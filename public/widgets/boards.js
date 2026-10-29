'use strict';

/* ════════════════════════════════════════
   Widget Boards — articles mis de côté
   ════════════════════════════════════════ */
Dashboard.register({
  type: 'boards',
  name: 'Boards',
  icon: 'i-bookmark',
  description: 'Vos collections d\'articles sauvegardés.',
  singleton: true,

  mount(ctx) {
    ctx.body.innerHTML = `
      <div data-list></div>
      <form class="add-row compact" data-form>
        <input type="text" data-name placeholder="Nouveau board…" required>
        <button type="submit" class="btn primary icon-only" title="Créer">${icon('i-plus', 'ic-sm')}</button>
      </form>
    `;

    const list = ctx.body.querySelector('[data-list]');
    const form = ctx.body.querySelector('[data-form]');
    const nameInput = ctx.body.querySelector('[data-name]');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = nameInput.value.trim();
      if (!name) return;
      nameInput.value = '';
      await createBoardNamed(name);
    });

    function render() {
      const boards = Store.boards;
      const total = boards.reduce((sum, b) => sum + b.items.length, 0);
      ctx.summary(`${boards.length} board${boards.length > 1 ? 's' : ''} · ${total} article${total > 1 ? 's' : ''}`);

      if (boards.length === 0) {
        list.innerHTML = `<div class="empty compact">${icon('i-bookmark')}<div>Aucun board</div><p>Créez-en un pour collecter vos articles.</p></div>`;
        return;
      }
      list.innerHTML = boards.map((b) => `
        <div class="board-card" onclick="openBoard('${escAttr(b.id)}')">
          <span class="board-icon">${esc(b.icon)}</span>
          <div class="board-info">
            <div class="board-name">${esc(b.name)}</div>
            <div class="board-count">${b.items.length} article${b.items.length > 1 ? 's' : ''}</div>
          </div>
          <button class="ghost-btn danger" onclick="event.stopPropagation(); confirmClick(this, 'deleteBoard', '${escAttr(b.id)}')" title="Supprimer le board">
            ${icon('i-trash')}
          </button>
        </div>
      `).join('');
    }

    ctx.on('boards', render);
    render();
  },
});
