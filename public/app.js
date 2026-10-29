'use strict';

/* ════════════════════════════════════════
   Intégration Electron
   ════════════════════════════════════════ */
const isElectron = typeof window.widget !== 'undefined';
if (isElectron) document.body.classList.add('electron', 'dock-right');

async function togglePin() {
  if (!isElectron) return;
  const isOn = await window.widget.toggleAlwaysOnTop();
  document.getElementById('btn-pin').classList.toggle('active', isOn);
}
async function minimizeWin() { if (isElectron) window.widget.minimize(); }
async function closeWin() { if (isElectron) window.widget.close(); }
async function maximizeWin() { if (isElectron) window.widget.toggleMaximize(); }
async function dockRight() { if (isElectron) window.widget.dockRight(); closeDockMenu(); }
async function dockLeft() { if (isElectron) window.widget.dockLeft(); closeDockMenu(); }
async function tabletMode() { if (isElectron) window.widget.setTabletMode(); updateAutoHideLabel(false); closeDockMenu(); }

async function toggleAutoHide() {
  if (!isElectron) return;
  const active = await window.widget.toggleAutoHide();
  updateAutoHideLabel(active);
  if (active) updateReserveLabel(false); // mutually exclusive with reserved space
  closeDockMenu();
}
function updateAutoHideLabel(active) {
  const label = document.getElementById('autohide-label');
  if (label) label.textContent = active ? 'Désactiver auto-masquer' : 'Activer auto-masquer';
  const btn = document.getElementById('btn-autohide');
  if (btn) btn.style.color = active ? 'var(--accent)' : '';
}

async function toggleReserveSpace() {
  if (!isElectron || !window.widget.toggleReserveSpace) return;
  const active = await window.widget.toggleReserveSpace();
  updateReserveLabel(active);
  if (active) updateAutoHideLabel(false); // mutually exclusive with auto-hide
  closeDockMenu();
}
function updateReserveLabel(active) {
  const label = document.getElementById('reserve-label');
  if (label) label.textContent = active ? 'Détacher du bureau' : 'Ancrer au bureau';
  const btn = document.getElementById('btn-reserve');
  if (btn) btn.style.color = active ? 'var(--accent)' : '';
}

if (isElectron) {
  if (window.widget.onAutoHideState) {
    window.widget.onAutoHideState((hidden) => {
      document.body.classList.toggle('panel-hidden', hidden);
    });
  }
  if (window.widget.onReserveState) {
    window.widget.onReserveState((on) => updateReserveLabel(on));
  }
  if (window.widget.onDockSideState) {
    window.widget.onDockSideState((side) => {
      document.body.classList.toggle('dock-left', side === 'left');
      document.body.classList.toggle('dock-right', side !== 'left');
      const arrow = document.querySelector('.side-peek-arrow');
      if (arrow) arrow.innerHTML = side === 'left' ? '&#10094;' : '&#10095;';
    });
  }
  if (window.widget.onAccentColorState) window.widget.onAccentColorState(applyAccentColor);
  if (window.widget.getAccentColor) window.widget.getAccentColor().then(applyAccentColor);
  window.widget.getAlwaysOnTop().then((on) => {
    document.getElementById('btn-pin').classList.toggle('active', on);
  });
}

// L'accent Windows n'est repris que s'il est vraiment coloré et lisible sur
// fond sombre. Un accent gris ou très sombre (ex. #3F3F3F) éteindrait toutes
// les couleurs d'état : on garde alors le vert de FeedMe.
function isUsableAccent({ r, g, b }) {
  const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255;
  const lightness = (max + min) / 2;
  const saturation = max === min ? 0 : (max - min) / (1 - Math.abs(2 * lightness - 1));
  return saturation >= 0.3 && lightness >= 0.35;
}
function applyAccentColor(color) {
  const rgb = hexToRgb(color);
  if (!rgb || !isUsableAccent(rgb)) {
    document.documentElement.style.removeProperty('--accent');
    document.documentElement.style.removeProperty('--accent-rgb');
    return;
  }
  document.documentElement.style.setProperty('--accent', color);
  document.documentElement.style.setProperty('--accent-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
}

function hexToRgb(color) {
  const hex = String(color || '').replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

function toggleDockMenu() { document.getElementById('dock-menu').classList.toggle('open'); }
function closeDockMenu() { document.getElementById('dock-menu').classList.remove('open'); }
document.addEventListener('click', (e) => {
  if (!e.target.closest('#btn-dock') && !e.target.closest('#dock-menu')) closeDockMenu();
});

/* ════════════════════════════════════════
   Helpers
   ════════════════════════════════════════ */
function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escAttr(s) { return esc(s).replace(/'/g, '&#39;'); }

function icon(name, cls = '') {
  return `<svg class="ic ${cls}"><use href="#${name}"/></svg>`;
}

function faviconImg(link, cls = 'favicon') {
  try {
    const host = new URL(link).hostname;
    return `<img class="${cls}" src="https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(host)}" alt="" loading="lazy" onerror="this.remove()">`;
  } catch (e) {
    return '';
  }
}

function hostOf(link) {
  try { return new URL(link).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "à l'instant";
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} h`;
  const days = Math.floor(hrs / 24);
  return `${days} j`;
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${Math.round(value)}%` : '--';
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '--';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function tempLabel(value) {
  return Number.isFinite(value) ? `${Math.round(value)}°C` : 'N/A';
}

function catColor(name) { return Store.catColors[name] || '#a78bfa'; }

function meterColor(percent) {
  if (!Number.isFinite(percent)) return 'var(--text-faint)';
  if (percent >= 85) return 'var(--danger)';
  if (percent >= 70) return 'var(--warn)';
  return 'var(--accent)';
}

// Suppression en deux clics : le premier arme le bouton, le second exécute.
function confirmClick(btn, fnName, ...args) {
  if (btn.dataset.armed) {
    delete btn.dataset.armed;
    btn.classList.remove('armed');
    window[fnName](...args);
    return;
  }
  btn.dataset.armed = '1';
  btn.classList.add('armed');
  btn.title = 'Cliquez à nouveau pour confirmer';
  setTimeout(() => {
    delete btn.dataset.armed;
    btn.classList.remove('armed');
  }, 2600);
}

/* ════════════════════════════════════════
   Toasts
   ════════════════════════════════════════ */
function showToast(msg, type = 'success') {
  const container = document.getElementById('toasts');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `${icon(type === 'error' ? 'i-x' : 'i-check')}<span>${esc(msg)}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('out');
    setTimeout(() => toast.remove(), 350);
  }, 2400);
}

/* ════════════════════════════════════════
   Bus de données
   ──────────────────────────────────────────
   Les widgets ne sondent jamais l'API eux-mêmes : le noyau récupère, range
   dans Store, puis publie. Deux widgets qui affichent la même donnée ne
   déclenchent donc qu'une seule requête.
   ════════════════════════════════════════ */
const Bus = (() => {
  const subs = new Map();
  return {
    on(topic, fn) {
      if (!subs.has(topic)) subs.set(topic, new Set());
      subs.get(topic).add(fn);
      return () => subs.get(topic)?.delete(fn);
    },
    emit(topic, data) {
      const set = subs.get(topic);
      if (!set) return;
      for (const fn of [...set]) {
        try { fn(data); } catch (e) { console.error(`[bus:${topic}]`, e); }
      }
    },
    // Nombre d'abonnés : sert à ne sonder que ce qui est réellement affiché.
    count(topic) { return subs.get(topic)?.size || 0; },
  };
})();

const Store = {
  articles: [],
  feeds: [],
  categories: [],
  catColors: {},
  suggestions: [],
  boards: [],
  savedArticleIds: new Set(),
  metrics: null,
  aiUsage: null,
  spotifyStatus: { configured: false, connected: false, redirectUri: '' },
  spotifyState: null,
  feedlyStatus: { connected: false },
  query: '',
  sort: 'date',
  articlesError: null,
  loadingArticles: false,
};

// Articles lus, conservés en localStorage
let readArticleIds = new Set(JSON.parse(localStorage.getItem('fm-read') || '[]'));
function isRead(id) { return readArticleIds.has(id); }
function markAsRead(id) {
  readArticleIds.add(id);
  const arr = [...readArticleIds];
  if (arr.length > 2000) readArticleIds = new Set(arr.slice(-2000));
  localStorage.setItem('fm-read', JSON.stringify([...readArticleIds]));
  Bus.emit('read', id);
  updateStatus();
}

/* ════════════════════════════════════════
   API
   ════════════════════════════════════════ */
async function api(path, options = {}) {
  if (options.json !== undefined) {
    options.body = JSON.stringify(options.json);
    options.headers = { 'Content-Type': 'application/json', ...options.headers };
    delete options.json;
  }
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur HTTP ${res.status}`);
  return data;
}

async function fetchArticles() {
  Store.loadingArticles = true;
  Bus.emit('articles:loading');
  try {
    const params = new URLSearchParams();
    if (Store.sort === 'popularity') params.set('sort', 'popularity');
    if (Store.query) params.set('q', Store.query);
    Store.articles = await api('/api/articles?' + params);
    Store.articlesError = null;
  } catch (e) {
    Store.articlesError = e.message;
  } finally {
    Store.loadingArticles = false;
  }
  Bus.emit('articles', Store.articles);
  updateStatus();
}

async function fetchFeeds() {
  Store.feeds = await api('/api/feeds');
  Bus.emit('feeds', Store.feeds);
}

async function fetchSuggestions() {
  Store.suggestions = await api('/api/feed-suggestions');
  Bus.emit('suggestions', Store.suggestions);
}

async function fetchBoards() {
  Store.boards = await api('/api/boards');
  Store.savedArticleIds.clear();
  for (const b of Store.boards) {
    for (const item of b.items) Store.savedArticleIds.add(item.articleId);
  }
  Bus.emit('boards', Store.boards);
}

async function fetchCategories() {
  Store.categories = await api('/api/categories');
  Store.catColors = {};
  for (const c of Store.categories) Store.catColors[c.name] = c.color;
  Bus.emit('categories', Store.categories);
}

async function fetchFeedlyStatus() {
  try {
    Store.feedlyStatus = await api('/api/feedly/status');
  } catch (e) {
    Store.feedlyStatus = { connected: false };
  }
  renderFeedlyStatus();
}

/* ── Historique glissant des mesures ──
   Les graphes couvrent une fenêtre de 60 secondes. On stocke des points
   horodatés plutôt qu'un tableau à taille fixe : la cadence de sondage n'est
   pas garantie (onglet masqué, échantillon lent), et l'axe des abscisses doit
   rester le temps réel, pas le numéro d'échantillon. */
const HISTORY_MS = 60000;
Store.history = {};

function pushHistory(key, value) {
  if (!Number.isFinite(value)) return;
  const series = Store.history[key] || (Store.history[key] = []);
  const now = Date.now();
  series.push({ t: now, v: value });
  const cutoff = now - HISTORY_MS - 2000; // petite marge pour lisser le bord
  while (series.length && series[0].t < cutoff) series.shift();
}

function recordMetrics(m) {
  if (!m) return;
  pushHistory('cpu', m.cpu?.usagePercent);
  pushHistory('ram', m.memory?.usedPercent);
  pushHistory('gpu', m.gpu?.loadPercent);
  pushHistory('vram', m.gpu?.vramPercent);
  pushHistory('cpuTemp', m.temperature?.cpuC);
  pushHistory('gpuTemp', m.gpu?.tempC);
  pushHistory('netRx', m.network?.rxSec);
  pushHistory('netTx', m.network?.txSec);
  pushHistory('diskRead', m.diskIo?.readSec);
  pushHistory('diskWrite', m.diskIo?.writeSec);
}

async function fetchSystemMetrics() {
  try {
    Store.metrics = await api('/api/system/metrics');
  } catch (e) {
    Store.metrics = null;
  }
  recordMetrics(Store.metrics);
  Bus.emit('metrics', Store.metrics);
}

/* ════════════════════════════════════════
   Rafraîchissement & statut
   ════════════════════════════════════════ */
async function refresh() {
  const btn = document.getElementById('btn-refresh');
  btn.classList.add('spinning');
  try {
    await fetch('/api/articles/refresh', { method: 'POST' });
    await fetchArticles();
  } finally {
    btn.classList.remove('spinning');
  }
}

function updateStatus() {
  const el = document.getElementById('status-text');
  if (!el) return;
  if (Store.feeds.length === 0) {
    el.textContent = 'Aucune source configurée';
    return;
  }
  const unread = Store.articles.filter((a) => !readArticleIds.has(a.id)).length;
  const now = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (unread > 0) {
    el.innerHTML = `<span class="status-new">● ${unread.toLocaleString('fr-FR')} non lu${unread > 1 ? 's' : ''}</span> · ${now}`;
  } else {
    el.textContent = `Tout est lu · ${now}`;
  }
}

function openArticle(id, link) {
  if (window.addScore) window.addScore(1);
  markAsRead(id);
  window.open(link, '_blank');
}

async function shareArticle(link) {
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(link);
    showToast('Lien copié !');
  }
  if (window.addScore) window.addScore(2);
}

/* ════════════════════════════════════════
   Paramètres
   ════════════════════════════════════════ */
function showSettingsSection(section) {
  document.querySelectorAll('.settings-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.settingsTab === section);
  });
  document.querySelectorAll('.settings-section').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `settings-section-${section}`);
  });
  // Les recommandations dépendent des flux suivis : on les recharge à l'ouverture
  if (section === 'suggestions') loadSuggestedFeedList();
  // L'autorisation se termine dans le navigateur : on relit l'état à l'ouverture.
  if (section === 'spotify') fetchSpotifyStatus();
  if (section === 'ai') { fetchAiStatus(); renderHiddenList(); }
  if (section === 'ai-usage') loadUsageSettings();
}

function togglePanel(name) {
  document.getElementById(name + '-panel').classList.toggle('open');
  if (name === 'settings') {
    loadCatList();
    loadFeedList();
    loadSuggestedFeedList();
    fetchFeedlyStatus();
    fetchAiStatus();
    renderHiddenList();
  }
}

function closePanelIfBg(e, id) {
  if (e.target.id === id) document.getElementById(id).classList.remove('open');
}

/* ── Catégories ── */
async function loadCatList() {
  await fetchCategories();
  document.getElementById('cat-list').innerHTML = Store.categories.map((c) => {
    const count = Store.feeds.filter((f) => f.category === c.name).length;
    return `
    <div class="list-row">
      <span class="badge" style="--pill:${esc(c.color)};font-size:11px;padding:4px 12px;">${esc(c.name)}</span>
      <div class="list-row-info">
        <div class="list-row-sub">${count} flux</div>
      </div>
      <input type="color" value="${esc(c.color)}" class="swatch" title="Changer la couleur"
             onchange="updateCatColor('${escAttr(c.name)}', this.value)">
      ${c.name !== 'Autres' ? `<button class="ghost-btn danger" onclick="confirmClick(this, 'deleteCategory', '${escAttr(c.name)}')" title="Supprimer">${icon('i-trash')}</button>` : ''}
    </div>
  `;
  }).join('');
  // Met à jour le sélecteur de catégorie du formulaire d'ajout de flux
  const sel = document.getElementById('new-cat');
  sel.innerHTML = Store.categories.map((c) => `<option>${esc(c.name)}</option>`).join('');
}

async function addCategory(event) {
  if (event) event.preventDefault();
  const name = document.getElementById('new-cat-name').value.trim();
  const color = document.getElementById('new-cat-color').value;
  if (!name) return;
  await api('/api/categories', { method: 'POST', json: { name, color } });
  document.getElementById('new-cat-name').value = '';
  await loadCatList();
  showToast('Catégorie créée');
}

async function updateCatColor(name, color) {
  await api(`/api/categories/${encodeURIComponent(name)}`, { method: 'PATCH', json: { color } });
  await fetchCategories();
  loadCatList();
}

async function deleteCategory(name) {
  await api(`/api/categories/${encodeURIComponent(name)}`, { method: 'DELETE' });
  await loadCatList();
  showToast('Catégorie supprimée');
}

/* ── Flux ── */
async function loadFeedList() {
  await fetchFeeds();
  const list = document.getElementById('feed-list');
  const count = document.getElementById('feed-count');
  if (count) {
    count.innerHTML = Store.feeds.length === 0
      ? 'Aucun flux configuré'
      : `<strong>${Store.feeds.length}</strong> flux · ${Store.categories.length} catégorie${Store.categories.length > 1 ? 's' : ''}`;
  }
  if (Store.feeds.length === 0) {
    list.innerHTML = '<div class="set-empty">Aucun flux pour le moment. Collez une URL ci-dessus.</div>';
    return;
  }
  // Groupés par catégorie, dans l'ordre des catégories ; les flux d'une
  // catégorie disparue ferment la liste.
  const order = Store.categories.map((c) => c.name);
  const groups = new Map();
  for (const f of Store.feeds) {
    if (!groups.has(f.category)) groups.set(f.category, []);
    groups.get(f.category).push(f);
  }
  const names = [...groups.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib) || a.localeCompare(b);
  });
  const row = (f) => {
    const color = catColor(f.category);
    const sourceBadge = (f.source === 'feedly' || f.source === 'opml')
      ? `<span class="source-tag">${f.source === 'opml' ? 'OPML' : 'Feedly'}</span>` : '';
    const title = f.title || hostOf(f.url) || f.url;
    return `
    <div class="source-row">
      <span class="source-icon">${faviconImg(f.url)}</span>
      <div class="source-info">
        <div class="source-title">${esc(title)} ${sourceBadge}</div>
        <div class="source-url mono">${esc(f.url.replace(/^https?:\/\/(www\.)?/, ''))}</div>
      </div>
      <select class="cat-select" style="--pill:${esc(color)}" aria-label="Catégorie de ${escAttr(title)}"
        onchange="changeFeedCategory('${escAttr(f.url)}', this.value)">
        ${Store.categories.map((c) => `<option value="${escAttr(c.name)}"${c.name === f.category ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>
      <button class="ghost-btn danger" onclick="confirmClick(this, 'removeFeed', '${escAttr(f.url)}')" title="Supprimer ce flux" aria-label="Supprimer ${escAttr(title)}">${icon('i-trash')}</button>
    </div>`;
  };
  list.innerHTML = names.map((name) => `
    <div class="source-group">
      <span class="source-group-dot" style="background:${esc(catColor(name))}"></span>
      <span class="source-group-name">${esc(name)}</span>
      <span class="source-group-count mono">${groups.get(name).length}</span>
    </div>
    ${groups.get(name).map(row).join('')}`).join('');
}

async function loadSuggestedFeedList() {
  // Toujours recharger : les recommandations dépendent des flux suivis
  await fetchSuggestions();
  await fetchFeeds();
  const list = document.getElementById('suggested-feed-list');
  if (!list) return;
  list.innerHTML = Store.suggestions.map((item) => {
    const alreadyAdded = Store.feeds.some((feed) => feed.url === item.url);
    const color = catColor(item.category);
    return `
      <div class="list-row" style="align-items:flex-start">
        ${faviconImg(item.url)}
        <div class="list-row-info">
          <div class="list-row-title">${esc(item.title)} <span class="badge" style="--pill:${esc(color)}">${esc(item.category)}</span></div>
          <div class="list-row-sub wrap">${esc(item.description)}</div>
        </div>
        <button class="btn primary" ${alreadyAdded ? 'disabled' : ''} onclick="addSuggestedFeed('${escAttr(item.url)}')">
          ${alreadyAdded ? 'Ajouté' : 'Ajouter'}
        </button>
      </div>
    `;
  }).join('');
}

async function addFeed(event) {
  await addManualFeed(event, 'new-url');
}

async function addManualFeed(event, inputId) {
  if (event) event.preventDefault();
  const input = document.getElementById(inputId);
  const url = input.value.trim();
  const cat = document.getElementById('new-cat')?.value || 'Autres';
  if (!url) return;
  try {
    await api('/api/feeds', { method: 'POST', json: { url, category: cat } });
    input.value = '';
    await fetchFeeds();
    await fetchCategories();
    loadFeedList();
    showToast('Flux ajouté');
    fetchArticles();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function addSuggestedFeed(url) {
  const item = Store.suggestions.find((suggestion) => suggestion.url === url);
  if (!item) return;
  await api('/api/feeds', {
    method: 'POST',
    json: { url: item.url, category: item.category, title: item.title, source: 'suggested' },
  });
  await fetchFeeds();
  await fetchCategories();
  await fetchSuggestions();
  showToast(`${item.title} ajouté`);
  await fetchArticles();
  loadSuggestedFeedList();
}

async function removeFeed(url) {
  await api('/api/feeds', { method: 'DELETE', json: { url } });
  await fetchFeeds();
  loadFeedList();
  showToast('Flux supprimé');
  fetchArticles();
}

async function changeFeedCategory(url, category) {
  await api('/api/feeds', { method: 'PATCH', json: { url, category } });
  await fetchFeeds();
  loadFeedList();
}

/* ── Feedly / OPML ── */
function renderFeedlyStatus() {
  const title = document.getElementById('feedly-title');
  const meta = document.getElementById('feedly-meta');
  const badge = document.getElementById('feedly-badge');
  const syncBtn = document.getElementById('feedly-sync-btn');
  const disconnectBtn = document.getElementById('feedly-disconnect-btn');
  if (!title || !meta || !badge) return;

  if (Store.feedlyStatus.connected) {
    const profile = Store.feedlyStatus.profile || {};
    const name = profile.email || profile.fullName || 'Compte Feedly connecté';
    const synced = Store.feedlyStatus.lastSyncAt ? `Dernière sync ${timeAgo(Store.feedlyStatus.lastSyncAt)}` : 'Pas encore synchronisé';
    title.textContent = name;
    meta.textContent = `${Store.feedlyStatus.feedCount || 0} flux importés · ${synced}`;
    badge.textContent = 'Connecté';
    badge.className = 'set-pill on';
    if (syncBtn) syncBtn.disabled = false;
    if (disconnectBtn) disconnectBtn.disabled = false;
  } else {
    title.textContent = 'Import OPML';
    meta.textContent = 'Compatible avec les comptes Feedly gratuits.';
    badge.textContent = 'OPML';
    badge.className = 'set-pill';
    if (syncBtn) syncBtn.disabled = true;
    if (disconnectBtn) disconnectBtn.disabled = true;
  }
}

function updateFileLabel(input) {
  const label = input.closest('.file-drop');
  if (!label) return;
  const span = label.querySelector('.file-label');
  const file = input.files && input.files[0];
  span.textContent = file ? file.name : 'Choisir un fichier OPML…';
  label.classList.toggle('has-file', !!file);
}

async function importFeedlyOpml() {
  importOpmlFromInput('feedly-opml');
}

async function importOpmlFromInput(inputId) {
  const input = document.getElementById(inputId);
  const file = input.files && input.files[0];
  if (!file) return showToast('Choisissez un fichier OPML', 'error');
  setFeedlyBusy(true);
  try {
    const opml = await file.text();
    const data = await api('/api/feeds/opml', {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml' },
      body: opml,
    });
    input.value = '';
    updateFileLabel(input);
    await fetchFeeds();
    await loadFeedList();
    await fetchCategories();
    showToast(`${data.added} flux importés`);
    await refresh();
  } catch (e) {
    showToast(e.message || 'Erreur OPML', 'error');
  } finally {
    setFeedlyBusy(false);
  }
}

async function connectFeedly(event) {
  if (event) event.preventDefault();
  const input = document.getElementById('feedly-token');
  const token = input.value.trim();
  if (!token) return showToast('Jeton Feedly requis', 'error');
  setFeedlyBusy(true);
  try {
    Store.feedlyStatus = await api('/api/feedly/connect', { method: 'POST', json: { token } });
    input.value = '';
    renderFeedlyStatus();
    await loadFeedList();
    await fetchCategories();
    showToast('Feedly connecté');
    await refresh();
  } catch (e) {
    showToast(e.message || 'Erreur Feedly', 'error');
  } finally {
    setFeedlyBusy(false);
  }
}

async function syncFeedly() {
  setFeedlyBusy(true);
  try {
    Store.feedlyStatus = await api('/api/feedly/sync', { method: 'POST' });
    renderFeedlyStatus();
    await loadFeedList();
    await fetchCategories();
    showToast('Feedly synchronisé');
    await refresh();
  } catch (e) {
    showToast(e.message || 'Erreur Feedly', 'error');
  } finally {
    setFeedlyBusy(false);
  }
}

async function disconnectFeedly() {
  setFeedlyBusy(true);
  try {
    await api('/api/feedly', { method: 'DELETE' });
    Store.feedlyStatus = { connected: false };
    renderFeedlyStatus();
    await loadFeedList();
    showToast('Feedly déconnecté');
    await refresh();
  } finally {
    setFeedlyBusy(false);
  }
}

function setFeedlyBusy(isBusy) {
  ['feedly-import-btn', 'feedly-sync-btn', 'feedly-disconnect-btn'].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = isBusy;
  });
  if (!isBusy) renderFeedlyStatus();
}

/* ════════════════════════════════════════
   Spotify — connexion & sondage
   ──────────────────────────────────────────
   Le rendu du lecteur vit dans le widget Spotify ; ici on ne garde que
   l'appairage du compte et la boucle de sondage partagée.
   ════════════════════════════════════════ */
let spotifyProgressMs = 0;    // progression interpolée entre deux sondages
let spotifyLastTick = 0;
let spotifyPollTimer = null;
let volumeTimeout = null;

async function fetchSpotifyStatus() {
  try {
    Store.spotifyStatus = await api('/api/spotify/status');
  } catch (e) {
    Store.spotifyStatus = { configured: false, connected: false, redirectUri: '' };
  }
  renderSpotifyStatus();
  Bus.emit('spotify:status', Store.spotifyStatus);
  syncSpotifyPolling();
}

function renderSpotifyStatus() {
  const badge = document.getElementById('spotify-badge');
  const title = document.getElementById('spotify-title');
  const meta = document.getElementById('spotify-meta');
  const redirect = document.getElementById('spotify-redirect');
  const clientInput = document.getElementById('spotify-client-id');
  const disconnectBtn = document.getElementById('spotify-disconnect-btn');
  if (!badge) return;

  const status = Store.spotifyStatus;
  if (status.redirectUri) redirect.textContent = status.redirectUri;
  disconnectBtn.style.display = status.connected ? '' : 'none';

  // Le Client ID est retenu : une fois l'app créée, la procédure du dashboard
  // n'a plus à être affichée — un seul bouton suffit à se reconnecter.
  const setup = document.getElementById('spotify-setup');
  const knownApp = status.configured && !status.connected;
  document.getElementById('spotify-reconnect').hidden = !knownApp;
  // App livrée pré-configurée : on ne parle jamais du dashboard.
  document.getElementById('spotify-setup-toggle').hidden = !knownApp || status.bundled;
  setup.hidden = status.configured;
  if (status.configured) clientInput.value = '';

  if (status.connected) {
    const profile = status.profile || {};
    // `product` n'est renvoyé par /me qu'avec le scope `user-read-private`, que
    // FeedMe ne demande pas. Sans cette information, annoncer « Gratuit » était
    // une affirmation gratuite : on reste neutre.
    const tier = profile.product || '';
    badge.textContent = tier === 'premium' ? 'Premium' : 'Connecté';
    badge.className = 'set-pill on';
    title.textContent = profile.name ? `Connecté · ${profile.name}` : 'Connecté à Spotify';
    meta.textContent = tier === 'premium'
      ? 'Contrôles de lecture actifs.'
      : 'Lecture et affichage actifs. Les commandes de lecture requièrent un compte Premium — Spotify les refusera sinon.';
  } else {
    badge.textContent = 'Hors ligne';
    badge.className = 'set-pill';
    title.textContent = 'Spotify non connecté';
    meta.textContent = 'Pilotez la lecture depuis FeedMe.';
  }
}

// Le sondage ne tourne que si le compte est connecté, la fenêtre visible et
// un widget Spotify réellement présent sur le dashboard.
function syncSpotifyPolling() {
  const wanted = Store.spotifyStatus.connected && !document.hidden && !document.body.classList.contains('agents-visible') && Bus.count('spotify') > 0;
  if (wanted && !spotifyPollTimer) {
    pollSpotify();
    spotifyPollTimer = setInterval(pollSpotify, 3000);
  } else if (!wanted && spotifyPollTimer) {
    clearInterval(spotifyPollTimer);
    spotifyPollTimer = null;
  }
  if (!Store.spotifyStatus.connected) {
    Store.spotifyState = null;
    Bus.emit('spotify', null);
  }
}

let lastTrackId = null;

async function pollSpotify() {
  try {
    const data = await api('/api/spotify/now-playing');
    if (!data.connected) {
      Store.spotifyStatus.connected = false;
      syncSpotifyPolling();
      return;
    }
    Store.spotifyState = data;
    spotifyProgressMs = data.progressMs || 0;
    spotifyLastTick = Date.now();
  } catch (e) {
    Store.spotifyState = null;
  }
  Bus.emit('spotify', Store.spotifyState);

  // Changement de morceau : les widgets qui suivent les paroles ou l'état
  // « aimé » n'ont pas à comparer eux-mêmes à chaque sondage.
  const trackId = Store.spotifyState?.track?.id || null;
  if (trackId !== lastTrackId) {
    lastTrackId = trackId;
    if (trackId) fetchSpotifySaved([trackId]);
    Bus.emit('spotify:track', Store.spotifyState?.track || null);
  }
}

// Fait avancer la barre entre deux sondages pour éviter l'effet saccadé.
setInterval(() => {
  if (document.hidden || document.body.classList.contains('agents-visible')) return;
  const state = Store.spotifyState;
  if (!state?.playing || !state.track) return;
  const now = Date.now();
  spotifyProgressMs = Math.min(state.track.durationMs, spotifyProgressMs + (now - spotifyLastTick));
  spotifyLastTick = now;
  Bus.emit('spotify:progress', spotifyProgressMs);
}, 500);

async function spotifyCommand(name) {
  try {
    await api(`/api/spotify/command/${name}`, { method: 'POST' });
    // Spotify applique la commande de façon asynchrone : on relit juste après.
    setTimeout(pollSpotify, 350);
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function spotifyTogglePlay() {
  spotifyCommand(Store.spotifyState?.playing ? 'pause' : 'play');
}

async function spotifySeek(positionMs) {
  spotifyProgressMs = positionMs; // retour visuel immédiat
  spotifyLastTick = Date.now();
  Bus.emit('spotify:progress', spotifyProgressMs);
  try {
    await api('/api/spotify/seek', { method: 'POST', json: { positionMs } });
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function setSpotifyVolume(value) {
  clearTimeout(volumeTimeout);
  volumeTimeout = setTimeout(async () => {
    try {
      await api('/api/spotify/volume', { method: 'POST', json: { volume: Number(value) } });
    } catch (e) {
      showToast(e.message, 'error');
    }
  }, 250);
}

// Ouvre l'app Spotify du PC, sur le morceau en cours quand il y en a un.
// Le repli vers le lecteur web (Spotify non installé) est géré côté main.
function openSpotifyApp() {
  const track = Store.spotifyState?.track;
  const uri = track?.id ? `spotify:track:${track.id}` : 'spotify:';
  const webUrl = track?.url || 'https://open.spotify.com';
  if (isElectron) window.widget.openSpotify(uri, webUrl);
  else window.open(webUrl, '_blank');
}

function openSpotifyDashboard(event) {
  event.preventDefault();
  const url = 'https://developer.spotify.com/dashboard';
  if (isElectron) window.widget.openExternal(url);
  else window.open(url, '_blank');
}

async function copyRedirectUri() {
  try {
    await navigator.clipboard.writeText(document.getElementById('spotify-redirect').textContent);
    showToast('Redirect URI copiée');
  } catch (e) {
    showToast('Copie impossible', 'error');
  }
}

function toggleSpotifySetup(event) {
  event.preventDefault();
  const setup = document.getElementById('spotify-setup');
  setup.hidden = !setup.hidden;
}

async function connectSpotify(event) {
  event.preventDefault();
  const input = document.getElementById('spotify-client-id');
  const btn = document.getElementById('spotify-connect-btn');
  const clientId = input.value.trim();
  // Champ vide + app déjà connue = reconnexion : le serveur reprend l'ID mémorisé.
  if (!clientId && !Store.spotifyStatus.configured) {
    return showToast('Collez le Client ID de votre app Spotify', 'error');
  }

  btn.disabled = true;
  try {
    const { url } = await api('/api/spotify/authorize', { method: 'POST', json: clientId ? { clientId } : {} });
    if (isElectron) window.widget.openExternal(url);
    else window.open(url, '_blank');
    showToast('Autorisez FeedMe dans votre navigateur');
    input.value = '';
    // La connexion se termine dans le navigateur : on repasse voir le résultat.
    setTimeout(fetchSpotifyStatus, 6000);
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

/* ── Spotify Connect, favoris, historique, paroles ── */
Store.spotifyDevices = [];
Store.spotifySaved = {};
Store.spotifyHistory = [];
Store.lyrics = { trackId: null, lines: [], plain: '', loading: false, error: null };

function spotifyCan(scope) {
  return (Store.spotifyStatus.scopes || []).includes(scope);
}

async function fetchSpotifyDevices() {
  try {
    const data = await api('/api/spotify/devices');
    Store.spotifyDevices = data.devices || [];
  } catch (e) {
    Store.spotifyDevices = [];
    showToast(e.message, 'error');
  }
  Bus.emit('spotify:devices', Store.spotifyDevices);
}

async function transferSpotify(deviceId) {
  try {
    await api('/api/spotify/transfer', { method: 'POST', json: { deviceId } });
    showToast('Lecture transférée');
    // Spotify applique le transfert de façon asynchrone.
    setTimeout(() => { pollSpotify(); fetchSpotifyDevices(); }, 700);
  } catch (e) {
    showToast(e.message, 'error');
  }
}

let savedRetryTimer = null;

async function fetchSpotifySaved(ids) {
  const wanted = ids.filter((id) => id && Store.spotifySaved[id] === undefined);
  if (wanted.length === 0 || !spotifyCan('user-library-read')) return;
  try {
    const data = await api(`/api/spotify/saved?ids=${encodeURIComponent(wanted.join(','))}`);
    Object.assign(Store.spotifySaved, data.saved || {});
    Bus.emit('spotify:saved', Store.spotifySaved);

    // Le serveur construit son index de bibliothèque en tâche de fond : on
    // redemande une fois qu'il a eu le temps d'aboutir. L'étoile reste neutre
    // en attendant plutôt que d'afficher un « non aimé » qui serait faux.
    if (data.pending && !savedRetryTimer) {
      savedRetryTimer = setTimeout(() => {
        savedRetryTimer = null;
        const track = Store.spotifyState?.track?.id;
        if (track) fetchSpotifySaved([track]);
      }, 5000);
    }
  } catch (e) { /* silencieux : l'étoile reste neutre */ }
}

async function toggleSpotifySaved(id) {
  const next = !Store.spotifySaved[id];
  // Retour visuel immédiat, corrigé si Spotify refuse.
  Store.spotifySaved[id] = next;
  Bus.emit('spotify:saved', Store.spotifySaved);
  try {
    await api('/api/spotify/saved', { method: 'POST', json: { id, saved: next } });
    showToast(next ? 'Ajouté à vos titres likés' : 'Retiré de vos titres likés');
  } catch (e) {
    Store.spotifySaved[id] = !next;
    Bus.emit('spotify:saved', Store.spotifySaved);
    showToast(e.message, 'error');
  }
}

async function fetchSpotifyHistory() {
  if (!spotifyCan('user-read-recently-played')) return;
  try {
    const data = await api('/api/spotify/history');
    Store.spotifyHistory = data.tracks || [];
  } catch (e) {
    Store.spotifyHistory = [];
  }
  Bus.emit('spotify:history', Store.spotifyHistory);
}

async function fetchLyrics(track) {
  if (!track?.id) return;
  if (Store.lyrics.trackId === track.id && !Store.lyrics.error) return;

  Store.lyrics = { trackId: track.id, lines: [], plain: '', loading: true, error: null };
  Bus.emit('spotify:lyrics', Store.lyrics);

  const params = new URLSearchParams({
    trackId: track.id,
    title: track.title || '',
    artist: track.artist || '',
    album: track.album || '',
    durationMs: String(track.durationMs || 0),
  });
  try {
    const data = await api(`/api/spotify/lyrics?${params}`);
    Store.lyrics = {
      trackId: track.id,
      lines: data.lines || [],
      plain: data.plain || '',
      loading: false,
      error: (data.lines || []).length === 0 && !data.plain ? 'Aucune parole trouvée' : null,
    };
  } catch (e) {
    Store.lyrics = { trackId: track.id, lines: [], plain: '', loading: false, error: e.message };
  }
  Bus.emit('spotify:lyrics', Store.lyrics);
}

function openSpotifyTrack(url) {
  if (isElectron) window.widget.openSpotify('spotify:', url);
  else window.open(url, '_blank');
}

async function disconnectSpotify() {
  try {
    await api('/api/spotify', { method: 'DELETE' });
    showToast('Spotify déconnecté');
    await fetchSpotifyStatus();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

document.addEventListener('visibilitychange', syncSpotifyPolling);

/* ════════════════════════════════════════
   Favoris & sources masquées
   ──────────────────────────────────────────
   Deux listes purement locales, comme les articles lus : elles décrivent une
   préférence de lecture, pas une donnée à synchroniser. Les boards restent le
   mécanisme de sauvegarde durable côté serveur.
   ════════════════════════════════════════ */
let favoriteIds = new Set(JSON.parse(localStorage.getItem('fm-favorites') || '[]'));
let hiddenSources = new Set(JSON.parse(localStorage.getItem('fm-hidden-sources') || '[]'));

function isFavorite(id) { return favoriteIds.has(id); }

function toggleFavorite(id) {
  if (favoriteIds.has(id)) favoriteIds.delete(id);
  else favoriteIds.add(id);
  localStorage.setItem('fm-favorites', JSON.stringify([...favoriteIds]));
  Bus.emit('favorites', favoriteIds);
  return favoriteIds.has(id);
}

function isSourceHidden(source) { return hiddenSources.has(source); }

function hideSource(source) {
  hiddenSources.add(source);
  localStorage.setItem('fm-hidden-sources', JSON.stringify([...hiddenSources]));
  Bus.emit('hidden', hiddenSources);
  showToast(`${source} masqué`);
  renderHiddenList();
}

function unhideSource(source) {
  hiddenSources.delete(source);
  localStorage.setItem('fm-hidden-sources', JSON.stringify([...hiddenSources]));
  Bus.emit('hidden', hiddenSources);
  renderHiddenList();
}

function renderHiddenList() {
  const list = document.getElementById('hidden-list');
  if (!list) return;
  const sources = [...hiddenSources];
  if (sources.length === 0) {
    list.innerHTML = `<div class="set-empty">Aucune source masquée. Utilisez l'icône œil sur une carte article.</div>`;
    return;
  }
  list.innerHTML = sources.map((source) => `
    <div class="list-row">
      <div class="list-row-info"><div class="list-row-title">${esc(source)}</div></div>
      <button class="btn" onclick="unhideSource('${escAttr(source)}')">${icon('i-eye-off', 'ic-sm')} Réafficher</button>
    </div>
  `).join('');
}

/* ════════════════════════════════════════
   IA — résumés & regroupement
   ════════════════════════════════════════ */
Store.aiStatus = { provider: 'none', configured: false, enabled: true, model: '', models: [], compatPresets: [], cachedSummaries: 0 };
Store.aiCompatModels = [];  // renseignée par un test de fournisseur
Store.aiCompatProbe = null; // { message, tone } du dernier test de fournisseur
Store.summaries = {};
Store.clusters = [];
Store.clusterMode = null;

async function fetchAiStatus() {
  try {
    Store.aiStatus = await api('/api/ai/status');
  } catch (e) {
    Store.aiStatus = { configured: false, enabled: false, model: '', models: [], cachedSummaries: 0 };
  }
  renderAiSettings();
  Bus.emit('ai:status', Store.aiStatus);
}

// Les résumés arrivent par lots : on ne demande que les articles visibles et
// jamais deux fois le même (le serveur cache aussi, mais autant s'épargner
// l'aller-retour).
const summaryRequested = new Set();
let summaryTimer = null;
let summaryQueue = new Set();

function requestSummaries(ids) {
  let added = false;
  for (const id of ids) {
    if (summaryRequested.has(id) || Store.summaries[id]) continue;
    summaryRequested.add(id);
    summaryQueue.add(id);
    added = true;
  }
  if (!added) return;

  clearTimeout(summaryTimer);
  summaryTimer = setTimeout(async () => {
    const batch = [...summaryQueue];
    summaryQueue = new Set();
    if (batch.length === 0) return;
    Bus.emit('summaries:loading', batch);
    try {
      const data = await api('/api/ai/summaries', { method: 'POST', json: { ids: batch } });
      Object.assign(Store.summaries, data.summaries || {});
      Store.summaryMode = data.mode;
      if (data.error) showToast(`IA : ${data.error}`, 'error');
      Bus.emit('summaries', Store.summaries);
      if (data.error) fetchAiStatus();
    } catch (e) {
      // Réessayer plus tard reste possible : on relâche les identifiants.
      for (const id of batch) summaryRequested.delete(id);
      showToast(e.message, 'error');
      Bus.emit('summaries', Store.summaries);
    }
  }, 250);
}

async function fetchClusters() {
  try {
    const data = await api('/api/ai/clusters');
    Store.clusters = data.topics || [];
    Store.clusterMode = data.mode;
    if (data.error) showToast(`IA : ${data.error}`, 'error');
  } catch (e) {
    Store.clusters = [];
    Store.clusterMode = null;
    showToast(e.message, 'error');
  }
  Bus.emit('clusters', Store.clusters);
}

function currentPreset() {
  return (Store.aiStatus.compatPresets || []).find((p) => p.id === Store.aiStatus.compatPreset) || null;
}

function renderAiSettings() {
  const status = Store.aiStatus;
  const badge = document.getElementById('ai-badge');
  if (!badge) return;

  const provider = status.provider || 'none';
  // `ready` vient du serveur : lui seul sait si la configuration suffit
  // (un serveur local n'exige pas de clé, un fournisseur distant si).
  const ready = Boolean(status.ready);

  // En-tête
  if (ready) {
    badge.textContent = status.enabled ? 'Actif' : 'En pause';
    badge.className = status.enabled ? 'set-pill on' : 'set-pill warn';
    document.getElementById('ai-title').textContent = provider === 'claude'
      ? 'Claude'
      : currentPreset()?.label.split(' —')[0] || 'Fournisseur';
  } else {
    badge.textContent = provider === 'none' ? 'Extractif' : 'Incomplet';
    badge.className = provider === 'none' ? 'set-pill' : 'set-pill warn';
    document.getElementById('ai-title').textContent = provider === 'none'
      ? 'Mode extractif'
      : 'Configuration incomplète';
  }
  document.getElementById('ai-meta').textContent = ready
    ? `${status.compatModel || status.model} · ${status.cachedSummaries || 0} résumé${(status.cachedSummaries || 0) > 1 ? 's' : ''} en cache`
    : 'Deux premières phrases de l\'article, sans appel réseau.';

  // Sections propres à chaque moteur
  document.getElementById('ai-provider').value = provider;
  document.getElementById('ai-claude').hidden = provider !== 'claude';
  document.getElementById('ai-compat').hidden = provider !== 'compat';

  const modelSelect = document.getElementById('ai-model');
  if (modelSelect) {
    modelSelect.innerHTML = (status.models || []).map((m) =>
      `<option value="${escAttr(m.id)}"${m.id === status.model ? ' selected' : ''}>${esc(m.label)}</option>`
    ).join('');
  }

  // Fournisseur gratuit
  const presetSelect = document.getElementById('ai-compat-preset');
  if (presetSelect) {
    const known = (status.compatPresets || []).some((p) => p.id === status.compatPreset);
    // Un fournisseur retiré de la liste (ou réglé à la main) ne doit pas laisser
    // le menu afficher le premier de la liste alors que la config pointe ailleurs.
    const orphan = !known && status.compatBaseUrl
      ? `<option value="" selected>Configuration personnalisée</option>`
      : '';
    presetSelect.innerHTML = orphan + (status.compatPresets || []).map((p) =>
      `<option value="${escAttr(p.id)}"${p.id === status.compatPreset ? ' selected' : ''}>${esc(p.label)}</option>`
    ).join('');
  }
  const preset = currentPreset();
  const note = document.getElementById('ai-compat-note');
  if (note) {
    // La contrainte réelle du palier est affichée AVANT que l'utilisateur aille
    // créer un compte, pas découverte après.
    note.innerHTML = preset
      ? `${esc(preset.note)}
         <a href="#" onclick="openExternalLink(event, '${escAttr(preset.signup)}')">Obtenir une clé →</a>
         ${preset.limit ? `<span class="set-caveat">${icon('i-zap', 'ic-xs')} ${esc(preset.limit)}</span>` : ''}`
      : 'Choisissez un fournisseur pour commencer.';
  }
  const checked = document.getElementById('ai-compat-checked');
  if (checked) {
    checked.textContent = status.compatCheckedOn
      ? `Conditions vérifiées le ${status.compatCheckedOn} — elles changent souvent, la page du fournisseur fait foi.`
      : '';
  }

  // La liste de modèles n'est connue qu'après un test : sinon on montre au
  // moins celui qui est enregistré, plus la suggestion du préréglage.
  const compatModelSelect = document.getElementById('ai-compat-model');
  if (compatModelSelect) {
    const options = Store.aiCompatModels.length
      ? Store.aiCompatModels.map((m) => m.id)
      : [status.compatModel, preset?.model].filter(Boolean);
    const unique = [...new Set(options)];
    compatModelSelect.innerHTML = unique.length
      ? unique.map((id) => `<option value="${escAttr(id)}"${id === status.compatModel ? ' selected' : ''}>${esc(id)}</option>`).join('')
      : '<option value="">— testez la clé pour lister les modèles —</option>';
  }

  const keyHint = document.getElementById('ai-compat-keyhint');
  if (keyHint) {
    keyHint.textContent = status.compatNeedsKey === false
      ? 'Serveur local : aucune clé nécessaire.'
      : status.compatConfigured ? 'Clé enregistrée. Collez-en une autre pour la remplacer.'
        : 'Vérifiée avant enregistrement.';
  }

  const toggle = document.getElementById('ai-enabled');
  if (toggle) toggle.checked = status.enabled !== false;
  const disconnect = document.getElementById('ai-disconnect-btn');
  if (disconnect) disconnect.style.display = (status.configured || status.compatConfigured) ? '' : 'none';

  // Un seul bandeau d'état en pied de carte : le test en cours, son résultat,
  // ou la dernière erreur du moteur. Trois messages concurrents nuisaient plus
  // qu'ils n'informaient.
  const statusBox = document.getElementById('ai-status');
  if (!statusBox) return;
  let tone = '';
  let icon_ = 'i-check';
  let text = '';

  if (Store.aiCompatProbe) {
    text = Store.aiCompatProbe.message;
    tone = Store.aiCompatProbe.tone;
    icon_ = tone === 'bad' ? 'i-x' : tone === 'busy' ? 'i-sync' : 'i-check';
  } else if (status.lastError) {
    tone = 'bad';
    icon_ = 'i-x';
    text = `${status.lastError.message} (${timeAgo(status.lastError.at)})`;
  } else if (ready) {
    tone = 'ok';
    text = provider === 'compat'
      ? 'Prêt. Activez les résumés depuis l\'étincelle du widget Flux RSS.'
      : 'Prêt. Résumés et regroupement sémantique actifs.';
  } else if (provider === 'compat' && status.compatNeedsKey && !status.compatConfigured) {
    text = 'Collez votre clé et testez-la : les résumés ne démarreront pas sans elle.';
  } else if (provider === 'claude' && !status.configured) {
    text = 'Ajoutez votre clé Anthropic pour activer le moteur.';
  }

  statusBox.hidden = !text;
  statusBox.className = `set-status${tone ? ' ' + tone : ''}`;
  statusBox.innerHTML = text ? `${icon(icon_, 'ic-sm')}<span>${esc(text)}</span>` : '';
}

async function openExternalLink(event, url) {
  if (event) event.preventDefault();
  if (!isElectron) { window.open(url, '_blank'); return; }

  // Le processus principal filtre les domaines autorisés et renvoie `false`
  // s'il refuse. Sans ce retour, un clic sur un hôte non listé ne produisait
  // rien du tout — on préfère le dire et donner l'adresse à copier.
  const opened = await window.widget.openExternal(url);
  if (opened === false) {
    try {
      await navigator.clipboard.writeText(url);
      showToast('Lien copié — ouverture bloquée pour ce domaine');
    } catch (e) {
      showToast(`Ouverture refusée : ${url}`, 'error');
    }
  }
}

async function patchAiConfig(patch, toast) {
  try {
    Store.aiStatus = await api('/api/ai/config', { method: 'POST', json: patch });
    renderAiSettings();
    Bus.emit('ai:status', Store.aiStatus);
    if (toast) showToast(toast);
    return true;
  } catch (e) {
    showToast(e.message, 'error');
    return false;
  }
}

async function setAiProvider(provider) {
  Store.aiCompatProbe = null;
  await patchAiConfig({ provider });
  // Les résumés en cache viennent d'un autre moteur.
  resetSummaries();
}

async function setAiCompatPreset(id) {
  const preset = (Store.aiStatus.compatPresets || []).find((p) => p.id === id);
  if (!preset) return;
  Store.aiCompatModels = [];
  Store.aiCompatProbe = null;
  await patchAiConfig({
    compatPreset: id,
    compatBaseUrl: preset.baseUrl,
    compatModel: preset.model,
  });
}

async function setAiCompatModel(model) {
  await patchAiConfig({ compatModel: model }, 'Modèle mis à jour');
  resetSummaries();
}

// Teste le fournisseur AVANT d'enregistrer : une clé fautive doit se voir tout
// de suite, pas au premier article résumé.
async function saveAiCompat(event) {
  if (event) event.preventDefault();
  const input = document.getElementById('ai-compat-key');
  const key = input.value.trim();
  const baseUrl = Store.aiStatus.compatBaseUrl || currentPreset()?.baseUrl;
  if (!baseUrl) return showToast('Choisissez d\'abord un fournisseur', 'error');

  const button = document.getElementById('ai-compat-test');
  if (button) button.disabled = true;
  Store.aiCompatProbe = { message: 'Test du fournisseur en cours…', tone: 'busy' };
  renderAiSettings();

  try {
    const probe = await api('/api/ai/compat/probe', { method: 'POST', json: { baseUrl, key } });
    if (!probe.reachable) {
      Store.aiCompatProbe = { message: probe.error || 'Fournisseur injoignable', tone: 'bad' };
      renderAiSettings();
      return showToast(probe.error || 'Fournisseur injoignable', 'error');
    }
    Store.aiCompatModels = probe.models || [];
    const n = Store.aiCompatModels.length;
    Store.aiCompatProbe = { message: `Connecté — ${n} modèle${n > 1 ? 's' : ''} disponible${n > 1 ? 's' : ''}.`, tone: 'ok' };
    input.value = '';

    // Si le modèle du préréglage n'existe pas chez ce fournisseur, on prend le
    // premier proposé plutôt que de laisser un modèle qui échouera.
    const wanted = Store.aiStatus.compatModel;
    const exists = Store.aiCompatModels.some((m) => m.id === wanted);
    await patchAiConfig({
      compatKey: key,
      ...(exists || !Store.aiCompatModels.length ? {} : { compatModel: Store.aiCompatModels[0].id }),
    }, 'Fournisseur connecté');
    resetSummaries();
  } catch (e) {
    Store.aiCompatProbe = { message: e.message, tone: 'bad' };
    renderAiSettings();
    showToast(e.message, 'error');
  } finally {
    const button = document.getElementById('ai-compat-test');
    if (button) button.disabled = false;
  }
}

function resetSummaries() {
  Store.summaries = {};
  Store.clusters = [];
  summaryRequested.clear();
  Bus.emit('summaries', Store.summaries);
}

async function saveAiKey(event) {
  if (event) event.preventDefault();
  const input = document.getElementById('ai-key');
  const key = input.value.trim();
  if (!key) return showToast('Collez votre clé API', 'error');
  try {
    Store.aiStatus = await api('/api/ai/config', { method: 'POST', json: { apiKey: key } });
    input.value = '';
    renderAiSettings();
    Bus.emit('ai:status', Store.aiStatus);
    showToast('Clé enregistrée');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function setAiModel(model) {
  try {
    Store.aiStatus = await api('/api/ai/config', { method: 'POST', json: { model } });
    renderAiSettings();
    Bus.emit('ai:status', Store.aiStatus);
    // Les résumés en cache viennent d'un autre modèle : on repart à zéro.
    Store.summaries = {};
    summaryRequested.clear();
    Bus.emit('summaries', Store.summaries);
    showToast('Modèle mis à jour');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function setAiEnabled(enabled) {
  try {
    Store.aiStatus = await api('/api/ai/config', { method: 'POST', json: { enabled } });
    renderAiSettings();
    Bus.emit('ai:status', Store.aiStatus);
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function disconnectAi() {
  try {
    Store.aiStatus = await api('/api/ai', { method: 'DELETE' });
    Store.summaries = {};
    Store.clusters = [];
    summaryRequested.clear();
    renderAiSettings();
    Bus.emit('ai:status', Store.aiStatus);
    Bus.emit('summaries', Store.summaries);
    showToast('IA déconnectée');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function clearAiCache() {
  try {
    Store.aiStatus = await api('/api/ai/cache/clear', { method: 'POST' });
    Store.summaries = {};
    Store.clusters = [];
    summaryRequested.clear();
    renderAiSettings();
    Bus.emit('summaries', Store.summaries);
    showToast('Cache IA vidé');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function openAnthropicConsole(event) {
  event.preventDefault();
  const url = 'https://console.anthropic.com/settings/keys';
  if (isElectron) window.widget.openExternal(url);
  else window.open(url, '_blank');
}

/* ════════════════════════════════════════
   Boards — CRUD & modale de sauvegarde
   ════════════════════════════════════════ */
async function createBoardNamed(name) {
  if (!name) return;
  await api('/api/boards', { method: 'POST', json: { name } });
  await fetchBoards();
  showToast('Board créé');
}

async function deleteBoard(id) {
  await api(`/api/boards/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await fetchBoards();
  showToast('Board supprimé');
}

async function removeBoardItem(boardId, articleId) {
  await api(`/api/boards/${encodeURIComponent(boardId)}/items/${encodeURIComponent(articleId)}`, { method: 'DELETE' });
  await fetchBoards();
  renderBoardSheet(boardId);
}

function openSaveModal(id, title, link, source) {
  document.getElementById('save-article-id').value = id;
  document.getElementById('save-article-title').value = title;
  document.getElementById('save-article-link').value = link;
  document.getElementById('save-article-source').value = source;
  document.getElementById('save-highlight').value = '';
  document.getElementById('save-note').value = '';
  document.getElementById('save-modal-title').textContent = title;

  const sel = document.getElementById('save-board');
  sel.innerHTML = Store.boards.map((b) =>
    `<option value="${esc(b.id)}">${esc(b.icon)} ${esc(b.name)}</option>`
  ).join('');

  document.getElementById('save-modal').classList.add('open');
}

function editBoardItem(boardId, articleId) {
  const board = Store.boards.find((b) => b.id === boardId);
  const item = board?.items.find((i) => i.articleId === articleId);
  if (!item) return;

  document.getElementById('save-article-id').value = articleId;
  document.getElementById('save-article-title').value = item.title;
  document.getElementById('save-article-link').value = item.link;
  document.getElementById('save-article-source').value = item.source;
  document.getElementById('save-highlight').value = item.highlight || '';
  document.getElementById('save-note').value = item.note || '';
  document.getElementById('save-modal-title').textContent = item.title;

  const sel = document.getElementById('save-board');
  sel.innerHTML = `<option value="${esc(board.id)}" selected>${esc(board.icon)} ${esc(board.name)}</option>`;

  document.getElementById('save-modal').classList.add('open');
}

function closeSaveModal() {
  document.getElementById('save-modal').classList.remove('open');
}

function closeModalIfBg(e) {
  if (e.target.id === 'save-modal') closeSaveModal();
}

async function saveToBoard() {
  const boardId = document.getElementById('save-board').value;
  if (!boardId) { showToast('Créez d\'abord un board', 'error'); return; }
  const payload = {
    articleId: document.getElementById('save-article-id').value,
    title: document.getElementById('save-article-title').value,
    link: document.getElementById('save-article-link').value,
    source: document.getElementById('save-article-source').value,
    highlight: document.getElementById('save-highlight').value.trim(),
    note: document.getElementById('save-note').value.trim(),
  };
  try {
    await api(`/api/boards/${encodeURIComponent(boardId)}/items`, { method: 'POST', json: payload });
    closeSaveModal();
    await fetchBoards();
    if (document.getElementById('board-panel').classList.contains('open')) renderBoardSheet(boardId);
    showToast('Article sauvegardé');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

/* Détail d'un board : feuille glissante, plus une vue à part entière. */
function openBoard(id) {
  renderBoardSheet(id);
  document.getElementById('board-panel').classList.add('open');
}

function closeBoardSheet() {
  document.getElementById('board-panel').classList.remove('open');
}

function renderBoardSheet(boardId) {
  const board = Store.boards.find((b) => b.id === boardId);
  const body = document.getElementById('board-sheet-body');
  const head = document.getElementById('board-sheet-title');
  if (!board || !body) return;

  head.textContent = `${board.icon} ${board.name}`;
  if (board.items.length === 0) {
    body.innerHTML = `<div class="empty">${icon('i-bookmark')}<div>Aucun article sauvegardé</div><p>Utilisez l'étoile sur une carte article pour l'ajouter ici.</p></div>`;
    return;
  }
  body.innerHTML = board.items.map((item) => `
    <div class="board-item">
      <div class="board-item-title"><a href="${esc(item.link)}" target="_blank" rel="noopener">${esc(item.title)}</a></div>
      <div class="board-item-source">${esc(item.source)} · ${timeAgo(item.savedAt)}</div>
      ${item.highlight ? `<div class="board-item-highlight">« ${esc(item.highlight)} »</div>` : ''}
      ${item.note ? `<div class="board-item-note">${esc(item.note)}</div>` : ''}
      <div class="board-item-actions">
        <button class="ghost-btn" onclick="editBoardItem('${escAttr(boardId)}','${escAttr(item.articleId)}')" title="Modifier la note">${icon('i-edit')}</button>
        <button class="ghost-btn danger" onclick="confirmClick(this, 'removeBoardItem', '${escAttr(boardId)}', '${escAttr(item.articleId)}')" title="Retirer du board">${icon('i-trash')}</button>
      </div>
    </div>
  `).join('');
}

/* ════════════════════════════════════════
   Raccourcis clavier
   ════════════════════════════════════════ */
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    Bus.emit('focus-search');
  }
  if (e.key === 'Escape') {
    const modal = document.getElementById('save-modal');
    const settings = document.getElementById('settings-panel');
    const library = document.getElementById('library-panel');
    const boardPanel = document.getElementById('board-panel');
    if (modal.classList.contains('open')) closeSaveModal();
    else if (library.classList.contains('open')) library.classList.remove('open');
    else if (boardPanel.classList.contains('open')) closeBoardSheet();
    else if (settings.classList.contains('open')) settings.classList.remove('open');
    else Bus.emit('escape');
  }
});

/* ════════════════════════════════════════
   Initialisation
   ════════════════════════════════════════ */
window.addEventListener('DOMContentLoaded', async () => {
  Dashboard.init(document.getElementById('dashboard'));

  await fetchCategories();
  await fetchFeeds();
  fetchArticles();
  fetchSuggestions();
  fetchBoards();
  fetchFeedlyStatus();
  fetchSpotifyStatus();
  fetchAiStatus();

  // Les métriques ne sont sondées que si un widget les affiche.
  setInterval(() => {
    if (!document.hidden && !document.getElementById('dashboard').hidden && Bus.count('metrics') > 0) fetchSystemMetrics();
  }, 2000);
  if (Bus.count('metrics') > 0) fetchSystemMetrics();

  // Auto-rafraîchissement des articles toutes les 3 minutes
  setInterval(async () => {
    if (document.hidden || document.getElementById('dashboard').hidden || Bus.count('articles') === 0) return;
    await fetch('/api/articles/refresh', { method: 'POST' });
    await fetchArticles();
  }, 3 * 60 * 1000);
});

/* ════════════════════════════════════════
   PACMAN — easter egg du logo
   ════════════════════════════════════════ */
(() => {
  const canvas = document.getElementById('pacman-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const mid = H / 2;
  const pac = { x: 4, r: 11, mouth: 0.25, mouthDir: 1, mouthSpeed: 0.008, targetX: 4, eating: false };
  let pellets = [];
  let score = parseInt(localStorage.getItem('fm-score') || '0', 10);
  let particles = [];
  let scorePulse = 0;
  let bigMilestonePulse = 0;
  let badgeParticles = [];
  let milestoneRings = [];

  const SHAPES = ['circle', 'square', 'triangle', 'star', 'diamond'];
  const PELLET_COLORS = ['#4ade80', '#60a5fa', '#f472b6', '#fbbf24', '#a78bfa'];
  const PACMAN_PALETTE = ['#4ade80', '#60a5fa', '#f472b6', '#fbbf24', '#a78bfa', '#fb923c', '#34d399', '#f87171', '#38bdf8', '#e879f9'];
  let pacmanColor = null;

  function accentColor() {
    return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4ade80';
  }
  pacmanColor = accentColor();

  function spawnPellets() {
    pellets = [];
    const count = 5 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) {
      pellets.push({
        x: 38 + i * 14,
        y: mid + (Math.random() - 0.5) * 6,
        r: 2.5 + Math.random() * 1.5,
        shape: SHAPES[Math.floor(Math.random() * SHAPES.length)],
        alive: true,
        color: PELLET_COLORS[Math.floor(Math.random() * PELLET_COLORS.length)],
      });
    }
  }

  function drawPacman() {
    const { x, r, mouth } = pac;
    ctx.save();
    ctx.translate(x + r, mid);
    ctx.beginPath();
    ctx.arc(0, 0, r, mouth * Math.PI, (2 - mouth) * Math.PI);
    ctx.lineTo(0, 0);
    ctx.closePath();
    ctx.fillStyle = pacmanColor;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(-1, -r * 0.35, 1.8, 0, Math.PI * 2);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();
  }

  function drawShape(p) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.fillStyle = p.color;
    const r = p.r;
    if (p.shape === 'circle') {
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    } else if (p.shape === 'square') {
      ctx.fillRect(-r, -r, r * 2, r * 2);
    } else if (p.shape === 'triangle') {
      ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(r, r); ctx.lineTo(-r, r); ctx.closePath(); ctx.fill();
    } else if (p.shape === 'star') {
      ctx.beginPath();
      for (let i = 0; i < 5; i++) {
        const a = (i * 4 * Math.PI / 5) - Math.PI / 2;
        ctx[i === 0 ? 'moveTo' : 'lineTo'](Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath(); ctx.fill();
    } else if (p.shape === 'diamond') {
      ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(r, 0); ctx.lineTo(0, r); ctx.lineTo(-r, 0); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  function drawParticles() {
    for (const p of particles) {
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawScore() {
    const label = score.toLocaleString('fr-FR');
    const pulse = Math.max(scorePulse, bigMilestonePulse);
    const isBig = bigMilestonePulse > 0;
    const eatAlpha = pac.eating ? 0.28 : 1;

    ctx.save();
    const fontSize = 13 + pulse * 2;
    ctx.font = `800 ${fontSize}px system-ui`;
    const textW = ctx.measureText(label).width;
    const bW = Math.max(50, textW + 16);
    const bH = 19 + pulse * 2;
    const bX = W - bW - 5;
    const bY = mid - bH / 2;
    const r = bH / 2;

    // Glow halo
    if (pulse > 0) {
      ctx.shadowBlur = 10 + pulse * 22;
      ctx.shadowColor = isBig ? '#ffffff' : pacmanColor;
    }

    // Dark pill background
    ctx.globalAlpha = 0.82 * eatAlpha;
    ctx.fillStyle = 'rgba(0,0,0,0.48)';
    ctx.beginPath(); ctx.roundRect(bX, bY, bW, bH, r); ctx.fill();

    // Colored border — rainbow cycle on big milestone
    ctx.shadowBlur = 0;
    ctx.globalAlpha = (0.68 + pulse * 0.32) * eatAlpha;
    ctx.strokeStyle = isBig
      ? `hsl(${(Date.now() / 5) % 360}, 95%, 65%)`
      : pacmanColor;
    ctx.lineWidth = 1.2 + pulse * 0.6;
    ctx.beginPath(); ctx.roundRect(bX, bY, bW, bH, r); ctx.stroke();

    // Score number
    ctx.globalAlpha = eatAlpha;
    ctx.fillStyle = isBig ? '#ffffff' : pacmanColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bX + bW / 2, mid);

    ctx.restore();
  }

  function drawBrandText() {
    ctx.font = '700 14px system-ui';
    ctx.textAlign = 'left';
    const textX = pac.x + pac.r * 2 + 6;
    if (!pac.eating && pellets.every((p) => !p.alive)) {
      ctx.fillStyle = '#eef1f4';
      ctx.fillText('Feed', textX, mid + 5);
      ctx.fillStyle = pacmanColor;
      ctx.fillText('Me', textX + ctx.measureText('Feed').width + 1, mid + 5);
    }
  }

  function drawSeparator() {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(W - 65, mid - 8);
    ctx.lineTo(W - 65, mid + 8);
    ctx.stroke();
    ctx.restore();
  }

  function spawnMilestoneEffect(big) {
    const cx = W - 25;
    const cy = mid;
    const count = big ? 24 : 8;
    for (let i = 0; i < count; i++) {
      const angle = big ? (i / count) * Math.PI * 2 : Math.random() * Math.PI * 2;
      const speed = big ? 2.2 + Math.random() * 2.5 : 0.9 + Math.random() * 1.6;
      badgeParticles.push({
        x: cx, y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        r: big ? 2 + Math.random() * 1.5 : 1 + Math.random() * 0.8,
        life: 1,
        color: PACMAN_PALETTE[Math.floor(Math.random() * PACMAN_PALETTE.length)],
      });
    }
    if (big) {
      for (let i = 0; i < 3; i++) {
        milestoneRings.push({ x: cx, y: cy, r: 5, life: 1, delay: i * 9 });
      }
    }
  }

  function drawBadgeParticles() {
    ctx.save();
    for (const p of badgeParticles) {
      ctx.globalAlpha = p.life * 0.88;
      ctx.shadowBlur = 5;
      ctx.shadowColor = p.color;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawMilestoneRings() {
    ctx.save();
    for (const ring of milestoneRings) {
      if (ring.delay > 0) continue;
      ctx.globalAlpha = ring.life * 0.65;
      ctx.shadowBlur = 8 * ring.life;
      ctx.shadowColor = pacmanColor;
      ctx.strokeStyle = pacmanColor;
      ctx.lineWidth = 1.6 * ring.life;
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, ring.r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function update() {
    pac.mouth += pac.mouthDir * pac.mouthSpeed;
    if (pac.mouth > 0.3) pac.mouthDir = -1;
    if (pac.mouth < 0.02) pac.mouthDir = 1;

    if (pac.eating) {
      const nextPellet = pellets.find((p) => p.alive);
      if (nextPellet) {
        pac.targetX = nextPellet.x - pac.r;
        const dx = pac.targetX - pac.x;
        pac.x += dx * 0.015;
        if (Math.abs(pac.x + pac.r - nextPellet.x) < 6) {
          nextPellet.alive = false;
          score++;
          localStorage.setItem('fm-score', score);
          if (score % 200 === 0) {
            bigMilestonePulse = 1;
            spawnMilestoneEffect(true);
            const filtered = PACMAN_PALETTE.filter(c => c !== pacmanColor);
            pacmanColor = filtered[Math.floor(Math.random() * filtered.length)];
          } else if (score % 50 === 0) {
            scorePulse = 1;
            spawnMilestoneEffect(false);
            const filtered = PACMAN_PALETTE.filter(c => c !== pacmanColor);
            pacmanColor = filtered[Math.floor(Math.random() * filtered.length)];
          } else if (score % 10 === 0) {
            const filtered = PACMAN_PALETTE.filter(c => c !== pacmanColor);
            pacmanColor = filtered[Math.floor(Math.random() * filtered.length)];
          }
          for (let i = 0; i < 6; i++) {
            particles.push({
              x: nextPellet.x, y: nextPellet.y,
              vx: (Math.random() - 0.5) * 3, vy: (Math.random() - 0.5) * 3,
              r: nextPellet.r, life: 1, color: nextPellet.color,
            });
          }
        }
      } else {
        pac.eating = false;
        pac.targetX = 4;
      }
    } else {
      const dx = pac.targetX - pac.x;
      pac.x += dx * 0.008;
    }

    for (const p of particles) {
      p.x += p.vx; p.y += p.vy;
      p.life -= 0.04;
    }
    particles = particles.filter((p) => p.life > 0);

    for (const p of badgeParticles) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.05; p.life -= 0.028;
    }
    badgeParticles = badgeParticles.filter(p => p.life > 0);
    for (const ring of milestoneRings) {
      if (ring.delay > 0) { ring.delay--; continue; }
      ring.r += 2.5; ring.life -= 0.022;
    }
    milestoneRings = milestoneRings.filter(r => r.life > 0);
    scorePulse = Math.max(0, scorePulse - 0.022);
    bigMilestonePulse = Math.max(0, bigMilestonePulse - 0.012);
  }

  function render() {
    ctx.clearRect(0, 0, W, H);
    for (const p of pellets) { if (p.alive) drawShape(p); }
    drawParticles();
    drawMilestoneRings();
    drawPacman();
    drawBrandText();
    drawSeparator();
    drawScore();
    drawBadgeParticles();
    update();
    requestAnimationFrame(render);
  }

  window.pacmanChomp = function () {
    if (pac.eating) return;
    spawnPellets();
    pac.eating = true;
    pac.mouthSpeed = 0.012;
  };

  function applyScore(n) {
    for (let i = 0; i < n; i++) {
      score++;
      localStorage.setItem('fm-score', score);
      const filtered = PACMAN_PALETTE.filter((c) => c !== pacmanColor);
      if (score % 200 === 0) {
        bigMilestonePulse = 1;
        spawnMilestoneEffect(true);
        pacmanColor = filtered[Math.floor(Math.random() * filtered.length)];
      } else if (score % 50 === 0) {
        scorePulse = 1;
        spawnMilestoneEffect(false);
        pacmanColor = filtered[Math.floor(Math.random() * filtered.length)];
      } else if (score % 10 === 0) {
        pacmanColor = filtered[Math.floor(Math.random() * filtered.length)];
      }
    }
    if (scorePulse === 0 && bigMilestonePulse === 0) scorePulse = 0.35;
  }

  window.addScore = applyScore;

  spawnPellets();
  render();
})();
