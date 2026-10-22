/**
 * Recaps: one merged card per week — the theme list and the generated recaps
 * are the same list. Each row is a persona: pending themes show a pending
 * pill and a Remove button; generated recaps show rating / fact-check and
 * open in the reader on click. Theme controls (add / suggest / generate) sit
 * under the list for the week the commissioner is reviewing. The reader shows
 * the recap exactly as it pastes into Gmail: inline-styled HTML (Gmail keeps
 * inline styles, drops classes and stylesheets), copied to the clipboard as
 * text/html + text/plain.
 *
 * The shell (picker / list / reader containers) is built once; status polls
 * refresh the run card and the list in place and never touch the reader, so
 * an open recap stays put while a generation runs in the background.
 */

import { getData, api } from '../api.js';
import { esc, ago, fmtDate, pill, card, toast, armed, busy, delegate, renderMarkdown, severityOf } from '../ui.js';
import { setContext } from '../main.js';

export const title = 'Recaps';

let root = null;
let ctxRef = null;
let seasons = [];
let themes = null;
let latestRun = null;
let setup = null;
let generating = false;
let sel = { season: null, week: null, slug: null, styleName: null };
let pollTimer = null;

export async function render(view, ctx) {
    ctxRef = ctx;
    root = document.createElement('div');
    root.className = 'stack';
    view.replaceChildren(root);
    root.innerHTML = `
        <div id="run-slot"></div>
        <section class="card">
            <div class="card-head"><h2>Recaps</h2><div class="row" id="picker"></div></div>
            <div id="styles"></div>
            <div id="theme-footer"></div>
        </section>
        <div id="reader"></div>`;
    delegate(root, {
        open: el => openRecap(el.dataset.slug, el.dataset.name),
        draft: el => armed(el, () => createDraft(el), 'Tap again to create the draft'),
        copy: el => copyForGmail(el),
        close: () => { sel.slug = null; sel.styleName = null; clearTimeout(regenTimer); root.querySelector('#reader').innerHTML = ''; },
        'regenerate-one': el => armed(el, () => regenerateOne(el), 'Tap again to rewrite this recap'),
        'clear-feedback': () => { const t = root.querySelector('#feedback-text'); if (t) { t.value = ''; t.focus(); } },
        'add-theme': el => addTheme(el),
        'remove-theme': el => armed(el, () => removeTheme(el.dataset.slug), 'Tap again to remove'),
        propose: el => armed(el, () => propose(el), 'Tap again to ask for suggestions'),
        generate: el => armed(el, () => generate(el, false), `Tap again to generate ${themes ? themes.themes.filter(t => !t.generated).length : ''} recap(s)`),
        regenerate: el => armed(el, () => generate(el, true), 'Tap again to regenerate ALL of them'),
        'refresh-run': () => refresh(),
        rate: el => armed(el, () => rateWeek(el), 'Tap again to rate (about two minutes)')
    });
    root.addEventListener('change', event => {
        if (event.target.id === 'recap-season') { sel.season = Number(event.target.value); sel.week = null; renderPicker(); }
        if (event.target.id === 'recap-week') { sel.week = Number(event.target.value); loadWeek(); }
    });
    root.addEventListener('keydown', event => {
        if (event.key === 'Enter' && event.target.id === 'theme-name') { event.preventDefault(); const b = root.querySelector('[data-action="add-theme"]'); if (b) addTheme(b); }
    });
    await refresh();
}

export async function refresh() {
    if (!root) return;
    const data = await getData('/api/admin/recaps').catch(() => ({ seasons: [] }));
    seasons = data.seasons || [];
    themes = data.themes || null;
    setup = data.setup || null;
    latestRun = data.latestRun || null;
    generating = !!data.generating;
    setContext(themes
        ? `${themes.season} week ${themes.week} · ${themes.themes.length} theme${themes.themes.length === 1 ? '' : 's'} · ${generating ? 'generating…' : themes.generatedAt ? `generated ${ago(themes.generatedAt)}` : 'awaiting your review'}`
        : latestRun ? `last run ${latestRun.overallStatus} · ${ago(latestRun.runAt)}` : 'no themes proposed yet');
    if (sel.season === null && seasons.length) { sel.season = seasons[0].season; sel.week = seasons[0].weeks[0]?.week ?? null; }
    // A freshly proposed themes week may not have recap files yet, so it won't
    // be in `seasons` — still make it selectable so its list can be reviewed.
    if (themes && sel.season === themes.season && sel.week === null) sel.week = themes.week;
    root.querySelector('#run-slot').innerHTML = runCard(latestRun, generating);
    renderPicker();
    clearTimeout(pollTimer);
    if (generating || (setup && setup.status === 'running')) pollTimer = setTimeout(() => refresh(), 20000);
}

// ---------- Ratings ----------

/** "★★★★½" for 4.5, with the number in the tooltip. */
function stars(n) {
    if (n == null) return '';
    const full = Math.floor(n);
    const half = n - full >= 0.5;
    return `<span class="stars" title="${esc(String(n))} / 5">${'★'.repeat(full)}${half ? '½' : ''}<span class="dim">${'★'.repeat(5 - full - (half ? 1 : 0))}</span></span>`;
}

function recommendedPill(r) {
    return r && r.recommended ? pill('accent', '★ recommended') : '';
}

async function rateWeek(button) {
    if (!sel.season || !sel.week) return;
    await busy(button, 'Rating…', async () => {
        try {
            const body = await api.post(`/api/admin/recaps/${sel.season}/${sel.week}/rate`);
            toast(body.data.message, 'success');
            clearTimeout(pollTimer);
            pollTimer = setTimeout(() => refresh(), 45000);
        } catch (error) {
            toast(error.message, 'error');
        }
    });
}

// ---------- The merged week list ----------

/** True when the summary's themes doc is the week currently selected in the picker. */
function themesWeekSelected() {
    return !!(themes && themes.season === sel.season && themes.week === sel.week);
}

function renderPicker() {
    const picker = root.querySelector('#picker');
    const seasonList = seasons.map(s => s.season);
    if (themes && !seasonList.includes(themes.season)) seasonList.unshift(themes.season);
    const s = seasons.find(x => x.season === sel.season);
    const weeks = ((s && s.weeks) || []).map(w => ({ ...w }));
    if (themes && themes.season === sel.season && !weeks.some(w => w.week === themes.week)) {
        weeks.unshift({ week: themes.week, count: 0, hasFactcheck: false });
    }
    if (sel.week === null && weeks.length) sel.week = weeks[0].week;
    picker.innerHTML = `
        <select class="input" style="width:auto" id="recap-season">${seasonList.map(x => `<option value="${x}" ${x === sel.season ? 'selected' : ''}>${x}</option>`).join('')}</select>
        <select class="input" style="width:auto" id="recap-week">${weeks.map(w => `<option value="${w.week}" ${w.week === sel.week ? 'selected' : ''}>Week ${w.week}${w.count ? ` (${w.count} recap${w.count === 1 ? '' : 's'}${w.hasFactcheck ? ', fact-checked' : ''})` : ''}</option>`).join('')}</select>`;
    loadWeek();
}

function themeRow(th) {
    return `<tr>
        <td><strong>${esc(th.name)}</strong> <span class="dim">${esc(th.slug)}</span> ${th.origin === 'commissioner' ? pill('accent', 'you') : ''}${th.description ? `<div class="muted">${esc(th.description)}</div>` : ''}</td>
        <td><span class="dim">—</span></td>
        <td>${generating ? pill('info', 'generating…') : pill('warning', 'pending')} <button class="btn sm ghost" data-action="remove-theme" data-slug="${esc(th.slug)}">Remove</button></td>
    </tr>`;
}

function styleRow(st, hasFactcheck) {
    return `<tr class="clickable${st.rating && st.rating.recommended ? ' recommended' : ''}" data-action="open" data-slug="${esc(st.slug)}" data-name="${esc(st.styleName)}">
        <td>${st.rating && st.rating.recommended ? '<span class="rec-star" title="Recommended">★</span> ' : ''}<strong>${esc(st.styleName)}</strong> <span class="dim">${esc(st.slug)}</span>${st.rating && st.rating.blurb ? `<div class="muted">${esc(st.rating.blurb)}</div>` : ''}</td>
        <td>${st.rating ? stars(st.rating.stars) : '<span class="dim">—</span>'}</td>
        <td>${hasFactcheck ? (st.factcheck ? pill(st.factcheck === 'PASS' ? 'ok' : 'critical', st.factcheck) : '<span class="dim">unchecked</span>') : '<span class="dim">—</span>'}</td>
    </tr>`;
}

async function loadWeek() {
    const out = root.querySelector('#styles');
    renderThemeFooter();
    if (!sel.season || !sel.week) {
        out.innerHTML = `<div class="card-body"><span class="quiet">${setup && setup.summary ? esc(setup.summary) : 'No recaps yet this season. Themes are proposed automatically once every game of the week is final.'}</span></div>`;
        return;
    }
    let d = null;
    let loadError = null;
    try {
        d = await getData(`/api/admin/recaps/${sel.season}/${sel.week}`);
    } catch (error) {
        loadError = error;
    }
    const generated = new Set((d?.styles || []).map(st => st.slug));
    const pendingThemes = themesWeekSelected() ? themes.themes.filter(th => !generated.has(th.slug)) : [];
    if (!d && !pendingThemes.length) {
        out.innerHTML = `<div class="card-body"><span class="${loadError ? 'err' : 'quiet'}">${esc(loadError ? loadError.message : 'Nothing here yet.')}</span></div>`;
        return;
    }
    const rated = !!(d && d.ratings);
    const rows = pendingThemes.map(themeRow).join('') + (d?.styles || []).map(st => styleRow(st, d.hasFactcheck)).join('');
    out.innerHTML = `${d ? `<div class="card-body row" style="justify-content:space-between;flex-wrap:wrap;gap:6px">
            <span class="muted">${rated ? `Rated on storytelling and interest ${esc(ago(d.ratings.ratedAt))} (${esc(d.ratings.ratedBy || 'claude')}) - ★ marks the one to send.` : 'Not rated yet.'}</span>
            <button class="btn sm ghost" data-action="rate">${rated ? 'Re-rate' : 'Rate recaps'}</button>
        </div>` : ''}
        <div class="table-wrap"><table class="table"><thead><tr><th>Style</th><th>Rating</th><th>Fact-check</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** Theme controls under the list — only for the week the themes doc is about. */
function renderThemeFooter() {
    const foot = root.querySelector('#theme-footer');
    if (!themesWeekSelected()) { foot.innerHTML = ''; return; }
    const t = themes;
    // Keep whatever the commissioner already typed across background polls.
    const prevName = foot.querySelector('#theme-name');
    const prevDesc = foot.querySelector('#theme-desc');
    const nameVal = prevName ? prevName.value : '';
    const descVal = prevDesc ? prevDesc.value : '';
    const focusId = document.activeElement && ['theme-name', 'theme-desc'].includes(document.activeElement.id) ? document.activeElement.id : null;
    const v = t.validation;
    const gate = v
        ? `Validation ${v.overallStatus} (${ago(v.runAt)})`
        : `Week ${t.week} not validated yet - Generate stays off until the 13:00 UTC daily validation (or run it on Scoring & data)`;
    const allDone = t.themes.length > 0 && t.themes.every(th => th.generated);
    const pending = t.themes.filter(th => !th.generated).length;
    let action;
    if (generating) action = '<span class="muted">Generating… (10-30 min)</span> <button class="btn sm ghost" data-action="refresh-run">Refresh</button>';
    else if (allDone) action = '<button class="btn sm ghost" data-action="regenerate">Regenerate all</button>';
    else action = `<button class="btn sm primary" data-action="generate" ${t.canGenerate && t.themes.length ? '' : 'disabled'}>Generate ${pending} recap${pending === 1 ? '' : 's'}</button>`;
    foot.innerHTML = `<div class="card-body">
        <div class="row" style="flex-wrap:wrap;gap:6px">
            <input class="input" id="theme-name" placeholder="New theme, e.g. Morgan Freeman narration" style="flex:1;min-width:200px" ${allDone ? 'disabled' : ''}>
            <input class="input" id="theme-desc" placeholder="optional: one line on the voice" style="flex:2;min-width:200px" ${allDone ? 'disabled' : ''}>
            <button class="btn sm" data-action="add-theme" ${allDone ? 'disabled' : ''}>Add theme</button>
            <button class="btn sm ghost" data-action="propose" ${allDone || generating ? 'disabled' : ''}>Suggest more</button>
            <span style="margin-left:auto">${action}</span>
        </div>
        <div class="muted" style="margin-top:8px">${t.proposedAt ? `Proposed ${ago(t.proposedAt)} · ` : ''}${esc(gate)}${t.lastRun ? ` · last run ${esc(t.lastRun.overallStatus)}${t.lastRun.error ? `: ${esc(t.lastRun.error)}` : t.lastRun.note ? `: ${esc(t.lastRun.note)}` : ''}` : ''}</div>
        <div id="theme-status"></div>
    </div>`;
    foot.querySelector('#theme-name').value = nameVal;
    foot.querySelector('#theme-desc').value = descVal;
    if (focusId) { const el = foot.querySelector(`#${focusId}`); if (el && !el.disabled) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
}

async function addTheme(button) {
    if (!themes) return;
    const name = root.querySelector('#theme-name').value.trim();
    const description = root.querySelector('#theme-desc').value.trim();
    if (name.length < 3) { toast('Give the theme a name (3+ characters)', 'error'); return; }
    await busy(button, 'Adding…', async () => {
        try {
            const body = await api.post(`/api/admin/recaps/${themes.season}/${themes.week}/themes`, { name, description });
            toast(`Added "${body.data.added.name}"`, 'success');
            const nameEl = root.querySelector('#theme-name');
            const descEl = root.querySelector('#theme-desc');
            if (nameEl) nameEl.value = '';
            if (descEl) descEl.value = '';
            await refresh();
        } catch (error) {
            toast(error.message, 'error');
        }
    });
}

async function removeTheme(slug) {
    if (!themes) return;
    try {
        await api.del(`/api/admin/recaps/${themes.season}/${themes.week}/themes/${encodeURIComponent(slug)}`);
        toast(`Removed ${slug}`, 'success');
        await refresh();
    } catch (error) {
        toast(error.message, 'error');
    }
}

async function propose(button) {
    if (!themes) return;
    await busy(button, 'Asking…', async () => {
        try {
            await api.post(`/api/admin/recaps/${themes.season}/${themes.week}/themes/propose`);
            toast('Asking claude for suggestions - about a minute', 'success');
            clearTimeout(pollTimer);
            pollTimer = setTimeout(() => refresh(), 20000);
        } catch (error) {
            toast(error.message, 'error');
        }
    });
}

async function generate(button, regenerate) {
    if (!themes) return;
    await busy(button, 'Starting…', async () => {
        try {
            const body = await api.post(`/api/admin/recaps/${themes.season}/${themes.week}/generate`, { regenerate });
            toast(body.data.message, 'success');
            await refresh();
        } catch (error) {
            const status = root.querySelector('#theme-status');
            if (status) status.innerHTML = `<div class="note critical">${esc(error.message)}</div>`;
            toast(error.message, 'error');
        }
    });
}

// ---------- Last run ----------

function runCard(run, isGenerating) {
    if (!run) return '';
    const styles = (run.styles || []).map(s => `<li>${esc(s.slug)} ${s.factcheck ? pill(s.factcheck === 'PASS' ? 'ok' : 'critical', s.factcheck) : ''}</li>`).join('');
    return card({
        title: `Last recap run ${pill(severityOf(run.overallStatus === 'RUNNING' ? 'info' : run.overallStatus), run.overallStatus)}`,
        meta: `${run.season ? `${esc(run.season)} week ${esc(run.week)} · ` : ''}${esc(run.trigger || '')} · ${fmtDate(run.runAt)} (${ago(run.runAt)})`,
        actions: isGenerating ? '<button class="btn sm ghost" data-action="refresh-run">Refresh</button>' : '',
        body: `${run.reason ? `<div class="muted">${esc(run.reason)}</div>` : ''}${run.error ? `<div class="note critical">${esc(run.error)}</div>` : ''}${run.note ? `<div class="muted">${esc(run.note)} - open it below to see what the checker found.</div>` : ''}${styles ? `<details class="disclosure"><summary>${run.styles.length} recap(s) written</summary><ul class="checks">${styles}</ul></details>` : ''}`
    });
}

// ---------- Reader ----------

// Inline styles Gmail preserves on paste (it strips <style> blocks and class names).
const EMAIL_STYLES = {
    h1: 'font-size:22px;font-weight:bold;margin:18px 0 8px;line-height:1.3',
    h2: 'font-size:18px;font-weight:bold;margin:18px 0 6px;line-height:1.3',
    h3: 'font-size:16px;font-weight:bold;margin:14px 0 4px;line-height:1.3',
    h4: 'font-size:15px;font-weight:bold;margin:12px 0 4px',
    h5: 'font-size:15px;font-weight:bold;margin:12px 0 4px',
    h6: 'font-size:15px;font-weight:bold;margin:12px 0 4px',
    p: 'margin:0 0 12px;line-height:1.5',
    ul: 'margin:0 0 12px;padding-left:24px',
    ol: 'margin:0 0 12px;padding-left:24px',
    li: 'margin:0 0 4px;line-height:1.5',
    blockquote: 'margin:0 0 12px;padding-left:12px;border-left:3px solid #c8ccd4;color:#555',
    hr: 'border:none;border-top:1px solid #c8ccd4;margin:16px 0',
    table: 'border-collapse:collapse;margin:0 0 12px;font-size:14px',
    th: 'border:1px solid #c8ccd4;padding:4px 8px;text-align:left;background:#f0f1f3;font-weight:bold',
    td: 'border:1px solid #c8ccd4;padding:4px 8px;vertical-align:top'
};

/** Markdown -> Gmail-ready HTML: the same structure as renderMarkdown, every tag inline-styled. */
export function emailHtml(markdown) {
    const box = document.createElement('div');
    box.innerHTML = renderMarkdown(markdown || '');
    for (const [tag, style] of Object.entries(EMAIL_STYLES)) {
        box.querySelectorAll(tag).forEach(el => el.setAttribute('style', style));
    }
    box.setAttribute('style', 'font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111111;line-height:1.5');
    return box.outerHTML;
}

let currentMarkdown = '';
let regenTimer = null;

async function openRecap(slug, styleName) {
    const reader = root.querySelector('#reader');
    sel.slug = slug;
    sel.styleName = styleName;
    clearTimeout(regenTimer);
    reader.innerHTML = '<p class="quiet">Loading…</p>';
    try {
        const d = await getData(`/api/admin/recaps/${sel.season}/${sel.week}/${encodeURIComponent(slug)}`);
        currentMarkdown = d.markdown || '';
        reader.innerHTML = card({
            title: `${esc(sel.season)} week ${esc(sel.week)} — ${esc(styleName)} ${d.rating ? stars(d.rating.stars) : ''} ${recommendedPill(d.rating)}`,
            actions: `<button class="btn primary" data-action="copy">Copy for Gmail</button><button class="btn" data-action="draft">Create Gmail draft</button><button class="btn ghost" data-action="close">Close</button>`,
            body: `<div id="draft-status"></div>${d.rating && d.rating.blurb ? `<div class="muted" style="margin-bottom:8px">${esc(d.rating.blurb)}</div>` : ''}${factcheckNote(d.factcheck)}
                ${feedbackBox()}
                <div class="muted" style="margin-bottom:8px">Shown as it pastes into Gmail. Copy for Gmail puts the formatted recap on the clipboard - paste it into a compose window with Ctrl+V / Cmd+V.</div>
                <div class="email-preview" id="recap-email">${emailHtml(currentMarkdown)}</div>`
        });
        reader.scrollIntoView({ behavior: 'smooth' });
        pollRegeneration();
    } catch (error) {
        reader.innerHTML = `<p class="err">${esc(error.message)}</p>`;
    }
}

// ---------- Give feedback and run again (one recap) ----------

/** The feedback box: free-form notes for the writer; only this recap is rewritten (scripts/recap-regenerate.js). */
function feedbackBox() {
    return `<details class="disclosure" id="feedback-box" style="margin-bottom:10px">
        <summary>Give feedback and run again</summary>
        <div class="muted" style="margin:6px 0">Tell the writer what to change. Only this recap is rewritten (about five minutes, fact-checked); the current version stays until the new one is ready, then it reopens here.</div>
        <textarea class="input" id="feedback-text" rows="4" style="width:100%;box-sizing:border-box" placeholder="e.g. Too long - cut the injury jokes, give the Chris/Joe game more room, keep the closing bit."></textarea>
        <div class="row" style="margin-top:6px;gap:6px;flex-wrap:wrap">
            <button class="btn sm primary" data-action="regenerate-one">Run again with feedback</button>
            <button class="btn sm ghost" data-action="clear-feedback">Clear</button>
        </div>
    </details>
    <div id="regen-status"></div>`;
}

async function regenerateOne(button) {
    if (!sel.slug) return;
    const box = root.querySelector('#feedback-text');
    const feedback = box ? box.value.trim() : '';
    if (feedback.length < 5) { toast('Say what should change first (a few words at least)', 'error'); if (box) box.focus(); return; }
    await busy(button, 'Starting…', async () => {
        try {
            const body = await api.post(`/api/admin/recaps/${sel.season}/${sel.week}/${encodeURIComponent(sel.slug)}/regenerate`, { feedback });
            toast(body.data.message, 'success');
            renderRegenNote({ status: 'running', ts: new Date().toISOString(), summary: body.data.message, details: {} });
            clearTimeout(regenTimer);
            regenTimer = setTimeout(() => pollRegeneration(), 15000);
        } catch (error) {
            const status = root.querySelector('#regen-status');
            if (status) status.innerHTML = `<div class="note critical" style="margin-bottom:8px">${esc(error.message)}</div>`;
            toast(error.message, 'error');
        }
    });
}

/** Ask the server about this recap's rewrite; keep polling while it runs; reopen the recap when it lands. */
async function pollRegeneration() {
    if (!sel.slug || !root.querySelector('#regen-status')) return;
    const slug = sel.slug;
    let d;
    try {
        d = await getData(`/api/admin/recaps/${sel.season}/${sel.week}/${encodeURIComponent(slug)}/regenerate`);
    } catch (_) { return; }
    if (sel.slug !== slug) return; // the commissioner opened another recap meanwhile
    const r = d.regeneration;
    if (!r) return;
    const wasRunning = !!(root.querySelector('#regen-status [data-running]'));
    renderRegenNote(r);
    if (r.status === 'running') {
        clearTimeout(regenTimer);
        regenTimer = setTimeout(() => pollRegeneration(), 15000);
    } else if (wasRunning) {
        // Just finished: show the new text (or the error) and refresh the week's list
        if (r.status === 'ok') toast(`${sel.styleName} rewritten - fact-check ${r.details && r.details.verdict ? r.details.verdict : 'not run'}`, 'success');
        else if (r.status === 'warning') toast(`${sel.styleName} not replaced - the new draft FAILED the fact-check`, 'error');
        else toast(r.summary, 'error');
        await loadWeek();
        await openRecap(slug, sel.styleName);
    }
}

function renderRegenNote(r) {
    const status = root.querySelector('#regen-status');
    if (!status) return;
    const details = r.details || {};
    const fb = details.feedback ? `<details class="disclosure" style="margin-top:4px"><summary>your feedback</summary><div class="prose">${esc(details.feedback)}</div></details>` : '';
    const when = r.ts ? ` (${esc(ago(r.ts))})` : '';
    let html;
    if (r.status === 'running') html = `<div class="note info" style="margin-bottom:8px" data-running="1">Rewriting from your feedback${when} - about five minutes. The version below stays until the new one is ready.${fb}</div>`;
    else if (r.status === 'ok') html = `<div class="note ok" style="margin-bottom:8px">Rewritten from your feedback${when}${details.verdict ? ` - fact-check ${esc(details.verdict)}` : ''}${details.words ? ` - ${esc(String(details.words))} words` : ''}. Its rating was dropped; Rate recaps redoes the week.${fb}</div>`;
    else if (r.status === 'warning') {
        const found = details.factcheck ? `<details class="disclosure" style="margin-top:6px"><summary>What the fact-checker found in the draft</summary><div class="prose">${renderMarkdown(details.factcheck)}</div></details>` : '';
        html = `<div class="note warning" style="margin-bottom:8px">The rewrite from your feedback${when} FAILED the fact-check (a wrong fact or an ignored instruction), so the version below was kept. Give feedback again to retry - everything you said before still applies.${found}${fb}</div>`;
    }
    else html = `<div class="note critical" style="margin-bottom:8px">Rewrite failed${when}: ${esc(r.summary || 'unknown error')} - the previous version is untouched.${fb}</div>`;
    status.innerHTML = html;
}

/** The fact-checker's verdict for this recap, shown right above it (a FAIL here is the only place it's flagged red). */
function factcheckNote(fc) {
    if (!fc) return '<div class="muted" style="margin-bottom:8px">Not fact-checked.</div>';
    const detail = fc.detail ? `<details class="disclosure" style="margin-top:6px"><summary>What the fact-checker found</summary><div class="prose">${renderMarkdown(fc.detail)}</div></details>` : '';
    if (fc.verdict === 'PASS') return `<div class="note ok" style="margin-bottom:8px">Fact-check PASS${detail}</div>`;
    return `<div class="note critical" style="margin-bottom:8px"><strong>Fact-check FAIL</strong> - this recap has at least one claim that contradicts the digest. Fix it or don't send it.${detail}</div>`;
}

/** Put the recap on the clipboard as rich text (text/html) with the markdown as the plain-text fallback. */
async function copyForGmail(button) {
    const preview = root.querySelector('#recap-email');
    if (!preview) return;
    const html = preview.innerHTML;
    const text = currentMarkdown;
    await busy(button, 'Copying…', async () => {
        try {
            if (navigator.clipboard && window.ClipboardItem) {
                await navigator.clipboard.write([new ClipboardItem({
                    'text/html': new Blob([html], { type: 'text/html' }),
                    'text/plain': new Blob([text], { type: 'text/plain' })
                })]);
            } else {
                selectionCopy(preview);
            }
            toast('Copied - paste into a Gmail compose window', 'success');
        } catch (error) {
            try { selectionCopy(preview); toast('Copied - paste into a Gmail compose window', 'success'); }
            catch (_) { toast(`Copy failed (${error.message}) - select the preview and copy by hand`, 'error'); }
        }
    });
}

/** Fallback for browsers without ClipboardItem: select the rendered preview and copy the selection. */
function selectionCopy(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const ok = document.execCommand('copy');
    selection.removeAllRanges();
    if (!ok) throw new Error('execCommand copy refused');
}

async function createDraft(button) {
    if (!sel.slug) return;
    const status = root.querySelector('#draft-status');
    await busy(button, 'Creating draft…', async () => {
        try {
            const body = await api.post(`/api/admin/recaps/${sel.season}/${sel.week}/${encodeURIComponent(sel.slug)}/draft`);
            status.innerHTML = `<div class="note ok">Draft created: ${esc(body.data?.subject || '')} · <a href="https://mail.google.com/mail/#drafts" target="_blank" rel="noopener">open Gmail drafts</a></div>`;
            toast('Gmail draft created', 'success');
            button.disabled = true;
        } catch (error) {
            status.innerHTML = `<div class="note critical">${esc(error.message)}</div>`;
        }
    });
}
