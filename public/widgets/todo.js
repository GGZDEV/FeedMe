'use strict';

/* ════════════════════════════════════════
   Widget To-do
   ──────────────────────────────────────────
   Stocké côté serveur (todos.json) plutôt qu'en localStorage : une liste de
   tâches est une donnée qu'on ne veut pas perdre en vidant le cache du
   navigateur intégré.
   ════════════════════════════════════════ */
Dashboard.register({
  type: 'todo',
  name: 'To-do',
  icon: 'i-check-square',
  description: 'Une liste de tâches simple, conservée avec vos autres réglages.',
  singleton: true,
  defaults: { hideDone: false },

  mount(ctx) {
    ctx.body.innerHTML = `
      <form class="add-row compact" data-form>
        <input type="text" data-title placeholder="Nouvelle tâche…" required>
        <button type="submit" class="btn primary icon-only" title="Ajouter">${icon('i-plus', 'ic-sm')}</button>
      </form>
      <div data-list></div>
    `;
    const list = ctx.body.querySelector('[data-list]');
    const form = ctx.body.querySelector('[data-form]');
    const input = ctx.body.querySelector('[data-title]');
    let todos = [];

    ctx.tools(`
      <button class="widget-btn" data-hide-done title="Masquer / afficher les tâches faites">${icon('i-eye-off', 'ic-sm')}</button>
      <button class="widget-btn" data-purge title="Supprimer les tâches faites">${icon('i-trash', 'ic-sm')}</button>
    `);
    const tool = (sel) => ctx.root.querySelector(sel);
    tool('[data-hide-done]').addEventListener('click', () => {
      ctx.settings.hideDone = !ctx.settings.hideDone;
      ctx.save();
      tool('[data-hide-done]').classList.toggle('on', ctx.settings.hideDone);
      render();
    });
    tool('[data-purge]').addEventListener('click', (e) => {
      confirmClick(e.currentTarget, 'todoPurge');
    });
    tool('[data-hide-done]').classList.toggle('on', !!ctx.settings.hideDone);

    async function load() {
      try {
        todos = await api('/api/todos');
      } catch (e) {
        todos = [];
      }
      render();
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      input.value = '';
      // Insertion optimiste : la saisie enchaînée ne doit pas attendre le réseau.
      todos.unshift({ id: `tmp-${Date.now()}`, title, done: false, pending: true });
      render();
      try {
        await api('/api/todos', { method: 'POST', json: { title } });
      } catch (err) {
        showToast(err.message, 'error');
      }
      load();
    });

    function render() {
      const open = todos.filter((t) => !t.done).length;
      const done = todos.length - open;
      ctx.summary(todos.length === 0
        ? 'aucune tâche'
        : `<strong>${open}</strong> à faire${done ? ` · ${done} faite${done > 1 ? 's' : ''}` : ''}`);

      if (ctx.isCollapsed()) return;

      const visible = ctx.settings.hideDone ? todos.filter((t) => !t.done) : todos;
      if (visible.length === 0) {
        list.innerHTML = `<div class="empty compact">${icon('i-check-square')}<div>${
          todos.length ? 'Tout est fait' : 'Aucune tâche'}</div></div>`;
        return;
      }

      // Les tâches faites descendent, sans réordonner côté serveur.
      const sorted = [...visible].sort((a, b) => Number(a.done) - Number(b.done));
      list.innerHTML = `<div class="todo-list">${sorted.map((t) => `
        <div class="todo-item${t.done ? ' done' : ''}${t.pending ? ' pending' : ''}" data-id="${escAttr(t.id)}">
          <button class="todo-check" data-toggle="${escAttr(t.id)}" title="${t.done ? 'Rouvrir' : 'Marquer comme faite'}">
            ${t.done ? icon('i-check', 'ic-sm') : ''}
          </button>
          <span class="todo-title">${esc(t.title)}</span>
          <button class="action-btn" data-del="${escAttr(t.id)}" title="Supprimer">${icon('i-trash')}</button>
        </div>`).join('')}</div>`;

      for (const btn of list.querySelectorAll('[data-toggle]')) {
        btn.addEventListener('click', async () => {
          const todo = todos.find((t) => t.id === btn.dataset.toggle);
          if (!todo || todo.pending) return;
          todo.done = !todo.done;
          render();
          try {
            await api(`/api/todos/${encodeURIComponent(todo.id)}`, { method: 'PATCH', json: { done: todo.done } });
          } catch (e) {
            todo.done = !todo.done;
            render();
            showToast(e.message, 'error');
          }
        });
      }
      for (const btn of list.querySelectorAll('[data-del]')) {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.del;
          try {
            await api(`/api/todos/${encodeURIComponent(id)}`, { method: 'DELETE' });
            todos = todos.filter((t) => t.id !== id);
            render();
          } catch (e) {
            showToast(e.message, 'error');
          }
        });
      }
    }

    window.todoPurge = async () => {
      try {
        await api('/api/todos', { method: 'DELETE' });
        showToast('Tâches faites supprimées');
        load();
      } catch (e) {
        showToast(e.message, 'error');
      }
    };

    ctx.repaint = render;
    render();
    load();
  },

  onExpand(ctx) { ctx.repaint?.(); },
});
