/**
 * Podcast: The PFL Cast outlines for Jellypod. Edit who is on the show, press
 * Generate, and scripts/podcast-outlines.js writes five outlines from the
 * week's validated digest and marks Claude's favorite. Click an outline to
 * read it; Copy puts the markdown on the clipboard for Jellypod. Finished
 * audio is posted at /podcast_upload (server/routes/podcastUpload.js).
 */

import { getData, api } from '../api.js';
import { esc, ago, pill, card, toast, armed, busy, delegate, renderMarkdown } from '../ui.js';
import { setContext } from '../main.js';
import { emailHtml } from './recaps.js';

export const title = 'Podcast';

let root = null;
let summary = null;
let hosts = [];
let hostsDirty = false;
let sel = { season: null, week: null, outline: null };
let episodeView = null;
let pollTimer = null;

export async function render(view) {
    root = document.createElement('div');
    root.className = 'stack';
    view.replaceChildren(root);
    root.innerHTML = `
        <div id="hosts-slot"></div>
        <section class="card">
            <div class="card-head"><h2>Outlines</h2><div class="row" id="pod-picker"></div></div>
            <div id="pod-week"></div>
        </section>
        <div id="pod-reader"></div>
        <section class="card">
            <div class="card-head"><h2>Emails</h2></div>
            <div id="pod-emails"><div class="card-body"><span class="quiet">Loading…</span></div></div>
        </section>
        <div id="email-reader"></div>
        <section class="card">
            <div class="card-head"><h2>Publishing</h2></div>
            <div class="card-body">
                <p style="margin:0 0 6px">Post the finished episode audio at <a href="https://peninsulafootball.com/podcast_upload" target="_blank" rel="noopener"><strong>peninsulafootball.com/podcast_upload</strong></a> (it has its own password). The uploader asks for the week, a title and a description.</p>
                <p class="muted" style="margin:0">Episodes appear on <a href="https://peninsulafootball.com/podcast" target="_blank" rel="noopener">peninsulafootball.com/podcast</a>.</p>
            </div>
        </section>`;
    delegate(root, {
        'add-host': () => { readHostInputs(); hosts.push({ name: '', role: hosts.length >= 2 ? 'guest' : 'host', traits: '' }); hostsDirty = true; renderHosts(); },
        'remove-host': el => { readHostInputs(); hosts.splice(Number(el.dataset.i), 1); hostsDirty = true; renderHosts(); },
        'save-hosts': el => saveHosts(el),
        generate: el => armed(el, () => generate(el), 'Tap again to write 5 outlines'),
        open: el => openOutline(el.dataset.id),
        close: () => { sel.outline = null; root.querySelector('#pod-reader').innerHTML = ''; },
        copy: el => copyOutline(el),
        choose: el => chooseOutline(el),
        'open-email': el => openEmail(el.dataset.slug),
        'close-email': () => { root.querySelector('#email-reader').innerHTML = ''; },
        'copy-subject': el => copySubject(el),
        'copy-email': el => copyEmail(el)
    });
    root.addEventListener('input', event => { if (event.target.closest('#hosts-slot')) hostsDirty = true; });
    root.addEventListener('change', event => {
        if (event.target.id === 'pod-week-select') {
            const [s, w] = event.target.value.split('-').map(Number);
            sel = { season: s, week: w, outline: null };
            root.querySelector('#pod-reader').innerHTML = '';
            loadWeek();
        }
    });
    await refresh();
}

export function destroy() { clearTimeout(pollTimer); root = null; }

export async function refresh() {
    if (!root) return;
    summary = await getData('/api/admin/podcast');
    if (!hostsDirty) hosts = (summary.hosts || []).map(h => ({ ...h }));
    renderHosts();
    if (sel.season === null && summary.weeks.length) {
        const w = summary.running || summary.weeks[0];
        sel = { season: Number(w.season), week: Number(w.week), outline: null };
    }
    renderPicker();
    await loadWeek();
    await loadEmails();
}

// ---------- Hosts ----------

function readHostInputs() {
    root.querySelectorAll('[data-host-row]').forEach(row => {
        const i = Number(row.dataset.hostRow);
        if (!hosts[i]) return;
        hosts[i] = {
            name: row.querySelector('.h-name').value,
            role: row.querySelector('.h-role').value,
            traits: row.querySelector('.h-traits').value
        };
    });
}

function renderHosts() {
    const max = (summary && summary.maxHosts) || 4;
    const rows = hosts.map((h, i) => `
        <div class="row" data-host-row="${i}" style="flex-wrap:wrap;gap:6px;align-items:flex-start;margin-bottom:8px">
            <input class="input h-name" placeholder="Real person, e.g. Peyton Manning" value="${esc(h.name)}" style="flex:1;min-width:180px">
            <select class="input h-role" style="width:auto">
                <option value="host" ${h.role === 'host' ? 'selected' : ''}>Host</option>
                <option value="guest" ${h.role === 'guest' ? 'selected' : ''}>Guest</option>
            </select>
            <textarea class="input h-traits" rows="2" placeholder="Traits to play up (optional - otherwise their well-known on-air personality)" style="flex:3;min-width:240px">${esc(h.traits)}</textarea>
            <button class="btn sm ghost" data-action="remove-host" data-i="${i}" ${hosts.length <= 1 ? 'disabled' : ''}>Remove</button>
        </div>`).join('');
    root.querySelector('#hosts-slot').innerHTML = card({
        title: 'On the show',
        meta: summary && summary.hostsUpdatedAt ? `saved ${esc(ago(summary.hostsUpdatedAt))}` : 'defaults - not saved yet',
        body: `${rows}
            <div class="row" style="gap:6px">
                <button class="btn sm" data-action="add-host" ${hosts.length >= max ? 'disabled' : ''}>Add person</button>
                <span class="muted">Up to ${max}. Real named people; a guest is optional.</span>
                <span style="margin-left:auto"><button class="btn sm primary" data-action="save-hosts">${hostsDirty ? 'Save changes' : 'Save'}</button></span>
            </div>`
    });
}

async function saveHosts(button) {
    readHostInputs();
    await busy(button, 'Saving…', async () => {
        try {
            const body = await api.put('/api/admin/podcast/hosts', { hosts });
            hosts = body.data.hosts.map(h => ({ ...h }));
            hostsDirty = false;
            toast('Saved - the next generation uses this lineup', 'success');
            await refresh();
        } catch (error) {
            toast(error.message, 'error');
        }
    });
}

// ---------- Week ----------

function renderPicker() {
    const weeks = (summary && summary.weeks) || [];
    root.querySelector('#pod-picker').innerHTML = weeks.length
        ? `<select class="input" style="width:auto" id="pod-week-select">${weeks.map(w => `<option value="${w.season}-${w.week}" ${w.season === sel.season && w.week === sel.week ? 'selected' : ''}>${w.season} week ${w.week}${w.hasEpisode ? ' (outlines)' : ''}</option>`).join('')}</select>`
        : '';
}

function stars(n) {
    if (n == null) return '<span class="dim">—</span>';
    const full = Math.floor(n);
    const half = n - full >= 0.5;
    return `<span class="stars" title="${esc(String(n))} / 5">${'★'.repeat(full)}${half ? '½' : ''}<span class="dim">${'★'.repeat(5 - full - (half ? 1 : 0))}</span></span>`;
}

async function loadWeek() {
    const out = root.querySelector('#pod-week');
    if (!sel.season) {
        out.innerHTML = '<div class="card-body"><span class="quiet">No validated week yet. Outlines can be written once a week passes the daily validation.</span></div>';
        setContext('');
        return;
    }
    try {
        episodeView = await getData(`/api/admin/podcast/${sel.season}/${sel.week}`);
    } catch (error) {
        out.innerHTML = `<div class="card-body"><span class="err">${esc(error.message)}</span></div>`;
        return;
    }
    const ep = episodeView.episode;
    const running = episodeView.running;
    setContext(`${sel.season} week ${sel.week} · ${running ? 'writing outlines…' : ep && ep.status === 'ok' ? `${ep.outlines.length} outlines · ${ago(ep.finishedAt)}` : 'no outlines yet'}`);

    let action;
    if (running) action = '<span class="muted">Writing 5 outlines… (about 5 minutes)</span>';
    else if (episodeView.gate) action = `<span class="muted">${esc(episodeView.gate)}</span>`;
    else if (episodeView.busy) action = '<span class="muted">Another week is being written - wait for it to finish</span>';
    else action = `<button class="btn sm primary" data-action="generate">${ep && ep.outlines && ep.outlines.length ? 'Write 5 new outlines' : 'Write 5 outlines'}</button>`;

    const outlines = (ep && ep.outlines) || [];
    const ordered = [...outlines].sort((a, b) => (b.id === ep.chosen) - (a.id === ep.chosen) || (b.id === ep.favorite) - (a.id === ep.favorite) || (b.stars || 0) - (a.stars || 0));
    const rows = ordered.map(o => `
        <tr class="clickable${o.id === ep.favorite ? ' recommended' : ''}" data-action="open" data-id="${esc(o.id)}">
            <td>${o.id === ep.favorite ? '<span class="rec-star" title="Claude\'s favorite">★</span> ' : ''}<strong>${esc(o.title)}</strong>${o.id === ep.chosen ? ` ${pill('ok', 'your pick')}` : ''}${o.premise ? `<div class="muted">${esc(o.premise)}</div>` : ''}${o.blurb ? `<div class="muted"><em>${esc(o.blurb)}</em></div>` : ''}</td>
            <td>${stars(o.stars)}</td>
        </tr>`).join('');
    const fav = outlines.find(o => o.id === (ep && ep.favorite));
    const cast = ep && ep.hosts ? ep.hosts.map(h => `${h.name}${h.role === 'guest' ? ' (guest)' : ''}`).join(', ') : '';
    out.innerHTML = `
        <div class="card-body row" style="justify-content:space-between;flex-wrap:wrap;gap:6px">
            <span class="muted">${ep && ep.status === 'failed' ? `<span class="err">Last run failed: ${esc(ep.error || 'unknown error')}</span>` : ep && ep.status === 'ok' ? `With ${esc(cast)}${fav ? ` · ★ Claude's favorite: <strong>${esc(fav.title)}</strong>${ep.favoriteReason ? ` - ${esc(ep.favoriteReason)}` : ''}` : ''}${ep.error ? ` · ${esc(ep.error)}` : ''}` : 'Outlines are segments and talking points for Jellypod, built from the validated digest.'}</span>
            <span>${action}</span>
        </div>
        ${rows ? `<div class="table-wrap"><table class="table"><thead><tr><th>Outline</th><th>Rating</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}`;

    clearTimeout(pollTimer);
    if (running || (summary && summary.running)) pollTimer = setTimeout(() => refresh().catch(() => {}), 20000);
    if (sel.outline && outlines.some(o => o.id === sel.outline)) renderReader();
}

async function generate(button) {
    await busy(button, 'Starting…', async () => {
        try {
            const body = await api.post(`/api/admin/podcast/${sel.season}/${sel.week}/generate`);
            toast(body.data.message, 'success');
            await refresh();
        } catch (error) {
            toast(error.message, 'error');
        }
    });
}

// ---------- Reader ----------

function currentOutline() {
    const ep = episodeView && episodeView.episode;
    return ep && ep.outlines ? ep.outlines.find(o => o.id === sel.outline) : null;
}

function openOutline(id) {
    sel.outline = id;
    renderReader();
    root.querySelector('#pod-reader').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderReader() {
    const o = currentOutline();
    const reader = root.querySelector('#pod-reader');
    if (!o) { reader.innerHTML = ''; return; }
    const ep = episodeView.episode;
    const numbers = (o.unverifiedNumbers || []).length
        ? `<div class="muted" style="margin-bottom:10px">Numbers not found in the digest (often a host's own career stat or a joke; worth a glance): ${o.unverifiedNumbers.map(n => pill('info', n)).join(' ')}</div>`
        : '';
    reader.innerHTML = card({
        title: `${o.id === ep.favorite ? '★ ' : ''}${esc(o.title)}`,
        actions: `${o.id === ep.chosen ? pill('ok', 'your pick') : '<button class="btn sm" data-action="choose">Use this one</button>'} <button class="btn sm primary" data-action="copy">Copy for Jellypod</button> <button class="btn sm ghost" data-action="close">Close</button>`,
        meta: o.editNote ? esc(o.editNote) : '',
        body: `${o.runningBit ? `<div class="muted" style="margin-bottom:6px">Running bit: ${esc(o.runningBit)}</div>` : ''}${numbers}<div class="prose">${renderMarkdown(o.markdown)}</div>`
    });
}

async function chooseOutline(button) {
    const o = currentOutline();
    if (!o) return;
    await busy(button, 'Saving…', async () => {
        try {
            await api.post(`/api/admin/podcast/${sel.season}/${sel.week}/choose`, { id: o.id });
            toast(`Using "${o.title}" - next week's show builds on it`, 'success');
            await loadWeek();
            renderReader();
        } catch (error) {
            toast(error.message, 'error');
        }
    });
}

async function copyOutline(button) {
    const o = currentOutline();
    if (!o) return;
    await busy(button, 'Copying…', async () => {
        try {
            await navigator.clipboard.writeText(o.markdown);
            toast('Copied - paste it into Jellypod', 'success');
        } catch (_) {
            const ta = document.createElement('textarea');
            ta.value = o.markdown;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            toast('Copied - paste it into Jellypod', 'success');
        }
    });
}


// ---------- Emails (podcast/emails/*.md) ----------

let emails = [];
let openEmailSlug = null;

async function loadEmails() {
    const box = root && root.querySelector('#pod-emails');
    if (!box) return;
    try {
        emails = (await getData('/api/admin/podcast/emails')).emails || [];
    } catch (error) {
        box.innerHTML = `<div class="card-body"><span class="err">${esc(error.message)}</span></div>`;
        return;
    }
    box.innerHTML = emails.length
        ? `<div class="table-wrap"><table class="table"><tbody>${emails.map(e => `
            <tr class="clickable" data-action="open-email" data-slug="${esc(e.slug)}"><td><strong>${esc(e.subject)}</strong> <span class="dim">${esc(e.slug)}</span></td></tr>`).join('')}</tbody></table></div>`
        : '<div class="card-body"><span class="quiet">No emails yet.</span></div>';
}

/** Gmail-ready HTML (inline styles, from the recap reader) with plain URLs turned into links. */
function gmailHtml(markdown) {
    const box = document.createElement('div');
    box.innerHTML = emailHtml(markdown);
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) if (/https?:\/\//.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
    for (const node of nodes) {
        const frag = document.createDocumentFragment();
        node.nodeValue.split(/(https?:\/\/[^\s<]+)/).forEach((part, i) => {
            if (i % 2) {
                const a = document.createElement('a');
                a.href = part;
                a.textContent = part;
                a.setAttribute('style', 'color:#1a5fb4');
                frag.appendChild(a);
            } else if (part) frag.appendChild(document.createTextNode(part));
        });
        node.replaceWith(frag);
    }
    return box.innerHTML;
}

function openEmail(slug) {
    const e = emails.find(x => x.slug === slug);
    if (!e) return;
    openEmailSlug = slug;
    const reader = root.querySelector('#email-reader');
    reader.innerHTML = card({
        title: esc(e.subject),
        actions: '<button class="btn sm" data-action="copy-subject">Copy subject</button> <button class="btn sm primary" data-action="copy-email">Copy for Gmail</button> <button class="btn sm ghost" data-action="close-email">Close</button>',
        body: `<p class="muted" style="margin-top:0">Copy the subject into Gmail's subject line, then Copy for Gmail and paste into the message body.</p>
            <div class="email-preview" id="pod-email-preview">${gmailHtml(e.markdown)}</div>`
    });
    reader.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function copySubject(button) {
    const e = emails.find(x => x.slug === openEmailSlug);
    if (!e) return;
    try { await navigator.clipboard.writeText(e.subject); toast('Subject copied', 'success'); } catch (error) { toast(`Copy failed: ${error.message}`, 'error'); }
}

async function copyEmail(button) {
    const e = emails.find(x => x.slug === openEmailSlug);
    const preview = root.querySelector('#pod-email-preview');
    if (!e || !preview) return;
    await busy(button, 'Copying…', async () => {
        try {
            if (!(navigator.clipboard && window.ClipboardItem)) throw new Error('no ClipboardItem');
            await navigator.clipboard.write([new ClipboardItem({
                'text/html': new Blob([preview.innerHTML], { type: 'text/html' }),
                'text/plain': new Blob([e.markdown.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1')], { type: 'text/plain' })
            })]);
            toast('Copied - paste into the Gmail message', 'success');
        } catch (_) {
            const range = document.createRange();
            range.selectNodeContents(preview);
            const sel2 = window.getSelection();
            sel2.removeAllRanges();
            sel2.addRange(range);
            const ok = document.execCommand('copy');
            sel2.removeAllRanges();
            toast(ok ? 'Copied - paste into the Gmail message' : 'Copy failed - select the preview and copy it', ok ? 'success' : 'error');
        }
    });
}
