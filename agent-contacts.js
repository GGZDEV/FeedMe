'use strict';
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const time = value => (typeof value === 'number' ? value : Date.parse(value || '')) || 0;
const keyFor = (connectionId, agentId) => JSON.stringify([connectionId, agentId]);
const agentFor = conversation => conversation.agentId || conversation.remote?.agentId || 'default';

class ContactProfiles {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'agent-profiles.json');
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {};
  }
  get(connectionId, agentId) { return this.data[keyFor(connectionId, agentId)] || {}; }
  set(connectionId, agentId, input) {
    const name = String(input.name || '').trim();
    if (name.length > 80 || /[\u0000-\u001f]/.test(name)) throw new Error('Le nom doit contenir au maximum 80 caractères.');
    const photo = input.photo || '';
    if (typeof photo !== 'string' || photo.length > 90000) throw new Error('Photo trop volumineuse. Choisissez une autre image.');
    if (photo) {
      const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(photo);
      if (!match) throw new Error('Choisissez une photo PNG, JPEG ou WebP.');
      const bytes = Buffer.from(match[2], 'base64');
      const valid = match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
        : match[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
      if (!valid || bytes.length > 65536) throw new Error('Photo invalide ou trop volumineuse.');
    }
    const color = /^#[0-9a-f]{6}$/i.test(input.color || '') ? input.color : '';
    this.data[keyFor(connectionId, agentId)] = { name, photo, color };
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
    return this.get(connectionId, agentId);
  }
}

function contactsFor(connections, conversations, profiles) {
  const result = [];
  for (const connection of connections) {
    const agents = new Map((connection.catalog?.agents || []).map(agent => [agent.id, agent]));
    const relevant = conversations.filter(c => c.connectionId === connection.id && (connection.kind !== 'openclaw' || c.agentId || c.remote?.agentId));
    for (const thread of relevant) {
      const id = agentFor(thread); if (!agents.has(id)) agents.set(id, { id, name: id === 'default' ? connection.name : id });
    }
    if (connection.kind !== 'openclaw' && !agents.size) agents.set('default', { id: 'default', name: connection.name });
    for (const agent of agents.values()) {
      const threads = relevant.filter(c => agentFor(c) === agent.id);
      const latest = [...threads].sort((a, b) => time(b.updatedAt) - time(a.updatedAt))[0];
      const primary = threads.find(c => c.isMain) || threads.find(c => c.contact) || latest;
      const profile = profiles.get(connection.id, agent.id);
      result.push({ connectionId: connection.id, agentId: agent.id, id: primary?.id, name: profile.name || agent.name || agent.id,
        originalName: agent.name || agent.id, emoji: agent.emoji || '', photo: profile.photo || '', color: profile.color || '',
        unread: threads.reduce((sum, c) => sum + (c.unread || 0), 0), preview: latest?.preview || '', updatedAt: latest?.updatedAt || 0,
        active: threads.some(c => c.active) });
    }
  }
  return result;
}

function mergeMessages(threads) {
  const messages = [], seen = new Set();
  for (const thread of threads) {
    const source = thread.remote?.sessionKey || thread.id;
    for (const [index, message] of thread.messages.entries()) {
      if (!message.content?.trim() && !message.attachments?.length && !['streaming', 'failed', 'interrupted'].includes(message.status)) continue;
      const stamp = time(message.timestamp || message.createdAt);
      // Source identity prevents duplicate caches; identical text in independent
      // sessions is retained, since it can be a legitimate repeated message.
      const id = createHash('sha256').update(JSON.stringify([source, message.id || [stamp, index], message.role, message.content])).digest('hex');
      if (seen.has(id)) continue;
      seen.add(id);
      messages.push({ ...message, viewId: id, conversationId: thread.id, readOnly: !!thread.readOnly,
        sortTime: stamp || time(thread.updatedAt) || time(thread.createdAt) });
    }
  }
  return messages.sort((a, b) => a.sortTime - b.sortTime).map(({ sortTime, ...message }) => message);
}
module.exports = { ContactProfiles, contactsFor, mergeMessages, agentFor };
