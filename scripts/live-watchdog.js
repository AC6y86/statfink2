#!/usr/bin/env node

/**
 * Live-scoring watchdog (PM2: statfink2-watchdog, always on).
 *
 * OBSERVES ONLY. Every 2 minutes it asks the running server
 * GET /api/internal/health/live (HealthCheckService.checkLiveScoring: is
 * anything supposed to be live right now, and is data actually moving?),
 * adds what a league owner would see from outside (the public site, its
 * API, the TLS certificate, and our scores against ESPN's scoreboard), rolls
 * everything up with server/utils/liveRollup.js and appends the answer as
 * ONE JSON line to logs/watchdog/live-YYYY-MM-DD.jsonl, mirroring the last
 * line to logs/watchdog/live-latest.json for the admin dashboard. Healthy
 * checks are logged too, so a silent log is itself a signal.
 *
 * It never decides, alerts or emails. scripts/watchdog-notifier.js reads the
 * log and applies the notification policy; anything else can read it as well.
 *
 * Special lines:
 *   server_down  - the server did not answer; expectedGames is filled from a
 *                  read-only DB open so the line still says whether it matters.
 *                  The public-site signals are still gathered (they are what
 *                  matters then) but server_reachable keeps the status.
 *   public_path_unreachable
 *                - the server answers on localhost but the watchdog's own
 *                  probe of the public hostname failed. This probe runs ON
 *                  the VM, so it is NOT proof of an external outage: the
 *                  network diagnostics (scripts/lib/netDiag.js) say which
 *                  layer broke. Severity warning when the VM's own resolver
 *                  cannot resolve the hostname (a VM DNS problem), critical
 *                  when the name resolves but TCP / TLS / HTTP fails
 *                  (nginx, certificate, upstream - confirm from outside).
 *                  Replaces the old `site_down`, which claimed too much.
 *                  The server's own critical verdicts (misconfigured,
 *                  stalled) always outrank it (server/utils/liveRollup.js).
 *   maintenance  - logs/maintenance.lock exists (nightly tests stop the live
 *                  services on purpose); severity warning if the lock is stale.
 *                  No probes during maintenance.
 *
 * Script-side signals (scripts/lib/siteSanity.js): public_site,
 * public_api_fresh, tls_cert every tick; scores_vs_espn only while games are
 * in the live window. PUBLIC_SITE_URL overrides https://peninsulafootball.com.
 * Network-path diagnostics (scripts/lib/netDiag.js) every tick: dns_system,
 * dns_gateway (192.168.1.1), dns_public (1.1.1.1, 9.9.9.9), tcp_public,
 * tls_public; WATCHDOG_GATEWAY_DNS / WATCHDOG_PUBLIC_DNS / WATCHDOG_PUBLIC_IP /
 * WATCHDOG_DNS_TIMEOUT_MS / WATCHDOG_CONNECT_TIMEOUT_MS override them.
 * Budget: the whole tick stays under ~15 s (8 s site, 8 s ESPN, 2 s per DNS
 * query, 5 s TCP + 5 s TLS, all concurrent).
 *
 * Manual usage:
 *   node scripts/live-watchdog.js --once            # one check, log it, print the line, exit
 *   node scripts/live-watchdog.js --once --dry-run  # one check, print only (nothing written)
 */

const path = require('path');
const axios = require('axios');
const sqlite3 = require('sqlite3');
const wl = require('./lib/watchdogLog');
const siteSanity = require('./lib/siteSanity');
const netDiag = require('./lib/netDiag');
const watchdogChecks = require('../server/config/watchdogChecks.json');
const espnClient = require('./lib/espnClient');
const { rollUpLive, clampSummary } = require('../server/utils/liveRollup');

const SERVER = 'http://localhost:8000';
const INTERNAL_HEADERS = { 'X-Internal-Token': 'statfink-internal-cron' };
const INTERVAL_MS = 2 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30000;
const PROBE_TIMEOUT_MS = 8000;
const MAINTENANCE_STUCK_SEC = 30 * 60;
const LOG_RETENTION_DAYS = 30;
const DB_PATH = path.resolve(wl.REPO, process.env.DATABASE_PATH || 'fantasy_football.db');
const ESPN_CACHE_FILE = path.join(wl.WATCHDOG_DIR, 'espn-scoreboard.json');

const ONCE = process.argv.includes('--once');
const DRY_RUN = process.argv.includes('--dry-run');

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * When the server is down the endpoint cannot tell us whether games are on.
 * Open the DB read-only (safe under WAL, never blocks the writer) just to
 * count games in the live window. null when even that fails.
 */
function countExpectedGamesReadOnly() {
    return new Promise(resolve => {
        const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, err => {
            if (err) return resolve(null);
            const now = Math.floor(Date.now() / 1000);
            db.get(`
                SELECT COUNT(*) AS n
                FROM nfl_games ng
                JOIN league_settings ls ON ls.league_id = 1
                WHERE ng.season = ls.season_year
                  AND COALESCE(ng.status, 'Scheduled') NOT LIKE 'Final%'
                  AND ng.game_time_epoch BETWEEN ? AND ?
            `, [now - 4 * 3600, now + 15 * 60], (e, row) => {
                db.close(() => resolve(e || !row ? null : row.n));
            });
        });
    });
}

/**
 * Pure: the watchdog line from what this tick observed.
 *   serverData           the `data` object from /api/internal/health/live, or null
 *   serverError          why the server did not answer (string) when serverData is null
 *   maintenanceLockAgeSec  age of logs/maintenance.lock, or null when absent
 *   expectedGames        read-only DB count used on the server_down branch (null = unknown)
 *   extraSignals         script-side signals (siteSanity); ignored during maintenance
 *   now                  ms
 * durationMs is added by the caller.
 */
function buildEntry({ serverData = null, serverError = null, maintenanceLockAgeSec = null,
    expectedGames = null, extraSignals = [], now = Date.now() } = {}) {
    const ts = new Date(now).toISOString();
    const extra = Array.isArray(extraSignals) ? extraSignals : [];

    if (maintenanceLockAgeSec !== null) {
        const lockAgeSec = maintenanceLockAgeSec;
        const stuck = lockAgeSec > MAINTENANCE_STUCK_SEC;
        return {
            ts,
            status: 'maintenance',
            severity: stuck ? 'warning' : 'ok',
            maintenance: true,
            lockAgeSec,
            signals: [],
            summary: stuck
                ? `logs/maintenance.lock is ${Math.round(lockAgeSec / 60)}m old (limit ${MAINTENANCE_STUCK_SEC / 60}m) - nightly tests may be stuck with the live services stopped`
                : `Maintenance window (logs/maintenance.lock, ${lockAgeSec}s old) - checks skipped`
        };
    }

    if (serverData) {
        // The server answered, so local app health is known. A failed
        // public_site is then a SELF-probe of the VM's own public hostname:
        // let the network diagnostics say which layer broke (and downgrade
        // the signal to warning when it is the VM's own DNS) before rolling
        // up. The status itself is decided by rollUpLive, where the server's
        // own verdicts (misconfigured, stalled) outrank the self-probe and a
        // failed probe alone is public_path_unreachable (never site_down).
        const { signals: annotated, explanation } = netDiag.annotatePublicProbe(extra);
        const signals = [...(serverData.signals || []), ...annotated];
        const live = (serverData.expectedGames || 0) > 0;
        const rolled = rollUpLive(signals, {
            live,
            expectedGames: serverData.expectedGames,
            inProgress: serverData.gamesInProgress,
            loopAgeSec: serverData.loopAgeSec === undefined ? null : serverData.loopAgeSec
        });
        return { ts, ...serverData, ...rolled, signals, maintenance: false, ...(explanation ? { publicPathLayer: explanation.layer } : {}) };
    }

    // server_down: the script's own signal first; the probes still tell whether
    // the public side is affected. server_reachable keeps the status.
    const detail = serverError || 'no response';
    const gamesNote = expectedGames === null
        ? ''
        : expectedGames > 0
            ? `; ${expectedGames} game(s) in the live window`
            : '; no games in the live window';
    const reachable = {
        name: 'server_reachable',
        ok: false,
        severity: 'critical',
        detail: `GET /api/internal/health/live failed: ${detail}`
    };
    const signals = [reachable, ...extra];
    const { status, severity } = rollUpLive(signals, { live: (expectedGames || 0) > 0, expectedGames, inProgress: 0, loopAgeSec: null });
    const otherFailing = extra.filter(s => !s.ok).map(s => s.detail);
    const summary = clampSummary([`statfink2 server unreachable (${detail})${gamesNote}`, ...otherFailing].join('; '));
    return { ts, status, severity, expectedGames, maintenance: false, signals, summary };
}

/**
 * Script-side signals. Never throws: a bug in a probe becomes a warning
 * signal on the line instead of a missing line.
 */
async function gatherExtraSignals({ season, week, expectedGames, now, baseUrl }) {
    const live = (expectedGames || 0) > 0;
    const tasks = [
        siteSanity.probePublicSite({ baseUrl, season, week, live, now, timeoutMs: PROBE_TIMEOUT_MS, checkDisplayedWeek: watchdogChecks.checkDisplayedWeek !== false })
            .catch(e => [{ name: 'public_site', ok: false, severity: 'warning', detail: `probe threw: ${e.message}` }]),
        netDiag.probeNetworkPath({ baseUrl })
            .catch(e => netDiag.SIGNAL_NAMES.map(name => ({ name, ok: false, severity: 'warning', detail: `probe threw: ${e.message}` })))
    ];
    if (live && season && week) {
        tasks.push(scoresSignal({ season, week, now }).then(s => [s])
            .catch(e => [{ name: 'scores_vs_espn', ok: false, severity: 'warning', detail: `comparison threw: ${e.message}` }]));
    } else {
        tasks.push(Promise.resolve([siteSanity.compareScoresToEspn({ live: false })]));
    }
    const groups = await Promise.all(tasks);
    return groups.flat();
}

async function scoresSignal({ season, week, now }) {
    const [events, games] = await Promise.all([
        siteSanity.fetchScoreboardCached({ season, week, cacheFile: ESPN_CACHE_FILE, now, timeoutMs: PROBE_TIMEOUT_MS }),
        siteSanity.readWeekGamesReadOnly(DB_PATH, season, week)
    ]);
    if (!games) return { name: 'scores_vs_espn', ok: true, detail: 'nfl_games unavailable (read-only open failed)' };
    const matches = events ? espnClient.matchEventsToGames(events, games).matches : null;
    return siteSanity.compareScoresToEspn({ matches, nflGames: games, now, live: true });
}

async function check({ dryRun = DRY_RUN } = {}) {
    const started = Date.now();
    const ts = new Date(started).toISOString();
    const maintenanceLockAgeSec = wl.maintenanceLockAgeSec();
    let entry;

    if (maintenanceLockAgeSec !== null) {
        entry = buildEntry({ maintenanceLockAgeSec, now: started });
    } else {
        const baseUrl = process.env.PUBLIC_SITE_URL || siteSanity.DEFAULT_BASE_URL;
        let serverData = null;
        let serverError = null;
        let expectedGames = null;
        let season = null;
        let week = null;
        try {
            const response = await axios.get(`${SERVER}/api/internal/health/live`, {
                headers: INTERNAL_HEADERS,
                timeout: REQUEST_TIMEOUT_MS
            });
            const data = response.data && response.data.data;
            if (!data || !data.status || !data.severity) {
                throw new Error('unexpected response shape from /api/internal/health/live');
            }
            serverData = data;
            expectedGames = data.expectedGames || 0;
            season = data.season || null;
            week = data.week || null;
        } catch (error) {
            serverError = error.response ? `HTTP ${error.response.status}` : error.message;
            const [count, current] = await Promise.all([countExpectedGamesReadOnly(), siteSanity.readLeagueWeekReadOnly(DB_PATH)]);
            expectedGames = count;
            if (current) ({ season, week } = current);
        }
        const extraSignals = await gatherExtraSignals({ season, week, expectedGames, now: started, baseUrl });
        entry = buildEntry({ serverData, serverError, expectedGames, extraSignals, now: started });
    }

    entry.durationMs = Date.now() - started;
    if (dryRun) {
        log('DRY RUN - line not written');
    } else {
        try {
            wl.appendEntry(entry);
        } catch (error) {
            console.error(`[${ts}] Failed to write watchdog log: ${error.message}`);
        }
    }
    log(`${entry.status}/${entry.severity} ${entry.summary}`);
    return entry;
}

async function main() {
    if (!DRY_RUN) {
        const pruned = wl.pruneOldLogs(LOG_RETENTION_DAYS);
        if (pruned.length) log(`Pruned ${pruned.length} watchdog log file(s) older than ${LOG_RETENTION_DAYS} days`);
    }

    if (ONCE) {
        const entry = await check();
        console.log(JSON.stringify(entry, null, 2));
        return;
    }

    log(`Live watchdog started (every ${INTERVAL_MS / 1000}s, logging to ${wl.WATCHDOG_DIR})`);
    await check();
    setInterval(() => check().catch(err => console.error(`[${new Date().toISOString()}] check failed: ${err.message}`)), INTERVAL_MS);
}

module.exports = {
    buildEntry,
    gatherExtraSignals,
    countExpectedGamesReadOnly,
    check,
    MAINTENANCE_STUCK_SEC,
    PROBE_TIMEOUT_MS,
    ESPN_CACHE_FILE
};

if (require.main === module) {
    for (const signal of ['SIGTERM', 'SIGINT']) {
        process.on(signal, () => {
            log(`Received ${signal}, shutting down`);
            process.exit(0);
        });
    }

    main().catch(err => {
        console.error(`[${new Date().toISOString()}] Fatal: ${err.message}`);
        process.exit(1);
    });
}
