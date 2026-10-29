'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { EventEmitter } = require('events');
const { messageText } = require('./openclaw');
const digest = value => createHash('sha256').update(value).digest('hex');
const visible = text => text.trim() && !/^(NO_REPLY|HEARTBEAT_OK)$/i.test(text.trim());
const eligible = row => typeof row?.key === 'string' && row.key.startsWith('agent:') &&
  !/:(subagent|heartbeat):|:heartbeat$/.test(row.key) && row.classification !== 'heartbeat';
const chatSession = key => typeof key === 'string' && /^agent:[a-zA-Z0-9_-]+:/.test(key) && !/:(cron|subagent|heartbeat)(:|$)/.test(key);

// This is a durable local projection of gateway transcripts, never a new
// delivery channel or a retry queue for remote agent work.
class AgentInbox extends EventEmitter {
  constructor({ dataDir, notify = () => {} }) {
    super();
    this.file = path.join(dataDir, 'agent-inbox.json');
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { items: [], sessions: {}, connections: {} };
    this.workers = new Map(); this.notify = notify; this.status = {};
  }
  save() {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }
  snapshot() {
    const items = [...this.data.items].sort((a, b) => b.receivedAt - a.receivedAt);
    return { items, unread: items.filter(item => !item.read).length, status: this.status };
  }
  changed() { this.emit('change'); }
  read(id) {
    const item = this.data.items.find(item => item.id === id);
    if (!item) throw new Error('Message introuvable.');
    item.read = true; this.save(); this.changed(); return item;
  }
  readAll() { this.data.items.forEach(item => { item.read = true; }); this.save(); this.changed(); }
  readSession(connectionId, sessionKey, ids) {
    const selected = new Set(ids);
    let changed = false;
    for (const item of this.data.items) if (!item.read && item.connectionId === connectionId && item.sessionKey === sessionKey && selected.has(item.id)) { item.read = true; changed = true; }
    if (changed) { this.save(); this.changed(); }
  }
  remove(connectionId) {
    this.stop(connectionId); delete this.status[connectionId];
    this.data.items = this.data.items.filter(item => item.connectionId !== connectionId);
    for (const key of Object.keys(this.data.sessions)) if (key.startsWith(connectionId + '|')) delete this.data.sessions[key];
    delete this.data.connections[connectionId]; this.save(); this.changed();
  }
  stop(id) {
    const worker = this.workers.get(id);
    if (!worker) return;
    worker.stopped = true; clearTimeout(worker.timer); clearTimeout(worker.eventTimer);
    worker.client.off('gatewayEvent', worker.onEvent); worker.client.off('disconnect', worker.onDisconnect); this.workers.delete(id);
  }
  start(connection, client) {
    if (this.workers.get(connection.id)?.client === client) return;
    this.stop(connection.id);
    const worker = { client, connection, stopped: false, delay: 2000, dirty: false, running: false };
    worker.onEvent = frame => {
      if (['sessions.changed', 'session.message', 'cron'].includes(frame.event) || (frame.event === 'chat' && ['final', 'error', 'aborted'].includes(frame.payload?.state))) {
        worker.dirty = true;
        if (!worker.running && !worker.eventTimer) worker.eventTimer = setTimeout(() => { worker.eventTimer = null; this.run(worker); }, 400);
      }
    };
    worker.onDisconnect = () => {
      worker.subscribed = false;
      if (!worker.running && !worker.stopped) {
        clearTimeout(worker.timer);
        worker.timer = setTimeout(() => this.run(worker), 2000);
      }
    };
    client.on('gatewayEvent', worker.onEvent); client.on('disconnect', worker.onDisconnect); this.workers.set(connection.id, worker);
    this.run(worker);
  }
  async run(worker) {
    if (worker.stopped || worker.running) return;
    clearTimeout(worker.timer); worker.running = true; worker.dirty = false;
    const id = worker.connection.id;
    try {
      const wasConnected = worker.client.info().state === 'connected';
      await worker.client.connect();
      if (worker.stopped) return;
      if (!worker.client.hello?.features?.methods?.includes('sessions.list')) throw new Error('Sessions unavailable');
      if (!wasConnected || !worker.subscribed || worker.socket !== worker.client.socket) {
        worker.versions = new Map();
        if (worker.client.hello?.features?.methods?.includes('sessions.subscribe')) {
          await worker.client.rpc('sessions.subscribe', { limit: 100 });
        }
        worker.subscribed = true;
        worker.socket = worker.client.socket;
      }
      await this.sync(worker);
      if (worker.stopped) return;
      worker.delay = 2000;
      this.status[id] = { state: 'connected', lastSync: Date.now(), message: worker.partial ? 'Historique partiel : certaines sessions restent à synchroniser.' : 'Réception active · synchronisation automatique' };
    } catch (error) {
      worker.subscribed = false;
      if (['TIMEOUT', 'DISCONNECTED'].includes(error.code)) worker.client.close();
      this.status[id] = { state: 'error', message: error.code ? error.message : 'Réception indisponible. Nouvelle tentative automatique.' };
      worker.delay = Math.min(worker.delay * 2, 60000);
    } finally {
      worker.running = false;
      if (!worker.stopped) {
        this.changed();
        worker.timer = setTimeout(() => this.run(worker), worker.dirty ? 500 : this.status[id]?.state === 'connected' ? 60000 : worker.delay);
        worker.timer.unref?.();
      }
    }
  }
  async sync(worker) {
    const { client, connection } = worker;
    worker.partial = false;
    const state = this.data.connections[connection.id] ||= { startedAt: Date.now() };
    let offset = 0;
    do {
      const page = await client.rpc('sessions.list', { limit: 100, offset });
      if (!Array.isArray(page?.sessions)) throw new Error('Invalid roster');
      for (const row of page.sessions.filter(eligible)) {
        if (worker.stopped) return;
        const key = connection.id + '|' + row.key;
        const previous = this.data.sessions[key];
        const metadata = { key: row.key, agentId: row.agentId || row.key.split(':')[1], sessionId: row.sessionId,
          title: String(row.label || row.derivedTitle || row.displayName || '').slice(0, 180), updatedAt: row.updatedAt,
          isMain: row.isMain === true || row.classification === 'main', source: row.channel || 'openclaw',
          sendDisabledReason: row.sendDisabledReason || null };
        // Re-read once after every reconnect, even if updatedAt is unchanged.
        const version = `${row.sessionId}|${row.updatedAt}`;
        if (previous && worker.versions?.get(key) === version && !worker.dirty) { previous.metadata = metadata; if (previous.partial) worker.partial = true; continue; }
        try {
          await this.syncSession(connection, client, row, state, previous, worker);
          if (worker.stopped) return;
          if (this.data.sessions[key]) this.data.sessions[key].metadata = metadata;
          (worker.versions ||= new Map()).set(key, version);
        } catch (error) {
          if (['DISCONNECTED', 'TIMEOUT'].includes(error.code)) throw error;
          worker.partial = true;
        }
      }
      const next = page.nextOffset;
      if (!page.hasMore) break;
      if (!Number.isInteger(next) || next <= offset || next >= 1000) { worker.partial = true; break; }
      offset = next;
    } while (!worker.stopped);
    if (!worker.stopped) { state.initialized = true; this.save(); }
  }
  async syncSession(connection, client, row, state, previous, worker) {
    const ledger = previous?.sessionId === row.sessionId ? previous : { sessionId: row.sessionId, seen: [] };
    const seen = new Set(ledger.seen);
    const additions = [];
    let offset = 0, pages = 0, anchor = false, partial = false;
    do {
      const history = await client.rpc('chat.history', { sessionKey: row.key, limit: 100, ...(offset ? { offset } : {}) });
      if (worker.stopped) return;
      if (row.sessionId && history.sessionId && row.sessionId !== history.sessionId) { worker.dirty = true; return; }
      for (const message of history.messages || []) {
        if (message?.role !== 'assistant') continue;
        const content = messageText(message).slice(0, 500000);
        if (!visible(content)) continue;
        const identity = message.__openclaw?.id || message.id || message.messageId || '';
        const rawTime = message.timestamp ?? message.createdAt;
        const time = typeof rawTime === 'number' ? rawTime : Date.parse(rawTime);
        const id = digest(JSON.stringify([connection.id, row.key, history.sessionId || row.sessionId, identity, identity ? null : rawTime, content]));
        if (seen.has(id)) { anchor = true; continue; }
        seen.add(id);
        const receivedAt = Number.isFinite(time) ? time : Number(row.updatedAt) || Date.now();
        const read = !state.initialized || (!previous && receivedAt < state.startedAt);
        additions.push({ id, connectionId: connection.id, sessionKey: row.key, sessionId: history.sessionId || row.sessionId,
          agentId: row.agentId || row.key.split(':')[1], title: String(row.label || row.displayName || row.derivedTitle || 'Message de votre agent').slice(0, 180),
          source: /:cron:/.test(row.key) || row.createdVia === 'cron' ? 'cron' : row.channel || (row.key.includes(':feedme:') ? 'feedme' : 'openclaw'),
          content, receivedAt, read });
      }
      if (!previous || anchor || !history.hasMore) break;
      const next = history.nextOffset;
      if (!Number.isInteger(next) || next <= offset || ++pages >= 10) { worker.partial = true; partial = true; break; }
      offset = next;
    } while (!worker.stopped);
    if (worker.stopped) return;
    this.data.sessions[connection.id + '|' + row.key] = { sessionId: row.sessionId, seen: [...seen].slice(-2000), partial: partial || !!previous?.partial };
    if (previous?.partial) worker.partial = true;
    const existing = new Set(this.data.items.map(item => item.id));
    const fresh = additions.filter(item => !existing.has(item.id));
    this.data.items.push(...fresh);
    this.data.items.sort((a, b) => a.receivedAt - b.receivedAt);
    // Keep unread messages; retain the latest 1000 read messages locally.
    let readCount = this.data.items.filter(item => item.read).length;
    this.data.items = this.data.items.filter(item => !item.read || readCount-- <= 1000);
    this.save();
    const unread = fresh.filter(item => !item.read);
    if (unread.length && chatSession(row.key)) {
      const last = unread.sort((a, b) => b.receivedAt - a.receivedAt)[0];
      try { this.notify({ ...last, connectionName: connection.name, count: unread.length }); } catch { /* OS notifications are optional. */ }
    }
  }
  close() { for (const id of this.workers.keys()) this.stop(id); }
}

module.exports = { AgentInbox, eligible, chatSession };
