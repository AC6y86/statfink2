/**
 * This week: the week's timeline, what needs Joe, live scoring, the daily
 * validation and a one-row verification strip. Everything here is read from
 * existing endpoints (the verification data comes from /api/admin/status);
 * the only writes are approve/reject, the manual week advance and the
 * hold/release of the automatic Wednesday advance. Alerts,
 * rulings and the per-job detail live on /admin/status.
 */

import { getData, api } from '../api.js';
import { esc, ago, untilText, fmtDate, pill, card, toast, armed, busy, delegate, checksList, severityOf } from '../ui.js';
import { setContext } from '../main.js';
import { renderPendingItem, approvePending, recheckPending, rejectPending, overridePending, OPEN_STATUSES } from './moves.js';

export const title = 'This week';

let root = null;
let ctxRef = null;
let holdRef = { held: false };

// This is a dashboard: state and a queue. Running updates or validation by
// hand lives on Scoring & data → Sync.
export async function render(view, ctx) {
    ctxRef = ctx;
    root = document.createElement('div');
    root.className = 'stack';
    view.replaceChildren(root);
    delegate(root, {
        approve: el => approvePending(el, el.dataset.id, refresh),
        recheck: el => recheckPending(el, el.dataset.id, refresh),
        reject: el => togglePanel(`reject-${el.dataset.id}`),
        'reject-confirm': el => rejectPending(el.dataset.id, refresh),
        'reject-cancel': el => togglePanel(`reject-${el.dataset.id}`, true),
        override: el => togglePanel(`override-${el.dataset.id}`),
        'override-confirm': el => overridePending(el, el.dataset.id, refresh),
        'override-cancel': el => togglePanel(`override-${el.dataset.id}`, true),
        open: el => ctx.navigate('moves', el.dataset.tab || null),
        'view-alerts': () => ctx.navigate('status'),
        'view-status': () => ctx.navigate('status'),
        advance: el => armed(el, () => advanceWeek(el), 'Tap again to advance the week'),
        hold: el => toggleHold(el, true),
        release: el => toggleHold(el, false),
        recaps: () => ctx.navigate('recaps')
    });
    await refresh();
}

export async function refresh() {
    if (!root || !ctxRef) return;
    const s = ctxRef.settings || {};
    const week = Number(s.current_week);
    const season = Number(s.season_year);

    const [games, nextGames, pending, snapshot, hold, recaps] = await Promise.all([
        getData(`/api/nfl-games/${week}/${season}`).catch(() => []),
        week < 18 ? getData(`/api/nfl-games/${week + 1}/${season}`).catch(() => []) : Promise.resolve([]),
        getData('/api/admin/pending-moves').catch(() => ({ items: [] })),
        getData('/api/admin/status').catch(() => null),
        getData('/api/admin/advance/hold').catch(() => ({ held: false })),
        getData('/api/admin/recaps').catch(() => null)
    ]);
    holdRef = hold || { held: false };
    const validation = snapshot && snapshot.validation;
    const alerts = (snapshot && snapshot.alerts) || { unacknowledged: 0, critical: 0, items: [] };

    const advanceJob = snapshot && Array.isArray(snapshot.jobs) ? snapshot.jobs.find(j => j.job === 'weekly-advance') : null;
    const tl = timeline(Array.isArray(games) ? games : [], Array.isArray(nextGames) ? nextGames : [], validation, week, season, holdRef, advanceJob);
    tl.recaps = recaps && recaps.themes ? recaps.themes : null;
    tl.generating = !!(recaps && recaps.generating);
    setContext(tl.context);

    const items = (pending.items || []).filter(i => OPEN_STATUSES.includes(i.status)); // failed executions still need you
    const alertList = alerts.items || [];
    const unacked = alerts.unacknowledged || 0;
    const critical = alerts.critical || 0;

    root.innerHTML = `
        <section class="card">${tl.html}</section>
        <div class="grid-2">
            ${needsYou(items, unacked, critical, alertList, tl)}
            <div class="stack">
                ${liveCard(snapshot && snapshot.live)}
                ${weeklyCard(validation)}
            </div>
        </div>
        ${verificationStrip(snapshot)}`;
}

function togglePanel(id, forceHide = false) {
    const el = root.querySelector(`#${CSS.escape(id)}`);
    if (!el) return;
    el.hidden = forceHide ? true : !el.hidden;
    if (!el.hidden) { const input = el.querySelector('input'); if (input) input.focus(); }
}

// ---------- Timeline ----------

function dayKey(epochSec) {
    return new Date(epochSec * 1000).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function timeline(games, nextGames, validation, week, season, hold = { held: false }, advanceJob = null) {
    const nowSec = Math.floor(Date.now() / 1000);
    const isFinal = g => /^Final/.test(g.status || '');
    const isLive = g => g.status && !isFinal(g) && g.status !== 'Scheduled';
    const withTime = games.filter(g => g.game_time_epoch);
    const total = games.length;
    const finals = games.filter(isFinal).length;
    const live = games.filter(isLive).length;

    // Bucket games by local calendar day
    const days = new Map();
    for (const g of withTime.sort((a, b) => a.game_time_epoch - b.game_time_epoch)) {
        const key = dayKey(g.game_time_epoch);
        if (!days.has(key)) days.set(key, []);
        days.get(key).push(g);
    }

    const steps = [];
    for (const [key, list] of days) {
        const first = list[0].game_time_epoch;
        const last = list[list.length - 1].game_time_epoch;
        const done = list.every(isFinal);
        const anyLive = list.some(isLive);
        const inWindow = nowSec >= first - 900 && nowSec <= last + 4 * 3600;
        let state = 'upcoming';
        if (done) state = 'done';
        else if (anyLive || inWindow) state = 'now';
        const finalCount = list.filter(isFinal).length;
        let sub;
        if (done) sub = `${list.length} game${list.length === 1 ? '' : 's'} final`;
        else if (anyLive) sub = `${list.filter(isLive).length} live · ${finalCount}/${list.length} final`;
        else if (first > nowSec) sub = `${list.length} game${list.length === 1 ? '' : 's'} · kickoff ${untilText(first)}`;
        else sub = `${finalCount}/${list.length} final`;
        steps.push({ state, title: key, sub });
    }
    if (!steps.length) {
        steps.push({ state: 'upcoming', title: `Week ${week}`, sub: 'no games scheduled (offseason?)' });
    }

    // Validation step: the daily validation (13:00 UTC) that ran after the
    // week's last kickoff counts as this week's validation.
    const weekDone = total > 0 && finals === total;
    const lastKick = withTime.length ? Math.max(...withTime.map(g => g.game_time_epoch)) : null;
    const vStatus = validation && (validation.overallStatus || validation.status);
    const validated = validation && Number(validation.week) === week && Number(validation.season) === season &&
        vStatus && vStatus !== 'SKIPPED' && weekDone &&
        (!lastKick || new Date(validation.ts).getTime() / 1000 > lastKick);
    steps.push({
        state: validated ? 'done' : weekDone ? 'now' : 'upcoming',
        title: 'Daily 13:00 UTC · validation',
        sub: validated ? `${vStatus} · ${ago(validation.ts)}` : weekDone ? 'week complete · next daily validation 13:00 UTC (or run it now)' : 'daily 13:00 validation · themes proposed when the week is final'
    });

    // Advance step: automatic Wednesday 15:00 UTC (retry Thursday 15:00) on a PASS
    // validation, unless held. The button is the manual override either way.
    const nextKick = nextGames.filter(g => g.game_time_epoch).reduce((m, g) => (m === null || g.game_time_epoch < m ? g.game_time_epoch : m), null);
    let advState = 'upcoming';
    let advSub = week >= 18 ? 'final week - nothing to advance to' : 'automatic Wed 15:00 UTC (retry Thu 15:00) once validation is PASS · before next kickoff';
    let advDue = false;
    const autoRan = advanceJob && advanceJob.week === week && advanceJob.season === season && advanceJob.lastRun;
    if (week < 18 && weekDone) {
        advDue = true;
        const deadline = nextKick ? ` · week ${week + 1} kicks off ${untilText(nextKick)} (${fmtDate(nextKick * 1000)})` : '';
        if (nextKick && nextKick < nowSec) { advState = 'overdue'; advSub = `week ${week + 1} kicked off ${untilText(nextKick)} - its stats are NOT being collected`; }
        else if (hold.held) { advState = 'due'; advSub = `HELD by you${hold.reason ? ` (${hold.reason})` : ''} - the automatic advance will not run${deadline}`; }
        else if (autoRan && advanceJob.status !== 'ok') { advState = 'due'; advSub = `automatic advance held: ${advanceJob.summary}${deadline}`; }
        else { advState = 'due'; advSub = `automatic Wed 15:00 UTC (retry Thu 15:00) if validation is PASS${deadline}`; }
    }
    const holdBtn = week < 18 && !(nextKick && nextKick < nowSec)
        ? (hold.held ? `<button class="btn sm ghost" data-action="release">Release hold</button>` : `<button class="btn sm ghost" data-action="hold">Hold the advance</button>`)
        : '';
    const advBtn = advDue ? `<button class="btn sm ${advState === 'overdue' ? 'danger' : 'primary'}" data-action="advance">Advance now</button>` : '';
    steps.push({ state: advState, title: `Advance to week ${week + 1} · ${hold.held ? 'held' : 'automatic'}`, sub: advSub, action: `${advBtn} ${holdBtn}`.trim() });

    const html = `<div class="timeline">${steps.map(st => `
        <div class="tl-step ${st.state}">
            <div class="tl-dot">${st.state === 'done' ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"></path></svg>' : ''}</div>
            <div><div class="tl-title">${esc(st.title)}</div><div class="tl-sub">${esc(st.sub)}</div>${st.action ? `<div style="margin-top:6px">${st.action}</div>` : ''}</div>
        </div>`).join('')}</div>`;

    const nextThisWeek = withTime.filter(g => g.game_time_epoch > nowSec).map(g => g.game_time_epoch).sort((a, b) => a - b)[0];
    let context;
    if (live) context = `Week ${week} · ${live} game${live === 1 ? '' : 's'} live · ${finals}/${total} final`;
    else if (weekDone) context = `Week ${week} complete · ${total} games final`;
    else if (nextThisWeek) context = `Week ${week} · ${finals}/${total} final · next kickoff ${untilText(nextThisWeek)}`;
    else context = `Week ${week} · ${season}`;

    return { html, context, weekDone, advDue, advState, nextKick, held: hold.held };
}

async function advanceWeek(button) {
    await busy(button, 'Advancing…', async () => {
        try {
            const body = await api.post('/api/admin/scheduler/weekly');
            const r = (body.data && body.data.results) || {};
            toast(body.success ? `Weekly update done: standings ${r.standings ? 'ok' : 'failed'}, week advance ${r.weekAdvance ? 'ok' : 'failed'}` : body.message || 'Weekly update failed', body.success ? 'success' : 'error');
        } catch (error) {
            toast(`Weekly update failed: ${error.message}`, 'error');
        }
        location.reload(); // settings (current_week) changed everywhere
    });
}

async function toggleHold(button, hold) {
    await busy(button, hold ? 'Holding…' : 'Releasing…', async () => {
        try {
            const reason = hold ? (window.prompt('Why hold the automatic advance? (shown on the status page)', 'reviewing scores') || 'held from /admin') : null;
            await api.post('/api/admin/advance/hold', hold ? { hold: true, reason } : { hold: false });
            toast(hold ? 'Automatic advance held' : 'Hold released', 'success');
        } catch (error) {
            toast(`Hold failed: ${error.message}`, 'error');
        }
        await refresh();
    });
}

// ---------- Needs you ----------

function needsYou(items, unacked, critical, alertList, tl) {
    const rows = [];
    for (const item of items) rows.push(renderPendingItem(item, ctxRef, { compact: true }));
    const nowSec = Math.floor(Date.now() / 1000);
    const soon = tl.nextKick && tl.nextKick - nowSec < 8 * 3600; // past the Thursday 15:00 UTC retry
    if (tl.advDue && (tl.advState === 'overdue' || tl.held || soon)) {
        rows.push(`<div class="card-row">
            <div class="icon-box ${tl.advState === 'overdue' ? 'critical' : 'warning'}">${iconClock()}</div>
            <div class="grow"><div><strong>Advance the week</strong> · week ${esc(ctxRef.settings.current_week)} is complete${tl.held ? ' · held by you' : ''}</div>
            <div class="muted">Live updates only poll the current week. ${tl.nextKick ? `Next kickoff ${esc(untilText(tl.nextKick))}.` : ''}</div></div>
            <div class="actions"><button class="btn sm ${tl.advState === 'overdue' ? 'danger' : 'primary'}" data-action="advance">Advance week</button></div>
        </div>`);
    }
    if (tl.recaps && tl.recaps.themes.length && !tl.recaps.generatedAt && !tl.generating) {
        rows.push(`<div class="card-row">
            <div class="icon-box warning">${iconClock()}</div>
            <div class="grow"><div><strong>Recap themes ready</strong> · ${esc(String(tl.recaps.themes.length))} for ${esc(String(tl.recaps.season))} week ${esc(String(tl.recaps.week))}</div>
            <div class="muted">Review the list, add your own, then Generate${tl.recaps.canGenerate ? '' : ' (after the daily validation)'}.</div></div>
            <div class="actions"><button class="btn sm primary" data-action="recaps">Open Recaps</button></div>
        </div>`);
    }
    if (unacked > 0) {
        const newest = alertList.find(a => !a.acknowledged);
        rows.push(`<div class="card-row">
            <div class="icon-box ${critical ? 'critical' : 'warning'}">${iconAlert()}</div>
            <div class="grow"><div><strong>${unacked} alert${unacked === 1 ? '' : 's'}</strong> unacknowledged${newest ? ` · newest: ${esc(newest.source)}` : ''}</div>
            <div class="muted">${critical ? `${critical} critical` : 'warnings and info only'}${newest ? ` · ${esc(newest.message).slice(0, 90)}` : ''}</div></div>
            <div class="actions"><button class="btn sm" data-action="view-alerts">View on Verification</button></div>
        </div>`);
    }
    const count = items.length + (tl.advDue ? 1 : 0) + (unacked > 0 ? 1 : 0);
    return card({ title: 'Needs you', meta: count ? `${count} item${count === 1 ? '' : 's'}` : '', rows: rows.length ? rows.join('') : '<div class="empty">Nothing waiting on you</div>' });
}

// ---------- Live scoring / validation ----------

function liveCard(live) {
    const w = live && live.latest;
    const n = live && live.notifier;
    if (!w) return card({ title: 'Live scoring', body: '<span class="quiet">The watchdog has not written a check yet (<code>pm2 logs statfink2-watchdog</code>).</span>' });
    const ageMin = (Date.now() - new Date(w.ts).getTime()) / 60000;
    const sev = w.severity || 'critical';
    const meta = [`checked ${ago(w.ts)}`];
    if (w.expectedGames != null) meta.push(`${w.expectedGames} game(s) in window`);
    if (w.gamesInProgress != null) meta.push(`${w.gamesInProgress} in progress`);
    if (w.loopAgeSec != null) meta.push(`loop ${w.loopAgeSec}s ago`);
    const chips = (w.signals || []).map(s => `<span class="chip${s.ok ? '' : (s.severity === 'critical' ? ' bad' : ' warn')}" title="${esc(s.detail || '')}">${esc(String(s.name || '').replace(/_/g, ' '))}</span>`).join('');
    return card({
        title: `Live scoring ${pill(sev, w.status)}`,
        actions: '',
        body: `
            <div>${esc(w.summary || '')}</div>
            <div class="muted">${esc(meta.join(' · '))}</div>
            ${ageMin > 15 ? '<div class="note critical">Watchdog silent - check <code>statfink2-watchdog</code>.</div>' : ''}
            ${n && n.incident ? `<div class="note ${esc(n.incident.severity || 'warning')}">Open incident: ${esc(n.incident.status)} since ${esc(ago(n.incident.since))}${n.incident.emails ? `, emailed ${esc(String(n.incident.emails))}×` : ''}</div>` : ''}
            <div class="chips">${chips}</div>`
    });
}

function weeklyCard(v) {
    if (!v) return card({ title: 'Validation', body: '<span class="quiet">The daily validation has not written a status yet (runs with the daily update, 13:00 UTC).</span>' });
    const status = v.overallStatus || v.status || '?';
    const gc = v.gamesComplete;
    const games = gc && gc.totalGames > 0 ? ` · games ${gc.completedGames}/${gc.totalGames} final` : '';
    const sm = v.healthSummary || {};
    const ageDays = (Date.now() - new Date(v.ts).getTime()) / 86400000;
    return card({
        title: `Validation ${pill(severityOf(status), status)}`,
        body: `
            <div>${esc(String(v.season || '?'))} week ${esc(String(v.week || '?'))}${v.mode ? ` · ${esc(v.mode)}` : ''}${games}${v.checks ? ` · ${sm.passed ?? 0} passed, ${sm.failed ?? 0} failed, ${sm.warnings ?? 0} warnings${sm.deferred ? `, ${sm.deferred} deferred` : ''}` : ''}</div>
            <div class="muted">run ${ago(v.ts)} (${fmtDate(v.ts)})${typeof v.summary === 'string' && v.summary ? ` · ${esc(v.summary)}` : ''}</div>
            ${ageDays > 1.1 && status !== 'SKIPPED' ? '<div class="note critical">Last run is over a day old - check <code>statfink2-daily</code>.</div>' : ''}
            ${v.checks ? `<details class="disclosure"><summary>Checks</summary>${checksList(v.checks)}</details>` : ''}`
    });
}

// ---------- Verification strip ----------

function verificationStrip(snapshot) {
    if (!snapshot) return card({ title: 'Verification', body: '<span class="quiet">Status unavailable - <a href="/admin/status">open the Verification page</a>.</span>' });
    const stale = snapshot.jobs.filter(j => j.reason === 'stale').length;
    const rulings = (snapshot.questions || []).filter(q => q.needsRuling).length;
    const meta = [`overall ${snapshot.overall}`];
    if (stale) meta.push(`${stale} not running`);
    if (rulings) meta.push(`${rulings} ruling${rulings === 1 ? '' : 's'} needed`);
    if (snapshot.maintenance) meta.push('maintenance');
    if (snapshot.offseason) meta.push('offseason');
    const chips = snapshot.jobs.map(j =>
        `<a class="chip strip-chip" href="/admin/status#${esc(j.job)}" title="${esc(j.summary || j.status)}${j.lastRun ? ` · ${esc(ago(j.lastRun))}` : ''}"><span class="dot ${esc(j.effective)}"></span> ${esc(j.title)}</a>`
    ).join('');
    return card({
        title: `Verification ${pill(snapshot.overall, snapshot.overall)}`,
        meta: esc(meta.join(' · ')),
        actions: '<button class="btn sm" data-action="view-status">Open</button>',
        body: `<div class="chips">${chips}</div>`
    });
}

function iconClock() {
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>';
}
function iconAlert() {
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path></svg>';
}
