/**
 * Verification: is every check running, and what did it find. One fetch of
 * /api/admin/status (server/services/jobStatusService.js) feeds every card:
 * jobs, live scoring, questions needing a ruling, this week's defensive
 * scores, the Double Check, the log sentinel's error fingerprints, the daily
 * validation, recaps and alerts.
 * Writes: a commissioner ruling (POST /api/admin/doublecheck/ruling),
 * log-noise acks (POST/DELETE /api/admin/log-noise/ack) and alert acks.
 */

import { getData, api } from '../api.js';
import { esc, ago, fmtDate, untilText, pill, card, toast, busy, delegate, checksList, severityOf } from '../ui.js';
import { setContext } from '../main.js';
import { warningSummary } from './warningSummary.js';

export const title = 'Verification';

const AWARD_CLASSES = ['DEF_8_INT', 'DEF_8_FUMBLE', 'DEF_8_BLOCKED', 'RETURN_20_KICK', 'RETURN_20_PUNT',
    'OFF_PASS', 'OFF_RUSH', 'OFF_RECOVERY', 'SAFETY_2', 'NOT_A_SCORE'];
const AWARD_LABELS = {
    DEF_8_INT: 'Defensive TD (8) - interception return', DEF_8_FUMBLE: 'Defensive TD (8) - fumble return',
    DEF_8_BLOCKED: 'Defensive TD (8) - blocked kick', RETURN_20_KICK: 'Kick return TD (20)', RETURN_20_PUNT: 'Punt return TD (20)',
    OFF_PASS: 'Offensive passing TD', OFF_RUSH: 'Offensive rushing TD', OFF_RECOVERY: 'Offensive fumble recovery TD (8)',
    SAFETY_2: 'Safety (2)', NOT_A_SCORE: 'Not a score'
};

let root = null;
let showAcked = false;
let snapshot = null;

export async function render(view, ctx) {
    root = document.createElement('div');
    root.className = 'stack';
    view.replaceChildren(root);
    delegate(root, {
        ack: el => ackAlerts([el.dataset.id]),
        'ack-all': () => ackAlerts(null),
        'clear-all': el => clearAllWarnings(el),
        'toggle-acked': el => { showAcked = el.checked; loadAlerts(); },
        'save-ruling': el => saveRuling(el),
        'ack-noise': el => ackNoise(el, true),
        'unack-noise': el => ackNoise(el, false)
    });
    await refresh();
}

export async function refresh() {
    if (!root) return;
    const [status, moves] = await Promise.all([
        getData('/api/admin/status'),
        getData('/api/admin/pending-moves').catch(() => null)
    ]);
    snapshot = status;
    const s = snapshot;
    const stale = s.jobs.filter(j => j.reason === 'stale').length;
    const rulings = s.questions.filter(q => q.needsRuling).length;
    const bits = [`overall ${s.overall}`];
    if (stale) bits.push(`${stale} job${stale === 1 ? '' : 's'} not running`);
    if (rulings) bits.push(`${rulings} ruling${rulings === 1 ? '' : 's'} needed`);
    if (s.offseason) bits.push('offseason');
    if (s.maintenance) bits.push('maintenance');
    setContext(bits.join(' · '));

    root.innerHTML = `
        ${warningSummaryCard(s, moves)}
        ${overallNote(s)}
        ${jobsCard(s)}
        ${liveCard(s.live, s.diagnosis)}
        ${liveReviewCard(s.liveReview, s.qwen, s.jobs.find(j => j.job === 'live-review'))}
        ${rulingsCard(s.questions)}
        ${defensiveCard(s.doublecheck)}
        ${doublecheckCard(s.doublecheck)}
        ${logErrorsCard(s.logErrors, s.jobs.find(j => j.job === 'log-sentinel'))}
        ${validationCard(s.validation)}
        ${recapsCard(s.recaps, s.jobs.find(j => j.job === 'recaps'))}
        ${alertsCard(s.alerts.items || [], s.alerts.unacknowledged)}`;
    if (showAcked) loadAlerts();
}

// ---------- Overall ----------

function warningSummaryCard(s, moves) {
    const summary = warningSummary(s, moves);
    const rows = summary.rows.map(r => `<div class="card-row" style="display:block;overflow-wrap:anywhere">
        <div>${pill(r.kind, r.label)} <strong>${esc(r.title)}</strong></div>
        <p style="margin:6px 0">${esc(r.detail)}</p>
        <div class="muted">${r.timestamp ? `${esc(fmtDate(r.timestamp))} · ` : ''}<a href="${esc(r.href)}">View details</a></div>
    </div>`).join('');
    return card({ id: 'warning-summary', title: 'Warning summary', meta: `updated ${ago(s.generatedAt)}`,
        rows: `<div class="card-body"><strong>${esc(summary.headline)}</strong><div class="muted" style="margin-top:6px">${summary.rows.length ? 'Yellow can include unresolved issues, saved rulings, and old notices. Each is explained below.' : 'No warning notices in the latest verification snapshot.'}</div></div>${rows}` });
}

function overallNote(s) {
    const notes = [];
    const open = (s.alerts && s.alerts.unacknowledged) || 0;
    const fresh = (s.logErrors && s.logErrors.summary && s.logErrors.summary.newCount) || 0;
    if (open || fresh) {
        const what = [open ? `${open} open alert${open === 1 ? '' : 's'}` : '', fresh ? `${fresh} never-seen log error shape${fresh === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
        notes.push(`<div class="note warning" style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap"><span>${what} - they stay yellow until acknowledged.</span><button class="btn sm" data-action="clear-all">Clear all warnings</button></div>`);
    }
    if (s.advanceDeadline && s.advanceDeadline.status !== 'passed') {
        notes.push(`<div class="note ${s.advanceDeadline.status === 'failed' ? 'critical' : 'warning'}">${esc(s.advanceDeadline.message)}</div>`);
    }
    if (s.maintenance) notes.push(`<div class="note info">Maintenance lock is on (${Math.round((s.maintenanceLockAgeSec || 0) / 60)} min) - live-loop, watchdog and email-poller silence is expected.</div>`);
    if (s.offseason) notes.push('<div class="note info">Offseason: no games within a week - live scoring, watchdog, notifier and recaps silence is informational.</div>');
    return notes.length ? `<div class="stack" style="gap:8px">${notes.join('')}</div>` : '';
}

// ---------- Jobs ----------

function jobsCard(s) {
    const rows = s.jobs.map(j => {
        let note = '';
        if (j.reason === 'stale') note = `<div class="note critical" style="margin-top:6px">Not running - expected by ${esc(fmtDate(j.expectedBy))} (${esc(untilText(new Date(j.expectedBy).getTime() / 1000))})</div>`;
        else if (j.reason === 'maintenance') note = '<div class="note info" style="margin-top:6px">Silent during maintenance</div>';
        else if (j.reason === 'offseason') note = '<div class="note info" style="margin-top:6px">Silent - offseason</div>';
        else if (j.reason === 'missing') note = '<div class="note info" style="margin-top:6px">No run recorded yet - first run is at the scheduled time</div>';
        else if (j.reason === 'idle') note = '<div class="muted" style="margin-top:6px">Idle - no game in the live window</div>';
        else if (j.reason && j.reason.startsWith('pm2-')) note = `<div class="note critical" style="margin-top:6px">pm2 reports the process is <strong>${esc(j.reason.slice(4))}</strong> - check <code>pm2 logs ${esc((j.pm2 && j.pm2.app) || j.job)} --lines 50</code></div>`;
        const pm2Text = j.pm2 ? ` · pm2 ${esc(j.pm2.status)}${j.pm2.restarts ? ` (${esc(String(j.pm2.restarts))} restarts)` : ''}` : '';
        const when = j.week != null ? ` · ${esc(String(j.season || ''))} wk ${esc(String(j.week))}` : '';
        return `<tr id="${esc(j.job)}">
            <td><span class="dot ${esc(j.effective)}" title="${esc(j.status)}"></span></td>
            <td><strong>${esc(j.title)}</strong><div class="muted">${esc(j.status)}${when}${pm2Text}</div></td>
            <td>${j.lastRun ? `${esc(ago(j.lastRun))}<div class="muted">${esc(fmtDate(j.lastRun))}</div>` : '<span class="muted">never</span>'}</td>
            <td class="dim">${esc(j.cadence)}</td>
            <td class="dim">${j.expectedBy ? esc(untilText(new Date(j.expectedBy).getTime() / 1000)) : '—'}</td>
            <td>${esc(j.summary || '')}${note}</td>
        </tr>`;
    }).join('');
    return card({
        id: 'jobs',
        title: `Jobs ${pill(s.overall, s.overall)}`,
        meta: `generated ${ago(s.generatedAt)} · schedules in ecosystem.config.js · UTC`,
        rows: `<div class="table-wrap"><table class="table">
            <thead><tr><th></th><th>Job</th><th>Last run</th><th>Cadence</th><th>Next expected</th><th>Summary</th></tr></thead>
            <tbody>${rows}</tbody></table></div>`
    });
}

// ---------- Live scoring ----------

function liveCard(live, diagnosis) {
    const w = live && live.latest;
    const n = live && live.notifier;
    if (!w) return card({ id: 'live', title: 'Live scoring', body: '<span class="quiet">The watchdog has not written a check yet (<code>pm2 logs statfink2-watchdog</code>).</span>' });
    const ageMin = (Date.now() - new Date(w.ts).getTime()) / 60000;
    const sev = w.severity || 'critical';
    const meta = [`checked ${ago(w.ts)}`];
    if (w.expectedGames != null) meta.push(`${w.expectedGames} game(s) in window`);
    if (w.gamesInProgress != null) meta.push(`${w.gamesInProgress} in progress`);
    if (w.loopAgeSec != null) meta.push(`loop ${w.loopAgeSec}s ago`);
    const chips = (w.signals || []).map(s => `<span class="chip${s.ok ? '' : (s.severity === 'critical' ? ' bad' : ' warn')}" title="${esc(s.detail || '')}">${esc(String(s.name || '').replace(/_/g, ' '))}</span>`).join('');
    return card({
        id: 'live',
        title: `Live scoring ${pill(sev, w.status)}`,
        body: `
            <div>${esc(w.summary || '')}</div>
            <div class="muted">${esc(meta.join(' · '))}</div>
            ${ageMin > 15 ? '<div class="note critical">Watchdog silent - check <code>statfink2-watchdog</code>.</div>' : ''}
            ${selfProbeNote(w)}
            ${n && n.incident ? `<div class="note ${esc(n.incident.severity || 'warning')}">Open incident: ${esc(n.incident.status)} since ${esc(ago(n.incident.since))}${n.incident.emails ? `, emailed ${esc(String(n.incident.emails))}×` : ''}</div>` : ''}
            ${live.lastEmailError ? `<div class="note warning">Notifier's last email failed: ${esc(typeof live.lastEmailError === 'string' ? live.lastEmailError : JSON.stringify(live.lastEmailError))}</div>` : ''}
            ${diagnosisNote(diagnosis)}
            <div class="chips">${chips}</div>`
    });
}

/**
 * public_path_unreachable (or the pre-diagnostics name site_down): the
 * watchdog's own probe of the public hostname failed. It runs on the VM, so
 * it is not proof of an external outage; say which layer and what it means.
 */
function selfProbeNote(w) {
    if (!w || (w.status !== 'public_path_unreachable' && w.status !== 'site_down')) return '';
    const layer = w.publicPathLayer || null;
    const sev = w.severity === 'critical' ? 'critical' : 'warning';
    const what = layer === 'dns'
        ? 'The VM\'s own resolver cannot resolve the public hostname (a VM / gateway DNS problem). Nothing is proven about the public site.'
        : layer
            ? `The hostname resolves but the ${esc(layer)} layer fails from the VM. Confirm from outside before treating it as an outage.`
            : 'No network diagnostics on this line. Confirm from outside before treating it as an outage.';
    return `<div class="note ${sev}"><strong>Self-probe from the VM, not an external check${layer ? ` (layer: ${esc(layer)})` : ''}:</strong> ${what}</div>`;
}

/** The Qwen diagnostician's take on an escalation (jobStatusService only passes it through while fresh and not ok). An opinion, not a signal. */
function diagnosisNote(d) {
    if (!d || !d.diagnosis) return '';
    const sev = d.severity === 'critical' ? 'critical' : 'warning';
    return `<div class="note ${sev}"><strong>Diagnosis (Qwen):</strong> ${esc(d.diagnosis)}${d.suggestedAction ? ` — ${esc(d.suggestedAction)}` : ''}<div class="muted">${esc(d.model || 'qwen')} · ${esc(ago(d.ts))}${d.status ? ` · watchdog ${esc(d.status)}` : ''}</div></div>`;
}

// ---------- Live play review (Qwen) ----------

const REVIEW_PILL = { confirmed: 'ok', 'under review': 'warning', 'miscredit suspected': 'warning' };
const VOTE_NAMES = ['drive', 'gamebook', 'text'];

/** "20260913_BUF@HOU" -> "BUF @ HOU" */
function gameLabel(gameId) {
    const id = String(gameId || '');
    const m = /([A-Z]{2,3})@([A-Z]{2,3})$/.exec(id);
    return m ? `${m[1]} @ ${m[2]}` : id;
}

function truncate(text, max) {
    const t = String(text || '');
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function confidenceText(c) {
    if (c == null || c === '') return '';
    if (typeof c === 'number') return `${Math.round((c <= 1 ? c * 100 : c))}%`;
    return String(c);
}

/** dbCredit may be a string, a list, or an object; keep it to one short line. */
function creditText(credit) {
    if (credit == null || credit === '') return '—';
    if (typeof credit === 'string') return credit;
    if (Array.isArray(credit)) return credit.map(creditText).filter(x => x !== '—').join(', ') || '—';
    if (typeof credit === 'object') {
        const who = credit.name || credit.player || credit.team || credit.creditedTo || credit.dst || '';
        const what = credit.awardClass || credit.kind || credit.field || '';
        const pts = credit.points != null ? `${credit.points} pts` : '';
        const line = [who, what, pts].filter(Boolean).join(' · ');
        return line || truncate(JSON.stringify(credit), 60);
    }
    return String(credit);
}

function voteChips(det) {
    const votes = det && det.votes && typeof det.votes === 'object' ? det.votes : {};
    const expected = det && det.awardClass;
    const names = [...VOTE_NAMES, ...Object.keys(votes).filter(k => !VOTE_NAMES.includes(k))];
    return names.map(name => {
        const v = votes[name];
        if (v === undefined) return '';
        if (v === null || v === '') return `<span class="chip dim" title="${esc(name)}: no signal">${esc(name)} —</span>`;
        const agree = !expected || expected === 'AMBIGUOUS' || v === expected;
        return `<span class="chip${agree ? '' : ' warn'}" title="${esc(name)}: ${esc(v)}">${esc(name)}</span>`;
    }).join('');
}

function reviewRow(r) {
    const det = r.deterministic || {};
    const q = r.qwen;
    const text = String(r.text || '');
    const qwenCell = q && q.awardClass
        ? `${esc(q.awardClass)}${q.confidence != null && q.confidence !== '' ? ` <span class="muted">${esc(confidenceText(q.confidence))}</span>` : ''}`
        : '<span class="muted">—</span>';
    const status = String(r.status || '');
    return `<tr>
        <td><strong>${esc(gameLabel(r.gameId))}</strong>${r.scoringTeam ? `<div class="muted">${esc(r.scoringTeam)} scored</div>` : ''}</td>
        <td class="dim">${r.period != null ? `Q${esc(String(r.period))} ` : ''}${esc(r.clock || '')}</td>
        <td title="${esc(text)}">${esc(truncate(text, 90))}</td>
        <td>${esc(det.awardClass || '?')}${det.agreement ? `<div class="muted">${esc(typeof det.agreement === 'string' ? det.agreement : JSON.stringify(det.agreement))}</div>` : ''}</td>
        <td><div class="chips">${voteChips(det)}</div></td>
        <td${q && q.reasoning ? ` title="${esc(q.reasoning)}"` : ''}>${qwenCell}</td>
        <td>${esc(creditText(r.dbCredit))}</td>
        <td>${pill(REVIEW_PILL[status] || 'info', status || '?')}${r.reason ? `<div class="muted">${esc(r.reason)}</div>` : ''}</td>
    </tr>`;
}

function liveReviewCard(lr, qwen, job) {
    const q = qwen || {};
    const reach = !q.configured ? 'not configured' : q.reachable === true ? 'reachable' : q.reachable === false ? 'unreachable' : 'not checked yet';
    const qwenLine = `Qwen ${q.model ? `<code>${esc(q.model)}</code>` : '(no model)'} · ${esc(reach)} · last tick ${esc(ago(lr ? lr.ts : job && job.lastRun))}`;
    const idle = (job && (job.reason === 'idle' || job.status === 'skipped')) || (lr && (!lr.games || lr.games.length === 0));
    if (!lr) {
        return card({
            id: 'live-review', title: 'Live play review',
            body: `<div class="muted">${qwenLine}</div>
                ${idle ? '<div class="muted">No games in the live window</div>' : '<span class="quiet">The reviewer has not written a tick yet (<code>pm2 logs statfink2-live-review</code>).</span>'}`
        });
    }
    const sm = lr.summary || {};
    const sev = severityOf(sm.status || 'info');
    const reviews = [...(lr.reviews || [])].sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0));
    const counts = [];
    if (sm.confirmed != null) counts.push(`${sm.confirmed} confirmed`);
    if (sm.underReview) counts.push(`${sm.underReview} under review`);
    if (sm.suspected) counts.push(`${sm.suspected} miscredit suspected`);
    const meta = [lr.week != null ? `${lr.season || ''} wk ${lr.week}` : '', lr.games && lr.games.length ? `${lr.games.length} game${lr.games.length === 1 ? '' : 's'}` : ''].filter(Boolean);
    const rows = reviews.map(reviewRow).join('');
    return card({
        id: 'live-review',
        title: `Live play review ${pill(sev, sm.status || '?')}`,
        meta: meta.map(esc).join(' · '),
        rows: `<div class="card-body">
            <div class="muted">${qwenLine}</div>
            ${sm.summary ? `<div>${esc(sm.summary)}</div>` : ''}${counts.length ? `<div class="muted">${esc(counts.join(' · '))}</div>` : ''}
            ${sm.qwenUnreachable ? '<div class="muted">Qwen unreachable this tick - deterministic votes only</div>' : ''}
            ${idle ? '<div class="muted">No games in the live window</div>' : ''}
        </div>
        ${rows ? `<div class="table-wrap"><table class="table">
            <thead><tr><th>Game</th><th>Clock</th><th>Play</th><th>Class</th><th>Signals</th><th>Qwen</th><th>Credited to</th><th>Status</th></tr></thead>
            <tbody>${rows}</tbody></table></div>` : '<div class="empty">No defensive touchdowns or safeties reviewed yet</div>'}`
    });
}

// ---------- Needs a ruling ----------

function kv(label, value) {
    if (value === undefined || value === null || value === '') return '';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return `<tr><th>${esc(label)}</th><td>${esc(text)}</td></tr>`;
}

function evidenceTable(ev) {
    if (!ev) return '<span class="quiet">No evidence recorded</span>';
    const d = ev.drive || {};
    const driveText = d.team ? `${d.team} drive · ${d.result || '?'}${d.isTurnover ? ' · turnover' : ''}${d.startTeam || d.endTeam ? ` · ${d.startTeam || '?'} → ${d.endTeam || '?'}` : ''}` : (Object.keys(d).length ? JSON.stringify(d) : '');
    const votes = ev.votes ? Object.entries(ev.votes).map(([k, v]) => `${k}: ${v == null ? '—' : v}`).join(' · ') : '';
    const players = Array.isArray(ev.players) ? ev.players.map(p => `${p.name || p.id}${p.pos ? ` (${p.pos})` : ''}`).join(', ') : '';
    return `<div class="table-wrap"><table class="table kv">
        ${kv('Tank01', ev.tank01Text)}
        ${kv('ESPN', ev.espnType || ev.espnText ? `${ev.espnType || ''}${ev.espnType && ev.espnText ? ' — ' : ''}${ev.espnText || ''}` : '')}
        ${kv('Drive', driveText)}
        ${kv('Gamebook', ev.gamebook)}
        ${kv('Votes', votes)}
        ${kv('Teams', ev.scoringTeam ? `${ev.scoringTeam} scored${ev.defendingTeam ? ` vs ${ev.defendingTeam}` : ''}` : '')}
        ${kv('Players', players)}
        ${kv('DB credit', ev.dbCredit)}
    </table></div>
    ${ev.rule ? `<details class="disclosure"><summary>Rule</summary><pre class="block">${esc(ev.rule)}</pre></details>` : ''}`;
}

function rulingsCard(questions) {
    const list = questions || [];
    const open = list.filter(q => q.needsRuling);
    const rows = list.map(q => {
        const r = q.resolution;
        const ru = q.ruling;
        const options = (q.options && q.options.length ? q.options : AWARD_CLASSES).filter(o => AWARD_CLASSES.includes(o));
        const selected = ru ? ru.awardClass : r ? r.awardClass : '';
        return `<div class="card-row${q.needsRuling ? '' : ' acked'}" id="q-${esc(q.id)}">
            <div class="grow stack" style="gap:8px">
                <div>${pill(q.needsRuling ? 'warning' : 'ok', q.needsRuling ? 'needs ruling' : ru ? 'ruled' : 'resolved')}
                    <strong>${esc(q.gameId || '?')}</strong> · play ${esc(String(q.playIdx ?? '?'))}${q.kind ? ` · ${esc(q.kind)}` : ''}
                    <span class="muted">${esc(q.id)}</span></div>
                <div>${esc(q.question || '')}</div>
                ${evidenceTable(q.evidence)}
                ${r ? `<div class="note ${r.confidence === 'unsure' ? 'warning' : 'info'}"><strong>Opus:</strong> ${esc(r.awardClass)} (${esc(r.confidence || '?')})${r.reasoning ? ` - ${esc(r.reasoning)}` : ''}<div class="muted">${esc(r.model || '')} ${esc(ago(r.ts))}</div></div>` : '<div class="muted">No LLM verdict yet.</div>'}
                ${ru ? `<div class="note ok"><strong>Ruling:</strong> ${esc(ru.awardClass)}${ru.note ? ` - ${esc(ru.note)}` : ''}<div class="muted">by ${esc(ru.by || '?')} ${esc(ago(ru.ts))}</div></div>` : ''}
                <div class="ruling-form" data-qid="${esc(q.id)}" data-season="${esc(String(q.season ?? ''))}" data-week="${esc(String(q.week ?? ''))}">
                    <div class="grid-2" style="gap:8px;align-items:end">
                        <label class="field">Award class
                            <select class="input" data-role="award">
                                <option value="">choose…</option>
                                ${options.map(o => `<option value="${esc(o)}"${o === selected ? ' selected' : ''}>${esc(AWARD_LABELS[o] || o)}</option>`).join('')}
                            </select></label>
                        <label class="field">Note<input class="input" data-role="note" placeholder="why (optional)" value="${esc(ru ? ru.note : '')}"></label>
                    </div>
                    <div style="margin-top:8px"><button class="btn sm primary" data-action="save-ruling">${ru ? 'Update ruling' : 'Save ruling'}</button></div>
                </div>
            </div>
        </div>`;
    }).join('');
    return card({
        id: 'rulings',
        title: `Needs a ruling ${open.length ? `<b class="badge">${open.length}</b>` : ''}`,
        meta: list.length ? `${list.length} question${list.length === 1 ? '' : 's'} this week` : '',
        rows: rows || '<div class="empty">No open questions - every scoring play this week was decided by the signals.</div>'
    });
}

async function saveRuling(button) {
    const form = button.closest('.ruling-form');
    if (!form) return;
    const awardClass = form.querySelector('[data-role="award"]').value;
    const note = form.querySelector('[data-role="note"]').value;
    if (!awardClass) { toast('Pick an award class first', 'error'); return; }
    await busy(button, 'Saving…', async () => {
        try {
            const body = await api.post('/api/admin/doublecheck/ruling', {
                questionId: form.dataset.qid, awardClass, note,
                season: form.dataset.season || undefined, week: form.dataset.week || undefined
            });
            const fin = body.data && body.data.finalize;
            toast(fin && fin.exitCode === 0 ? 'Ruling saved and report refreshed' : `Ruling saved; finalize exited ${fin ? fin.exitCode : '?'}${fin && fin.error ? `: ${fin.error}` : ''}`, fin && fin.exitCode === 0 ? 'success' : '');
        } catch (error) {
            toast(`Ruling failed: ${error.message}`, 'error');
        }
    });
    await refresh();
}

// ---------- Defensive scores ----------

function defensiveCard(dc) {
    const list = dc && Array.isArray(dc.defensiveScores) ? dc.defensiveScores : null;
    if (!list) return card({ id: 'defense', title: 'Defensive scores this week', body: '<span class="quiet">none recorded (the Double Check lists them once it runs with the dossier’s defensive-scores output)</span>' });
    const rows = list.map(d => `<tr>
        <td>${esc(d.gameId || '')}</td><td class="num">${esc(String(d.playIdx ?? ''))}</td>
        <td>${esc(d.scoringTeam || '')}</td><td>${esc(d.kind || '')}</td>
        <td>${esc(d.awardClass || '')}</td><td>${esc(d.creditedTo || '—')}</td>
        <td>${d.votesAgree === false ? pill('warning', 'split') : d.votesAgree === true ? pill('ok', 'agree') : '—'}${d.agreement ? `<div class="muted">${esc(typeof d.agreement === 'string' ? d.agreement : JSON.stringify(d.agreement))}</div>` : ''}</td>
        <td>${d.questionId ? `<a href="#q-${esc(d.questionId)}">question</a>` : '—'}</td>
    </tr>`).join('');
    return card({
        id: 'defense',
        title: 'Defensive scores this week',
        meta: `${list.length} play${list.length === 1 ? '' : 's'}`,
        rows: list.length ? `<div class="table-wrap"><table class="table">
            <thead><tr><th>Game</th><th class="num">Play</th><th>Team</th><th>Kind</th><th>Award</th><th>Credited to</th><th>Signals</th><th></th></tr></thead>
            <tbody>${rows}</tbody></table></div>` : '<div class="empty">No defensive touchdowns or safeties this week</div>'
    });
}

// ---------- Double Check ----------

function findingRow(f) {
    const ent = f.entity || {};
    const who = [ent.name || ent.id, ent.owner || ent.team].filter(Boolean).join(' · ');
    return `<div class="card-row">
        <div class="grow">
            <div>${pill(severityOf(f.severity), f.severity)} <strong>${esc(f.bugClassRef || '')}</strong> ${esc(f.check || '')}</div>
            <div style="margin-top:4px">${esc(f.explanation || '')}</div>
            <div class="muted">${esc(ent.type || '')}${who ? ` ${esc(who)}` : ''}${f.suggestedFix ? ` · fix: ${esc(f.suggestedFix)}` : ''}</div>
        </div>
    </div>`;
}

/** INCOMPLETE while the week is still being played is expected: neutral unless something actually failed or warned. */
function doublecheckSeverity(dc) {
    if (dc.overallStatus !== 'INCOMPLETE') return severityOf(dc.overallStatus);
    const c = dc.counts || {};
    return (c.FAIL || 0) > 0 ? 'critical' : (c.WARN || 0) > 0 ? 'warning' : 'info';
}

function doublecheckCard(dc) {
    if (!dc) return card({ id: 'doublecheck', title: 'Double Check', body: '<span class="quiet">No Double Check has run yet (<code>node scripts/doublecheck-daily.js --force</code>).</span>' });
    const c = dc.counts || {};
    const comp = dc.completeness || {};
    const fails = dc.findings.filter(f => f.severity === 'FAIL');
    const warns = dc.findings.filter(f => f.severity === 'WARN');
    return card({
        id: 'doublecheck',
        title: `Double Check ${pill(doublecheckSeverity(dc), dc.overallStatus || '?')}`,
        meta: `${esc(String(dc.season || '?'))} week ${esc(String(dc.week || '?'))} · run ${ago(dc.ts)}`,
        rows: `<div class="card-body">
            <div>FAIL ${esc(String(c.FAIL ?? 0))} · WARN ${esc(String(c.WARN ?? 0))} · INFO ${esc(String(c.INFO ?? 0))} · deferred ${esc(String(c.DEFER ?? 0))}${c.flips ? ` · <strong>${esc(String(c.flips))} result flip(s)</strong>` : ''}${dc.questions != null ? ` · ${esc(String(dc.questions))} question(s)` : ''}</div>
            <div class="muted">games ${esc(String(comp.gamesFinal ?? '?'))}/${esc(String(comp.gamesTotal ?? '?'))} final · ESPN ${esc(String(comp.espnGamesFetched ?? '?'))} fetched · standings ${comp.standingsPresent ? 'present' : 'not yet'}${comp.deferred && comp.deferred.length ? ` · deferred: ${esc(comp.deferred.join(', '))}` : ''}</div>
            ${dc.reportFile ? `<div class="muted">report: <code>${esc(dc.reportFile)}</code></div>` : ''}
        </div>
        ${fails.map(findingRow).join('')}${warns.map(findingRow).join('')}
        ${!fails.length && !warns.length ? '<div class="empty">No FAIL or WARN findings</div>' : ''}`
    });
}

// ---------- Log errors (sentinel) ----------

/** "9430" -> "9,430" without relying on the viewer's locale for the thousands mark. */
function num(n) {
    return Number(n || 0).toLocaleString('en-US');
}

function logErrorRow(f) {
    const flag = f.new ? pill('warning', 'NEW') : f.spiking ? pill('warning', 'SPIKING') : f.known ? '<span class="pill">known</span>' : pill('info', 'seen');
    const counts = `${num(f.count10m)} / ${num(f.count24h)} / ${num(f.count7d)}`;
    const via = f.knownVia === 'acked' ? 'acknowledged on this page' : f.knownVia && f.knownVia.startsWith('shipped:') ? `knownLogNoise.json: ${f.knownVia.slice(8)}` : '';
    const spike = f.spiking ? `<div class="muted">${esc(num(f.count1h))} in the last hour vs a usual ${esc(num(f.hourlyAvg))}/h (threshold ${esc(num(f.spikeThreshold))})</div>` : '';
    let action = '';
    if (!f.known) action = `<button class="btn sm" data-action="ack-noise" data-id="${esc(f.id)}" data-text="${esc(f.fingerprint)}">It's noise</button>`;
    else if (f.knownVia === 'acked') action = `<button class="btn sm" data-action="unack-noise" data-id="${esc(f.id)}">Un-ack</button>`;
    return `<div class="card-row${f.known ? ' acked' : ''}" id="fp-${esc(f.id)}"${f.known ? ' style="opacity:0.7"' : ''}>
        <div class="grow">
            <div>${flag} <strong>${esc(f.job || '?')}</strong> <span class="muted">${esc(f.level || 'error')} · ${esc(f.id)}</span></div>
            <div class="mono" style="margin-top:4px;word-break:break-word">${esc(f.fingerprint || '')}</div>
            <div class="muted">${esc(counts)} (10 min / 24 h / 7 d) · first ${esc(ago(f.firstSeen))} · last ${esc(ago(f.lastSeen))}${via ? ` · ${esc(via)}` : ''}</div>
            ${spike}
            ${f.sample ? `<details class="disclosure"><summary>Sample</summary><pre class="block">${esc(f.sample)}</pre></details>` : ''}
        </div>
        ${action ? `<div class="actions">${action}</div>` : ''}
    </div>`;
}

function logErrorsCard(le, job) {
    if (!le) {
        return card({
            id: 'log-errors', title: 'Log errors',
            body: `<span class="quiet">The log sentinel has not written a pass yet (<code>node scripts/log-sentinel.js --once</code>, pm2 <code>statfink2-log-sentinel</code>).</span>${job && job.summary ? `<div class="muted">${esc(job.summary)}</div>` : ''}`
        });
    }
    const sm = le.summary || {};
    const sev = severityOf(sm.status || 'info');
    const list = le.fingerprints || [];
    const meta = [`scanned ${ago(le.ts)}`];
    if (le.scanned != null) meta.push(`${le.scanned} file${le.scanned === 1 ? '' : 's'}`);
    if (sm.knownSuppressed) meta.push(`${sm.knownSuppressed} known`);
    const rows = list.map(logErrorRow).join('');
    return card({
        id: 'log-errors',
        title: `Log errors ${pill(sev, sm.status || '?')}`,
        meta: meta.map(esc).join(' · '),
        rows: `<div class="card-body">
            <div>${esc(sm.summary || '')}</div>
            ${le.firstRun ? '<div class="muted">First pass: everything already in the logs was taken as the baseline; only shapes that appear from now on are new.</div>' : ''}
            <div class="muted">Yellow only for an error shape nobody has seen before (24 h) or a known one flooding. "It's noise" keeps a shape counted here but never coloured; the shipped list is <code>server/config/knownLogNoise.json</code>.</div>
        </div>
        ${rows || '<div class="empty">No errors in the pm2 logs</div>'}`
    });
}

async function ackNoise(button, ack) {
    const id = button.dataset.id;
    if (!id) return;
    await busy(button, ack ? 'Saving…' : 'Removing…', async () => {
        try {
            if (ack) await api.post('/api/admin/log-noise/ack', { id, text: button.dataset.text || '' });
            else await api.del(`/api/admin/log-noise/ack/${encodeURIComponent(id)}`);
            toast(ack ? 'Marked as noise - the next sentinel pass (10 min) lists it as known' : 'Un-acknowledged - the next sentinel pass judges it again', 'success');
        } catch (error) {
            toast(`${ack ? 'Ack' : 'Un-ack'} failed: ${error.message}`, 'error');
        }
    });
    await refresh();
}

// ---------- Validation ----------

function validationCard(v) {
    if (!v) return card({ id: 'validation', title: 'Validation', body: '<span class="quiet">The daily validation has not written a status yet (runs with the daily update at 13:00 UTC).</span>' });
    const status = v.overallStatus || v.status || '?';
    const gc = v.gamesComplete;
    const sm = v.healthSummary || (typeof v.summary === 'object' ? v.summary : null) || {};
    const games = gc && gc.totalGames > 0 ? ` · games ${esc(String(gc.completedGames))}/${esc(String(gc.totalGames))} final` : '';
    return card({
        id: 'validation',
        title: `Validation ${pill(severityOf(status), status)}`,
        meta: `run ${ago(v.ts)} (${fmtDate(v.ts)})`,
        body: `
            <div>${esc(String(v.season || '?'))} week ${esc(String(v.week || '?'))}${v.mode ? ` · ${esc(v.mode)} mode` : ''}${games}${v.checks ? ` · ${esc(String(sm.passed ?? 0))} passed, ${esc(String(sm.failed ?? 0))} failed, ${esc(String(sm.warnings ?? 0))} warnings${sm.deferred ? `, ${esc(String(sm.deferred))} deferred` : ''}` : ''}</div>
            ${typeof v.summary === 'string' && v.summary ? `<div class="muted">${esc(v.summary)}</div>` : ''}
            ${v.doubleCheck ? `<div class="muted">Double Check: ${esc(typeof v.doubleCheck === 'string' ? v.doubleCheck : v.doubleCheck.overallStatus || JSON.stringify(v.doubleCheck))}</div>` : ''}
            ${v.checks ? `<details class="disclosure"><summary>Checks (${v.checks.length})</summary>${checksList(v.checks)}</details>` : ''}`
    });
}

// ---------- Recaps ----------

function recapsCard(r, job) {
    if (!r && !job) return card({ id: 'recaps', title: 'Recaps', body: '<span class="quiet">No recap run recorded.</span>' });
    const status = r ? (r.overallStatus || '?') : job.status;
    const sev = status === 'SKIPPED' ? 'info' : severityOf(status);
    const when = r ? r.runAt : job.lastRun;
    let line;
    if (r && r.overallStatus === 'SKIPPED') line = r.reason || 'skipped';
    else if (r) line = `${r.season || '?'} week ${r.week || '?'}${r.factcheckFile ? ' · fact-checked' : ''}${r.error ? ` · ${r.error}` : ''}${r.note ? ` · ${r.note}` : ''}`;
    else line = job.summary || '';
    return card({
        id: 'recaps',
        title: `Recaps ${pill(sev, status)}`,
        meta: `${ago(when)} · on demand from Recaps`,
        body: `<div>${esc(line)}</div>${job && job.summary && r ? `<div class="muted">${esc(job.summary)}</div>` : ''}`
    });
}

// ---------- Alerts ----------

function alertsCard(alerts, unacked) {
    const rows = alerts.slice(0, 60).map(a => `
        <div class="card-row${a.acknowledged ? ' acked' : ''}" style="${a.acknowledged ? 'opacity:0.55' : ''}">
            <div class="grow">
                <div>${pill(severityOf(a.severity), a.severity)} <strong>${esc(a.source)}</strong>${a.count > 1 ? ` <span class="muted">×${esc(String(a.count))}</span>` : ''}</div>
                <div style="margin-top:4px">${esc(a.message)}</div>
                <div class="muted">${esc(ago(a.timestamp))} · ${esc(fmtDate(a.timestamp))}${a.lastSeen ? ` · last seen ${esc(ago(a.lastSeen))}` : ''}</div>
                ${a.details && (Array.isArray(a.details) ? a.details.length : true) ? `<details class="disclosure"><summary>Details</summary><pre class="block">${esc(Array.isArray(a.details) ? a.details.join('\n') : JSON.stringify(a.details, null, 2))}</pre></details>` : ''}
            </div>
            <div class="actions">${a.acknowledged ? `<span class="muted">${a.automaticallyResolved ? 'resolved with move' : 'acked'}</span>` : `<button class="btn sm" data-action="ack" data-id="${esc(a.id)}">Ack</button>`}</div>
        </div>`).join('');
    return card({
        id: 'alerts',
        title: `Alerts ${unacked ? `<b class="badge">${esc(String(unacked))}</b>` : ''}`,
        actions: `<label class="check"><input type="checkbox" data-action="toggle-acked" ${showAcked ? 'checked' : ''}> show acked</label><button class="btn sm" data-action="ack-all">Ack all</button>`,
        rows: rows || '<div class="empty">No alerts</div>'
    });
}

async function loadAlerts() {
    const alerts = await getData(`/api/admin/health/alerts${showAcked ? '' : '?unacknowledged=true'}`).catch(() => ({ alerts: [] }));
    const list = alerts.alerts || [];
    const unacked = alerts.actionableCount ?? list.filter(a => !a.acknowledged && a.severity !== 'info').length;
    const old = root.querySelector('#alerts');
    if (old) old.outerHTML = alertsCard(list, unacked);
}

/** Everything yellow at once: open alerts + never-seen log shapes (marked seen; still spike-checked). */
async function clearAllWarnings(button) {
    await busy(button, 'Clearing…', async () => {
        try {
            const r = await api.post('/api/admin/warnings/clear', {});
            const d = (r && r.data) || r || {};
            toast(`Cleared ${d.alertsAcknowledged || 0} alert(s) and ${d.logShapesAcknowledged || 0} log error shape(s)`, 'success');
        } catch (error) {
            toast(`Clear failed: ${error.message}`, 'error');
        }
    });
    await refresh();
}

async function ackAlerts(ids) {
    try {
        await api.post('/api/admin/health/alerts/ack', ids ? { ids } : {});
        toast(ids ? 'Acknowledged' : 'All alerts acknowledged', 'success');
    } catch (error) {
        toast(`Ack failed: ${error.message}`, 'error');
    }
    await refresh();
}
