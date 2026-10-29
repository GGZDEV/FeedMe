'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
const { createAgentRouter, normalizeEndpoint, readEvents } = require('../agents');

async function fixture(t, fetchImpl, secretStorage, WebSocketImpl) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedme-agents-'));
  const app = express();
  app.use(express.json());
  const router = createAgentRouter({ dataDir, fetchImpl, secretStorage, WebSocketImpl });
  app.use('/api/agents', router);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => {
    router.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/api/agents`;
  const call = async (route, method = 'GET', data) => {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
    const body = response.headers.get('content-type')?.includes('event-stream') ? await response.text() : await response.json();
    return { status: response.status, body };
  };
  const connect = async (kind = 'compatible', name = 'Assistant') => (await call('/connections', 'POST', {
    name, kind, endpoint: 'https://agents.example.test', model: kind === 'hermes' ? 'hermes-agent' : 'demo', token: 'test-secret',
  })).body;
  const thread = async connectionId => (await call('/conversations', 'POST', { connectionId })).body;
  return { call, connect, thread, base, dataDir };
}

test('normalizes gateway and profile endpoints, rejects remote HTTP and embedded credentials', () => {
  assert.equal(normalizeEndpoint('https://host.test'), 'https://host.test/v1');
  assert.equal(normalizeEndpoint('https://host.test/p/work/v1/'), 'https://host.test/p/work/v1');
  assert.equal(normalizeEndpoint('http://127.0.0.1:8642/v1/chat/completions'), 'http://127.0.0.1:8642/v1');
  for (const value of ['http://host.test', 'https://user:pass@host.test', 'file:///tmp/test', 'https://host.test?key=secret']) assert.throws(() => normalizeEndpoint(value));
});

test('decodes fragmented UTF-8, CRLF, comments, multiple frames and final frame', async () => {
  const bytes = Buffer.from(': keepalive\r\n\r\ndata: {"text":"coucou 👋"}\r\n\r\ndata: [DONE]');
  async function* chunks() { for (const byte of bytes) yield Uint8Array.of(byte); }
  const events = [];
  for await (const event of readEvents(chunks())) events.push(event);
  assert.deepEqual(events, ['{"text":"coucou 👋"}', '[DONE]']);
});

test('keeps tokens out of API responses and plaintext storage; blocks cross-site access', async t => {
  const f = await fixture(t, async () => Response.json({ data: [] }));
  const c = await f.connect();
  assert.equal(c.tokenStorage, 'session');
  assert.equal(c.hasToken, true);
  assert.ok(!JSON.stringify((await f.call('/')).body).includes('test-secret'));
  assert.ok(!fs.readFileSync(path.join(f.dataDir, 'agents-store.json'), 'utf8').includes('test-secret'));
  assert.equal((await fetch(f.base, { headers: { Origin: 'https://hostile.test' } })).status, 403);
  const rebindingStatus = await new Promise((resolve, reject) => {
    http.get(f.base, { headers: { Host: 'hostile.test' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(rebindingStatus, 403);
});

test('uses supplied encrypted storage without exposing the encrypted token', async t => {
  const codec = { encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() };
  let auth;
  const f = await fixture(t, async (_url, options) => { auth = options.headers.Authorization; return Response.json({ data: [{ id: 'openclaw' }] }); }, codec);
  const c = await f.connect();
  assert.equal(c.tokenStorage, 'encrypted');
  assert.equal(c.secret, undefined);
  assert.equal((await f.call(`/connections/${c.id}/test`, 'POST')).status, 200);
  assert.equal(auth, 'Bearer test-secret');
});

test('compatible clients keep distinct thread identities and successful history', async t => {
  const calls = [];
  const f = await fixture(t, async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return new Response('data: {"choices":[{"delta":{"content":"Bonjour 👋"}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const c = await f.connect();
  const first = await f.thread(c.id);
  assert.match((await f.call(`/conversations/${first.id}/messages`, 'POST', { text: 'Salut' })).body, /event: done/);
  await f.call(`/conversations/${first.id}/messages`, 'POST', { text: 'Suite' });
  const second = await f.thread(c.id);
  await f.call(`/conversations/${second.id}/messages`, 'POST', { text: 'Salut' });
  assert.equal(calls[0].user, calls[1].user);
  assert.notEqual(calls[0].user, calls[2].user);
  assert.deepEqual(calls[1].messages.map(m => m.content), ['Salut', 'Bonjour 👋', 'Suite']);
  const saved = (await f.call(`/conversations/${first.id}`)).body;
  assert.equal(saved.messages.length, 4);
  assert.equal(saved.messages[1].content, 'Bonjour 👋');
  assert.equal(saved.messages[1].status, 'complete');
  assert.equal(saved.active, false);
  assert.equal((await f.call('/connections', 'POST', { ...c, model: 'openclaw/other' })).status, 400);
});

test('Hermes receives full successful history; non-streaming compatible responses also work', async t => {
  const calls = [];
  const headers = [];
  const f = await fixture(t, async (_url, options) => {
    calls.push(JSON.parse(options.body));
    headers.push(options.headers);
    return Response.json({ choices: [{ message: { content: 'Réponse' }, finish_reason: 'stop' }] });
  });
  const c = await f.connect('hermes');
  const thread = await f.thread(c.id);
  await f.call(`/conversations/${thread.id}/messages`, 'POST', { text: 'Un' });
  await f.call(`/conversations/${thread.id}/messages`, 'POST', { text: 'Deux' });
  assert.deepEqual(calls[1].messages.map(m => m.content), ['Un', 'Réponse', 'Deux']);
  assert.equal(headers[0]['X-Hermes-Session-Id'], `feedme-${thread.id}`);
  assert.equal(headers[0]['X-Hermes-Session-Id'], headers[1]['X-Hermes-Session-Id']);
  assert.notEqual(headers[0]['Idempotency-Key'], headers[1]['Idempotency-Key']);
});

test('persists partial failures and rejects error terminal chunks instead of treating them as success', async t => {
  let iteration = 0;
  const f = await fixture(t, async () => new Response(iteration++ === 0
    ? 'data: {"choices":[{"delta":{"content":"Partiel"}}]}\n\n'
    : 'data: {"choices":[{"delta":{},"finish_reason":"error"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
  const c = await f.connect();
  const thread = await f.thread(c.id);
  const result = await f.call(`/conversations/${thread.id}/messages`, 'POST', { text: 'Action' });
  assert.match(result.body, /event: error/);
  assert.doesNotMatch(result.body, /event: done/);
  let saved = (await f.call(`/conversations/${thread.id}`)).body;
  assert.equal(saved.messages.at(-1).status, 'failed');
  assert.equal(saved.messages.at(-1).content, 'Partiel');
  await f.call(`/conversations/${thread.id}/messages`, 'POST', { text: 'Autre' });
  saved = (await f.call(`/conversations/${thread.id}`)).body;
  assert.equal(saved.messages.at(-1).status, 'failed');
});

test('rejects concurrent sends, aborts upstream on disconnect and retains the interrupted turn', async t => {
  let started;
  const start = new Promise(resolve => { started = resolve; });
  let signal;
  const f = await fixture(t, async (_url, options) => {
    signal = options.signal; started();
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Début"}}]}\n\n'));
      signal.addEventListener('abort', () => controller.error(new Error('cancelled')), { once: true });
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const c = await f.connect();
  const thread = await f.thread(c.id);
  const controller = new AbortController();
  const response = await fetch(`${f.base}/conversations/${thread.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Travaille' }), signal: controller.signal });
  await start;
  assert.equal((await f.call(`/conversations/${thread.id}/messages`, 'POST', { text: 'Encore' })).status, 409);
  assert.equal((await f.call(`/conversations/${thread.id}`, 'DELETE')).status, 400);
  const reader = response.body.getReader();
  await reader.read(); controller.abort();
  for (let attempt = 0; attempt < 30; attempt++) {
    const saved = (await f.call(`/conversations/${thread.id}`)).body;
    if (!saved.active) { assert.equal(saved.messages.at(-1).status, 'interrupted'); assert.equal(signal.aborted, true); return; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Upstream request was not interrupted');
});

test('attachments: images go to the API as image parts, only metadata is stored, unsupported files are refused before sending', async t => {
  const calls = [];
  const f = await fixture(t, async (_url, options) => { calls.push(JSON.parse(options.body)); return Response.json({ choices: [{ message: { content: 'Vu' }, finish_reason: 'stop' }] }); });
  const c = await f.connect();
  const thread = await f.thread(c.id);
  const image = Buffer.from('image-bytes').toString('base64');
  await f.call(`/conversations/${thread.id}/messages`, 'POST', { text: '', attachments: [{ fileName: 'photo.png', mimeType: 'image/png', content: image }] });
  assert.deepEqual(calls[0].messages.at(-1).content, [{ type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } }]);
  const stored = (await f.call(`/conversations/${thread.id}`)).body.messages[0];
  assert.deepEqual(stored.attachments, [{ name: 'photo.png', mimeType: 'image/png', size: 11 }]);
  assert.equal(fs.readFileSync(path.join(f.dataDir, 'agents-store.json'), 'utf8').includes(image), false);
  const refused = await f.call(`/conversations/${thread.id}/messages`, 'POST', { text: 'Et ça ?', attachments: [{ fileName: 'a.zip', mimeType: 'application/zip', content: 'UEs=' }] });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /images et des fichiers texte/);
  assert.equal(calls.length, 1);
  assert.equal((await f.call(`/conversations/${thread.id}`)).body.messages.length, 2);
});
