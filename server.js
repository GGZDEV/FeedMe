const express = require('express');
const RSSParser = require('rss-parser');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const si = require('systeminformation');
const winmetrics = require('./winmetrics');
const ai = require('./ai');

const app = express();
const parser = new RSSParser({
  timeout: 10000,
  headers: {
    'User-Agent': 'FeedMe RSS Reader/1.0',
    Accept: 'application/rss+xml, application/xml, text/xml',
  },
});

// Sending a message to an agent may carry attachments (up to 25 MB, base64):
// only that route gets a larger body limit.
const agentMessageJson = express.json({ limit: '40mb' });
app.use((req, res, next) => /^\/api\/agents\/conversations\/[^/]+\/messages$/.test(req.path) ? agentMessageJson(req, res, next) : next());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Use writable data dir (set by Electron in production, or __dirname in dev)
const STORE_DIR = process.env.FEEDME_DATA_DIR || __dirname;
const FEEDS_FILE = path.join(STORE_DIR, 'feeds.json');
const BOARDS_FILE = path.join(STORE_DIR, 'boards.json');
const CATEGORIES_FILE = path.join(STORE_DIR, 'categories.json');
const FEEDLY_FILE = path.join(STORE_DIR, 'feedly.json');
const SPOTIFY_FILE = path.join(STORE_DIR, 'spotify.json');
const DATA_DIR = path.join(STORE_DIR, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// En production, Electron déplace le stockage hors de l'asar : le module IA
// doit viser le même dossier que le reste de la configuration.
ai.configure(STORE_DIR);

// Agent credentials never go back to the renderer. Electron injects Windows
// encryption; plain Node sessions keep newly entered tokens only in memory.
const agentRouter = require('./agents').createAgentRouter({
  dataDir: STORE_DIR,
  secretStorage: app.locals.agentSecretStorage || global.feedmeAgentSecretStorage || null,
  notify: item => global.feedmeAgentNotify?.(item),
});
app.use('/api/agents', agentRouter);
const directUsage = require('./direct-usage').createDirectUsage();
app.use('/api/ai-usage', require('./ai-usage').createUsageRouter({ dataDir: STORE_DIR,
  readUsage: id => id.startsWith('direct:') ? directUsage.read(id) : agentRouter.readUsage(id),
  connections: () => [...directUsage.connections(), ...agentRouter.usageConnections()] }));

// --- Helpers ---
function loadJSON(file, fallback) {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  return fallback;
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function articleId(article) {
  return crypto.createHash('md5').update(article.link || article.title).digest('hex').slice(0, 12);
}

let _cachedCpuInfo = null;
async function getCpuInfo() {
  if (_cachedCpuInfo) return _cachedCpuInfo;
  try {
    const cpu = await si.cpu();
    _cachedCpuInfo = { model: cpu.brand || cpu.manufacturer || os.cpus()[0]?.model || 'CPU', cores: cpu.cores || os.cpus().length };
  } catch {
    _cachedCpuInfo = { model: os.cpus()[0]?.model || 'CPU', cores: os.cpus().length };
  }
  return _cachedCpuInfo;
}

// Modèle et VRAM totale ne changent pas : une seule interrogation par session
// (si.graphics() est lent, il énumère les contrôleurs via WMI).
let _cachedGpuInfo = null;
async function getGpuInfo() {
  if (_cachedGpuInfo) return _cachedGpuInfo;
  try {
    const { controllers } = await si.graphics();
    // La vraie carte est celle qui a le plus de VRAM dédiée : on écarte ainsi
    // les adaptateurs d'affichage virtuels (Parsec, RDP, Hyper-V…).
    const primary = (controllers || [])
      .slice()
      .sort((a, b) => (b.vram || 0) - (a.vram || 0))[0] || null;
    _cachedGpuInfo = primary ? {
      model: primary.model || primary.name || 'GPU',
      vendor: primary.vendor || '',
      vramTotal: Number.isFinite(primary.vram) && primary.vram > 0 ? primary.vram * 1024 * 1024 : null,
      // Renseignés seulement par nvidia-smi ; nuls sur AMD/Intel.
      loadFromDriver: Number.isFinite(primary.utilizationGpu) ? primary.utilizationGpu : null,
      vramUsedFromDriver: Number.isFinite(primary.memoryUsed) ? primary.memoryUsed * 1024 * 1024 : null,
      tempFromDriver: Number.isFinite(primary.temperatureGpu) ? primary.temperatureGpu : null,
    } : null;
  } catch {
    _cachedGpuInfo = null;
  }
  return _cachedGpuInfo;
}

/* Charge CPU calculée à partir de `os.cpus()`, pas de systeminformation.
   ──────────────────────────────────────────
   Sous Windows, `si.currentLoad()`, `si.mem()`, `si.cpuTemperature()`,
   `si.fsSize()`, `si.networkStats()` et `si.cpuCurrentSpeed()` passent tous par
   un pool de processus PowerShell. Appelés toutes les deux secondes, ils
   saturaient le processeur : jusqu'à huit powershell.exe simultanés à ~9 % de
   CPU chacun. Tout ce qui suit vient désormais soit de Node (gratuit), soit du
   helper persistant unique. */
let lastCpuTimes = null;

// Sous Windows, libuv remplit `sys` avec (KernelTime - IdleTime) et `irq` avec
// InterruptTime — or InterruptTime est DÉJÀ compris dans KernelTime. Additionner
// `irq` au total le compte deux fois, gonfle le dénominateur et fait paraître la
// machine bien plus chargée qu'elle ne l'est. Sur Linux `irq` est bien un poste
// distinct de /proc/stat, d'où la distinction par plateforme.
const COUNT_IRQ = process.platform !== 'win32';

function cpuLoadPercent() {
  const totals = os.cpus().reduce((acc, c) => {
    acc.idle += c.times.idle;
    acc.total += c.times.user + c.times.nice + c.times.sys + c.times.idle
      + (COUNT_IRQ ? c.times.irq : 0);
    return acc;
  }, { idle: 0, total: 0 });

  const previous = lastCpuTimes;
  lastCpuTimes = totals;
  if (!previous) return null; // le premier échantillon n'a rien à comparer

  const idleDelta = totals.idle - previous.idle;
  const totalDelta = totals.total - previous.total;
  if (totalDelta <= 0) return null;
  return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
}

async function systemMetrics() {
  // Les deux seuls appels systeminformation restants sont mis en cache pour
  // toute la session : modèle de CPU et de GPU ne changent pas.
  const [cpuInfo, gpuInfo, lhm] = await Promise.all([
    getCpuInfo(),
    getGpuInfo(),
    winmetrics.readLhm().catch(() => null),
  ]);
  const counters = winmetrics.sample();

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  // La température ne peut venir que d'un pilote dédié : sans LibreHardwareMonitor
  // il n'y a rien à lire, et interroger systeminformation pour obtenir `null`
  // coûtait un processus PowerShell toutes les deux secondes.
  const cpuC = Number.isFinite(lhm?.cpuC) && lhm.cpuC > 0 ? lhm.cpuC : null;
  const tempSource = cpuC !== null ? 'LibreHardwareMonitor' : null;

  const cpuUsage = cpuLoadPercent();
  const speedGhz = os.cpus()[0]?.speed ? os.cpus()[0].speed / 1000 : null;

  const iface = counters?.nif
    ? { iface: counters.nif, rx_sec: counters.nrx, tx_sec: counters.ntx }
    : null;

  // ConvertTo-Json déballe un tableau d'un seul élément : on renormalise.
  const rawDisks = counters?.disks == null ? [] : [].concat(counters.disks);
  const disks = rawDisks.map((d) => ({
    name: d.name,
    total: d.total,
    free: d.free,
    used: d.total - d.free,
    usedPercent: d.total > 0 ? ((d.total - d.free) / d.total) * 100 : 0,
  }));

  const gpuLoad = Number.isFinite(counters?.g3d) ? counters.g3d : gpuInfo?.loadFromDriver ?? null;
  const vramUsed = Number.isFinite(counters?.vram) && counters.vram > 0
    ? counters.vram
    : gpuInfo?.vramUsedFromDriver ?? null;
  const gpuC = Number.isFinite(lhm?.gpuC) && lhm.gpuC > 0 ? lhm.gpuC : gpuInfo?.tempFromDriver ?? null;

  return {
    platform: process.platform,
    hostname: os.hostname(),
    cpu: {
      model: cpuInfo.model,
      cores: cpuInfo.cores,
      usagePercent: cpuUsage,
      speedGhz,
      loadAverage: os.loadavg(),
    },
    memory: {
      total: totalMem,
      free: freeMem,
      used: usedMem,
      usedPercent: totalMem > 0 ? (usedMem / totalMem) * 100 : 0,
    },
    gpu: gpuInfo ? {
      model: gpuInfo.model,
      vendor: gpuInfo.vendor,
      loadPercent: gpuLoad,
      loadCopyPercent: Number.isFinite(counters?.gcopy) ? counters.gcopy : null,
      loadVideoPercent: Number.isFinite(counters?.gvid) ? counters.gvid : null,
      vramTotal: gpuInfo.vramTotal,
      vramUsed,
      vramSharedUsed: Number.isFinite(counters?.vshar) ? counters.vshar : null,
      vramPercent: gpuInfo.vramTotal && Number.isFinite(vramUsed)
        ? (vramUsed / gpuInfo.vramTotal) * 100
        : null,
      tempC: gpuC,
      hotspotC: Number.isFinite(lhm?.gpuHotspotC) ? lhm.gpuHotspotC : null,
      fanRpm: Number.isFinite(lhm?.gpuFanRpm) ? lhm.gpuFanRpm : null,
      powerW: Number.isFinite(lhm?.gpuPowerW) ? lhm.gpuPowerW : null,
    } : null,
    network: iface ? {
      iface: iface.iface,
      rxSec: Number.isFinite(iface.rx_sec) ? iface.rx_sec : null,
      txSec: Number.isFinite(iface.tx_sec) ? iface.tx_sec : null,
    } : null,
    diskIo: counters ? {
      readSec: counters.dr,
      writeSec: counters.dw,
      queue: counters.dq,
    } : null,
    temperature: {
      cpuC,
      available: cpuC !== null,
      source: tempSource,
      cpuFanRpm: Number.isFinite(lhm?.cpuFanRpm) ? lhm.cpuFanRpm : null,
    },
    // Ce que la machine sait produire : le client masque ce qui manque plutôt
    // que d'afficher des tuiles vides.
    sources: {
      perfCounters: counters !== null,
      lhm: Boolean(lhm?.available),
      // Les FPS demandent un hook dans le moteur de rendu du jeu : hors de
      // portée d'un compteur système, voir le widget pour l'explication.
      fps: false,
    },
    disks,
    app: {
      uptimeSeconds: Math.round(process.uptime()),
      memoryBytes: process.memoryUsage().rss,
    },
    sampledAt: new Date().toISOString(),
  };
}

function clearArticleCache() {
  cachedArticles = [];
  lastFetchTime = 0;
}

function normalizeFeedlyToken(token) {
  return String(token || '').replace(/^Bearer\s+/i, '').trim();
}

function safeFeedlyConfig(config) {
  if (!config?.token) return { connected: false };
  return {
    connected: true,
    profile: config.profile || null,
    lastSyncAt: config.lastSyncAt || null,
    feedCount: config.feedCount || 0,
  };
}

function loadFeedlyConfig() {
  return loadJSON(FEEDLY_FILE, {});
}

function saveFeedlyConfig(config) {
  saveJSON(FEEDLY_FILE, config);
}

function feedlyRequest(pathname, token, host = 'api.feedly.com') {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host,
      path: pathname,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'FeedMe RSS Reader/1.0',
      },
      timeout: 12000,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        let parsed = {};
        if (body) {
          try {
            parsed = JSON.parse(body);
          } catch (e) {
            return reject(new Error(`Feedly returned invalid JSON (${response.statusCode})`));
          }
        }
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(parsed);
        } else {
          reject(new Error(parsed.errorMessage || parsed.message || `Feedly HTTP ${response.statusCode}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Feedly request timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function feedlyApi(pathname, token) {
  try {
    return await feedlyRequest(pathname, token, 'api.feedly.com');
  } catch (e) {
    // Older Feedly integrations still use cloud.feedly.com. Keep a fallback for user tokens.
    return feedlyRequest(pathname, token, 'cloud.feedly.com');
  }
}

function feedlyCategory(subscription) {
  const category = subscription?.categories?.[0];
  return category?.label || category?.id?.split('/').pop() || 'Feedly';
}

function feedlyFeedUrl(subscription) {
  if (!subscription?.id) return null;
  if (subscription.id.startsWith('feed/')) return subscription.id.slice(5);
  return subscription.id;
}

function attr(node, name) {
  return node.getAttribute(name) || '';
}

function parseOpmlFeeds(opmlText, defaultCategory = 'Feedly') {
  const { DOMParser } = require('@xmldom/xmldom');
  const doc = new DOMParser().parseFromString(opmlText, 'text/xml');
  const parserErrors = doc.getElementsByTagName('parsererror');
  if (parserErrors.length > 0) throw new Error('Fichier OPML invalide');

  const feeds = [];
  function walk(node, category) {
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i];
      if (child.nodeType !== 1 || child.tagName !== 'outline') continue;

      const xmlUrl = attr(child, 'xmlUrl');
      const title = attr(child, 'title') || attr(child, 'text');
      if (xmlUrl) {
        feeds.push({
          url: xmlUrl,
          category: category || defaultCategory,
          title,
          source: 'opml',
        });
      } else {
        walk(child, title || category || defaultCategory);
      }
    }
  }

  const bodies = doc.getElementsByTagName('body');
  if (!bodies.length) throw new Error('Aucune section body dans le fichier OPML');
  walk(bodies[0], defaultCategory);
  return feeds.filter((feed) => /^https?:\/\//i.test(feed.url));
}

function importFeeds(importedFeeds) {
  const feeds = loadFeeds();
  const seen = new Set(feeds.map((feed) => feed.url));
  const added = [];
  for (const feed of importedFeeds) {
    if (!feed.url || seen.has(feed.url)) continue;
    seen.add(feed.url);
    feeds.push(feed);
    added.push(feed);
  }
  saveJSON(FEEDS_FILE, feeds);
  ensureCategories(added.map((feed) => feed.category));
  clearArticleCache();
  return added;
}

async function syncFeedlyFeeds(token) {
  const subscriptions = await feedlyApi('/v3/subscriptions', token);
  if (!Array.isArray(subscriptions)) throw new Error('Feedly subscriptions response was not an array');

  const imported = subscriptions
    .map((subscription) => ({
      url: feedlyFeedUrl(subscription),
      category: feedlyCategory(subscription),
      title: subscription.title || subscription.label || '',
      source: 'feedly',
    }))
    .filter((feed) => feed.url && /^https?:\/\//i.test(feed.url));

  const manualFeeds = loadFeeds().filter((feed) => feed.source !== 'feedly');
  const seen = new Set(manualFeeds.map((feed) => feed.url));
  const mergedFeedly = [];
  for (const feed of imported) {
    if (seen.has(feed.url)) continue;
    seen.add(feed.url);
    mergedFeedly.push(feed);
  }

  saveJSON(FEEDS_FILE, [...manualFeeds, ...mergedFeedly]);
  ensureCategories(mergedFeedly.map((feed) => feed.category));
  clearArticleCache();
  return mergedFeedly;
}

// --- Feeds ---
function loadFeeds() {
  if (fs.existsSync(FEEDS_FILE)) {
    return JSON.parse(fs.readFileSync(FEEDS_FILE, 'utf-8'));
  }
  saveJSON(FEEDS_FILE, []);
  return [];
}

// Catalogue de recommandations. L'ordre sert de priorité par défaut ;
// les tags sont comparés aux catégories suivies pour personnaliser la liste.
const SUGGESTION_CATALOG = [
  { title: 'Le Monde - Une', url: 'https://www.lemonde.fr/rss/une.xml', category: 'Actu', tags: ['actu', 'gen', 'info', 'france', 'monde'], description: 'Le fil généraliste pour suivre les grands titres en France et à l\'international.' },
  { title: 'Numerama', url: 'https://www.numerama.com/feed/', category: 'Tech', tags: ['tech', 'numerique', 'ia'], description: 'Culture numérique, plateformes, IA et enjeux tech grand public.' },
  { title: 'Korben', url: 'https://korben.info/feed', category: 'Tech', tags: ['tech', 'outils', 'securite', 'dev'], description: 'Outils, bidouilles, sécurité, logiciel libre et veille technique accessible.' },
  { title: 'Next', url: 'https://next.ink/feed', category: 'Tech', tags: ['tech', 'telecom', 'regulation'], description: 'Actualité tech française avec un angle télécom, régulation et industrie.' },
  { title: 'Journal du Hacker', url: 'https://www.journalduhacker.net/rss', category: 'Dev', tags: ['dev', 'code', 'opensource', 'hack'], description: 'Liens communautaires pour développement, open source et culture hacker.' },
  { title: 'TechCrunch', url: 'https://techcrunch.com/feed/', category: 'Startups', tags: ['startups', 'tech', 'business'], description: 'Startups, financement, produits et grandes tendances tech internationales.' },
  { title: 'France Info', url: 'https://www.francetvinfo.fr/titres.rss', category: 'Actu', tags: ['actu', 'gen', 'info', 'france'], description: 'L\'actualité en continu du service public.' },
  { title: 'Courrier International', url: 'https://www.courrierinternational.com/feed/all/rss.xml', category: 'Actu', tags: ['actu', 'gen', 'monde', 'international'], description: 'Le meilleur de la presse étrangère traduit en français.' },
  { title: 'Frandroid', url: 'https://www.frandroid.com/feed', category: 'Tech', tags: ['tech', 'mobile', 'android', 'materiel'], description: 'Smartphones, objets connectés, mobilité électrique et tests produits.' },
  { title: 'Les Numériques', url: 'https://www.lesnumeriques.com/rss.xml', category: 'Tech', tags: ['tech', 'tests', 'materiel'], description: 'Tests et guides d\'achat high-tech : photo, audio, informatique, maison connectée.' },
  { title: 'Clubic', url: 'https://www.clubic.com/feed/news.rss', category: 'Tech', tags: ['tech', 'materiel', 'logiciel'], description: 'Actualité high-tech, bons plans et comparatifs matériels et logiciels.' },
  { title: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', category: 'Tech', tags: ['tech', 'english', 'international'], description: 'Référence anglophone sur la tech, les plateformes et la culture numérique.' },
  { title: 'Hacker News', url: 'https://news.ycombinator.com/rss', category: 'Dev', tags: ['dev', 'code', 'startups', 'english'], description: 'La veille communautaire de Y Combinator : code, produits, science.' },
  { title: 'Dev.to', url: 'https://dev.to/feed', category: 'Dev', tags: ['dev', 'code', 'web', 'english'], description: 'Articles de développeurs pour développeurs : web, carrière, bonnes pratiques.' },
  { title: 'GitHub Blog', url: 'https://github.blog/feed/', category: 'Dev', tags: ['dev', 'code', 'opensource', 'english'], description: 'Nouveautés GitHub, open source et ingénierie logicielle.' },
  { title: 'Zataz', url: 'https://www.zataz.com/feed/', category: 'Sécurité', tags: ['securite', 'cyber', 'hack'], description: 'Cybersécurité francophone : fuites de données, piratages, prévention.' },
  { title: 'The Hacker News', url: 'https://feeds.feedburner.com/TheHackersNews', category: 'Sécurité', tags: ['securite', 'cyber', 'english'], description: 'Vulnérabilités, malwares et actualité cybersécurité internationale.' },
  { title: 'Maddyness', url: 'https://www.maddyness.com/feed/', category: 'Startups', tags: ['startups', 'innovation', 'france', 'business'], description: 'Le média des startups françaises : levées de fonds, innovation, écosystème.' },
  { title: 'Futura Sciences', url: 'https://www.futura-sciences.com/rss/actualites.xml', category: 'Science', tags: ['science', 'espace', 'sante', 'nature'], description: 'Sciences, espace, santé et environnement expliqués au grand public.' },
  { title: 'Sciences et Avenir', url: 'https://www.sciencesetavenir.fr/rss.xml', category: 'Science', tags: ['science', 'sante', 'espace'], description: 'L\'actualité scientifique et médicale décryptée.' },
  { title: 'Gamekult', url: 'https://www.gamekult.com/feed.xml', category: 'Gaming', tags: ['gaming', 'jeux', 'jeu'], description: 'Tests, critiques et actualité du jeu vidéo.' },
  { title: 'jeuxvideo.com', url: 'https://www.jeuxvideo.com/rss/rss.xml', category: 'Gaming', tags: ['gaming', 'jeux', 'jeu'], description: 'Toute l\'actualité du jeu vidéo : sorties, tests, astuces.' },
  { title: 'L\'Équipe', url: 'https://www.lequipe.fr/rss/actu_rss.xml', category: 'Sport', tags: ['sport', 'foot', 'football'], description: 'Toute l\'actualité sportive : foot, rugby, tennis, F1 et plus.' },
  { title: 'Les Inrocks', url: 'https://www.lesinrocks.com/feed/', category: 'Culture', tags: ['culture', 'musique', 'cinema'], description: 'Musique, cinéma, séries et culture pop.' },
];

function normalizeTokens(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Recommandations dynamiques : on pondère chaque entrée du catalogue selon
// les catégories des flux suivis, on exclut les flux déjà ajoutés, et on
// renvoie les meilleures propositions (l'ordre du catalogue départage à score égal).
function buildSuggestions(limit = 8) {
  const feeds = loadFeeds();
  const subscribed = new Set(feeds.map((feed) => feed.url));
  const tokenWeight = {};
  for (const feed of feeds) {
    for (const token of normalizeTokens(feed.category)) {
      tokenWeight[token] = (tokenWeight[token] || 0) + 1;
    }
  }
  return SUGGESTION_CATALOG
    .filter((item) => !subscribed.has(item.url))
    .map((item) => {
      const tokens = new Set([...normalizeTokens(item.category), ...item.tags]);
      let score = 0;
      for (const token of tokens) score += tokenWeight[token] || 0;
      return { item, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ item }) => ({
      title: item.title,
      url: item.url,
      category: item.category,
      description: item.description,
    }));
}

app.get('/api/feeds', (req, res) => res.json(loadFeeds()));

app.get('/api/feed-suggestions', (req, res) => res.json(buildSuggestions()));

app.get('/api/system/metrics', async (req, res) => {
  try {
    res.json(await systemMetrics());
  } catch (e) {
    res.status(500).json({ error: e.message || 'System metrics unavailable' });
  }
});

app.post('/api/feeds', (req, res) => {
  const feeds = loadFeeds();
  const { url, category, title, source } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  if (feeds.some((feed) => feed.url === url)) return res.json({ ok: true, duplicate: true });
  feeds.push({ url, category: category || 'Autres', title: title || '', source: source || 'manual' });
  ensureCategories([category || 'Autres']);
  clearArticleCache();
  saveJSON(FEEDS_FILE, feeds);
  res.json({ ok: true });
});

app.delete('/api/feeds', (req, res) => {
  const { url } = req.body;
  let feeds = loadFeeds();
  feeds = feeds.filter((f) => f.url !== url);
  saveJSON(FEEDS_FILE, feeds);
  res.json({ ok: true });
});

app.patch('/api/feeds', (req, res) => {
  const { url, category } = req.body;
  if (!url || !category) return res.status(400).json({ error: 'url and category required' });
  const feeds = loadFeeds();
  const feed = feeds.find((f) => f.url === url);
  if (!feed) return res.status(404).json({ error: 'Feed not found' });
  feed.category = category;
  saveJSON(FEEDS_FILE, feeds);
  clearArticleCache();
  res.json({ ok: true });
});

app.post('/api/feeds/opml', express.text({ type: '*/*', limit: '5mb' }), (req, res) => {
  if (!req.body) return res.status(400).json({ error: 'OPML file required' });
  try {
    const parsed = parseOpmlFeeds(req.body);
    const added = importFeeds(parsed);
    res.json({ ok: true, parsed: parsed.length, added: added.length });
  } catch (e) {
    res.status(400).json({ error: e.message || 'OPML import failed' });
  }
});

// --- Feedly connection ---
app.get('/api/feedly/status', (req, res) => {
  res.json(safeFeedlyConfig(loadFeedlyConfig()));
});

app.post('/api/feedly/connect', async (req, res) => {
  const token = normalizeFeedlyToken(req.body?.token);
  if (!token) return res.status(400).json({ error: 'Feedly API token required' });

  try {
    const profile = await feedlyApi('/v3/profile', token);
    const imported = await syncFeedlyFeeds(token);
    const config = {
      token,
      profile: {
        id: profile.id || '',
        email: profile.email || '',
        fullName: profile.fullName || profile.givenName || '',
      },
      lastSyncAt: new Date().toISOString(),
      feedCount: imported.length,
    };
    saveFeedlyConfig(config);
    res.json({ ok: true, ...safeFeedlyConfig(config) });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Feedly connection failed' });
  }
});

app.post('/api/feedly/sync', async (req, res) => {
  const config = loadFeedlyConfig();
  if (!config.token) return res.status(400).json({ error: 'Feedly is not connected' });

  try {
    const imported = await syncFeedlyFeeds(config.token);
    const nextConfig = {
      ...config,
      lastSyncAt: new Date().toISOString(),
      feedCount: imported.length,
    };
    saveFeedlyConfig(nextConfig);
    res.json({ ok: true, ...safeFeedlyConfig(nextConfig) });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Feedly sync failed' });
  }
});

app.delete('/api/feedly', (req, res) => {
  const feeds = loadFeeds().filter((feed) => feed.source !== 'feedly');
  saveJSON(FEEDS_FILE, feeds);
  saveFeedlyConfig({});
  clearArticleCache();
  res.json({ ok: true });
});

// --- Spotify ---
//
// Authorization Code + PKCE, so no client secret ever lives on disk. The user
// supplies their own Client ID (a personal app from the Spotify dashboard);
// FeedMe stores the resulting refresh token in spotify.json.
//
// The redirect URI must use the 127.0.0.1 IP literal: Spotify's dashboard
// rejects "localhost" for loopback redirects, even though the app itself is
// served on localhost. It also has to match the registered URI character for
// character, hence the port is taken from the port the server actually got.
// Les trois premiers portent le lecteur ; les trois suivants ont été ajoutés
// pour les favoris et l'historique. Un compte connecté avant cet ajout possède
// un refresh token qui n'ouvre PAS les nouveaux droits : l'interface propose
// une reconnexion plutôt que de laisser les boutons échouer en silence.
const SPOTIFY_SCOPE_LIST = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-library-read',
  'user-library-modify',
  'user-read-recently-played',
];
const SPOTIFY_SCOPES = SPOTIFY_SCOPE_LIST.join(' ');

let spotifyPending = null; // single in-flight authorization: { clientId, verifier, state }

// Client ID livré avec FeedMe. Avec PKCE il n'y a aucun secret à protéger : un
// Client ID public est le fonctionnement prévu pour une application installée.
// Quand il est fourni, l'utilisateur ne voit qu'un bouton « Se connecter » —
// aucun passage par le dashboard développeur.
const SPOTIFY_APP_FILE = path.join(__dirname, 'spotify-app.json');

function bundledSpotifyClientId() {
  return String(process.env.SPOTIFY_CLIENT_ID || loadJSON(SPOTIFY_APP_FILE, {}).clientId || '').trim();
}

function loadSpotifyConfig() {
  return loadJSON(SPOTIFY_FILE, {});
}

// Celui saisi par l'utilisateur prime, sinon celui livré avec l'app.
function spotifyClientId() {
  return loadSpotifyConfig().clientId || bundledSpotifyClientId();
}

function saveSpotifyConfig(config) {
  saveJSON(SPOTIFY_FILE, config);
}

function spotifyRedirectUri() {
  return `http://127.0.0.1:${process.env.FEEDME_PORT || PORT}/api/spotify/callback`;
}

function safeSpotifyConfig(config) {
  // Les comptes connectés avant l'ajout des scopes n'ont pas de champ `scopes` :
  // on suppose alors l'ancien jeu de trois permissions.
  const granted = config?.scopes
    ? String(config.scopes).split(/\s+/).filter(Boolean)
    : (config?.refreshToken ? SPOTIFY_SCOPE_LIST.slice(0, 3) : []);
  return {
    configured: Boolean(spotifyClientId()),
    // Vrai quand l'app est livrée pré-configurée : l'interface masque alors
    // toute la procédure du dashboard, il ne reste que « Se connecter ».
    bundled: Boolean(bundledSpotifyClientId()),
    connected: Boolean(config?.refreshToken),
    profile: config?.profile || null,
    redirectUri: spotifyRedirectUri(),
    scopes: granted,
    missingScopes: config?.refreshToken
      ? SPOTIFY_SCOPE_LIST.filter((s) => !granted.includes(s))
      : [],
  };
}

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function spotifyToken(form) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `Spotify token error ${res.status}`);
  return data;
}

// Valid access token, refreshed when within a minute of expiry.
async function spotifyAccessToken() {
  const config = loadSpotifyConfig();
  if (!config.refreshToken) throw new Error('Spotify n\'est pas connecté');
  if (config.accessToken && config.expiresAt && Date.now() < config.expiresAt - 60000) {
    return config.accessToken;
  }

  const data = await spotifyToken({
    grant_type: 'refresh_token',
    refresh_token: config.refreshToken,
    client_id: spotifyClientId(), // peut ne venir que du fichier livré
  });
  const next = {
    ...config,
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
  // Spotify rotates the refresh token on some refreshes — keep the newest one.
  if (data.refresh_token) next.refreshToken = data.refresh_token;
  saveSpotifyConfig(next);
  return next.accessToken;
}

async function spotifyApi(pathname, { method = 'GET', body } = {}) {
  const token = await spotifyAccessToken();
  const res = await fetch(`https://api.spotify.com/v1${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  // 204 = command accepted, or nothing is playing on any device.
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Spotify API error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// The two failures users actually hit, in plain French.
function spotifyControlError(err) {
  if (err.status === 404) return 'Aucun appareil Spotify actif. Lancez la lecture dans Spotify puis réessayez.';
  if (err.status === 403) return 'Les commandes de lecture nécessitent un compte Spotify Premium.';
  return err.message || 'Commande Spotify échouée';
}

// Les opérations de bibliothèque ne dépendent PAS de Premium : y renvoyer un 403
// vers le message « nécessite Premium » envoyait sur une fausse piste. Un 403 ici
// est un refus d'autorisation (scope absent ou endpoint interdit à l'app).
function spotifyLibraryError(err) {
  if (err.status === 403) {
    return 'Spotify a refusé l\'accès à votre bibliothèque pour cette application '
      + `(403${err.message && err.message !== 'Forbidden' ? ' — ' + err.message : ''}).`;
  }
  if (err.status === 401) return 'Session Spotify expirée. Reconnectez votre compte.';
  return err.message || 'Opération de bibliothèque échouée';
}

function spotifyCallbackPage(title, message, ok) {
  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><title>FeedMe · Spotify</title></head>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0d10;color:#eef1f4;font-family:'Segoe UI',sans-serif;text-align:center">
  <div>
    <div style="font-size:44px;margin-bottom:14px">${ok ? '&#9834;' : '&#9888;'}</div>
    <h1 style="font-size:19px;margin-bottom:8px;color:${ok ? '#4ade80' : '#ef4444'}">${esc(title)}</h1>
    <p style="color:#9aa3ae;font-size:14px;max-width:380px">${esc(message)}</p>
  </div>
</body></html>`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

app.get('/api/spotify/status', (req, res) => {
  res.json(safeSpotifyConfig(loadSpotifyConfig()));
});

// Starts the flow: stores the PKCE verifier and hands the consent URL back so
// the renderer can open it in the system browser.
app.post('/api/spotify/authorize', (req, res) => {
  // Le Client ID est mémorisé une fois pour toutes : une reconnexion se fait
  // sans rien recoller, le corps de la requête ne sert qu'à en changer.
  const stored = spotifyClientId();
  const clientId = String(req.body?.clientId || stored).trim();
  if (!/^[0-9a-f]{32}$/i.test(clientId)) {
    return res.status(400).json({ error: 'Client ID invalide (32 caractères hexadécimaux attendus)' });
  }
  // Mémorisé dès l'autorisation, pas seulement au retour : si l'utilisateur
  // abandonne l'écran de consentement, il n'a pas à le ressaisir.
  if (clientId !== stored) saveSpotifyConfig({ ...loadSpotifyConfig(), clientId });

  const verifier = base64url(crypto.randomBytes(64));
  const state = base64url(crypto.randomBytes(16));
  spotifyPending = { clientId, verifier, state };

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: spotifyRedirectUri(),
    code_challenge_method: 'S256',
    code_challenge: base64url(crypto.createHash('sha256').update(verifier).digest()),
    state,
    scope: SPOTIFY_SCOPES,
  });
  res.json({ url: `https://accounts.spotify.com/authorize?${params}` });
});

app.get('/api/spotify/callback', async (req, res) => {
  const pending = spotifyPending;
  spotifyPending = null; // single use, whatever the outcome

  const fail = (message) => res.status(400).send(spotifyCallbackPage('Connexion échouée', message, false));

  if (req.query.error) return fail(`Spotify a refusé l'autorisation (${req.query.error}).`);
  if (!pending || req.query.state !== pending.state) {
    return fail('Demande d\'autorisation inconnue ou expirée. Relancez la connexion depuis FeedMe.');
  }
  if (!req.query.code) return fail('Aucun code d\'autorisation reçu.');

  try {
    const data = await spotifyToken({
      grant_type: 'authorization_code',
      code: String(req.query.code),
      redirect_uri: spotifyRedirectUri(),
      client_id: pending.clientId,
      code_verifier: pending.verifier,
    });
    saveSpotifyConfig({
      clientId: pending.clientId,
      refreshToken: data.refresh_token,
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
      // Spotify renvoie les permissions réellement accordées : on les garde
      // pour savoir quelles fonctions proposer.
      scopes: data.scope || SPOTIFY_SCOPES,
    });

    // "product" tells the UI upfront whether playback commands will work.
    const profile = await spotifyApi('/me').catch(() => null);
    if (profile) {
      saveSpotifyConfig({
        ...loadSpotifyConfig(),
        profile: { id: profile.id, name: profile.display_name || profile.id, product: profile.product || '' },
      });
    }
    res.send(spotifyCallbackPage('FeedMe est connecté à Spotify', 'Vous pouvez fermer cet onglet et revenir à FeedMe.', true));
  } catch (e) {
    fail(e.message);
  }
});

app.get('/api/spotify/now-playing', async (req, res) => {
  if (!loadSpotifyConfig().refreshToken) return res.json({ connected: false });

  try {
    const state = await spotifyApi('/me/player');
    if (!state || !state.item) return res.json({ connected: true, playing: false, track: null });
    res.json({
      connected: true,
      playing: Boolean(state.is_playing),
      progressMs: state.progress_ms || 0,
      device: state.device ? { name: state.device.name, volume: state.device.volume_percent } : null,
      track: {
        id: state.item.id,
        title: state.item.name,
        artist: (state.item.artists || []).map((a) => a.name).join(', '),
        album: state.item.album?.name || '',
        art: state.item.album?.images?.[0]?.url || '',
        durationMs: state.item.duration_ms || 0,
        url: state.item.external_urls?.spotify || '',
      },
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

const SPOTIFY_COMMANDS = {
  play: { method: 'PUT', path: '/me/player/play' },
  pause: { method: 'PUT', path: '/me/player/pause' },
  next: { method: 'POST', path: '/me/player/next' },
  previous: { method: 'POST', path: '/me/player/previous' },
};

app.post('/api/spotify/command/:name', async (req, res) => {
  const command = SPOTIFY_COMMANDS[req.params.name];
  if (!command) return res.status(400).json({ error: 'Commande inconnue' });

  try {
    await spotifyApi(command.path, { method: command.method });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: spotifyControlError(e) });
  }
});

app.post('/api/spotify/seek', async (req, res) => {
  const positionMs = Math.max(0, Math.round(Number(req.body?.positionMs)));
  if (!Number.isFinite(positionMs)) return res.status(400).json({ error: 'Position invalide' });

  try {
    await spotifyApi(`/me/player/seek?position_ms=${positionMs}`, { method: 'PUT' });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: spotifyControlError(e) });
  }
});

app.post('/api/spotify/volume', async (req, res) => {
  const volume = Math.min(100, Math.max(0, Math.round(Number(req.body?.volume))));
  if (!Number.isFinite(volume)) return res.status(400).json({ error: 'Volume invalide' });

  try {
    await spotifyApi(`/me/player/volume?volume_percent=${volume}`, { method: 'PUT' });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: spotifyControlError(e) });
  }
});

/* ── Spotify Connect : appareils & transfert ── */
app.get('/api/spotify/devices', async (req, res) => {
  try {
    const data = await spotifyApi('/me/player/devices');
    res.json({
      devices: (data?.devices || []).map((d) => ({
        id: d.id,
        name: d.name,
        type: d.type,
        active: Boolean(d.is_active),
        volume: d.volume_percent,
        restricted: Boolean(d.is_restricted),
      })),
    });
  } catch (e) {
    res.status(400).json({ error: spotifyControlError(e) });
  }
});

app.post('/api/spotify/transfer', async (req, res) => {
  const deviceId = String(req.body?.deviceId || '').trim();
  if (!deviceId) return res.status(400).json({ error: 'Appareil manquant' });
  try {
    // `play: true` évite que le transfert mette la lecture en pause.
    await spotifyApi('/me/player', { method: 'PUT', body: { device_ids: [deviceId], play: true } });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: spotifyControlError(e) });
  }
});

/* ── Favoris (bibliothèque Spotify) ──
   `GET /me/tracks/contains` renvoie 403 « Forbidden » pour certaines apps même
   avec le scope `user-library-read` accordé, alors que `GET /me/tracks` (la
   liste paginée) répond 200 avec le même jeton. On tente donc l'endpoint direct,
   puis on retombe sur un balayage de la liste, gardé en mémoire. */
let savedSweep = null;    // { ids: Set, at, truncated, total }
let sweepInFlight = null; // promesse partagée : un seul balayage à la fois
const SAVED_TTL_MS = 10 * 60 * 1000;
// Garde-fou de dernier recours (500 000 titres) ; la vraie borne est le `total`
// renvoyé par Spotify. Un plafond arbitraire plus bas produirait de faux
// « non aimé » sur les titres les plus anciens.
const SWEEP_PAGE_LIMIT = 10000;

function sweepFresh() {
  return savedSweep && Date.now() - savedSweep.at < SAVED_TTL_MS;
}

function startSweep() {
  if (sweepInFlight) return sweepInFlight;
  sweepInFlight = (async () => {
    const ids = new Set();
    let url = '/me/tracks?limit=50';
    let pages = 0;
    let total = null;

    while (url && pages < SWEEP_PAGE_LIMIT) {
      const page = await spotifyApi(url);
      if (total === null) total = page?.total ?? null;
      for (const item of page?.items || []) {
        if (item?.track?.id) ids.add(item.track.id);
      }
      pages++;
      // `next` est une URL absolue : on la ramène au chemin attendu par spotifyApi.
      url = page?.next ? page.next.replace('https://api.spotify.com/v1', '') : null;
    }

    savedSweep = { ids, at: Date.now(), truncated: Boolean(url), total };
    return savedSweep;
  })();
  // La promesse est libérée dans tous les cas : un échec ne doit pas figer
  // définitivement la fonctionnalité.
  sweepInFlight.catch(() => {}).then(() => { sweepInFlight = null; });
  return sweepInFlight;
}

app.get('/api/spotify/saved', async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
  if (ids.length === 0) return res.json({ saved: {} });

  // Voie normale : un seul appel, réponse immédiate.
  try {
    const flags = await spotifyApi(`/me/tracks/contains?ids=${encodeURIComponent(ids.join(','))}`);
    const saved = {};
    ids.forEach((id, i) => { saved[id] = Boolean(flags?.[i]); });
    return res.json({ saved, via: 'contains' });
  } catch (e) {
    if (e.status !== 403) return res.status(400).json({ error: spotifyLibraryError(e) });
  }

  // Voie de repli : balayage complet de la bibliothèque. Il dure une dizaine de
  // secondes pour deux mille titres, donc il ne bloque JAMAIS la requête — on
  // répond `pending` et le client redemande quand c'est prêt.
  if (sweepFresh()) {
    const saved = {};
    for (const id of ids) saved[id] = savedSweep.ids.has(id);
    return res.json({ saved, via: 'sweep', total: savedSweep.total, truncated: savedSweep.truncated });
  }

  startSweep().catch(() => {});
  res.json({ saved: {}, via: 'sweep', pending: true });
});

app.post('/api/spotify/saved', async (req, res) => {
  const id = String(req.body?.id || '').trim();
  const saved = Boolean(req.body?.saved);
  if (!id) return res.status(400).json({ error: 'Morceau manquant' });
  try {
    await spotifyApi(`/me/tracks?ids=${encodeURIComponent(id)}`, { method: saved ? 'PUT' : 'DELETE' });
    // Le cache de balayage devient faux dès la première modification.
    if (savedSweep) {
      if (saved) savedSweep.ids.add(id);
      else savedSweep.ids.delete(id);
    }
    res.json({ ok: true, saved });
  } catch (e) {
    res.status(400).json({ error: spotifyLibraryError(e) });
  }
});

/* ── Historique d'écoute ── */
app.get('/api/spotify/history', async (req, res) => {
  try {
    const data = await spotifyApi('/me/player/recently-played?limit=30');
    const seen = new Set();
    const tracks = [];
    for (const item of data?.items || []) {
      const t = item.track;
      // Un morceau rejoué apparaît plusieurs fois : on garde la plus récente.
      if (!t || seen.has(t.id)) continue;
      seen.add(t.id);
      tracks.push({
        id: t.id,
        title: t.name,
        artist: (t.artists || []).map((a) => a.name).join(', '),
        art: t.album?.images?.at(-1)?.url || '',
        url: t.external_urls?.spotify || '',
        playedAt: item.played_at,
      });
    }
    res.json({ tracks });
  } catch (e) {
    res.status(400).json({ error: spotifyControlError(e) });
  }
});

/* ── Paroles synchronisées ──
   L'API Spotify n'expose pas les paroles. LRCLIB est une base ouverte de
   fichiers LRC, sans clé et sans compte : on l'interroge avec les métadonnées
   du morceau en cours. Résultat mis en cache par identifiant de morceau — les
   paroles ne changent jamais, et on réinterroge à chaque scrub sinon. */
const lyricsCache = new Map(); // trackId -> { lines, plain, at }
const LYRICS_TTL_MS = 12 * 60 * 60 * 1000;

// Format LRC : « [01:23.45] texte ». Les lignes sans horodatage sont ignorées,
// celles sans texte servent de marqueur d'interlude.
function parseLrc(text) {
  const lines = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const match = raw.match(/^\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]\s*(.*)$/);
    if (!match) continue;
    const [, mm, ss, frac, content] = match;
    const fraction = frac ? Number(`0.${frac}`) * 1000 : 0;
    lines.push({ t: Number(mm) * 60000 + Number(ss) * 1000 + fraction, text: content.trim() });
  }
  return lines.sort((a, b) => a.t - b.t);
}

async function lrclib(pathname) {
  const res = await fetch(`https://lrclib.net/api${pathname}`, {
    headers: { 'User-Agent': 'FeedMe/1.0 (personal desktop widget)' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`LRCLIB ${res.status}`);
  return res.json();
}

app.get('/api/spotify/lyrics', async (req, res) => {
  const { trackId, title, artist, album, durationMs } = req.query;
  if (!trackId || !title || !artist) {
    return res.status(400).json({ error: 'Métadonnées du morceau manquantes' });
  }

  const hit = lyricsCache.get(trackId);
  if (hit && Date.now() - hit.at < LYRICS_TTL_MS) {
    return res.json({ lines: hit.lines, plain: hit.plain, cached: true });
  }

  try {
    const params = new URLSearchParams({ artist_name: artist, track_name: title });
    if (album) params.set('album_name', album);
    if (durationMs) params.set('duration', String(Math.round(Number(durationMs) / 1000)));

    let data = await lrclib(`/get?${params}`);
    if (!data) {
      // Pas de correspondance exacte (album ou durée qui diffèrent) : on
      // retombe sur une recherche titre + artiste.
      const search = await lrclib(`/search?${new URLSearchParams({ track_name: title, artist_name: artist })}`);
      data = Array.isArray(search)
        ? search.find((r) => r.syncedLyrics) || search[0] || null
        : null;
    }

    const result = {
      lines: data?.syncedLyrics ? parseLrc(data.syncedLyrics) : [],
      plain: data?.plainLyrics || '',
    };
    lyricsCache.set(trackId, { ...result, at: Date.now() });
    if (lyricsCache.size > 200) lyricsCache.delete(lyricsCache.keys().next().value);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: 'Paroles indisponibles (LRCLIB injoignable)' });
  }
});

// Drops the tokens but keeps the Client ID, so reconnecting is one click.
app.delete('/api/spotify', (req, res) => {
  const { clientId } = loadSpotifyConfig();
  saveSpotifyConfig(clientId ? { clientId } : {});
  res.json({ ok: true });
});

// --- Categories ---
function loadCategories() {
  return loadJSON(CATEGORIES_FILE, [
    { name: 'Tech', color: '#60a5fa' },
    { name: 'Actu', color: '#f472b6' },
    { name: 'Autres', color: '#a78bfa' },
  ]);
}

function ensureCategories(names) {
  const palette = ['#60a5fa', '#f472b6', '#a78bfa', '#4ade80', '#fbbf24', '#fb7185', '#22d3ee'];
  const cats = loadCategories();
  const existing = new Set(cats.map((cat) => cat.name.toLowerCase()));
  let added = false;
  for (const name of names) {
    if (!name || existing.has(name.toLowerCase())) continue;
    cats.push({ name, color: palette[cats.length % palette.length] });
    existing.add(name.toLowerCase());
    added = true;
  }
  if (added) saveJSON(CATEGORIES_FILE, cats);
}

app.get('/api/categories', (req, res) => res.json(loadCategories()));

app.post('/api/categories', (req, res) => {
  const cats = loadCategories();
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const existing = cats.find(c => c.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    existing.color = color || existing.color;
  } else {
    cats.push({ name, color: color || '#a78bfa' });
  }
  saveJSON(CATEGORIES_FILE, cats);
  res.json({ ok: true });
});

app.delete('/api/categories/:name', (req, res) => {
  let cats = loadCategories();
  cats = cats.filter(c => c.name !== req.params.name);
  saveJSON(CATEGORIES_FILE, cats);
  res.json({ ok: true });
});

app.patch('/api/categories/:name', (req, res) => {
  const cats = loadCategories();
  const cat = cats.find(c => c.name === req.params.name);
  if (!cat) return res.status(404).json({ error: 'Not found' });
  if (req.body.color) cat.color = req.body.color;
  if (req.body.newName) cat.name = req.body.newName;
  saveJSON(CATEGORIES_FILE, cats);
  res.json({ ok: true });
});

// --- Articles cache ---
let cachedArticles = [];
let lastFetchTime = 0;
const CACHE_TTL = 2 * 60 * 1000; // 2 min

async function fetchAllArticles() {
  if (Date.now() - lastFetchTime < CACHE_TTL && cachedArticles.length > 0) {
    return cachedArticles;
  }
  const feeds = loadFeeds();
  const allArticles = [];
  const results = await Promise.allSettled(
    feeds.map(async (feed) => {
      try {
        const parsed = await parser.parseURL(feed.url);
        return parsed.items.map((item) => {
          const a = {
            title: item.title || '',
            link: item.link || '',
            pubDate: item.pubDate || item.isoDate || '',
            source: parsed.title || new URL(feed.url).hostname,
            category: feed.category || 'Autres',
            description: (item.contentSnippet || item.content || '').substring(0, 300),
            image:
              item.enclosure?.url ||
              extractImage(item['content:encoded'] || item.content || '') ||
              null,
            // Popularity signals
            comments: item.comments ? 1 : 0,
            categories: item.categories?.length || 0,
          };
          a.id = articleId(a);
          return a;
        });
      } catch (e) {
        console.error(`Error fetching ${feed.url}: ${e.message}`);
        return [];
      }
    })
  );
  for (const result of results) {
    if (result.status === 'fulfilled') allArticles.push(...result.value);
  }

  // Deduplicate by link
  const seen = new Set();
  const deduped = [];
  for (const a of allArticles) {
    if (!seen.has(a.link)) { seen.add(a.link); deduped.push(a); }
  }

  // Compute popularity score
  computePopularity(deduped);

  cachedArticles = deduped;
  lastFetchTime = Date.now();
  return cachedArticles;
}

function computePopularity(articles) {
  // Step 1: Count significant keywords across DIFFERENT sources only
  // A word is trending only if multiple distinct sources mention it
  const STOP_WORDS = new Set([
    'cette','comme','dans','depuis','encore','entre','faire','avant',
    'apres','aussi','autre','leurs','mais','notre','plus','pour',
    'quand','sans','selon','seront','tout','toute','tous','toutes',
    'trois','votre','avoir','avec','etre','elle','sont','nous','vous',
    'france','monde','nouveau','nouvelle','nouveaux','comment','pourquoi',
  ]);

  // Map: word -> Set of source names
  const wordSources = {};
  for (const a of articles) {
    const words = (a.title || '').toLowerCase()
      .replace(/[^a-zA-ZÀ-ÿ\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 5 && !STOP_WORDS.has(w));
    const uniqueWords = [...new Set(words)];
    for (const w of uniqueWords) {
      if (!wordSources[w]) wordSources[w] = new Set();
      wordSources[w].add(a.source);
    }
  }

  // Step 2: Score each article
  for (const a of articles) {
    const words = (a.title || '').toLowerCase()
      .replace(/[^a-zA-ZÀ-ÿ\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 5 && !STOP_WORDS.has(w));
    const uniqueWords = [...new Set(words)];

    // Cross-source score: only count words mentioned by 2+ different sources
    const crossSourceScore = uniqueWords.reduce((sum, w) => {
      const srcCount = wordSources[w] ? wordSources[w].size : 0;
      return sum + (srcCount >= 2 ? srcCount - 1 : 0);
    }, 0);

    // Recency bonus (0-1, decays over 24h)
    const ageMs = Date.now() - new Date(a.pubDate).getTime();
    const recency = Math.max(0, 1 - ageMs / (24 * 3600 * 1000));

    a.popularity = Math.round((crossSourceScore * 5 + recency * 3) * 10) / 10;
  }

  // Step 3: Only top 10% get the "trending" badge via a percentile threshold
  const scores = articles.map(a => a.popularity).sort((a, b) => b - a);
  const top10pctIndex = Math.max(0, Math.floor(articles.length * 0.10) - 1);
  const threshold = scores[top10pctIndex] || 999;
  // Store the threshold for the frontend
  for (const a of articles) {
    a.isTrending = a.popularity >= threshold && a.popularity > 0;
  }
}

function extractImage(html) {
  const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

app.get('/api/articles', async (req, res) => {
  const articles = await fetchAllArticles();
  const { sort, q } = req.query;
  let result = [...articles];

  // Search filter
  if (q) {
    const query = q.toLowerCase();
    result = result.filter(
      (a) =>
        a.title.toLowerCase().includes(query) ||
        a.description.toLowerCase().includes(query) ||
        a.source.toLowerCase().includes(query)
    );
  }

  // Sort
  if (sort === 'popularity') {
    result.sort((a, b) => b.popularity - a.popularity);
  } else {
    result.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  }

  res.json(result);
});

// Force refresh (clear cache)
app.post('/api/articles/refresh', async (req, res) => {
  lastFetchTime = 0;
  const articles = await fetchAllArticles();
  res.json({ count: articles.length });
});

/* ════════════════════════════════════════
   IA — résumés & regroupement de sujets
   ──────────────────────────────────────────
   La clé API n'est jamais renvoyée au client : elle entre par POST, ressort
   sous la forme d'un booléen `configured`.
   ════════════════════════════════════════ */
app.get('/api/ai/status', (req, res) => res.json(ai.safeConfig()));

app.post('/api/ai/config', (req, res) => {
  const config = ai.loadConfig();
  const {
    apiKey, model, enabled, provider,
    compatPreset, compatBaseUrl, compatModel, compatKey,
  } = req.body || {};

  if (apiKey !== undefined) {
    const key = String(apiKey).trim();
    if (key && !/^sk-ant-/.test(key)) {
      return res.status(400).json({ error: 'Une clé Anthropic commence par « sk-ant- »' });
    }
    config.apiKey = key || undefined;
  }
  if (model !== undefined) {
    if (!ai.AVAILABLE_MODELS.some((m) => m.id === model)) {
      return res.status(400).json({ error: 'Modèle inconnu' });
    }
    config.model = model;
  }
  if (provider !== undefined) {
    if (!['claude', 'compat', 'none'].includes(provider)) {
      return res.status(400).json({ error: 'Fournisseur inconnu' });
    }
    config.provider = provider;
  }
  if (compatPreset !== undefined) config.compatPreset = String(compatPreset || '');
  if (compatBaseUrl !== undefined) {
    const url = String(compatBaseUrl || '').trim();
    if (url && !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: 'URL de fournisseur invalide' });
    }
    config.compatBaseUrl = url;
  }
  if (compatModel !== undefined) config.compatModel = String(compatModel || '').trim();
  // Chaîne vide = suppression volontaire de la clé (cas d'un serveur local).
  if (compatKey !== undefined) config.compatKey = String(compatKey).trim() || undefined;
  if (enabled !== undefined) config.enabled = Boolean(enabled);

  config.lastError = null;
  ai.saveConfig(config);
  res.json(ai.safeConfig());
});

// Vérifie qu'un fournisseur répond et liste ses modèles. La clé peut être
// fournie ici avant d'être enregistrée : on teste avant de valider.
app.post('/api/ai/compat/probe', async (req, res) => {
  const { baseUrl, key } = req.body || {};
  try {
    res.json(await ai.probeCompat(baseUrl, key ? String(key).trim() : undefined));
  } catch (e) {
    res.status(500).json({ reachable: false, models: [], error: e.message });
  }
});

app.delete('/api/ai', (req, res) => {
  ai.saveConfig({});
  ai.clearCache();
  res.json(ai.safeConfig());
});

app.post('/api/ai/cache/clear', (req, res) => {
  ai.clearCache();
  res.json(ai.safeConfig());
});

// Résumés d'un lot d'articles. Les identifiants proviennent du fil déjà
// chargé : on ne résume que ce que le client affiche réellement.
app.post('/api/ai/summaries', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 60) : [];
  if (ids.length === 0) return res.json({ summaries: {}, mode: 'none' });

  try {
    const articles = await fetchAllArticles();
    const byId = new Map(articles.map((a) => [a.id, a]));
    const wanted = ids.map((id) => byId.get(id)).filter(Boolean);
    res.json(await ai.summarize(wanted));
  } catch (e) {
    res.status(500).json({ error: e.message || 'Résumés indisponibles' });
  }
});

app.get('/api/ai/clusters', async (req, res) => {
  try {
    const articles = await fetchAllArticles();
    const sorted = [...articles].sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    res.json(await ai.cluster(sorted));
  } catch (e) {
    res.status(500).json({ error: e.message || 'Regroupement indisponible' });
  }
});

// --- Boards & Notes ---
function loadBoards() {
  return loadJSON(BOARDS_FILE, [
    { id: 'default', name: 'A lire', icon: '📌', items: [] },
  ]);
}
function saveBoards(boards) { saveJSON(BOARDS_FILE, boards); }

app.get('/api/boards', (req, res) => res.json(loadBoards()));

app.post('/api/boards', (req, res) => {
  const boards = loadBoards();
  const { name, icon } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = crypto.randomBytes(4).toString('hex');
  boards.push({ id, name, icon: icon || '📂', items: [] });
  saveBoards(boards);
  res.json({ ok: true, id });
});

app.delete('/api/boards/:id', (req, res) => {
  let boards = loadBoards();
  boards = boards.filter((b) => b.id !== req.params.id);
  saveBoards(boards);
  res.json({ ok: true });
});

// Save article to board with optional note & highlight
app.post('/api/boards/:id/items', (req, res) => {
  const boards = loadBoards();
  const board = boards.find((b) => b.id === req.params.id);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  const { articleId, title, link, source, highlight, note } = req.body;
  // Prevent duplicates
  if (board.items.some((i) => i.articleId === articleId)) {
    // Update existing
    const item = board.items.find((i) => i.articleId === articleId);
    if (highlight) item.highlight = highlight;
    if (note !== undefined) item.note = note;
  } else {
    board.items.push({
      articleId,
      title,
      link,
      source,
      highlight: highlight || '',
      note: note || '',
      savedAt: new Date().toISOString(),
    });
  }
  saveBoards(boards);
  res.json({ ok: true });
});

// Update note/highlight on a board item
app.patch('/api/boards/:boardId/items/:articleId', (req, res) => {
  const boards = loadBoards();
  const board = boards.find((b) => b.id === req.params.boardId);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  const item = board.items.find((i) => i.articleId === req.params.articleId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (req.body.note !== undefined) item.note = req.body.note;
  if (req.body.highlight !== undefined) item.highlight = req.body.highlight;
  saveBoards(boards);
  res.json({ ok: true });
});

// Remove item from board
app.delete('/api/boards/:boardId/items/:articleId', (req, res) => {
  const boards = loadBoards();
  const board = boards.find((b) => b.id === req.params.boardId);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  board.items = board.items.filter((i) => i.articleId !== req.params.articleId);
  saveBoards(boards);
  res.json({ ok: true });
});

/* ════════════════════════════════════════
   Météo — Open-Meteo
   ──────────────────────────────────────────
   Aucune clé, aucun compte, pas de quota pour un usage personnel. Deux appels :
   le géocodage pour transformer un nom de ville en coordonnées (une fois, le
   client garde le résultat), puis les prévisions.
   ════════════════════════════════════════ */
const weatherCache = new Map(); // "lat,lon" -> { data, at }
const WEATHER_TTL_MS = 10 * 60 * 1000;

app.get('/api/weather/search', async (req, res) => {
  const name = String(req.query.q || '').trim();
  if (name.length < 2) return res.json({ places: [] });
  try {
    const params = new URLSearchParams({ name, count: '6', language: 'fr', format: 'json' });
    const upstream = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`);
    if (!upstream.ok) throw new Error(`geocoding ${upstream.status}`);
    const data = await upstream.json();
    res.json({
      places: (data.results || []).map((r) => ({
        name: r.name,
        country: r.country || '',
        admin: r.admin1 || '',
        lat: r.latitude,
        lon: r.longitude,
        timezone: r.timezone,
      })),
    });
  } catch (e) {
    res.status(502).json({ error: 'Recherche de ville indisponible' });
  }
});

app.get('/api/weather', async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: 'Coordonnées invalides' });
  }

  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const hit = weatherCache.get(key);
  if (hit && Date.now() - hit.at < WEATHER_TTL_MS) return res.json({ ...hit.data, cached: true });

  try {
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m',
      hourly: 'temperature_2m,precipitation_probability,weather_code',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset',
      timezone: 'auto',
      forecast_days: '5',
    });
    const upstream = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
    if (!upstream.ok) throw new Error(`open-meteo ${upstream.status}`);
    const raw = await upstream.json();

    // On ne garde que les heures à venir : le widget affiche les prochaines,
    // pas celles déjà passées.
    const now = Date.now();
    const hours = (raw.hourly?.time || [])
      .map((t, i) => ({
        t,
        temp: raw.hourly.temperature_2m?.[i],
        rain: raw.hourly.precipitation_probability?.[i],
        code: raw.hourly.weather_code?.[i],
      }))
      .filter((h) => new Date(h.t).getTime() >= now - 30 * 60 * 1000)
      .slice(0, 12);

    const data = {
      current: {
        temp: raw.current?.temperature_2m,
        feels: raw.current?.apparent_temperature,
        humidity: raw.current?.relative_humidity_2m,
        wind: raw.current?.wind_speed_10m,
        precipitation: raw.current?.precipitation,
        code: raw.current?.weather_code,
        isDay: raw.current?.is_day === 1,
        time: raw.current?.time,
      },
      hours,
      days: (raw.daily?.time || []).map((t, i) => ({
        date: t,
        code: raw.daily.weather_code?.[i],
        max: raw.daily.temperature_2m_max?.[i],
        min: raw.daily.temperature_2m_min?.[i],
        rain: raw.daily.precipitation_probability_max?.[i],
        sunrise: raw.daily.sunrise?.[i],
        sunset: raw.daily.sunset?.[i],
      })),
      timezone: raw.timezone,
      sampledAt: new Date().toISOString(),
    };
    weatherCache.set(key, { data, at: Date.now() });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'Météo indisponible' });
  }
});

/* ════════════════════════════════════════
   Calendrier — événements locaux + abonnement ICS
   ──────────────────────────────────────────
   Pas d'OAuth Google : un agenda local, plus la possibilité d'abonner une URL
   ICS (Google Calendar, Outlook et Apple en exposent tous une en lecture seule
   dans leurs réglages de partage). Les deux sources sont fusionnées.
   ════════════════════════════════════════ */
const CALENDAR_FILE = path.join(STORE_DIR, 'calendar.json');

function loadCalendar() {
  const data = loadJSON(CALENDAR_FILE, { events: [], subscriptions: [] });
  data.events = data.events || [];
  data.subscriptions = data.subscriptions || [];
  return data;
}

// Analyseur ICS minimal : on ne veut que les VEVENT et leurs trois champs
// utiles. Les lignes pliées (RFC 5545 : continuation par espace) sont
// recollées avant analyse, sinon un titre long est tronqué.
function parseIcs(text) {
  const unfolded = String(text || '').replace(/\r?\n[ \t]/g, '');
  const events = [];
  let current = null;

  for (const line of unfolded.split(/\r?\n/)) {
    if (line.startsWith('BEGIN:VEVENT')) { current = {}; continue; }
    if (line.startsWith('END:VEVENT')) {
      if (current?.start && current.title) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;

    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const rawKey = line.slice(0, sep);
    const value = line.slice(sep + 1);
    const key = rawKey.split(';')[0].toUpperCase();

    if (key === 'SUMMARY') current.title = unescapeIcs(value);
    else if (key === 'LOCATION') current.location = unescapeIcs(value);
    else if (key === 'DTSTART') {
      current.start = icsDate(value);
      // Une date sans heure (VALUE=DATE) est un événement sur la journée.
      current.allDay = /VALUE=DATE(?!-TIME)/i.test(rawKey) || /^\d{8}$/.test(value);
    }
  }
  return events;
}

function unescapeIcs(value) {
  return value.replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

// « 20260730T140000Z » ou « 20260730 » → ISO
function icsDate(value) {
  const m = String(value).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return null;
  const [, y, mo, d, hh = '00', mm = '00', ss = '00', z] = m;
  const iso = `${y}-${mo}-${d}T${hh}:${mm}:${ss}${z ? 'Z' : ''}`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const icsCache = new Map(); // url -> { events, at }
const ICS_TTL_MS = 15 * 60 * 1000;

async function fetchIcs(url) {
  const hit = icsCache.get(url);
  if (hit && Date.now() - hit.at < ICS_TTL_MS) return hit.events;
  const upstream = await fetch(url, { headers: { 'User-Agent': 'FeedMe/1.0' } });
  if (!upstream.ok) throw new Error(`ICS ${upstream.status}`);
  const events = parseIcs(await upstream.text());
  icsCache.set(url, { events, at: Date.now() });
  return events;
}

app.get('/api/calendar', async (req, res) => {
  const store = loadCalendar();
  const errors = [];

  const remote = await Promise.all(store.subscriptions.map(async (sub) => {
    try {
      const events = await fetchIcs(sub.url);
      return events.map((e) => ({ ...e, id: `ics:${sub.id}:${e.start}:${e.title}`, source: sub.name, remote: true }));
    } catch (e) {
      errors.push(`${sub.name} : abonnement injoignable`);
      return [];
    }
  }));

  // Fenêtre glissante : rien avant aujourd'hui, rien au-delà de 60 jours.
  const from = new Date(); from.setHours(0, 0, 0, 0);
  const until = from.getTime() + 60 * 24 * 3600 * 1000;

  const events = [...store.events.map((e) => ({ ...e, remote: false })), ...remote.flat()]
    .filter((e) => e.start && new Date(e.start).getTime() >= from.getTime() && new Date(e.start).getTime() <= until)
    .sort((a, b) => new Date(a.start) - new Date(b.start))
    .slice(0, 200);

  res.json({ events, subscriptions: store.subscriptions, errors });
});

app.post('/api/calendar/events', (req, res) => {
  const { title, start, allDay, location } = req.body || {};
  if (!title || !start) return res.status(400).json({ error: 'Titre et date requis' });
  const date = new Date(start);
  if (Number.isNaN(date.getTime())) return res.status(400).json({ error: 'Date invalide' });

  const store = loadCalendar();
  store.events.push({
    id: crypto.randomBytes(6).toString('hex'),
    title: String(title).slice(0, 200),
    start: date.toISOString(),
    allDay: Boolean(allDay),
    location: location ? String(location).slice(0, 200) : '',
  });
  saveJSON(CALENDAR_FILE, store);
  res.json({ ok: true });
});

app.delete('/api/calendar/events/:id', (req, res) => {
  const store = loadCalendar();
  store.events = store.events.filter((e) => e.id !== req.params.id);
  saveJSON(CALENDAR_FILE, store);
  res.json({ ok: true });
});

app.post('/api/calendar/subscriptions', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  const name = String(req.body?.name || '').trim() || 'Agenda';
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'URL ICS invalide' });

  try {
    // On valide en récupérant tout de suite : une URL fautive doit échouer ici,
    // pas silencieusement à chaque lecture du calendrier.
    const events = await fetchIcs(url);
    const store = loadCalendar();
    if (store.subscriptions.some((s) => s.url === url)) {
      return res.json({ ok: true, duplicate: true });
    }
    store.subscriptions.push({ id: crypto.randomBytes(4).toString('hex'), url, name });
    saveJSON(CALENDAR_FILE, store);
    res.json({ ok: true, events: events.length });
  } catch (e) {
    res.status(400).json({ error: 'Impossible de lire cet agenda ICS' });
  }
});

app.delete('/api/calendar/subscriptions/:id', (req, res) => {
  const store = loadCalendar();
  const sub = store.subscriptions.find((s) => s.id === req.params.id);
  if (sub) icsCache.delete(sub.url);
  store.subscriptions = store.subscriptions.filter((s) => s.id !== req.params.id);
  saveJSON(CALENDAR_FILE, store);
  res.json({ ok: true });
});

/* ════════════════════════════════════════
   To-do
   ════════════════════════════════════════ */
const TODOS_FILE = path.join(STORE_DIR, 'todos.json');

function loadTodos() { return loadJSON(TODOS_FILE, []); }

app.get('/api/todos', (req, res) => res.json(loadTodos()));

app.post('/api/todos', (req, res) => {
  const title = String(req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Intitulé requis' });
  const todos = loadTodos();
  todos.unshift({
    id: crypto.randomBytes(6).toString('hex'),
    title: title.slice(0, 300),
    done: false,
    createdAt: new Date().toISOString(),
  });
  saveJSON(TODOS_FILE, todos.slice(0, 500));
  res.json({ ok: true });
});

app.patch('/api/todos/:id', (req, res) => {
  const todos = loadTodos();
  const todo = todos.find((t) => t.id === req.params.id);
  if (!todo) return res.status(404).json({ error: 'Tâche introuvable' });
  if (req.body?.done !== undefined) {
    todo.done = Boolean(req.body.done);
    todo.doneAt = todo.done ? new Date().toISOString() : null;
  }
  if (req.body?.title) todo.title = String(req.body.title).slice(0, 300);
  saveJSON(TODOS_FILE, todos);
  res.json({ ok: true });
});

app.delete('/api/todos/:id', (req, res) => {
  const todos = loadTodos().filter((t) => t.id !== req.params.id);
  saveJSON(TODOS_FILE, todos);
  res.json({ ok: true });
});

// Purge des tâches terminées, en un appel.
app.delete('/api/todos', (req, res) => {
  const kept = loadTodos().filter((t) => !t.done);
  saveJSON(TODOS_FILE, kept);
  res.json({ ok: true, remaining: kept.length });
});

const PORT = parseInt(process.env.PORT || '3777', 10);

function startServer(port, retries) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      console.log(`FeedMe running at http://localhost:${actualPort}`);
      process.env.FEEDME_PORT = String(actualPort);
      resolve(actualPort);
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && retries > 0) {
        console.log(`Port ${port} busy, trying ${port + 1}...`);
        resolve(startServer(port + 1, retries - 1));
      } else {
        console.error('Server error:', err.message);
        reject(err);
      }
    });
  });
}

const ready = startServer(PORT, 5);

module.exports = { app, ready };
