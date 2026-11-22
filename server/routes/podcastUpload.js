'use strict';

/**
 * peninsulafootball.com/podcast_upload - post an episode of The PFL Cast.
 *
 * Its own password (PODCAST_UPLOAD_PASSWORD_HASH in .env, bcrypt), separate
 * from the admin login: signing in sets req.session.podcastUploader, which
 * grants nothing else. The page (public/js/podcast-upload.js) asks for the
 * week, a title and a description, uploads the audio in chunks under nginx's
 * 1 MB request limit, then publishes it to /podcast.
 *
 * The JSON endpoints require the X-PFL-Upload header: a cross-site form
 * cannot set it, and a cross-site fetch with it is blocked by CORS preflight.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const store = require('../utils/podcastStore');
const { logInfo } = require('../utils/errorHandler');

const router = express.Router();
const VALIDATION_FILE = path.join(__dirname, '../../logs/weekly-validation-latest.json');

function env(req) {
    const e = (req.app && req.app.locals && req.app.locals.podcastEnv) || {};
    return {
        root: e.root || store.DEFAULT_ROOT,
        passwordHash: e.uploadPasswordHash !== undefined ? e.uploadPasswordHash : process.env.PODCAST_UPLOAD_PASSWORD_HASH,
        validationFile: e.validationFile || VALIDATION_FILE
    };
}

function esc(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const STYLE = `
  :root { --bg: #f6f4ef; --card: #fff; --text: #1d1d1b; --muted: #6b6a66; --accent: #1f5f3f; --line: #d9d5cb; --err: #a3261b; }
  @media (prefers-color-scheme: dark) { :root { --bg: #141513; --card: #1d1f1c; --text: #ecebe6; --muted: #a3a29b; --accent: #7fc79e; --line: #3a3c37; --err: #f08b80; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .wrap { max-width: 640px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { margin: 0 0 4px; font-size: 28px; }
  .sub { color: var(--muted); margin: 0 0 24px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-bottom: 20px; }
  label { display: block; font-weight: 600; margin: 14px 0 4px; }
  label:first-child { margin-top: 0; }
  .hint { color: var(--muted); font-size: 14px; font-weight: 400; }
  input[type=text], input[type=password], select, textarea { width: 100%; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--text); font: inherit; }
  textarea { min-height: 130px; resize: vertical; }
  button { margin-top: 18px; padding: 10px 18px; border: 0; border-radius: 8px; background: var(--accent); color: var(--card); font: inherit; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  button.link { background: none; color: var(--accent); padding: 0; margin: 0; font-weight: 400; }
  .err { color: var(--err); }
  .msg { margin-top: 12px; }
  .ep { border-top: 1px solid var(--line); padding: 12px 0; display: flex; gap: 12px; justify-content: space-between; align-items: flex-start; }
  .ep:first-of-type { border-top: 0; }
  .muted { color: var(--muted); font-size: 14px; }
  a { color: var(--accent); }
`;

function page(body, { script = false } = {}) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Upload · The PFL Cast</title><style>${STYLE}</style></head>
<body><div class="wrap">${body}</div>${script ? '<script type="module" src="/js/podcast-upload.js"></script>' : ''}</body></html>`;
}

function loginPage(error) {
    return page(`
        <h1>The PFL Cast</h1>
        <p class="sub">Episode uploader</p>
        <form class="card" method="post" action="/podcast_upload/login">
            <label for="pw">Password</label>
            <input type="password" id="pw" name="password" autocomplete="current-password" autofocus required>
            ${error ? `<p class="err msg">${esc(error)}</p>` : ''}
            <button type="submit">Sign in</button>
        </form>`);
}

function uploaderPage() {
    return page(`
        <h1>Post an episode</h1>
        <p class="sub">The PFL Cast · it goes live on <a href="/podcast" target="_blank" rel="noopener">peninsulafootball.com/podcast</a></p>
        <form class="card" id="upload-form">
            <label for="week">Week</label>
            <select id="week"></select>
            <label for="title">Title</label>
            <input type="text" id="title" maxlength="160" required>
            <label for="desc">Description <span class="hint">- what is in this episode? Shown on the podcast page.</span></label>
            <textarea id="desc" maxlength="4000" required></textarea>
            <label for="file">Audio file <span class="hint">- MP3 recommended (M4A, WAV, OGG also work)</span></label>
            <input type="file" id="file" accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.opus">
            <p class="muted" id="replace-note"></p>
            <button type="submit" id="submit">Post episode</button>
            <p class="msg" id="msg" aria-live="polite"></p>
        </form>
        <div class="card"><strong>Posted episodes</strong><div id="episodes"><p class="muted">Loading…</p></div></div>
        <form method="post" action="/podcast_upload/logout"><button type="submit" class="link">Sign out</button></form>`, { script: true });
}

const signedIn = req => !!(req.session && req.session.podcastUploader);

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
    handler: (req, res) => res.status(429).type('html').send(loginPage('Too many attempts - try again in 15 minutes.')) });

router.get('/', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!env(req).passwordHash) return res.status(503).type('html').send(loginPage('The uploader is not set up (no password configured).'));
    res.type('html').send(signedIn(req) ? uploaderPage() : loginPage());
});

router.post('/login', loginLimiter, express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
    const hash = env(req).passwordHash;
    const pw = req.body && typeof req.body.password === 'string' ? req.body.password : '';
    const ok = !!hash && pw.length > 0 && pw.length < 200 && await bcrypt.compare(pw, hash).catch(() => false);
    if (!ok) {
        logInfo(`Podcast uploader: failed sign-in from ${req.ip}`);
        return res.status(401).type('html').send(loginPage('Wrong password.'));
    }
    req.session.regenerate(err => {
        if (err) return res.status(500).type('html').send(loginPage('Could not start a session - try again.'));
        req.session.podcastUploader = true;
        req.session.save(() => res.redirect(303, '/podcast_upload'));
    });
});

router.post('/logout', (req, res) => {
    if (req.session) delete req.session.podcastUploader;
    res.redirect(303, '/podcast_upload');
});

// ---- JSON API for the page ----
const api = express.Router();
api.use((req, res, next) => {
    if (!signedIn(req)) return res.status(401).json({ success: false, message: 'Signed out - reload the page and sign in again' });
    if (req.get('X-PFL-Upload') !== '1') return res.status(403).json({ success: false, message: 'Missing upload header' });
    next();
});

function weekParams(req) {
    const season = Number(req.params.season);
    const week = Number(req.params.week);
    if (!Number.isInteger(season) || season < 2024 || season > 2100 || !Number.isInteger(week) || week < 1 || week > 18) {
        const e = new Error('Invalid season or week');
        e.status = 400;
        throw e;
    }
    return { season, week };
}

const wrap = fn => (req, res) => {
    try { fn(req, res); } catch (error) { res.status(error.status || 400).json({ success: false, message: error.message }); }
};

/** Season/week choices, the default week, title suggestions from the outlines, and what is posted. */
api.get('/state', wrap((req, res) => {
    const e = env(req);
    let validation = null;
    try { validation = JSON.parse(fs.readFileSync(e.validationFile, 'utf8')); } catch (_) { /* none */ }
    const season = validation && validation.season ? Number(validation.season) : new Date().getFullYear();
    const defaultWeek = validation && validation.week ? Number(validation.week) : 1;
    const suggestions = {};
    for (const w of store.listEpisodeWeeks(e.root)) {
        const doc = store.readEpisode(w.season, w.week, e.root);
        const o = doc && doc.outlines && (doc.outlines.find(x => x.id === doc.chosen) || doc.outlines.find(x => x.id === doc.favorite));
        const h = o && /^#\s+(.+)$/m.exec(o.markdown || '');
        if (h) suggestions[`${w.season}-${w.week}`] = h[1].replace(/^The PFL Cast\s*[—-]\s*/, '').trim();
    }
    res.json({ success: true, data: { season, defaultWeek, maxWeek: 18, suggestions, published: store.readPublished(e.root), maxBytes: store.MAX_AUDIO_BYTES } });
}));

api.post('/uploads', wrap((req, res) => {
    res.json({ success: true, data: { uploadId: store.startUpload(env(req).root) } });
}));

api.put('/uploads/:id', express.raw({ type: 'application/octet-stream', limit: '2mb' }), wrap((req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new Error('Empty chunk');
    res.json({ success: true, data: { received: store.appendChunk(req.params.id, req.query.offset, req.body, env(req).root) } });
}));

api.post('/episodes/:season/:week', express.json({ limit: '64kb' }), wrap((req, res) => {
    const { season, week } = weekParams(req);
    const b = req.body || {};
    const entry = store.publishEpisode({ season, week, title: b.title, description: b.description, uploadId: b.uploadId, filename: b.filename }, env(req).root);
    logInfo(`Podcast published via uploader: ${season} week ${week} "${entry.title}" (${entry.file}, ${entry.bytes} bytes)`);
    res.json({ success: true, data: { episode: entry } });
}));

api.put('/episodes/:season/:week', express.json({ limit: '64kb' }), wrap((req, res) => {
    const { season, week } = weekParams(req);
    const entry = store.updateEpisodeText({ season, week, title: req.body && req.body.title, description: req.body && req.body.description }, env(req).root);
    logInfo(`Podcast episode text edited via uploader: ${season} week ${week}`);
    res.json({ success: true, data: { episode: entry } });
}));

api.delete('/episodes/:season/:week', wrap((req, res) => {
    const { season, week } = weekParams(req);
    const removed = store.unpublishEpisode(season, week, env(req).root);
    if (!removed) throw Object.assign(new Error('No episode posted for that week'), { status: 404 });
    logInfo(`Podcast removed via uploader: ${season} week ${week} (${removed.file})`);
    res.json({ success: true, data: { removed } });
}));

router.use('/api', api);

module.exports = router;
