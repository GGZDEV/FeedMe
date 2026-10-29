'use strict';

/* ════════════════════════════════════════
   ai.js — résumés et regroupement de sujets
   ──────────────────────────────────────────
   Deux services, tous deux facultatifs :

   1. Résumé en deux lignes de chaque article.
   2. Regroupement des articles qui parlent du même sujet.

   Trois moteurs possibles, au choix de l'utilisateur :

   - `claude` : API Anthropic. Meilleure qualité, payante. Traite les articles
     par lots de douze en sortie structurée, et sait regrouper les sujets.
   - `compat` : n'importe quelle API compatible OpenAI — Groq, Gemini,
     OpenRouter, Cerebras, Mistral ont toutes un palier gratuit, et un serveur
     local (Ollama) marche par le même chemin. Un article par appel, en texte
     brut. Le regroupement reste lexical : demander à un petit modèle de
     rassembler cent titres donne des groupes incohérents et des identifiants
     inventés, le lexical est plus honnête à ce niveau de capacité.
   - aucun : résumé extractif (premières phrases nettoyées) et regroupement
     lexical. L'interface ne change pas, seule la qualité baisse.

   Choix d'implémentation (chemin Claude) :
   - Les articles sont traités par lots (un appel pour douze articles) et le
     résultat est mis en cache sur disque par identifiant d'article. Un article
     déjà résumé ne repasse jamais par l'API, même après redémarrage.
   - Sorties structurées (`output_config.format`) plutôt que du JSON demandé en
     prose : la réponse est garantie conforme au schéma, pas de parsing fragile.
   - `effort: 'low'` en laissant la réflexion active. Désactiver la réflexion
     sur Opus 5 expose deux défauts connus (appels d'outils écrits en texte,
     balises internes qui fuient dans la réponse) ; baisser l'effort donne
     l'économie recherchée sans ces risques.
   - `fallbacks: 'default'` : les classificateurs de sûreté peuvent refuser une
     requête (un article de presse sur la cybersécurité, par exemple). Le repli
     serveur relance alors la demande sur un autre modèle au lieu de renvoyer un
     refus. Si le compte n'a pas accès à cette bêta, on réessaie sans.
   ════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AnthropicSDK = require('@anthropic-ai/sdk');
const Anthropic = AnthropicSDK.default || AnthropicSDK;

const DEFAULT_MODEL = 'claude-opus-5';
const AVAILABLE_MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5 — le plus capable' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 — équilibré' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — le plus rapide' },
];

/* ────────────────────────────────────────
   Fournisseur « compatible OpenAI » (offres gratuites)
   ──────────────────────────────────────────
   Groq, Google Gemini, OpenRouter, Mistral et Cerebras exposent tous le même
   endpoint `/v1/chat/completions` et disposent tous d'un palier gratuit. Un
   seul chemin de code les couvre — et il couvre aussi, sans rien changer, un
   serveur local (Ollama, LM Studio) si l'envie prend un jour : il suffit de
   laisser la clé vide.

   Un petit modèle ne tient pas la charge d'un lot de douze articles rendu en
   JSON structuré : il oublie des entrées, invente des identifiants ou casse le
   schéma. Ce chemin traite donc **un article à la fois, en texte brut**, avec
   une petite concurrence. C'est plus d'appels, mais ils sont gratuits et la
   fiabilité est sans commune mesure.

   Chaque préréglage porte sa contrainte réelle plutôt qu'un « gratuit » vague :
   quota, condition d'accès, contrepartie. Ces conditions évoluent — d'où la date
   de vérification affichée dans l'interface, et le fait que la page d'inscription
   fasse toujours foi. Cerebras a été retiré de cette liste : sa formule « Free
   Trial » exige une carte bancaire et n'accorde que 5 $ de crédits expirant en
   30 jours, ce qui n'est pas un palier gratuit.
   ──────────────────────────────────────── */
const COMPAT_CONCURRENCY = 3;
const COMPAT_TIMEOUT_MS = 60000;
const COMPAT_CHECKED_ON = '31 juillet 2026';

const COMPAT_PRESETS = [
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai',
    model: 'llama-3.1-8b-instant',
    signup: 'https://console.groq.com/keys',
    note: 'Palier gratuit, clé immédiate.',
    limit: '30 requêtes/min mais seulement 6 000 tokens/min : les résumés arrivent par vagues.',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash-lite',
    signup: 'https://aistudio.google.com/apikey',
    note: 'Palier gratuit via Google AI Studio.',
    limit: 'Contrepartie : Google se réserve d\'exploiter le contenu envoyé sur le palier gratuit.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    signup: 'https://openrouter.ai/keys',
    note: 'Modèles dont l\'identifiant finit par « :free ».',
    limit: '50 requêtes/jour sans achat de crédits — vite atteint. 1 000/jour après 10 $ d\'achat.',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai',
    model: 'mistral-small-latest',
    signup: 'https://console.mistral.ai/api-keys',
    note: 'Palier « Experiment » gratuit, modèle européen.',
    limit: 'Vérification par téléphone obligatoire à l\'inscription.',
  },
  {
    id: 'ollama',
    label: 'Serveur local (Ollama, LM Studio…)',
    baseUrl: 'http://localhost:11434',
    model: 'llama3.2:3b',
    signup: 'https://ollama.com/download',
    note: 'Aucune clé, aucun quota, rien ne sort de la machine.',
    limit: 'Tourne sur votre GPU : ~5 Go à télécharger, et il faut que le serveur soit lancé.',
  },
];

const BATCH_SIZE = 12;
const MAX_CACHE_ENTRIES = 4000;
const CLUSTER_TTL_MS = 30 * 60 * 1000;

let STORE_DIR = __dirname;
let CONFIG_FILE = path.join(STORE_DIR, 'ai.json');
let CACHE_FILE = path.join(STORE_DIR, 'data', 'ai-cache.json');

function configure(storeDir) {
  STORE_DIR = storeDir;
  CONFIG_FILE = path.join(STORE_DIR, 'ai.json');
  CACHE_FILE = path.join(STORE_DIR, 'data', 'ai-cache.json');
}

/* ────────────────────────────────────────
   Configuration
   ──────────────────────────────────────── */
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch (e) { /* fichier illisible : on repart de zéro */ }
  return {};
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// La clé n'est jamais renvoyée au client : elle n'entre que par POST.
function safeConfig() {
  const config = loadConfig();
  const cache = loadCache();
  return {
    provider: config.provider || (config.apiKey ? 'claude' : 'none'),
    configured: Boolean(config.apiKey),
    enabled: config.enabled !== false,
    model: config.model || DEFAULT_MODEL,
    models: AVAILABLE_MODELS,
    compatPresets: COMPAT_PRESETS,
    compatCheckedOn: COMPAT_CHECKED_ON,
    compatPreset: config.compatPreset || '',
    compatBaseUrl: config.compatBaseUrl || '',
    compatModel: config.compatModel || '',
    // Comme la clé Anthropic, la clé du fournisseur ne ressort jamais.
    compatConfigured: Boolean(config.compatKey),
    compatNeedsKey: Boolean(config.compatBaseUrl) && !isLocalEndpoint(config.compatBaseUrl),
    // Le client n'a pas à rejouer la logique d'activation : le serveur tranche.
    ready: activeProvider() !== null,
    cachedSummaries: Object.keys(cache.summaries || {}).length,
    lastError: config.lastError || null,
  };
}

// Un serveur qui tourne sur la machine ou le réseau local n'exige pas de clé ;
// un fournisseur distant, si. Sans cette distinction, un préréglage à peine
// choisi (URL + modèle remplis, clé encore vide) se déclarerait opérationnel et
// échouerait en 401 sur chaque article.
function isLocalEndpoint(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
      || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  } catch (e) {
    return false;
  }
}

// Quel moteur sert les résumés : 'claude', 'compat', ou null (mode extractif).
function activeProvider() {
  const config = loadConfig();
  if (config.enabled === false) return null;
  const provider = config.provider || (config.apiKey ? 'claude' : 'none');
  if (provider === 'claude') return config.apiKey ? 'claude' : null;
  if (provider === 'compat') {
    if (!config.compatBaseUrl || !config.compatModel) return null;
    if (!config.compatKey && !isLocalEndpoint(config.compatBaseUrl)) return null;
    return 'compat';
  }
  return null;
}

function isActive() { return activeProvider() !== null; }

// L'empreinte du moteur sert de clé de cache : changer de modèle doit invalider
// les résumés, leur qualité n'étant pas comparable.
function engineTag() {
  const config = loadConfig();
  return activeProvider() === 'compat'
    ? `compat:${config.compatModel}`
    : (config.model || DEFAULT_MODEL);
}

function recordError(message) {
  const config = loadConfig();
  saveConfig({ ...config, lastError: message ? { message, at: new Date().toISOString() } : null });
}

/* ────────────────────────────────────────
   Cache disque
   ──────────────────────────────────────── */
let cacheMemo = null;

function loadCache() {
  if (cacheMemo) return cacheMemo;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      cacheMemo = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    }
  } catch (e) { /* cache corrompu : on le reconstruit */ }
  if (!cacheMemo || typeof cacheMemo !== 'object') cacheMemo = {};
  cacheMemo.summaries = cacheMemo.summaries || {};
  cacheMemo.clusters = cacheMemo.clusters || {};
  return cacheMemo;
}

function saveCache() {
  const cache = loadCache();

  // Purge des plus anciens résumés au-delà du plafond.
  const entries = Object.entries(cache.summaries);
  if (entries.length > MAX_CACHE_ENTRIES) {
    entries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
    cache.summaries = Object.fromEntries(entries.slice(0, MAX_CACHE_ENTRIES));
  }
  // Un seul regroupement conservé : il porte sur l'ensemble du fil.
  const clusterKeys = Object.keys(cache.clusters);
  if (clusterKeys.length > 4) {
    const kept = clusterKeys
      .map((k) => [k, cache.clusters[k]])
      .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
      .slice(0, 4);
    cache.clusters = Object.fromEntries(kept);
  }

  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch (e) {
    console.error('[ai] écriture du cache impossible:', e.message);
  }
}

function clearCache() {
  cacheMemo = { summaries: {}, clusters: {} };
  saveCache();
}

/* ────────────────────────────────────────
   Appel API
   ──────────────────────────────────────── */
let clientMemo = { key: null, client: null };
// Certains comptes n'ont pas accès à la bêta de repli serveur : on retient le
// refus pour ne pas retenter à chaque requête.
let serverFallbackAvailable = true;

function getClient() {
  const { apiKey } = loadConfig();
  if (!apiKey) return null;
  if (clientMemo.key !== apiKey) {
    clientMemo = { key: apiKey, client: new Anthropic({ apiKey, maxRetries: 2 }) };
  }
  return clientMemo.client;
}

function textOf(message) {
  return (message.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

async function askClaude({ system, prompt, schema, maxTokens = 8000 }) {
  const client = getClient();
  if (!client) throw new Error('Clé API Claude absente');
  const model = loadConfig().model || DEFAULT_MODEL;

  const base = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
    output_config: {
      // Réflexion laissée active (défaut sur Opus 5), effort abaissé : c'est le
      // réglage recommandé pour économiser sans désactiver la réflexion.
      effort: 'low',
      format: { type: 'json_schema', schema },
    },
  };

  const send = (withFallback) => (withFallback
    ? client.beta.messages.create({
      ...base,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    })
    : client.messages.create(base));

  let message;
  try {
    message = await send(serverFallbackAvailable);
  } catch (e) {
    // Le repli serveur est une bêta : si le compte n'y a pas droit, la requête
    // part sans, plutôt que d'échouer.
    const aboutFallback = e instanceof Anthropic.BadRequestError
      && /fallback|beta/i.test(e.message || '');
    if (serverFallbackAvailable && aboutFallback) {
      serverFallbackAvailable = false;
      message = await send(false);
    } else {
      throw e;
    }
  }

  // Un refus renvoie un HTTP 200 : sans ce test, la lecture du contenu part
  // sur un tableau vide.
  if (message.stop_reason === 'refusal') {
    const category = message.stop_details?.category || 'non précisée';
    throw new Error(`Requête refusée par les garde-fous de sûreté (catégorie : ${category})`);
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error('Réponse tronquée : lot trop volumineux');
  }

  const raw = textOf(message);
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error('Réponse IA illisible');
  }
}

/* ────────────────────────────────────────
   Fournisseur compatible OpenAI
   ──────────────────────────────────────── */
function normalizeBase(url) {
  // Les fournisseurs publient tantôt « …/openai », tantôt « …/openai/v1 » :
  // on retire le /v1 final pour le rajouter nous-mêmes, sans le doubler.
  return String(url || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

function compatHeaders(key) {
  return {
    'Content-Type': 'application/json',
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
  };
}

// Vérifie l'accès et liste les modèles disponibles. `/v1/models` est standard ;
// un serveur Ollama répond en plus sur `/api/tags`.
//
// Le test est déclenché par un clic, bouton désactivé pendant l'attente : il
// DOIT rendre la main vite. Deux précautions, parce qu'une seule ne suffit pas :
// les deux tentatives partent en parallèle (elles sont indépendantes), et une
// échéance globale coiffe le tout — `fetch` n'honore pas toujours l'abandon sur
// une adresse non routable, où l'on mesurait 38 secondes de blocage.
const PROBE_ATTEMPT_MS = 5000;
const PROBE_DEADLINE_MS = 6000;

async function probeCompat(baseUrl, keyOverride) {
  const base = normalizeBase(baseUrl);
  if (!base) return { reachable: false, models: [], error: 'URL manquante' };
  const key = keyOverride || loadConfig().compatKey || '';

  const attempt = async (path, headers, pick) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_ATTEMPT_MS);
    try {
      const res = await fetch(base + path, { headers, signal: controller.signal });
      if (!res.ok) return { status: res.status, body: (await res.text().catch(() => '')).slice(0, 160) };
      return { models: pick(await res.json()) };
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const probes = Promise.all([
    attempt('/v1/models', compatHeaders(key), (d) => (d.data || []).map((m) => ({ id: m.id }))),
    attempt('/api/tags', {}, (d) =>
      (d.models || []).map((m) => ({ id: m.name, size: m.size ? `${(m.size / 1e9).toFixed(1)} Go` : '' }))),
  ]);

  let deadlineTimer;
  const deadline = new Promise((resolve) => {
    deadlineTimer = setTimeout(() => resolve(null), PROBE_DEADLINE_MS);
  });

  const settled = await Promise.race([probes, deadline]);
  clearTimeout(deadlineTimer);
  if (!settled) {
    return { reachable: false, baseUrl: base, models: [], error: 'Aucune réponse dans le délai imparti' };
  }

  const [openai, ollama] = settled;
  if (openai?.models) return { reachable: true, baseUrl: base, models: openai.models };
  if (ollama?.models) return { reachable: true, baseUrl: base, models: ollama.models };

  if (openai?.status === 401 || openai?.status === 403) {
    return { reachable: false, baseUrl: base, models: [], error: 'Clé refusée par le fournisseur' };
  }
  if (openai?.status) {
    return { reachable: false, baseUrl: base, models: [], error: `HTTP ${openai.status}` };
  }
  return { reachable: false, baseUrl: base, models: [], error: 'Serveur injoignable' };
}

async function compatChat({ system, prompt, maxTokens = 200 }) {
  const config = loadConfig();
  const base = normalizeBase(config.compatBaseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMPAT_TIMEOUT_MS);

  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: compatHeaders(config.compatKey),
      signal: controller.signal,
      body: JSON.stringify({
        model: config.compatModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        // Peu de créativité voulue : on résume, on n'invente pas.
        temperature: 0.2,
        max_tokens: maxTokens,
        stream: false,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let message;
      if (res.status === 401 || res.status === 403) message = 'Clé API refusée par le fournisseur';
      else if (res.status === 404) message = `Modèle « ${config.compatModel} » introuvable chez ce fournisseur`;
      else if (res.status === 429) message = 'Quota gratuit atteint — réessayez plus tard';
      else message = `Fournisseur : HTTP ${res.status}${body ? ' — ' + body.slice(0, 120) : ''}`;
      const err = new Error(message);
      err.compat = true;
      throw err;
    }

    const data = await res.json();
    return data?.choices?.[0]?.message?.content || '';
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error('Le fournisseur n\'a pas répondu à temps');
      err.compat = true;
      throw err;
    }
    if (!e.compat) {
      const err = new Error('Fournisseur injoignable — vérifiez l\'URL et votre connexion');
      err.compat = true;
      throw err;
    }
    throw e;
  }
}

// Un petit modèle enrobe volontiers sa réponse. On retire les préfixes, les
// guillemets et tout ce qui dépasse deux phrases.
function tidySummary(raw) {
  let text = String(raw || '')
    .replace(/<\/?think>[\s\S]*?(<\/think>|$)/gi, '') // modèles à raisonnement visible
    .replace(/^\s*(résumé|resume|summary)\s*[:\-–]\s*/i, '')
    .replace(/^["«»'`\s]+|["«»'`\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const sentences = text.match(/[^.!?]+[.!?]+/g);
  // Chaque phrase capturée traîne l'espace qui la précède : sans ce trim, le
  // recollage produit une double espace au milieu du résumé.
  if (sentences && sentences.length > 2) {
    text = sentences.slice(0, 2).map((s) => s.trim()).join(' ');
  }
  return text.slice(0, 300);
}

// Exécute des tâches par petits paquets : un palier gratuit sature vite.
async function mapWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function friendlyError(e) {
  if (e.compat) return e.message;
  if (e instanceof Anthropic.AuthenticationError) return 'Clé API refusée par Anthropic';
  if (e instanceof Anthropic.PermissionDeniedError) return 'Cette clé n\'a pas accès à ce modèle';
  if (e instanceof Anthropic.NotFoundError) return 'Modèle introuvable';
  if (e instanceof Anthropic.RateLimitError) return 'Limite de débit atteinte, réessayez dans un instant';
  if (e instanceof Anthropic.APIConnectionError) return 'Impossible de joindre l\'API Anthropic';
  return e.message || 'Erreur IA';
}

/* ────────────────────────────────────────
   Résumés
   ──────────────────────────────────────── */
const SUMMARY_SYSTEM = `Tu résumes des articles de presse pour un lecteur de flux RSS.

Pour chaque article, écris un résumé de deux phrases courtes au maximum, en français, qui dit ce qui s'est réellement passé — pas ce dont l'article parle. Va droit au fait : pas de « cet article explique que », pas de formule d'accroche, pas de question rhétorique.

Tu ne disposes que du titre et d'un extrait tronqué. N'invente aucun fait qui n'y figure pas : si l'extrait est trop pauvre pour un résumé fiable, reformule simplement le titre en une phrase informative.`;

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summaries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          summary: { type: 'string' },
        },
        required: ['id', 'summary'],
        additionalProperties: false,
      },
    },
  },
  required: ['summaries'],
  additionalProperties: false,
};

// Repli sans clé : deux premières phrases nettoyées.
function extractiveSummary(article) {
  const source = (article.description || '').replace(/\s+/g, ' ').trim();
  if (!source) return '';
  const sentences = source.match(/[^.!?]+[.!?]+/g);
  if (!sentences) return source.slice(0, 180);
  return sentences.slice(0, 2).map((s) => s.trim()).join(' ').slice(0, 260);
}

const inFlight = new Map();

const COMPAT_SUMMARY_SYSTEM = `Tu résumes des articles de presse en français.

Réponds par deux phrases courtes au maximum, qui disent ce qui s'est réellement passé. Pas de préambule, pas de guillemets, pas de titre, pas de liste : uniquement le résumé.

N'invente aucun fait absent du texte fourni. Si l'extrait est trop pauvre, reformule le titre en une phrase informative.`;

// Un article par appel, en texte brut : un petit modèle ne tient pas un lot
// rendu en JSON structuré. Dès la première panne du serveur on arrête d'appeler
// et on bascule le reste en extractif — inutile d'enchaîner N échecs.
async function summarizeCompat(todo, out, cache, engine) {
  let failure = null;

  await mapWithLimit(todo, COMPAT_CONCURRENCY, async (article) => {
    if (failure) { out[article.id] = extractiveSummary(article); return; }

    const prompt = [
      `Titre : ${article.title || ''}`,
      `Source : ${article.source || ''}`,
      `Extrait : ${(article.description || '').slice(0, 700)}`,
    ].join('\n');

    try {
      const text = tidySummary(await compatChat({ system: COMPAT_SUMMARY_SYSTEM, prompt }));
      if (text) {
        out[article.id] = text;
        cache.summaries[article.id] = { text, model: engine, at: Date.now() };
        return;
      }
      out[article.id] = extractiveSummary(article); // réponse vide : on ne cache pas
    } catch (e) {
      failure = failure || friendlyError(e);
      out[article.id] = extractiveSummary(article);
    }
  });

  return failure;
}

async function summarize(articles) {
  const cache = loadCache();
  const engine = engineTag();
  const provider = activeProvider();
  const out = {};
  const todo = [];

  for (const article of articles) {
    const hit = cache.summaries[article.id];
    // Un changement de moteur invalide les résumés : la qualité n'est pas la même.
    if (hit && hit.model === engine) { out[article.id] = hit.text; continue; }
    todo.push(article);
  }

  if (todo.length === 0) return { summaries: out, mode: provider ? 'ai' : 'extractive', provider };

  if (!provider) {
    for (const article of todo) out[article.id] = extractiveSummary(article);
    return { summaries: out, mode: 'extractive', provider: null };
  }

  if (provider === 'compat') {
    const failure = await summarizeCompat(todo, out, cache, engine);
    saveCache();
    recordError(failure);
    return { summaries: out, mode: failure ? 'partial' : 'ai', provider, error: failure };
  }

  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH_SIZE) batches.push(todo.slice(i, i + BATCH_SIZE));

  let failure = null;
  await Promise.all(batches.map(async (batch) => {
    const key = batch.map((a) => a.id).sort().join(',');
    // Deux widgets qui demandent le même lot ne déclenchent qu'un appel.
    if (inFlight.has(key)) {
      try { Object.assign(out, await inFlight.get(key)); } catch (e) { /* traité plus bas */ }
      return;
    }

    const work = (async () => {
      const prompt = 'Résume chacun de ces articles.\n\n' + batch.map((a) => [
        `<article id="${a.id}">`,
        `<titre>${a.title || ''}</titre>`,
        `<source>${a.source || ''}</source>`,
        `<extrait>${(a.description || '').slice(0, 700)}</extrait>`,
        '</article>',
      ].join('\n')).join('\n\n');

      const data = await askClaude({
        system: SUMMARY_SYSTEM,
        prompt,
        schema: SUMMARY_SCHEMA,
        maxTokens: 8000,
      });

      const local = {};
      for (const item of data.summaries || []) {
        if (!item?.id || !item.summary) continue;
        local[item.id] = item.summary.trim();
        cache.summaries[item.id] = { text: local[item.id], model: engine, at: Date.now() };
      }
      return local;
    })();

    inFlight.set(key, work);
    try {
      Object.assign(out, await work);
    } catch (e) {
      failure = failure || friendlyError(e);
      // Le lot qui échoue retombe sur l'extractif : l'interface reste peuplée.
      for (const article of batch) out[article.id] = extractiveSummary(article);
    } finally {
      inFlight.delete(key);
    }
  }));

  saveCache();
  recordError(failure);
  return { summaries: out, mode: failure ? 'partial' : 'ai', provider, error: failure };
}

/* ────────────────────────────────────────
   Regroupement des sujets
   ──────────────────────────────────────── */
const CLUSTER_SYSTEM = `Tu regroupes des titres d'articles de presse qui traitent du même sujet.

Un groupe rassemble des articles portant sur le même événement ou la même affaire, même si les titres sont formulés différemment ou viennent de sources différentes. Deux articles sur le même thème général mais des faits distincts ne forment PAS un groupe.

Ne crée que des groupes de deux articles ou plus. Les articles isolés ne doivent apparaître dans aucun groupe. Donne à chaque groupe un intitulé de quatre à six mots qui nomme le sujet.`;

const CLUSTER_SCHEMA = {
  type: 'object',
  properties: {
    topics: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['label', 'ids'],
        additionalProperties: false,
      },
    },
  },
  required: ['topics'],
  additionalProperties: false,
};

const CLUSTER_STOP_WORDS = new Set([
  'cette', 'comme', 'dans', 'depuis', 'encore', 'entre', 'faire', 'avant',
  'apres', 'aussi', 'autre', 'leurs', 'mais', 'notre', 'plus', 'pour',
  'quand', 'sans', 'selon', 'seront', 'tout', 'toute', 'tous', 'toutes',
  'votre', 'avoir', 'avec', 'etre', 'elle', 'sont', 'nous', 'vous',
  'nouveau', 'nouvelle', 'nouveaux', 'comment', 'pourquoi', 'contre',
]);

function keywordsOf(title) {
  return new Set((title || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // retire les accents
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 5 && !CLUSTER_STOP_WORDS.has(w)));
}

// Repli sans clé : deux articles vont ensemble s'ils partagent au moins deux
// mots significatifs dans leur titre.
function lexicalClusters(articles) {
  const seen = new Set();
  const topics = [];
  const words = articles.map((a) => ({ a, w: keywordsOf(a.title) }));

  for (let i = 0; i < words.length; i++) {
    if (seen.has(words[i].a.id)) continue;
    const group = [words[i].a];
    const shared = new Set();
    for (let j = i + 1; j < words.length; j++) {
      if (seen.has(words[j].a.id)) continue;
      const common = [...words[i].w].filter((w) => words[j].w.has(w));
      if (common.length >= 2) {
        group.push(words[j].a);
        for (const w of common) shared.add(w);
      }
    }
    if (group.length >= 2) {
      for (const a of group) seen.add(a.id);
      topics.push({ label: [...shared].slice(0, 4).join(' '), ids: group.map((a) => a.id) });
    }
  }
  return topics;
}

async function cluster(articles) {
  const subset = articles.slice(0, 120); // au-delà, le regroupement n'apporte rien
  const signature = crypto.createHash('md5')
    .update(subset.map((a) => a.id).join(',') + '|' + (loadConfig().model || DEFAULT_MODEL))
    .digest('hex');

  const cache = loadCache();
  const hit = cache.clusters[signature];
  if (hit && Date.now() - hit.at < CLUSTER_TTL_MS) {
    return { topics: hit.topics, mode: hit.mode };
  }

  if (!isActive()) {
    const topics = lexicalClusters(subset);
    cache.clusters[signature] = { topics, mode: 'lexical', at: Date.now() };
    saveCache();
    return { topics, mode: 'lexical' };
  }

  try {
    const prompt = 'Regroupe les articles qui traitent du même sujet.\n\n' + subset
      .map((a) => `${a.id} · [${a.source || '?'}] ${a.title || ''}`)
      .join('\n');

    const data = await askClaude({
      system: CLUSTER_SYSTEM,
      prompt,
      schema: CLUSTER_SCHEMA,
      maxTokens: 8000,
    });

    const valid = new Set(subset.map((a) => a.id));
    const topics = (data.topics || [])
      // Le modèle peut renvoyer un identifiant inventé ou un groupe d'un seul
      // article malgré la consigne : on filtre plutôt que de faire confiance.
      .map((t) => ({ label: String(t.label || '').trim(), ids: (t.ids || []).filter((id) => valid.has(id)) }))
      .filter((t) => t.label && t.ids.length >= 2);

    cache.clusters[signature] = { topics, mode: 'ai', at: Date.now() };
    saveCache();
    recordError(null);
    return { topics, mode: 'ai' };
  } catch (e) {
    const message = friendlyError(e);
    recordError(message);
    return { topics: lexicalClusters(subset), mode: 'lexical', error: message };
  }
}

/* ────────────────────────────────────────
   API du module
   ──────────────────────────────────────── */
module.exports = {
  configure,
  safeConfig,
  isActive,
  activeProvider,
  loadConfig,
  saveConfig,
  clearCache,
  summarize,
  cluster,
  extractiveSummary,
  probeCompat,
  DEFAULT_MODEL,
  AVAILABLE_MODELS,
  COMPAT_PRESETS,
};
