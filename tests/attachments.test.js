'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAttachments, attachmentMeta, gatewayAttachments, completionContent, stripMediaRefs, rememberSent, restoreAttachments } = require('../agent-attachments');

const b64 = text => Buffer.from(text).toString('base64');
const png = { fileName: 'capture.png', mimeType: 'image/png', content: b64('fake-png-bytes'), preview: 'data:image/jpeg;base64,AAAA' };

test('validates attachments: count, encoding, size, type and file name', () => {
  assert.deepEqual(normalizeAttachments(undefined), []);
  const [file] = normalizeAttachments([{ fileName: '../../secret\u0000.txt', mimeType: 'not a mime', content: b64('bonjour') }]);
  assert.equal(file.fileName, '.._.._secret.txt');
  assert.equal(file.mimeType, 'application/octet-stream');
  assert.equal(file.sizeBytes, 7);
  assert.throws(() => normalizeAttachments(Array(5).fill(png)), /4 pièces jointes/);
  assert.throws(() => normalizeAttachments([{ fileName: 'x', content: 'pas du base64 !' }]), /n’a pas pu être lu/);
  assert.throws(() => normalizeAttachments([{ fileName: 'big.bin', content: 'A'.repeat(14 * 1024 * 1024) }]), /dépasse 10.0 Mo/);
  assert.equal(normalizeAttachments([{ ...png, preview: 'javascript:alert(1)' }])[0].preview, '');
});

test('keeps only display metadata, never the file content', () => {
  const meta = attachmentMeta(normalizeAttachments([png]));
  assert.deepEqual(meta, [{ name: 'capture.png', mimeType: 'image/png', size: 14, preview: png.preview }]);
  assert.equal(JSON.stringify(meta).includes(png.content), false);
});

test('chat.send format respects the limits advertised by the gateway', () => {
  const list = normalizeAttachments([png, { fileName: 'notes.pdf', mimeType: 'application/pdf', content: b64('%PDF-1.7') }]);
  assert.deepEqual(gatewayAttachments(list, undefined).map(a => [a.type, a.mimeType, a.fileName, a.origin]), [['image', 'image/png', 'capture.png', 'file'], ['file', 'application/pdf', 'notes.pdf', 'file']]);
  assert.throws(() => gatewayAttachments(list, { attachments: { maxBytes: 100, maxImageBytes: 4 } }), /capture\.png.*limite de la passerelle/);
  assert.throws(() => gatewayAttachments(list, { maxPayload: 1000 }), /taille acceptée/);
});

test('Chat Completions: images become image parts, text files are inlined, other files are refused', () => {
  assert.equal(completionContent('Salut', []), 'Salut');
  const parts = completionContent('Regarde', normalizeAttachments([png, { fileName: 'notes.md', mimeType: '', content: b64('# Titre') }]));
  assert.equal(parts[0].type, 'text');
  assert.match(parts[0].text, /Regarde\n\nFichier joint : notes\.md\n```\n# Titre\n```/);
  assert.equal(parts[1].image_url.url, `data:image/png;base64,${png.content}`);
  assert.throws(() => completionContent('', normalizeAttachments([{ fileName: 'a.zip', mimeType: 'application/zip', content: b64('PK') }])), /images et des fichiers texte/);
});

test('re-attaches sent files to gateway history by text and time', () => {
  const conversation = {};
  rememberSent(conversation, 'Voici la capture', [{ name: 'capture.png' }], 1000);
  rememberSent(conversation, '', [{ name: 'photo.jpg' }], 5000);
  const messages = [
    { role: 'user', content: 'Voici la capture', timestamp: 900_000_000 }, // Same text, far away in time.
    { role: 'user', content: stripMediaRefs('Voici la capture\nmedia://inbound/abc'), timestamp: 2000 },
    { role: 'user', content: '', timestamp: 5500 },
  ];
  restoreAttachments(messages, conversation.sentAttachments);
  assert.equal(messages[0].attachments, undefined);
  assert.equal(messages[1].attachments[0].name, 'capture.png');
  assert.equal(messages[2].attachments[0].name, 'photo.jpg');
});
