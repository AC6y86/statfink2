/**
 * Roster moves: pending email moves (approve / reject / retry / override), the
 * manual move form (IR, supplemental, IR return, trade) with a live preview,
 * the selected team's roster, and a player search tab. The server is the only
 * gate for roster rules (19 active, IR 3-week rule); errors surface verbatim.
 * A move that failed to execute stays listed with its error until it succeeds
 * or is rejected. A move the validator refuses offers a clearly labelled
 * commissioner override (reason required, recorded on the item).
 */

import { getData, api } from '../api.js';
import { esc, ago, pill, card, toast, armed, busy, delegate } from '../ui.js';
import { setContext } from '../main.js';

export const title = 'Roster moves';

const TYPE_LABELS = { ir: 'IR move', supplemental: 'Supplemental', ir_return: 'IR return', trade: 'Trade' };

let root = null;
let ctxRef = null;
let state = { tab: 'moves', teamId: '', moveType: 'ir', drop: '', add: '', partnerTeam: '', partnerPlayer: '' };
let cache = { roster: {}, available: null, players: null };
let playerFilter = { q: '', pos: '', team: '', page: 1 };

// ---------- Shared with This week ----------

export function describeMove(item, ctx) {
    if (!item.move) return esc(item.parse?.summary || 'No move could be extracted');
    const m = item.move;
    const team = id => `<strong>${esc(ctx.teamName(id))}</strong>`;
    if (m.move_type === 'trade') {
        return `${team(m.team_id)} sends <strong>${esc(m.drop_player_name)}</strong> to ${team(m.partner_team_id)} for <strong>${esc(m.partner_player_name)}</strong> <span class="pill accent">trade</span>`;
    }
    return `${team(m.team_id)} · ${esc(TYPE_LABELS[m.move_type] || m.move_type)} · drop <strong>${esc(m.drop_player_name)}</strong> → add <strong>${esc(m.add_player_name)}</strong>`;
}

/** Open statuses: still waiting on the commissioner (a failed execution is NOT resolved). */
export const OPEN_STATUSES = ['pending', 'needs_review', 'failed'];

export function renderPendingItem(item, ctx, { compact = false } = {}) {
    const resolved = ['approved', 'rejected'].includes(item.status);
    const isReview = item.status === 'needs_review';
    const isFailed = item.status === 'failed';
    const v = item.validation || {};
    const invalid = !resolved && item.move && (isFailed || v.valid !== true);
    const verdict = resolved ? esc(item.status) : v.valid
        ? '<span style="color:var(--ok-ink);font-weight:600">would pass validation</span>'
        : `<span style="color:var(--bad);font-weight:600">would fail: ${esc((v.errors || []).join('; ') || 'unknown')}</span>`;
    const questions = resolved ? [] : (item.parse?.questions_for_commissioner || []);
    const id = esc(item.id);
    const nfl = v.nflEligibility || null;
    const nflLine = nfl && !resolved
        ? `<div class="muted">NFL.com ${nfl.eligible ? '<span style="color:var(--ok-ink)">eligible</span>' : '<span style="color:var(--bad)">not eligible</span>'}${nfl.observedStatus ? ` · ${esc(nfl.observedStatus)}` : ''}${nfl.checkedAt ? ` · checked ${ago(nfl.checkedAt)}` : ''}${(nfl.sources || []).length ? ` · ${nfl.sources.slice(0, 3).map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener">source ${i + 1}</a>`).join(' ')}` : ''}</div>`
        : '';
    const basis = item.executionResult?.evidenceBasis;
    const basisLine = basis
        ? `<div class="muted">Approved on enqueue-time NFL.com evidence${basis === 'enqueue_legacy' ? ' (legacy item)' : ''}${item.executionResult?.nflEligibility?.enqueueCheckedAt ? ` checked ${ago(item.executionResult.nflEligibility.enqueueCheckedAt)}` : ''} · fresh check unavailable at approval</div>`
        : '';
    // Failed execution: keep the error in front of the commissioner until the item is retried, overridden or rejected
    const attempts = Array.isArray(item.executionAttempts) ? item.executionAttempts.length : 0;
    const failure = isFailed && item.executionResult && item.executionResult.success === false ? item.executionResult : null;
    const failedLine = failure
        ? `<div class="note critical" style="margin-top:6px"><strong>Execution failed</strong>${failure.attemptedAt || item.lastAttemptAt ? ` · ${ago(failure.attemptedAt || item.lastAttemptAt)}` : ''}${attempts > 1 ? ` · ${attempts} attempts` : ''}${failure.override ? ' · during an override' : ''}<div>${esc(failure.message || 'unknown error')}</div><div class="muted">Still waiting on you: retry, recheck NFL.com, override the validation, or reject to dismiss.</div></div>`
        : '';
    const ov = item.override;
    const overrideLine = ov
        ? `<div class="note warning" style="margin-top:6px"><strong>Executed by commissioner override</strong>${ov.by ? ` · ${esc(ov.by)}` : ''}${ov.at ? ` · ${ago(ov.at)}` : ''}<div>Reason: ${esc(ov.reason || '')}</div>${(ov.overriddenErrors || []).length ? `<div class="muted">Overrode: ${esc(ov.overriddenErrors.join('; '))}</div>` : ''}</div>`
        : '';
    const canRecheck = item.move && item.move.move_type !== 'trade' && OPEN_STATUSES.includes(item.status);
    const recheckButton = canRecheck ? `<button class="btn sm" data-action="recheck" data-id="${id}" title="Fresh NFL.com fetch; never executes">Recheck NFL.com</button>` : '';
    const typeSelect = item.move && item.move.move_type !== 'trade' && !resolved
        ? `<select class="input" style="width:auto;height:32px" id="pm-type-${id}" aria-label="Move type">${['ir', 'supplemental', 'ir_return'].map(t =>
            `<option value="${t}" ${t === item.move.move_type ? 'selected' : ''}>as ${TYPE_LABELS[t]}</option>`).join('')}</select>`
        : '';
    const rejectButton = `<button class="btn sm" data-action="reject" data-id="${id}">${isFailed ? 'Reject (dismiss)' : 'Reject'}</button>`;
    // The override is only offered for a move the validator refuses; it is explicit (own panel, reason required)
    const overrideButton = invalid ? `<button class="btn sm danger" data-action="override" data-id="${id}" title="Commissioner override: execute this move even though validation refuses it">Override validation…</button>` : '';
    const buttons = resolved
        ? `${pill(item.status === 'approved' ? 'ok' : 'info', item.status)}${ov ? ` ${pill('warning', 'override')}` : ''}`
        : isFailed
        ? `${typeSelect}${recheckButton}<button class="btn sm" data-action="open" data-tab="moves" data-id="${id}">${compact ? 'Open' : 'Use in manual form'}</button>${rejectButton}${overrideButton}<button class="btn sm success" data-action="approve" data-id="${id}">Retry approve &amp; execute</button>`
        : isReview
        ? `${recheckButton}<button class="btn sm" data-action="open" data-tab="moves" data-id="${id}">${compact ? 'Open' : 'Use in manual form'}</button>${rejectButton}${overrideButton}`
        : `${typeSelect}${recheckButton}${rejectButton}${overrideButton}<button class="btn sm success" data-action="approve" data-id="${id}">Approve &amp; execute</button>`;
    const overridePanel = invalid ? `
                <div id="override-${id}" hidden style="margin-top:8px" class="note critical">
                    <strong>Commissioner override</strong> · executes this move even though validation says: ${esc(isFailed && failure ? failure.message : (v.errors || []).join('; ') || 'invalid')}
                    <div class="muted">Recorded on the move with your reason. Players must exist and the roster must still end at 19 active.</div>
                    <input class="input" type="text" id="override-reason-${id}" placeholder="Reason (required)" style="margin-top:6px">
                    <div class="row" style="margin-top:8px"><button class="btn sm danger" data-action="override-confirm" data-id="${id}">Confirm override &amp; execute</button><button class="btn sm" data-action="override-cancel" data-id="${id}">Cancel</button></div>
                </div>` : '';
    return `
        <div class="card-row stack-actions" id="pm-${id}">
            <div class="icon-box ${isFailed ? 'critical' : isReview ? 'warning' : ''}">${isFailed ? '!' : isReview ? '?' : '⇅'}</div>
            <div class="grow">
                <div>${describeMove(item, ctx)} ${isReview ? pill('warning', 'needs review') : ''}${isFailed ? pill('critical', 'execution failed') : ''}</div>
                <div class="muted">from ${esc(item.email?.from || '?')} · ${ago(item.createdAt || item.email?.date)} · ${verdict}</div>
                ${(item.commissionerRulings || []).map(renderCommissionerNote).join('')}
                ${nflLine}${basisLine}${failedLine}${overrideLine}
                ${!compact && item.move && (item.move.drop_quote || item.move.add_quote) ? `<div class="muted">${item.move.drop_quote ? `drop ⟵ “${esc(item.move.drop_quote)}”` : ''}${item.move.add_quote ? ` · add ⟵ “${esc(item.move.add_quote)}”` : ''}</div>` : ''}
                ${questions.length ? `<div class="note warning" style="margin-top:6px"><strong>Needs your judgment</strong><ul style="margin:4px 0 0 18px;padding:0">${questions.map(q => `<li>${esc(q)}</li>`).join('')}</ul></div>` : ''}
                <details class="disclosure"><summary>Original email</summary><pre class="block">Subject: ${esc(item.email?.subject || '')}\n\n${esc(item.email?.body || '')}</pre></details>
                <div id="reject-${id}" hidden style="margin-top:8px">
                    <input class="input" type="text" id="reason-${id}" placeholder="Reason (optional)">
                    <div class="row" style="margin-top:8px"><button class="btn sm danger" data-action="reject-confirm" data-id="${id}">Confirm reject</button><button class="btn sm" data-action="reject-cancel" data-id="${id}">Cancel</button></div>
                </div>${overridePanel}
            </div>
            <div class="actions">${buttons}</div>
        </div>`;
}

export async function approvePending(button, id, after) {
    return armed(button, async () => {
        const moveType = document.getElementById(`pm-type-${id}`)?.value || null;
        await busy(button, 'Executing…', async () => {
            try {
                const body = await api.post(`/api/admin/pending-moves/${encodeURIComponent(id)}/approve`, { moveType });
                toast(body.message || (body.success ? 'Move executed' : 'Move failed'), body.success ? 'success' : 'error');
            } catch (error) {
                toast(`Approve failed: ${error.message}`, 'error');
            }
        });
        if (after) await after();
    }, 'Tap again to execute');
}

/**
 * Commissioner override: execute the selected move despite a validation
 * refusal. Reason is required; two-tap confirmation; the server records it.
 */
export async function overridePending(button, id, after) {
    const reason = document.getElementById(`override-reason-${id}`)?.value.trim() || '';
    if (!reason) { toast('Give a reason for the override', 'warning'); return; }
    return armed(button, async () => {
        const moveType = document.getElementById(`pm-type-${id}`)?.value || null;
        await busy(button, 'Overriding…', async () => {
            try {
                const body = await api.post(`/api/admin/pending-moves/${encodeURIComponent(id)}/override`, { reason, moveType });
                toast(body.message || (body.success ? 'Override executed' : 'Override failed'), body.success ? 'success' : 'error');
            } catch (error) {
                toast(`Override failed: ${error.message}`, 'error');
            }
        });
        if (after) await after();
    }, 'Tap again to override');
}

/** Re-run validation with a fresh NFL.com fetch. Never executes the move. */
export async function recheckPending(button, id, after) {
    await busy(button, 'Checking NFL.com…', async () => {
        try {
            const body = await api.post(`/api/admin/pending-moves/${encodeURIComponent(id)}/recheck`, {});
            toast(body.message || (body.success ? 'Validation passed' : 'Validation failed'), body.success ? 'success' : 'error');
        } catch (error) {
            toast(`Recheck failed: ${error.message}`, 'error');
        }
    });
    if (after) await after();
}

export async function rejectPending(id, after) {
    const reason = document.getElementById(`reason-${id}`)?.value.trim() || null;
    try {
        await api.post(`/api/admin/pending-moves/${encodeURIComponent(id)}/reject`, { reason });
        toast('Move rejected', 'success');
    } catch (error) {
        toast(`Reject failed: ${error.message}`, 'error');
    }
    if (after) await after();
}

// ---------- Area ----------

export async function render(view, ctx, opts = {}) {
    ctxRef = ctx;
    state.tab = opts.tab === 'players' ? 'players' : 'moves';
    root = document.createElement('div');
    root.className = 'stack';
    view.replaceChildren(root);
    delegate(root, {
        tab: el => { state.tab = el.dataset.tab; ctx.navigate('moves', state.tab === 'players' ? 'players' : null); },
        approve: el => approvePending(el, el.dataset.id, refresh),
        recheck: el => recheckPending(el, el.dataset.id, refresh),
        reject: el => togglePanel(`reject-${el.dataset.id}`),
        'reject-confirm': el => rejectPending(el.dataset.id, refresh),
        'link-ruling': el => linkRuling(el),
        'reject-cancel': el => togglePanel(`reject-${el.dataset.id}`, true),
        override: el => togglePanel(`override-${el.dataset.id}`),
        'override-confirm': el => overridePending(el, el.dataset.id, refresh),
        'override-cancel': el => togglePanel(`override-${el.dataset.id}`, true),
        open: el => prefillFromPending(el.dataset.id),
        'move-type': el => { state.moveType = el.dataset.type; state.add = ''; state.drop = ''; state.partnerPlayer = ''; renderForm(); },
        execute: el => armed(el, () => executeMove(el), 'Tap again to execute'),
        page: el => { playerFilter.page = Number(el.dataset.page); renderPlayers(); }
    });
    root.addEventListener('change', onChange);
    root.addEventListener('input', event => {
        if (event.target.id === 'player-q') { playerFilter.q = event.target.value; playerFilter.page = 1; renderPlayers(); }
    });
    await refresh();
}

export async function refresh() {
    if (!root || !ctxRef) return;
    setContext(`Week ${ctxRef.settings?.current_week ?? '?'} · ${ctxRef.settings?.season_year ?? ''}`);
    root.innerHTML = `
        <div class="subtabs">
            <button data-action="tab" data-tab="moves" class="${state.tab === 'moves' ? 'active' : ''}">Moves</button>
            <button data-action="tab" data-tab="players" class="${state.tab === 'players' ? 'active' : ''}">Player search</button>
        </div>
        <div id="area-body"></div>`;
    if (state.tab === 'players') await renderPlayers();
    else await renderMoves();
}

function togglePanel(id, forceHide = false) {
    const el = root.querySelector(`#${CSS.escape(id)}`);
    if (!el) return;
    el.hidden = forceHide ? true : !el.hidden;
    if (!el.hidden) { const input = el.querySelector('input'); if (input) input.focus(); }
}

async function linkRuling(button) {
    const moveId = document.getElementById(`ruling-target-${button.dataset.id}`)?.value;
    if (!moveId) { toast('Select the affected move first', 'warning'); return; }
    await busy(button, 'Attaching…', async () => {
        try {
            await api.post(`/api/admin/pending-moves/${encodeURIComponent(button.dataset.id)}/link-ruling`, { moveId });
            toast('Ruling attached; move status unchanged', 'success');
            await renderMoves();
        } catch (error) { toast(`Could not attach ruling: ${error.message}`, 'error'); }
    });
}

export function renderCommissionerNote(item) {
    const reported = item.source?.kind === 'user_report';
    const evidence = reported ? item.source : item.email;
    return `<div class="card-row"><div class="grow">
        <div>${pill('warning', reported ? 'Reported commissioner ruling' : 'Commissioner ruling')} <strong>${esc(item.parse?.summary || 'Commissioner ruling')}</strong></div>
        <div class="muted">${esc(evidence?.from || '')} · ${ago(evidence?.date || item.createdAt)}</div>
        <blockquote class="note warning">${esc(item.rulingQuote || '')}</blockquote>
        <div class="muted">${reported ? 'Reported by Joe via iMessage; Dan’s original message has not been located. The quote above is Joe’s report, not a direct quote from Dan.' : 'Recorded from email; this note does not automatically reject or undo a roster move.'}</div>
        ${reported ? '<div class="muted">This note does not automatically reject or undo a roster move.</div>' : ''}
        <details class="disclosure"><summary>${reported ? 'Original report' : 'Original email'}</summary><pre class="block">${reported ? '' : `Subject: ${esc(evidence?.subject || '')}\n\n`}${esc(evidence?.body || '')}</pre></details>
    </div></div>`;
}

async function renderMoves() {
    const body = root.querySelector('#area-body');
    const pending = await getData('/api/admin/pending-moves').catch(() => ({ items: [] }));
    const notices = (pending.items || []).filter(i => i.kind === 'commissioner_invalidation');
    // Failed executions stay in the waiting list (with their error) until they succeed or are rejected
    const items = (pending.items || []).filter(i => OPEN_STATUSES.includes(i.status));
    const failedCount = items.filter(i => i.status === 'failed').length;
    const resolved = (pending.items || []).filter(i => ['approved', 'rejected'].includes(i.status) && i.commissionerRulings?.length);
    const unlinked = notices.filter(i => !i.relatedItemIds?.length);
    const proposals = (pending.items || []).filter(i => i.kind !== 'commissioner_invalidation');
    body.innerHTML = `
        <div class="grid-2">
            <div class="stack">
                ${card({ title: 'From email', meta: `polled every 2 min · ${items.length} waiting${failedCount ? ` · ${failedCount} failed` : ''}`, rows: items.length ? items.map(i => renderPendingItem(i, ctxRef)).join('') : '<div class="empty">Nothing waiting on you</div>' })}
                ${resolved.length ? card({ title: 'Resolved moves with rulings', rows: resolved.map(i => renderPendingItem(i, ctxRef)).join('') }) : ''}
                ${unlinked.length ? card({ title: 'Choose a move for these rulings', rows: unlinked.map(n => `${renderCommissionerNote(n)}<div class="card-body"><select class="input" id="ruling-target-${esc(n.id)}"><option value="">Select affected move…</option>${proposals.map(i => `<option value="${esc(i.id)}">${esc(i.move ? `${i.move.drop_player_name} → ${i.move.add_player_name} (${i.status})` : i.parse?.summary || i.id)}</option>`).join('')}</select><button class="btn sm" data-action="link-ruling" data-id="${esc(n.id)}">Attach to move</button></div>`).join('') }) : ''}
            </div>
            <div class="stack">
                <section class="card" id="form-card"></section>
                <section class="card" id="roster-card"></section>
            </div>
        </div>`;
    await renderForm();
}

function opt(value, label, selected) {
    return `<option value="${esc(value)}" ${String(value) === String(selected) ? 'selected' : ''}>${esc(label)}</option>`;
}

async function roster(teamId) {
    if (!teamId) return null;
    if (!cache.roster[teamId]) cache.roster[teamId] = await getData(`/api/teams/${teamId}/roster`);
    return cache.roster[teamId];
}

async function available() {
    if (!cache.available) {
        const list = await getData('/api/players/available');
        cache.available = (Array.isArray(list) ? list : []).slice().sort((a, b) => a.name.localeCompare(b.name));
    }
    return cache.available;
}

async function renderForm() {
    const formCard = root.querySelector('#form-card');
    const rosterCard = root.querySelector('#roster-card');
    if (!formCard) return;
    const teams = ctxRef.teams.slice().sort((a, b) => a.team_id - b.team_id);
    const t = state.moveType;
    const r = await roster(state.teamId).catch(() => null);
    const week = Number(ctxRef.settings?.current_week);

    let addOptions = '';
    if (t === 'ir_return') {
        const ir = (r && r.injured_reserve) || [];
        addOptions = ir.map(p => {
            const weeksOnIr = p.ir_week ? week - Number(p.ir_week) : null;
            const hint = p.ir_week ? ` · IR since wk ${p.ir_week}${weeksOnIr !== null && weeksOnIr < 3 ? ` (eligible wk ${Number(p.ir_week) + 3})` : ''}` : '';
            return opt(p.player_id, `${p.name} (${p.position})${hint}`, state.add);
        }).join('');
    } else if (t !== 'trade') {
        const av = await available().catch(() => []);
        addOptions = av.map(p => opt(p.player_id, `${p.name} (${p.position}, ${p.team})`, state.add)).join('');
    }
    const dropOptions = ((r && r.active) || []).map(p => opt(p.player_id, `${p.name} (${p.position})`, state.drop)).join('');
    const partnerRoster = t === 'trade' && state.partnerTeam ? await roster(state.partnerTeam).catch(() => null) : null;
    const partnerOptions = ((partnerRoster && partnerRoster.active) || []).map(p => opt(p.player_id, `${p.name} (${p.position})`, state.partnerPlayer)).join('');

    formCard.innerHTML = `
        <div class="card-head"><h2>Manual move</h2><div class="segmented">${Object.entries(TYPE_LABELS).map(([k, l]) => `<button data-action="move-type" data-type="${k}" class="${t === k ? 'active' : ''}">${l}</button>`).join('')}</div></div>
        <div class="card-body">
            <div class="grid-2" style="gap:12px">
                <label class="field">Team<select class="input" id="f-team"><option value="">Choose team…</option>${teams.map(tm => opt(tm.team_id, `${tm.team_name} (${tm.owner_name})`, state.teamId)).join('')}</select></label>
                <label class="field">${t === 'ir' ? 'Player to IR' : t === 'trade' ? 'Player they send' : 'Drop'}<select class="input" id="f-drop" ${!state.teamId ? 'disabled' : ''}><option value="">${state.teamId ? 'Choose…' : 'Pick a team first'}</option>${dropOptions}</select></label>
                ${t === 'trade' ? `
                <label class="field">Partner team<select class="input" id="f-partner-team"><option value="">Choose team…</option>${teams.filter(tm => String(tm.team_id) !== String(state.teamId)).map(tm => opt(tm.team_id, `${tm.team_name} (${tm.owner_name})`, state.partnerTeam)).join('')}</select></label>
                <label class="field">Player they get back<select class="input" id="f-partner-player" ${!state.partnerTeam ? 'disabled' : ''}><option value="">${state.partnerTeam ? 'Choose…' : 'Pick partner first'}</option>${partnerOptions}</select></label>` : `
                <label class="field">${t === 'ir_return' ? 'Activate from IR' : 'Add (free agent)'}<select class="input" id="f-add" ${t === 'ir_return' && !state.teamId ? 'disabled' : ''}><option value="">Choose…</option>${addOptions}</select></label>`}
            </div>
            <div class="row between" style="border-top:1px solid var(--border-soft);padding-top:12px">
                <div class="muted" id="f-preview">${preview()}</div>
                <button class="btn primary" data-action="execute" ${canExecute() ? '' : 'disabled'}>Execute move</button>
            </div>
            <div class="muted">The server enforces the rules (19 active per team, IR minimum 3 weeks, no dropping or trading a player once his NFL game has kicked off - judged at the time the owner's email was sent - and for IR moves a fresh NFL.com check: Game Status "Out" or current Reserve/Injured); its message is shown here verbatim if a move is refused.</div>
        </div>`;

    if (!r) {
        rosterCard.innerHTML = '<div class="card-body"><span class="quiet">Pick a team to see its roster.</span></div>';
        return;
    }
    const active = r.active || [];
    const ir = r.injured_reserve || [];
    const row = (p, dim = false) => `<tr>
        <td${dim ? ' class="dim"' : ''}><strong>${esc(p.name)}</strong></td><td${dim ? ' class="dim"' : ''}>${esc(p.position)}</td><td${dim ? ' class="dim"' : ''}>${esc(p.team || '')}</td>
        <td>${dim ? `<span class="pill warning">IR${p.ir_week ? ` · wk ${esc(p.ir_week)}` : ''}</span>` : p.is_scoring ? '<span class="pill ok">scoring</span>' : '<span class="muted">active</span>'}</td>
        <td class="dim">${p.bye_week ? `bye ${esc(p.bye_week)}` : ''}</td></tr>`;
    rosterCard.innerHTML = `
        <div class="card-head"><h2>${esc(ctxRef.teamName(state.teamId))} · ${active.length} active ${active.length !== 19 ? pill('critical', `should be 19`) : ''}</h2><span class="muted">${ir.length} on IR · week ${esc(r.dataSource?.week ?? week)}</span></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Player</th><th>Pos</th><th>NFL</th><th>Status</th><th></th></tr></thead>
        <tbody>${active.map(p => row(p)).join('')}${ir.map(p => row(p, true)).join('')}</tbody></table></div>`;
}

function selName(id) {
    const el = root.querySelector(`#${id}`);
    const o = el && el.selectedOptions[0];
    return o && o.value ? o.textContent.replace(/\s*\(.*$/, '') : null;
}

function preview() {
    const t = state.moveType;
    if (t === 'trade') {
        if (!(state.teamId && state.drop && state.partnerTeam && state.partnerPlayer)) return 'Pick both teams and both players.';
        return `${esc(ctxRef.teamName(state.teamId))} trades ${esc(selName('f-drop'))} to ${esc(ctxRef.teamName(state.partnerTeam))} for ${esc(selName('f-partner-player'))}`;
    }
    if (!(state.teamId && state.drop && state.add)) return 'Pick a team, a player to drop and a player to add.';
    const d = esc(selName('f-drop')), a = esc(selName('f-add'));
    if (t === 'ir') return `${d} → IR, add ${a}`;
    if (t === 'ir_return') return `Activate ${a} from IR, drop ${d}`;
    return `Drop ${d}, add ${a}`;
}

function canExecute() {
    return state.moveType === 'trade'
        ? Boolean(state.teamId && state.drop && state.partnerTeam && state.partnerPlayer)
        : Boolean(state.teamId && state.drop && state.add);
}

async function onChange(event) {
    const id = event.target.id;
    const v = event.target.value;
    if (id === 'f-team') { state.teamId = v; state.drop = ''; state.add = state.moveType === 'ir_return' ? '' : state.add; await renderForm(); }
    else if (id === 'f-drop') { state.drop = v; syncPreview(); }
    else if (id === 'f-add') { state.add = v; syncPreview(); }
    else if (id === 'f-partner-team') { state.partnerTeam = v; state.partnerPlayer = ''; await renderForm(); }
    else if (id === 'f-partner-player') { state.partnerPlayer = v; syncPreview(); }
    else if (id === 'player-pos') { playerFilter.pos = v; playerFilter.page = 1; renderPlayers(); }
    else if (id === 'player-team') { playerFilter.team = v; playerFilter.page = 1; renderPlayers(); }
}

function syncPreview() {
    const p = root.querySelector('#f-preview');
    if (p) p.innerHTML = preview();
    const b = root.querySelector('[data-action="execute"]');
    if (b) b.disabled = !canExecute();
}

async function executeMove(button) {
    const t = state.moveType;
    const body = t === 'trade'
        ? { moveType: t, teamId: state.teamId, dropPlayerId: state.drop, partnerTeamId: state.partnerTeam, partnerPlayerId: state.partnerPlayer }
        : { moveType: t, teamId: state.teamId, dropPlayerId: state.drop, addPlayerId: state.add };
    await busy(button, 'Executing…', async () => {
        try {
            const res = await api.post('/api/admin/roster/move', body);
            toast(res.message || 'Move executed', 'success');
            cache = { roster: {}, available: null, players: cache.players };
            state.drop = ''; state.add = ''; state.partnerPlayer = '';
        } catch (error) {
            toast(error.message || 'Move refused', 'error');
        }
    });
    await refresh();
}

async function prefillFromPending(id) {
    const pending = await getData('/api/admin/pending-moves').catch(() => ({ items: [] }));
    const item = (pending.items || []).find(i => i.id === id);
    if (item && item.move) {
        state.moveType = item.move.move_type || 'supplemental';
        state.teamId = String(item.move.team_id || '');
        state.drop = item.move.drop_player_id || '';
        state.add = item.move.add_player_id || '';
        state.partnerTeam = String(item.move.partner_team_id || '');
        state.partnerPlayer = item.move.partner_player_id || '';
    }
    if (state.tab !== 'moves') { state.tab = 'moves'; await refresh(); } else await renderForm();
    const fc = root.querySelector('#form-card');
    if (fc) fc.scrollIntoView({ behavior: 'smooth' });
}

// ---------- Player search ----------

async function renderPlayers() {
    const body = root.querySelector('#area-body');
    if (!body) return;
    if (!cache.players) {
        body.innerHTML = '<p class="quiet">Loading players…</p>';
        cache.players = await getData('/api/players').catch(() => []);
    }
    const all = Array.isArray(cache.players) ? cache.players : [];
    const q = playerFilter.q.trim().toLowerCase();
    const list = all.filter(p => (!q || (p.name || '').toLowerCase().includes(q)) && (!playerFilter.pos || p.position === playerFilter.pos) && (!playerFilter.team || p.team === playerFilter.team));
    const per = 50;
    const pages = Math.max(1, Math.ceil(list.length / per));
    playerFilter.page = Math.min(Math.max(1, playerFilter.page), pages);
    const slice = list.slice((playerFilter.page - 1) * per, playerFilter.page * per);
    const teams = [...new Set(all.map(p => p.team).filter(Boolean))].sort();
    const positions = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
    const existing = body.querySelector('#player-q');
    const filters = `
        <div class="row" style="margin-bottom:12px">
            <input class="input" style="flex:1 1 220px" id="player-q" placeholder="Search players…" value="${esc(playerFilter.q)}">
            <select class="input" style="width:auto" id="player-pos"><option value="">All positions</option>${positions.map(p => opt(p, p, playerFilter.pos)).join('')}</select>
            <select class="input" style="width:auto" id="player-team"><option value="">All teams</option>${teams.map(t => opt(t, t, playerFilter.team)).join('')}</select>
            <span class="muted">${list.length.toLocaleString()} of ${all.length.toLocaleString()}</span>
        </div>`;
    const table = `<div class="table-wrap"><table class="table"><thead><tr><th>Player</th><th>Pos</th><th>NFL</th><th>Injury</th><th>Bye</th><th>Updated</th></tr></thead><tbody>
        ${slice.length ? slice.map(p => `<tr><td><strong>${esc(p.name)}</strong></td><td>${esc(p.position)}</td><td>${esc(p.team || '')}</td><td>${p.injury_designation ? `<span class="pill warning">${esc(p.injury_designation)}</span> <span class="muted">${esc(p.injury_description || '')}</span>` : ''}</td><td class="dim">${esc(p.bye_week || '')}</td><td class="dim">${p.last_updated ? esc(new Date(p.last_updated).toLocaleDateString()) : ''}</td></tr>`).join('') : '<tr><td colspan="6" class="dim">No players match</td></tr>'}
    </tbody></table></div>`;
    const pager = pages > 1 ? `<div class="row" style="margin-top:12px">${Array.from({ length: pages }, (_, i) => i + 1).filter(n => Math.abs(n - playerFilter.page) <= 2 || n === 1 || n === pages).map(n => `<button class="btn sm ${n === playerFilter.page ? 'primary' : ''}" data-action="page" data-page="${n}">${n}</button>`).join('')}</div>` : '';
    if (existing && document.activeElement === existing) {
        // keep focus while typing: only redraw the table + pager
        body.querySelector('#player-results').innerHTML = table + pager;
        body.querySelector('#player-count').textContent = `${list.length.toLocaleString()} of ${all.length.toLocaleString()}`;
        return;
    }
    body.innerHTML = `<section class="card"><div class="card-body">${filters.replace('<span class="muted">', '<span class="muted" id="player-count">')}<div id="player-results">${table}${pager}</div></div></section>`;
}
