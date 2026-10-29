'use strict';

/* ════════════════════════════════════════
   Widget Calendrier
   ──────────────────────────────────────────
   Deux sources fusionnées : des événements saisis ici, et des abonnements ICS
   en lecture seule. Pas d'OAuth Google — Google Calendar, Outlook et Apple
   exposent tous une URL ICS privée dans leurs réglages de partage, ce qui donne
   le même résultat sans écran de consentement à maintenir.
   ════════════════════════════════════════ */
Dashboard.register({
  type: 'calendar',
  name: 'Calendrier',
  icon: 'i-calendar',
  description: 'Vos prochains événements, saisis ici ou via un abonnement ICS.',
  singleton: true,
  defaults: { showForm: false, showSubs: false, horizon: 14 },

  mount(ctx) {
    ctx.body.innerHTML = `<div data-content></div>`;
    const content = ctx.body.querySelector('[data-content]');
    let events = [];
    let subscriptions = [];
    let errors = [];
    let loading = true;

    ctx.tools(`
      <button class="widget-btn" data-add title="Ajouter un événement">${icon('i-plus', 'ic-sm')}</button>
      <button class="widget-btn" data-subs title="Abonnements ICS">${icon('i-sync', 'ic-sm')}</button>
      <button class="widget-btn" data-refresh title="Actualiser">${icon('i-refresh', 'ic-sm')}</button>
    `);
    const tool = (sel) => ctx.root.querySelector(sel);
    tool('[data-add]').addEventListener('click', () => {
      ctx.settings.showForm = !ctx.settings.showForm;
      ctx.settings.showSubs = false;
      ctx.save();
      render();
    });
    tool('[data-subs]').addEventListener('click', () => {
      ctx.settings.showSubs = !ctx.settings.showSubs;
      ctx.settings.showForm = false;
      ctx.save();
      render();
    });
    tool('[data-refresh]').addEventListener('click', () => load());

    async function load() {
      loading = true;
      try {
        const data = await api('/api/calendar');
        events = data.events || [];
        subscriptions = data.subscriptions || [];
        errors = data.errors || [];
      } catch (e) {
        errors = [e.message];
      } finally {
        loading = false;
      }
      render();
    }

    /* ── Regroupement par jour ── */
    function dayKey(iso) { return new Date(iso).toDateString(); }

    function dayLabel(iso) {
      const date = new Date(iso);
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const diff = Math.round((new Date(date).setHours(0, 0, 0, 0) - today.getTime()) / 86400000);
      if (diff === 0) return "Aujourd'hui";
      if (diff === 1) return 'Demain';
      if (diff < 7) return date.toLocaleDateString('fr-FR', { weekday: 'long' });
      return date.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
    }

    function withinHorizon(event) {
      const limit = Date.now() + ctx.settings.horizon * 86400000;
      return new Date(event.start).getTime() <= limit;
    }

    /* ── Rendu ── */
    function render() {
      const upcoming = events.filter(withinHorizon);
      const next = upcoming[0];
      ctx.summary(next
        ? `${esc(dayLabel(next.start))} · <strong>${esc(next.title)}</strong>`
        : (loading ? 'chargement…' : 'rien de prévu'));

      if (ctx.isCollapsed()) return;

      const groups = new Map();
      for (const event of upcoming) {
        const key = dayKey(event.start);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(event);
      }

      content.innerHTML = `
        ${ctx.settings.showForm ? renderForm() : ''}
        ${ctx.settings.showSubs ? renderSubs() : ''}
        ${errors.length ? `<div class="cal-warn">${icon('i-x', 'ic-xs')} ${errors.map(esc).join(' · ')}</div>` : ''}
        ${groups.size === 0
          ? `<div class="empty compact">${icon('i-calendar')}<div>${loading ? 'Chargement…' : 'Rien de prévu'}</div>
             ${loading ? '' : `<p>Ajoutez un événement ou abonnez un agenda ICS.</p>`}</div>`
          : [...groups.entries()].map(([, list]) => `
              <div class="cal-day">
                <div class="cal-day-head">${esc(dayLabel(list[0].start))}</div>
                ${list.map(renderEvent).join('')}
              </div>`).join('')}
      `;
      wire();
    }

    function renderEvent(event) {
      const time = event.allDay
        ? 'journée'
        : new Date(event.start).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      return `
        <div class="cal-event${event.remote ? ' remote' : ''}">
          <span class="cal-time">${esc(time)}</span>
          <span class="cal-body">
            <span class="cal-title">${esc(event.title)}</span>
            ${event.location ? `<span class="cal-loc">${esc(event.location)}</span>` : ''}
            ${event.source ? `<span class="cal-src">${esc(event.source)}</span>` : ''}
          </span>
          ${event.remote
            ? `<span class="cal-remote-mark" title="Événement importé — modifiez-le dans son agenda d'origine">${icon('i-sync', 'ic-xs')}</span>`
            : `<button class="action-btn" data-del="${escAttr(event.id)}" title="Supprimer">${icon('i-trash')}</button>`}
        </div>`;
    }

    function renderForm() {
      // datetime-local attend l'heure locale sans fuseau : on décale l'ISO.
      const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
      return `
        <form class="cal-form" data-form>
          <input type="text" data-title placeholder="Intitulé de l'événement…" required>
          <div class="cal-form-row">
            <input type="datetime-local" data-start value="${now.toISOString().slice(0, 16)}" required>
            <label class="cal-allday"><input type="checkbox" data-allday> journée</label>
          </div>
          <input type="text" data-loc placeholder="Lieu (optionnel)">
          <button type="submit" class="btn primary">${icon('i-plus', 'ic-sm')} Ajouter</button>
        </form>`;
    }

    function renderSubs() {
      return `
        <div class="cal-subs">
          <p class="section-hint" style="margin:0 0 8px">
            Collez l'URL ICS privée de votre agenda (Google Calendar : Paramètres de l'agenda →
            « Adresse secrète au format iCal »). Lecture seule, actualisée toutes les 15 minutes.
          </p>
          ${subscriptions.map((s) => `
            <div class="list-row">
              <div class="list-row-info">
                <div class="list-row-title">${esc(s.name)}</div>
                <div class="list-row-sub">${esc(s.url.slice(0, 60))}…</div>
              </div>
              <button class="ghost-btn danger" data-unsub="${escAttr(s.id)}" title="Retirer">${icon('i-trash')}</button>
            </div>`).join('')}
          <form class="cal-form" data-sub-form>
            <input type="text" data-sub-name placeholder="Nom de l'agenda…">
            <input type="url" data-sub-url placeholder="https://…/basic.ics" required>
            <button type="submit" class="btn primary">${icon('i-plus', 'ic-sm')} Abonner</button>
          </form>
        </div>`;
    }

    function wire() {
      const form = content.querySelector('[data-form]');
      if (form) {
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const title = form.querySelector('[data-title]').value.trim();
          const start = form.querySelector('[data-start]').value;
          if (!title || !start) return;
          try {
            await api('/api/calendar/events', {
              method: 'POST',
              json: {
                title,
                start: new Date(start).toISOString(),
                allDay: form.querySelector('[data-allday]').checked,
                location: form.querySelector('[data-loc]').value.trim(),
              },
            });
            ctx.settings.showForm = false;
            ctx.save();
            showToast('Événement ajouté');
            load();
          } catch (err) {
            showToast(err.message, 'error');
          }
        });
      }

      const subForm = content.querySelector('[data-sub-form]');
      if (subForm) {
        subForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const url = subForm.querySelector('[data-sub-url]').value.trim();
          const name = subForm.querySelector('[data-sub-name]').value.trim();
          const btn = subForm.querySelector('button');
          btn.disabled = true;
          try {
            const data = await api('/api/calendar/subscriptions', { method: 'POST', json: { url, name } });
            showToast(data.duplicate ? 'Agenda déjà abonné' : `Agenda abonné (${data.events} événements)`);
            load();
          } catch (err) {
            showToast(err.message, 'error');
          } finally {
            btn.disabled = false;
          }
        });
      }

      for (const btn of content.querySelectorAll('[data-del]')) {
        btn.addEventListener('click', () => confirmClick(btn, 'calendarDelete', btn.dataset.del));
      }
      for (const btn of content.querySelectorAll('[data-unsub]')) {
        btn.addEventListener('click', () => confirmClick(btn, 'calendarUnsubscribe', btn.dataset.unsub));
      }
    }

    // Les suppressions passent par confirmClick, qui appelle une fonction globale.
    window.calendarDelete = async (id) => {
      try {
        await api(`/api/calendar/events/${encodeURIComponent(id)}`, { method: 'DELETE' });
        load();
      } catch (e) { showToast(e.message, 'error'); }
    };
    window.calendarUnsubscribe = async (id) => {
      try {
        await api(`/api/calendar/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' });
        showToast('Abonnement retiré');
        load();
      } catch (e) { showToast(e.message, 'error'); }
    };

    ctx.repaint = render;
    render();
    load();
    // Les abonnements ICS sont cachés 15 min côté serveur.
    ctx.every(() => { if (!document.hidden) load(); }, 15 * 60 * 1000);
  },

  onExpand(ctx) { ctx.repaint?.(); },
});
