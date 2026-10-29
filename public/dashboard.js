'use strict';

/* ════════════════════════════════════════
   Dashboard — socle modulaire
   ──────────────────────────────────────────
   Chaque bloc de l'interface est un widget indépendant : on l'ajoute, on le
   retire, on le replie sur une ligne, on le déplace au doigt. La disposition
   vit dans localStorage, les widgets ne connaissent que leur propre corps.

   Un widget se déclare ainsi :

     Dashboard.register({
       type: 'todo',
       name: 'To-do',
       icon: 'i-check-square',
       description: 'Une liste de tâches simple.',
       singleton: true,             // une seule instance permise
       defaults: { hideDone: false } // réglages initiaux
       mount(ctx)   { ... }         // appelé une fois, à l'insertion
       destroy(ctx) { ... }         // nettoyage (les on()/every() sont auto-purgés)
     });

   Le contexte fourni au widget :
     ctx.body       élément DOM du corps (à remplir librement)
     ctx.settings   objet de réglages persisté
     ctx.save()     persiste les réglages
     ctx.summary(html)   ligne affichée quand le widget est replié
     ctx.tools(html)     boutons ajoutés dans l'en-tête
     ctx.center(html)    zone centrée de l'en-tête (masquée au repli)
     ctx.on(topic, fn)   abonnement au Bus, résilié au démontage
     ctx.every(fn, ms)   intervalle, arrêté au démontage
     ctx.isCollapsed()   true si replié (inutile de rendre le corps)
   ════════════════════════════════════════ */

const Dashboard = (() => {
  const LAYOUT_KEY = 'fm-dashboard-v1';
  const registry = new Map();
  const instances = new Map(); // id -> instance vivante
  let layout = [];             // [{ id, type, collapsed, settings }]
  let container = null;

  /* ── Disposition par défaut ── */
  const DEFAULT_LAYOUT = [
    { type: 'system' },
    { type: 'ai-usage' },
    { type: 'spotify' },
    { type: 'rss' },
  ];

  function uid() {
    return 'w' + Math.random().toString(36).slice(2, 9);
  }

  function loadLayout() {
    try {
      const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
      if (Array.isArray(raw) && raw.length) {
        // Un type retiré du code (widget supprimé d'une version à l'autre)
        // resterait sinon dans la disposition, invisible et impossible à
        // enlever. Tous les widgets sont enregistrés avant init(), donc un type
        // inconnu ici est bien un type disparu.
        const kept = raw.filter((w) => registry.has(w.type));
        if (kept.length) {
          if (!localStorage.getItem('fm-ai-usage-introduced')) {
            if (!kept.some(w => w.type === 'ai-usage')) kept.splice(1, 0, { id: uid(), type: 'ai-usage', collapsed: false, settings: {} });
            localStorage.setItem('fm-ai-usage-introduced', '1');
          }
          return kept;
        }
      }
    } catch (e) { /* disposition illisible : on repart du défaut */ }
    localStorage.setItem('fm-ai-usage-introduced', '1');
    return DEFAULT_LAYOUT.map((w) => ({ id: uid(), collapsed: false, settings: {}, ...w }));
  }

  function saveLayout() {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  }

  /* ════════════════════════════════════════
     Construction d'un widget
     ════════════════════════════════════════ */
  function buildWidget(entry) {
    const def = registry.get(entry.type);
    if (!def) return null;

    const root = document.createElement('section');
    root.className = 'widget';
    root.dataset.id = entry.id;
    root.dataset.type = entry.type;
    if (entry.collapsed) root.classList.add('collapsed');

    root.innerHTML = `
      <header class="widget-head">
        <span class="widget-grip" title="Glisser pour déplacer">${icon('i-grip', 'ic-sm')}</span>
        <span class="widget-icon">${icon(def.icon || 'i-layout', 'ic-sm')}</span>
        <span class="widget-name">${esc(def.name)}</span>
        <span class="widget-center"></span>
        <span class="widget-summary"></span>
        <span class="widget-tools"></span>
        <button class="widget-btn widget-fold" title="Replier / déplier">${icon('i-chevron', 'ic-sm')}</button>
        <button class="widget-btn widget-remove" title="Retirer ce widget">${icon('i-x', 'ic-sm')}</button>
      </header>
      <div class="widget-body"></div>
    `;

    const body = root.querySelector('.widget-body');
    const summaryEl = root.querySelector('.widget-summary');
    const toolsEl = root.querySelector('.widget-tools');
    const centerEl = root.querySelector('.widget-center');

    const disposers = [];
    const timers = [];

    const ctx = {
      id: entry.id,
      type: entry.type,
      def,
      root,
      body,
      settings: { ...(def.defaults || {}), ...(entry.settings || {}) },
      save() {
        entry.settings = { ...ctx.settings };
        saveLayout();
      },
      summary(html) { summaryEl.innerHTML = html || ''; },
      tools(html) { toolsEl.innerHTML = html || ''; },
      // Zone centrée de l'en-tête, indépendante du nom et des boutons. Masquée
      // quand le widget est replié, où la place revient au résumé.
      center(html) { centerEl.innerHTML = html || ''; },
      on(topic, fn) { disposers.push(Bus.on(topic, fn)); },
      every(fn, ms) { timers.push(setInterval(() => {
        if (!document.hidden && !container.hidden) fn();
      }, ms)); },
      isCollapsed() { return root.classList.contains('collapsed'); },
      setBusy(on) { root.classList.toggle('busy', !!on); },
    };

    const instance = { entry, def, ctx, root, disposers, timers };
    instances.set(entry.id, instance);

    root.querySelector('.widget-fold').addEventListener('click', () => toggleCollapse(entry.id));
    root.querySelector('.widget-remove').addEventListener('click', (e) => {
      confirmClick(e.currentTarget, 'dashboardRemoveWidget', entry.id);
    });
    // Double-clic sur l'en-tête : repli rapide, comme une fenêtre.
    root.querySelector('.widget-head').addEventListener('dblclick', (e) => {
      if (e.target.closest('button') || e.target.closest('.widget-tools')) return;
      toggleCollapse(entry.id);
    });

    attachDrag(root, entry.id);

    try {
      def.mount?.(ctx);
    } catch (e) {
      console.error(`[widget:${entry.type}]`, e);
      body.innerHTML = `<div class="widget-error">${icon('i-x')} Ce widget n'a pas pu démarrer.</div>`;
    }
    return root;
  }

  function destroyWidget(id) {
    const inst = instances.get(id);
    if (!inst) return;
    for (const off of inst.disposers) off();
    for (const t of inst.timers) clearInterval(t);
    try { inst.def.destroy?.(inst.ctx); } catch (e) { console.error(e); }
    inst.root.remove();
    instances.delete(id);
  }

  /* ════════════════════════════════════════
     Rendu & mutations
     ════════════════════════════════════════ */
  function render() {
    container.innerHTML = '';
    for (const id of [...instances.keys()]) destroyWidget(id);
    for (const entry of layout) {
      const node = buildWidget(entry);
      if (node) container.appendChild(node);
    }
    renderEmptyState();
  }

  function renderEmptyState() {
    const existing = container.querySelector('.dashboard-empty');
    if (existing) existing.remove();
    if (layout.length > 0) return;
    const el = document.createElement('div');
    el.className = 'empty dashboard-empty';
    el.innerHTML = `${icon('i-layout')}<div>Dashboard vide</div><p>Ajoutez vos premiers widgets pour composer votre tableau de bord.</p>
      <button class="btn primary" style="margin-top:14px" onclick="openWidgetLibrary()">${icon('i-plus', 'ic-sm')} Ajouter un widget</button>`;
    container.appendChild(el);
  }

  function addWidget(type, settings = {}) {
    const def = registry.get(type);
    if (!def) return;
    if (def.singleton && layout.some((w) => w.type === type)) {
      showToast(`${def.name} est déjà sur votre dashboard`, 'error');
      return;
    }
    const entry = { id: uid(), type, collapsed: false, settings };
    layout.push(entry);
    saveLayout();
    container.querySelector('.dashboard-empty')?.remove();
    const node = buildWidget(entry);
    if (node) {
      container.appendChild(node);
      node.classList.add('just-added');
      node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      setTimeout(() => node.classList.remove('just-added'), 700);
    }
    showToast(`${def.name} ajouté`);
    Bus.emit('layout', layout);
  }

  function removeWidget(id) {
    const index = layout.findIndex((w) => w.id === id);
    if (index === -1) return;
    const name = registry.get(layout[index].type)?.name || 'Widget';
    destroyWidget(id);
    layout.splice(index, 1);
    saveLayout();
    renderEmptyState();
    showToast(`${name} retiré`);
    Bus.emit('layout', layout);
  }

  function toggleCollapse(id) {
    const entry = layout.find((w) => w.id === id);
    const inst = instances.get(id);
    if (!entry || !inst) return;
    entry.collapsed = !entry.collapsed;
    inst.root.classList.toggle('collapsed', entry.collapsed);
    saveLayout();
    // Certains widgets (graphes, canvas) ont besoin de se remesurer au dépliage.
    if (!entry.collapsed) inst.def.onExpand?.(inst.ctx);
  }

  /* ════════════════════════════════════════
     Réordonnancement par glisser-déposer
     ──────────────────────────────────────────
     Pointer events plutôt que l'API HTML5 : contrôle total du rendu (le widget
     suit le doigt, un fantôme garde la place) et pas d'image de drag native
     dans une fenêtre sans cadre.
     ════════════════════════════════════════ */
  function attachDrag(root, id) {
    const grip = root.querySelector('.widget-grip');
    const head = root.querySelector('.widget-head');

    const onPointerDown = (e) => {
      if (e.button !== 0) return;
      // Le corps du widget reste interactif : seuls la poignée et les zones
      // neutres de l'en-tête démarrent un déplacement.
      if (e.target.closest('button') || e.target.closest('.widget-tools')) return;
      if (!grip.contains(e.target) && !isNeutralHeaderZone(e.target)) return;
      startDrag(e, root, id);
    };

    grip.addEventListener('pointerdown', onPointerDown);
    head.addEventListener('pointerdown', onPointerDown);
  }

  function isNeutralHeaderZone(target) {
    return target.classList?.contains('widget-head')
      || target.classList?.contains('widget-name')
      || target.classList?.contains('widget-icon')
      || target.classList?.contains('widget-summary');
  }

  let drag = null;

  function startDrag(event, root, id) {
    const startY = event.clientY;
    const rect = root.getBoundingClientRect();

    drag = {
      id, root, startY,
      offsetY: startY - rect.top,
      width: rect.width,
      left: rect.left,
      started: false,
      placeholder: null,
      pointerId: event.pointerId,
    };

    // On capture sur document : le pointeur sort vite du widget d'origine
    // puisque celui-ci passe en position fixe.
    document.addEventListener('pointermove', onDragMove);
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);
  }

  function beginActualDrag() {
    const { root, width, left } = drag;
    const rect = root.getBoundingClientRect();

    const placeholder = document.createElement('div');
    placeholder.className = 'widget-placeholder';
    placeholder.style.height = `${rect.height}px`;
    root.parentNode.insertBefore(placeholder, root);
    drag.placeholder = placeholder;

    root.classList.add('dragging');
    root.style.width = `${width}px`;
    root.style.left = `${left}px`;
    root.style.position = 'fixed';
    root.style.zIndex = '900';
    root.style.pointerEvents = 'none';
    document.body.classList.add('dragging-widget');
    drag.started = true;
  }

  function onDragMove(event) {
    if (!drag) return;
    const dy = event.clientY - drag.startY;
    if (!drag.started) {
      if (Math.abs(dy) < 5) return; // seuil : un clic simple reste un clic
      beginActualDrag();
    }

    event.preventDefault();
    drag.root.style.top = `${event.clientY - drag.offsetY}px`;

    // Position d'insertion : premier widget dont le milieu passe sous le curseur.
    const siblings = [...container.querySelectorAll('.widget:not(.dragging)')];
    let before = null;
    for (const node of siblings) {
      const box = node.getBoundingClientRect();
      if (event.clientY < box.top + box.height / 2) { before = node; break; }
    }
    if (before) container.insertBefore(drag.placeholder, before);
    else container.appendChild(drag.placeholder);

    autoScroll(event.clientY);
  }

  // Déplacer vers un widget hors écran doit faire défiler la colonne.
  function autoScroll(clientY) {
    const box = container.getBoundingClientRect();
    const margin = 60;
    if (clientY < box.top + margin) container.scrollTop -= Math.ceil((box.top + margin - clientY) / 6);
    else if (clientY > box.bottom - margin) container.scrollTop += Math.ceil((clientY - (box.bottom - margin)) / 6);
  }

  function endDrag() {
    document.removeEventListener('pointermove', onDragMove);
    document.removeEventListener('pointerup', endDrag);
    document.removeEventListener('pointercancel', endDrag);
    if (!drag) return;

    if (drag.started) {
      const { root, placeholder } = drag;
      root.classList.remove('dragging');
      root.style.cssText = '';
      placeholder.parentNode.insertBefore(root, placeholder);
      placeholder.remove();
      document.body.classList.remove('dragging-widget');

      // L'ordre du DOM fait foi : on recompose la disposition depuis lui.
      const order = [...container.querySelectorAll('.widget')].map((n) => n.dataset.id);
      layout.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      saveLayout();
      Bus.emit('layout', layout);

      root.classList.add('just-dropped');
      setTimeout(() => root.classList.remove('just-dropped'), 400);
    }
    drag = null;
  }

  /* ════════════════════════════════════════
     Bibliothèque de widgets
     ════════════════════════════════════════ */
  function renderLibrary() {
    const list = document.getElementById('library-list');
    if (!list) return;
    const defs = [...registry.values()];
    list.innerHTML = defs.map((def) => {
      const count = layout.filter((w) => w.type === def.type).length;
      const maxed = def.singleton && count > 0;
      return `
        <div class="library-card${maxed ? ' added' : ''}">
          <span class="library-icon">${icon(def.icon || 'i-layout')}</span>
          <div class="library-info">
            <div class="library-name">${esc(def.name)}${maxed ? ` <span class="badge accent">Sur le dashboard</span>` : ''}</div>
            <div class="library-desc">${esc(def.description || '')}</div>
          </div>
          <button class="btn ${maxed ? '' : 'primary'} icon-only"
                  ${maxed ? 'disabled' : ''}
                  title="${maxed ? 'Déjà ajouté' : 'Ajouter au dashboard'}"
                  onclick="dashboardAddWidget('${escAttr(def.type)}')">
            ${icon(maxed ? 'i-check' : 'i-plus', 'ic-sm')}
          </button>
        </div>`;
    }).join('');
  }

  /* ════════════════════════════════════════
     API publique
     ════════════════════════════════════════ */
  return {
    register(def) {
      if (!def?.type) throw new Error('Un widget doit avoir un type');
      registry.set(def.type, def);
    },
    init(el) {
      container = el;
      layout = loadLayout();
      saveLayout(); // fige la disposition par défaut au premier lancement
      render();
    },
    add: addWidget,
    remove: removeWidget,
    toggleCollapse,
    renderLibrary,
    hasType(type) { return layout.some((w) => w.type === type); },
    countType(type) { return layout.filter((w) => w.type === type).length; },
    reset() {
      layout = DEFAULT_LAYOUT.map((w) => ({ id: uid(), collapsed: false, settings: {}, ...w }));
      saveLayout();
      render();
      showToast('Disposition réinitialisée');
    },
    get layout() { return layout; },
  };
})();

/* Handlers globaux (référencés par les onclick du HTML) */
function dashboardAddWidget(type) {
  Dashboard.add(type);
  Dashboard.renderLibrary();
}
function dashboardRemoveWidget(id) {
  Dashboard.remove(id);
  Dashboard.renderLibrary();
}
function openWidgetLibrary() {
  Dashboard.renderLibrary();
  document.getElementById('library-panel').classList.add('open');
}
function closeWidgetLibrary() {
  document.getElementById('library-panel').classList.remove('open');
}
function resetDashboard() {
  Dashboard.reset();
  Dashboard.renderLibrary();
}
