#!/usr/bin/env node

/**
 * Live-scoring watchdog (PM2: statfink2-watchdog, always on).
 *
 * OBSERVES ONLY. Every 2 minutes it asks the running server
 * GET /api/internal/health/live (HealthCheckService.checkLiveScoring: is
 * anything supposed to be live right now, and is data actually moving?) and
 * appends the answer as ONE JSON line to logs/watchdog/live-YYYY-MM-DD.jsonl,
 * mirroring the last line to logs/watchdog/live-latest.json for the admin
 * dashboard. Healthy checks are logged too, so a silent log is itself a signal.
 *
 * It never decides, alerts or emails. scripts/watchdog-notifier.js reads the
 * log and applies the notification policy; anything else can read it as well.
 *
 * Special lines:
 *   server_down  - the server did not answer; expectedGames is filled from a
 *                  read-only DB open so the line still says whether it matters
 *   maintenance  - logs/maintenance.lock exists (nightly tests stop the live
 *                  services on purpose); severity warning if the lock is stale
 *
 * Manual usage:
 *   node scripts/live-watchdog.js --once     # one check, print the line, exit
 */

const path = require('path');
const axios = require('axios');
const sqlite3 = require('sqlite3');
const wl = require('./lib/watchdogLog');

const SERVER = 'http://localhost:8000';
const INTERNAL_HEADERS = { 'X-Internal-Token': 'statfink-internal-cron' };
const INTERVAL_MS = 2 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30000;
const MAINTENANCE_STUCK_SEC = 30 * 60;
const LOG_RETENTION_DAYS = 30;
const DB_PATH = path.resolve(wl.REPO, process.env.DATABASE_PATH || 'fantasy_football.db');

const ONCE = process.argv.includes('--once');

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

async function check() {
    const started = Date.now();
    const ts = new Date(started).toISOString();
    const lockAgeSec = wl.maintenanceLockAgeSec();
    let entry;

    if (lockAgeSec !== null) {
        const stuck = lockAgeSec > MAINTENANCE_STUCK_SEC;
        entry = {
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
    } else {
        try {
            const response = await axios.get(`${SERVER}/api/internal/health/live`, {
                headers: INTERNAL_HEADERS,
                timeout: REQUEST_TIMEOUT_MS
            });
            const data = response.data && response.data.data;
            if (!data || !data.status || !data.severity) {
                throw new Error('unexpected response shape from /api/internal/health/live');
            }
            entry = { ts, ...data, maintenance: false };
        } catch (error) {
            const detail = error.response ? `HTTP ${error.response.status}` : error.message;
            const expectedGames = await countExpectedGamesReadOnly();
            const gamesNote = expectedGames === null
                ? ''
                : expectedGames > 0
                    ? `; ${expectedGames} game(s) in the live window`
                    : '; no games in the live window';
            entry = {
                ts,
                status: 'server_down',
                severity: 'critical',
                expectedGames,
                maintenance: false,
                signals: [{
                    name: 'server_reachable',
                    ok: false,
                    severity: 'critical',
                    detail: `GET /api/internal/health/live failed: ${detail}`
                }],
                summary: `statfink2 server unreachable (${detail})${gamesNote}`
            };
        }
    }

    entry.durationMs = Date.now() - started;
    try {
        wl.appendEntry(entry);
    } catch (error) {
        console.error(`[${ts}] Failed to write watchdog log: ${error.message}`);
    }
    log(`${entry.status}/${entry.severity} ${entry.summary}`);
    return entry;
}

async function main() {
    const pruned = wl.pruneOldLogs(LOG_RETENTION_DAYS);
    if (pruned.length) log(`Pruned ${pruned.length} watchdog log file(s) older than ${LOG_RETENTION_DAYS} days`);

    if (ONCE) {
        const entry = await check();
        console.log(JSON.stringify(entry, null, 2));
        return;
    }

    log(`Live watchdog started (every ${INTERVAL_MS / 1000}s, logging to ${wl.WATCHDOG_DIR})`);
    await check();
    setInterval(() => check().catch(err => console.error(`[${new Date().toISOString()}] check failed: ${err.message}`)), INTERVAL_MS);
}

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
