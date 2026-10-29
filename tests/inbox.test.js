'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter, once } = require('events');
const { AgentInbox } = require('../agent-inbox');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedme-inbox-'));
  const notifications = [];
  const inbox = new AgentInbox({ dataDir: dir, notify: item => notifications.push(item) });
  const rows = [{ key: 'agent:news:main', agentId: 'news', channel: 'telegram', sessionId: 's1', updatedAt: Date.now() }];
  const messages = [{ role: 'assistant', content: 'Ancien bulletin', timestamp: Date.now() - 100000, __openclaw: { id: 'old' } }];
  const client = new EventEmitter();
  Object.assign(client, { socket: {}, hello: { features: { methods: ['sessions.list', 'sessions.subscribe'] } }, info: () => ({ state: 'connected' }), connect: async () => {}, rpc: async (method, params) => {
    if (method === 'sessions.subscribe') return { subscribed: true };
    if (method === 'sessions.list') return { sessions: rows };
    if (method === 'chat.history') return { sessionId: rows.find(row => row.key === params.sessionKey)?.sessionId, messages };
    throw new Error('Forbidden RPC');
  } });
  const worker = { client, connection: { id: 'c1', name: 'VPS' } };
  t.after(() => { inbox.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, notifications, inbox, rows, messages, client, worker };
}

test('imports past history as read, then receives scheduled messages outside the foreground chat', async t => {
  const f = fixture(t);
  await f.inbox.sync(f.worker);
  assert.equal(f.inbox.snapshot().unread, 0);
  assert.equal(f.notifications.length, 0);
  f.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Vos news de 8h' }], timestamp: Date.now(), __openclaw: { id: 'news' } });
  f.rows[0].updatedAt++;
  await f.inbox.sync(f.worker);
  assert.equal(f.inbox.snapshot().unread, 1);
  assert.equal(f.notifications.length, 1);
  assert.equal(f.notifications[0].content, 'Vos news de 8h');
  assert.equal(f.notifications[0].source, 'telegram');
  await f.inbox.sync({ ...f.worker, versions: new Map() });
  assert.equal(f.notifications.length, 1);
  assert.equal(f.inbox.snapshot().items.length, 2);
});

test('restart catches up missed messages once and persists read acknowledgments', async t => {
  const f = fixture(t);
  await f.inbox.sync(f.worker);
  f.messages.push({ role: 'assistant', content: 'Message pendant la coupure', __openclaw: { id: 'offline' } });
  const restored = new AgentInbox({ dataDir: f.dir, notify: item => f.notifications.push(item) });
  await restored.sync({ ...f.worker, versions: new Map() });
  assert.equal(restored.snapshot().unread, 1);
  restored.read(restored.snapshot().items.find(item => item.content.includes('coupure')).id);
  await restored.sync({ ...f.worker, versions: new Map() });
  assert.equal(new AgentInbox({ dataDir: f.dir }).snapshot().unread, 0);
  assert.equal(f.notifications.length, 1);
});

test('ignores tools, silent replies and heartbeat sessions; retains identical texts with distinct message IDs', async t => {
  const f = fixture(t);
  f.messages.push({ role: 'assistant', content: [{ type: 'toolCall', name: 'secret' }] }, { role: 'assistant', content: 'NO_REPLY' }, { role: 'assistant', content: 'HEARTBEAT_OK' });
  f.rows.push({ key: 'agent:news:main:heartbeat' });
  await f.inbox.sync(f.worker);
  f.messages.push({ role: 'assistant', content: 'Même rappel', id: 'a' }, { role: 'assistant', content: 'Même rappel', id: 'b' }); f.rows[0].updatedAt++;
  await f.inbox.sync(f.worker);
  assert.equal(f.inbox.snapshot().unread, 2);
  assert.equal(f.inbox.snapshot().items.length, 3);
});

test('reconnect renews subscription and refreshes history even with unchanged roster timestamps', async t => {
  const f = fixture(t);
  await f.inbox.run(f.worker); clearTimeout(f.worker.timer);
  f.messages.push({ role: 'assistant', content: 'Après reconnexion', id: 'reconnect' });
  f.client.socket = {};
  await f.inbox.run(f.worker); clearTimeout(f.worker.timer);
  assert.equal(f.inbox.snapshot().unread, 1);
});

test('a stopped receiver cannot commit an in-flight history or emit a notification', async t => {
  const f = fixture(t);
  const original = f.client.rpc;
  f.client.rpc = async (...args) => { const result = await original(...args); if (args[0] === 'chat.history') f.worker.stopped = true; return result; };
  await f.inbox.sync(f.worker);
  assert.equal(f.inbox.snapshot().items.length, 0);
  assert.equal(f.notifications.length, 0);
});

test('gateway events trigger background reception without an open conversation', async t => {
  const f = fixture(t);
  const initial = once(f.inbox, 'change');
  f.inbox.start(f.worker.connection, f.client);
  await initial;
  f.messages.push({ role: 'assistant', content: 'Votre rappel du matin', id: 'event-message' });
  f.rows[0].updatedAt++;
  const update = once(f.inbox, 'change');
  f.client.emit('gatewayEvent', { event: 'sessions.changed', payload: { session: f.rows[0] } });
  await update;
  assert.equal(f.inbox.snapshot().unread, 1);
  assert.equal(f.notifications.length, 1);
});

test('offline recovery pages backward until a known transcript entry is found', async t => {
  const f = fixture(t);
  await f.inbox.sync(f.worker);
  const original = f.client.rpc;
  const offsets = [];
  f.client.rpc = async (method, params) => {
    if (method !== 'chat.history') return original(method, params);
    offsets.push(params.offset || 0);
    return { sessionId: 's1', messages: params.offset ? f.messages : Array.from({ length: 100 }, (_, i) => ({ role: 'assistant', content: 'Rappel ' + i, id: 'missed-' + i })), hasMore: !params.offset, nextOffset: 100 };
  };
  await f.inbox.sync({ ...f.worker, versions: new Map() });
  assert.deepEqual(offsets, [0, 100]);
  assert.equal(f.inbox.snapshot().unread, 100);
  assert.equal(f.notifications.length, 1);
  assert.equal(f.notifications[0].count, 100);
});
