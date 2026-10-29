'use strict';

/* ════════════════════════════════════════
   Widget RSS — le fil d'articles
   ──────────────────────────────────────────
   Quatre couches de filtrage se composent, dans cet ordre :
     1. sources masquées (préférence durable)
     2. catégorie / favoris / non lus (le sélecteur de vue)
     3. mots-clés inclus puis exclus
     4. recherche plein texte (côté serveur)
   Le regroupement par sujet s'applique après, sur ce qui reste.
   ════════════════════════════════════════ */
Dashboard.register({
  type: 'rss',
  name: 'Flux RSS',
  icon: 'i-rss',
  description: 'Vos articles, avec résumés IA, regroupement par sujet, filtres et favoris.',
  singleton: true,
  defaults: {
    view: 'all',          // all | unread | favorites | <nom de catégorie>
    pageSize: 20,
    showImages: true,
    summaries: false,
    grouped: false,
    include: [],
    exclude: [],
    showFilters: false,
  },

  mount(ctx) {
    let shown = ctx.settings.pageSize;
    let onboardingTab = 'feedly';

    ctx.body.innerHTML = `
      <div class="rss-controls">
        <label class="rss-search">
          ${icon('i-search')}
          <input type="text" data-search placeholder="Rechercher" aria-label="Rechercher dans les articles">
          <span class="kbd" aria-hidden="true">Ctrl K</span>
          <button type="button" class="rss-search-clear" data-clear hidden aria-label="Effacer la recherche">${icon('i-x', 'ic-sm')}</button>
        </label>
      </div>
      <div class="kw-panel" data-kw hidden>
        <div class="kw-group">
          <span class="kw-label">${icon('i-check', 'ic-xs')} Ne garder que</span>
          <div class="kw-chips" data-kw-include></div>
          <form class="kw-form" data-kw-form="include">
            <input type="text" placeholder="mot-clé…" spellcheck="false">
          </form>
        </div>
        <div class="kw-group">
          <span class="kw-label">${icon('i-x', 'ic-xs')} Exclure</span>
          <div class="kw-chips" data-kw-exclude></div>
          <form class="kw-form" data-kw-form="exclude">
            <input type="text" placeholder="mot-clé…" spellcheck="false">
          </form>
        </div>
      </div>
      <div class="filters" data-filters></div>
      <div data-list></div>
    `;

    // Les options d'affichage vivent à côté de la recherche : l'en-tête est
    // déjà occupé par le tri.
    ctx.body.querySelector('.rss-controls').insertAdjacentHTML('beforeend', `
      <div class="rss-tools">
        <button class="widget-btn" data-summaries title="Résumés IA" aria-label="Résumés IA">${icon('i-sparkle', 'ic-sm')}</button>
        <button class="widget-btn" data-grouped title="Regrouper par sujet" aria-label="Regrouper par sujet">${icon('i-grid', 'ic-sm')}</button>
        <button class="widget-btn" data-kw-toggle title="Filtrer par mots-clés" aria-label="Filtrer par mots-clés">${icon('i-settings', 'ic-sm')}</button>
        <button class="widget-btn" data-images title="Afficher / masquer les visuels" aria-label="Afficher / masquer les visuels">${icon('i-layout', 'ic-sm')}</button>
        <button class="widget-btn" data-reload title="Rafraîchir les flux" aria-label="Rafraîchir les flux">${icon('i-refresh', 'ic-sm')}</button>
      </div>`);

    // Le tri vit dans l'en-tête du widget.
    ctx.center(`
      <div class="segmented" role="group" aria-label="Tri des articles">
        <button class="seg${Store.sort === 'popularity' ? '' : ' active'}" data-sort="date" title="Articles les plus récents">Récent</button>
        <button class="seg${Store.sort === 'popularity' ? ' active' : ''}" data-sort="popularity" title="Sujets repris par plusieurs sources">Tendances</button>
      </div>`);

    const q = (sel) => ctx.body.querySelector(sel);
    const listEl = q('[data-list]');
    const filtersEl = q('[data-filters]');
    const kwPanel = q('[data-kw]');
    const searchInput = q('[data-search]');
    const clearBtn = q('[data-clear]');
    const tool = (sel) => ctx.root.querySelector(sel);

    /* ── Boutons d'en-tête ── */
    tool('[data-reload]').addEventListener('click', refresh);

    tool('[data-images]').addEventListener('click', () => {
      ctx.settings.showImages = !ctx.settings.showImages;
      ctx.save();
      render();
    });

    tool('[data-summaries]').addEventListener('click', () => {
      ctx.settings.summaries = !ctx.settings.summaries;
      ctx.save();
      syncToolStates();
      render();
    });

    tool('[data-grouped]').addEventListener('click', () => {
      ctx.settings.grouped = !ctx.settings.grouped;
      ctx.save();
      syncToolStates();
      if (ctx.settings.grouped && Store.clusters.length === 0) fetchClusters();
      render();
    });

    tool('[data-kw-toggle]').addEventListener('click', () => {
      ctx.settings.showFilters = !ctx.settings.showFilters;
      ctx.save();
      syncToolStates();
      renderKeywords();
    });

    function syncToolStates() {
      tool('[data-summaries]').classList.toggle('on', ctx.settings.summaries);
      tool('[data-grouped]').classList.toggle('on', ctx.settings.grouped);
      tool('[data-kw-toggle]').classList.toggle('on', hasKeywords() || ctx.settings.showFilters);
    }

    /* ── Recherche ── */
    let searchTimer;
    searchInput.addEventListener('input', () => {
      clearBtn.hidden = !searchInput.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        Store.query = searchInput.value.trim();
        shown = ctx.settings.pageSize;
        fetchArticles();
      }, 300);
    });
    clearBtn.addEventListener('click', resetSearch);
    ctx.on('focus-search', () => {
      if (ctx.isCollapsed()) Dashboard.toggleCollapse(ctx.id);
      searchInput.focus();
      searchInput.select();
    });
    ctx.on('escape', () => { if (searchInput.value) resetSearch(); });

    function resetSearch() {
      searchInput.value = '';
      clearBtn.hidden = true;
      Store.query = '';
      fetchArticles();
    }

    /* ── Tri ── */
    for (const btn of ctx.root.querySelectorAll('[data-sort]')) {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.sort;
        if (Store.sort === mode) return;
        Store.sort = mode;
        for (const b of ctx.root.querySelectorAll('[data-sort]')) {
          b.classList.toggle('active', b.dataset.sort === mode);
        }
        shown = ctx.settings.pageSize;
        fetchArticles();
      });
    }

    // Défilement horizontal des filtres à la molette
    filtersEl.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (filtersEl.scrollWidth <= filtersEl.clientWidth) return;
      e.preventDefault();
      filtersEl.scrollLeft += e.deltaY;
    }, { passive: false });

    /* ── Mots-clés ── */
    function hasKeywords() {
      return ctx.settings.include.length > 0 || ctx.settings.exclude.length > 0;
    }

    for (const form of ctx.body.querySelectorAll('[data-kw-form]')) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = form.querySelector('input');
        const word = input.value.trim().toLowerCase();
        if (!word) return;
        const list = ctx.settings[form.dataset.kwForm];
        if (!list.includes(word)) list.push(word);
        input.value = '';
        ctx.save();
        shown = ctx.settings.pageSize;
        renderKeywords();
        render();
      });
    }

    function renderKeywords() {
      kwPanel.hidden = !ctx.settings.showFilters;
      syncToolStates();
      if (kwPanel.hidden) return;
      for (const kind of ['include', 'exclude']) {
        const host = q(`[data-kw-${kind}]`);
        host.innerHTML = ctx.settings[kind].map((word) => `
          <button class="kw-chip" data-drop="${escAttr(word)}" data-kind="${kind}" title="Retirer">
            ${esc(word)} ${icon('i-x', 'ic-xs')}
          </button>`).join('');
        for (const btn of host.querySelectorAll('[data-drop]')) {
          btn.addEventListener('click', () => {
            const list = ctx.settings[btn.dataset.kind];
            list.splice(list.indexOf(btn.dataset.drop), 1);
            ctx.save();
            renderKeywords();
            render();
          });
        }
      }
    }

    function matchesKeywords(a) {
      const haystack = `${a.title || ''} ${a.description || ''} ${Store.summaries[a.id] || ''}`.toLowerCase();
      const { include, exclude } = ctx.settings;
      // Inclusion : au moins un des mots (un OU, pas un ET — sinon deux
      // mots-clés vident presque toujours le fil).
      if (include.length && !include.some((w) => haystack.includes(w))) return false;
      if (exclude.some((w) => haystack.includes(w))) return false;
      return true;
    }

    /* ── Sélection des articles ── */
    function visibleArticles() {
      const view = ctx.settings.view;
      return Store.articles.filter((a) => {
        if (isSourceHidden(a.source)) return false;
        if (view === 'unread' && isRead(a.id)) return false;
        if (view === 'favorites' && !isFavorite(a.id)) return false;
        if (view !== 'all' && view !== 'unread' && view !== 'favorites' && a.category !== view) return false;
        return matchesKeywords(a);
      });
    }

    function renderFilters() {
      const view = ctx.settings.view;
      const cats = [...new Set(Store.articles.filter((a) => !isSourceHidden(a.source)).map((a) => a.category))];
      const unread = Store.articles.filter((a) => !isRead(a.id) && !isSourceHidden(a.source)).length;
      const favs = Store.articles.filter((a) => isFavorite(a.id)).length;

      filtersEl.innerHTML = `
        <button class="chip ${view === 'all' ? 'active' : ''}" data-view="all">Tout</button>
        <button class="chip ${view === 'unread' ? 'active' : ''}" data-view="unread">
          Non lus${unread > 0 ? `<span class="chip-count">${unread}</span>` : ''}
        </button>
        <button class="chip ${view === 'favorites' ? 'active' : ''}" style="--chip:#fbbf24" data-view="favorites">
          ${icon('i-star', 'ic-xs')} Favoris${favs > 0 ? `<span class="chip-count">${favs}</span>` : ''}
        </button>
        <span class="filters-sep"></span>
        ${cats.map((c) => {
          const n = Store.articles.filter((a) => a.category === c && !isRead(a.id) && !isSourceHidden(a.source)).length;
          return `
            <button class="chip ${view === c ? 'active' : ''}" style="--chip:${esc(catColor(c))}" data-view="${escAttr(c)}">
              <span class="chip-dot"></span>${esc(c)}${n > 0 ? `<span class="chip-count">${n}</span>` : ''}
            </button>`;
        }).join('')}
      `;
      for (const btn of filtersEl.querySelectorAll('[data-view]')) {
        btn.addEventListener('click', () => {
          ctx.settings.view = btn.dataset.view;
          ctx.save();
          shown = ctx.settings.pageSize;
          render();
        });
      }
    }

    /* ── Cartes ── */
    function articleCard(a) {
      const read = isRead(a.id);
      const saved = Store.savedArticleIds.has(a.id);
      const fav = isFavorite(a.id);
      const summary = ctx.settings.summaries ? Store.summaries[a.id] : null;
      const pending = ctx.settings.summaries && !summary;

      return `
        <article class="article${read ? ' read' : ''}" data-id="${esc(a.id)}">
          <div class="article-link" data-open="${escAttr(a.link)}" data-article="${escAttr(a.id)}">
            ${a.image && ctx.settings.showImages ? `<img class="article-image" src="${esc(a.image)}" onerror="this.remove()" loading="lazy" alt="">` : ''}
            <div class="article-meta">
              ${!read ? '<span class="unread-dot"></span>' : ''}
              ${faviconImg(a.link)}
              <span class="source">${esc(a.source)}</span>
              <span class="time">${timeAgo(a.pubDate)}</span>
            </div>
            <h3 class="article-title">${esc(a.title)}</h3>
            ${summary
              ? `<p class="article-summary">${icon('i-sparkle', 'ic-xs')} ${esc(summary)}</p>`
              : pending
                ? `<p class="article-summary pending"><span class="sk-line w90"></span><span class="sk-line w70"></span></p>`
                : (a.description ? `<p class="article-desc">${esc(a.description)}</p>` : '')}
          </div>
          <footer class="article-foot">
            <span class="cat-pill" style="--pill:${esc(catColor(a.category))}">${esc(a.category)}</span>
            ${a.isTrending ? `<span class="trend-badge">${icon('i-zap')} Tendance</span>` : ''}
            <span class="spacer"></span>
            <button class="action-btn${fav ? ' fav' : ''}" data-fav="${escAttr(a.id)}" title="${fav ? 'Retirer des favoris' : 'Ajouter aux favoris'}">${icon('i-star')}</button>
            <button class="action-btn${saved ? ' saved' : ''}" data-save="${escAttr(a.id)}" title="${saved ? 'Déjà dans un board' : 'Sauvegarder dans un board'}">${icon('i-bookmark')}</button>
            <button class="action-btn" data-share="${escAttr(a.link)}" title="Copier le lien">${icon('i-link')}</button>
            <button class="action-btn" data-hide="${escAttr(a.source)}" title="Masquer ${escAttr(a.source)}">${icon('i-eye-off')}</button>
          </footer>
        </article>`;
    }

    function skeleton(count = 4) {
      const card = `<div class="skeleton-card"><div class="sk-line w40"></div><div class="sk-line tall w90"></div><div class="sk-line tall w70"></div><div class="sk-line w90"></div></div>`;
      return `<div class="articles-grid">${card.repeat(count)}</div>`;
    }

    /* ── Regroupement par sujet ── */
    function renderGrouped(articles) {
      const byId = new Map(articles.map((a) => [a.id, a]));
      const used = new Set();
      const groups = [];

      for (const topic of Store.clusters) {
        // Un groupe n'a de sens que si au moins deux de ses articles survivent
        // aux filtres en cours.
        const members = topic.ids.map((id) => byId.get(id)).filter((a) => a && !used.has(a.id));
        if (members.length < 2) continue;
        for (const a of members) used.add(a.id);
        groups.push({ label: topic.label, members });
      }

      const loose = articles.filter((a) => !used.has(a.id));
      const badge = Store.clusterMode === 'lexical'
        ? `<span class="badge" title="Regroupement lexical — ajoutez une clé API pour un regroupement sémantique">lexical</span>`
        : '';

      return `
        ${groups.map((g) => `
          <section class="topic">
            <header class="topic-head">
              ${icon('i-grid', 'ic-sm')}
              <span class="topic-label">${esc(g.label)}</span>
              <span class="topic-count">${g.members.length}</span>
              ${badge}
            </header>
            <div class="articles-grid">${g.members.map(articleCard).join('')}</div>
          </section>`).join('')}
        ${loose.length ? `
          <section class="topic">
            <header class="topic-head">
              ${icon('i-rss', 'ic-sm')}<span class="topic-label">Sujets isolés</span>
              <span class="topic-count">${loose.length}</span>
            </header>
            <div class="articles-grid">${loose.slice(0, shown).map(articleCard).join('')}</div>
          </section>` : ''}
      `;
    }

    /* ── Rendu ── */
    function render() {
      const pool = Store.articles.filter((a) => !isSourceHidden(a.source));
      const unread = pool.filter((a) => !isRead(a.id)).length;
      ctx.summary(unread > 0
        ? `<strong>${unread}</strong> non lu${unread > 1 ? 's' : ''} sur ${pool.length}`
        : `${pool.length} article${pool.length > 1 ? 's' : ''} · tout est lu`);

      if (ctx.isCollapsed()) return;

      // Aucune source configurée : on montre l'accueil, pas un fil vide.
      if (Store.feeds.length === 0 && !Store.query) {
        q('.rss-controls').hidden = true;
        ctx.root.querySelector('.segmented').hidden = true;
        kwPanel.hidden = true;
        filtersEl.hidden = true;
        listEl.innerHTML = renderOnboarding();
        wireOnboarding();
        return;
      }
      q('.rss-controls').hidden = false;
      ctx.root.querySelector('.segmented').hidden = false;
      filtersEl.hidden = false;

      if (Store.loadingArticles && Store.articles.length === 0) {
        listEl.innerHTML = skeleton();
        return;
      }
      if (Store.articlesError) {
        listEl.innerHTML = `<div class="empty compact">${icon('i-rss')}<div>Erreur de chargement des flux</div><p>${esc(Store.articlesError)}</p></div>`;
        return;
      }

      renderFilters();
      const filtered = visibleArticles();

      if (filtered.length === 0) {
        listEl.innerHTML = emptyMessage();
        return;
      }

      const page = ctx.settings.grouped ? filtered : filtered.slice(0, shown);
      listEl.innerHTML = `
        ${ctx.settings.grouped
          ? renderGrouped(filtered)
          : `<div class="articles-grid">${page.map(articleCard).join('')}</div>`}
        ${!ctx.settings.grouped && filtered.length > shown
          ? `<button class="btn more-btn" data-more>Voir ${Math.min(ctx.settings.pageSize, filtered.length - shown)} articles de plus</button>`
          : ''}
      `;
      wireList();

      // Ne demander des résumés que pour ce qui est réellement à l'écran.
      if (ctx.settings.summaries) {
        const visible = [...listEl.querySelectorAll('.article')].map((el) => el.dataset.id);
        requestSummaries(visible);
      }
    }

    function emptyMessage() {
      if (Store.query) {
        return `<div class="empty compact">${icon('i-search')}<div>Aucun résultat pour « ${esc(Store.query)} »</div></div>`;
      }
      if (ctx.settings.view === 'favorites') {
        return `<div class="empty compact">${icon('i-star')}<div>Aucun favori</div><p>Utilisez l'étoile sur une carte article.</p></div>`;
      }
      if (ctx.settings.view === 'unread') {
        return `<div class="empty compact">${icon('i-check')}<div>Tout est lu</div></div>`;
      }
      if (hasKeywords()) {
        return `<div class="empty compact">${icon('i-search')}<div>Aucun article ne passe vos filtres</div>
          <p>Assouplissez les mots-clés depuis l'icône de recherche de l'en-tête.</p></div>`;
      }
      return `<div class="empty compact">${icon('i-rss')}<div>Aucun article</div><p>Lancez un rafraîchissement ou ajoutez des sources.</p></div>`;
    }

    function wireList() {
      listEl.querySelector('[data-more]')?.addEventListener('click', () => {
        shown += ctx.settings.pageSize;
        render();
      });
      for (const el of listEl.querySelectorAll('[data-open]')) {
        el.addEventListener('click', () => {
          const card = el.closest('.article');
          card.classList.add('read');
          card.querySelector('.unread-dot')?.remove();
          openArticle(el.dataset.article, el.dataset.open);
        });
      }
      for (const btn of listEl.querySelectorAll('[data-fav]')) {
        btn.addEventListener('click', () => {
          const on = toggleFavorite(btn.dataset.fav);
          btn.classList.toggle('fav', on);
          btn.title = on ? 'Retirer des favoris' : 'Ajouter aux favoris';
        });
      }
      for (const btn of listEl.querySelectorAll('[data-save]')) {
        btn.addEventListener('click', () => {
          const a = Store.articles.find((x) => x.id === btn.dataset.save);
          if (a) openSaveModal(a.id, a.title, a.link, a.source);
        });
      }
      for (const btn of listEl.querySelectorAll('[data-share]')) {
        btn.addEventListener('click', () => shareArticle(btn.dataset.share));
      }
      for (const btn of listEl.querySelectorAll('[data-hide]')) {
        btn.addEventListener('click', () => confirmClick(btn, 'hideSource', btn.dataset.hide));
      }
    }

    /* ── Accueil quand aucun flux n'est configuré ── */
    function renderOnboarding() {
      return `
        <div class="onboarding">
          <div class="onboarding-hero">
            <h2>Construisez votre fil</h2>
            <p>Importez vos sources Feedly en OPML ou commencez avec quelques flux recommandés.</p>
          </div>
          <div class="onboarding-tabs">
            <button class="${onboardingTab === 'feedly' ? 'active' : ''}" data-ob-tab="feedly">Importer Feedly</button>
            <button class="${onboardingTab === 'suggestions' ? 'active' : ''}" data-ob-tab="suggestions">Suggestions</button>
          </div>
          ${onboardingTab === 'feedly' ? onboardingFeedly() : onboardingSuggestions()}
        </div>`;
    }

    function onboardingFeedly() {
      return `
        <div class="onboarding-panel">
          <div class="step-list">
            <div class="step-item"><span class="step-num">1</span><span>Sur Feedly web, ouvrez <strong>feedly.com/i/opml</strong> depuis votre compte.</span></div>
            <div class="step-item"><span class="step-num">2</span><span>Téléchargez le fichier OPML de vos sources et dossiers.</span></div>
            <div class="step-item"><span class="step-num">3</span><span>Importez le fichier ici. Les dossiers Feedly deviendront des catégories FeedMe.</span></div>
          </div>
          <label class="file-drop">
            <input type="file" id="onboarding-opml" accept=".opml,.xml,text/xml,application/xml" onchange="updateFileLabel(this)" hidden>
            ${icon('i-upload')}
            <span class="file-label">Choisir un fichier OPML…</span>
          </label>
          <div class="btn-row">
            <button class="btn primary" onclick="importOpmlFromInput('onboarding-opml')">${icon('i-upload', 'ic-sm')} Importer OPML</button>
            <button class="btn" data-ob-tab="suggestions">${icon('i-sparkle', 'ic-sm')} Voir les suggestions</button>
          </div>
          <form class="add-row" onsubmit="addManualFeed(event, 'onboarding-url')">
            <input type="url" id="onboarding-url" placeholder="Ou collez une URL RSS…" required>
            <button type="submit" class="btn primary icon-only" title="Ajouter">${icon('i-plus')}</button>
          </form>
        </div>`;
    }

    function onboardingSuggestions() {
      return `
        <div class="suggestions-grid">
          ${Store.suggestions.map((item) => {
            const added = Store.feeds.some((feed) => feed.url === item.url);
            return `
              <div class="suggestion-card">
                <div class="suggestion-top">
                  <div>
                    <div class="suggestion-title">${esc(item.title)}</div>
                    <span class="badge" style="--pill:${esc(catColor(item.category))}">${esc(item.category)}</span>
                  </div>
                  <button class="btn primary" ${added ? 'disabled' : ''} onclick="addSuggestedFeed('${escAttr(item.url)}')">
                    ${added ? `${icon('i-check', 'ic-sm')} Ajouté` : `${icon('i-plus', 'ic-sm')} Ajouter`}
                  </button>
                </div>
                <div class="suggestion-desc">${esc(item.description)}</div>
              </div>`;
          }).join('')}
        </div>`;
    }

    function wireOnboarding() {
      for (const btn of listEl.querySelectorAll('[data-ob-tab]')) {
        btn.addEventListener('click', () => {
          onboardingTab = btn.dataset.obTab;
          listEl.innerHTML = renderOnboarding();
          wireOnboarding();
        });
      }
    }

    /* ── Abonnements ── */
    ctx.on('articles', () => {
      // Le fil a changé : les regroupements portaient sur l'ancien jeu.
      if (ctx.settings.grouped) fetchClusters();
      render();
    });
    ctx.on('articles:loading', () => { if (Store.articles.length === 0) render(); });
    ctx.on('feeds', render);
    ctx.on('categories', render);
    ctx.on('boards', render);
    ctx.on('suggestions', render);
    ctx.on('summaries', render);
    ctx.on('clusters', render);
    ctx.on('hidden', render);
    ctx.on('ai:status', () => { Store.clusters = []; render(); });

    syncToolStates();
    renderKeywords();
    render();
    if (ctx.settings.grouped) fetchClusters();
  },

  onExpand() {
    // Le corps n'est pas peint quand le widget est replié : on le repeint
    // à la réouverture pour éviter une zone vide.
    Bus.emit('articles', Store.articles);
  },
});
