'use strict';

let usagePending = null, usageConfig = { sources: [], connections: [] }, usageDiscovery = null;
async function fetchAiUsage(force = false) {
  if (usagePending) return usagePending;
  usagePending = (async () => {
    try { Store.aiUsage = await api('/api/ai-usage' + (force ? '?refresh=1' : '')); }
    catch { Store.aiUsage = { ...(Store.aiUsage || {}), error: 'Impossible de joindre le suivi des quotas.', stale: true }; }
    Bus.emit('ai-usage', Store.aiUsage);
  })();
  try { await usagePending; } finally { usagePending = null; }
}
function openUsageSettings() {
  document.getElementById('settings-panel').classList.add('open');
  showSettingsSection('ai-usage');
}
function usageDate(time) {
  return time ? new Date(time).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
}
function usageTime(time) {
  return new Date(time).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}
// Remise à zéro : l'heure seule si c'est aujourd'hui, sinon « jeu. 06:00 ».
function usageReset(time) {
  const d = new Date(time);
  return d.toDateString() === new Date().toDateString() ? usageTime(d) : d.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '') + ' ' + usageTime(d);
}
function renderUsageWindow(w) {
  const used = Math.max(0, Math.min(100, w.usedPercent));
  // Vert tant qu'il en reste, orange à mi-parcours, rouge quand il devient bas.
  const tone = w.remainingPercent > 66 ? 'ok' : w.remainingPercent > 33 ? 'mid' : 'low';
  const label = [w.groupLabel, w.label === 'Week' ? 'Semaine' : w.label].filter(Boolean).join(' · ');
  const left = Math.round(w.remainingPercent);
  const title = `${label} : ${left} % restants, ${Math.round(used)} % consommés${w.resetAt ? ' · remise à zéro le ' + usageDate(w.resetAt) : ''}`;
  return `<div class="usage-window usage-${tone}" title="${escAttr(title)}"><div class="usage-window-head mono"><strong>${left}%</strong>${w.resetAt ? `<span>${esc(usageReset(w.resetAt))}</span>` : ''}</div><div class="usage-meter" role="progressbar" aria-label="${escAttr(label)} : quota consommé" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${used}" aria-valuetext="${Math.round(used)} % consommés, ${left} % restants"><span class="usage-meter-fill" style="width:${used}%"></span></div></div>`;
}
async function loadUsageSettings() {
  const area = document.getElementById('usage-settings-sources');
  try {
    usageConfig = await api('/api/ai-usage/config');
    area.innerHTML = usageConfig.sources.map((source, index) => `<div class="usage-source"><div><strong>${esc(source.label)}</strong><p class="set-hint">${source.providers === null ? 'Tous les abonnements disponibles' : source.providers.length + ' abonnement(s) sélectionné(s)'}</p></div><button class="btn" data-usage-edit="${index}">Modifier</button><button class="btn danger" data-usage-remove="${index}">Retirer</button></div>`).join('');
    area.querySelectorAll('[data-usage-remove]').forEach(button => button.onclick = async () => {
      try { await saveUsageSources(usageConfig.sources.filter((_, i) => i !== Number(button.dataset.usageRemove))); }
      catch { showToast('Impossible d’enregistrer les abonnements.'); }
    });
    area.querySelectorAll('[data-usage-edit]').forEach(button => button.onclick = () => {
      document.getElementById('usage-connection').value = usageConfig.sources[Number(button.dataset.usageEdit)].connectionId;
      discoverUsage();
    });
    document.getElementById('usage-connection').innerHTML = usageConfig.connections.map(c => `<option value="${escAttr(c.id)}">${esc(c.name)}</option>`).join('');
    document.getElementById('usage-discover').disabled = !usageConfig.connections.length;
    usageDiscovery = null;
    document.getElementById('usage-discovery').innerHTML = usageConfig.connections.length ? '' : '<p class="set-hint">Ajoutez d’abord votre passerelle dans l’onglet Agents.</p><button class="btn" onclick="document.getElementById(\'settings-panel\').classList.remove(\'open\');document.querySelector(\'[data-workspace=agents]\').click()">Ouvrir Agents</button>';
  } catch { area.textContent = 'Impossible de charger les abonnements.'; }
}
async function discoverUsage() {
  const button = document.getElementById('usage-discover'), area = document.getElementById('usage-discovery');
  const connectionId = document.getElementById('usage-connection').value;
  if (!connectionId || button.disabled) return;
  button.disabled = true; area.textContent = 'Recherche des quotas…'; usageDiscovery = null;
  try {
    const result = await api('/api/ai-usage/discover', { method: 'POST', json: { connectionId } });
    if (document.getElementById('usage-connection').value !== connectionId) { area.textContent = 'Relancez la recherche pour cette connexion.'; return; }
    if (result.error || !result.providers.length) {
      area.textContent = result.error || 'Aucun quota disponible. Connectez votre abonnement dans OpenClaw, puis relancez la recherche.'; return;
    }
    // An account can run models without exposing subscription usage. Keep that distinction visible.
    if (!connectionId.startsWith('direct:') && !result.providers.some(p => p.provider === 'anthropic')) result.providers.push({ provider: 'anthropic', name: 'Claude', windows: [], error: 'Quota non communiqué par OpenClaw pour le moment.' });
    usageDiscovery = { connectionId, providers: result.providers };
    const selected = usageConfig.sources.find(s => s.connectionId === connectionId)?.providers;
    area.innerHTML = '<p>Choisissez les abonnements à afficher sur l’accueil.</p>' + result.providers.map((p, i) => `<label class="usage-choice"><input type="checkbox" data-usage-provider="${i}" ${!selected || selected.includes(p.provider) ? 'checked' : ''}><span><strong>${esc(p.name)}</strong>${p.plan ? ' · ' + esc(p.plan) : ''}<small>${esc(p.error || (p.windows.length ? p.windows.length + ' limite(s) disponible(s)' : 'Quota non communiqué'))}</small></span></label>`).join('') + '<button class="btn primary" onclick="connectUsage()">Afficher sur l’accueil</button>' + (connectionId.startsWith('direct:') ? '' : '<p class="set-hint">Claude absent ? Le compte peut permettre de discuter sans exposer son quota. <a href="https://docs.openclaw.ai/concepts/usage-tracking" target="_blank" rel="noopener noreferrer">Vérifier le suivi d’utilisation dans OpenClaw</a>.</p>');
  } catch { area.textContent = connectionId.startsWith('direct:') ? 'Impossible de rechercher les abonnements. Vérifiez la connexion du compte sur ce PC.' : 'Impossible de rechercher les abonnements. Vérifiez la connexion à OpenClaw.'; }
  finally { button.disabled = false; }
}
async function saveUsageSources(sources) {
  await api('/api/ai-usage/config', { method: 'POST', json: { sources } });
  await loadUsageSettings(); await fetchAiUsage(true);
}
async function connectUsage() {
  const discovered = usageDiscovery;
  if (!discovered || discovered.connectionId !== document.getElementById('usage-connection').value) return;
  const providers = [...document.querySelectorAll('[data-usage-provider]:checked')].map(input => discovered.providers[Number(input.dataset.usageProvider)].provider);
  if (!providers.length) { showToast('Choisissez au moins un abonnement.'); return; }
  const source = { connectionId: discovered.connectionId, label: usageConfig.connections.find(c => c.id === discovered.connectionId).name, providers };
  try {
    await saveUsageSources([...usageConfig.sources.filter(s => s.connectionId !== source.connectionId), source]);
    if (!Dashboard.hasType('ai-usage')) Dashboard.add('ai-usage');
    showToast('Abonnements ajoutés à l’accueil.');
  } catch { showToast('Impossible d’enregistrer les abonnements.'); }
}

Dashboard.register({
  type: 'ai-usage', name: 'Quotas IA', icon: 'i-sparkle', singleton: true,
  description: 'Les quotas restants de vos abonnements et leur remise à zéro.',
  mount(ctx) {
    ctx.tools(`<button class="widget-btn usage-refresh" title="Actualiser les quotas" aria-label="Actualiser les quotas">${icon('i-sync', 'ic-sm')}</button><button class="widget-btn usage-settings" title="Abonnements IA" aria-label="Configurer les abonnements IA">${icon('i-settings', 'ic-sm')}</button>`);
    ctx.root.querySelector('.usage-settings').onclick = openUsageSettings;
    ctx.root.querySelector('.usage-refresh').onclick = async () => { ctx.setBusy(true); try { await fetchAiUsage(true); } finally { ctx.setBusy(false); } };
    const render = data => {
      ctx.summary(data?.configured ? 'Quotas des abonnements' : 'À connecter');
      ctx.center(''); ctx.body.title = '';
      if (!data) { ctx.body.innerHTML = '<p class="usage-empty">Chargement des quotas…</p>'; return; }
      if (!data.configured) {
        ctx.body.innerHTML = `<div class="usage-empty"><strong>Vos abonnements, en un coup d’œil</strong><p>${esc(data.error || 'Suivez les quotas restants et les prochaines remises à zéro.')}</p><button class="btn primary">Connecter mes abonnements</button></div>`;
        ctx.body.querySelector('button').onclick = openUsageSettings; return;
      }
      // En-tête épuré : rien au centre, sauf un repère quand les valeurs sont
      // anciennes. Les colonnes (session · semaine) et l'heure de mise à jour
      // passent en infobulle du corps ; replié, on garde les quotas courts.
      const providers = data.sources.flatMap(s => s.providers);
      const updated = Math.max(0, ...providers.map(p => p.updatedAt || 0));
      const stale = data.stale || data.sources.some(s => s.stale || s.providers.some(p => p.stale));
      const short = providers.filter(p => p.windows.length).map(p => `${esc(p.name)} <strong>${Math.round(p.windows[0].remainingPercent)} %</strong>`).join(' · ');
      ctx.summary(short || 'Quotas des abonnements');
      const freshness = updated ? (stale ? 'Dernières valeurs connues · ' : 'Actualisé à ') + usageTime(updated) : '';
      ctx.center(stale ? `<span class="usage-stale" title="${escAttr(freshness)}">valeurs anciennes</span>` : '');
      ctx.body.title = ['Restant par session · par semaine', freshness].filter(Boolean).join('\n');
      // Pas d'intertitre par connexion : le nom court suffit (« ChatGPT » pour
      // « ChatGPT / Codex ») ; le nom complet et la connexion sont en infobulle.
      ctx.body.innerHTML = (data.error ? `<p class="usage-warning">${esc(data.error)}</p>` : '') + data.sources.map(source => `${source.error ? `<p class="usage-warning">${esc(source.error)}${source.providers.length ? ' Dernières valeurs connues.' : ''}</p>` : ''}${source.providers.length ? source.providers.map(provider => {
        const info = [provider.name, provider.plan, source.label].filter(Boolean).join(' · ');
        // Old values stay visible, with the reason they could not be refreshed.
        const why = provider.windows.length && provider.error ? `<p class="usage-account-note">${esc(provider.error)}</p>` : '';
        return `<article class="usage-account"><strong class="usage-name" title="${escAttr(info)}">${esc(provider.name.split(' / ')[0])}</strong>${provider.windows.length ? `<div class="usage-windows">${provider.windows.map(renderUsageWindow).join('')}</div>` : `<span class="usage-none">${esc(provider.error || 'Quota non communiqué')}</span>`}${why}</article>`;
      }).join('') : '<p class="usage-empty">Aucun quota disponible pour cette connexion.</p>'}`).join('');
    };
    ctx.on('ai-usage', render); render(Store.aiUsage);
    fetchAiUsage();
  }
});
document.addEventListener('DOMContentLoaded', () => {
  setInterval(() => { if (!document.hidden && Bus.count('ai-usage') > 0) fetchAiUsage(); }, 120000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Bus.count('ai-usage') > 0) fetchAiUsage(); });
});

