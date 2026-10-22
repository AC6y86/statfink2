#!/usr/bin/env node
'use strict';

/**
 * Live play review — a local Qwen model votes on every touchdown / safety
 * while games are running (pm2 `statfink2-live-review`, cron every 5 min).
 *
 * Usage:
 *   node scripts/live-review.js [--force] [--diagnose] [--no-qwen] [--offline] [--quiet]
 *   node scripts/live-review.js --replay <season> <week> --games <id,id> [--write] [--no-qwen]
 *
 * Per tick (docs/DOUBLECHECK.md "Live review"):
 *   1. Read the league read-only (season / current_week / this week's games) and
 *      logs/watchdog/live-latest.json. Outside a game window (no game in
 *      progress, none Final < 90 min, watchdog expectedGames 0) exit `skipped`
 *      in well under a second without touching the network.
 *   2. For every game in the window: Tank01 boxscore from tank01_cache (the
 *      live loop refreshes it every minute) + ESPN summary (espnClient, partial
 *      cache allowed, at most 8 network fetches per tick) + player_stats rows
 *      -> tdDossier.buildGameDossier exactly like the daily Double Check.
 *   3. New TD / SAFETY plays (by play key, logs/live-review/state.json) get one
 *      Qwen vote each: the reconcile prompt (rule text verbatim + award table +
 *      evidence + strict JSON schema), validated with the reconcile script's
 *      validateResolution. Unreachable / invalid twice -> qwen: null, the
 *      deterministic layer decides alone.
 *   4. Compare Qwen vs the script's class vs the DB credit -> confirmed /
 *      under review / miscredit suspected. Under review and suspected plays are
 *      merged into the week's questions.json (source 'live-review', the vote as
 *      hints.qwen) and into live-hints.json so the 06:00 reconcile sees them.
 *   5. Write logs/live-review/latest.json and logs/status/live-review.json.
 *   6. Diagnostician (--diagnose, or automatically when the watchdog says
 *      warning/critical): the watchdog line + pm2 log tails + the WATCHDOG.md
 *      runbook -> Qwen -> logs/live-review/diagnosis.json.
 *
 * Never writes the database. Never throws out of main: any failure becomes a
 * warning job status and exit 1.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
try { require('dotenv').config({ path: path.join(REPO, '.env') }); } catch (_) { /* dotenv optional */ }

const sqlite3 = require('sqlite3');
const { getTeamAbbreviation } = require('../server/utils/teamMappings');
const tdDossier = require('./lib/tdDossier');
const espnClient = require('./lib/espnClient');
const qwen = require('./lib/qwenClient');
const { writeJobStatus } = require('./lib/jobStatus');
const { ruleText, optionsTable } = require('./lib/doublecheckChecks');
const { validateResolution } = require('./doublecheck-reconcile');
const LR = require('./lib/liveReview');

const JOB = 'live-review';
const DB_PATH = path.resolve(REPO, process.env.DATABASE_PATH || 'fantasy_football.db');
const OUT_DIR = process.env.LIVE_REVIEW_DIR || path.join(REPO, 'logs', 'live-review');
const WATCHDOG_LATEST = path.join(REPO, 'logs', 'watchdog', 'live-latest.json');
const DOUBLECHECK_ROOT = path.join(REPO, 'logs', 'doublecheck');
const PM2_LOG_DIR = process.env.PM2_LOG_DIR || path.join(os.homedir(), '.pm2', 'logs');
const ESPN_FETCH_BUDGET = 8;          // network calls per tick (scoreboard + summaries)
const QWEN_MAX_PER_TICK = 12;         // votes per tick
const QWEN_TICK_BUDGET_MS = 180000;   // stop asking after this much wall time
const QWEN_TIMEOUT_MS = 30000;
const QWEN_RETRY_MAX = 2;             // later ticks may retry a play Qwen could not vote on

const pad2 = w => String(w).padStart(2, '0');
const nowIso = () => new Date().toISOString();
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }
function writeJsonAtomic(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
}
const canon = t => (t ? (getTeamAbbreviation(String(t)) || String(t)) : t);
const truncate = (s, n) => { const t = String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' '); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// ---------- args ----------

function parseArgs(argv) {
    const args = argv.slice(2);
    const value = f => { const i = args.indexOf(f); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
    const ri = args.indexOf('--replay');
    const replay = ri >= 0 ? { season: parseInt(args[ri + 1], 10), week: parseInt(args[ri + 2], 10) } : null;
    const games = value('--games') ? value('--games').split(',').map(s => s.trim()).filter(Boolean) : [];
    return {
        force: args.includes('--force'),
        diagnose: args.includes('--diagnose'),
        noQwen: args.includes('--no-qwen'),
        offline: args.includes('--offline'),
        quiet: args.includes('--quiet'),
        write: args.includes('--write'),
        replay, games,
        valid: !replay || (Number.isInteger(replay.season) && Number.isInteger(replay.week) && replay.week >= 1 && games.length > 0)
    };
}

// ---------- db (read-only) ----------

const all = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
const get = (db, sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));

function openDb() {
    return new Promise((res, rej) => {
        const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, err => (err ? rej(new Error(`cannot open ${DB_PATH} read-only: ${err.message}`)) : res(db)));
    });
}
const closeDb = db => new Promise(res => db.close(() => res()));

async function readLeague(db, replay) {
    let season, week;
    if (replay) { season = replay.season; week = replay.week; } else {
        const s = await get(db, 'SELECT season_year, current_week FROM league_settings LIMIT 1') || {};
        season = Number(s.season_year); week = Number(s.current_week);
    }
    const games = await all(db, 'SELECT game_id, season, week, status, home_team, away_team, home_score, away_score, game_time_epoch, last_updated FROM nfl_games WHERE season = ? AND week = ? ORDER BY game_id', [season, week]);
    return { season, week, games: games.map(g => ({ ...g, home_team: canon(g.home_team), away_team: canon(g.away_team) })) };
}

/** Same inputs the daily job feeds tdDossier (scripts/doublecheck-data.js buildSnapshot). */
async function loadGameData(db, season, week, games) {
    const boxscores = new Map();
    for (const g of games) {
        const row = await get(db, 'SELECT response_data FROM tank01_cache WHERE cache_key = ?', [`boxscore_${g.game_id}`]);
        if (!row) continue;
        try { const j = JSON.parse(row.response_data); boxscores.set(g.game_id, j.body || j); } catch (_) { /* bad cache row */ }
    }
    const playerPositions = new Map();
    const pl = await get(db, "SELECT response_data FROM tank01_cache WHERE cache_key = 'playerList'");
    if (pl) { try { for (const p of (JSON.parse(pl.response_data).body || [])) playerPositions.set(String(p.playerID), { name: p.longName, pos: p.pos, team: canon(p.team) }); } catch (_) { /* ignore */ } }
    const players = await all(db, 'SELECT player_id, name, position, team FROM nfl_players');
    const nflPlayers = new Map(players.map(p => [String(p.player_id), { ...p, team: canon(p.team) }]));
    const statsByGame = new Map();
    if (games.length) {
        const rows = await all(db, `SELECT ps.*, COALESCE(NULLIF(ps.position, ''), np.position) AS pos, np.name AS np_name
            FROM player_stats ps LEFT JOIN nfl_players np ON np.player_id = ps.player_id
            WHERE ps.season = ? AND ps.week = ? AND ps.game_id IN (${games.map(() => '?').join(',')})`, [season, week, ...games.map(g => g.game_id)]);
        for (const r of rows) {
            r.position = r.pos; r.name = r.player_name || r.np_name || r.player_id;
            if (!statsByGame.has(r.game_id)) statsByGame.set(r.game_id, []);
            statsByGame.get(r.game_id).push(r);
        }
    }
    return { boxscores, playerPositions, nflPlayers, statsByGame };
}

// ---------- espn (≤ 8 network calls per tick) ----------

async function pullEspn(season, week, games, { offline, log }) {
    const cacheDir = espnClient.defaultCacheDir(season, week);
    const out = { summaries: new Map(), fetched: 0, cached: 0, missing: [], errors: [] };
    let budget = ESPN_FETCH_BUDGET;
    let events = [];
    try {
        const sb = readJson(path.join(cacheDir, 'scoreboard.json'));
        const useCache = sb && sb.body && (offline || sb.completed === true);
        if (!useCache && !offline) budget -= 1;
        const board = useCache ? sb.body : await espnClient.fetchScoreboard(season, week, { cacheDir, offline });
        events = (board && board.events) || [];
    } catch (e) {
        out.errors.push(`scoreboard: ${e.message}`);
        log(`espn scoreboard unavailable: ${e.message}`);
    }
    const { matches } = espnClient.matchEventsToGames(events, games);
    for (const g of games) {
        const m = matches.find(x => x.gameId === g.game_id);
        if (!m) { out.missing.push(g.game_id); continue; }
        const allowNetwork = !offline && budget > 0;
        try {
            const r = await espnClient.fetchSummaryWithMeta(m.eventId, { cacheDir, offline: !allowNetwork });
            if (r.source === 'network') { out.fetched += 1; budget -= 1; } else if (r.source !== 'none') out.cached += 1;
            if (r.body) out.summaries.set(g.game_id, r.body); else out.missing.push(g.game_id);
        } catch (e) {
            budget -= 1;
            const partial = readJson(path.join(cacheDir, `summary-${m.eventId}.partial.json`));
            if (partial && partial.body) { out.summaries.set(g.game_id, partial.body); out.cached += 1; } else out.missing.push(g.game_id);
            out.errors.push(`${g.game_id}: ${e.message}`);
            log(`espn summary ${g.game_id} failed: ${e.message}`);
        }
    }
    return out;
}

// ---------- qwen vote ----------

const VOTE_SYSTEM = 'You are a football scoring auditor. Answer with exactly one JSON object and nothing else: no prose, no markdown fences, no reasoning text outside the JSON.';

const isUnreachable = err => /not configured|network error|timeout|HTTP 5\d\d|HTTP 404/i.test(String(err || ''));
const sleep = ms => new Promise(res => setTimeout(res, ms));

async function qwenVote(play, gameId, { season, week, rule, options, fetchImpl, log = () => {} }) {
    const { question, prompt } = LR.buildReviewPrompt(play, gameId, { rule, options, season, week });
    const ask = () => qwen.askJson({ system: VOTE_SYSTEM, user: prompt, validate: v => validateResolution(v, question), timeoutMs: QWEN_TIMEOUT_MS, fetchImpl });
    let r = await ask();
    if (!r.ok && isUnreachable(r.error) && !/not configured/i.test(r.error)) {
        // one transient network failure (connection reset behind tailscale serve) is not an outage
        log(`qwen: ${r.error}; retrying once in 2 s`);
        await sleep(2000);
        r = await ask();
    }
    if (!r.ok) return { vote: null, error: r.error, latencyMs: r.latencyMs, unreachable: isUnreachable(r.error) };
    const v = r.value;
    return { vote: { awardClass: v.awardClass, credits: v.credits, confidence: v.confidence, reasoning: String(v.reasoning).slice(0, 2000), latencyMs: r.latencyMs, model: r.model, ts: nowIso() }, error: null, latencyMs: r.latencyMs, unreachable: false };
}

// ---------- review one tick ----------

async function reviewGames({ season, week, games, data, espn, state, opts, log, rule, options }) {
    const ts = nowIso();
    const touched = [];          // records written/updated this tick
    const questions = [];
    const dossiers = new Map();
    const qwenEnabled = !opts.noQwen && qwen.isConfigured();
    let qwenCalls = 0;
    let qwenDown = !qwenEnabled;
    const started = Date.now();
    const deferred = [];

    for (const g of games) {
        const box = data.boxscores.get(g.game_id) || null;
        const summary = espn.summaries.get(g.game_id) || null;
        if (!box) { log(`${g.game_id}: no Tank01 boxscore in cache yet`); continue; }
        if (!summary) { deferred.push(g.game_id); log(`${g.game_id}: ESPN summary unavailable — review deferred to the next tick`); continue; }
        const finalScore = /^Final/i.test(String(g.status)) && g.home_score !== null && g.home_score !== undefined && g.away_score !== null && g.away_score !== undefined ? { home: g.home_score, away: g.away_score } : null;
        let dossier;
        try {
            dossier = tdDossier.buildGameDossier({ gameId: g.game_id, season, week, homeTeam: g.home_team, awayTeam: g.away_team, tank01Body: box, espnSummary: summary, playerPositions: data.playerPositions, nflPlayers: data.nflPlayers, dbRows: data.statsByGame.get(g.game_id) || [], finalScore });
        } catch (e) { log(`${g.game_id}: dossier failed: ${e.message}`); continue; }
        dossiers.set(g.game_id, dossier);

        const plays = (dossier.plays || []).filter(p => p.kind === 'TD' || p.kind === 'SAFETY');
        const fresh = new Set(LR.newPlays(dossier, state).map(p => LR.playKey(g.game_id, p)));
        for (const play of LR.prioritize(plays)) {
            const key = LR.playKey(g.game_id, play);
            const prev = state.reviewed[key] || null;
            let vote = prev ? prev.qwen : null;
            let qwenError = prev ? prev.qwenError : null;
            let retries = prev ? (prev.qwenRetries || 0) : 0;
            const wantsVote = fresh.has(key) || (prev && !prev.qwen && prev.qwenError && retries < QWEN_RETRY_MAX && !/not configured/i.test(prev.qwenError));
            if (wantsVote) {
                if (!qwenEnabled) qwenError = opts.noQwen ? 'disabled (--no-qwen)' : 'not configured (QWEN_BASE_URL / QWEN_MODEL)';
                else if (qwenDown) qwenError = 'Qwen unreachable this tick';
                else if (qwenCalls >= QWEN_MAX_PER_TICK || Date.now() - started > QWEN_TICK_BUDGET_MS) { if (fresh.has(key)) continue; }   // leave it for the next tick
                else {
                    qwenCalls += 1;
                    if (prev) retries += 1;
                    const r = await qwenVote(play, g.game_id, { season, week, rule, options, log });
                    vote = r.vote; qwenError = r.error;
                    if (r.unreachable) { qwenDown = true; log(`qwen unreachable: ${r.error}`); }
                    else if (!r.vote) log(`${key}: qwen answer rejected: ${r.error}`);
                }
            }
            const verdict = LR.compareVotes({ play, qwen: vote });
            const rec = LR.reviewRecord({ play, gameId: g.game_id, season, week, qwen: vote, qwenError, verdict, ts: prev ? prev.ts : ts });
            rec.updatedTs = ts;
            rec.qwenRetries = retries;
            state.reviewed[key] = rec;
            touched.push(rec);
            if (verdict.status !== LR.STATUS.CONFIRMED && (!prev || prev.status !== verdict.status || (vote && !prev.qwen))) {
                const q = LR.toQuestion(play, g.game_id, season, week, vote, { rule });
                q.hints.liveStatus = verdict.status;
                questions.push(q);
            }
        }
    }
    return { touched, questions, dossiers, qwenCalls, qwenDown, qwenEnabled, deferred };
}

// ---------- hand-off to the daily pipeline ----------

function mergeIntoWorkspace(season, week, questions, log, reviews = [], root = DOUBLECHECK_ROOT) {
    if (!questions.length && !reviews.length) return null;
    const ws = path.join(root, String(season), `week${pad2(week)}`);
    fs.mkdirSync(ws, { recursive: true });
    const qFile = path.join(ws, 'questions.json');
    const existing = readJson(qFile) || { generatedAt: nowIso(), season, week, questions: [] };
    const merged = LR.mergeQuestions(existing, questions);
    merged.season = merged.season || season; merged.week = merged.week || week;
    const rulings = readJson(path.join(root, 'rulings.json')) || {};
    const reconciled = LR.retireConfirmedQuestions(merged, reviews, rulings);
    if (reconciled.retired.length) {
        const archiveFile = path.join(ws, 'live-resolved-questions.json');
        const archive = fs.existsSync(archiveFile)
            ? JSON.parse(fs.readFileSync(archiveFile, 'utf8')) : { season, week, questions: {} };
        if (!archive.questions || typeof archive.questions !== 'object' || Array.isArray(archive.questions)) {
            throw new Error('Invalid confirmed-question archive; active questions left unchanged');
        }
        for (const item of reconciled.retired) archive.questions[item.question.id] = item;
        archive.updatedAt = nowIso();
        // Archive first: an I/O failure must never discard active questions.
        writeJsonAtomic(archiveFile, archive);
        log(`${reconciled.retired.length} confirmed question(s) archived with verification evidence`);
    }
    writeJsonAtomic(qFile, reconciled.active);
    // The daily doublecheck-data.js rewrites questions.json; hints live on here and reconcile re-attaches them.
    const hFile = path.join(ws, 'live-hints.json');
    const hints = readJson(hFile) || { season, week, hints: {} };
    for (const q of questions) if (q.hints && q.hints.qwen) hints.hints[q.id] = { qwen: q.hints.qwen, status: q.hints.liveStatus || null, ts: nowIso() };
    hints.updatedAt = nowIso();
    writeJsonAtomic(hFile, hints);
    log(`${questions.length} question(s) merged into ${qFile}`);
    return qFile;
}

// ---------- diagnostician ----------

function newestLog(app, kind) {
    try {
        const files = fs.readdirSync(PM2_LOG_DIR).filter(f => f.startsWith(`${app}-${kind}`) && f.endsWith('.log'));
        if (!files.length) return null;
        files.sort((a, b) => fs.statSync(path.join(PM2_LOG_DIR, b)).mtimeMs - fs.statSync(path.join(PM2_LOG_DIR, a)).mtimeMs);
        return path.join(PM2_LOG_DIR, files[0]);
    } catch (_) { return null; }
}

function tail(file, n = 60, width = 220) {
    if (!file) return [];
    try {
        const stat = fs.statSync(file);
        const size = Math.min(stat.size, 256 * 1024);
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(size);
        fs.readSync(fd, buf, 0, size, stat.size - size);
        fs.closeSync(fd);
        return buf.toString('utf8').split('\n').filter(l => l.trim()).slice(-n).map(l => truncate(l, width));
    } catch (_) { return []; }
}

function runbookTable() {
    try {
        const md = fs.readFileSync(path.join(REPO, 'WATCHDOG.md'), 'utf8');
        const i = md.indexOf('## What to do about each status');
        if (i < 0) return '';
        const rest = md.slice(i);
        const tbl = rest.match(/(\|[^\n]*\n)+/);
        return tbl ? tbl[0].trim() : '';
    } catch (_) { return ''; }
}

function fallbackDiagnosis(live) {
    const sev = live && ['ok', 'warning', 'critical'].includes(live.severity) ? live.severity : 'ok';
    if (!live) return { diagnosis: 'No watchdog line is available (logs/watchdog/live-latest.json missing); nothing can be diagnosed.', suggestedAction: 'pm2 logs statfink2-watchdog --lines 50', severity: 'warning' };
    if (sev === 'ok') return { diagnosis: `Watchdog reports ${live.status}: ${live.summary || 'no issue'}. Nothing is wrong.`, suggestedAction: 'none', severity: 'ok' };
    return { diagnosis: `Watchdog reports ${live.status} (${sev}): ${live.summary || ''}`.trim(), suggestedAction: `see WATCHDOG.md runbook row "${live.status}"`, severity: sev };
}

async function diagnose(live, { log }) {
    const ts = nowIso();
    const logs = {};
    for (const app of ['statfink2-live-continuous', 'statfink2']) {
        logs[`${app} (out)`] = tail(newestLog(app, 'out'));
        logs[`${app} (error)`] = tail(newestLog(app, 'error'));
    }
    const base = { ts, watchdogTs: live ? live.ts : null, status: live ? live.status : null, model: null };
    if (!qwen.isConfigured()) {
        const f = fallbackDiagnosis(live);
        return { ...base, ...f, source: 'fallback', error: 'Qwen not configured' };
    }
    const user = [
        'You are diagnosing the live fantasy-scoring pipeline of statfink2 (Node app under pm2: statfink2 = web server + Tank01 API client, statfink2-live-continuous = per-minute live scoring loop). A watchdog checks it every 2 minutes.',
        '',
        'WATCHDOG (logs/watchdog/live-latest.json):',
        JSON.stringify(live || { error: 'no watchdog line available' }, null, 1),
        '',
        'RUNBOOK (WATCHDOG.md):',
        runbookTable() || '(runbook unavailable)',
        '',
        ...Object.entries(logs).flatMap(([k, lines]) => [`LAST ${lines.length} LINES OF pm2 log ${k}:`, lines.length ? lines.join('\n') : '(empty)', '']),
        'Answer with ONE JSON object: {"diagnosis": "<= 80 words, plain English, what is (or is not) wrong and the likely cause", "suggestedAction": "exactly one runbook fix line that applies, or \'none\'", "severity": "ok"|"warning"|"critical"}.',
        'The watchdog is the authority on whether live scoring is healthy: severity must be the watchdog severity, never higher. When it is ok, say that nothing is wrong (severity "ok", suggestedAction "none"); you may add one sentence about a notable recent error in the logs. Log lines carry timestamps: ignore anything older than 30 minutes before the watchdog ts. Never invent commands that are not in the runbook.'
    ].join('\n');
    const validate = v => {
        const errs = [];
        if (typeof v.diagnosis !== 'string' || !v.diagnosis.trim()) errs.push('diagnosis must be a non-empty string');
        if (typeof v.suggestedAction !== 'string') errs.push('suggestedAction must be a string');
        if (!['ok', 'warning', 'critical'].includes(v.severity)) errs.push('severity must be ok|warning|critical');
        return errs;
    };
    const r = await qwen.askJson({ system: 'You answer with exactly one JSON object and nothing else.', user, validate, timeoutMs: 60000, maxTokens: 400 });
    if (!r.ok) {
        log(`diagnosis: qwen failed (${r.error}); using the deterministic fallback`);
        return { ...base, ...fallbackDiagnosis(live), source: 'fallback', error: r.error };
    }
    const words = String(r.value.diagnosis).trim().split(/\s+/);
    // The watchdog decides how bad things are; the model only explains. Its own opinion is kept for the record.
    const rank = { ok: 0, warning: 1, critical: 2 };
    const wdSev = live && rank[live.severity] !== undefined ? live.severity : 'ok';
    const severity = rank[r.value.severity] > rank[wdSev] ? wdSev : r.value.severity;
    const suggestedAction = severity === 'ok' ? 'none' : (String(r.value.suggestedAction).trim() || 'none');
    return { ...base, diagnosis: words.slice(0, 80).join(' '), suggestedAction, severity, qwenSeverity: r.value.severity, model: r.model, latencyMs: r.latencyMs, source: 'qwen', error: null };
}

// ---------- output ----------

function printReplayTable(records, log) {
    const rows = records.slice().sort((a, b) => (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : a.playIdx - b.playIdx));
    const head = ['play', 'game', 'when', 'team', 'kind', 'script', 'db', 'qwen', 'status', 'text'];
    const lines = rows.map(r => [String(r.playIdx), r.gameId, `${r.period || '?'} ${r.clock || '?'}`, r.scoringTeam || '?', r.kind,
        r.deterministic.awardClass, r.deterministic.agreement === null ? 'n/a' : r.deterministic.agreement ? 'agree' : 'DIFFERS',
        r.qwen ? `${r.qwen.awardClass} (${r.qwen.confidence}, ${r.qwen.latencyMs ?? '?'} ms)` : `null${r.qwenError ? ` [${truncate(r.qwenError, 40)}]` : ''}`,
        r.status, truncate(r.text, 60)]);
    const widths = head.map((h, i) => Math.max(h.length, ...lines.map(l => l[i].length)));
    const fmt = cols => cols.map((c, i) => c.padEnd(widths[i])).join('  ');
    log(fmt(head));
    log(fmt(widths.map(w => '-'.repeat(w))));
    for (const l of lines) log(fmt(l));
    for (const r of rows) if (r.qwen && r.qwen.reasoning) log(`  play ${r.playIdx} ${r.gameId} — Qwen: ${truncate(r.qwen.reasoning, 300)}`);
}

// ---------- main ----------

async function main() {
    const opts = parseArgs(process.argv);
    const log = opts.quiet ? () => {} : msg => console.log(`[${nowIso()}] ${msg}`);
    if (!opts.valid) {
        console.error('Usage: node scripts/live-review.js [--force] [--diagnose] [--no-qwen] [--offline] [--quiet]\n       node scripts/live-review.js --replay <season> <week> --games <id,id> [--write] [--no-qwen]');
        process.exit(2);
    }
    const started = Date.now();
    const replay = opts.replay;
    const persist = !replay || opts.write;
    const live = readJson(WATCHDOG_LATEST);
    const stateFile = path.join(OUT_DIR, 'state.json');
    const state = LR.pruneState(persist ? (readJson(stateFile) || { reviewed: {} }) : { reviewed: {} });
    if (!state.reviewed) state.reviewed = {};

    const db = await openDb();
    let league, data;
    let games;
    try {
        league = await readLeague(db, replay);
        if (replay) {
            games = league.games.filter(g => opts.games.includes(g.game_id));
            const missing = opts.games.filter(id => !games.some(g => g.game_id === id));
            if (missing.length) log(`not in nfl_games for ${league.season} week ${league.week}: ${missing.join(', ')}`);
        } else {
            games = LR.selectGames(league.games, live);
            if (!games.length && opts.force) games = league.games.filter(g => !/^Scheduled$/i.test(String(g.status || '')) && String(g.status || ''));
        }
        const windowOpen = replay || opts.force || LR.inWindow(league.games, live);
        const watchdogBad = !!(live && (live.severity === 'warning' || live.severity === 'critical'));
        if (!windowOpen && !opts.diagnose && !watchdogBad) {
            if (persist) mergeIntoWorkspace(league.season, league.week, [], log,
                Object.values(state.reviewed).filter(r => r.season === league.season && r.week === league.week));
            const rec = writeJobStatus(JOB, { status: 'skipped', summary: 'no games in the live window', season: league.season, week: league.week, durationMs: Date.now() - started, details: { games: [], expectedGames: live ? live.expectedGames : null } });
            log(`skipped: no games in the live window (${Date.now() - started} ms)${rec ? '' : ' [status write failed]'}`);
            return 0;
        }
        data = await loadGameData(db, league.season, league.week, games);
    } finally {
        await closeDb(db);
    }
    const { season, week } = league;
    log(`${replay ? 'replay' : 'tick'} ${season} week ${week}: ${games.length} game(s) ${games.map(g => `${g.game_id} [${g.status}]`).join(', ') || '(none)'}; qwen ${opts.noQwen ? 'disabled' : qwen.isConfigured() ? `configured (${qwen.config().model})` : 'not configured'}`);

    let result = { touched: [], questions: [], dossiers: new Map(), qwenCalls: 0, qwenDown: false, qwenEnabled: false, deferred: [] };
    let espn = { summaries: new Map(), fetched: 0, cached: 0, missing: [], errors: [] };
    if (games.length) {
        const offline = opts.offline || (replay && games.every(g => /^Final/i.test(String(g.status))) && cachedFinal(season, week, games));
        espn = await pullEspn(season, week, games, { offline, log });
        log(`espn: ${espn.fetched} fetched, ${espn.cached} cached, ${espn.missing.length} missing${espn.errors.length ? `, errors: ${espn.errors.join(' | ')}` : ''}`);
        result = await reviewGames({ season, week, games, data, espn, state, opts, log, rule: ruleText(), options: optionsTable() });
    }

    // latest.json: every review of the current week (state is the record; this is the view)
    const reviews = Object.values(state.reviewed).filter(r => r.season === season && r.week === week)
        .sort((a, b) => (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : a.playIdx - b.playIdx));
    const sum = LR.summarize(reviews);
    const latest = { ts: nowIso(), season, week, games: games.map(g => g.game_id), reviews, summary: { ...sum, qwenConfigured: qwen.isConfigured(), qwenCallsThisTick: result.qwenCalls, espn: { fetched: espn.fetched, cached: espn.cached, missing: espn.missing }, deferred: result.deferred } };

    let qFile = null;
    if (persist) {
        writeJsonAtomic(stateFile, { updatedAt: nowIso(), reviewed: state.reviewed });
        writeJsonAtomic(path.join(OUT_DIR, 'latest.json'), latest);
        qFile = mergeIntoWorkspace(season, week, result.questions, log, reviews);
    }

    // Diagnostician: on request, or whenever the watchdog is unhappy.
    let diagnosis = null;
    if (opts.diagnose || (live && (live.severity === 'warning' || live.severity === 'critical'))) {
        diagnosis = await diagnose(live, { log });
        if (persist || opts.diagnose) writeJsonAtomic(path.join(OUT_DIR, 'diagnosis.json'), diagnosis);
        log(`diagnosis (${diagnosis.source}, ${diagnosis.severity}): ${diagnosis.diagnosis} -> ${diagnosis.suggestedAction}`);
    }

    if (replay) {
        printReplayTable(result.touched, m => console.log(m));
        console.log(`\n${sum.summary}${opts.write ? ` (written; ${qFile || 'no questions'})` : ' (dry replay: nothing written; add --write to persist)'}`);
        return 0;
    }

    const summaryParts = [`${games.length} game(s) in window`, sum.summary];
    if (!qwen.isConfigured() && !opts.noQwen) summaryParts.push('Qwen not configured');
    else if (result.qwenDown && result.qwenEnabled) summaryParts.push('Qwen unreachable');
    if (result.deferred.length) summaryParts.push(`${result.deferred.length} game(s) deferred (no ESPN summary)`);
    const details = { games: games.map(g => g.game_id), confirmed: sum.confirmed, underReview: sum.underReview, suspected: sum.suspected, qwenUnreachable: sum.qwenUnreachable, qwenConfigured: qwen.isConfigured(), qwenCalls: result.qwenCalls, espnFetched: espn.fetched, deferred: result.deferred, questionsFile: qFile, diagnosis: diagnosis ? { severity: diagnosis.severity, source: diagnosis.source } : null };
    writeJobStatus(JOB, { status: sum.status, summary: summaryParts.join('; '), season, week, durationMs: Date.now() - started, details });
    log(`done: ${sum.status} — ${summaryParts.join('; ')} (${Date.now() - started} ms)`);
    return 0;
}

/** Every replayed final game has a permanent ESPN summary cached -> no network needed. */
function cachedFinal(season, week, games) {
    const dir = espnClient.defaultCacheDir(season, week);
    const sb = readJson(path.join(dir, 'scoreboard.json'));
    if (!sb || !sb.body) return false;
    const { matches } = espnClient.matchEventsToGames(sb.body.events || [], games);
    return games.every(g => { const m = matches.find(x => x.gameId === g.game_id); return m && fs.existsSync(path.join(dir, `summary-${m.eventId}.json`)); });
}

if (require.main === module) {
    main().then(code => { process.exitCode = code; }).catch(err => {
        const msg = `tick failed: ${err && err.message ? err.message : String(err)}`;
        console.error(`live-review ${msg}`);
        writeJobStatus(JOB, { status: 'warning', summary: msg });
        process.exitCode = 1;
    });
}

module.exports = { parseArgs, selectForTick: LR.selectGames, pullEspn, reviewGames, diagnose, fallbackDiagnosis, runbookTable, tail, newestLog, mergeIntoWorkspace,
    // internals reused by scripts/qwen-replay.js (read-only replays of past seasons)
    openDb, closeDb, readLeague, loadGameData, qwenVote, ruleText, optionsTable, cachedFinal };
