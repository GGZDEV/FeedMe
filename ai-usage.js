'use strict';
const fs = require('fs'), path = require('path'), express = require('express');
const clean = (value, max = 100) => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, '').slice(0, max) : '';
const percent = value => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
const timestamp = value => typeof value === 'number' && Number.isFinite(value) && value > 1e12 ? value : null;
const CACHE_MS = 120000;
const providerName = (id, fallback) => ['openai', 'openai-codex'].includes(id) ? 'ChatGPT / Codex' : id === 'anthropic' ? 'Claude' : fallback || id;
const directErrors = {
  CODEX_LOGIN_REQUIRED: 'Connectez Codex à votre abonnement ChatGPT sur ce PC, puis actualisez les quotas.',
  CLAUDE_LOGIN_REQUIRED: 'Connexion Claude Code expirée : reconnectez Claude Code à votre abonnement Claude sur ce PC (ou lancez « claude »), puis actualisez.',
  CLAUDE_USAGE_UNAVAILABLE: 'Claude ne communique pas ses quotas actuellement. Réessayez plus tard.'
};

function normalizeUsage(value, now = Date.now()) {
  if (!Array.isArray(value?.providers)) throw new Error('Réponse de quotas invalide.');
  const providers = [];
  for (const item of value.providers.slice(0, 100)) {
    if (typeof item?.provider !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(item.provider)) continue;
    const windows = (Array.isArray(item.windows) ? item.windows : []).slice(0, 20).flatMap(window => {
      const used = percent(window?.usedPercent);
      return used === null ? [] : [{ label: clean(window.label) || 'Quota', groupLabel: clean(window.groupLabel), usedPercent: used,
        remainingPercent: 100 - used, resetAt: timestamp(window.resetAt) }];
    });
    providers.push({ provider: item.provider, name: providerName(item.provider, clean(item.displayName)), plan: clean(item.plan), windows,
      updatedAt: timestamp(value.updatedAt) || now, ...(item.error ? { error: directErrors[item.errorCode] || 'Quota indisponible. Vérifiez la connexion du compte dans OpenClaw.' } : {}) });
  }
  return { providers, updatedAt: timestamp(value.updatedAt) || now, refreshing: value.refreshing === true };
}

class UsageService {
  constructor({ dataDir, readUsage, connections, now = Date.now }) {
    this.file = path.join(dataDir, 'ai-usage.json');
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { sources: [], snapshots: {} };
    this.readUsage = readUsage; this.connections = connections; this.now = now; this.pending = new Map(); this.lastAttempt = new Map(); this.results = new Map();
  }
  save() { fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data), { mode: 0o600 }); fs.renameSync(this.file + '.tmp', this.file); }
  config() { return { sources: this.data.sources, connections: this.connections() }; }
  configure(sources) {
    if (!Array.isArray(sources) || sources.length > 10) throw new Error('Configuration invalide.');
    const available = new Set(this.connections().map(c => c.id)), seen = new Set();
    this.data.sources = sources.map(source => {
      if (!available.has(source?.connectionId) || seen.has(source.connectionId)) throw new Error('Connexion invalide ou déjà ajoutée.');
      seen.add(source.connectionId);
      let providers = null;
      if (source.providers !== null && source.providers !== undefined) {
        if (!Array.isArray(source.providers) || source.providers.length > 100 || source.providers.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(id))) throw new Error('Liste des abonnements invalide.');
        providers = [...new Set(source.providers)];
      }
      return { connectionId: source.connectionId, label: clean(source.label) || this.connections().find(c => c.id === source.connectionId).name, providers };
    });
    for (const id of Object.keys(this.data.snapshots)) if (!seen.has(id)) delete this.data.snapshots[id];
    for (const id of this.results.keys()) if (!seen.has(id)) this.results.delete(id);
    for (const id of seen) {
      const result = this.results.get(id);
      if (result && !result.stale && !result.refreshing && !result.error) this.data.snapshots[id] = result;
    }
    this.save(); return this.config();
  }
  async read(id, force = false) {
    if (this.pending.has(id)) return this.pending.get(id);
    const previous = this.data.snapshots[id], now = this.now();
    const cooldown = force ? 5000 : CACHE_MS;
    const cached = this.results.get(id) || previous;
    if (cached && now - (this.lastAttempt.get(id) ?? previous?.fetchedAt ?? 0) < cooldown) return cached;
    this.lastAttempt.set(id, now);
    const task = (async () => {
      try {
        const fresh = normalizeUsage(await this.readUsage(id), this.now());
        if (fresh.refreshing) return { ...(previous || { providers: [] }), refreshing: true, stale: !!previous, error: 'Mise à jour des quotas en cours…' };
        const providers = fresh.providers.map(provider => {
          const old = previous?.providers.find(p => p.provider === provider.provider);
          return provider.error && old?.windows.length ? { ...old, stale: true, error: provider.error } : provider;
        });
        const snapshot = { ...fresh, providers, fetchedAt: this.now(), stale: false };
        // Discovery does not persist a subscription or any authentication data.
        if (this.data.sources.some(s => s.connectionId === id)) { this.data.snapshots[id] = snapshot; this.save(); }
        return snapshot;
      } catch {
        return { ...(previous || { providers: [] }), stale: true, error: id.startsWith('direct:') ? 'Impossible d’actualiser les quotas. Vérifiez la connexion du compte sur ce PC.' : 'Impossible d’actualiser les quotas. Vérifiez OpenClaw et la connexion des comptes.' };
      }
    })();
    this.pending.set(id, task);
    try { const result = await task; this.results.set(id, result); return result; } finally { this.pending.delete(id); }
  }
  async snapshot(force = false) {
    const sources = await Promise.all(this.data.sources.map(async source => {
      const snapshot = await this.read(source.connectionId, force);
      const providers = source.providers === null ? snapshot.providers : source.providers.map(id => snapshot.providers.find(p => p.provider === id) ||
        { provider: id, name: providerName(id), plan: '', windows: [], error: 'OpenClaw ne communique pas de quota pour cet abonnement. Vérifiez son suivi d’utilisation côté OpenClaw.' });
      return { ...source, ...snapshot, providers };
    }));
    return { sources, configured: this.data.sources.length > 0, checkedAt: this.now() };
  }
}

function createUsageRouter(options) {
  const router = express.Router(), service = new UsageService(options);
  router.use((req, res, next) => {
    let host; try { host = new URL('http://' + req.headers.host).hostname; } catch { /* reject below */ }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host) || (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) || req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Accès local uniquement.' });
    res.setHeader('Cache-Control', 'no-store'); next();
  });
  const route = fn => async (req, res) => { try { await fn(req, res); } catch (error) { if (!res.headersSent) res.status(400).json({ error: error.message }); } };
  router.get('/config', (_req, res) => res.json(service.config()));
  router.post('/config', route((req, res) => res.json(service.configure(req.body?.sources))));
  router.post('/discover', route(async (req, res) => {
    const id = req.body?.connectionId;
    if (!options.connections().some(c => c.id === id)) throw new Error('Choisissez une source de quotas enregistrée.');
    res.json(await service.read(id, true));
  }));
  router.get('/', route(async (req, res) => res.json(await service.snapshot(req.query.refresh === '1'))));
  return router;
}
module.exports = { normalizeUsage, UsageService, createUsageRouter };
