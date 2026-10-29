'use strict';

/* ════════════════════════════════════════
   Widget Spotify — lecteur complet
   ──────────────────────────────────────────
   Trois panneaux se partagent le bas du widget, un seul ouvert à la fois :
   paroles, appareils Spotify Connect, historique d'écoute. Les paroles viennent
   de LRCLIB (l'API Spotify n'en expose pas) et se synchronisent sur la
   progression interpolée du lecteur, pas sur les sondages — sinon la ligne
   courante avance par saccades de trois secondes.
   ════════════════════════════════════════ */
Dashboard.register({
  type: 'spotify',
  name: 'Spotify',
  icon: 'i-music',
  description: 'Lecteur, paroles synchronisées, appareils Connect, favoris et historique.',
  singleton: true,
  defaults: { bigArt: false, panel: null }, // panel : null | lyrics | devices | history

  mount(ctx) {
    ctx.body.innerHTML = `
      <div class="sp" data-player hidden>
        <div class="sp-top">
          <div class="sp-art" data-art>${icon('i-music')}</div>
          <div class="sp-main">
            <div class="sp-title" data-title>Rien en lecture</div>
            <div class="sp-sub" data-sub></div>
          </div>
          <div class="sp-controls">
            <button class="player-btn" data-like title="Ajouter à vos titres likés">${icon('i-star')}</button>
            <button class="player-btn" data-prev title="Morceau précédent" aria-label="Morceau précédent">${icon('i-prev')}</button>
            <button class="player-btn play" data-toggle title="Lecture / Pause" aria-label="Lecture / Pause">${icon('i-play')}</button>
            <button class="player-btn" data-next title="Morceau suivant" aria-label="Morceau suivant">${icon('i-next')}</button>
          </div>
        </div>

        <div class="sp-progress mono">
          <span data-time-cur>0:00</span>
          <div class="sp-seek" data-seek title="Cliquez pour vous déplacer dans le morceau">
            <div class="sp-seek-fill" data-seek-fill></div>
          </div>
          <span data-time-dur>0:00</span>
        </div>

        <div class="sp-row">
          <span class="sp-vol-icon" data-device-name title="Appareil actif">${icon('i-monitor', 'ic-sm')}</span>
          <input type="range" class="player-volume" data-volume min="0" max="100" value="70" title="Volume" aria-label="Volume">
          <button class="player-btn open" data-open title="Ouvrir Spotify" aria-label="Ouvrir Spotify">${icon('i-external', 'ic-sm')}</button>
        </div>

        <div class="sp-panel" data-panel hidden></div>
      </div>

      <div class="empty compact" data-offline>
        ${icon('i-music')}<div>Spotify non connecté</div>
        <p>Connectez votre compte pour piloter la lecture depuis FeedMe.</p>
        <button class="btn primary" style="margin-top:10px" data-connect>${icon('i-music', 'ic-sm')} Connecter Spotify</button>
      </div>

      <div class="sp-reauth" data-reauth hidden>
        ${icon('i-sparkle', 'ic-sm')}
        <span>Nouvelles fonctions disponibles (favoris, historique). Reconnectez votre compte pour autoriser ces accès.</span>
        <button class="btn" data-reconnect>Reconnecter</button>
      </div>
    `;

    const q = (sel) => ctx.body.querySelector(sel);
    const tool = (sel) => ctx.root.querySelector(sel);
    const player = q('[data-player]');
    const offline = q('[data-offline]');
    const reauth = q('[data-reauth]');
    const art = q('[data-art]');
    const seek = q('[data-seek]');
    const seekFill = q('[data-seek-fill]');
    const volume = q('[data-volume]');
    const panel = q('[data-panel]');

    ctx.tools(`
      <button class="widget-btn" data-lyrics title="Paroles">${icon('i-quote', 'ic-sm')}</button>
      <button class="widget-btn" data-devices title="Appareils Spotify Connect">${icon('i-monitor', 'ic-sm')}</button>
      <button class="widget-btn" data-history title="Historique d'écoute">${icon('i-clock', 'ic-sm')}</button>
      <button class="widget-btn" data-big title="Pochette en grand">${icon('i-max', 'ic-sm')}</button>
    `);

    /* ── Panneaux ── */
    function openPanel(name) {
      ctx.settings.panel = ctx.settings.panel === name ? null : name;
      ctx.save();
      syncToolStates();
      if (ctx.settings.panel === 'devices') fetchSpotifyDevices();
      if (ctx.settings.panel === 'history') fetchSpotifyHistory();
      if (ctx.settings.panel === 'lyrics') fetchLyrics(Store.spotifyState?.track);
      renderPanel();
    }

    function syncToolStates() {
      for (const [name, sel] of [['lyrics', '[data-lyrics]'], ['devices', '[data-devices]'], ['history', '[data-history]']]) {
        tool(sel).classList.toggle('on', ctx.settings.panel === name);
      }
      tool('[data-big]').classList.toggle('on', !!ctx.settings.bigArt);
      // Sans les nouvelles permissions, ces boutons ne mèneraient qu'à une erreur.
      tool('[data-history]').disabled = !spotifyCan('user-read-recently-played');
      q('[data-like]').disabled = !spotifyCan('user-library-modify') || !Store.spotifyState?.track;
    }

    tool('[data-lyrics]').addEventListener('click', () => openPanel('lyrics'));
    tool('[data-devices]').addEventListener('click', () => openPanel('devices'));
    tool('[data-history]').addEventListener('click', () => openPanel('history'));
    tool('[data-big]').addEventListener('click', () => {
      ctx.settings.bigArt = !ctx.settings.bigArt;
      ctx.save();
      player.classList.toggle('big-art', ctx.settings.bigArt);
      syncToolStates();
    });
    player.classList.toggle('big-art', !!ctx.settings.bigArt);

    /* ── Commandes ── */
    q('[data-prev]').addEventListener('click', () => spotifyCommand('previous'));
    q('[data-next]').addEventListener('click', () => spotifyCommand('next'));
    q('[data-toggle]').addEventListener('click', spotifyTogglePlay);
    q('[data-open]').addEventListener('click', openSpotifyApp);
    q('[data-like]').addEventListener('click', () => {
      const id = Store.spotifyState?.track?.id;
      if (id) toggleSpotifySaved(id);
    });
    q('[data-connect]').addEventListener('click', () => {
      togglePanel('settings');
      showSettingsSection('spotify');
    });
    q('[data-reconnect]').addEventListener('click', () => {
      togglePanel('settings');
      showSettingsSection('spotify');
    });

    volume.addEventListener('input', () => setSpotifyVolume(volume.value));

    seek.addEventListener('click', (event) => {
      const track = Store.spotifyState?.track;
      if (!track) return;
      const box = seek.getBoundingClientRect();
      const ratio = (event.clientX - box.left) / box.width;
      spotifySeek(Math.round(Math.min(1, Math.max(0, ratio)) * track.durationMs));
    });

    /* ── Rendu du lecteur ── */
    function renderStatus() {
      const connected = Store.spotifyStatus.connected;
      player.hidden = !connected;
      offline.hidden = connected;
      reauth.hidden = !connected || (Store.spotifyStatus.missingScopes || []).length === 0;
      if (!connected) ctx.summary('non connecté');
    }

    function renderState(state) {
      renderStatus();
      syncToolStates();
      if (!Store.spotifyStatus.connected) return;

      const track = state?.track;
      for (const sel of ['[data-prev]', '[data-next]', '[data-toggle]']) q(sel).disabled = !track;

      if (!track) {
        art.dataset.trackId = '';
        art.innerHTML = icon('i-music');
        q('[data-title]').textContent = 'Rien en lecture';
        q('[data-sub]').textContent = 'Ouvrez Spotify pour lancer un morceau';
        seekFill.style.width = '0%';
        q('[data-time-cur]').textContent = '0:00';
        q('[data-time-dur]').textContent = '0:00';
        ctx.summary('rien en lecture');
        renderPanel();
        return;
      }

      // La pochette n'est remplacée qu'au changement de morceau : sinon le
      // <img> se recharge à chaque sondage et clignote.
      if (art.dataset.trackId !== track.id) {
        art.dataset.trackId = track.id;
        art.innerHTML = track.art ? `<img src="${escAttr(track.art)}" alt="">` : icon('i-music');
      }

      q('[data-title]').textContent = track.title;
      q('[data-sub]').textContent = [track.artist, track.album].filter(Boolean).join(' · ');

      const toggle = q('[data-toggle]');
      toggle.innerHTML = icon(state.playing ? 'i-pause' : 'i-play');
      toggle.classList.toggle('active', state.playing);

      const like = q('[data-like]');
      const liked = Store.spotifySaved[track.id];
      like.classList.toggle('liked', !!liked);
      like.title = liked ? 'Retirer de vos titres likés' : 'Ajouter à vos titres likés';

      const deviceLabel = q('[data-device-name]');
      deviceLabel.title = state.device?.name ? `Appareil : ${state.device.name}` : 'Appareil actif';

      // Ne pas écraser le curseur pendant que l'utilisateur le manipule.
      if (state.device && document.activeElement !== volume) volume.value = state.device.volume;

      ctx.summary(
        `${state.playing ? icon('i-play', 'ic-xs') : icon('i-pause', 'ic-xs')} <strong>${esc(track.title)}</strong> · ${esc(track.artist)}`
      );
      renderProgress(state.progressMs || 0);
      renderPanel();
    }

    function renderProgress(progressMs) {
      const track = Store.spotifyState?.track;
      if (!track) return;
      const percent = Math.min(100, (progressMs / (track.durationMs || 1)) * 100);
      seekFill.style.width = `${percent}%`;
      q('[data-time-cur]').textContent = formatDuration(progressMs);
      q('[data-time-dur]').textContent = formatDuration(track.durationMs);
      if (ctx.settings.panel === 'lyrics') highlightLyrics(progressMs);
    }

    /* ── Paroles ── */
    let lyricLineEls = [];
    let activeLyricIndex = -1;

    function renderLyrics() {
      const { lines, plain, loading, error } = Store.lyrics;
      lyricLineEls = [];
      activeLyricIndex = -1;

      if (loading) return `<div class="sp-lyrics-state">${icon('i-sync', 'ic-sm')} Recherche des paroles…</div>`;
      if (lines.length > 0) {
        return `<div class="sp-lyrics" data-lyrics-scroll>${lines.map((l, i) =>
          `<p class="sp-lyric${l.text ? '' : ' interlude'}" data-i="${i}">${l.text ? esc(l.text) : '♪'}</p>`
        ).join('')}</div>`;
      }
      if (plain) {
        return `<div class="sp-lyrics plain">${plain.split(/\n/).map((l) =>
          `<p class="sp-lyric static">${esc(l) || '&nbsp;'}</p>`).join('')}</div>
          <div class="sp-lyrics-state">Paroles non synchronisées pour ce morceau</div>`;
      }
      return `<div class="sp-lyrics-state">${icon('i-quote', 'ic-sm')} ${esc(error || 'Aucune parole trouvée')}
        <br><span class="sp-credit">Source : LRCLIB</span></div>`;
    }

    function highlightLyrics(progressMs) {
      if (lyricLineEls.length === 0) return;
      const lines = Store.lyrics.lines;

      // Dernière ligne dont l'horodatage est déjà passé. Recherche linéaire
      // depuis l'index courant : on avance d'une ligne toutes les quelques
      // secondes, un parcours complet à chaque tick serait du gaspillage.
      let index = activeLyricIndex;
      while (index + 1 < lines.length && lines[index + 1].t <= progressMs) index++;
      while (index >= 0 && lines[index].t > progressMs) index--;
      if (index === activeLyricIndex) return;

      lyricLineEls[activeLyricIndex]?.classList.remove('active');
      activeLyricIndex = index;
      const el = lyricLineEls[index];
      if (!el) return;
      el.classList.add('active');
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    /* ── Appareils ── */
    function renderDevices() {
      const devices = Store.spotifyDevices;
      if (devices.length === 0) {
        return `<div class="sp-lyrics-state">${icon('i-monitor', 'ic-sm')} Aucun appareil Spotify détecté.
          <br><span class="sp-credit">Lancez Spotify sur un appareil pour le voir apparaître.</span></div>`;
      }
      return `<div class="sp-devices">${devices.map((d) => `
        <button class="sp-device${d.active ? ' active' : ''}" data-device="${escAttr(d.id)}" ${d.restricted ? 'disabled title="Appareil non pilotable"' : ''}>
          ${icon(deviceIcon(d.type), 'ic-sm')}
          <span class="sp-device-name">${esc(d.name)}</span>
          <span class="sp-device-type">${esc(d.type)}</span>
          ${d.active ? `<span class="sp-device-dot"></span>` : ''}
        </button>`).join('')}</div>`;
    }

    function deviceIcon(type) {
      const t = String(type || '').toLowerCase();
      if (t.includes('phone') || t.includes('tablet')) return 'i-tablet';
      if (t.includes('speaker') || t.includes('cast') || t.includes('tv')) return 'i-music';
      return 'i-monitor';
    }

    /* ── Historique ── */
    function renderHistory() {
      const tracks = Store.spotifyHistory;
      if (!spotifyCan('user-read-recently-played')) {
        return `<div class="sp-lyrics-state">Reconnectez votre compte pour accéder à l'historique.</div>`;
      }
      if (tracks.length === 0) {
        return `<div class="sp-lyrics-state">${icon('i-clock', 'ic-sm')} Historique vide pour le moment.</div>`;
      }
      return `<div class="sp-history">${tracks.map((t) => `
        <button class="sp-hist-row" data-track-url="${escAttr(t.url)}" title="Ouvrir dans Spotify">
          ${t.art ? `<img class="sp-hist-art" src="${escAttr(t.art)}" alt="" loading="lazy">` : `<span class="sp-hist-art"></span>`}
          <span class="sp-hist-meta">
            <span class="sp-hist-title">${esc(t.title)}</span>
            <span class="sp-hist-artist">${esc(t.artist)}</span>
          </span>
          <span class="sp-hist-time">${timeAgo(t.playedAt)}</span>
        </button>`).join('')}</div>`;
    }

    /* ── Assemblage du panneau ──
       Le sondage republie l'état toutes les trois secondes. Reconstruire le
       panneau à chaque fois remettrait la ligne de paroles active à zéro et
       ferait sauter le défilement : on ne repeint que si les données affichées
       ont réellement changé. */
    let panelSignature = null;

    function panelSig(name) {
      if (name === 'lyrics') {
        const l = Store.lyrics;
        return `lyrics|${l.trackId}|${l.lines.length}|${l.plain.length}|${l.loading}|${l.error}`;
      }
      if (name === 'devices') {
        return 'devices|' + Store.spotifyDevices.map((d) => `${d.id}:${d.active}`).join(',');
      }
      if (name === 'history') {
        return `history|${Store.spotifyHistory.length}|${Store.spotifyHistory[0]?.playedAt || ''}`;
      }
      return String(name);
    }

    function renderPanel() {
      const name = ctx.settings.panel;
      panel.hidden = !name;
      if (!name) { panelSignature = null; return; }

      const signature = panelSig(name);
      if (signature === panelSignature) return;
      panelSignature = signature;

      if (name === 'lyrics') panel.innerHTML = renderLyrics();
      else if (name === 'devices') panel.innerHTML = renderDevices();
      else if (name === 'history') panel.innerHTML = renderHistory();

      if (name === 'lyrics') {
        lyricLineEls = [...panel.querySelectorAll('.sp-lyric[data-i]')];
        if (lyricLineEls.length) highlightLyrics(Store.spotifyState?.progressMs || 0);
      }
      for (const btn of panel.querySelectorAll('[data-device]')) {
        btn.addEventListener('click', () => transferSpotify(btn.dataset.device));
      }
      for (const btn of panel.querySelectorAll('[data-track-url]')) {
        btn.addEventListener('click', () => openSpotifyTrack(btn.dataset.trackUrl));
      }
    }

    /* ── Abonnements ── */
    ctx.on('spotify', renderState);
    // Le statut arrive après le montage : on repasse par renderState pour que
    // le résumé replié ne reste pas bloqué sur « non connecté ».
    ctx.on('spotify:status', () => renderState(Store.spotifyState));
    ctx.on('spotify:progress', renderProgress);
    ctx.on('spotify:saved', () => renderState(Store.spotifyState));
    ctx.on('spotify:devices', renderPanel);
    ctx.on('spotify:history', renderPanel);
    ctx.on('spotify:lyrics', renderPanel);
    // Nouveau morceau : les paroles précédentes ne valent plus rien.
    ctx.on('spotify:track', (track) => {
      if (ctx.settings.panel === 'lyrics') fetchLyrics(track);
      if (ctx.settings.panel === 'history') fetchSpotifyHistory();
    });

    renderState(Store.spotifyState);
    // S'abonner suffit à réveiller le sondage partagé.
    syncSpotifyPolling();

    // Restaure le panneau ouvert au démontage précédent. Passer par openPanel()
    // le refermerait : la fonction bascule.
    if (ctx.settings.panel === 'devices') fetchSpotifyDevices();
    else if (ctx.settings.panel === 'history') fetchSpotifyHistory();
    else if (ctx.settings.panel === 'lyrics') fetchLyrics(Store.spotifyState?.track);
    syncToolStates();
    renderPanel();
  },

  destroy() {
    // Plus aucun widget Spotify : le sondage s'arrête de lui-même.
    setTimeout(syncSpotifyPolling, 0);
  },
});
