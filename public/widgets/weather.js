'use strict';

/* ════════════════════════════════════════
   Widget Météo — Open-Meteo
   ──────────────────────────────────────────
   Pas de clé API, pas de compte. La ville est choisie une fois par recherche
   géocodée, puis ses coordonnées sont stockées dans les réglages du widget :
   les rafraîchissements suivants ne touchent plus au géocodage.
   ════════════════════════════════════════ */

// Codes WMO renvoyés par Open-Meteo. Un pictogramme et un libellé par plage.
const WMO = {
  0: ['☀️', 'Ciel dégagé'],
  1: ['🌤️', 'Plutôt dégagé'], 2: ['⛅', 'Partiellement nuageux'], 3: ['☁️', 'Couvert'],
  45: ['🌫️', 'Brouillard'], 48: ['🌫️', 'Brouillard givrant'],
  51: ['🌦️', 'Bruine légère'], 53: ['🌦️', 'Bruine'], 55: ['🌦️', 'Bruine dense'],
  56: ['🌧️', 'Bruine verglaçante'], 57: ['🌧️', 'Bruine verglaçante dense'],
  61: ['🌦️', 'Pluie faible'], 63: ['🌧️', 'Pluie'], 65: ['🌧️', 'Pluie forte'],
  66: ['🌧️', 'Pluie verglaçante'], 67: ['🌧️', 'Pluie verglaçante forte'],
  71: ['🌨️', 'Neige faible'], 73: ['🌨️', 'Neige'], 75: ['❄️', 'Neige forte'],
  77: ['🌨️', 'Grains de neige'],
  80: ['🌦️', 'Averses'], 81: ['🌧️', 'Averses fortes'], 82: ['⛈️', 'Averses violentes'],
  85: ['🌨️', 'Averses de neige'], 86: ['❄️', 'Fortes averses de neige'],
  95: ['⛈️', 'Orage'], 96: ['⛈️', 'Orage avec grêle'], 99: ['⛈️', 'Orage violent'],
};

function wmo(code) { return WMO[code] || ['🌡️', '—']; }

Dashboard.register({
  type: 'weather',
  name: 'Météo',
  icon: 'i-cloud',
  description: 'Conditions actuelles, prochaines heures et cinq jours. Sans clé API.',
  singleton: false,
  defaults: { place: null, days: true },

  mount(ctx) {
    ctx.body.innerHTML = `<div data-content></div>`;
    const content = ctx.body.querySelector('[data-content]');
    let data = null;
    let loading = false;
    let error = null;
    let searching = false;

    ctx.tools(`
      <button class="widget-btn" data-place title="Changer de ville">${icon('i-globe', 'ic-sm')}</button>
      <button class="widget-btn" data-refresh title="Actualiser">${icon('i-refresh', 'ic-sm')}</button>
    `);
    ctx.root.querySelector('[data-place]').addEventListener('click', () => {
      searching = !searching;
      render();
    });
    ctx.root.querySelector('[data-refresh]').addEventListener('click', () => load(true));

    async function load(force = false) {
      const place = ctx.settings.place;
      if (!place) { render(); return; }
      if (loading && !force) return;
      loading = true;
      error = null;
      render();
      try {
        data = await api(`/api/weather?lat=${place.lat}&lon=${place.lon}`);
      } catch (e) {
        error = e.message;
      } finally {
        loading = false;
      }
      render();
    }

    /* ── Choix de la ville ── */
    function renderSearch() {
      return `
        <form class="add-row compact" data-search-form>
          <input type="text" data-city placeholder="Nom de ville…" autocomplete="off" spellcheck="false">
          <button type="submit" class="btn primary icon-only" title="Chercher">${icon('i-search', 'ic-sm')}</button>
        </form>
        <div data-results></div>`;
    }

    function wireSearch() {
      const form = content.querySelector('[data-search-form]');
      if (!form) return;
      const input = form.querySelector('[data-city]');
      const results = content.querySelector('[data-results]');
      input.focus();

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const query = input.value.trim();
        if (query.length < 2) return;
        results.innerHTML = `<div class="wx-hint">Recherche…</div>`;
        try {
          const { places } = await api(`/api/weather/search?q=${encodeURIComponent(query)}`);
          if (places.length === 0) {
            results.innerHTML = `<div class="wx-hint">Aucune ville trouvée.</div>`;
            return;
          }
          results.innerHTML = `<div class="wx-results">${places.map((p, i) => `
            <button class="wx-result" data-pick="${i}">
              <strong>${esc(p.name)}</strong>
              <span>${esc([p.admin, p.country].filter(Boolean).join(', '))}</span>
            </button>`).join('')}</div>`;
          for (const btn of results.querySelectorAll('[data-pick]')) {
            btn.addEventListener('click', () => {
              ctx.settings.place = places[Number(btn.dataset.pick)];
              ctx.save();
              searching = false;
              data = null;
              load(true);
            });
          }
        } catch (e) {
          results.innerHTML = `<div class="wx-hint">${esc(e.message)}</div>`;
        }
      });
    }

    /* ── Rendu ── */
    function render() {
      const place = ctx.settings.place;

      if (!place || searching) {
        ctx.summary(place ? esc(place.name) : 'ville non choisie');
        if (ctx.isCollapsed()) return;
        content.innerHTML = `
          ${place ? '' : `<p class="section-hint" style="margin:0 0 4px">Choisissez la ville à suivre.</p>`}
          ${renderSearch()}`;
        wireSearch();
        return;
      }

      if (error) {
        ctx.summary('météo indisponible');
        if (ctx.isCollapsed()) return;
        content.innerHTML = `<div class="empty compact">${icon('i-cloud')}<div>Météo indisponible</div><p>${esc(error)}</p></div>`;
        return;
      }

      if (!data) {
        ctx.summary(loading ? 'chargement…' : esc(place.name));
        if (ctx.isCollapsed()) return;
        content.innerHTML = `<div class="wx-hint">${icon('i-sync', 'ic-sm')} Chargement de la météo…</div>`;
        return;
      }

      const [emoji, label] = wmo(data.current.code);
      const temp = Math.round(data.current.temp);
      ctx.summary(`${emoji} <strong>${temp}°</strong> · ${esc(place.name)}`);
      if (ctx.isCollapsed()) return;

      content.innerHTML = `
        <div class="wx-now">
          <span class="wx-icon">${emoji}</span>
          <div class="wx-now-main">
            <div class="wx-temp">${temp}<span>°C</span></div>
            <div class="wx-label">${esc(label)}</div>
          </div>
          <div class="wx-now-meta">
            <span>${esc(place.name)}</span>
            <span>Ressenti ${Math.round(data.current.feels)}°</span>
            <span>${Math.round(data.current.humidity)} % · ${Math.round(data.current.wind)} km/h</span>
          </div>
        </div>

        <div class="wx-hours">
          ${data.hours.map((h) => {
            const [e] = wmo(h.code);
            const hour = new Date(h.t).toLocaleTimeString('fr-FR', { hour: '2-digit' });
            return `
              <div class="wx-hour">
                <span class="wx-hour-time">${esc(hour)}</span>
                <span class="wx-hour-icon">${e}</span>
                <span class="wx-hour-temp">${Math.round(h.temp)}°</span>
                <span class="wx-hour-rain${h.rain >= 40 ? ' wet' : ''}">${h.rain != null ? `${h.rain}%` : ''}</span>
              </div>`;
          }).join('')}
        </div>

        ${ctx.settings.days ? `
          <div class="wx-days">
            ${data.days.map((d, i) => {
              const [e, l] = wmo(d.code);
              const day = i === 0 ? "Aujourd'hui"
                : new Date(d.date).toLocaleDateString('fr-FR', { weekday: 'long' });
              return `
                <div class="wx-day">
                  <span class="wx-day-name">${esc(day)}</span>
                  <span class="wx-day-icon" title="${escAttr(l)}">${e}</span>
                  <span class="wx-day-rain${d.rain >= 40 ? ' wet' : ''}">${d.rain != null ? `${d.rain}%` : ''}</span>
                  <span class="wx-day-temp"><strong>${Math.round(d.max)}°</strong> ${Math.round(d.min)}°</span>
                </div>`;
            }).join('')}
          </div>` : ''}
      `;
    }

    // Le corps n'est pas peint tant que le widget est replié : onExpand a besoin
    // d'un point d'entrée sur le rendu local.
    ctx.repaint = render;

    render();
    load();
    // Open-Meteo cache dix minutes côté serveur : sonder plus souvent ne sert à rien.
    ctx.every(() => { if (!document.hidden) load(); }, 10 * 60 * 1000);
  },

  onExpand(ctx) {
    ctx.repaint?.();
  },
});
