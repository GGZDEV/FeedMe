'use strict';

// Pièces jointes des messages aux agents : validation de ce qu'envoie la page,
// conversion vers chaque service, et métadonnées gardées pour l'affichage.
// Le contenu complet (base64) ne fait que transiter : seuls le nom, le type,
// la taille et une petite vignette sont conservés dans l'historique local.

const MAX_FILES = 4;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_PREVIEW_CHARS = 80000;
const MAX_INLINE_TEXT_BYTES = 300 * 1024;
const MAX_REMEMBERED = 40;

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const PREVIEW = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|log|json|jsonl|ya?ml|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|ps1|bat|sql|ini|toml|cfg|conf|env)$/i;

class AttachmentError extends Error {}

function fileNameOf(value) {
  const name = String(value || '').replace(/[\\/]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 180);
  return name || 'fichier';
}
function decodedSize(base64) {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor(base64.length / 4) * 3 - padding;
}
const sizeLabel = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} Mo` : `${Math.max(1, Math.round(bytes / 1024))} Ko`;

// Valide la liste reçue du navigateur. Lève une AttachmentError lisible.
function normalizeAttachments(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new AttachmentError('Pièces jointes invalides.');
  if (input.length > MAX_FILES) throw new AttachmentError(`${MAX_FILES} pièces jointes au maximum par message.`);
  let total = 0;
  return input.map(item => {
    const fileName = fileNameOf(item?.fileName);
    const content = typeof item?.content === 'string' ? item.content.trim() : '';
    if (!content || content.length % 4 !== 0 || !BASE64.test(content)) throw new AttachmentError(`Le fichier « ${fileName} » n’a pas pu être lu.`);
    const sizeBytes = decodedSize(content);
    if (sizeBytes > MAX_FILE_BYTES) throw new AttachmentError(`« ${fileName} » dépasse ${sizeLabel(MAX_FILE_BYTES)}.`);
    total += sizeBytes;
    if (total > MAX_TOTAL_BYTES) throw new AttachmentError(`Les pièces jointes dépassent ${sizeLabel(MAX_TOTAL_BYTES)} au total.`);
    const mimeType = MIME.test(String(item?.mimeType || '')) ? String(item.mimeType).toLowerCase() : 'application/octet-stream';
    const preview = typeof item?.preview === 'string' && item.preview.length <= MAX_PREVIEW_CHARS && PREVIEW.test(item.preview) ? item.preview : '';
    return { fileName, mimeType, content, sizeBytes, isImage: mimeType.startsWith('image/'), preview };
  });
}

// Ce qui reste dans l'historique local : de quoi afficher la pièce, pas son contenu.
const attachmentMeta = list => list.map(({ fileName, mimeType, sizeBytes, preview }) => ({ name: fileName, mimeType, size: sizeBytes, ...(preview ? { preview } : {}) }));

// Format du paramètre `attachments` de chat.send (OpenClaw).
function gatewayAttachments(list, policy) {
  const limits = policy?.attachments;
  for (const item of list) {
    const max = limits ? (item.isImage ? limits.maxImageBytes : limits.maxBytes) : null;
    if (Number.isFinite(max) && item.sizeBytes > max) throw new AttachmentError(`« ${item.fileName} » dépasse la limite de la passerelle (${sizeLabel(max)}).`);
  }
  const encoded = list.reduce((sum, item) => sum + item.content.length, 0);
  if (Number.isFinite(policy?.maxPayload) && encoded + 64 * 1024 > policy.maxPayload) throw new AttachmentError(`Les pièces jointes dépassent la taille acceptée par la passerelle (${sizeLabel(policy.maxPayload * 0.75)}).`);
  return list.map(item => ({ type: item.isImage ? 'image' : 'file', mimeType: item.mimeType, fileName: item.fileName, content: item.content, sizeBytes: item.sizeBytes, origin: 'file' }));
}

const isTextFile = item => item.mimeType.startsWith('text/') || /^application\/(json|xml|x-yaml|yaml|javascript|x-sh|sql|toml)$/.test(item.mimeType) || TEXT_EXTENSIONS.test(item.fileName);

// Contenu du dernier message pour une API compatible Chat Completions :
// images en parties `image_url`, fichiers texte recopiés dans le message.
function completionContent(text, list) {
  if (!list.length) return text;
  const blocks = [text];
  for (const item of list.filter(item => !item.isImage)) {
    if (!isTextFile(item)) throw new AttachmentError(`« ${item.fileName} » : ce service n’accepte que des images et des fichiers texte. Les autres fichiers passent par OpenClaw.`);
    if (item.sizeBytes > MAX_INLINE_TEXT_BYTES) throw new AttachmentError(`« ${item.fileName} » est trop long pour être recopié dans le message (${sizeLabel(MAX_INLINE_TEXT_BYTES)} au maximum).`);
    blocks.push(`Fichier joint : ${item.fileName}\n\`\`\`\n${Buffer.from(item.content, 'base64').toString('utf8')}\n\`\`\``);
  }
  const body = blocks.filter(Boolean).join('\n\n');
  const images = list.filter(item => item.isImage);
  if (!images.length) return body;
  return [...(body ? [{ type: 'text', text: body }] : []), ...images.map(item => ({ type: 'image_url', image_url: { url: `data:${item.mimeType};base64,${item.content}` } }))];
}

// L'historique OpenClaw remplace les messages locaux : on y rattache les
// pièces jointes envoyées, en retrouvant le message par son texte et sa date.
const stripMediaRefs = text => String(text || '').split('\n').filter(line => !/^\s*\[?media:\/\/inbound\/\S+\]?\s*$/.test(line)).join('\n').trim();
function rememberSent(conversation, text, attachments, at = Date.now()) {
  conversation.sentAttachments = [...(conversation.sentAttachments || []), { text: text.trim(), at, attachments }].slice(-MAX_REMEMBERED);
}
function restoreAttachments(messages, sent) {
  const used = new Set();
  for (const entry of sent || []) {
    let best = null, bestGap = Infinity;
    messages.forEach((message, index) => {
      if (message.role !== 'user' || used.has(index) || stripMediaRefs(message.content) !== entry.text) return;
      const stamp = typeof message.timestamp === 'number' ? message.timestamp : Date.parse(message.timestamp || message.createdAt || '');
      const gap = Number.isFinite(stamp) ? Math.abs(stamp - entry.at) : 0;
      if (gap < 15 * 60 * 1000 && gap < bestGap) { best = index; bestGap = gap; }
    });
    if (best !== null) { used.add(best); messages[best].attachments = entry.attachments; }
  }
  return messages;
}

module.exports = { AttachmentError, normalizeAttachments, attachmentMeta, gatewayAttachments, completionContent, stripMediaRefs, rememberSent, restoreAttachments, MAX_FILES, MAX_FILE_BYTES };
