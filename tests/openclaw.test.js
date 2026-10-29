'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { OpenClawClient, DeviceVault, normalizeGatewayEndpoint, CLIENT, SCOPES } = require('../openclaw');
const { createAgentRouter } = require('../agents');

function vaultFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedme-ws-'));
  const key = crypto.randomBytes(32);
  const codec = {
    encrypt(text) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
    },
    decrypt(text) {
      const bytes = Buffer.from(text, 'base64'), decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString();
    },
  };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, codec, vault: new DeviceVault(dir, codec) };
}

function gateway({ paired = true, timestamp = Date.now(), handler, omitDeviceToken = false } = {}) {
  const frames = [];
  const sockets = [];
  let approved = paired;
  class Socket extends EventTarget {
    constructor(url) {
      super(); this.url = url; this.readyState = 0; sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.event('connect.challenge', { nonce: 'nonce-' + sockets.length, ts: timestamp }); });
    }
    frame(frame) { if (this.readyState === 1) this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) })); }
    event(event, payload, seq) { this.frame({ type: 'event', event, payload, ...(seq ? { seq } : {}) }); }
    reply(req, payload) { this.frame({ type: 'res', id: req.id, ok: true, payload }); }
    send(text) {
      const frame = JSON.parse(text); frames.push(frame);
      queueMicrotask(() => {
        if (frame.method === 'connect') {
          if (!approved) return this.frame({ type: 'res', id: frame.id, ok: false, error: { code: 'NOT_PAIRED', message: 'must not leak secret', details: { code: 'PAIRING_REQUIRED', requestId: 'pair-request-123' } } });
          return this.reply(frame, { type: 'hello-ok', protocol: 4, auth: { role: 'operator', scopes: [...SCOPES], ...(omitDeviceToken ? {} : { deviceToken: 'minted-device-token' }) }, snapshot: { sessionDefaults: { defaultAgentId: 'main' } }, features: { methods: ['chat.history', 'chat.send', 'chat.message.get'] } });
        }
        handler?.(frame, this);
      });
    }
    close() { if (this.readyState === 3) return; this.readyState = 3; queueMicrotask(() => this.dispatchEvent(new Event('close'))); }
  }
  return { Socket, frames, sockets, approve: () => { approved = true; } };
}
function makeClient(t, options) {
  const f = vaultFixture(t);
  const g = gateway(options);
  const client = new OpenClawClient({ endpoint: 'wss://gateway.example.test', vault: f.vault, password: () => ' password with spaces ', WebSocketImpl: g.Socket });
  t.after(() => client.close());
  return { ...f, ...g, client };
}

test('OpenClaw normalizes only secure WS endpoints and removes the obsolete /v1 preset', () => {
  assert.equal(normalizeGatewayEndpoint('https://host.test/v1'), 'wss://host.test');
  assert.equal(normalizeGatewayEndpoint('wss://host.test/'), 'wss://host.test');
  assert.equal(normalizeGatewayEndpoint('http://localhost:18789'), 'ws://localhost:18789');
  for (const value of ['ws://remote.test', 'wss://user:pass@host.test', 'wss://host.test?password=bad', 'file:///test']) assert.throws(() => normalizeGatewayEndpoint(value));
});

test('signs the actual nonce and server timestamp with a persistent Ed25519 identity', async t => {
  const f = makeClient(t);
  await f.client.connect();
  const params = f.frames[0].params;
  assert.equal(f.frames[0].method, 'connect');
  assert.equal(params.auth.password, ' password with spaces ');
  assert.equal(params.client.displayName, 'FeedMe');
  assert.deepEqual(params.scopes, ['operator.read', 'operator.write']);
  const id = crypto.createHash('sha256').update(Buffer.from(params.device.publicKey, 'base64url')).digest('hex');
  assert.equal(id, params.device.id);
  const proof = ['v3', id, CLIENT.id, CLIENT.mode, 'operator', params.scopes.join(','), String(params.device.signedAt), '', params.device.nonce, CLIENT.platform.toLowerCase(), 'desktop'].join('|');
  const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: params.device.publicKey }, format: 'jwk' });
  assert.equal(crypto.verify(null, Buffer.from(proof), key, Buffer.from(params.device.signature, 'base64url')), true);
  assert.equal(crypto.verify(null, Buffer.from(proof.replace(params.device.nonce, 'wrong-nonce')), key, Buffer.from(params.device.signature, 'base64url')), false);
  const bytes = fs.readFileSync(f.vault.file, 'utf8');
  assert.ok(!bytes.includes('PRIVATE KEY'));
  assert.ok(!bytes.includes('minted-device-token'));
  assert.ok(!bytes.includes('password with spaces'));
  const reloaded = new DeviceVault(f.dir, f.codec);
  assert.equal(reloaded.identity().id, id);
  assert.equal(reloaded.grant(f.client.endpoint).token, 'minted-device-token');
});

test('pairing remains pending until approval and the next handshake uses the remembered device grant', async t => {
  const f = makeClient(t, { paired: false });
  await assert.rejects(f.client.connect(), error => error.code === 'PAIRING_REQUIRED' && error.requestId === 'pair-request-123');
  assert.equal(f.client.info().state, 'awaiting_approval');
  assert.deepEqual(f.frames.map(f => f.method), ['connect']);
  f.approve();
  await f.client.connect();
  const id = f.client.info().deviceId;
  f.client.close();
  await new Promise(resolve => setImmediate(resolve));
  await f.client.connect();
  const auth = f.frames.at(-1).params.auth;
  assert.equal(auth.password, undefined);
  assert.equal(auth.deviceToken, 'minted-device-token');
  assert.equal(f.frames.at(-1).params.device.id, id);
  assert.ok(!JSON.stringify(f.client.info()).includes('minted-device-token'));
});

test('rejects malformed challenges without emitting a connect frame or credentials', async t => {
  const f = makeClient(t, { timestamp: 'invalid' });
  await assert.rejects(f.client.connect(), error => error.code === 'PROTOCOL_ERROR');
  assert.equal(f.frames.length, 0);
});

test('refuses a password-only admission without an issued device grant', async t => {
  const f = makeClient(t, { omitDeviceToken: true });
  await assert.rejects(f.client.connect(), error => error.code === 'AUTH_FAILED');
  assert.notEqual(f.client.info().state, 'connected');
  assert.equal(f.vault.info(f.client.endpoint).paired, false);
});

test('requires encrypted identity persistence and does not silently replace an unreadable key', async t => {
  const f = vaultFixture(t);
  assert.throws(() => new DeviceVault(f.dir, null).identity(), error => error.code === 'SECURE_STORAGE_REQUIRED');
  const id = f.vault.identity().id;
  const broken = new DeviceVault(f.dir, { decrypt() { throw new Error('bad'); } });
  assert.throws(() => broken.identity(), error => error.code === 'DEVICE_STORAGE_ERROR');
  assert.equal(new DeviceVault(f.dir, f.codec).identity().id, id);
});

test('chat.send uses a durable idempotency key and consumes same-socket snapshots, replacements and append deltas', async t => {
  const f = makeClient(t, { handler(req, socket) {
    if (req.method !== 'chat.send') return;
    // Events can beat the acknowledgement; unrelated runs must be ignored.
    socket.event('chat', { sessionKey: req.params.sessionKey, runId: 'run-1', state: 'delta', deltaText: 'Bon' });
    socket.reply(req, { runId: 'run-1', status: 'started' });
    socket.event('chat', { sessionKey: req.params.sessionKey, runId: 'unrelated', state: 'final', message: { content: 'wrong' } });
    socket.event('chat', { sessionKey: req.params.sessionKey, runId: 'run-1', state: 'delta', deltaText: 'jour' });
    socket.event('chat', { sessionKey: req.params.sessionKey, runId: 'run-1', state: 'delta', deltaText: 'Salut', replace: true });
    socket.event('chat', { sessionKey: req.params.sessionKey, runId: 'run-1', state: 'final', message: { content: [{ type: 'text', text: 'Salut 👋' }] } });
  } });
  const conversation = { id: crypto.randomUUID() }, texts = [];
  const result = await f.client.send(conversation, 'default', 'Bonjour', 'message-id-123', value => texts.push(value), new AbortController().signal);
  assert.equal(result, 'Salut 👋');
  assert.deepEqual(texts, ['Bon', 'Bonjour', 'Salut', 'Salut 👋']);
  const send = f.frames.find(frame => frame.method === 'chat.send');
  assert.equal(send.params.idempotencyKey, 'message-id-123');
  assert.equal(send.params.sessionKey, `agent:main:feedme:${conversation.id}`);
  assert.equal(f.sockets.length, 1);
});

test('history resumes the actual gateway session and fetches a complete message via chat.message.get', async t => {
  const f = makeClient(t, { handler(req, socket) {
    if (req.method === 'chat.history') socket.reply(req, { sessionId: 'real-session', messages: [{ id: 'm1', role: 'assistant', content: 'preview' }] });
    if (req.method === 'chat.message.get') socket.reply(req, { ok: true, message: { content: [{ type: 'text', text: 'Full remote message' }] } });
  } });
  const conversation = { id: crypto.randomUUID() };
  const history = await f.client.history(conversation, 'research');
  assert.equal(history.messages[0].content, 'Full remote message');
  assert.equal(conversation.remote.sessionId, 'real-session');
  const request = f.frames.find(f => f.method === 'chat.message.get');
  assert.equal(request.params.messageId, 'm1');
  assert.equal(request.params.sessionId, undefined);
  assert.equal(f.frames.find(frame => frame.method === 'chat.history').params.sessionId, undefined);
  assert.match(request.params.sessionKey, /^agent:research:feedme:/);
});

test('technical tool and reasoning messages do not become empty chat bubbles', async t => {
  const f = makeClient(t, { handler(req, socket) {
    if (req.method === 'chat.history') socket.reply(req, { messages: [
      { role: 'user', content: 'Ça marche ?' },
      { role: 'assistant', content: [{ type: 'toolcall', id: 'call-1', name: 'terminal' }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'internal result' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'private reasoning' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Oui, ça marche.' }] },
      { role: 'assistant', content: '   ' },
    ] });
  } });
  const history = await f.client.history({ id: 'test', remote: { agentId: 'main', sessionKey: 'agent:main:feedme:test', sessionId: 'old-session' } }, 'default');
  assert.deepEqual(history.messages.map(m => [m.role, m.content]), [['user', 'Ça marche ?'], ['assistant', 'Oui, ça marche.']]);
  assert.equal(JSON.stringify(history).includes('private reasoning'), false);
});

test('agent selection uses the live catalogue and permanently binds a thread to its agent', async t => {
  const f = makeClient(t, { handler(req, socket) {
    if (req.method === 'agents.list') socket.reply(req, { defaultId: 'main', agents: [
      { id: 'main', name: 'Home', workspace: '/private/unused' },
      { id: 'scholar', identity: { name: 'Research', emoji: '🔬' }, model: { primary: 'private/model' } },
    ] });
  } });
  const catalog = await f.client.listAgents();
  assert.deepEqual(catalog, { defaultId: 'main', agents: [{ id: 'main', name: 'Home' }, { id: 'scholar', name: 'Research', emoji: '🔬' }] });
  const conversation = { id: 'thread', agentId: 'scholar' };
  assert.equal(f.client.target(conversation, 'default').sessionKey, 'agent:scholar:feedme:thread');
  conversation.agentId = 'main';
  assert.throws(() => f.client.target(conversation, 'default'));
  assert.deepEqual(f.frames.map(frame => frame.method), ['connect', 'agents.list']);
});

test('model catalogue reads the current session and switching uses a chat command in the same session', async t => {
  const f = makeClient(t, { handler(req, socket) {
    if (req.method === 'models.list') socket.reply(req, { models: [
      { provider: 'anthropic', id: 'claude-opus', name: 'Opus' },
      { provider: 'openai', id: 'gpt-test', name: 'GPT' },
      { provider: 'openai', id: 'gpt-test', name: 'GPT' },
      { provider: 'bad', id: 'id\n/reset' }, { id: 'missing-provider' },
    ] });
    if (req.method === 'sessions.list') socket.reply(req, { sessions: [{ key: 'agent:main:main', modelProvider: 'anthropic', model: 'claude-opus' }] });
    if (req.method === 'chat.send') {
      socket.reply(req, { runId: req.params.idempotencyKey });
      socket.event('chat', { sessionKey: req.params.sessionKey, runId: req.params.idempotencyKey, state: 'final', message: { content: 'Model set to openai/gpt-test.' } });
    }
  } });
  const conversation = { id: 'home', agentId: 'main', remote: { agentId: 'main', sessionKey: 'agent:main:main', sessionId: 'native-session' } };
  const catalog = await f.client.listModels(conversation, 'default');
  assert.equal(catalog.current, 'anthropic/claude-opus');
  assert.deepEqual(catalog.models.map(m => m.id), ['anthropic/claude-opus', 'openai/gpt-test']);
  assert.equal(f.frames.filter(f => f.method === 'chat.send').length, 0);
  const result = await f.client.send(conversation, 'default', '/model openai/gpt-test', 'switch-1', () => {}, new AbortController().signal);
  assert.match(result, /Model set/);
  const send = f.frames.find(f => f.method === 'chat.send');
  assert.equal(send.params.message, '/model openai/gpt-test');
  assert.equal(send.params.sessionKey, 'agent:main:main');
  assert.equal(send.params.sessionId, 'native-session');
  assert.equal(send.params.deliver, false);
});

test('connection loss and cancellation do not resend a task', async t => {
  const f = makeClient(t, { handler(req, socket) {
    if (req.method === 'chat.send') { socket.reply(req, { runId: 'one' }); socket.close(); }
  } });
  await assert.rejects(f.client.send({ id: 'thread' }, 'default', 'Do work', 'send-1', () => {}, new AbortController().signal), error => error.code === 'DISCONNECTED');
  await f.client.connect();
  assert.equal(f.frames.filter(f => f.method === 'chat.send').length, 1);
});

test('router migrates HTTP OpenClaw presets, redacts secrets and blocks chat before device approval without any HTTP fallback', async t => {
  const f = vaultFixture(t), g = gateway({ paired: false, handler(req, socket) {
    if (req.method === 'agents.list') socket.reply(req, { defaultId: 'main', agents: [{ id: 'main', name: 'Home' }, { id: 'scholar', name: 'Scholar' }] });
  } });
  const app = express(); app.use(express.json());
  const router = createAgentRouter({ dataDir: f.dir, secretStorage: f.codec, WebSocketImpl: g.Socket, fetchImpl: () => { throw new Error('HTTP forbidden'); } });
  app.use('/api/agents', router);
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(async () => { router.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/api/agents`;
  const call = async (url, body) => {
    const res = await fetch(base + url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    return { status: res.status, body: await res.json() };
  };
  const saved = await call('/connections', { name: 'OpenClaw', kind: 'openclaw', model: 'default', endpoint: 'https://gateway.test/v1', password: 'do-not-leak' });
  assert.equal(saved.body.endpoint, 'wss://gateway.test');
  assert.equal(saved.body.authMode, 'password');
  assert.equal(saved.body.secret, undefined);
  const test = await call(`/connections/${saved.body.id}/test`, {});
  assert.equal(test.body.gateway.state, 'awaiting_approval');
  assert.ok(test.body.gateway.message.includes('FeedMe'));
  const conversation = await call('/conversations', { connectionId: saved.body.id });
  const sent = await call(`/conversations/${conversation.body.id}/messages`, { text: 'must not run' });
  assert.equal(sent.status, 400);
  assert.equal(g.frames.filter(f => f.method === 'chat.send').length, 0);
  assert.ok(!JSON.stringify((await call('/')).body).includes('do-not-leak'));
  assert.ok(!fs.readFileSync(path.join(f.dir, 'agents-store.json'), 'utf8').includes('do-not-leak'));
  g.approve();
  assert.equal((await call(`/connections/${saved.body.id}/test`, {})).body.ok, true);
  const catalog = await call(`/connections/${saved.body.id}/agents`);
  assert.deepEqual(catalog.body.agents.map(a => a.id), ['main', 'scholar']);
  const scholar = await call('/conversations', { connectionId: saved.body.id, agentId: 'scholar' });
  assert.equal(scholar.body.agentId, 'scholar');
  assert.equal((await call('/conversations', { connectionId: saved.body.id, agentId: 'missing' })).status, 400);
  assert.equal(g.frames.filter(f => f.method === 'chat.send').length, 0);
});

test('native messages, unread receipts and replies share one durable gateway conversation', async t => {
  const f = vaultFixture(t);
  const row = { key: 'agent:main:main', agentId: 'main', sessionId: 'native-session', isMain: true, title: 'Home', source: 'telegram', updatedAt: Date.now() };
  fs.writeFileSync(path.join(f.dir, 'agents-store.json'), JSON.stringify({ connections: [{ id: 'vps', kind: 'openclaw', endpoint: 'wss://gateway.test', model: 'default', name: 'VPS', transport: 'gateway-ws', authMode: 'password', secret: f.codec.encrypt('password') }], conversations: [] }));
  fs.writeFileSync(path.join(f.dir, 'agent-inbox.json'), JSON.stringify({ connections: {}, sessions: { 'vps|agent:main:main': { metadata: row, seen: [] }, 'vps|agent:main:cron:private': { metadata: { ...row, key: 'agent:main:cron:private', isMain: false }, seen: [] } }, items: [{ id: 'receipt', connectionId: 'vps', agentId: 'main', sessionKey: row.key, content: 'Les news de 8h', receivedAt: Date.now(), read: false }] }));
  const history = [{ role: 'user', content: 'Mes news chaque matin' }, { role: 'assistant', content: 'Les news de 8h', id: 'news' }];
  const g = gateway({ handler(req, socket) {
    if (req.method === 'agents.list') socket.reply(req, { defaultId: 'main', agents: [{ id: 'main', name: 'Home' }] });
    if (req.method === 'sessions.list') socket.reply(req, { sessions: [row] });
    if (req.method === 'chat.history') socket.reply(req, { sessionId: 'native-session', messages: history });
    if (req.method === 'chat.message.get') socket.reply(req, { ok: true, message: history.at(-1) });
    if (req.method === 'chat.send') {
      socket.reply(req, { runId: req.params.idempotencyKey });
      history.push({ role: 'user', content: req.params.message }, { role: 'assistant', content: 'Voici les détails.' });
      socket.event('chat', { sessionKey: row.key, runId: req.params.idempotencyKey, state: 'final', message: history.at(-1) });
    }
  } });
  const app = express(); app.use(express.json());
  const router = createAgentRouter({ dataDir: f.dir, secretStorage: f.codec, WebSocketImpl: g.Socket }); app.use('/api/agents', router);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { router.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/api/agents`;
  const call = async (url, body) => { const res = await fetch(base + url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}); return { status: res.status, body: await res.json() }; };
  const listed = (await call('/')).body.conversations;
  assert.equal(listed.length, 1); assert.equal(listed[0].unread, 1); assert.equal(listed[0].preview, 'Les news de 8h');
  const first = (await call('/threads/open', { connectionId: 'vps', agentId: 'main' })).body;
  const second = (await call('/threads/open', { connectionId: 'vps', agentId: 'main' })).body;
  assert.equal(first.id, listed[0].id); assert.equal(first.id, second.id); assert.equal(first.remote.sessionKey, row.key);
  const opened = (await call('/conversations/' + first.id)).body;
  assert.deepEqual(opened.receiptIds, ['receipt']);
  await call('/conversations/' + first.id + '/read', { ids: ['receipt', 'unrelated'] });
  assert.equal((await call('/')).body.conversations[0].unread, 0);
  const response = await fetch(base + '/conversations/' + first.id + '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Explique la deuxième actualité.' }) });
  assert.ok((await response.text()).includes('event: done'));
  const send = g.frames.find(frame => frame.method === 'chat.send');
  assert.equal(send.params.sessionKey, row.key); assert.equal(send.params.sessionId, 'native-session');
  assert.equal(send.params.message, 'Explique la deuxième actualité.'); assert.equal(send.params.deliver, false);
  assert.equal((await call('/')).body.conversations.length, 1);
  assert.equal((await call('/threads/open', { connectionId: 'vps', agentId: 'main', sessionKey: 'agent:other:main' })).status, 400);
  assert.equal((await call('/threads/open', { connectionId: 'vps', agentId: 'main', sessionKey: 'agent:main:cron:private' })).status, 400);
});

test('attachments reach chat.send and stay attached to the user message in gateway history', async t => {
  const f = makeClient(t, { handler(req, socket) {
    if (req.method === 'chat.send') {
      socket.reply(req, { runId: 'run-a' });
      socket.event('chat', { sessionKey: req.params.sessionKey, runId: 'run-a', state: 'final', message: { content: 'Bien reçu.' } });
    }
    if (req.method === 'chat.history') socket.reply(req, { messages: [
      { role: 'user', content: [{ type: 'text', text: 'Voici le fichier\nmedia://inbound/abc' }], timestamp: Date.now() },
      { role: 'user', content: [{ type: 'image', mimeType: 'image/png' }], timestamp: Date.now() },
      { role: 'user', content: [{ type: 'image', mimeType: 'image/png' }], timestamp: Date.now() - 3600e3 },
      { role: 'assistant', content: 'Bien reçu.' },
    ] });
  } });
  const conversation = { id: crypto.randomUUID() };
  const files = [{ type: 'file', mimeType: 'application/pdf', fileName: 'a.pdf', content: 'JVBERg==', sizeBytes: 4, origin: 'file' }];
  await f.client.send(conversation, 'default', 'Voici le fichier', 'k1', () => {}, new AbortController().signal, files);
  assert.deepEqual(f.frames.find(frame => frame.method === 'chat.send').params.attachments, files);
  conversation.sentAttachments = [{ text: 'Voici le fichier', at: Date.now(), attachments: [{ name: 'a.pdf' }] }, { text: '', at: Date.now(), attachments: [{ name: 'photo.png' }] }];
  const history = await f.client.history(conversation, 'default');
  // The media reference is hidden, the image-only message is kept with its file,
  // and an image-only message nobody can attribute is not an empty bubble.
  assert.deepEqual(history.messages.map(m => [m.role, m.content, m.attachments?.[0]?.name]), [['user', 'Voici le fichier', 'a.pdf'], ['user', '', 'photo.png'], ['assistant', 'Bien reçu.', undefined]]);
});
