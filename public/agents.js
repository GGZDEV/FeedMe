'use strict';

(() => {
  const root = document.getElementById('agent-space');
  const state = { connections: [], conversations: [], contacts: [], selected: null, thread: null };
  const streams = new Map(), drafts = new Map(), replies = new Map();
  const modelCatalogs = new Map();
  // Messages typed while the agent works: sent in order once it is free.
  const queues = new Map(), flushing = new Set();
  // Files waiting in the composer, per thread: { fileName, mimeType, size, content (base64), preview }.
  const pendingFiles = new Map();
  const MAX_FILES = 4, MAX_FILE_BYTES = 10 * 1024 * 1024, MAX_TOTAL_BYTES = 25 * 1024 * 1024;
  let loaded = false, loading = false, search = '', refreshTimer, menuAnchor = null;
  const request = (url, options) => api('/api/agents' + url, options);
  const element = selector => root.querySelector(selector);
  const connection = () => state.connections.find(c => c.id === state.selected);
  const agentId = thread => thread?.agentId || thread?.remote?.agentId;
  const contactFor = id => state.contacts.find(c => c.connectionId === state.selected && c.agentId === id);
  const agentName = id => contactFor(id)?.name || connection()?.catalog?.agents.find(agent => agent.id === id)?.name || id || connection()?.name || 'Agent';
  // Tinted initials for agents without a photo or a chosen colour.
  const tints = [['#18233a', '#9dbbff'], ['#251d36', '#c9aeff'], ['#2e2416', '#f2b862'], ['#16291f', '#7fddb0'], ['#33181c', '#ff9a9f'], ['#1e1e22', '#c8c8ce']];
  const tintFor = id => tints[[...String(id || '')].reduce((sum, char) => sum + char.charCodeAt(0), 0) % tints.length];
  const avatar = id => {
    const contact = contactFor(id);
    if (contact?.photo) return `<img src="${escAttr(contact.photo)}" alt="" draggable="false">`;
    const text = contact?.emoji || agentName(id).slice(0, 1).toUpperCase();
    const [bg, fg] = contact?.color ? [contact.color, 'var(--text)'] : tintFor(id);
    return `<span class="messenger-initial" style="background:${escAttr(bg)};color:${escAttr(fg)}">${esc(text)}</span>`;
  };
  const shortModel = id => String(id || '').split('/').pop();
  const providerTone = id => ({ openai: '#10a37f', anthropic: '#d97757', google: '#4f8cff', gemini: '#4f8cff' })[String(id || '').split('/')[0].toLowerCase()] || 'var(--text-faint)';
  const busy = thread => !!thread && (thread.active || streams.has(thread.id));
  const workingSince = thread => streams.get(thread.id)?.startedAt
    || Date.parse([...(thread.messages || [])].reverse().find(m => m.role === 'user')?.createdAt || '') || 0;
  const elapsed = since => { const s = Math.max(0, Math.floor((Date.now() - since) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const contactPath = thread => '/connections/' + thread.connectionId + '/contacts/' + agentId(thread);
  const safely = fn => async (...args) => { try { await fn(...args); } catch (error) { showToast(error.message, 'error'); } };
  const status = text => { const label = element('[data-agent-status]'); if (label) label.textContent = text; };
  const clock = value => value ? new Date(value).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
  const isOpen = () => !root.hidden && document.visibilityState === 'visible';

  async function refresh() {
    const data = await request('/');
    state.connections = data.connections; state.conversations = data.conversations; state.contacts = data.contacts || [];
    if (!state.connections.some(c => c.id === state.selected)) state.selected = state.connections[0]?.id || null;
    const selected = connection();
    if (selected?.kind === 'openclaw' && selected.gateway?.state === 'connected' && !selected.catalog) {
      try { selected.catalog = await request('/connections/' + selected.id + '/agents'); state.contacts = (await request('/')).contacts || []; } catch { /* Existing threads remain available. */ }
    }
    const count = state.contacts.reduce((sum, contact) => sum + (contact.unread || 0), 0);
    const badge = document.querySelector('[data-inbox-badge]'); badge.textContent = count || ''; badge.hidden = !count;
  }
  function rows() {
    return state.contacts.filter(contact => contact.connectionId === state.selected)
      .filter(row => !search || `${row.name} ${row.originalName} ${row.preview}`.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.name.localeCompare(b.name));
  }
  function renderList() {
    const list = element('[data-chat-list]'); if (!list) return;
    const previousScroll = list.scrollTop;
    const entries = rows();
    list.innerHTML = entries.map(row => {
      const preview = row.active ? row.preview || 'Travaille…' : row.preview || 'Aucun message pour l’instant';
      const label = row.name + (row.active ? ' · au travail' : '') + (row.unread ? ` · ${row.unread} non lu${row.unread > 1 ? 's' : ''}` : '');
      return `<button type="button" class="messenger-contact ${agentId(state.thread) === row.agentId ? 'selected' : ''} ${row.unread ? 'unread' : ''} ${row.active ? 'working' : ''}" data-chat="${escAttr(row.agentId)}" aria-label="${escAttr(label)}"><span class="messenger-avatar-wrap"><span class="messenger-avatar">${avatar(row.agentId)}</span>${row.active ? '<span class="messenger-presence" aria-hidden="true"></span>' : ''}</span><span class="messenger-contact-copy"><span class="messenger-contact-title"><strong>${esc(row.name)}</strong><time>${esc(clock(row.updatedAt))}</time></span><span class="messenger-preview-row"><span class="messenger-preview ${row.preview || row.active ? '' : 'is-empty'}">${row.active ? '<span class="messenger-pulse" aria-hidden="true"></span>' : ''}<span>${esc(preview)}</span></span>${row.unread ? `<span class="messenger-count" aria-hidden="true">${row.unread}</span>` : ''}</span></span></button>`;
    }).join('') || '<p class="agent-help">Aucun agent trouvé.</p>';
    list.querySelectorAll('[data-chat]').forEach(button => button.addEventListener('click', safely(async () => {
      await openThread({ agentId: button.dataset.chat });
    })));
    list.querySelectorAll('[data-chat]').forEach(button => button.addEventListener('contextmenu', event => { event.preventDefault(); openProfile(button.dataset.chat); }));
    list.scrollTop = previousScroll;
  }
  function renderMessages(preservePosition = false) {
    const list = element('[data-messages]'); if (!list) return;
    const follow = !preservePosition || list.scrollHeight - list.scrollTop - list.clientHeight < 90, top = list.scrollTop;
    list.replaceChildren(); let lastDay;
    for (const message of state.thread?.messages || []) {
      if (!message.content?.trim() && !message.attachments?.length && !['streaming', 'failed', 'interrupted'].includes(message.status)) continue;
      const timestamp = message.timestamp || message.createdAt, date = timestamp ? new Date(timestamp) : null;
      const day = date && !Number.isNaN(date.valueOf()) ? date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }) : null;
      if (day && day !== lastDay) { const divider = document.createElement('div'); divider.className = 'messenger-day'; divider.textContent = day; list.append(divider); lastDay = day; }
      if (message.status === 'streaming' && !message.content?.trim()) continue; // The working card stands in for it.
      const fromUser = message.role === 'user', name = agentName(agentId(state.thread));
      const article = document.createElement('article'); article.className = 'agent-message ' + (fromUser ? 'from-user' : 'from-agent');
      if (!fromUser) {
        const head = document.createElement('div'); head.className = 'agent-message-head';
        head.innerHTML = `<span class="messenger-avatar small">${avatar(agentId(state.thread))}</span><strong>${esc(name)}</strong>${timestamp ? `<time>${esc(clock(timestamp))}</time>` : ''}`;
        article.append(head);
      }
      if (message.attachments?.length) {
        const files = document.createElement('div'); files.className = 'agent-message-files';
        files.innerHTML = message.attachments.map(file => fileChip(file, false)).join(''); article.append(files);
      }
      if (message.content || !message.attachments?.length) { const content = document.createElement('div'); content.className = 'agent-message-content'; content.textContent = message.content || 'Réponse interrompue.'; article.append(content); }
      if (fromUser) { const meta = document.createElement('small'); meta.className = 'messenger-message-meta'; meta.textContent = timestamp ? clock(timestamp) : ''; if (meta.textContent) article.append(meta); }
      if (message.error) { const note = document.createElement('small'); note.className = 'agent-message-error'; note.textContent = message.error; article.append(note); }
      if (!fromUser && message.status !== 'streaming') {
        const actions = document.createElement('div'); actions.className = 'agent-message-actions';
        if (message.conversationId && !message.readOnly) {
          const reply = document.createElement('button'); reply.type = 'button'; reply.className = 'message-action'; reply.innerHTML = `${icon('i-reply')}Répondre`;
          reply.addEventListener('click', () => { replies.set(state.thread.id, message); renderReply(); element('[data-prompt]').focus(); }); actions.append(reply);
        }
        if (message.content) {
          const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'message-action'; copy.innerHTML = `${icon('i-copy')}Copier`;
          copy.addEventListener('click', safely(async () => { await navigator.clipboard.writeText(message.content); showToast('Message copié.'); })); actions.append(copy);
        }
        if (actions.children.length) article.append(actions);
      }
      list.append(article);
    }
    if (busy(state.thread)) {
      const card = document.createElement('section'); card.className = 'agent-working'; card.setAttribute('aria-label', 'Progression de l’agent');
      const since = workingSince(state.thread);
      card.innerHTML = `<span class="agent-spinner" aria-hidden="true"></span><span class="agent-working-label">${esc(agentName(agentId(state.thread)))} travaille</span>${since ? `<time data-elapsed="${since}">${elapsed(since)}</time>` : ''}`;
      list.append(card);
    }
    if (!list.children.length) list.innerHTML = `<div class="messenger-welcome"><span class="messenger-avatar large">${avatar(agentId(state.thread))}</span><h2>${esc(agentName(agentId(state.thread)))}</h2><p>Le début de votre conversation.<br>Ses messages et vos réponses se retrouvent ici.</p></div>`;
    list.scrollTop = follow ? list.scrollHeight : top;
    if (state.thread) status(state.thread.historyError || (state.thread.readOnly ? 'Cette conversation est en lecture seule.' : ''));
    renderComposerState(); renderQueued(); renderModels();
    if (state.thread && !busy(state.thread) && queues.get(state.thread.id)?.length) setTimeout(() => flushQueue().catch(error => showToast(error.message, 'error')), 0);
  }
  // Send / stop / hint follow the thread state: while the agent works, a new
  // message is queued and sent at the end of the step.
  function renderComposerState() {
    const thread = state.thread, input = element('[data-prompt]'), sendButton = element('[data-send]');
    if (!thread || !input || !sendButton) return;
    const working = busy(thread);
    sendButton.disabled = loading || thread.readOnly || (!input.value.trim() && !pendingFiles.get(thread.id)?.length);
    sendButton.setAttribute('aria-label', working ? 'Mettre en attente' : 'Envoyer');
    element('[data-stop]').hidden = !streams.has(thread.id);
    element('[data-composer-hint]').textContent = working ? 'Sera envoyé à la fin de l’étape' : '⇧ ↵ nouvelle ligne';
    element('.messenger-chat-header .messenger-presence').hidden = !working;
  }
  const fileSize = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} Mo` : `${Math.max(1, Math.round(bytes / 1024))} Ko`;
  const readDataUrl = blob => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Lecture du fichier impossible.')); reader.readAsDataURL(blob); });
  // Draws an image into a JPEG no larger than `side` pixels.
  async function shrinkImage(file, side, quality) {
    const bitmap = await createImageBitmap(file);
    try {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas'); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#141415'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    } finally { bitmap.close(); }
  }
  async function addFiles(list) {
    const thread = state.thread; if (!thread || thread.readOnly || !list?.length) return;
    const current = pendingFiles.get(thread.id) || [];
    for (const original of [...list]) {
      if (current.length >= MAX_FILES) { showToast(`${MAX_FILES} pièces jointes au maximum par message.`, 'error'); break; }
      let file = original, mimeType = original.type || 'application/octet-stream', fileName = original.name || 'fichier';
      const image = /^image\/(jpeg|png|webp|bmp)$/.test(mimeType);
      // Large photos are resized before sending: the agent sees them just as well.
      if (image && file.size > 4 * 1024 * 1024) {
        try { file = await shrinkImage(original, 2560, .85); mimeType = 'image/jpeg'; fileName = fileName.replace(/\.\w+$/, '') + '.jpg'; } catch { file = original; }
      }
      if (file.size > MAX_FILE_BYTES) { showToast(`« ${fileName} » dépasse ${fileSize(MAX_FILE_BYTES)}.`, 'error'); continue; }
      if (current.reduce((sum, item) => sum + item.size, 0) + file.size > MAX_TOTAL_BYTES) { showToast(`Les pièces jointes dépassent ${fileSize(MAX_TOTAL_BYTES)} au total.`, 'error'); break; }
      const content = String(await readDataUrl(file)).split(',')[1] || '';
      if (!content) { showToast(`« ${fileName} » est vide.`, 'error'); continue; }
      let preview = '';
      if (mimeType.startsWith('image/')) { try { preview = await readDataUrl(await shrinkImage(file, 240, .72)); } catch { /* Shown as a file chip instead. */ } }
      current.push({ fileName, mimeType, size: file.size, content, preview });
    }
    if (state.thread?.id !== thread.id) return;
    pendingFiles.set(thread.id, current); renderPendingFiles(); element('[data-prompt]')?.focus();
  }
  // One attachment, in the composer tray or in a sent bubble.
  const fileChip = (file, removable, index) => {
    const name = file.fileName || file.name || 'fichier';
    const label = `${name} · ${fileSize(file.size || 0)}`;
    const remove = removable ? `<button type="button" class="agent-file-remove" data-remove-file="${index}" aria-label="Retirer ${escAttr(name)}">${icon('i-x', 'ic-sm')}</button>` : '';
    return file.preview
      ? `<span class="agent-file is-image" title="${escAttr(label)}"><img src="${escAttr(file.preview)}" alt="${escAttr(name)}">${remove}</span>`
      : `<span class="agent-file" title="${escAttr(label)}">${icon('i-file')}<span class="agent-file-name">${esc(name)}</span><span class="agent-file-size">${esc(fileSize(file.size || 0))}</span>${remove}</span>`;
  };
  function renderPendingFiles() {
    const tray = element('[data-attachments]'), thread = state.thread; if (!tray || !thread) return;
    const files = pendingFiles.get(thread.id) || [];
    tray.hidden = !files.length;
    tray.innerHTML = files.map((file, index) => fileChip(file, true, index)).join('');
    tray.querySelectorAll('[data-remove-file]').forEach(button => button.addEventListener('click', () => { files.splice(Number(button.dataset.removeFile), 1); renderPendingFiles(); element('[data-prompt]')?.focus(); }));
    renderComposerState();
  }
  function renderQueued() {
    const panel = element('[data-queued]'), thread = state.thread; if (!panel || !thread) return;
    const queue = queues.get(thread.id) || [];
    panel.hidden = !queue.length;
    panel.innerHTML = queue.map((item, index) => `<div class="agent-queued-item"><span><strong>En attente</strong>${esc([item.files?.length ? `${item.files.length} pièce${item.files.length > 1 ? 's' : ''} jointe${item.files.length > 1 ? 's' : ''}` : '', item.text.slice(0, 150)].filter(Boolean).join(' · '))}</span><button type="button" class="ghost-btn" data-unqueue="${index}" aria-label="Retirer ce message de la file">${icon('i-x', 'ic-sm')}</button></div>`).join('');
    panel.querySelectorAll('[data-unqueue]').forEach(button => button.addEventListener('click', () => { queue.splice(Number(button.dataset.unqueue), 1); renderQueued(); }));
  }
  function enqueue(thread, item) {
    if (!queues.has(thread.id)) queues.set(thread.id, []);
    queues.get(thread.id).push(item); renderQueued();
  }
  async function flushQueue() {
    const thread = state.thread;
    if (!thread || busy(thread) || loading || thread.readOnly || flushing.has(thread.id)) return;
    const item = queues.get(thread.id)?.shift(); if (!item) return;
    flushing.add(thread.id); renderQueued();
    try {
      await send(null, item.text, item.reply, item.files);
      if (item.text.startsWith('/model ')) await loadModels(thread, true);
    } finally { flushing.delete(thread.id); setTimeout(() => flushQueue().catch(() => {}), 0); }
  }
  function renderModels() {
    const thread = state.thread; if (!thread) return;
    const catalog = modelCatalogs.get(thread.id);
    const label = catalog?.loading && !catalog.current ? 'Chargement…' : shortModel(catalog?.current) || 'Modèle';
    root.querySelectorAll('[data-model-label]').forEach(node => { node.textContent = label; });
    root.querySelectorAll('[data-model-open]').forEach(button => button.setAttribute('aria-label', `Modèle : ${catalog?.current || 'par défaut'}. Changer de modèle`));
    const dot = element('[data-model-dot]'); if (dot) dot.style.background = providerTone(catalog?.current);
    const menu = element('[data-model-menu]'); if (!menu || menu.hidden) return;
    const options = [{ id: 'default', name: 'Par défaut de l’agent' }, ...(catalog?.models || [])];
    menu.innerHTML = `<div class="agent-model-menu-head"><span id="agent-model-title">Modèle du fil</span><button type="button" class="ghost-btn" data-refresh-models aria-label="Actualiser les modèles" title="Actualiser les modèles" ${catalog?.loading ? 'disabled' : ''}>${icon('i-refresh', 'ic-sm')}</button></div>
      <div role="listbox" aria-labelledby="agent-model-title">${catalog?.loading && !catalog.models ? '<p class="agent-model-empty">Chargement…</p>' : options.map(m => `<button type="button" role="option" class="agent-model-option ${m.id === 'default' ? 'is-default' : ''}" data-model="${escAttr(m.id)}" aria-selected="${m.id === catalog?.current}" ${thread.readOnly ? 'disabled' : ''}>${m.id === 'default' ? '' : `<span class="agent-model-dot" style="background:${providerTone(m.id)}"></span>`}<span>${esc(m.id === 'default' ? m.name : m.id)}</span>${m.id === catalog?.current ? icon('i-check') : ''}</button>`).join('')}</div>
      <p class="agent-model-note" role="status">${esc(catalog?.error || (busy(thread) ? 'Appliqué à la fin de l’étape en cours. Le fil et son historique sont conservés.' : 'Appliqué au prochain message. Le fil et son historique sont conservés.'))}</p>`;
    menu.querySelector('[data-refresh-models]').addEventListener('click', safely(() => loadModels(thread, true)));
    menu.querySelectorAll('[data-model]').forEach(option => option.addEventListener('click', safely(() => chooseModel(option.dataset.model))));
  }
  function openModelMenu(anchor) {
    const menu = element('[data-model-menu]'), chat = element('.messenger-chat'); if (!menu || !chat) return;
    if (!menu.hidden && menuAnchor === anchor) { closeModelMenu(); return; }
    menuAnchor = anchor; menu.hidden = false; renderModels();
    root.querySelectorAll('[data-model-open]').forEach(button => button.setAttribute('aria-expanded', String(button === anchor)));
    const box = chat.getBoundingClientRect(), at = anchor.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(at.left - box.left - 6, box.width - menu.offsetWidth - 8)) + 'px';
    const above = at.top - box.top > box.bottom - at.bottom;
    menu.style.top = above ? '' : (at.bottom - box.top + 6) + 'px';
    menu.style.bottom = above ? (box.bottom - at.top + 6) + 'px' : '';
    (menu.querySelector('[aria-selected=true]') || menu.querySelector('[data-model]'))?.focus();
    if (!modelCatalogs.has(state.thread.id)) loadModels(state.thread).catch(() => {});
  }
  function closeModelMenu(restoreFocus = false) {
    const menu = element('[data-model-menu]'); if (!menu || menu.hidden) return;
    menu.hidden = true;
    root.querySelectorAll('[data-model-open]').forEach(button => button.setAttribute('aria-expanded', 'false'));
    if (restoreFocus) menuAnchor?.focus();
    menuAnchor = null;
  }
  async function chooseModel(model) {
    const thread = state.thread, catalog = modelCatalogs.get(thread.id);
    closeModelMenu(true);
    if (!model || model === catalog?.current || (model !== 'default' && !catalog?.models?.some(m => m.id === model))) return;
    if (busy(thread)) { enqueue(thread, { text: '/model ' + model }); showToast('Changement de modèle appliqué à la fin de l’étape.'); return; }
    await send(null, '/model ' + model);
    await loadModels(thread, true);
  }
  async function loadModels(thread, force = false) {
    if (connection()?.kind !== 'openclaw' || (!force && modelCatalogs.has(thread.id))) return;
    if (modelCatalogs.get(thread.id)?.loading) return;
    modelCatalogs.set(thread.id, { ...modelCatalogs.get(thread.id), loading: true });
    if (state.thread?.id === thread.id) renderModels();
    try { modelCatalogs.set(thread.id, await request('/conversations/' + thread.id + '/models')); }
    catch (error) { modelCatalogs.set(thread.id, { error: 'Modèles indisponibles : ' + error.message }); }
    if (state.thread?.id === thread.id) renderModels();
  }
  function rememberDraft() { if (state.thread && element('[data-prompt]')) drafts.set(state.thread.id, element('[data-prompt]').value); }
  async function acknowledge(thread) {
    if (!isOpen() || state.thread?.id !== thread.id || !thread.receiptIds?.length) return;
    const ids = thread.receiptIds; thread.receiptIds = [];
    await request(contactPath(thread) + '/read', { method: 'POST', json: { ids } });
  }
  async function openThread(target) {
    if (loading) return;
    rememberDraft(); loading = true;
    try {
      const id = target.agentId || state.conversations.find(c => c.id === target.id)?.agentId || 'default';
      const descriptor = connection().kind === 'openclaw'
        ? await request('/threads/open', { method: 'POST', json: { connectionId: state.selected, agentId: id } })
        : contactFor(id)?.id ? { id: contactFor(id).id } : await request('/conversations', { method: 'POST', json: { connectionId: state.selected } });
      state.thread = streams.get(descriptor.id)?.thread || await request(contactPath({ connectionId: state.selected, agentId: id }));
      await refresh(); render(); await acknowledge(state.thread); await refresh(); renderList();
      element('[data-prompt]')?.focus();
    } finally { loading = false; if (element('[data-send]')) renderMessages(true); }
  }
  function render() {
    const selected = connection(), thread = state.thread, gateway = selected?.gateway;
    const connected = selected?.kind !== 'openclaw' || gateway?.state === 'connected';
    root.className = 'agent-space messenger' + (thread ? ' has-thread' : ''); menuAnchor = null;
    const stateLabel = selected ? connected ? 'Connecté' : gateway?.state === 'connecting' ? 'Connexion…' : 'Hors connexion' : '';
    root.innerHTML = `<div class="messenger-top"><h2>Messages</h2>${stateLabel ? `<button type="button" class="messenger-connection-state ${connected ? 'online' : gateway?.state === 'connecting' ? 'pending' : 'offline'}" data-settings title="Réglages de la connexion" aria-label="${escAttr(stateLabel + ' · réglages de la connexion')}">${esc(stateLabel)}</button>` : ''}<span class="messenger-top-spacer"></span><button type="button" class="messenger-tool messenger-new" data-add title="Ajouter une connexion" aria-label="Ajouter une connexion">${icon('i-plus')}Nouveau</button></div>
      <div class="messenger-layout"><aside class="messenger-sidebar"><div class="messenger-sidebar-tools">${state.connections.length > 1 ? `<select data-connection aria-label="Connexion">${state.connections.map(c => `<option value="${escAttr(c.id)}" ${selected?.id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>` : ''}${selected?.kind === 'openclaw' && !connected ? `<div class="messenger-alert"><span class="messenger-alert-icon">${icon('i-alert')}</span><div class="messenger-alert-copy"><strong>${esc(selected.name || 'OpenClaw')} déconnecté</strong><span>${gateway?.state === 'awaiting_approval' ? 'Approuvez FeedMe sur votre passerelle.' : gateway?.state === 'connecting' ? 'Connexion en cours…' : 'Reconnectez FeedMe à votre passerelle.'}</span></div><button type="button" class="btn primary" data-connect>${gateway?.state === 'awaiting_approval' ? 'Vérifier' : 'Connecter'}</button></div>` : ''}<label class="field messenger-search">${icon('i-search')}<input type="search" data-search aria-label="Rechercher une conversation" placeholder="Rechercher un agent ou un message" value="${escAttr(search)}"><kbd aria-hidden="true">Ctrl K</kbd></label></div><div class="messenger-contacts" data-chat-list aria-label="Conversations"></div></aside>
      <section class="messenger-chat" aria-label="Discussion">${thread ? `<header class="messenger-chat-header"><button type="button" class="messenger-icon-btn messenger-back" data-back aria-label="Retour aux conversations">${icon('i-chevron-left')}</button><span class="messenger-avatar-wrap"><span class="messenger-avatar medium">${avatar(agentId(thread))}</span><span class="messenger-presence" aria-hidden="true" hidden></span></span><div class="messenger-chat-title"><h3>${esc(agentName(agentId(thread)))}</h3><div class="messenger-chat-sub">${selected.kind === 'openclaw' ? `<button type="button" class="agent-model-trigger" data-model-open aria-haspopup="listbox" aria-expanded="false"><span data-model-label>Modèle</span>${icon('i-chevron', 'ic-sm')}</button><span class="messenger-sep" aria-hidden="true">·</span>` : ''}<span>Fil personnel</span></div></div><button type="button" class="messenger-icon-btn" data-profile aria-label="Options de la conversation" title="Nom et photo dans FeedMe">${icon('i-more')}</button></header><div class="agent-messages" data-messages role="log" aria-live="polite" aria-label="Messages avec ${escAttr(agentName(agentId(thread)))}"></div><p class="agent-status" data-agent-status role="status"></p><form class="agent-composer" data-composer><div class="messenger-reply-target" data-reply hidden></div><div class="agent-queued" data-queued hidden></div><div class="agent-attachments" data-attachments aria-label="Pièces jointes" hidden></div><input type="file" data-file-input multiple hidden><textarea data-prompt aria-label="Message à ${escAttr(agentName(agentId(thread)))}" placeholder="Écrire à ${escAttr(agentName(agentId(thread)))}…" rows="2" maxlength="32000" ${thread.readOnly ? 'disabled' : ''}></textarea><div class="agent-composer-foot">${thread.readOnly ? '' : `<button type="button" class="agent-attach" data-attach aria-label="Joindre un fichier ou une photo" title="Joindre un fichier ou une photo (ou collez / glissez-la ici)">${icon('i-paperclip')}</button>`}${selected.kind === 'openclaw' ? `<button type="button" class="agent-model-chip" data-model-open aria-haspopup="listbox" aria-expanded="false"><span class="agent-model-dot" data-model-dot></span><span data-model-label>Modèle</span>${icon('i-chevron', 'ic-sm')}</button>` : ''}<span class="agent-composer-hint" data-composer-hint>⇧ ↵ nouvelle ligne</span><button type="button" class="agent-stop" data-stop hidden title="Arrêter la réception. L’agent distant peut continuer ses actions.">${'<span aria-hidden="true"></span>'}Arrêter</button><button type="submit" class="agent-send" data-send aria-label="Envoyer" disabled>${icon('i-arrow-up')}</button></div></form><div class="agent-model-menu" data-model-menu hidden></div>` : `<div class="messenger-welcome"><span class="agent-orb">${icon('i-sparkle')}</span><h2>Vos agents, vos conversations.</h2><p>Choisissez un agent pour lui écrire.<br>Ses prochains messages arriveront dans le même fil.</p></div>`}</section></div><section class="agent-setup" data-setup hidden aria-label="Réglages de connexion"></section>`;
    renderList(); renderMessages(); renderReply();
    element('[data-search]').addEventListener('input', event => { search = event.target.value; renderList(); });
    element('[data-connection]')?.addEventListener('change', safely(async event => { if (loading) { event.target.value = state.selected; return; } rememberDraft(); state.selected = event.target.value; state.thread = null; search = ''; await refresh(); render(); }));
    element('[data-back]')?.addEventListener('click', () => { rememberDraft(); state.thread = null; render(); });
    element('[data-profile]')?.addEventListener('click', () => openProfile(agentId(state.thread)));
    element('[data-add]').addEventListener('click', () => openSettings(null)); element('[data-settings]')?.addEventListener('click', () => openSettings(selected));
    element('[data-connect]')?.addEventListener('click', safely(async event => { await connect(selected, event.currentTarget); }));
    element('[data-new]')?.addEventListener('click', safely(async () => { const thread = await request('/conversations', { method: 'POST', json: { connectionId: selected.id } }); await openThread({ id: thread.id }); }));
    if (thread) {
      if (selected.kind === 'openclaw') {
        root.querySelectorAll('[data-model-open]').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); openModelMenu(button); }));
        element('[data-model-menu]').addEventListener('keydown', event => {
          if (event.key === 'Escape') { event.stopPropagation(); closeModelMenu(true); return; }
          if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
          const options = [...element('[data-model-menu]').querySelectorAll('[data-model]')], index = options.indexOf(document.activeElement);
          event.preventDefault(); options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus();
        });
        renderModels(); loadModels(thread).catch(() => {});
      }
      const prompt = element('[data-prompt]'); prompt.value = drafts.get(thread.id) || '';
      prompt.addEventListener('input', () => { drafts.set(thread.id, prompt.value); renderComposerState(); });
      prompt.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!element('[data-send]').disabled) element('[data-composer]').requestSubmit(); } });
      element('[data-stop]').addEventListener('click', () => streams.get(state.thread?.id)?.controller.abort());
      element('[data-composer]').addEventListener('submit', safely(async event => {
        event.preventDefault();
        if (!busy(state.thread)) return send(event);
        const text = prompt.value.trim(), files = pendingFiles.get(state.thread.id) || []; if (!text && !files.length) return;
        enqueue(state.thread, { text, reply: replies.get(state.thread.id), files });
        replies.delete(state.thread.id); drafts.delete(state.thread.id); pendingFiles.delete(state.thread.id); prompt.value = ''; renderReply(); renderPendingFiles();
      }));
      // Attachments: paperclip, pasted images (Ctrl+V) and files dropped on the conversation.
      const picker = element('[data-file-input]');
      element('[data-attach]')?.addEventListener('click', () => picker.click());
      picker.addEventListener('change', safely(async () => { const files = [...picker.files]; picker.value = ''; await addFiles(files); }));
      prompt.addEventListener('paste', event => { const files = [...(event.clipboardData?.files || [])]; if (!files.length) return; event.preventDefault(); safely(addFiles)(files); });
      const chat = element('.messenger-chat');
      chat.addEventListener('dragover', event => { if (thread.readOnly || ![...event.dataTransfer.types].includes('Files')) return; event.preventDefault(); chat.classList.add('is-dropping'); });
      chat.addEventListener('dragleave', event => { if (!chat.contains(event.relatedTarget)) chat.classList.remove('is-dropping'); });
      chat.addEventListener('drop', event => { chat.classList.remove('is-dropping'); if (!event.dataTransfer.files.length) return; event.preventDefault(); safely(addFiles)(event.dataTransfer.files); });
      renderPendingFiles();
    }
    if (!selected) openSettings(null);
  }
  function renderReply() {
    const panel = element('[data-reply]'); if (!panel) return;
    const message = replies.get(state.thread?.id); panel.hidden = !message;
    panel.innerHTML = message ? `<span><strong>Réponse à ${esc(agentName(agentId(state.thread)))}</strong>${esc(message.content.slice(0, 150))}</span><button type="button" class="ghost-btn" data-cancel-reply aria-label="Annuler la réponse">✕</button>` : '';
    panel.querySelector('[data-cancel-reply]')?.addEventListener('click', () => { replies.delete(state.thread.id); renderReply(); });
  }
  function openProfile(id) {
    const contact = contactFor(id); if (!contact) return;
    rememberDraft();
    const panel = element('[data-setup]'); panel.hidden = false;
    let photo = contact.photo || '', color = contact.color || '', processing = false;
    panel.innerHTML = `<form data-contact-profile><div class="agent-setup-title"><h3>Personnaliser cet agent</h3><button type="button" class="ghost-btn" data-close-profile aria-label="Fermer la fiche">✕</button></div><p class="agent-help">Ce nom et cette photo sont visibles uniquement dans votre FeedMe.</p><div class="contact-profile-photo"><span class="messenger-avatar large" data-photo-preview>${avatar(id)}</span><button type="button" class="btn" data-pick-photo>Choisir une photo</button><button type="button" class="ghost-btn" data-remove-photo>Retirer la photo</button><input type="file" data-photo-file accept="image/jpeg,image/png,image/webp" hidden></div><label>Nom affiché<input name="displayName" aria-label="Nom affiché" maxlength="80" value="${escAttr(contact.name)}" placeholder="${escAttr(contact.originalName)}"></label><fieldset class="contact-colors"><legend>Couleur du profil</legend>${[['#345e88','bleu'],['#69509d','violet'],['#327865','vert'],['#9b6342','orange'],['#9b4e70','rose'],['#536575','gris']].map(([value,label]) => `<button type="button" data-profile-color="${value}" aria-label="Couleur ${label}" aria-pressed="${color === value}" style="background:${value}"></button>`).join('')}</fieldset><div class="agent-config-actions"><button type="submit" class="btn primary">Enregistrer</button><button type="button" class="ghost-btn" data-reset-profile>Rétablir le profil d’origine</button></div><p class="agent-help" data-profile-status role="status"></p></form>`;
    const form = panel.querySelector('form');
    const preview = () => {
      const frame = panel.querySelector('[data-photo-preview]');
      frame.innerHTML = photo ? `<img src="${escAttr(photo)}" alt="Aperçu de la photo">` : `<span class="messenger-initial" ${color ? `style="background:${color}"` : ''}>${esc(contact.emoji || form.elements.displayName.value.slice(0,1).toUpperCase() || contact.originalName.slice(0,1))}</span>`;
      panel.querySelectorAll('[data-profile-color]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.profileColor === color)));
    };
    panel.querySelector('[data-close-profile]').addEventListener('click', () => { panel.hidden = true; });
    panel.onkeydown = event => { if (event.key === 'Escape') panel.hidden = true; };
    panel.querySelector('[data-pick-photo]').addEventListener('click', () => panel.querySelector('[data-photo-file]').click());
    panel.querySelector('[data-remove-photo]').addEventListener('click', () => { photo = ''; preview(); });
    panel.querySelectorAll('[data-profile-color]').forEach(button => button.addEventListener('click', () => { color = button.dataset.profileColor; preview(); }));
    form.elements.displayName.addEventListener('input', preview);
    panel.querySelector('[data-reset-profile]').addEventListener('click', () => { form.elements.displayName.value = ''; photo = ''; color = ''; preview(); });
    panel.querySelector('[data-photo-file]').addEventListener('change', safely(async event => {
      const file = event.target.files[0]; if (!file) return;
      if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) throw new Error('Choisissez une photo PNG, JPEG ou WebP de moins de 8 Mo.');
      processing = true; form.querySelector('[type=submit]').disabled = true;
      panel.querySelector('[data-profile-status]').textContent = 'Préparation de la photo…';
      try {
        const bitmap = await createImageBitmap(file);
        try {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
          const ctx = canvas.getContext('2d'); ctx.fillStyle = '#1a222c'; ctx.fillRect(0, 0, 256, 256);
          const side = Math.min(bitmap.width, bitmap.height);
          ctx.drawImage(bitmap, (bitmap.width-side)/2, (bitmap.height-side)/2, side, side, 0, 0, 256, 256);
          for (const quality of [.85,.7,.5,.3]) { photo = canvas.toDataURL('image/jpeg', quality); if (photo.length <= 85000) break; }
          if (photo.length > 85000) throw new Error('Cette photo est trop complexe. Choisissez une autre image.');
          preview(); panel.querySelector('[data-profile-status]').textContent = 'Photo prête. Cliquez sur Enregistrer.';
        } finally { bitmap.close(); }
      } finally { processing = false; form.querySelector('[type=submit]').disabled = false; }
    }));
    form.addEventListener('submit', safely(async event => {
      event.preventDefault(); if (processing) return;
      const button = form.querySelector('[type=submit]'); button.disabled = true;
      try {
        await request('/connections/' + contact.connectionId + '/contacts/' + id + '/profile', { method: 'POST', json: { name: form.elements.displayName.value, photo, color } });
        await refresh(); render(); showToast('Profil enregistré dans FeedMe.');
      } finally { button.disabled = false; }
    }));
    form.elements.displayName.focus();
  }
  // Teste la connexion sans toucher à l'écran : l'appelant décide quoi
  // afficher. Renvoie { ok, message }.
  async function testConnection(id) {
    try {
      const result = await request('/connections/' + id + '/test', { method: 'POST' });
      return { ok: result.ok, message: result.gateway?.message || '' };
    } catch (error) { return { ok: false, message: error.message }; }
  }
  async function connect(selected, button) {
    if (!selected?.hasToken && !selected?.gateway?.paired) { openSettings(selected); return; }
    if (button) { button.disabled = true; button.textContent = 'Connexion…'; }
    const result = await testConnection(selected.id);
    await refresh(); rememberDraft(); render();
    if (result.ok) showToast(`Connecté à ${selected.name}.`);
    else openSettings(connection(), { tone: 'bad', text: result.message });
  }
  function openSettings(selected, notice) {
    rememberDraft(); const panel = element('[data-setup]'); panel.hidden = false;
    let current = selected;
    const isOpenclaw = () => form.elements.kind.value === 'openclaw';
    panel.innerHTML = `<form data-config><div class="agent-setup-title"><h3>${selected ? 'Connexion aux agents' : 'Ajouter une connexion'}</h3><button type="button" class="ghost-btn" data-close aria-label="Fermer les réglages">✕</button></div><label>Service<select name="kind"><option value="openclaw">OpenClaw</option><option value="hermes">Hermes</option><option value="compatible">API compatible</option></select></label><label>Nom<input name="name" required maxlength="80" value="${escAttr(selected?.name || 'OpenClaw')}"></label><label>Adresse du serveur<input name="endpoint" type="url" required value="${escAttr(selected?.endpoint || '')}" placeholder="wss://votre-serveur"></label><label>Mot de passe / jeton<input name="credential" type="password" autocomplete="new-password" placeholder="${selected?.hasToken ? 'Déjà enregistré · laisser vide pour le garder' : 'À saisir ici'}"></label><details><summary>Options avancées</summary><label>Modèle par défaut<input name="model" required value="${escAttr(selected?.model || 'default')}"></label></details><p class="agent-help">OpenClaw : FeedMe conserve son identité d’appareil. Le premier accès doit être approuvé sur votre passerelle. Les secrets sont chiffrés dans la version bureau.</p><div class="agent-setup-status" data-settings-result role="status" hidden></div><div class="agent-config-actions"><button type="submit" class="btn primary" data-connection-save>Enregistrer et connecter</button></div></form>`;
    const form = panel.querySelector('form'); form.elements.kind.value = selected?.kind || 'openclaw';
    const saveButton = form.querySelector('[data-connection-save]'), statusBox = form.querySelector('[data-settings-result]');
    const setStatus = (tone, text) => { statusBox.hidden = !text; statusBox.className = 'agent-setup-status ' + (tone || ''); statusBox.textContent = text || ''; };
    if (notice) setStatus(notice.tone, notice.text);
    form.elements.kind.addEventListener('change', () => { form.elements.model.value = form.elements.kind.value === 'hermes' ? 'hermes-agent' : 'default'; });
    element('[data-close]').addEventListener('click', () => { panel.hidden = true; });
    // Un seul geste : enregistrer, puis essayer de se connecter. Le panneau
    // reste ouvert pendant l'essai et ne se ferme qu'en cas de succès, avec
    // les champs intacts en cas d'échec.
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (saveButton.disabled) return;
      const input = Object.fromEntries(new FormData(form)); if (current) input.id = current.id;
      input[input.kind === 'openclaw' ? 'password' : 'token'] = input.credential; delete input.credential;
      saveButton.disabled = true; saveButton.textContent = 'Connexion…';
      setStatus('busy', isOpenclaw() ? 'Enregistré. Connexion à la passerelle… (jusqu’à 30 secondes)' : 'Enregistré. Vérification du serveur…');
      try {
        const saved = await request('/connections', { method: 'POST', json: input });
        state.selected = saved.id;
        if (state.thread?.connectionId !== saved.id) state.thread = null;
        await refresh(); current = connection();
        const result = await testConnection(saved.id);
        await refresh();
        if (result.ok) { panel.hidden = true; render(); showToast(`Connecté à ${saved.name || input.name}.`); return; }
        const pairing = current?.gateway?.state === 'awaiting_approval';
        setStatus(pairing ? 'warn' : 'bad', result.message || 'Connexion impossible.');
        form.elements.credential.placeholder = 'Déjà enregistré · laisser vide pour le garder';
      } catch (error) { setStatus('bad', error.message); }
      finally { saveButton.disabled = false; saveButton.textContent = 'Enregistrer et connecter'; }
    });
  }
  // `command` is text sent as is (a model change or a queued message);
  // `queuedReply` and `queuedFiles` were captured when it was queued.
  async function send(event, command, queuedReply, queuedFiles) {
    event?.preventDefault(); const thread = state.thread, input = element('[data-prompt]'), text = command ?? input.value.trim();
    const files = command !== undefined ? queuedFiles || [] : pendingFiles.get(thread?.id) || [];
    if ((!text && !files.length) || !thread || thread.readOnly || thread.active || streams.has(thread.id)) return;
    const reply = command !== undefined ? queuedReply || null : replies.get(thread.id), destination = reply?.conversationId || thread.id;
    if (command === undefined) { replies.delete(thread.id); renderReply(); drafts.delete(thread.id); input.value = ''; pendingFiles.delete(thread.id); renderPendingFiles(); }
    const controller = new AbortController(); streams.set(thread.id, { controller, thread, startedAt: Date.now() });
    const createdAt = new Date().toISOString(), answer = { role: 'assistant', content: '', status: 'streaming', createdAt, conversationId: destination };
    const sent = { role: 'user', content: text, status: 'complete', createdAt, conversationId: destination, ...(files.length ? { attachments: files.map(({ fileName, mimeType, size, preview }) => ({ name: fileName, mimeType, size, preview })) } : {}) };
    thread.messages.push(sent, answer); renderMessages();
    let receivedDone = false;
    try {
      const body = { text, ...(files.length ? { attachments: files.map(({ fileName, mimeType, content, preview }) => ({ fileName, mimeType, content, preview })) } : {}) };
      const response = await fetch('/api/agents/conversations/' + destination + '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
      if (!response.ok) {
        // Refused before anything was sent (size, type…): give the files back.
        if (files.length && !pendingFiles.get(thread.id)?.length) { pendingFiles.set(thread.id, files); thread.messages.splice(thread.messages.indexOf(sent), 1); renderPendingFiles(); }
        throw new Error((await response.json().catch(() => ({}))).error || (response.status === 413 ? 'Pièces jointes trop volumineuses.' : 'Envoi impossible.'));
      }
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const { value, done } = await reader.read(); buffer += done ? decoder.decode() : decoder.decode(value, { stream: true }); let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const line = frame.split('\n').find(line => line.startsWith('data: ')); if (!line) continue;
          const data = JSON.parse(line.slice(6));
          if (frame.startsWith('event: error')) throw new Error(data.message);
          if (frame.startsWith('event: done')) receivedDone = true;
          if (frame.startsWith('event: delta') || frame.startsWith('event: replace')) { answer.content = frame.startsWith('event: replace') ? data.text : answer.content + data.text; if (state.thread?.id === thread.id) renderMessages(true); }
        }
        if (done) break;
      }
      if (!receivedDone) throw new Error('La réception a été interrompue. Le message ne sera pas renvoyé automatiquement.');
    } catch (error) {
      if (controller.signal.aborted) { answer.status = 'interrupted'; answer.error = 'Réception arrêtée. L’agent distant peut continuer ses actions.'; }
      else { answer.status = 'failed'; answer.error = error.message; showToast(error.message, 'error'); }
    }
    finally {
      streams.delete(thread.id);
      try {
        const persisted = await request(contactPath(thread));
        if (state.thread?.id === thread.id) { state.thread = persisted; renderMessages(true); await acknowledge(persisted); }
        await refresh(); renderList();
      } catch (error) { status(error.message); }
    }
  }
  async function syncVisible() {
    await refresh();
    if (!loaded || !isOpen() || element('[data-setup]')?.hidden === false) return;
    renderList(); const thread = state.thread;
    if (thread && !streams.has(thread.id) && !loading) {
      const updated = await request(contactPath(thread));
      if (state.thread?.id !== thread.id || streams.has(thread.id)) return;
      state.thread = updated; renderMessages(true); await acknowledge(updated);
    } else if (!thread && document.activeElement !== element('[data-search]')) render();
  }
  async function showAgents() {
    document.querySelectorAll('[data-workspace]').forEach(tab => tab.classList.toggle('active', tab.dataset.workspace === 'agents'));
    document.getElementById('dashboard').hidden = true; root.hidden = false; document.body.classList.add('agents-visible'); syncSpotifyPolling();
    if (!loaded) { await refresh(); loaded = true; render(); } else await syncVisible();
  }
  document.querySelectorAll('[data-workspace]').forEach(button => button.addEventListener('click', safely(async () => {
    if (button.dataset.workspace === 'agents') await showAgents();
    else { rememberDraft(); root.hidden = true; document.getElementById('dashboard').hidden = false; document.body.classList.remove('agents-visible'); document.querySelectorAll('[data-workspace]').forEach(tab => tab.classList.toggle('active', tab === button)); syncSpotifyPolling(); }
  })));
  const events = new EventSource('/api/agents/events');
  events.addEventListener('inbox', () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => syncVisible().catch(() => {}), 300); });
  window.widget?.onAgentInbox?.(safely(async target => { await showAgents(); if (target?.connectionId && target.sessionKey) { state.selected = target.connectionId; await openThread({ agentId: target.agentId, sessionKey: target.sessionKey }); } }));
  document.addEventListener('visibilitychange', () => { if (isOpen()) syncVisible().catch(() => {}); });
  setInterval(() => { if (isOpen() && state.thread?.active && !streams.has(state.thread.id)) syncVisible().catch(() => {}); }, 4000);
  setInterval(() => { const clockNode = element('[data-elapsed]'); if (clockNode && isOpen()) clockNode.textContent = elapsed(Number(clockNode.dataset.elapsed)); }, 1000);
  document.addEventListener('click', event => { if (!event.target.closest('[data-model-menu],[data-model-open]')) closeModelMenu(); });
  // Ctrl K (emitted by app.js) focuses the agent search while the list is shown.
  Bus.on('focus-search', () => { const input = element('[data-search]'); if (isOpen() && input && input.offsetParent) { input.focus(); input.select(); } });
  refresh().catch(() => {});
})();
