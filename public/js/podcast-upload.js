// peninsulafootball.com/podcast_upload - post an episode of The PFL Cast.
// Uploads the audio in chunks (nginx allows 1 MB per request), then publishes
// it with the week, title and description. Server: server/routes/podcastUpload.js.

const CHUNK = 768 * 1024;
const H = { 'X-PFL-Upload': '1', Accept: 'application/json' };
const $ = id => document.getElementById(id);

let state = null;
let busy = false;

function esc(v) {
    return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function size(bytes) {
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

async function call(method, url, body, headers = {}) {
    const r = await fetch(`/podcast_upload/api${url}`, { method, credentials: 'same-origin', headers: { ...H, ...headers }, body });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.message || `${r.status} ${r.statusText}`);
    return data.data;
}
const json = (method, url, obj) => call(method, url, JSON.stringify(obj), { 'Content-Type': 'application/json' });

function msg(text, isError = false) {
    const el = $('msg');
    el.className = `msg${isError ? ' err' : ''}`;
    el.innerHTML = text;
}

function selected() {
    const [season, week] = $('week').value.split('-').map(Number);
    return { season, week, posted: state.published.find(e => e.season === season && e.week === week) || null };
}

function fillForWeek() {
    const { season, week, posted } = selected();
    $('title').value = posted ? posted.title : (state.suggestions[`${season}-${week}`] || `Week ${week}`);
    $('desc').value = posted ? posted.description : '';
    const lineup = posted && posted.cast ? posted.cast : (state.lineups[`${season}-${week}`] || { hosts: [], guests: [] });
    $('hosts').value = lineup.hosts.join(', ');
    $('guests').value = lineup.guests.join(', ');
    $('replace-note').textContent = posted ? `Week ${week} is already posted (${size(posted.bytes)}). Leave the file empty to just update the title and description, or choose a file to replace the audio.` : '';
    $('submit').textContent = posted ? 'Save changes' : 'Post episode';
    $('cover').value = '';
    $('remove-cover').checked = false;
    $('remove-cover-wrap').hidden = !(posted && posted.cover);
    setThumb($('cover-preview'), episodeCoverFallback(), state.showCover ? 'Show cover' : 'Week tile');
}

function renderEpisodes() {
    const list = state.published;
    $('episodes').innerHTML = list.length ? list.map(e => `
        <div class="ep">
            <div><strong><a href="/podcast/${e.season}/week${e.week}" target="_blank" rel="noopener">${esc(e.title)}</a></strong>${e.cover ? ' <span class="muted">· own cover</span>' : ''}<div class="muted">${e.season} week ${e.week} · ${size(e.bytes)} · ${new Date(e.publishedAt).toLocaleString()}</div></div>
            <button class="link" data-remove="${e.season}-${e.week}">Remove</button>
        </div>`).join('') : '<p class="muted">Nothing posted yet.</p>';
}

async function load(keepWeek) {
    state = await call('GET', '/state');
    const weeks = [];
    for (let w = state.maxWeek; w >= 1; w--) weeks.push(w);
    const current = keepWeek || `${state.season}-${state.defaultWeek}`;
    $('week').innerHTML = weeks.map(w => {
        const v = `${state.season}-${w}`;
        const posted = state.published.some(e => e.season === state.season && e.week === w);
        return `<option value="${v}" ${v === current ? 'selected' : ''}>${state.season} week ${w}${posted ? ' (posted)' : ''}</option>`;
    }).join('');
    renderShowCover();
    fillForWeek();
    renderEpisodes();
}

async function putChunk(id, offset, blob) {
    for (let attempt = 1; ; attempt++) {
        try {
            return (await call('PUT', `/uploads/${id}?offset=${offset}`, blob, { 'Content-Type': 'application/octet-stream' })).received;
        } catch (error) {
            if (attempt >= 3 || /Signed out/.test(error.message)) throw error;
            await new Promise(r => setTimeout(r, 1000 * attempt));
        }
    }
}

/** Upload any file in chunks; returns the upload id. */
async function uploadFile(file, onProgress) {
    const { uploadId } = await call('POST', '/uploads');
    let offset = 0;
    while (offset < file.size) {
        offset = await putChunk(uploadId, offset, file.slice(offset, Math.min(offset + CHUNK, file.size)));
        if (onProgress) onProgress(offset, file.size);
    }
    return uploadId;
}

function setThumb(el, src, emptyText) {
    el.style.backgroundImage = src ? `url("${src}")` : '';
    el.classList.toggle('has-img', !!src);
    el.innerHTML = `<span>${esc(emptyText)}</span>`;
}

const coverSrc = file => (file ? `/podcast/cover/${encodeURIComponent(file)}` : null);

function previewFile(input, thumb, fallbackSrc, emptyText) {
    const f = input.files[0];
    if (!f) { setThumb(thumb, fallbackSrc, emptyText); return; }
    // data: URL, not blob: - the site's CSP allows img data: but not blob:
    const reader = new FileReader();
    reader.onload = () => setThumb(thumb, reader.result, emptyText);
    reader.readAsDataURL(f);
}

function renderShowCover() {
    setThumb($('show-cover-preview'), coverSrc(state.showCover), 'No cover yet');
    $('show-cover-remove').hidden = !state.showCover;
}

async function saveShowCover(event) {
    event.preventDefault();
    const file = $('show-cover-file').files[0];
    const out = $('show-cover-msg');
    if (!file) { out.className = 'msg err'; out.textContent = 'Choose an image first.'; return; }
    if (file.size > state.maxImageBytes) { out.className = 'msg err'; out.textContent = `That image is ${size(file.size)}; the limit is ${size(state.maxImageBytes)}.`; return; }
    $('show-cover-save').disabled = true;
    try {
        out.className = 'msg'; out.textContent = 'Uploading…';
        const uploadId = await uploadFile(file, (n, t) => { out.textContent = `Uploading… ${Math.floor((n / t) * 100)}%`; });
        await json('POST', '/show-cover', { uploadId, filename: file.name });
        $('show-cover-file').value = '';
        await load($('week').value);
        out.innerHTML = 'Show cover saved. See it on <a href="/podcast" target="_blank" rel="noopener">the podcast page</a>.';
    } catch (error) {
        out.className = 'msg err'; out.textContent = error.message;
    } finally {
        $('show-cover-save').disabled = false;
    }
}

async function removeShowCover() {
    if (!window.confirm('Remove the show cover?')) return;
    try {
        await call('DELETE', '/show-cover');
        await load($('week').value);
        $('show-cover-msg').textContent = 'Show cover removed.';
    } catch (error) {
        $('show-cover-msg').className = 'msg err'; $('show-cover-msg').textContent = error.message;
    }
}

function episodeCoverFallback() {
    const { posted } = selected();
    return coverSrc((posted && posted.cover) || state.showCover);
}

async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const { season, week, posted } = selected();
    const title = $('title').value.trim();
    const description = $('desc').value.trim();
    const file = $('file').files[0];
    const coverFile = $('cover').files[0];
    const removeCover = $('remove-cover').checked && !coverFile;
    if (coverFile && coverFile.size > state.maxImageBytes) return msg(`That cover image is ${size(coverFile.size)}; the limit is ${size(state.maxImageBytes)}.`, true);
    if (title.length < 3) return msg('Give the episode a title.', true);
    if (description.length < 10) { $('desc').focus(); return msg('Write a description first. It goes on the podcast page.', true); }
    if (!file && !posted) return msg('Choose the audio file.', true);
    if (file && file.size > state.maxBytes) return msg(`That file is ${size(file.size)}; the limit is ${size(state.maxBytes)}.`, true);
    busy = true;
    $('submit').disabled = true;
    try {
        let coverUploadId = null;
        if (coverFile) {
            msg('Uploading cover…');
            coverUploadId = await uploadFile(coverFile);
        }
        const coverFields = { coverUploadId, coverFilename: coverFile ? coverFile.name : null, removeCover, hosts: $('hosts').value, guests: $('guests').value };
        if (!file) {
            await json('PUT', `/episodes/${season}/${week}`, { title, description, ...coverFields });
        } else {
            const uploadId = await uploadFile(file, (n, t) => msg(`Uploading audio… ${Math.floor((n / t) * 100)}% (${size(n)} of ${size(t)})`));
            msg('Publishing…');
            await json('POST', `/episodes/${season}/${week}`, { uploadId, filename: file.name, title, description, ...coverFields });
        }
        $('file').value = '';
        $('cover').value = '';
        await load(`${season}-${week}`);
        msg(`Done. It is live at <a href="/podcast/${season}/week${week}" target="_blank" rel="noopener">peninsulafootball.com/podcast/${season}/week${week}</a>.`);
    } catch (error) {
        msg(esc(error.message), true);
    } finally {
        busy = false;
        $('submit').disabled = false;
    }
}

async function remove(button) {
    const [season, week] = button.dataset.remove.split('-').map(Number);
    if (!window.confirm(`Take down ${season} week ${week}? The audio file is deleted.`)) return;
    try {
        await call('DELETE', `/episodes/${season}/${week}`);
        await load($('week').value);
        msg(`Removed ${season} week ${week}.`);
    } catch (error) {
        msg(esc(error.message), true);
    }
}

$('upload-form').addEventListener('submit', submit);
$('show-cover-form').addEventListener('submit', saveShowCover);
$('show-cover-remove').addEventListener('click', removeShowCover);
$('show-cover-file').addEventListener('change', () => previewFile($('show-cover-file'), $('show-cover-preview'), coverSrc(state && state.showCover), 'No cover yet'));
$('cover').addEventListener('change', () => { if ($('cover').files[0]) $('remove-cover').checked = false; previewFile($('cover'), $('cover-preview'), episodeCoverFallback(), 'Show cover'); });
$('remove-cover').addEventListener('change', () => setThumb($('cover-preview'), $('remove-cover').checked ? coverSrc(state.showCover) : episodeCoverFallback(), state.showCover ? 'Show cover' : 'Week tile'));
$('week').addEventListener('change', () => { msg(''); fillForWeek(); });
$('episodes').addEventListener('click', e => { const b = e.target.closest('[data-remove]'); if (b) remove(b); });
load().catch(error => msg(esc(error.message), true));
