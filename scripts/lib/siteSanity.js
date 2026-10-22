'use strict';

/**
 * Script-side sanity signals for the live watchdog (scripts/live-watchdog.js):
 * what a league owner sees, not what the server thinks of itself.
 *
 *   probePublicSite      -> public_site, public_api_fresh, tls_cert
 *   compareScoresToEspn  -> scores_vs_espn
 *   readWeekGamesReadOnly / readLeagueWeekReadOnly (sqlite OPEN_READONLY)
 *   fetchScoreboardCached (ESPN scoreboard, own 90 s cache file)
 *
 * Pure where it matters: every I/O is injectable (fetchImpl, tlsImpl, now)
 * so the unit tests never touch the network. Every signal is
 * { name, ok, severity?, detail } - the shape HealthCheckService.checkLiveScoring
 * emits, so server/utils/liveRollup.js can roll them all up together.
 *
 * Nothing here writes to the database.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');
const espnClient = require('./espnClient');
const { getTeamAbbreviation } = require('../../server/utils/teamMappings');

const DEFAULT_BASE_URL = 'https://peninsulafootball.com';
const DEFAULT_TIMEOUT_MS = 8000;
const API_STALE_SEC = 300;          // public sync-status older than this while live
const TLS_WARN_DAYS = 14;
const TLS_CRITICAL_DAYS = 3;
const SCORE_STALE_SEC = 300;        // ours differs from ESPN and not rewritten in 5 min
const FINAL_LAG_SEC = 20 * 60;      // ESPN final, ours not Final for 20 min
const MAX_LISTED_GAMES = 5;
const SCOREBOARD_TTL_MS = 90 * 1000;

// SQLite CURRENT_TIMESTAMP is 'YYYY-MM-DD HH:MM:SS' UTC with no zone marker;
// Date.parse would read it as local time.
function dbTimestampMs(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return value;
    const s = String(value);
    const ms = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)
        ? Date.parse(s.replace(' ', 'T') + 'Z')
        : Date.parse(s);
    return Number.isNaN(ms) ? null : ms;
}

function withTimeout(fetchImpl, url, opts, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (timer.unref) timer.unref();
    return Promise.resolve()
        .then(() => fetchImpl(url, { ...opts, signal: controller.signal }))
        .catch(e => { throw e && e.name === 'AbortError' ? new Error(`timeout after ${timeoutMs} ms`) : e; })
        .finally(() => clearTimeout(timer));
}

const minutes = sec => Math.round(sec / 60);

// ---------- public site ----------

async function probePage({ baseUrl, season, week, checkDisplayedWeek, fetchImpl, timeoutMs }) {
    const name = 'public_site';
    const started = Date.now();
    let res;
    let body = '';
    try {
        res = await withTimeout(fetchImpl, `${baseUrl}/`, { redirect: 'follow', headers: { 'User-Agent': 'statfink2-watchdog' } }, timeoutMs);
        try { body = await res.text(); } catch (_) { body = ''; }
    } catch (e) {
        return { name, ok: false, severity: 'critical', detail: `${baseUrl}/ unreachable: ${e.message}` };
    }
    const ms = Date.now() - started;
    const finalUrl = res.url || `${baseUrl}/`;
    if (res.status !== 200) {
        return { name, ok: false, severity: 'critical', detail: `HTTP ${res.status} from ${finalUrl} in ${ms} ms` };
    }
    if (season && week && checkDisplayedWeek) {
        const expected = `/statfink/${season}/${week}`;
        if (!(finalUrl.includes(expected) || body.includes(expected))) {
            const seen = /\/statfink\/(\d{4})\/(\d{1,2})\b/.exec(finalUrl) || /\/statfink\/(\d{4})\/(\d{1,2})\b/.exec(body);
            const why = seen
                ? `page is for week ${seen[2]} not ${week}${seen[1] !== String(season) ? ` (season ${seen[1]} not ${season})` : ''}`
                : `no ${expected} reference in the page`;
            return { name, ok: false, severity: 'critical', detail: `200 in ${ms} ms → ${finalUrl} but ${why}` };
        }
    }
    if (season && !checkDisplayedWeek) {
        const seen = /\/statfink\/(\d{4})\/(\d{1,2})\b/.exec(finalUrl) || /\/statfink\/(\d{4})\/(\d{1,2})\b/.exec(body);
        if (!seen || seen[1] !== String(season)) {
            return { name, ok: false, severity: 'critical', detail: `200 in ${ms} ms → ${finalUrl} but no league page for season ${season}` };
        }
    }
    return { name, ok: true, detail: `200 in ${ms} ms → ${finalUrl}${checkDisplayedWeek ? '' : ' (displayed-week check disabled)'}` };
}

/**
 * Find the last live-update timestamp in /api/league/sync-status.
 * The route today returns { success, data: { last_sync_time, latest_week,
 * weeks_synced, players_synced, latest_season } } where last_sync_time is
 * the request time (the app does not expose last_live_update publicly).
 * Preferred fields are checked first so the signal gets sharper the day the
 * route exposes them; the fallback still proves the public path reaches a
 * live app process (nginx cache / wrong upstream would return a stale one).
 * @returns {{ ts: number, field: string } | null}
 */
function findLiveTimestamp(json) {
    if (!json || typeof json !== 'object') return null;
    const scopes = [json.data, json.data && json.data.live, json];
    const fields = ['last_live_update', 'lastLiveUpdate', 'last_sync_time', 'lastSyncTime'];
    for (const scope of scopes) {
        if (!scope || typeof scope !== 'object') continue;
        for (const field of fields) {
            const ms = dbTimestampMs(scope[field]);
            if (ms !== null) return { ts: ms, field };
        }
    }
    return null;
}

async function probeApi({ baseUrl, live, now, fetchImpl, timeoutMs }) {
    const name = 'public_api_fresh';
    let json;
    try {
        const res = await withTimeout(fetchImpl, `${baseUrl}/api/league/sync-status`,
            { headers: { Accept: 'application/json', 'User-Agent': 'statfink2-watchdog' } }, timeoutMs);
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        json = await res.json();
    } catch (e) {
        // Decided by the caller (depends on public_site): unreachable marker
        return { name, ok: false, severity: 'warning', unreachable: true, detail: `sync-status unreachable: ${e.message}` };
    }
    const found = findLiveTimestamp(json);
    if (!live) return { name, ok: true, detail: 'idle' };
    if (!found) return { name, ok: false, severity: 'warning', detail: 'sync-status has no live-update timestamp' };
    const ageSec = Math.max(0, Math.round((now - found.ts) / 1000));
    if (ageSec > API_STALE_SEC) {
        return { name, ok: false, severity: 'warning', detail: `public API last live update ${minutes(ageSec)} min ago (${found.field})` };
    }
    return { name, ok: true, detail: `${found.field} ${ageSec}s ago` };
}

/** Default tlsImpl: one HEAD on a fresh socket, read the peer certificate. */
function defaultTlsImpl(baseUrl, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const u = new URL(baseUrl);
    return new Promise((resolve, reject) => {
        const req = https.request({
            method: 'HEAD',
            host: u.hostname,
            port: u.port || 443,
            path: '/',
            agent: false,
            timeout: timeoutMs,
            headers: { 'User-Agent': 'statfink2-watchdog' }
        }, res => {
            const cert = res.socket && res.socket.getPeerCertificate ? res.socket.getPeerCertificate() : null;
            res.resume();
            if (!cert || !cert.valid_to) return reject(new Error('no peer certificate on the socket'));
            resolve({ validTo: new Date(cert.valid_to), subject: cert.subject && cert.subject.CN });
        });
        req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs} ms`)));
        req.on('error', reject);
        req.end();
    });
}

async function probeTls({ baseUrl, now, tlsImpl, timeoutMs }) {
    const name = 'tls_cert';
    if (!/^https:/i.test(baseUrl)) return { name, ok: true, detail: 'not https' };
    let info;
    try {
        info = await tlsImpl(baseUrl, { timeoutMs });
    } catch (e) {
        return { name, ok: false, severity: 'warning', detail: `TLS check failed: ${e.message}` };
    }
    const validTo = info && info.validTo instanceof Date ? info.validTo.getTime() : Date.parse(info && info.validTo);
    if (Number.isNaN(validTo)) return { name, ok: false, severity: 'warning', detail: 'TLS check failed: certificate has no valid_to' };
    const days = Math.floor((validTo - now) / 86400000);
    if (days < TLS_CRITICAL_DAYS) {
        return { name, ok: false, severity: 'critical', detail: `certificate ${days < 0 ? 'EXPIRED' : `expires in ${days} day(s)`} (${new Date(validTo).toISOString().slice(0, 10)}) - run certbot` };
    }
    if (days < TLS_WARN_DAYS) {
        return { name, ok: false, severity: 'warning', detail: `certificate expires in ${days} days (${new Date(validTo).toISOString().slice(0, 10)}) - certbot renewal is late` };
    }
    return { name, ok: true, detail: `expires in ${days} days` };
}

/**
 * Probe the public site as a league owner would. Three signals, gathered
 * concurrently (≤ timeoutMs total):
 *   public_site      GET / follows redirects; 200 and the final URL or body
 *                    references /statfink/<season>/<week>. Critical otherwise.
 *                    checkDisplayedWeek=false allows any week in that season.
 *   public_api_fresh GET /api/league/sync-status; warning when live and the
 *                    timestamp is > 5 min old. Info-only ('sync-status
 *                    unavailable') when the site itself is down, so one
 *                    outage does not page twice.
 *   tls_cert         certificate valid_to: critical < 3 days, warning < 14.
 */
async function probePublicSite({
    baseUrl = process.env.PUBLIC_SITE_URL || DEFAULT_BASE_URL,
    season = null,
    week = null,
    checkDisplayedWeek = true,
    live = false,
    now = Date.now(),
    fetchImpl = globalThis.fetch,
    tlsImpl = defaultTlsImpl,
    timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
    const base = String(baseUrl).replace(/\/+$/, '');
    const [site, api, tls] = await Promise.all([
        probePage({ baseUrl: base, season, week, checkDisplayedWeek, fetchImpl, timeoutMs }),
        probeApi({ baseUrl: base, live, now, fetchImpl, timeoutMs }),
        probeTls({ baseUrl: base, now, tlsImpl, timeoutMs })
    ]);
    if (api.unreachable) {
        delete api.unreachable;
        if (!site.ok) {
            api.ok = true;
            delete api.severity;
            api.detail = 'sync-status unavailable (site down)';
        }
    }
    return [site, api, tls];
}

// ---------- scores vs ESPN ----------

const ESPN_ACTIVE_RE = /IN_PROGRESS|HALFTIME|END_PERIOD/;

/**
 * Compare our nfl_games scores with ESPN's scoreboard.
 * @param {{ matches: Array|null, nflGames: Array, now: number, live: boolean }} args
 *   matches: espnClient.matchEventsToGames(events, nflGames).matches, or null
 *            when the scoreboard could not be fetched (info-only result).
 *   nflGames: rows with game_id, home_team, away_team, home_score, away_score,
 *            status, last_updated (SQLite UTC text or ms).
 */
function compareScoresToEspn({ matches, nflGames = [], now = Date.now(), live = false,
    staleAfterSec = SCORE_STALE_SEC, finalLagSec = FINAL_LAG_SEC } = {}) {
    const name = 'scores_vs_espn';
    if (!live) return { name, ok: true, detail: 'idle' };
    if (!Array.isArray(matches)) return { name, ok: true, detail: 'ESPN scoreboard unavailable' };

    const byId = new Map((nflGames || []).map(g => [g.game_id, g]));
    const behind = [];
    let checked = 0;
    for (const m of matches) {
        const active = m.completed || ESPN_ACTIVE_RE.test(String(m.espnStatus || ''));
        if (!active) continue;
        const ours = byId.get(m.gameId);
        if (!ours) continue;
        checked += 1;
        const updatedMs = dbTimestampMs(ours.last_updated);
        const ageSec = updatedMs === null ? Infinity : Math.max(0, (now - updatedMs) / 1000);
        const oursHome = Number(ours.home_score) || 0;
        const oursAway = Number(ours.away_score) || 0;
        const scoresDiffer = oursHome !== m.homeScore || oursAway !== m.awayScore;
        const oursFinal = /^Final/i.test(String(ours.status || ''));
        const staleScore = scoresDiffer && ageSec > staleAfterSec;
        const lateFinal = m.completed && !oursFinal && ageSec > finalLagSec;
        if (staleScore || lateFinal) {
            const ago = ageSec === Infinity ? 'never' : `${minutes(ageSec)} min ago`;
            const finalNote = lateFinal ? ` (ESPN final, ours '${ours.status || 'Scheduled'}')` : '';
            behind.push(`${m.away}@${m.home} espn ${m.awayScore}-${m.homeScore}, ours ${oursAway}-${oursHome}, ours updated ${ago}${finalNote}`);
        }
    }
    if (behind.length) {
        const more = behind.length > MAX_LISTED_GAMES ? ` and ${behind.length - MAX_LISTED_GAMES} more` : '';
        return {
            name, ok: false, severity: 'warning',
            detail: `${behind.length} of ${checked} game(s) behind ESPN: ${behind.slice(0, MAX_LISTED_GAMES).join('; ')}${more}`
        };
    }
    return { name, ok: true, detail: checked ? `${checked} game(s) match ESPN` : 'no ESPN game in progress yet' };
}

// ---------- read-only DB helpers ----------

function openReadOnly(dbPath) {
    const sqlite3 = require('sqlite3');
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, err => (err ? reject(err) : resolve(db)));
    });
}

function dbAll(db, sql, params) {
    return new Promise((resolve, reject) => db.all(sql, params, (e, rows) => (e ? reject(e) : resolve(rows))));
}

/**
 * nfl_games rows for one week, teams canonicalised (WSH -> WAS), plus
 * last_updated_ms parsed as UTC. null when the DB cannot be opened/read.
 */
async function readWeekGamesReadOnly(dbPath, season, week) {
    let db;
    try {
        db = await openReadOnly(dbPath);
        const rows = await dbAll(db, `
            SELECT game_id, home_team, away_team, home_score, away_score,
                   COALESCE(status, 'Scheduled') AS status, last_updated, game_time_epoch
            FROM nfl_games WHERE season = ? AND week = ? ORDER BY game_time_epoch, game_id`, [season, week]);
        return rows.map(r => ({
            ...r,
            home_team: getTeamAbbreviation(r.home_team),
            away_team: getTeamAbbreviation(r.away_team),
            last_updated_ms: dbTimestampMs(r.last_updated)
        }));
    } catch (_) {
        return null;
    } finally {
        if (db) db.close(() => {});
    }
}

/** { season, week } from league_settings, or null. */
async function readLeagueWeekReadOnly(dbPath) {
    let db;
    try {
        db = await openReadOnly(dbPath);
        const rows = await dbAll(db, 'SELECT season_year AS season, current_week AS week FROM league_settings WHERE league_id = 1', []);
        return rows[0] && rows[0].season && rows[0].week ? { season: rows[0].season, week: rows[0].week } : null;
    } catch (_) {
        return null;
    } finally {
        if (db) db.close(() => {});
    }
}

// ---------- ESPN scoreboard (own cache) ----------

/**
 * ESPN scoreboard events for a week through the watchdog's OWN cache file
 * ({ fetchedAt, season, week, body }; default logs/watchdog/espn-scoreboard.json,
 * 90 s TTL) - never the Double Check's logs/doublecheck/espn cache. One
 * attempt, no retries (the tick has a budget). Any failure -> null.
 */
async function fetchScoreboardCached({ season, week, cacheFile, ttlMs = SCOREBOARD_TTL_MS, now = Date.now(),
    fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!season || !week || !cacheFile) return null;
    try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (cached && cached.body && cached.season === season && cached.week === week &&
            now - Date.parse(cached.fetchedAt) < ttlMs) {
            return cached.body.events || [];
        }
    } catch (_) { /* no usable cache */ }

    try {
        const body = await espnClient.fetchJson(espnClient.scoreboardUrl(season, week),
            { fetchImpl, timeoutMs, sleepMs: 0, retryDelaysMs: [] });
        const gotWeek = body && body.week && body.week.number;
        const gotYear = body && body.season && body.season.year;
        if (gotWeek !== week || gotYear !== season) return null;
        try {
            fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
            const tmp = `${cacheFile}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ fetchedAt: new Date(now).toISOString(), season, week, body }));
            fs.renameSync(tmp, cacheFile);
        } catch (_) { /* cache is an optimisation */ }
        return body.events || [];
    } catch (_) {
        return null;
    }
}

module.exports = {
    DEFAULT_BASE_URL,
    DEFAULT_TIMEOUT_MS,
    API_STALE_SEC,
    TLS_WARN_DAYS,
    TLS_CRITICAL_DAYS,
    SCORE_STALE_SEC,
    FINAL_LAG_SEC,
    SCOREBOARD_TTL_MS,
    dbTimestampMs,
    findLiveTimestamp,
    probePublicSite,
    defaultTlsImpl,
    compareScoresToEspn,
    readWeekGamesReadOnly,
    readLeagueWeekReadOnly,
    fetchScoreboardCached
};
