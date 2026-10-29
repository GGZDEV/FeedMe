'use strict';

/* ════════════════════════════════════════
   Widget Système — monitoring avec graphes sur 60 s
   ──────────────────────────────────────────
   Le widget ne sonde rien lui-même : il s'abonne au topic `metrics`, et c'est
   la présence d'au moins un abonné qui déclenche le sondage côté noyau. Le
   catalogue ci-dessous décrit chaque mesure ; l'utilisateur choisit celles
   qu'il veut voir, et celles que la machine ne sait pas produire sont grisées
   avec l'explication en infobulle.
   ════════════════════════════════════════ */

// « 16 Go / 32 Go », ou « 16/32 Go » quand la tuile est étroite.
function compactUsage(used, total) {
  const full = `${formatBytes(used)} / ${formatBytes(total)}`;
  const [, a, unitA] = formatBytes(used).match(/^([\d.,]+)\s*(.*)$/) || [];
  const [, b, unitB] = formatBytes(total).match(/^([\d.,]+)\s*(.*)$/) || [];
  return a && unitA === unitB ? [full, `${a}/${b} ${unitB}`] : [full];
}

function formatRate(bytesPerSec) {
  if (!Number.isFinite(bytesPerSec)) return '--';
  return `${formatBytes(bytesPerSec)}/s`;
}

const SYSTEM_METRICS = [
  {
    key: 'cpu', label: 'CPU', series: ['cpu'], max: 100,
    available: (m) => Number.isFinite(m.cpu?.usagePercent),
    percent: (m) => m.cpu?.usagePercent,
    value: (m) => formatPercent(m.cpu?.usagePercent),
    // Plusieurs formulations, de la plus complète à la plus courte : la tuile
    // garde la première qui tient sur une ligne.
    meta: (m) => {
      const cores = m.cpu?.cores ? `${m.cpu.cores} cœurs` : '';
      const ghz = Number.isFinite(m.cpu?.speedGhz) ? `${m.cpu.speedGhz.toFixed(1)} GHz` : '';
      return [[cores, ghz].filter(Boolean).join(' · '), cores || ghz];
    },
  },
  {
    key: 'ram', label: 'RAM', series: ['ram'], max: 100,
    available: (m) => Number.isFinite(m.memory?.usedPercent),
    percent: (m) => m.memory?.usedPercent,
    value: (m) => formatPercent(m.memory?.usedPercent),
    meta: (m) => compactUsage(m.memory?.used, m.memory?.total),
  },
  {
    key: 'gpu', label: 'GPU', series: ['gpu'], max: 100,
    available: (m) => Number.isFinite(m.gpu?.loadPercent),
    unavailableHint: 'Charge GPU indisponible sur ce système',
    percent: (m) => m.gpu?.loadPercent,
    value: (m) => formatPercent(m.gpu?.loadPercent),
    // Sans la marque ni les mentions entre parenthèses : « Radeon RX 6900 XT ».
    meta: (m) => {
      const name = String(m.gpu?.model || '').replace(/\s*\([^)]*\)/g, '')
        .replace(/^(AMD|NVIDIA|Intel(\(R\))?)\s+/i, '').replace(/^GeForce\s+/i, '').trim();
      return [name, name.replace(/^Radeon\s+/i, '')];
    },
  },
  {
    key: 'vram', label: 'VRAM', series: ['vram'], max: 100,
    available: (m) => Number.isFinite(m.gpu?.vramPercent),
    unavailableHint: 'VRAM indisponible sur ce système',
    percent: (m) => m.gpu?.vramPercent,
    value: (m) => formatPercent(m.gpu?.vramPercent),
    meta: (m) => compactUsage(m.gpu?.vramUsed, m.gpu?.vramTotal),
  },
  {
    key: 'cpuTemp', label: 'Temp CPU', series: ['cpuTemp'], max: 100,
    available: (m) => Number.isFinite(m.temperature?.cpuC),
    unavailableHint: 'Aucun capteur exposé — lancez LibreHardwareMonitor avec son serveur web (port 8085)',
    percent: (m) => Number.isFinite(m.temperature?.cpuC) ? (m.temperature.cpuC / 95) * 100 : null,
    value: (m) => tempLabel(m.temperature?.cpuC),
    meta: (m) => m.temperature?.source || '',
  },
  {
    key: 'gpuTemp', label: 'Temp GPU', series: ['gpuTemp'], max: 100,
    available: (m) => Number.isFinite(m.gpu?.tempC),
    unavailableHint: 'Aucun capteur exposé — lancez LibreHardwareMonitor avec son serveur web (port 8085)',
    percent: (m) => Number.isFinite(m.gpu?.tempC) ? (m.gpu.tempC / 95) * 100 : null,
    value: (m) => tempLabel(m.gpu?.tempC),
    meta: (m) => Number.isFinite(m.gpu?.hotspotC) ? `Hotspot ${tempLabel(m.gpu.hotspotC)}` : '',
  },
  {
    key: 'net', label: 'Réseau', series: ['netRx', 'netTx'], floor: 65536,
    legend: ['↓ reçu', '↑ envoyé'],
    available: (m) => Number.isFinite(m.network?.rxSec),
    unavailableHint: 'Débit réseau indisponible',
    value: (m) => `↓ ${formatRate(m.network?.rxSec)}`,
    meta: (m) => `↑ ${formatRate(m.network?.txSec)} · ${m.network?.iface || ''}`,
  },
  {
    key: 'disk', label: 'Disque', series: ['diskRead', 'diskWrite'], floor: 1048576,
    legend: ['lecture', 'écriture'],
    available: (m) => Number.isFinite(m.diskIo?.readSec),
    unavailableHint: 'Compteurs de performance Windows indisponibles',
    value: (m) => `L ${formatRate(m.diskIo?.readSec)}`,
    meta: (m) => `É ${formatRate(m.diskIo?.writeSec)}${m.diskIo?.queue ? ` · file ${m.diskIo.queue}` : ''}`,
  },
  {
    // Présent volontairement, et volontairement désactivé : le compteur n'existe
    // pas. Mieux vaut l'expliquer ici que laisser chercher.
    key: 'fps', label: 'FPS', series: [], disabled: true,
    available: () => false,
    unavailableHint: "Les FPS ne sont pas un compteur système : ils se mesurent en s'accrochant au moteur de rendu du jeu (RTSS, PresentMon). Impossible depuis FeedMe seul.",
    value: () => '--',
    meta: () => '',
  },
];

Dashboard.register({
  type: 'system',
  name: 'Système',
  icon: 'i-monitor',
  description: 'CPU, RAM, GPU, VRAM, températures, réseau et disque, avec graphes sur 60 secondes.',
  singleton: true,
  defaults: { enabled: ['cpu', 'ram', 'gpu', 'vram'], showDisks: false, showPicker: false },

  mount(ctx) {
    ctx.body.innerHTML = `
      <div class="mon-picker" data-picker hidden></div>
      <div class="mon-grid" data-grid></div>
      <div data-disks></div>
    `;
    const grid = ctx.body.querySelector('[data-grid]');
    const picker = ctx.body.querySelector('[data-picker]');
    const disksEl = ctx.body.querySelector('[data-disks]');

    ctx.tools(`
      <button class="widget-btn" data-pick title="Choisir les mesures affichées">${icon('i-settings', 'ic-sm')}</button>
      <button class="widget-btn" data-toggle-disks title="Afficher / masquer les disques">${icon('i-folder', 'ic-sm')}</button>
    `);
    ctx.root.querySelector('[data-pick]').addEventListener('click', () => {
      ctx.settings.showPicker = !ctx.settings.showPicker;
      ctx.save();
      renderPicker();
    });
    ctx.root.querySelector('[data-toggle-disks]').addEventListener('click', () => {
      ctx.settings.showDisks = !ctx.settings.showDisks;
      ctx.save();
      render(Store.metrics);
    });

    /* ── Sélecteur de mesures ── */
    function renderPicker() {
      picker.hidden = !ctx.settings.showPicker;
      if (picker.hidden) return;
      const metrics = Store.metrics;
      picker.innerHTML = SYSTEM_METRICS.map((def) => {
        const on = ctx.settings.enabled.includes(def.key);
        const ok = metrics ? def.available(metrics) : true;
        const hint = ok ? '' : (def.unavailableHint || 'Indisponible');
        return `<button class="chip mon-chip ${on ? 'active' : ''}${ok ? '' : ' unavailable'}"
                        data-metric="${escAttr(def.key)}" ${ok ? '' : 'disabled'}
                        title="${escAttr(hint)}">${esc(def.label)}</button>`;
      }).join('');
      for (const btn of picker.querySelectorAll('[data-metric]')) {
        btn.addEventListener('click', () => {
          const key = btn.dataset.metric;
          const list = ctx.settings.enabled;
          const at = list.indexOf(key);
          if (at === -1) list.push(key); else list.splice(at, 1);
          ctx.save();
          renderPicker();
          render(Store.metrics);
        });
      }
    }

    /* ── Cartes de mesure ──
       Les nœuds sont créés une fois puis mis à jour : recréer les <canvas> à
       chaque échantillon perdrait le contexte et ferait clignoter les graphes. */
    const cards = new Map(); // key -> { root, value, meta, canvas }

    function ensureCards(metrics) {
      const wanted = SYSTEM_METRICS.filter((def) =>
        ctx.settings.enabled.includes(def.key) && (!metrics || def.available(metrics)));

      // Retire les cartes qui ne sont plus voulues
      for (const [key, card] of cards) {
        if (!wanted.some((def) => def.key === key)) { card.root.remove(); cards.delete(key); }
      }

      for (const def of wanted) {
        if (cards.has(def.key)) continue;
        const root = document.createElement('div');
        root.className = 'mon-card';
        root.innerHTML = `
          <span class="mon-label">${esc(def.label)}</span>
          <span class="mon-value" data-value>--</span>
          <canvas class="mon-spark" data-spark></canvas>
          <div class="mon-meta" data-meta></div>
        `;
        cards.set(def.key, {
          def, root,
          value: root.querySelector('[data-value]'),
          meta: root.querySelector('[data-meta]'),
          canvas: root.querySelector('[data-spark]'),
        });
      }
      // Réordonne selon le catalogue pour que l'ordre reste stable
      for (const def of wanted) {
        const card = cards.get(def.key);
        if (card) grid.appendChild(card.root);
      }
      return wanted;
    }

    function paint(metrics) {
      for (const [, card] of cards) {
        const { def } = card;
        // Le chiffre en grand, l'unité en petit à côté (« 19 % » → 19 + %).
        const [, num, unit] = String(def.value(metrics)).match(/^([-\d.,]+)\s*(.*)$/) || [null, def.value(metrics), ''];
        card.value.innerHTML = `${esc(num)}${unit ? `<span class="mon-unit">${esc(unit)}</span>` : ''}`;
        // Sous-texte sur une seule ligne : la première formulation qui tient.
        const options = [].concat(def.meta(metrics)).filter(Boolean);
        card.meta.title = options[0] || '';
        for (const text of options) {
          card.meta.textContent = text;
          if (card.meta.scrollWidth <= card.meta.clientWidth) break;
        }
        if (!options.length) card.meta.textContent = '';

        const percent = def.percent?.(metrics);
        card.value.style.color = !Number.isFinite(percent) ? ''
          : percent >= 85 ? 'var(--danger)' : percent >= 70 ? 'var(--warn)' : 'var(--accent)';

        const series = def.series.map((key) => Store.history[key] || []);
        if (series.length === 0) continue;
        drawSparkline(card.canvas, series.length === 1 ? series[0] : series, {
          max: def.max,
          floor: def.floor,
          colors: def.series.length > 1 ? ['#60a5fa', '#f472b6'] : undefined,
          color: Number.isFinite(percent) ? meterColorHex(percent) : undefined,
        });
      }
    }

    // Les graphes prennent la couleur d'alerte de la valeur courante : un pic
    // rouge reste lisible même quand on ne regarde pas le chiffre.
    function meterColorHex(percent) {
      if (percent >= 85) return '#ff5a5f';
      if (percent >= 70) return '#f5b83d';
      return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4ade80';
    }

    /* ── Horloge de l'en-tête ──
       Le widget Horloge dédié prenait beaucoup de place pour une seule
       information : l'heure vit maintenant au centre de la barre du widget
       Système, et rejoint le résumé quand celui-ci prend la place au repli. */
    function clockText(withDate) {
      const now = new Date();
      const time = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      if (!withDate) return time;
      const date = now.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }).replace('/', '.');
      return `${date} · ${time}`;
    }

    function tickClock() {
      ctx.center(ctx.isCollapsed()
        ? ''
        : `<span class="widget-clock">${esc(clockText(true))}</span>`);
      if (ctx.isCollapsed()) renderSummary(Store.metrics);
    }

    function renderSummary(metrics) {
      // Replié, l'heure passe en tête du résumé : la zone centrale est masquée.
      const clock = `<strong class="sum-clock">${esc(clockText(false))}</strong>`;
      if (!metrics) { ctx.summary(`${clock} · mesures indisponibles`); return; }

      const parts = [];
      for (const key of ctx.settings.enabled) {
        const def = SYSTEM_METRICS.find((d) => d.key === key);
        if (!def || !def.available(metrics)) continue;
        parts.push(`${esc(def.label)} <strong>${esc(def.value(metrics))}</strong>`);
        if (parts.length === 2) break; // l'heure occupe déjà le début de la ligne
      }
      ctx.summary([clock, ...parts].join(' · '));
    }

    function renderDisks(metrics) {
      if (!ctx.settings.showDisks) { disksEl.innerHTML = ''; return; }
      const disks = metrics?.disks || [];
      disksEl.innerHTML = disks.length === 0 ? '' : `
        <div class="metric-list">${disks.map((disk) => {
          const pct = Number(disk.usedPercent) || 0;
          return `
            <div class="metric-row">
              <strong>${esc(disk.name || 'Disque')}</strong>
              <div class="meter"><div class="meter-fill" style="width:${Math.max(0, Math.min(100, pct))}%;background:${meterColor(pct)}"></div></div>
              <span>${formatPercent(pct)}</span>
            </div>`;
        }).join('')}</div>`;
    }

    function render(metrics) {
      renderSummary(metrics);
      if (ctx.isCollapsed()) return;

      if (!metrics) {
        grid.innerHTML = `<div class="empty compact">${icon('i-monitor')}<div>Mesures PC indisponibles</div></div>`;
        cards.clear();
        disksEl.innerHTML = '';
        return;
      }
      if (grid.querySelector('.empty')) grid.innerHTML = '';

      const wanted = ensureCards(metrics);
      if (wanted.length === 0) {
        grid.innerHTML = `<div class="empty compact">${icon('i-monitor')}<div>Aucune mesure sélectionnée</div>
          <p>Ouvrez le sélecteur avec l'engrenage pour en choisir.</p></div>`;
        cards.clear();
      } else {
        paint(metrics);
      }
      renderDisks(metrics);
      if (ctx.settings.showPicker) renderPicker();
    }

    // Un changement de largeur (dock ↔ tablette) invalide les buffers canvas.
    const observer = new ResizeObserver(() => { if (!ctx.isCollapsed()) paint(Store.metrics || {}); });
    observer.observe(ctx.body);
    ctx.on('layout', () => { if (!ctx.isCollapsed() && Store.metrics) paint(Store.metrics); });

    ctx.on('metrics', render);
    renderPicker();
    render(Store.metrics);
    tickClock();
    // Une seconde de cadence pour que la minute bascule pile, indépendamment du
    // rythme d'échantillonnage des mesures.
    ctx.every(tickClock, 1000);
    // Le widget vient peut-être d'être ajouté : première mesure immédiate.
    fetchSystemMetrics();

    ctx.tickClock = tickClock;
    ctx.cleanup = () => observer.disconnect();
  },

  destroy(ctx) {
    ctx.cleanup?.();
  },

  onExpand(ctx) {
    // Le corps n'est pas peint tant que le widget est replié : on redemande une
    // mesure pour le remplir sans attendre le prochain échantillon.
    ctx.tickClock?.();
    fetchSystemMetrics();
  },
});
