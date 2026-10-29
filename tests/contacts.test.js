'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const express = require('express');
const { ContactProfiles, contactsFor, mergeMessages } = require('../agent-contacts');
const { createAgentRouter } = require('../agents');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedme-contacts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, profiles: new ContactProfiles(dir) };
}
test('one contact per agent aggregates previews and unread messages across all sessions', t => {
  const f = fixture(t);
  const connections = [{ id: 'vps', kind: 'openclaw', catalog: { agents: [{ id: 'main', name: 'Home' }, { id: 'bebe', name: 'Ça grandit vite' }] } }];
  const threads = [{ id: 'a', connectionId: 'vps', agentId: 'main', isMain: true, unread: 2, updatedAt: 1, preview: 'ancien' },
    { id: 'b', connectionId: 'vps', agentId: 'main', unread: 3, updatedAt: 5, preview: 'nouveau' },
    { id: 'c', connectionId: 'vps', agentId: 'bebe', unread: 1 }, { id: 'unused', connectionId: 'vps' }];
  const contacts = contactsFor(connections, threads, f.profiles);
  assert.equal(contacts.length, 2);
  assert.equal(contacts[0].id, 'a'); assert.equal(contacts[0].unread, 5); assert.equal(contacts[0].preview, 'nouveau');
});
test('merged history retains messages and original reply destinations without duplicated session caches', () => {
  const a = { id: 'a', agentId: 'main', remote: { sessionKey: 'agent:main:main' }, messages: [{ id: '1', role: 'user', content: 'Question', timestamp: 100 }, { id: '2', role: 'assistant', content: 'Réponse', timestamp: 300 }] };
  const b = { id: 'b', agentId: 'main', remote: { sessionKey: 'agent:main:old' }, messages: [{ id: '3', role: 'assistant', content: 'Ancienne nouvelle', timestamp: 200 }] };
  const result = mergeMessages([a, b, { ...a, id: 'duplicate-cache' }]);
  assert.deepEqual(result.map(m => m.content), ['Question', 'Ancienne nouvelle', 'Réponse']);
  assert.deepEqual(result.map(m => m.conversationId), ['a', 'b', 'a']);
});
test('local names, photos and colors survive restart and stay separate between gateways', t => {
  const f = fixture(t);
  const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1kAAAAASUVORK5CYII=';
  f.profiles.set('vps', 'main', { name: 'Mon assistant', photo, color: '#345e88' });
  const restored = new ContactProfiles(f.dir);
  assert.equal(restored.get('vps','main').name, 'Mon assistant'); assert.equal(restored.get('vps','main').photo, photo);
  assert.deepEqual(restored.get('other','main'), {});
  for (const bad of ['https://example.test/avatar.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,c2NyaXB0']) assert.throws(() => restored.set('vps','main',{ photo: bad }));
  restored.set('vps','main',{}); assert.equal(restored.get('vps','main').name, '');
});
test('contact history, receipts and appearance work without any remote write or discarded old conversation', async t => {
  const f = fixture(t);
  const connection = { id: 'local', kind: 'compatible', name: 'Assistant', endpoint: 'https://example.test/v1', model: 'model' };
  fs.writeFileSync(path.join(f.dir,'agents-store.json'), JSON.stringify({ connections: [connection], conversations: [
    { id: 'a', connectionId: 'local', createdAt: '2026-01-01', messages: [{ role: 'user', content: 'Avant', timestamp: 10 }] },
    { id: 'b', connectionId: 'local', createdAt: '2026-01-02', messages: [{ role: 'assistant', content: 'Après', timestamp: 20 }] }
  ] }));
  let remoteCalls = 0;
  const app = express(); app.use(express.json());
  const router = createAgentRouter({ dataDir: f.dir, fetchImpl: () => { remoteCalls++; throw new Error('No remote calls allowed'); } }); app.use('/api/agents',router);
  const server = await new Promise(resolve => { const s=app.listen(0,'127.0.0.1',()=>resolve(s)); });
  t.after(async()=>{router.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const base = `http://127.0.0.1:${server.address().port}/api/agents`;
  let root = await (await fetch(base)).json(); assert.equal(root.contacts.length, 1);
  const history = await (await fetch(base+'/connections/local/contacts/default')).json();
  assert.deepEqual(history.messages.map(m=>m.content), ['Avant','Après']);
  const profileResponse = await fetch(base+'/connections/local/contacts/default/profile', { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Local seulement',color:'#69509d'}) });
  assert.equal(profileResponse.status,200);
  root = await (await fetch(base)).json(); assert.equal(root.contacts[0].name,'Local seulement');
  const saved = JSON.parse(fs.readFileSync(path.join(f.dir,'agents-store.json')));
  assert.equal(saved.connections[0].name,'Assistant'); assert.equal(saved.conversations.length,2); assert.equal(remoteCalls,0);
});
