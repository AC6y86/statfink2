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

function siteUrl() {
    return (process.env.PUBLIC_SITE_URL || 'https://peninsulafootball.com').replace(/\/+$/, '');
}

function episodePath(e) { return `/podcast/${e.season}/week${e.week}`; }

/** Square cover art (inline SVG): the wordmark and the week number. */
function coverUrl(file) { return `/podcast/cover/${encodeURIComponent(file)}`; }

function cover(e, big = false, showCover = null) {
    const eq = '<span class="eq"><i></i><i></i><i></i><i></i></span>';
    if (e.cover) return `<div class="cover${big ? ' cover-big' : ''}"><img src="${coverUrl(e.cover)}" alt="Cover art for ${esc(e.title)}" loading="lazy">${eq}</div>`;
    if (showCover) return `<div class="cover${big ? ' cover-big' : ''}"><img src="${coverUrl(showCover)}" alt="The PFL Cast cover art" loading="lazy"><span class="wk">WK ${esc(e.week)}</span>${eq}</div>`;
    const id = `g${e.season}${e.week}${big ? 'b' : ''}`;
    return `<div class="cover${big ? ' cover-big' : ''}" aria-hidden="true">
        <svg viewBox="0 0 120 120" role="presentation">
            <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1c4a33"/><stop offset="1" stop-color="#0b1a12"/></linearGradient></defs>
            <rect width="120" height="120" rx="14" fill="url(#${id})"/>
            ${[24, 48, 72, 96].map(x => `<line x1="${x}" y1="0" x2="${x}" y2="120" stroke="#ffffff" stroke-opacity=".07" stroke-width="2"/>`).join('')}
            <text x="12" y="26" fill="#f5c542" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="10" font-weight="800" textLength="96" lengthAdjust="spacingAndGlyphs">THE PFL CAST</text>
            <text x="10" y="96" fill="#ffffff" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="60" font-weight="900" letter-spacing="-3">${esc(e.week)}</text>
            <text x="12" y="110" fill="#ffffff" fill-opacity=".6" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="9" font-weight="700" letter-spacing="1.5">WEEK · ${esc(e.season)}</text>
        </svg>
        <span class="eq"><i></i><i></i><i></i><i></i></span>
    </div>`;
}

function episodeCard(e, num, featured, { single = false, showCover = null } = {}) {
    return `
        <article class="ep${featured ? ' ep-featured' : ''}" id="${e.season}-week${e.week}">
            ${cover(e, featured, showCover)}
            <div class="ep-body">
                <div class="kicker"><span class="num">EP ${String(num).padStart(2, '0')}</span>${featured && !single ? '<span class="new">New</span>' : ''}<span>Week ${esc(e.week)} · ${esc(e.season)}${e.publishedAt ? ` · ${esc(fmtDate(e.publishedAt))}` : ''}</span></div>
                ${single ? `<h1 class="ep-title">${esc(e.title)}</h1>` : `<h2><a class="ep-link" href="${episodePath(e)}">${esc(e.title)}</a></h2>`}
                <div class="desc">${paragraphs(e.description)}</div>
                <div class="player" data-title="${esc(e.title)}" data-file="${esc(e.file)}"><audio controls preload="${featured ? 'metadata' : 'none'}" src="/podcast/audio/${esc(e.file)}"></audio></div>
                <div class="actions">
                    <button class="share" type="button" data-share="${esc(siteUrl() + episodePath(e))}" data-share-title="${esc(e.title)}">↗ Share</button>
                    <a class="dl" href="/podcast/audio/${esc(e.file)}" download>↓ Download · ${esc(fmtSize(e.bytes || 0))}</a>
                </div>
            </div>
        </article>`;
}

const STYLE = `<style>
  :root {
    --bg: #f3f1ea; --card: #ffffff; --text: #15170f; --muted: #66685f; --line: #e2dfd4;
    --field: #0b1a12; --field2: #16382a; --gold: #f5c542; --gold-ink: #1a1405; --red: #e5484d;
    --accent: #1f6b45; --display: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0d100d; --card: #161a15; --text: #eceee6; --muted: #9da196; --line: #262b24; --accent: #7fd4a4; }
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 17px/1.6 var(--display); }
  a { color: var(--accent); }

  /* ---------- Hero ---------- */
  .hero { position: relative; overflow: hidden; color: #fff; background:
      radial-gradient(1200px 400px at 80% -10%, rgba(245,197,66,.22), transparent 60%),
      radial-gradient(800px 500px at -10% 110%, rgba(31,107,69,.55), transparent 60%),
      linear-gradient(160deg, var(--field2), var(--field) 65%); }
  .hero::before { content: ""; position: absolute; inset: 0; pointer-events: none;
      background: repeating-linear-gradient(90deg, rgba(255,255,255,.06) 0 2px, transparent 2px 10%);
      mask-image: linear-gradient(180deg, transparent, #000 30%, #000 70%, transparent); -webkit-mask-image: linear-gradient(180deg, transparent, #000 30%, #000 70%, transparent); }
  .hero::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 6px; background: repeating-linear-gradient(90deg, var(--gold) 0 40px, #fff 40px 44px); opacity: .9; }
  .hero-in { position: relative; max-width: 920px; margin: 0 auto; padding: 44px 16px 52px; }
  .onair { display: inline-flex; align-items: center; gap: 8px; padding: 5px 12px 5px 10px; border: 1px solid rgba(255,255,255,.25); border-radius: 999px; font-size: 12px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; background: rgba(0,0,0,.25); backdrop-filter: blur(4px); }
  .onair i { width: 8px; height: 8px; border-radius: 50%; background: var(--red); box-shadow: 0 0 0 0 rgba(229,72,77,.7); animation: ping 1.8s infinite; }
  @keyframes ping { 0% { box-shadow: 0 0 0 0 rgba(229,72,77,.7); } 70% { box-shadow: 0 0 0 10px rgba(229,72,77,0); } 100% { box-shadow: 0 0 0 0 rgba(229,72,77,0); } }
  .wordmark { margin: 18px 0 6px; font-weight: 900; line-height: .86; letter-spacing: -.045em; text-transform: uppercase; font-size: clamp(56px, 13vw, 128px); }
  .wordmark .the { display: block; font-size: .28em; letter-spacing: .32em; color: var(--gold); margin-bottom: .18em; font-weight: 800; }
  .wordmark .cast { color: transparent; -webkit-text-stroke: 2px #fff; }
  .tag { margin: 14px 0 0; max-width: 34em; color: rgba(255,255,255,.82); font-size: 18px; }
  .meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 22px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 999px; background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.14); font-size: 14px; font-weight: 600; }
  .chip b { color: var(--gold); font-weight: 800; }
  .listen { display: inline-flex; align-items: center; gap: 8px; margin-top: 26px; padding: 12px 20px; border-radius: 999px; background: var(--gold); color: var(--gold-ink); font-weight: 800; text-decoration: none; box-shadow: 0 6px 24px rgba(245,197,66,.3); transition: transform .15s ease; }
  .listen:hover { transform: translateY(-1px); }

  /* ---------- Episodes ---------- */
  .wrap { max-width: 920px; margin: 0 auto; padding: 0 16px 72px; }
  .section-label { margin: 40px 0 14px; font-size: 13px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; color: var(--muted); }
  .ep { display: grid; grid-template-columns: 120px 1fr; gap: 20px; background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 20px; margin-bottom: 16px; transition: box-shadow .2s ease, border-color .2s ease; }
  .ep:hover { box-shadow: 0 10px 30px rgba(0,0,0,.07); }
  .ep.is-playing { border-color: var(--gold); box-shadow: 0 0 0 3px rgba(245,197,66,.25), 0 10px 30px rgba(0,0,0,.08); }
  .ep-featured { margin-top: -36px; position: relative; grid-template-columns: 200px 1fr; padding: 24px; box-shadow: 0 18px 50px rgba(0,0,0,.18); }
  .cover { position: relative; width: 100%; aspect-ratio: 1; border-radius: 14px; overflow: hidden; box-shadow: 0 6px 18px rgba(0,0,0,.25); align-self: start; }
  .cover svg { display: block; width: 100%; height: 100%; }
  .eq { position: absolute; right: 10px; bottom: 10px; display: flex; gap: 3px; align-items: flex-end; height: 18px; opacity: 0; transition: opacity .2s; }
  .eq i { width: 4px; height: 30%; background: var(--gold); border-radius: 2px; }
  .is-playing .eq { opacity: 1; }
  .is-playing .eq i { animation: eq .9s ease-in-out infinite; }
  .is-playing .eq i:nth-child(2) { animation-delay: -.3s; } .is-playing .eq i:nth-child(3) { animation-delay: -.6s; } .is-playing .eq i:nth-child(4) { animation-delay: -.15s; }
  @keyframes eq { 0%, 100% { height: 25%; } 50% { height: 100%; } }
  .ep-body { min-width: 0; }
  .kicker { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; font-weight: 600; }
  .num { font-weight: 900; letter-spacing: .08em; color: var(--text); }
  .new { background: var(--gold); color: var(--gold-ink); border-radius: 999px; padding: 1px 9px; font-size: 11px; font-weight: 900; letter-spacing: .1em; text-transform: uppercase; }
  .ep h2 { margin: 6px 0 4px; font-size: 22px; line-height: 1.25; letter-spacing: -.01em; }
  .ep-featured h2 { font-size: clamp(24px, 3.4vw, 32px); }
  .desc { color: var(--text); opacity: .88; }
  .desc p { margin: 8px 0; }
  .dl { display: inline-block; margin-top: 6px; font-size: 14px; font-weight: 600; text-decoration: none; }
  .dl:hover { text-decoration: underline; }
  audio { width: 100%; }
  .empty { margin-top: -36px; position: relative; background: var(--card); border: 1px dashed var(--line); border-radius: 18px; padding: 36px 24px; text-align: center; color: var(--muted); }
  .empty strong { display: block; color: var(--text); font-size: 20px; margin-bottom: 4px; }

  /* ---------- Player ---------- */
  .player { margin: 14px 0 4px; }
  .pl { display: flex; align-items: center; gap: 14px; background: var(--bg); border: 1px solid var(--line); border-radius: 999px; padding: 8px 18px 8px 8px; }
  .pl button { border: 0; background: none; color: var(--text); cursor: pointer; padding: 4px; border-radius: 8px; line-height: 0; font: inherit; }
  .pl button:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
  .pl .pl-play { flex: none; width: 52px; height: 52px; border-radius: 50%; background: var(--field); color: var(--gold); display: grid; place-items: center; box-shadow: 0 4px 14px rgba(0,0,0,.25); transition: transform .12s ease; }
  .is-playing .pl .pl-play { background: var(--gold); color: var(--gold-ink); }
  .pl .pl-play:hover { transform: scale(1.06); }
  .pl .pl-play:active { transform: scale(.95); }
  .is-loading .pl-play { animation: plpulse 1s ease-in-out infinite; }
  @keyframes plpulse { 50% { opacity: .55; } }
  .pl-main { flex: 1; min-width: 0; }
  .pl-bar { position: relative; height: 22px; }
  .pl-track { position: absolute; left: 0; right: 0; top: 9px; height: 5px; border-radius: 3px; background: var(--line); }
  .pl-buf { position: absolute; inset: 0 auto 0 0; width: 0; border-radius: 3px; background: var(--muted); opacity: .3; }
  .pl-fill { position: absolute; inset: 0 auto 0 0; width: 0; border-radius: 3px; background: linear-gradient(90deg, var(--accent), var(--gold)); }
  .pl-knob { position: absolute; top: 50%; left: 0; width: 15px; height: 15px; margin: -7.5px 0 0 -7.5px; border-radius: 50%; background: #fff; border: 3px solid var(--gold); box-shadow: 0 1px 6px rgba(0,0,0,.3); transform: scale(0); transition: transform .12s ease; }
  .pl-bar:hover .pl-knob, .is-playing .pl-knob { transform: scale(1); }
  .pl-seek { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
  .pl-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .pl-time { white-space: nowrap; font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; font-weight: 600; }
  .pl-btns { display: flex; align-items: center; gap: 2px; }
  .pl button:hover { background: var(--line); }
  .pl .pl-play:hover { background: var(--field); }
  .is-playing .pl .pl-play:hover { background: var(--gold); }
  .pl .pl-speed { font-size: 12px; font-weight: 800; line-height: 1; padding: 6px 8px; border: 1px solid var(--line); border-radius: 999px; min-width: 46px; }


  .ep-link { color: inherit; text-decoration: none; }
  .ep-link:hover { text-decoration: underline; text-decoration-color: var(--gold); text-underline-offset: 4px; }
  .ep-title { margin: 6px 0 4px; font-size: clamp(26px, 4vw, 38px); line-height: 1.15; letter-spacing: -.02em; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin-top: 8px; }
  .share { border: 1px solid var(--line); background: var(--card); color: var(--text); border-radius: 999px; padding: 6px 14px; font: inherit; font-size: 14px; font-weight: 700; cursor: pointer; }
  .share:hover { border-color: var(--gold); }
  .share.copied { background: var(--gold); color: var(--gold-ink); border-color: var(--gold); }
  .actions .dl { margin-top: 0; }
  .hero-compact .hero-in { padding: 26px 16px 56px; }
  .back { color: rgba(255,255,255,.8); text-decoration: none; font-weight: 700; font-size: 14px; }
  .back:hover { color: #fff; }
  .wordmark-sm { font-size: clamp(40px, 8vw, 64px); margin-top: 14px; }
  .epnav { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 8px 0 0; }
  .epnav a { display: block; padding: 14px 16px; border: 1px solid var(--line); border-radius: 14px; background: var(--card); color: var(--text); text-decoration: none; font-weight: 700; line-height: 1.3; }
  .epnav a:hover { border-color: var(--gold); }
  .epnav small { display: block; color: var(--muted); font-size: 12px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; margin-bottom: 4px; }
  .epnav .next { text-align: right; }

  .cover img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .wk { position: absolute; left: 8px; bottom: 8px; padding: 2px 8px; border-radius: 999px; background: rgba(11,26,18,.85); color: var(--gold); font-size: 12px; font-weight: 900; letter-spacing: .06em; }
  .ep:not(.ep-featured) .wk { font-size: 10px; padding: 1px 6px; left: 6px; bottom: 6px; }
  .hero-in.has-art { display: grid; grid-template-columns: 1fr minmax(0, 300px); gap: 40px; align-items: center; }
  .hero-in.has-art .hero-text { order: 1; }
  .hero-in.has-art .wordmark { font-size: clamp(52px, 8.4vw, 100px); }
  .hero-art { order: 2; width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 22px; box-shadow: 0 24px 60px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.12); transform: rotate(2deg); }
  @media (max-width: 760px) {
    .hero-in.has-art { grid-template-columns: 1fr; gap: 20px; }
    .hero-art { order: 0; width: 140px; transform: none; border-radius: 16px; }
  }
  footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 14px; color: var(--muted); }
  footer a { font-weight: 600; text-decoration: none; }

  @media (max-width: 640px) {
    .hero-in { padding: 32px 16px 48px; }
    .ep, .ep-featured { grid-template-columns: 1fr; gap: 12px; padding: 16px; }
    .ep .cover { width: 72px; }
    .ep-featured .cover { width: 112px; }
    .pl { gap: 10px; padding-right: 12px; }
    .pl .pl-play { width: 46px; height: 46px; }
  }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
</style>`;

function shell({ title, description, url, audio, body, image = null }) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#0b1a12">
<link rel="canonical" href="${esc(url)}">
<meta property="og:site_name" content="The PFL Cast">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:type" content="${audio ? 'music.song' : 'website'}">
${audio ? `<meta property="og:audio" content="${esc(audio.url)}">\n<meta property="og:audio:type" content="${esc(audio.mime)}">` : ''}
${image ? `<meta property="og:image" content="${esc(siteUrl() + coverUrl(image))}">\n<meta name="twitter:image" content="${esc(siteUrl() + coverUrl(image))}">\n<link rel="icon" href="${esc(coverUrl(image))}">\n<link rel="apple-touch-icon" href="${esc(coverUrl(image))}">` : ''}
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
${STYLE}
</head>
<body>
${body}
<script type="module" src="/js/podcast-player.js"></script>
</body>
</html>`;
}

function hostChips(hosts, total) {
    const hostNames = hosts.filter(h => h.role === 'host').map(h => h.name);
    const guests = hosts.filter(h => h.role === 'guest').map(h => h.name);
    return `<div class="meta">
      ${hostNames.length ? `<span class="chip">🎙 <b>Hosts</b> ${esc(hostNames.join(' & '))}</span>` : ''}
      ${guests.length ? `<span class="chip"><b>Guest</b> ${esc(guests.join(', '))}</span>` : ''}
      ${total != null ? `<span class="chip"><b>${total}</b> episode${total === 1 ? '' : 's'}</span>` : ''}
    </div>`;
}

const FOOTER = '<footer><span>The PFL Cast · Peninsula Football League</span><a href="/podcast">All episodes</a><a href="/statfink">Live scores</a><a href="/standings">Standings</a></footer>';

function plainText(text, max = 200) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Episode number = position in publish order (oldest is 1). */
function numberOf(episodes, e) { return episodes.length - episodes.indexOf(e); }

function renderPage(episodes, hosts = [], showCover = null) {
    const latest = episodes[0];
    const total = episodes.length;
    const featured = latest ? episodeCard(latest, total, true, { showCover }) : '';
    const rest = episodes.slice(1).map(e => episodeCard(e, numberOf(episodes, e), false, { showCover })).join('\n');
    const description = latest ? `New episode: ${latest.title}. The weekly podcast of the Peninsula Football League.` : 'The weekly podcast of the Peninsula Football League.';
    return shell({ title: 'The PFL Cast', description, url: `${siteUrl()}/podcast`, image: showCover, body: `
<header class="hero">
  <div class="hero-in${showCover ? ' has-art' : ''}">
    ${showCover ? `<img class="hero-art" src="${coverUrl(showCover)}" alt="The PFL Cast cover art">` : ''}
    <div class="hero-text">
    <span class="onair"><i></i>${latest ? 'New every week' : 'Coming soon'}</span>
    <h1 class="wordmark"><span class="the">The</span>PFL <span class="cast">Cast</span></h1>
    <p class="tag">The Peninsula Football League, out loud. The week's best stories, the awards nobody asked for, and picks we'll regret.</p>
    ${hostChips(hosts, total)}
    ${latest ? `<a class="listen" href="#${latest.season}-week${latest.week}">▶ Listen to the latest</a>` : ''}
    </div>
  </div>
</header>
<main class="wrap">
  ${featured || '<div class="empty"><strong>Episode 1 is in the studio.</strong>Check back soon.</div>'}
  ${rest ? `<div class="section-label">Earlier episodes</div>\n${rest}` : ''}
  ${FOOTER}
</main>` });
}

/** One episode's own page (/podcast/2026/week10): shareable, with link-preview tags. */
function renderEpisodePage(episodes, e, hosts = [], showCover = null) {
    const num = numberOf(episodes, e);
    const newer = episodes[episodes.indexOf(e) - 1];
    const older = episodes[episodes.indexOf(e) + 1];
    const nav = (newer || older) ? `<nav class="epnav">
        ${older ? `<a href="${episodePath(older)}"><small>← Previous</small>${esc(older.title)}</a>` : '<span></span>'}
        ${newer ? `<a class="next" href="${episodePath(newer)}"><small>Next →</small>${esc(newer.title)}</a>` : '<span></span>'}
      </nav>` : '';
    return shell({
        title: `${e.title} · The PFL Cast`,
        description: plainText(e.description),
        url: `${siteUrl()}${episodePath(e)}`,
        audio: { url: `${siteUrl()}/podcast/audio/${e.file}`, mime: e.mime || store.AUDIO_TYPES[store.audioExt(e.file)] },
        image: e.cover || showCover,
        body: `
<header class="hero hero-compact">
  <div class="hero-in">
    <a class="back" href="/podcast">← All episodes</a>
    <div class="wordmark wordmark-sm"><span class="the">The</span>PFL <span class="cast">Cast</span></div>
    <p class="tag">Episode ${num} · Week ${esc(e.week)}, ${esc(e.season)}</p>
    ${hostChips(hosts, null)}
  </div>
</header>
<main class="wrap">
  ${episodeCard(e, num, true, { single: true, showCover })}
  ${nav}
  ${FOOTER}
</main>` });
}

router.get('/', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(renderPage(store.readPublished(rootOf(req)), store.readHosts(rootOf(req)).hosts, store.readShow(rootOf(req)).cover));
});

router.get('/:season(\\d{4})/week:week(\\d{1,2})', (req, res) => {
    const root = rootOf(req);
    const episodes = store.readPublished(root);
    const e = episodes.find(x => x.season === Number(req.params.season) && x.week === Number(req.params.week));
    res.set('Cache-Control', 'no-cache');
    if (!e) return res.status(404).type('html').send(shell({ title: 'Episode not found · The PFL Cast', description: 'The PFL Cast', url: `${siteUrl()}/podcast`, body: `<header class="hero hero-compact"><div class="hero-in"><a class="back" href="/podcast">← All episodes</a><div class="wordmark wordmark-sm"><span class="the">The</span>PFL <span class="cast">Cast</span></div><p class="tag">That episode isn't posted (yet).</p></div></header><main class="wrap">${FOOTER}</main>` }));
    return res.type('html').send(renderEpisodePage(episodes, e, store.readHosts(root).hosts, store.readShow(root).cover));
});

router.get('/cover/:file', (req, res) => {
    const file = store.coverPath(req.params.file, rootOf(req));
    if (!file) return res.status(404).type('text').send('Not found');
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    return res.sendFile(file, { headers: { 'Content-Type': store.IMAGE_TYPES[store.imageExt(req.params.file)] } }, err => {
        if (err && !res.headersSent) res.status(err.statusCode || 404).type('text').send('Not found');
    });
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
module.exports.renderEpisodePage = renderEpisodePage;
