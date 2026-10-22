/**
 * Scoring & data: Sync (manual updates, full re-sync), Tests (validation
 * suites, clear week), Database (table browser + SELECT console).
 * Destructive actions are two-tap. Nothing here edits cron schedules -
 * those live in ecosystem.config.js.
 */

import { getData, api } from '../api.js';
import { esc, ago, fmtDate, pill, card, toast, armed, busy, delegate, checksList, severityOf } from '../ui.js';
import { setContext } from '../main.js';

export const title = 'Scoring & data';

let root = null;
let ctxRef = null;
let tab = 'sync';
let db = { tables: null, table: '', page: 1, totalPages: 1, limit: 50, search: '', column: '' };

export async function render(view, ctx, opts = {}) {
    ctxRef = ctx;
    tab = ['sync', 'tests', 'database'].includes(opts.tab) ? opts.tab : 'sync';
    root = document.createElement('div');
    root.className = 'stack';
    view.replaceChildren(root);
    delegate(root, {
        tab: el => ctx.navigate('data', el.dataset.tab === 'sync' ? null : el.dataset.tab),
        daily: el => runJob(el, '/api/admin/scheduler/daily', 'Daily update', renderDaily),
        weekly: el => armed(el, () => runJob(el, '/api/admin/scheduler/weekly', 'Weekly update', renderWeekly, true), 'Tap again: advances the week'),
        live: el => runJob(el, '/api/admin/scheduler/live', 'Live update', renderLive),
        'sync-current': el => armed(el, () => runJob(el, '/api/admin/sync/games/current-week', 'Full sync', renderSync), 'Tap again: wipes + re-syncs this week'),
        'sync-week': el => armed(el, () => {
            const season = Number(root.querySelector('#sync-season').value);
            const week = Number(root.querySelector('#sync-week').value);
            return runJob(el, '/api/admin/sync/games/specific-week', `Full sync week ${week}`, renderSync, false, { season, week });
        }, 'Tap again: wipes + re-syncs that week'),
        'test-validate': el => runTest(el, '/api/admin/test/validate-week'),
        'test-stats': el => runTest(el, '/api/admin/test/stats-completeness'),
        'test-clear': el => armed(el, () => clearWeek(el), 'Tap again: DELETES the week'),
        'db-page': el => { db.page = Number(el.dataset.page); loadTable(); },
        'db-search': () => { db.search = root.querySelector('#db-search').value; db.column = root.querySelector('#db-column').value; db.page = 1; loadTable(); },
        'db-clear': () => { db.search = ''; db.column = ''; db.page = 1; loadTable(); },
        'db-query': el => runQuery(el)
    });
    root.addEventListener('change', event => {
        if (event.target.id === 'db-table') { db.table = event.target.value; db.page = 1; db.search = ''; db.column = ''; loadTable(); }
        if (event.target.id === 'db-limit') { db.limit = Number(event.target.value); db.page = 1; loadTable(); }
    });
    await refresh();
}

export async function refresh() {
    if (!root) return;
    setContext(`Week ${ctxRef.settings?.current_week ?? '?'} · ${ctxRef.settings?.season_year ?? ''}`);
    root.innerHTML = `
        <div class="subtabs">
            ${['sync', 'tests', 'database'].map(t => `<button data-action="tab" data-tab="${t}" class="${tab === t ? 'active' : ''}">${{ sync: 'Sync & updates', tests: 'Tests', database: 'Database' }[t]}</button>`).join('')}
        </div>
        <div id="area-body"></div>`;
    if (tab === 'sync') await renderSyncTab();
    else if (tab === 'tests') await renderTestsTab();
    else await renderDatabaseTab();
}

// ---------- Sync ----------

async function renderSyncTab() {
    const body = root.querySelector('#area-body');
    const s = await getData('/api/admin/scheduler/status').catch(() => ({}));
    const week = ctxRef.settings?.current_week;
    const season = ctxRef.settings?.season_year;
    const line = (label, ts, unit) => {
        if (!ts) return `<div>${label}: <span class="err">never run</span></div>`;
        return `<div>${label}: ${fmtDate(ts)} <span class="muted">(${ago(ts)})</span></div>`;
    };
    const running = ['daily', 'weekly', 'live'].filter(k => s[`${k}UpdateInProgress`]);
    body.innerHTML = `
        <div class="grid-2">
            ${card({ title: 'Scheduler', meta: running.length ? pill('warning', `${running.join(', ')} running`) : pill('ok', 'idle'), body: `
                ${line('Daily update', s.lastDailyUpdate)}
                ${line('Weekly update', s.lastWeeklyUpdate)}
                ${line('Live update', s.lastLiveUpdate)}
                ${s.lastLiveErrors && s.lastLiveErrors.length ? `<div class="note warning">Last live update reported: ${esc(s.lastLiveErrors.join(' | '))}</div>` : ''}
                <div class="muted">Schedules: daily update + validation 13:00 UTC · live every 60 s · Double Check 06:00 UTC · nightly tests 12:00 UTC · recap themes when the week is final · advance Wed 15:00 UTC (ecosystem.config.js)</div>` })}
            ${card({ title: 'Run now', body: `
                <div class="row"><button class="btn" data-action="daily">Run daily update</button><span class="muted">schedule sync, backup, player/injury sync, light validation</span></div>
                <div class="row"><button class="btn" data-action="live">Run live update</button><span class="muted">one pass of the live loop</span></div>
                <div class="row"><button class="btn danger" data-action="weekly">Run weekly update</button><span class="muted">standings → advance week ${esc(week)} → ${esc(Number(week) + 1)} → copy rosters. Do this after Tuesday's validation.</span></div>` })}
        </div>
        ${card({ title: 'Full re-sync from Tank01', meta: 'wipes the week’s stats and games first, then re-fetches every box score', body: `
            <div class="row"><button class="btn" data-action="sync-current">Full sync week ${esc(week)} (current)</button></div>
            <div class="row">
                <label class="field" style="width:120px">Season<input class="input" id="sync-season" type="number" value="${esc(season)}" min="2024" max="${esc(Number(season) + 1)}"></label>
                <label class="field" style="width:100px">Week<input class="input" id="sync-week" type="number" value="${esc(week)}" min="1" max="18"></label>
                <button class="btn" data-action="sync-week" style="align-self:flex-end">Full sync that week</button>
            </div>` })}
        <div id="job-result"></div>`;
}

async function runJob(button, path, label, renderer, reloadAfter = false, payload = undefined) {
    const out = root.querySelector('#job-result');
    await busy(button, `${label}…`, async () => {
        try {
            const body = await api.post(path, payload);
            out.innerHTML = renderer(body, label);
            toast(body.message || `${label} finished`, body.success === false ? 'error' : 'success');
        } catch (error) {
            const data = error.body && error.body.data;
            out.innerHTML = card({ title: `${esc(label)} failed`, body: `<div class="err">${esc(error.message)}</div>${data && data.results && data.results.errors ? `<ul>${data.results.errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}` });
            toast(`${label} failed: ${error.message}`, 'error');
        }
    });
    if (reloadAfter) location.reload();
}

const yn = v => (v ? pill('ok', 'ok') : pill('critical', 'failed'));
function errors(r) { return r.errors && r.errors.length ? `<div class="note warning">${r.errors.map(esc).join('<br>')}</div>` : ''; }

function renderDaily(body) {
    const r = (body.data && body.data.results) || {};
    return card({ title: 'Daily update', meta: `${body.data?.duration ?? '?'} ms`, body: `<div>Game schedule ${yn(r.gameSchedule)} · Backup ${yn(r.backup)} · Rosters ${yn(r.rosters)}</div>${errors(r)}${r.validation && r.validation.checks ? `<details class="disclosure" open><summary>Validation</summary>${checksList(r.validation.checks)}</details>` : ''}` });
}
function renderWeekly(body) {
    const r = (body.data && body.data.results) || {};
    const g = body.data && body.data.gamesStatus;
    return card({ title: 'Weekly update', meta: `${body.data?.duration ?? '?'} ms`, body: `<div>Standings ${yn(r.standings)} · Week advance ${yn(r.weekAdvance)}${g ? ` · games ${esc(g.completedGames)}/${esc(g.totalGames)} complete` : ''}</div>${errors(r)}` });
}
function renderLive(body) {
    const r = (body.data && body.data.results) || {};
    return card({ title: 'Live update', meta: `${body.data?.duration ?? '?'} ms`, body: `<div>Game scores ${yn(r.gameScores)} · ${esc(r.gamesInProgress ?? 0)} in progress · Defensive bonuses ${r.defensiveBonuses ? pill('ok', 'calculated') : pill('info', 'not yet')}</div>${errors(r)}` });
}
function renderSync(body, label) {
    const d = body.data || {};
    const rows = (d.results || []).map(g => `<tr><td>${esc(g.gameID)}</td><td>${esc(g.action)}</td><td>${esc(g.status || g.reason || g.error || '')}</td><td>${esc(g.scores || '')}</td></tr>`).join('');
    return card({ title: label, meta: `week ${esc(d.week)} · ${esc(d.season)}`, body: `
        <div>${esc(d.gamesUpdated ?? 0)} of ${esc(d.totalGames ?? 0)} games updated · ${esc(d.gamesSkipped ?? 0)} skipped · ${esc(d.apiCallsMade ?? 0)} Tank01 calls</div>
        ${rows ? `<details class="disclosure"><summary>Per game</summary><div class="table-wrap"><table class="table"><thead><tr><th>Game</th><th>Action</th><th>Status</th><th>Score</th></tr></thead><tbody>${rows}</tbody></table></div></details>` : ''}` });
}

// ---------- Tests ----------

async function renderTestsTab() {
    const body = root.querySelector('#area-body');
    const season = ctxRef.settings?.season_year;
    const res = await api.get(`/api/admin/test/available-weeks?season=${encodeURIComponent(season)}`).catch(() => ({ weeks: [] }));
    const weeks = res.weeks || [];
    body.innerHTML = `
        ${card({ title: 'Week tests', meta: `season ${esc(season)}`, body: `
            <div class="row">
                <label class="field" style="width:140px">Week<select class="input" id="test-week">${weeks.length ? weeks.map(w => `<option value="${w}" ${Number(w) === Number(ctxRef.settings?.current_week) ? 'selected' : ''}>Week ${w}</option>`).join('') : '<option value="">No weeks</option>'}</select></label>
                <button class="btn" data-action="test-validate" style="align-self:flex-end">Validate week</button>
                <button class="btn" data-action="test-stats" style="align-self:flex-end">Stats completeness (ESPN, slow)</button>
                <span class="spacer"></span>
                <button class="btn danger" data-action="test-clear" style="align-self:flex-end">Clear week data</button>
            </div>
            <div class="muted">Validate week runs the end-of-week checks in-process. Stats completeness spawns the ESPN verification suite and takes a while. Clear week data permanently deletes that week's stats and games; re-sync afterwards from the Sync tab.</div>` })}
        <div id="test-result"></div>`;
}

async function runTest(button, path) {
    const week = Number(root.querySelector('#test-week').value);
    const season = Number(ctxRef.settings?.season_year);
    const out = root.querySelector('#test-result');
    if (!week) { toast('Pick a week', 'error'); return; }
    await busy(button, 'Running…', async () => {
        try {
            const body = await api.post(path, { week, season });
            out.innerHTML = renderTestResults(body.results || body.data || {});
        } catch (error) {
            out.innerHTML = card({ title: 'Test failed to run', body: `<div class="err">${esc(error.message)}</div>` });
        }
    });
}

function renderTestResults(r) {
    const s = r.summary;
    let status = 'ok', headline = 'All tests passed';
    if (r.overallStatus === 'error') { status = 'critical'; headline = 'Test execution error'; }
    else if (s && s.failed > 0) { status = 'critical'; headline = `${s.failed} test(s) failed`; }
    else if (s && s.warnings > 0) { status = 'warning'; headline = `Passed with ${s.warnings} warning(s)`; }
    const checks = (r.checks || []).map(c => `<div class="card-row"><div class="grow"><div>${pill(severityOf(c.status), c.status)} <strong>${esc(c.name)}</strong></div><div>${esc(c.message || '')}</div>${c.details && (Array.isArray(c.details) ? c.details.length : true) ? `<details class="disclosure"><summary>Details</summary><pre class="block">${esc(Array.isArray(c.details) ? c.details.join('\n') : JSON.stringify(c.details, null, 2))}</pre></details>` : ''}</div></div>`).join('');
    return card({
        title: `${pill(status, headline)} week ${esc(r.week)} · ${esc(r.season)}`,
        meta: `${r.timestamp ? fmtDate(r.timestamp) : ''}${s ? ` · ${s.passed} passed, ${s.failed} failed, ${s.warnings} warnings` : ''}`,
        rows: checks || `<div class="card-body">${r.error ? `<div class="err">${esc(r.error.message || r.error)}</div>` : ''}${r.rawOutput ? `<pre class="block">${esc(String(r.rawOutput).slice(-4000))}</pre>` : ''}${r.errorOutput ? `<pre class="block">${esc(String(r.errorOutput).slice(-2000))}</pre>` : ''}</div>`
    });
}

async function clearWeek(button) {
    const week = Number(root.querySelector('#test-week').value);
    const season = Number(ctxRef.settings?.season_year);
    if (!week) { toast('Pick a week', 'error'); return; }
    await busy(button, 'Clearing…', async () => {
        try {
            const body = await api.post('/api/admin/test/clear-week-data', { week, season });
            toast(`${body.message || 'Cleared'}: ${body.statsDeleted ?? 0} stats, ${body.gamesDeleted ?? 0} games${body.matchupsReset !== undefined ? `, ${body.matchupsReset} matchups reset` : ''}`, 'success');
        } catch (error) {
            toast(`Clear failed: ${error.message}`, 'error');
        }
    });
}

// ---------- Database ----------

async function renderDatabaseTab() {
    const body = root.querySelector('#area-body');
    if (!db.tables) {
        body.innerHTML = '<p class="quiet">Loading tables…</p>';
        db.tables = await getData('/api/database/tables').catch(() => ({}));
    }
    const names = Object.keys(db.tables).sort();
    body.innerHTML = `
        ${card({ title: 'Browse a table', body: `
            <div class="row">
                <select class="input" style="width:auto" id="db-table"><option value="">Choose a table…</option>${names.map(n => `<option value="${esc(n)}" ${n === db.table ? 'selected' : ''}>${esc(n)} (${Number(db.tables[n].rowCount).toLocaleString()} rows)</option>`).join('')}</select>
                <select class="input" style="width:auto" id="db-column"><option value="">Search column…</option></select>
                <input class="input" style="flex:1 1 160px" id="db-search" placeholder="contains…" value="${esc(db.search)}">
                <button class="btn" data-action="db-search">Search</button><button class="btn" data-action="db-clear">Clear</button>
                <select class="input" style="width:auto" id="db-limit">${[25, 50, 100, 250].map(n => `<option value="${n}" ${n === db.limit ? 'selected' : ''}>${n} / page</option>`).join('')}</select>
            </div>
            <div id="db-columns" class="chips"></div>
            <div id="db-rows"></div>` })}
        ${card({ title: 'SELECT console', meta: 'read-only · first 100 rows shown', body: `
            <textarea class="input" id="db-sql" rows="4" placeholder="SELECT * FROM league_settings">SELECT current_week, season_year, last_live_update FROM league_settings</textarea>
            <div class="row"><button class="btn primary" data-action="db-query">Run query</button></div>
            <div id="db-query-result"></div>` })}`;
    if (db.table) await loadTable();
}

async function loadTable() {
    const info = db.tables[db.table];
    const colSel = root.querySelector('#db-column');
    const chips = root.querySelector('#db-columns');
    const out = root.querySelector('#db-rows');
    if (!info) { chips.innerHTML = ''; out.innerHTML = ''; return; }
    colSel.innerHTML = `<option value="">Search column…</option>${info.columns.map(c => `<option value="${esc(c.name)}" ${c.name === db.column ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}`;
    chips.innerHTML = info.columns.map(c => `<span class="chip" style="background:var(--border-soft);color:var(--text-2)" title="${esc(c.type)}">${esc(c.name)}${c.pk ? ' 🔑' : ''}</span>`).join('');
    out.innerHTML = '<p class="quiet">Loading…</p>';
    const params = new URLSearchParams({ page: db.page, limit: db.limit });
    if (db.search && db.column) { params.set('search', db.search); params.set('column', db.column); }
    try {
        const d = await getData(`/api/database/table/${encodeURIComponent(db.table)}?${params}`);
        db.totalPages = d.totalPages || 1;
        out.innerHTML = rowsTable(d.rows || []) + pager(d.page, d.totalPages, d.total);
    } catch (error) {
        out.innerHTML = `<p class="err">${esc(error.message)}</p>`;
    }
}

function rowsTable(rows, cap = Infinity) {
    if (!rows.length) return '<p class="quiet">No rows</p>';
    const cols = Object.keys(rows[0]);
    const cell = v => v === null || v === undefined ? '<span class="dim">NULL</span>' : esc(String(v).length > 120 ? `${String(v).slice(0, 120)}…` : String(v));
    return `<div class="table-wrap"><table class="table"><thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.slice(0, cap).map(r => `<tr>${cols.map(c => `<td class="mono">${cell(r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function pager(page, totalPages, total) {
    if (!totalPages || totalPages <= 1) return `<div class="muted" style="margin-top:8px">${Number(total || 0).toLocaleString()} rows</div>`;
    const nums = Array.from({ length: totalPages }, (_, i) => i + 1).filter(n => n === 1 || n === totalPages || Math.abs(n - page) <= 2);
    return `<div class="row" style="margin-top:8px">${nums.map(n => `<button class="btn sm ${n === page ? 'primary' : ''}" data-action="db-page" data-page="${n}">${n}</button>`).join('')}<span class="muted">page ${page} of ${totalPages} · ${Number(total).toLocaleString()} rows</span></div>`;
}

async function runQuery(button) {
    const sql = root.querySelector('#db-sql').value.trim();
    const out = root.querySelector('#db-query-result');
    if (!sql) { toast('Enter a SELECT', 'error'); return; }
    await busy(button, 'Running…', async () => {
        try {
            const body = await api.post('/api/database/query', { sql });
            const data = body.data || {};
            out.innerHTML = `<div class="muted" style="margin:8px 0">${Number(data.rowCount || 0).toLocaleString()} row(s)${data.rowCount > 100 ? ' · showing first 100' : ''}</div>${rowsTable(data.rows || [], 100)}`;
        } catch (error) {
            out.innerHTML = `<p class="err">${esc(error.message)}</p>`;
        }
    });
}
