'use strict';

/**
 * peninsulafootball.com/podcast - The PFL Cast, public. Lists the episodes
 * posted from /podcast_upload (podcast/published.json), newest first, each
 * with its description and an audio player. Audio is served from
 * /podcast/audio/<file> (only files listed in published.json; Range requests
 * work through res.sendFile so players can seek).
 */

const express = require('express');
const store = require('../utils/podcastStore');

const router = express.Router();

function rootOf(req) {
    const env = req.app && req.app.locals && req.app.locals.podcastEnv;
    return (env && env.root) || store.DEFAULT_ROOT;
}

function esc(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function paragraphs(text) {
    return String(text || '').split(/\n{2,}/).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n');
}

function fmtDate(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
}

function fmtSize(bytes) {
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function renderPage(episodes) {
    const latest = episodes[0];
    const items = episodes.map((e, i) => `
        <article class="ep" id="${e.season}-week${e.week}">
            <div class="kicker">${i === 0 ? '<span class="new">Latest</span>' : ''}${esc(e.season)} · Week ${esc(e.week)}${e.publishedAt ? ` · ${esc(fmtDate(e.publishedAt))}` : ''}</div>
            <h2>${esc(e.title)}</h2>
            <div class="player" data-title="${esc(e.title)}" data-file="${esc(e.file)}"><audio controls preload="${i === 0 ? 'metadata' : 'none'}" src="/podcast/audio/${esc(e.file)}"></audio></div>
            <div class="desc">${paragraphs(e.description)}</div>
            <a class="dl" href="/podcast/audio/${esc(e.file)}" download>Download (${esc(fmtSize(e.bytes || 0))})</a>
        </article>`).join('\n');
    const description = latest ? `${latest.title} - the weekly podcast of the Peninsula Football League.` : 'The weekly podcast of the Peninsula Football League.';
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The PFL Cast</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="The PFL Cast">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<style>
  :root { --bg: #f6f4ef; --card: #ffffff; --text: #1d1d1b; --muted: #6b6a66; --accent: #1f5f3f; --line: #e3e0d8; }
  @media (prefers-color-scheme: dark) { :root { --bg: #141513; --card: #1d1f1c; --text: #ecebe6; --muted: #a3a29b; --accent: #7fc79e; --line: #2e302c; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 17px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 40px 16px 64px; }
  header { margin-bottom: 32px; }
  header .league { color: var(--muted); font-size: 14px; letter-spacing: .08em; text-transform: uppercase; }
  header h1 { margin: 4px 0 8px; font-size: 40px; line-height: 1.1; }
  header p { margin: 0; color: var(--muted); }
  .ep { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-bottom: 20px; }
  .kicker { color: var(--muted); font-size: 14px; }
  .new { display: inline-block; background: var(--accent); color: var(--card); border-radius: 999px; padding: 0 10px; margin-right: 8px; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
  .ep h2 { margin: 4px 0 14px; font-size: 22px; line-height: 1.3; }
  audio { width: 100%; margin-bottom: 8px; }
  .player { margin: 4px 0 10px; }
  .pl { display: flex; align-items: center; gap: 14px; background: var(--bg); border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; }
  .pl button { border: 0; background: none; color: var(--text); cursor: pointer; padding: 4px; border-radius: 8px; line-height: 0; font: inherit; }
  .pl button:focus-visible, .pl-seek:focus-visible + * { outline: 2px solid var(--accent); outline-offset: 2px; }
  .pl .pl-play { flex: none; width: 52px; height: 52px; border-radius: 50%; background: var(--accent); color: var(--card); display: grid; place-items: center; box-shadow: 0 2px 8px rgba(0,0,0,.15); transition: transform .12s ease; }
  .pl .pl-play:hover { transform: scale(1.05); }
  .pl .pl-play:active { transform: scale(.96); }
  .is-loading .pl-play { animation: plpulse 1s ease-in-out infinite; }
  @keyframes plpulse { 50% { opacity: .6; } }
  .pl-main { flex: 1; min-width: 0; }
  .pl-bar { position: relative; height: 22px; }
  .pl-track { position: absolute; left: 0; right: 0; top: 9px; height: 4px; border-radius: 2px; background: var(--line); }
  .pl-buf { position: absolute; inset: 0 auto 0 0; width: 0; border-radius: 2px; background: var(--muted); opacity: .35; }
  .pl-fill { position: absolute; inset: 0 auto 0 0; width: 0; border-radius: 2px; background: var(--accent); }
  .pl-knob { position: absolute; top: 50%; left: 0; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; background: var(--accent); box-shadow: 0 1px 4px rgba(0,0,0,.25); transform: scale(0); transition: transform .12s ease; }
  .pl-bar:hover .pl-knob, .is-playing .pl-knob { transform: scale(1); }
  .pl-seek { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
  .pl-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 2px; }
  .pl-time { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .pl-btns { display: flex; align-items: center; gap: 2px; }
  .pl .pl-speed { font-size: 13px; font-weight: 700; line-height: 1; padding: 6px 8px; border: 1px solid var(--line); min-width: 44px; }
  .pl button:hover { background: var(--line); }
  .pl .pl-play:hover { background: var(--accent); }
  .is-playing { }
  @media (max-width: 420px) { .pl { gap: 10px; padding: 10px; } .pl .pl-play { width: 46px; height: 46px; } }
  .desc p { margin: 10px 0; }
  .dl { color: var(--accent); font-size: 14px; }
  .empty { color: var(--muted); }
  footer { margin-top: 32px; font-size: 14px; color: var(--muted); }
  footer a { color: var(--accent); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="league">Peninsula Football League</div>
    <h1>The PFL Cast</h1>
    <p>The week in the PFL: the best stories, the awards, and next week's picks.</p>
  </header>
  ${items || '<p class="empty">The first episode is on its way.</p>'}
  <footer><a href="/statfink">Live scores</a> · <a href="/standings">Standings</a></footer>
</div>
<script type="module" src="/js/podcast-player.js"></script>
</body>
</html>`;
}

router.get('/', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(renderPage(store.readPublished(rootOf(req))));
});

router.get('/audio/:file', (req, res) => {
    const file = store.publishedAudioPath(req.params.file, rootOf(req));
    if (!file) return res.status(404).type('text').send('Not found');
    const ext = store.audioExt(req.params.file);
    res.set('Cache-Control', 'public, max-age=86400');
    return res.sendFile(file, { headers: { 'Content-Type': store.AUDIO_TYPES[ext] } }, err => {
        if (err && !res.headersSent) res.status(err.statusCode || 404).type('text').send('Not found');
    });
});

module.exports = router;
module.exports.renderPage = renderPage;
