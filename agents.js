'use strict';

// HTTP adapters stay independent of Electron so the desktop shell can evolve.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { OpenClawClient, DeviceVault, GatewayError, normalizeGatewayEndpoint } = require('./openclaw');
const { AgentInbox, chatSession } = require('./agent-inbox');
const { ContactProfiles, contactsFor, mergeMessages, agentFor } = require('./agent-contacts');
const { normalizeAttachments, attachmentMeta, gatewayAttachments, completionContent, rememberSent } = require('./agent-attachments');

function normalizeEndpoint(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error('Adresse du serveur invalide.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Utilisez une adresse HTTP(S), sans identifiants ni paramètres.');
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Pour un serveur distant, utilisez HTTPS ou un tunnel SSH vers localhost.');
  }
  let pathname = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  if (!pathname.endsWith('/v1')) pathname += '/v1';
  url.pathname = pathname;
  return url.href.replace(/\/$/, '');
}

// Incremental UTF-8 and SSE decoding, including CRLF, comments and multiline data.
async function* readEvents(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 2 * 1024 * 1024) throw new Error('Événement trop volumineux.');
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (data) yield data;
    }
  }
  buffer += decoder.decode();
  const data = buffer.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
  if (data) yield data;
}

function createAgentRouter({ dataDir, secretStorage = null, fetchImpl = fetch, WebSocketImpl = WebSocket, notify = () => {} }) {
  const router = express.Router();
  const file = path.join(dataDir, 'agents-store.json');
  const temporarySecrets = new Map();
  const active = new Map();
  const clients = new Map();
  const profiles = new ContactProfiles(dataDir);
  const inbox = new AgentInbox({ dataDir, notify: item => {
    const ownActive = store.conversations.some(c => c.connectionId === item.connectionId && c.remote?.sessionKey === item.sessionKey && active.has(c.id));
    if (!ownActive) notify({ ...item, displayName: profiles.get(item.connectionId, item.agentId).name ||
      clients.get(item.connectionId)?.catalog?.agents.find(agent => agent.id === item.agentId)?.name || item.agentId });
  } });
  const vault = new DeviceVault(dataDir, secretStorage);
  let store = { connections: [], conversations: [] };
  if (fs.existsSync(file)) store = JSON.parse(fs.readFileSync(file, 'utf8'));
  const save = () => {
    fs.writeFileSync(file + '.tmp', JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  };
  let migrated = false;
  for (const connection of store.connections) {
    if (connection.kind !== 'openclaw') continue;
    const endpoint = normalizeGatewayEndpoint(connection.endpoint);
    if (connection.transport !== 'gateway-ws') {
      // An old HTTP bearer is not a gateway password. Never reinterpret it.
      delete connection.secret;
      connection.transport = 'gateway-ws'; connection.authMode = 'password';
      migrated = true;
    }
    if (connection.endpoint !== endpoint) { connection.endpoint = endpoint; migrated = true; }
    if (connection.model === 'openclaw') { connection.model = 'default'; migrated = true; }
  }
  if (migrated) save();
  // A crash cannot turn an unfinished answer into a successful response.
  for (const conversation of store.conversations) {
    for (const message of conversation.messages) if (message.status === 'streaming') message.status = 'interrupted';
  }
  const tokenFor = connection => {
    if (temporarySecrets.has(connection.id)) return temporarySecrets.get(connection.id);
    if (connection.secret) {
      try { return secretStorage.decrypt(connection.secret); }
      catch { throw new Error('Renseignez à nouveau le jeton de cette connexion.'); }
    }
    return '';
  };
  const clientFor = connection => {
    if (!clients.has(connection.id)) clients.set(connection.id, new OpenClawClient({
      endpoint: connection.endpoint, vault, password: () => tokenFor(connection), WebSocketImpl,
    }));
    return clients.get(connection.id);
  };
  const publicConnection = ({ secret, ...connection }) => ({
    ...connection, hasToken: !!secret || temporarySecrets.has(connection.id),
    tokenStorage: secret ? 'encrypted' : temporarySecrets.has(connection.id) ? 'session' : 'none',
    ...(connection.kind === 'openclaw' ? {
      gateway: clients.get(connection.id)?.info() || { state: 'disconnected', ...vault.info(connection.endpoint) },
      ...(clients.get(connection.id)?.catalog ? { catalog: clients.get(connection.id).catalog } : {}),
    } : {}),
  });
  const findConnection = id => {
    const connection = store.connections.find(item => item.id === id);
    if (!connection) throw new Error('Connexion introuvable.');
    return connection;
  };
  const adoptSession = (connection, row) => {
    if (!chatSession(row.key) || row.agentId !== row.key.split(':')[1]) return null;
    let conversation = store.conversations.find(c => c.connectionId === connection.id && c.remote?.sessionKey === row.key);
    if (!conversation) {
      conversation = { id: randomUUID(), connectionId: connection.id, agentId: row.agentId, createdAt: new Date().toISOString(), messages: [],
        remote: { agentId: row.agentId, sessionKey: row.key, ...(row.sessionId ? { sessionId: row.sessionId } : {}) } };
      store.conversations.push(conversation);
    }
    conversation.title ||= row.title || 'Discussion';
    conversation.isMain = row.isMain === true || row.key === `agent:${row.agentId}:main`;
    conversation.source = row.source || 'openclaw';
    conversation.readOnly = !!row.sendDisabledReason;
    conversation.updatedAt = row.updatedAt || conversation.updatedAt;
    return conversation;
  };
  const adoptSessions = () => {
    for (const [key, session] of Object.entries(inbox.data.sessions)) {
      const connection = store.connections.find(c => key.startsWith(c.id + '|') && c.kind === 'openclaw');
      if (connection && session.metadata) adoptSession(connection, session.metadata);
    }
  };
  const conversationSummary = ({ messages, ...conversation }) => {
    const received = inbox.data.items.filter(item => item.connectionId === conversation.connectionId && item.sessionKey === conversation.remote?.sessionKey);
    const latest = received.reduce((latest, item) => !latest || item.receivedAt > latest.receivedAt ? item : latest, null);
    const local = messages.at(-1);
    const stamp = local?.createdAt || local?.timestamp;
    const localTime = (typeof stamp === 'number' ? stamp : Date.parse(stamp || '')) || 0;
    return { ...conversation, active: active.has(conversation.id), unread: received.filter(item => !item.read).length,
      preview: latest && latest.receivedAt > localTime ? latest.content.slice(0, 180) : (local?.content || latest?.content || '').slice(0, 180),
      updatedAt: Math.max(Number(conversation.updatedAt) || 0, latest?.receivedAt || 0, localTime) || Date.parse(conversation.createdAt) };
  };
  inbox.on('change', () => { adoptSessions(); save(); });
  const headersFor = connection => {
    const token = tokenFor(connection);
    return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  };
  const upstreamError = status => new Error(status === 401 || status === 403
    ? 'Accès refusé : vérifiez le jeton et les droits de la passerelle.'
    : status === 404 ? 'API introuvable : vérifiez l’adresse et activez Chat Completions sur la passerelle.'
      : `La passerelle a renvoyé une erreur HTTP ${status}.`);
  const route = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (error) { if (!res.headersSent) res.status(400).json({ error: error.message }); }
  };

  router.use((req, res, next) => {
    // Reject remote browser origins and DNS rebinding to the local bridge.
    const expected = `http://${req.headers.host}`;
    let host;
    try { host = new URL(expected).hostname; } catch { /* rejected below */ }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host) ||
        (req.headers.origin && req.headers.origin !== expected) || req.headers['sec-fetch-site'] === 'cross-site') {
      return res.status(403).json({ error: 'Accès local uniquement.' });
    }
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.get('/', (_req, res) => {
    adoptSessions();
    const connections = store.connections.map(publicConnection), conversations = store.conversations.map(conversationSummary);
    res.json({ connections, conversations, contacts: contactsFor(connections, conversations, profiles) });
  });
  const contactConnection = req => {
    const connection = findConnection(req.params.connectionId);
    const id = req.params.agentId;
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !(clients.get(connection.id)?.catalog?.agents.some(a => a.id === id) ||
      store.conversations.some(c => c.connectionId === connection.id && agentFor(c) === id) || (connection.kind !== 'openclaw' && id === 'default'))) throw new Error('Agent introuvable.');
    return connection;
  };
  router.post('/connections/:connectionId/contacts/:agentId/profile', route((req, res) => {
    const connection = contactConnection(req);
    const profile = profiles.set(connection.id, req.params.agentId, req.body || {});
    // Presentation only: no Gateway RPC, agent rename or remote configuration.
    res.json(profile);
  }));
  router.get('/connections/:connectionId/contacts/:agentId', route(async (req, res) => {
    const connection = contactConnection(req); adoptSessions();
    const threads = store.conversations.filter(c => c.connectionId === connection.id && agentFor(c) === req.params.agentId);
    const primary = threads.find(c => c.isMain) || threads.find(c => c.contact) || threads[0];
    if (!primary) throw new Error('Ouvrez d’abord une conversation avec cet agent.');
    let partial = false;
    const failed = new Set(), running = new Set();
    const queue = [...threads];
    if (connection.kind === 'openclaw') await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length) {
        const thread = queue.shift();
        if (active.has(thread.id)) { running.add(thread.id); continue; }
        try {
          const history = await clientFor(connection).history(thread, connection.model);
          if (active.has(thread.id)) { running.add(thread.id); continue; }
          if (history.messages.length || !thread.messages.length) thread.messages = history.messages;
          if (history.active) running.add(thread.id);
        } catch { partial = true; failed.add(thread.id); }
      }
    }));
    const messages = mergeMessages(threads);
    const visible = new Set(messages.filter(m => m.role === 'assistant' && !failed.has(m.conversationId)).map(m => JSON.stringify([m.conversationId, m.content])));
    const receiptIds = inbox.data.items.filter(item => !item.read && threads.some(thread => thread.remote?.sessionKey === item.sessionKey &&
      item.connectionId === connection.id && visible.has(JSON.stringify([thread.id, item.content])))).map(item => item.id);
    save();
    res.json({ id: primary.id, connectionId: connection.id, agentId: req.params.agentId, contact: true, messages, receiptIds,
      readOnly: !!primary.readOnly, active: running.has(primary.id), activeConversationIds: [...running],
      ...(partial ? { historyError: 'Certains anciens messages sont momentanément indisponibles.' } : {}) });
  }));
  router.post('/connections/:connectionId/contacts/:agentId/read', route((req, res) => {
    const connection = contactConnection(req);
    if (!Array.isArray(req.body?.ids)) throw new Error('Messages invalides.');
    const allowed = new Set(store.conversations.filter(c => c.connectionId === connection.id && agentFor(c) === req.params.agentId).map(c => c.remote?.sessionKey));
    for (const key of allowed) inbox.readSession(connection.id, key, req.body.ids.slice(0, 2000));
    res.json({ ok: true });
  }));
  router.post('/threads/open', route(async (req, res) => {
    const connection = findConnection(req.body?.connectionId);
    if (connection.kind !== 'openclaw') throw new Error('Choisissez une conversation de cette connexion.');
    const client = clientFor(connection);
    const catalog = await client.listAgents();
    const agent = catalog.agents.find(agent => agent.id === req.body?.agentId);
    if (!agent) throw new Error('Cet agent est indisponible.');
    adoptSessions();
    let row;
    if (req.body.sessionKey !== undefined) {
      if (!chatSession(req.body.sessionKey) || req.body.sessionKey.split(':')[1] !== agent.id) throw new Error('Conversation invalide pour cet agent.');
      row = inbox.data.sessions[connection.id + '|' + req.body.sessionKey]?.metadata;
      if (!row && !store.conversations.some(c => c.connectionId === connection.id && c.agentId === agent.id && c.remote?.sessionKey === req.body.sessionKey)) throw new Error('Conversation inconnue. Actualisez les discussions.');
    } else {
      const page = await client.rpc('sessions.list', { agentId: agent.id, limit: 100 });
      const native = page.sessions?.find(s => s.agentId === agent.id && chatSession(s.key) && (s.isMain || s.key === `agent:${agent.id}:main`));
      if (native) row = { ...native, title: agent.name, source: native.channel || 'openclaw' };
    }
    let conversation = row ? adoptSession(connection, row) : store.conversations.find(c => c.connectionId === connection.id && c.agentId === agent.id &&
      (req.body.sessionKey ? c.remote?.sessionKey === req.body.sessionKey : c.contact === true));
    if (!conversation) {
      conversation = { id: randomUUID(), connectionId: connection.id, agentId: agent.id, title: agent.name, contact: true,
        createdAt: new Date().toISOString(), messages: [] };
      // A persistent contact is created once, never a fresh session per reply.
      client.target(conversation, connection.model);
      store.conversations.push(conversation);
    }
    save(); res.json(conversation);
  }));
  router.post('/conversations/:id/read', route((req, res) => {
    const conversation = store.conversations.find(c => c.id === req.params.id);
    if (!conversation || !Array.isArray(req.body?.ids)) throw new Error('Conversation invalide.');
    inbox.readSession(conversation.connectionId, conversation.remote?.sessionKey, req.body.ids.slice(0, 1000));
    res.json({ ok: true });
  }));
  router.get('/inbox', (_req, res) => res.json(inbox.snapshot()));
  router.post('/inbox/read-all', (_req, res) => { inbox.readAll(); res.json({ ok: true }); });
  router.post('/inbox/:id/read', route((req, res) => res.json(inbox.read(req.params.id))));
  router.post('/inbox/sync', route(async (_req, res) => {
    for (const connection of store.connections.filter(c => c.kind === 'openclaw')) inbox.start(connection, clientFor(connection));
    await Promise.all([...inbox.workers.values()].map(worker => { worker.versions = new Map(); return inbox.run(worker); }));
    res.json(inbox.snapshot());
  }));
  router.get('/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'Cache-Control': 'no-store' });
    const changed = () => res.write('event: inbox\ndata: {}\n\n');
    inbox.on('change', changed); changed();
    const heartbeat = setInterval(() => res.write(': alive\n\n'), 20000);
    req.on('close', () => { clearInterval(heartbeat); inbox.off('change', changed); });
  });
  router.post('/connections', route((req, res) => {
    const input = req.body || {};
    if (!['openclaw', 'hermes', 'compatible'].includes(input.kind)) throw new Error('Type de connexion invalide.');
    const name = String(input.name || '').trim().slice(0, 80);
    const model = String(input.model || '').trim().slice(0, 200);
    if (!name || !model) throw new Error('Nom et agent / modèle requis.');
    const endpoint = input.kind === 'openclaw' ? normalizeGatewayEndpoint(input.endpoint) : normalizeEndpoint(input.endpoint);
    const existing = input.id ? findConnection(input.id) : null;
    if (existing && store.conversations.some(c => c.connectionId === existing.id && active.has(c.id))) throw new Error('Attendez la fin de la réponse avant de modifier cette connexion.');
    const connection = { id: existing?.id || randomUUID(), name, kind: input.kind, endpoint, model, secret: existing?.secret };
    if (connection.kind === 'openclaw') { connection.transport = 'gateway-ws'; connection.authMode = 'password'; }
    // Validate identity before changing any saved or in-memory credentials.
    if (existing && (existing.endpoint !== endpoint || existing.model !== model || existing.kind !== input.kind) && store.conversations.some(c => c.connectionId === existing.id)) {
      throw new Error('Créez une autre connexion pour changer de serveur ou d’agent sans mélanger les historiques.');
    }
    const suppliedSecret = input.kind === 'openclaw' ? input.password : input.token;
    if (suppliedSecret !== undefined && String(suppliedSecret).length) {
      const token = input.kind === 'openclaw' ? String(suppliedSecret) : String(suppliedSecret).trim();
      if (token.length > 8192 || /[\r\n]/.test(token)) throw new Error('Jeton invalide.');
      if (input.kind === 'openclaw' && !secretStorage) throw new GatewayError('SECURE_STORAGE_REQUIRED');
      if (secretStorage) connection.secret = secretStorage.encrypt(token);
      else { temporarySecrets.set(connection.id, token); delete connection.secret; }
      if (input.kind === 'openclaw' && vault.data.grants[endpoint]) vault.clearGrant(endpoint);
    }
    inbox.stop(connection.id);
    clients.get(connection.id)?.close(); clients.delete(connection.id);
    if (existing) Object.assign(existing, connection);
    else store.connections.push(connection);
    save();
    if (connection.kind === 'openclaw' && vault.info(connection.endpoint).paired) inbox.start(connection, clientFor(connection));
    res.json(publicConnection(connection));
  }));
  router.delete('/connections/:id', route((req, res) => {
    findConnection(req.params.id);
    const threads = store.conversations.filter(c => c.connectionId === req.params.id);
    if (threads.some(c => active.has(c.id))) throw new Error('Une réponse est encore en cours.');
    store.connections = store.connections.filter(c => c.id !== req.params.id);
    store.conversations = store.conversations.filter(c => c.connectionId !== req.params.id);
    temporarySecrets.delete(req.params.id);
    inbox.remove(req.params.id);
    clients.get(req.params.id)?.close(); clients.delete(req.params.id);
    save(); res.json({ ok: true });
  }));
  router.post('/connections/:id/test', route(async (req, res) => {
    const connection = findConnection(req.params.id);
    if (connection.kind === 'openclaw') {
      const client = clientFor(connection);
      try { await client.connect(); }
      catch (error) {
        if (!(error instanceof GatewayError)) throw new GatewayError('DISCONNECTED');
        // Pendant un test, une coupure avant la poignée de main veut dire que
        // rien ne répond à cette adresse : le message générique (tâche
        // interrompue) induirait en erreur.
        const message = error.code === 'DISCONNECTED'
          ? 'Passerelle injoignable : rien ne répond à cette adresse. Vérifiez qu’OpenClaw tourne sur le serveur et qu’il est bien exposé (tailscale serve, tunnel…).'
          : error.message;
        return res.json({ ok: false, gateway: { ...client.info(), message, code: error.code } });
      }
      inbox.start(connection, client);
      return res.json({ ok: true, gateway: client.info() });
    }
    let response;
    try {
      response = await fetchImpl(`${connection.endpoint}/models`, { headers: headersFor(connection), redirect: 'error', signal: AbortSignal.timeout(10000) });
    } catch { throw new Error('Serveur inaccessible : vérifiez HTTPS, le tunnel et l’adresse.'); }
    if (!response.ok) throw upstreamError(response.status);
    const result = await response.json();
    if (!Array.isArray(result.data)) throw new Error('Cette adresse ne répond pas comme une API compatible.');
    res.json({ ok: true, models: result.data.map(model => model.id).filter(id => typeof id === 'string').slice(0, 100) });
  }));
  router.get('/connections/:id/agents', route(async (req, res) => {
    const connection = findConnection(req.params.id);
    if (connection.kind !== 'openclaw') throw new Error('Cette connexion ne possède pas de catalogue d’agents OpenClaw.');
    res.json(await clientFor(connection).listAgents());
  }));
  router.post('/conversations', route(async (req, res) => {
    const connection = findConnection(req.body?.connectionId);
    const conversation = { id: randomUUID(), connectionId: connection.id, title: 'Nouvelle conversation', createdAt: new Date().toISOString(), messages: [] };
    if (connection.kind === 'openclaw' && req.body?.agentId !== undefined) {
      const catalog = await clientFor(connection).listAgents();
      const agent = catalog.agents.find(agent => agent.id === req.body.agentId);
      if (!agent) throw new Error('Cet agent est indisponible sur la passerelle. Actualisez la liste.');
      conversation.agentId = agent.id;
    }
    store.conversations.unshift(conversation); save(); res.json(conversation);
  }));
  router.get('/conversations/:id', route(async (req, res) => {
    const conversation = store.conversations.find(c => c.id === req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation introuvable.' });
    const connection = findConnection(conversation.connectionId);
    let historyError;
    let remoteActive = false;
    if (connection.kind === 'openclaw' && !active.has(conversation.id)) {
      try {
        const history = await clientFor(connection).history(conversation, connection.model);
        // Gateway history is authoritative; keep uncertain local sends visible
        // if nothing has yet been committed remotely.
        if (history.messages.length || !conversation.messages.length) conversation.messages = history.messages;
        remoteActive = history.active;
        save();
      } catch (error) { historyError = error instanceof GatewayError ? error.message : 'Historique distant indisponible.'; }
    }
    const visibleText = new Set(conversation.messages.filter(message => message.role === 'assistant').map(message => message.content));
    const receiptIds = historyError ? [] : inbox.data.items.filter(item => !item.read && item.connectionId === conversation.connectionId &&
      item.sessionKey === conversation.remote?.sessionKey && visibleText.has(item.content)).map(item => item.id);
    res.json({ ...conversation, receiptIds, active: active.has(conversation.id) || remoteActive, ...(historyError ? { historyError } : {}) });
  }));
  router.delete('/conversations/:id', route((req, res) => {
    if (active.has(req.params.id)) throw new Error('Une réponse est encore en cours.');
    store.conversations = store.conversations.filter(c => c.id !== req.params.id);
    save(); res.json({ ok: true });
  }));
  router.get('/conversations/:id/models', route(async (req, res) => {
    const conversation = store.conversations.find(c => c.id === req.params.id);
    if (!conversation) throw new Error('Conversation introuvable.');
    const connection = findConnection(conversation.connectionId);
    if (connection.kind !== 'openclaw') throw new Error('Le sélecteur de modèle est disponible pour OpenClaw.');
    res.json(await clientFor(connection).listModels(conversation, connection.model));
  }));
  router.post('/conversations/:id/messages', route(async (req, res) => {
    const conversation = store.conversations.find(c => c.id === req.params.id);
    if (!conversation) throw new Error('Conversation introuvable.');
    if (conversation.readOnly) throw new Error('Cette conversation est en lecture seule sur OpenClaw.');
    if (active.has(conversation.id)) return res.status(409).json({ error: 'Une réponse est déjà en cours.' });
    const text = String(req.body?.text || '').trim();
    const files = normalizeAttachments(req.body?.attachments);
    if ((!text && !files.length) || text.length > 32000) throw new Error('Le message doit contenir entre 1 et 32 000 caractères, ou une pièce jointe.');
    const connection = findConnection(conversation.connectionId);
    // Each service gets attachments in its own format, checked before anything is recorded.
    let gatewayFiles = [], lastContent = text;
    if (connection.kind === 'openclaw') {
      // Authenticate and restore the server-side session before recording an
      // attempted task. An unapproved device must never reach chat.send.
      const client = clientFor(connection);
      await client.connect();
      if (active.has(conversation.id)) return res.status(409).json({ error: 'Une réponse est déjà en cours.' });
      client.target(conversation, connection.model);
      gatewayFiles = gatewayAttachments(files, client.hello?.policy);
    } else lastContent = completionContent(text, files);
    const headers = connection.kind === 'openclaw' ? null : headersFor(connection);
    const controller = new AbortController();
    active.set(conversation.id, controller);
    const timer = setTimeout(() => controller.abort(), 15 * 60 * 1000);
    const onClose = () => controller.abort();
    res.on('close', onClose);
    const createdAt = new Date().toISOString();
    conversation.updatedAt = Date.now();
    const userMessage = { id: randomUUID(), role: 'user', content: text, status: 'complete', createdAt, ...(files.length ? { attachments: attachmentMeta(files) } : {}) };
    conversation.messages.push(userMessage);
    if (files.length && connection.kind === 'openclaw') rememberSent(conversation, text, userMessage.attachments, Date.parse(createdAt));
    if (conversation.messages.length === 1 && !conversation.isMain && !conversation.contact) conversation.title = (text || files[0]?.fileName || '').slice(0, 65);
    const answer = { id: randomUUID(), role: 'assistant', content: '', status: 'streaming', createdAt };
    conversation.messages.push(answer);
    const emit = (event, data) => { if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    let heartbeat;
    try {
      save();
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      emit('start', { conversationId: conversation.id });
      heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 10000);
      if (connection.kind === 'openclaw') {
        userMessage.idempotencyKey = userMessage.id;
        save();
        await clientFor(connection).send(conversation, connection.model, text, userMessage.idempotencyKey, content => {
          answer.content = content; emit('replace', { text: content });
        }, controller.signal, gatewayFiles);
        answer.status = 'complete'; save(); emit('done', { status: 'complete' });
        return;
      }
      // Earlier attachments are not resent: only the new message carries its files.
      const messages = conversation.messages.filter(m => m.status === 'complete').map(m => ({ role: m.role, content: m === userMessage ? lastContent : m.content }));
      if (connection.kind === 'hermes') {
        headers['X-Hermes-Session-Id'] = `feedme-${conversation.id}`;
        headers['X-Hermes-Session-Key'] = `feedme-${connection.id}`;
        headers['Idempotency-Key'] = userMessage.id;
      }
      const response = await fetchImpl(`${connection.endpoint}/chat/completions`, {
        method: 'POST', headers, redirect: 'error', signal: controller.signal,
        body: JSON.stringify({ model: connection.model, messages, stream: true, user: `feedme-${conversation.id}` }),
      });
      if (!response.ok) throw upstreamError(response.status);
      const append = content => {
        if (typeof content !== 'string') return;
        if (answer.content.length + content.length > 2 * 1024 * 1024) throw new Error('Réponse trop volumineuse.');
        answer.content += content; emit('delta', { text: content });
      };
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        let ended = false;
        for await (const data of readEvents(response.body)) {
          if (data === '[DONE]') { ended = true; break; }
          let chunk;
          try { chunk = JSON.parse(data); } catch { throw new Error('Flux de réponse invalide.'); }
          const choice = chunk.choices?.[0];
          if (chunk.error || ['error', 'cancelled'].includes(choice?.finish_reason)) throw new Error('L’agent a interrompu ou refusé la demande.');
          append(choice?.delta?.content);
          if (choice?.finish_reason === 'length') throw new Error('Réponse tronquée par la limite de l’agent.');
          if (choice?.finish_reason === 'stop') ended = true;
        }
        if (!ended) throw new Error('Connexion interrompue avant la fin de la réponse.');
      } else {
        const data = await response.json();
        if (data.error || ['error', 'cancelled', 'length'].includes(data.choices?.[0]?.finish_reason)) throw new Error('L’agent n’a pas terminé la réponse.');
        append(data.choices?.[0]?.message?.content);
      }
      if (!answer.content) throw new Error('L’agent n’a renvoyé aucun texte.');
      answer.status = 'complete'; save(); emit('done', { status: answer.status });
    } catch (error) {
      answer.status = controller.signal.aborted || error.code === 'INTERRUPTED' ? 'interrupted' : 'failed';
      const message = controller.signal.aborted ? 'Réception arrêtée. L’agent distant peut continuer ses actions.'
        : /fetch|network|connect/i.test(error.message) ? 'Connexion au serveur perdue ou inaccessible.' : error.message;
      answer.error = message;
      save(); emit('error', { message });
    } finally {
      clearTimeout(timer); clearInterval(heartbeat); active.delete(conversation.id);
      res.off('close', onClose); res.end();
    }
  }));
  // Only already approved devices reconnect automatically at launch.
  router.usageConnections = () => store.connections.filter(c => c.kind === 'openclaw').map(c => ({ id: c.id, name: c.name, connected: clients.get(c.id)?.info().state === 'connected' }));
  router.readUsage = async id => {
    const connection = findConnection(id);
    if (connection.kind !== 'openclaw') throw new Error('Choisissez une connexion OpenClaw.');
    const client = clientFor(connection); await client.connect();
    if (!client.hello?.features?.methods?.includes('usage.status')) throw new Error('Cette passerelle ne propose pas le suivi des quotas.');
    return client.rpc('usage.status', {});
  };
  if (secretStorage) for (const connection of store.connections.filter(c => c.kind === 'openclaw' && vault.info(c.endpoint).paired)) inbox.start(connection, clientFor(connection));
  router.close = () => { inbox.close(); for (const client of clients.values()) client.close(); };
  return router;
}

module.exports = { createAgentRouter, normalizeEndpoint, readEvents };
