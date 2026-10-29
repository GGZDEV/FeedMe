'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { stripMediaRefs, restoreAttachments } = require('./agent-attachments');

const SCOPES = ['operator.read', 'operator.write'];
const CLIENT = { id: 'webchat', displayName: 'FeedMe', version: '1.1.0', platform: process.platform, deviceFamily: 'desktop', mode: 'ui' };
const MAX_TEXT = 2 * 1024 * 1024;

function normalizeGatewayEndpoint(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error('Adresse WebSocket invalide.'); }
  // Also migrates the old, unused HTTP preset. OpenClaw never uses /v1 here.
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (!['wss:', 'ws:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Utilisez une adresse wss:// sans identifiants ni paramètres.');
  if (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Une passerelle distante exige wss://.');
  url.pathname = url.pathname.replace(/\/v1(?:\/chat\/completions)?\/?$/, '/');
  return url.href.replace(/\/$/, '');
}

function deviceProof(identity, nonce, signedAt, scopes, token = '') {
  const payload = ['v3', identity.id, CLIENT.id, CLIENT.mode, 'operator', scopes.join(','), String(signedAt), token, nonce, CLIENT.platform.toLowerCase(), CLIENT.deviceFamily].join('|');
  return {
    id: identity.id, publicKey: identity.publicKey, nonce, signedAt,
    signature: crypto.sign(null, Buffer.from(payload), identity.privateKey).toString('base64url'),
  };
}

class DeviceVault {
  constructor(dataDir, codec) {
    this.file = path.join(dataDir, 'openclaw-device.json');
    this.codec = codec;
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { version: 1, grants: {} };
  }
  save() {
    const temp = this.file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
  identity() {
    if (!this.codec) throw new GatewayError('SECURE_STORAGE_REQUIRED');
    try {
      if (!this.data.identity) {
        const keys = crypto.generateKeyPairSync('ed25519');
        const publicKey = keys.publicKey.export({ format: 'jwk' }).x;
        this.data.identity = {
          id: crypto.createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex'), publicKey,
          privateKey: this.codec.encrypt(keys.privateKey.export({ type: 'pkcs8', format: 'pem' })),
        };
        this.save();
      }
      const identity = this.data.identity;
      const privateKey = crypto.createPrivateKey(this.codec.decrypt(identity.privateKey));
      const publicKey = crypto.createPublicKey(privateKey).export({ format: 'jwk' }).x;
      const id = crypto.createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex');
      if (id !== identity.id || publicKey !== identity.publicKey) throw new Error('Invalid identity');
      return { id, publicKey, privateKey };
    } catch { throw new GatewayError('DEVICE_STORAGE_ERROR'); }
  }
  grant(endpoint) {
    const record = this.data.grants[endpoint];
    if (!record) return null;
    try { return { ...record, token: this.codec.decrypt(record.token) }; }
    catch { throw new GatewayError('DEVICE_STORAGE_ERROR'); }
  }
  remember(endpoint, token, scopes, protocol) {
    const previous = this.grant(endpoint);
    const grantScopes = previous?.token === token ? previous.scopes : scopes;
    this.data.grants[endpoint] = { token: this.codec.encrypt(token), scopes: grantScopes, protocol, clientId: CLIENT.id, role: 'operator' };
    this.save();
  }
  clearGrant(endpoint) { delete this.data.grants[endpoint]; this.save(); }
  info(endpoint) { return { deviceId: this.data.identity?.id, paired: !!this.data.grants[endpoint] }; }
}

const ERROR_MESSAGES = {
  PAIRING_REQUIRED: 'Approbation requise : faites approuver l’appareil « FeedMe » côté OpenClaw, puis cliquez sur Vérifier l’approbation.',
  PASSWORD_REQUIRED: 'Saisissez le mot de passe de la passerelle dans FeedMe, puis enregistrez et connectez-vous.',
  AUTH_FAILED: 'Authentification refusée. Vérifiez le mot de passe ou l’approbation de cet appareil.',
  SECURE_STORAGE_REQUIRED: 'Utilisez la version bureau de FeedMe : le stockage sécurisé est requis pour conserver l’identité de l’appareil.',
  DEVICE_STORAGE_ERROR: 'Le stockage sécurisé de l’appareil est illisible. La clé existante est conservée ; aucune nouvelle identité n’a été créée.',
  PROTOCOL_ERROR: 'Réponse WebSocket invalide ou version de protocole incompatible.',
  DISCONNECTED: 'Connexion à OpenClaw interrompue. La tâche distante peut continuer ; elle ne sera pas renvoyée automatiquement.',
  TIMEOUT: 'La passerelle ne répond pas. Vérifiez la connexion puis actualisez l’historique.',
  RPC_REFUSED: 'La passerelle a refusé cette opération. Vérifiez les droits de l’appareil dans OpenClaw.',
  RUN_FAILED: 'L’agent a signalé un échec. Actualisez l’historique pour consulter le résultat conservé sur la passerelle.',
  INTERRUPTED: 'Réception arrêtée. La tâche distante peut continuer ; actualisez l’historique avant de renvoyer une demande.',
};
class GatewayError extends Error {
  constructor(code, requestId) {
    super(ERROR_MESSAGES[code] || ERROR_MESSAGES.RPC_REFUSED);
    this.code = code;
    if (typeof requestId === 'string' && /^[\w-]{1,200}$/.test(requestId)) this.requestId = requestId;
  }
}
function remoteError(error) {
  const code = error?.details?.code || error?.code;
  if (code === 'PAIRING_REQUIRED' || error?.code === 'NOT_PAIRED') return new GatewayError('PAIRING_REQUIRED', error?.details?.requestId);
  if (String(code).startsWith('AUTH_') || code === 'DEVICE_AUTH_INVALID' || code === 'DEVICE_IDENTITY_REQUIRED') return new GatewayError('AUTH_FAILED');
  if (code === 'PROTOCOL_MISMATCH') return new GatewayError('PROTOCOL_ERROR');
  // Never surface raw frames, remote error text, passwords or device tokens.
  return new GatewayError('RPC_REFUSED');
}
function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) return message.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
  return '';
}

class OpenClawClient extends EventEmitter {
  constructor({ endpoint, vault, password, WebSocketImpl = WebSocket }) {
    super();
    this.endpoint = normalizeGatewayEndpoint(endpoint);
    this.vault = vault;
    this.password = password;
    this.WebSocketImpl = WebSocketImpl;
    this.pending = new Map();
    this.state = { state: 'disconnected' };
    this.hello = null;
    this.socket = null;
    this.connecting = null;
    this.lastSeq = null;
  }
  info() { return { ...this.vault.info(this.endpoint), ...this.state }; }
  setState(state, extras = {}) { this.state = { state, ...extras }; this.emit('status', this.info()); }
  async connect() {
    if (this.state.state === 'connected') return this.info();
    if (this.connecting) return this.connecting;
    this.connecting = this.open();
    try { return await this.connecting; }
    finally { this.connecting = null; }
  }
  async open() {
    const identity = this.vault.identity();
    const grant = this.vault.grant(this.endpoint);
    const password = grant ? '' : this.password();
    if (!grant && !password) throw new GatewayError('PASSWORD_REQUIRED');
    const scopes = grant?.scopes || SCOPES;
    if (scopes.some(scope => !SCOPES.includes(scope))) throw new GatewayError('AUTH_FAILED');
    this.setState('connecting');
    this.lastSeq = null;
    return new Promise((resolve, reject) => {
      const socket = new this.WebSocketImpl(this.endpoint);
      this.socket = socket;
      let challenged = false;
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true; clearTimeout(watchdog);
        if (error) {
          this.setState(error.code === 'PAIRING_REQUIRED' ? 'awaiting_approval' : 'error', { message: error.message, ...(error.requestId ? { requestId: error.requestId } : {}) });
          reject(error); socket.close();
        } else resolve(this.info());
      };
      const watchdog = setTimeout(() => finish(new GatewayError('TIMEOUT')), 35000);
      socket.addEventListener('message', async event => {
        if (this.socket !== socket) return;
        let frame;
        try {
          if (typeof event.data !== 'string' || event.data.length > 8 * 1024 * 1024) throw new Error();
          frame = JSON.parse(event.data);
        } catch { if (!settled) finish(new GatewayError('PROTOCOL_ERROR')); else this.close(); return; }
        if (frame.type === 'res') {
          const request = this.pending.get(frame.id);
          if (!request) return;
          this.pending.delete(frame.id); clearTimeout(request.timer);
          if (frame.ok === true) request.resolve(frame.payload);
          else request.reject(remoteError(frame.error));
          return;
        }
        if (frame.type !== 'event') return;
        if (frame.event === 'connect.challenge' && !challenged && !settled) {
          challenged = true;
          const challenge = frame.payload;
          if (typeof challenge?.nonce !== 'string' || !challenge.nonce || !Number.isSafeInteger(challenge.ts) || challenge.ts < 0) return finish(new GatewayError('PROTOCOL_ERROR'));
          try {
            const auth = grant ? (grant.protocol === 3 ? { token: grant.token } : { deviceToken: grant.token }) : { password };
            const hello = await this.requestFrame('connect', {
              minProtocol: 3, maxProtocol: 4, client: CLIENT, role: 'operator', scopes,
              caps: ['chat-only-assistant-text', 'hello-health-on-demand'],
              auth, device: deviceProof(identity, challenge.nonce, challenge.ts, scopes, grant?.token || ''),
              locale: 'fr-FR', userAgent: 'FeedMe/1.1.0',
            });
            if (hello?.type !== 'hello-ok' || ![3, 4].includes(hello.protocol) || !Array.isArray(hello.auth?.scopes) || hello.auth.role !== 'operator') throw new GatewayError('PROTOCOL_ERROR');
            if (!SCOPES.every(scope => hello.auth.scopes.includes(scope)) || hello.auth.scopes.some(scope => !SCOPES.includes(scope))) throw new GatewayError('AUTH_FAILED');
            // A password-only admission without a device grant is insufficient.
            if (!grant && (typeof hello.auth.deviceToken !== 'string' || !hello.auth.deviceToken)) throw new GatewayError('AUTH_FAILED');
            if (hello.auth.deviceToken) this.vault.remember(this.endpoint, hello.auth.deviceToken, hello.auth.scopes, hello.protocol);
            this.hello = hello;
            this.setState('connected'); finish();
          } catch (error) { finish(error instanceof GatewayError ? error : new GatewayError('DEVICE_STORAGE_ERROR')); }
          return;
        }
        if (this.state.state !== 'connected') return;
        if (Number.isSafeInteger(frame.seq) && this.lastSeq !== null && frame.seq <= this.lastSeq) return;
        const gap = Number.isSafeInteger(frame.seq) && this.lastSeq !== null && frame.seq > this.lastSeq + 1;
        if (Number.isSafeInteger(frame.seq)) this.lastSeq = frame.seq;
        // Terminal snapshots settle their run before retiring a gapped socket.
        if (gap && !(frame.event === 'chat' && ['final', 'aborted', 'error'].includes(frame.payload?.state))) { this.close(); return; }
        this.emit('gatewayEvent', frame);
        if (gap) this.close();
      });
      const disconnect = () => {
        for (const [id, request] of this.pending) {
          if (request.socket !== socket) continue;
          clearTimeout(request.timer); request.reject(new GatewayError('DISCONNECTED')); this.pending.delete(id);
        }
        if (this.socket === socket) {
          this.socket = null; this.hello = null;
          if (this.state.state === 'connected') this.setState('disconnected');
          this.emit('disconnect');
        }
        if (!settled) finish(new GatewayError('DISCONNECTED'));
      };
      socket.addEventListener('close', disconnect, { once: true });
      socket.addEventListener('error', () => { if (!settled) finish(new GatewayError('DISCONNECTED')); else this.close(); });
    });
  }
  requestFrame(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== 1) return reject(new GatewayError('DISCONNECTED'));
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); reject(new GatewayError('TIMEOUT')); }, 30000);
      this.pending.set(id, { resolve, reject, timer, socket: this.socket });
      try { this.socket.send(JSON.stringify({ type: 'req', id, method, params })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new GatewayError('DISCONNECTED')); }
    });
  }
  async rpc(method, params) {
    if (!['agents.list', 'models.list', 'chat.history', 'chat.send', 'chat.message.get', 'sessions.list', 'sessions.subscribe', 'usage.status'].includes(method)) throw new GatewayError('RPC_REFUSED');
    await this.connect();
    return this.requestFrame(method, params);
  }
  async listAgents() {
    const result = await this.rpc('agents.list', {});
    if (!Array.isArray(result?.agents)) throw new GatewayError('PROTOCOL_ERROR');
    this.catalog = {
      defaultId: result.defaultId || this.hello?.snapshot?.sessionDefaults?.defaultAgentId,
      agents: result.agents.filter(agent => typeof agent?.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(agent.id)).map(agent => ({
        id: agent.id, name: String(agent.name || agent.identity?.name || agent.id).slice(0, 160),
        ...(typeof agent.identity?.emoji === 'string' ? { emoji: agent.identity.emoji.slice(0, 32) } : {}),
      })),
    };
    return this.catalog;
  }
  async listModels(conversation, agent) {
    await this.connect();
    const { sessionKey } = this.target(conversation, agent);
    const result = await this.rpc('models.list', {});
    if (!Array.isArray(result?.models)) throw new GatewayError('PROTOCOL_ERROR');
    const models = result.models.filter(m => typeof m?.id === 'string' && typeof m?.provider === 'string')
      .map(m => ({ id: `${m.provider}/${m.id}`, name: String(m.name || m.id).slice(0, 160), provider: m.provider }))
      .filter(m => /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,299}$/.test(m.id));
    let current = '';
    try {
      const page = await this.rpc('sessions.list', { agentId: conversation.remote.agentId, limit: 100 });
      const row = page.sessions?.find(row => row.key === sessionKey);
      if (row?.model) current = row.modelProvider && !row.model.startsWith(row.modelProvider + '/') ? `${row.modelProvider}/${row.model}` : row.model;
    } catch { /* The catalogue remains usable when session metadata is unavailable. */ }
    return { models: [...new Map(models.map(m => [m.id, m])).values()], current };
  }
  target(conversation, model) {
    if (!conversation.remote) {
      const requested = conversation.agentId || model;
      const agentId = !requested || ['default', 'openclaw'].includes(requested) ? this.hello?.snapshot?.sessionDefaults?.defaultAgentId || 'main' : requested.replace(/^openclaw[/:]/, '');
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(agentId)) throw new GatewayError('RPC_REFUSED');
      conversation.remote = { agentId, sessionKey: `agent:${agentId}:feedme:${conversation.id}` };
    }
    if (conversation.agentId && conversation.agentId !== conversation.remote.agentId) throw new GatewayError('RPC_REFUSED');
    return { sessionKey: conversation.remote.sessionKey, ...(conversation.remote.sessionId ? { sessionId: conversation.remote.sessionId } : {}) };
  }
  async history(conversation, model) {
    await this.connect();
    // History is a read of the current session behind the stable key. Some
    // released v4 gateways explicitly reject a pinned sessionId on this RPC.
    const { sessionKey } = this.target(conversation, model);
    const history = await this.rpc('chat.history', { sessionKey, limit: 100 });
    if (typeof history.sessionId === 'string') conversation.remote.sessionId = history.sessionId;
    const messages = [];
    for (const item of history.messages || []) {
      if (!['user', 'assistant'].includes(item?.role)) continue;
      const id = item.id || item.messageId || item.__openclaw?.id || item.__openclaw?.messageId;
      // Attached files show up as media:// references in the user's text; the
      // attachment chips replace them on screen.
      const content = (item.role === 'user' ? stripMediaRefs(messageText(item)) : messageText(item)).slice(0, MAX_TEXT);
      // An image sent alone has no text but is still a user message.
      const mediaOnly = item.role === 'user' && Array.isArray(item.content) && item.content.some(part => part && part.type && part.type !== 'text');
      // Tool calls/results and reasoning blocks can use user/assistant roles.
      // They belong to execution history, not to empty conversation bubbles.
      if ((!content.trim() && !mediaOnly) || /^(NO_REPLY|HEARTBEAT_OK)$/i.test(content.trim())) continue;
      messages.push({ ...(typeof id === 'string' ? { id } : {}), role: item.role, content, status: 'complete', ...(item.timestamp ? { timestamp: item.timestamp } : {}) });
    }
    restoreAttachments(messages, conversation.sentAttachments);
    // A media-only message nobody can attribute would be an empty bubble.
    for (let i = messages.length - 1; i >= 0; i--) if (!messages[i].content.trim() && !messages[i].attachments) messages.splice(i, 1);
    const lastAssistant = messages.findLast(message => message.role === 'assistant' && message.id);
    if (lastAssistant && this.hello?.features?.methods?.includes('chat.message.get')) {
      const full = await this.rpc('chat.message.get', { sessionKey, messageId: lastAssistant.id, maxChars: 500000 });
      if (full.ok && full.message && messageText(full.message).trim()) lastAssistant.content = messageText(full.message).slice(0, MAX_TEXT);
    }
    if (history.inFlightRun?.text?.trim() && messages.at(-1)?.content !== history.inFlightRun.text) messages.push({ role: 'assistant', content: history.inFlightRun.text.slice(0, MAX_TEXT), status: 'streaming' });
    return { messages, active: !!history.inFlightRun, nextOffset: history.nextOffset };
  }
  // `attachments` is already in the chat.send format (see agent-attachments.js).
  async send(conversation, model, text, idempotencyKey, onText, signal, attachments = []) {
    await this.connect();
    if (signal.aborted) throw new GatewayError('INTERRUPTED');
    const target = this.target(conversation, model);
    const runIds = new Set([idempotencyKey]);
    const queuedEvents = [];
    let acknowledged = false;
    let settled = false;
    let content = '';
    let resolveRun, rejectRun;
    const outcome = new Promise((resolve, reject) => { resolveRun = resolve; rejectRun = reject; });
    const fail = error => { if (!settled) { settled = true; rejectRun(error); } };
    const consume = frame => {
      const payload = frame.payload;
      if (frame.event !== 'chat' || payload?.sessionKey !== target.sessionKey) return;
      if (!acknowledged) { if (queuedEvents.length < 1000) queuedEvents.push(frame); return; }
      if (!runIds.has(payload.runId) || settled) return;
      if (payload.state === 'delta') {
        content = typeof payload.deltaText === 'string' ? (payload.replace ? payload.deltaText : content + payload.deltaText) : messageText(payload.message);
        if (content.length > MAX_TEXT) return fail(new GatewayError('PROTOCOL_ERROR'));
        onText(content);
      } else if (['final', 'aborted', 'error'].includes(payload.state)) {
        if (payload.message && messageText(payload.message).trim()) { content = messageText(payload.message); onText(content.slice(0, MAX_TEXT)); }
        if (payload.state !== 'final') return fail(new GatewayError(payload.state === 'aborted' ? 'INTERRUPTED' : 'RUN_FAILED'));
        settled = true; resolveRun(content);
      }
    };
    const disconnect = () => fail(new GatewayError('DISCONNECTED'));
    const abort = () => fail(new GatewayError('INTERRUPTED'));
    this.on('gatewayEvent', consume); this.on('disconnect', disconnect);
    signal.addEventListener('abort', abort, { once: true });
    // Mark the task durable before attempting the send. The router saves this
    // identity first; reconnects only read history and never invent a new send.
    try {
      const acknowledgement = this.rpc('chat.send', { ...target, message: text, idempotencyKey, deliver: false, ...(attachments.length ? { attachments } : {}) });
      acknowledgement.then(result => {
        if (typeof result?.runId === 'string') { runIds.add(result.runId); conversation.remote.runId = result.runId; }
        acknowledged = true;
        for (const event of queuedEvents) consume(event);
      }, fail);
      return await outcome;
    } finally {
      this.off('gatewayEvent', consume); this.off('disconnect', disconnect);
      signal.removeEventListener('abort', abort);
    }
  }
  close() {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null; this.hello = null;
    for (const [id, request] of this.pending) {
      if (request.socket !== socket) continue;
      clearTimeout(request.timer); request.reject(new GatewayError('DISCONNECTED')); this.pending.delete(id);
    }
    if (this.state.state === 'connected') this.setState('disconnected');
    this.emit('disconnect'); socket.close();
  }
}

module.exports = { OpenClawClient, DeviceVault, GatewayError, normalizeGatewayEndpoint, deviceProof, messageText, SCOPES, CLIENT };
