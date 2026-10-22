#!/usr/bin/env node
'use strict';

/**
 * ESPN public-API client for the Double Check job.
 *
 * Scoreboard:  https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=<season>&seasontype=2&week=<week>
 * Summary:     https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=<id>
 *
 * Politeness: one module-level throttle (default 1.5 s between live calls,
 * shared by every caller in the process), 30 s timeout, 3 retries with
 * 2 s / 5 s / 10 s backoff on 429, 5xx and network errors.
 *
 * Cache (logs/doublecheck/espn/<season>/week<NN>/ by default, logs/ is
 * gitignored):
 *   scoreboard.json          reused only when every event is completed
 *   summary-<id>.json        permanent; written only when the game is Final
 *   summary-<id>.partial.json in-progress snapshot; refetched next run
 * Every cache file is { fetchedAt, eventId|season+week, completed, body }.
 *
 * Event <-> nfl_games matching is by (canonical home, canonical away) via
 * getTeamAbbreviation (WSH -> WAS) and never by date: ESPN dates are UTC and
 * the internal game_id date is local.
 *
 * Manual use: node scripts/lib/espnClient.js <season> <week> [--offline]
 * (reads nfl_games read-only, prints the match table and fetch status).
 */

const fs = require('fs');
const path = require('path');
const { getTeamAbbreviation } = require('../../server/utils/teamMappings');

const REPO = path.join(__dirname, '..', '..');
const BASE_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const USER_AGENT = 'statfink2-doublecheck';
const TIMEOUT_MS = 30000;
const DEFAULT_SLEEP_MS = 1500;
const RETRY_DELAYS_MS = [2000, 5000, 10000];

// ---------- helpers ----------

const pad2 = n => String(n).padStart(2, '0');
const realSleep = ms => new Promise(res => setTimeout(res, ms));

function defaultCacheDir(season, week) {
    return path.join(REPO, 'logs', 'doublecheck', 'espn', String(season), `week${pad2(week)}`);
}

function resolveCacheDir(opts, season, week) {
    if (opts && opts.cacheDir) return opts.cacheDir;
    if (season && week) return defaultCacheDir(season, week);
    if (opts && opts.season && opts.week) return defaultCacheDir(opts.season, opts.week);
    throw new Error('espnClient: need opts.cacheDir or season+week to locate the cache');
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw new Error(`Cannot read cache file ${file}: ${e.message}`);
    }
}

function writeJson(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
}

function isRetryableStatus(status) {
    return status === 429 || status >= 500;
}

// ---------- throttle + fetch ----------

// Module-level: every live call in this process waits for the previous one,
// regardless of which function (or caller) issued it.
let lastNetworkCallAt = 0;

async function throttle(sleepMs, sleepImpl) {
    const wait = lastNetworkCallAt + sleepMs - Date.now();
    if (lastNetworkCallAt > 0 && wait > 0) await sleepImpl(wait);
    lastNetworkCallAt = Date.now();
}

/** Test hook: forget the last-call timestamp. */
function resetThrottle() {
    lastNetworkCallAt = 0;
}

/**
 * GET a JSON document with timeout, throttle and retry.
 * opts: fetchImpl (default global fetch), sleepImpl, sleepMs, timeoutMs,
 *       retryDelaysMs (array; length == number of retries).
 */
async function fetchJson(url, opts = {}) {
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw new Error('espnClient: no fetch implementation available (Node 18+ required)');
    const sleepImpl = opts.sleepImpl || realSleep;
    const sleepMs = opts.sleepMs === undefined ? DEFAULT_SLEEP_MS : opts.sleepMs;
    const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
    const delays = opts.retryDelaysMs || RETRY_DELAYS_MS;

    let lastErr = null;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
        if (attempt > 0) await sleepImpl(delays[attempt - 1]);
        await throttle(sleepMs, sleepImpl);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        if (timer.unref) timer.unref();
        try {
            const res = await fetchImpl(url, {
                headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
                signal: controller.signal
            });
            if (!res.ok) {
                const err = new Error(`HTTP ${res.status} from ${url}`);
                err.status = res.status;
                err.retryable = isRetryableStatus(res.status);
                throw err;
            }
            return await res.json();
        } catch (e) {
            if (e.retryable === false) throw e;
            lastErr = e.name === 'AbortError' ? new Error(`timeout after ${timeoutMs} ms: ${url}`) : e;
        } finally {
            clearTimeout(timer);
        }
    }
    const err = new Error(`ESPN fetch failed after ${delays.length + 1} attempts: ${lastErr ? lastErr.message : 'unknown'}`);
    err.cause = lastErr;
    throw err;
}

// ---------- scoreboard ----------

function scoreboardUrl(season, week) {
    return `${BASE_URL}/scoreboard?dates=${season}&seasontype=2&week=${week}`;
}

function summaryUrl(eventId) {
    return `${BASE_URL}/summary?event=${eventId}`;
}

function eventCompleted(event) {
    const comp = event.competitions && event.competitions[0];
    const type = (comp && comp.status && comp.status.type) || (event.status && event.status.type) || {};
    return type.completed === true;
}

function allEventsCompleted(body) {
    const events = (body && body.events) || [];
    return events.length > 0 && events.every(eventCompleted);
}

function assertScoreboardMatches(body, season, week) {
    const gotWeek = body && body.week && body.week.number;
    const gotYear = body && body.season && body.season.year;
    if (gotWeek !== week || gotYear !== season) {
        throw new Error(`ESPN scoreboard mismatch: asked for ${season} week ${week}, got season ${gotYear} week ${gotWeek}`);
    }
}

/**
 * Scoreboard for a week. Returns the parsed body; cached copy reused only
 * when every event in it is completed (or in offline mode).
 */
async function fetchScoreboard(season, week, opts = {}) {
    const cacheDir = resolveCacheDir(opts, season, week);
    const file = path.join(cacheDir, 'scoreboard.json');
    const cached = readJson(file);
    if (cached && cached.body) {
        if (opts.offline || allEventsCompleted(cached.body)) {
            assertScoreboardMatches(cached.body, season, week);
            return cached.body;
        }
    }
    if (opts.offline) throw new Error(`offline and no cached scoreboard at ${file}`);

    const body = await fetchJson(scoreboardUrl(season, week), opts);
    assertScoreboardMatches(body, season, week);
    writeJson(file, {
        fetchedAt: new Date().toISOString(),
        season,
        week,
        completed: allEventsCompleted(body),
        body
    });
    return body;
}

// ---------- summary ----------

function summaryCompleted(body) {
    const comp = body && body.header && body.header.competitions && body.header.competitions[0];
    return !!(comp && comp.status && comp.status.type && comp.status.type.completed === true);
}

/**
 * Like fetchSummary but also says where the body came from:
 * { body, source: 'cache'|'partial-cache'|'network'|'none', completed }.
 */
async function fetchSummaryWithMeta(eventId, opts = {}) {
    const cacheDir = resolveCacheDir(opts);
    const finalFile = path.join(cacheDir, `summary-${eventId}.json`);
    const partialFile = path.join(cacheDir, `summary-${eventId}.partial.json`);

    const final = readJson(finalFile);
    if (final && final.body) return { body: final.body, source: 'cache', completed: true };

    if (opts.offline) {
        const partial = readJson(partialFile);
        if (partial && partial.body) return { body: partial.body, source: 'partial-cache', completed: false };
        return { body: null, source: 'none', completed: false };
    }

    const body = await fetchJson(summaryUrl(eventId), opts);
    const completed = summaryCompleted(body);
    const record = { fetchedAt: new Date().toISOString(), eventId: String(eventId), completed, body };
    if (completed) {
        writeJson(finalFile, record);
        try { fs.unlinkSync(partialFile); } catch (e) { /* no partial to clean up */ }
    } else {
        writeJson(partialFile, record);
    }
    return { body, source: 'network', completed };
}

/**
 * Summary for one event. Permanent cache only once the game is completed;
 * offline mode returns the cached (final or partial) body or null.
 */
async function fetchSummary(eventId, opts = {}) {
    return (await fetchSummaryWithMeta(eventId, opts)).body;
}

// ---------- event <-> nfl_games matching ----------

const canon = abbr => (abbr ? getTeamAbbreviation(abbr) : '');
const gameKey = (home, away) => `${home}@${away}`;

function eventSides(event) {
    const comp = (event.competitions && event.competitions[0]) || {};
    const comps = comp.competitors || [];
    const home = comps.find(c => c.homeAway === 'home') || {};
    const away = comps.find(c => c.homeAway === 'away') || {};
    const type = (comp.status && comp.status.type) || (event.status && event.status.type) || {};
    return {
        home: canon(home.team && home.team.abbreviation),
        away: canon(away.team && away.team.abbreviation),
        homeScore: Number(home.score) || 0,
        awayScore: Number(away.score) || 0,
        espnStatus: type.name || null,
        completed: type.completed === true
    };
}

/**
 * Pair scoreboard events with nfl_games rows by (home, away) canonical codes.
 * @param {Array} events        scoreboard.events
 * @param {Array} nflGames      [{ game_id, home_team, away_team, status }]
 * @returns {{ matches: Array, unmatchedEvents: Array, unmatchedGames: Array }}
 */
function matchEventsToGames(events, nflGames) {
    const pending = new Map();
    for (const g of nflGames || []) {
        pending.set(gameKey(canon(g.home_team), canon(g.away_team)), g);
    }

    const matches = [];
    const unmatchedEvents = [];
    for (const event of events || []) {
        const sides = eventSides(event);
        const game = pending.get(gameKey(sides.home, sides.away));
        if (!game) {
            unmatchedEvents.push({ eventId: String(event.id), shortName: event.shortName || null, home: sides.home, away: sides.away, espnStatus: sides.espnStatus });
            continue;
        }
        pending.delete(gameKey(sides.home, sides.away));
        matches.push({
            eventId: String(event.id),
            gameId: game.game_id,
            home: sides.home,
            away: sides.away,
            espnStatus: sides.espnStatus,
            completed: sides.completed,
            homeScore: sides.homeScore,
            awayScore: sides.awayScore
        });
    }
    const unmatchedGames = [...pending.values()].map(g => ({
        game_id: g.game_id, home_team: canon(g.home_team), away_team: canon(g.away_team), status: g.status
    }));
    return { matches, unmatchedEvents, unmatchedGames };
}

// ---------- whole week ----------

/**
 * Scoreboard + every matched summary for a week. A single game failure is
 * recorded in status.failed (summaries gets null, or the stale partial
 * snapshot if one exists); only an unavailable, uncached scoreboard throws.
 */
async function fetchWeek(season, week, nflGames, opts = {}) {
    const cacheDir = resolveCacheDir(opts, season, week);
    const o = { ...opts, cacheDir };
    const scoreboard = await fetchScoreboard(season, week, o);
    const { matches, unmatchedEvents, unmatchedGames } = matchEventsToGames(scoreboard.events || [], nflGames);

    const summaries = new Map();
    const status = { ok: true, fetched: 0, cached: 0, failed: [] };
    for (const m of matches) {
        try {
            const r = await fetchSummaryWithMeta(m.eventId, o);
            summaries.set(m.gameId, r.body);
            if (r.source === 'network') status.fetched += 1;
            else if (r.source !== 'none') status.cached += 1;
            else status.failed.push({ gameId: m.gameId, eventId: m.eventId, error: 'offline and not cached' });
        } catch (e) {
            const partial = readJson(path.join(cacheDir, `summary-${m.eventId}.partial.json`));
            summaries.set(m.gameId, partial && partial.body ? partial.body : null);
            status.failed.push({
                gameId: m.gameId,
                eventId: m.eventId,
                error: e.message,
                stalePartialUsed: !!(partial && partial.body)
            });
        }
    }
    status.ok = status.failed.length === 0;
    return { scoreboard, matches, unmatchedEvents, unmatchedGames, summaries, status };
}

// ---------- CLI ----------

async function main() {
    const args = process.argv.slice(2);
    const positional = args.filter(a => !a.startsWith('--'));
    const season = parseInt(positional[0]);
    const week = parseInt(positional[1]);
    const offline = args.includes('--offline');
    if (!season || !week) {
        console.error('Usage: node scripts/lib/espnClient.js <season> <week> [--offline]');
        process.exit(1);
    }

    const sqlite3 = require('sqlite3');
    const dbPath = path.join(REPO, 'fantasy_football.db');
    const db = await new Promise((res, rej) => {
        const d = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, err => (err ? rej(err) : res(d)));
    });
    const nflGames = await new Promise((res, rej) => db.all(
        'SELECT game_id, home_team, away_team, status FROM nfl_games WHERE season = ? AND week = ? ORDER BY game_id',
        [season, week], (e, rows) => (e ? rej(e) : res(rows))));
    db.close();
    if (nflGames.length === 0) {
        console.error(`No nfl_games rows for ${season} week ${week}.`);
        process.exit(1);
    }

    const result = await fetchWeek(season, week, nflGames, { offline });
    console.log(`ESPN ${season} week ${week}${offline ? ' (offline)' : ''} - cache ${defaultCacheDir(season, week)}`);
    console.log('');
    console.log('event      game_id                 espn status        done  score      summary');
    for (const m of result.matches) {
        const body = result.summaries.get(m.gameId);
        const failed = result.status.failed.find(f => f.gameId === m.gameId);
        const summ = failed ? `FAILED: ${failed.error}` : (body ? 'ok' : 'missing');
        console.log(`${m.eventId.padEnd(10)} ${m.gameId.padEnd(23)} ${String(m.espnStatus).padEnd(18)} ${m.completed ? 'yes ' : 'no  '} ${`${m.away} ${m.awayScore}-${m.homeScore} ${m.home}`.padEnd(18)} ${summ}`);
    }
    for (const e of result.unmatchedEvents) console.log(`UNMATCHED ESPN EVENT ${e.eventId} ${e.shortName} (${e.away} @ ${e.home})`);
    for (const g of result.unmatchedGames) console.log(`UNMATCHED nfl_games ${g.game_id} (${g.away_team} @ ${g.home_team}, ${g.status})`);
    console.log('');
    console.log(`status: ok=${result.status.ok} fetched=${result.status.fetched} cached=${result.status.cached} failed=${result.status.failed.length}`);
}

if (require.main === module) {
    main().catch(err => {
        console.error(`espnClient failed: ${err.message}`);
        process.exit(1);
    });
}

module.exports = {
    fetchJson,
    fetchScoreboard,
    fetchSummary,
    fetchSummaryWithMeta,
    matchEventsToGames,
    fetchWeek,
    resetThrottle,
    defaultCacheDir,
    scoreboardUrl,
    summaryUrl,
    USER_AGENT,
    DEFAULT_SLEEP_MS,
    RETRY_DELAYS_MS,
    TIMEOUT_MS
};
