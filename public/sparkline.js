'use strict';

/* ════════════════════════════════════════
   Sparkline — petits graphes sur fenêtre glissante
   ──────────────────────────────────────────
   Canvas plutôt que SVG : on redessine jusqu'à dix graphes toutes les 1,5 s, et
   remplacer autant de nœuds DOM ferait travailler le layout pour rien.

   L'abscisse est le temps, pas l'index de l'échantillon : une pause du sondage
   (fenêtre masquée, échantillon lent) laisse un trou visible au lieu d'étirer
   la courbe et de mentir sur la cadence.

     drawSparkline(canvas, [{t, v}, …], { max, color, windowMs })
     drawSparkline(canvas, [serieA, serieB], { colors: ['#a', '#b'] })
   ════════════════════════════════════════ */

const SPARK_WINDOW_MS = 60000;

function sparkResize(canvas) {
  // Un canvas flou sur écran HiDPI se voit immédiatement : on dimensionne le
  // buffer en pixels physiques et on remet l'échelle au contexte.
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return null;

  const bufferW = Math.round(width * dpr);
  const bufferH = Math.round(height * dpr);
  if (canvas.width !== bufferW || canvas.height !== bufferH) {
    canvas.width = bufferW;
    canvas.height = bufferH;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function seriesMax(all) {
  let max = 0;
  for (const series of all) {
    for (const point of series) if (point.v > max) max = point.v;
  }
  return max;
}

function drawSparkline(canvas, data, options = {}) {
  const surface = sparkResize(canvas);
  if (!surface) return;
  const { ctx, width, height } = surface;

  const all = Array.isArray(data[0]) ? data : [data];
  const colors = options.colors
    || [options.color || getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4ade80', '#60a5fa'];

  const windowMs = options.windowMs || SPARK_WINDOW_MS;
  const now = options.now || Date.now();
  const from = now - windowMs;

  // Échelle : fixe pour les pourcentages, adaptative pour les débits — mais
  // jamais collée au maximum, sinon la courbe touche le haut du cadre.
  const peak = seriesMax(all);
  const max = Number.isFinite(options.max) ? options.max : Math.max(peak * 1.15, options.floor || 1);

  const x = (t) => ((t - from) / windowMs) * width;
  const y = (v) => height - 1 - (Math.max(0, Math.min(max, v)) / max) * (height - 2);

  // Un trait fin, sans aire ni repère : le chiffre au-dessus dit la valeur,
  // le graphe ne montre que la tendance.
  all.forEach((series, index) => {
    const points = series.filter((p) => p.t >= from);
    if (points.length === 0) return;

    ctx.beginPath();
    points.forEach((point, i) => {
      const px = x(point.t);
      const py = y(point.v);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.strokeStyle = colors[index % colors.length];
    ctx.lineWidth = 1.2;
    ctx.lineJoin = 'round';
    if (index > 0) ctx.setLineDash([3, 2]);
    ctx.stroke();
    ctx.setLineDash([]);
  });
}
