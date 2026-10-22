'use strict';

/**
 * Shared driver for the Double Check's deterministic layer, used by the daily
 * cron (scripts/doublecheck-daily.js) and by scripts/weekly-validate.js.
 *
 *   pickTargetWeek(games, currentWeek)      -> the most recent week <= currentWeek with a Final game
 *   weekSignature(games, week, standings)   -> string that changes when a new game goes final / scores move
 *   runDoubleCheck({season, week, trigger, offline, refresh, email}) -> { ok, status, error }
 *
 * Runs scripts/doublecheck-data.js (read-only DB + ESPN) then
 * scripts/doublecheck-finalize.js --script-only, and returns the status object
 * written to logs/doublecheck-latest.json.
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const sqlite3 = require('sqlite3');

const REPO = path.join(__dirname, '../..');
const DB_PATH = process.env.DATABASE_PATH || path.join(REPO, 'fantasy_football.db');
const LATEST_FILE = path.join(process.env.DOUBLECHECK_STATUS_DIR || path.join(REPO, 'logs'), 'doublecheck-latest.json');

function isFinal(status) { return /^Final/i.test(String(status || '')); }

/** Most recent week (<= currentWeek) that has at least one Final game; null if none. */
function pickTargetWeek(games, currentWeek) {
    const cw = Number(currentWeek) || 99;
    let best = null;
    for (const g of games || []) {
        if (!isFinal(g.status) || Number(g.week) > cw) continue;
        if (best === null || Number(g.week) > best) best = Number(g.week);
    }
    return best;
}

/** Changes whenever a game goes final, a final score moves, or standings for the week appear. */
function weekSignature(games, week, standingsRows = 0) {
    const finals = (games || []).filter(g => Number(g.week) === Number(week) && isFinal(g.status))
        .map(g => `${g.game_id}:${g.home_score}-${g.away_score}`).sort();
    return `wk${week}|${finals.join(',')}|standings=${standingsRows}`;
}

const all = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
const get = (db, sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));

/** Read-only look at the league: current season/week, this season's games, standings row count per week. */
async function readLeagueState(dbPath = DB_PATH) {
    const db = await new Promise((res, rej) => { const d = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, e => (e ? rej(e) : res(d))); });
    try {
        const settings = await get(db, 'SELECT season_year, current_week FROM league_settings LIMIT 1') || {};
        const season = Number(settings.season_year), currentWeek = Number(settings.current_week);
        const games = await all(db, 'SELECT game_id, week, status, home_score, away_score FROM nfl_games WHERE season = ?', [season]);
        const standings = await all(db, 'SELECT week, COUNT(*) AS n FROM weekly_standings WHERE season = ? GROUP BY week', [season]);
        return { season, currentWeek, games, standingsByWeek: Object.fromEntries(standings.map(r => [r.week, r.n])) };
    } finally {
        await new Promise(res => db.close(res));
    }
}

function runNode(args, timeoutMs) {
    const res = spawnSync(process.execPath, args, { cwd: REPO, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: process.env });
    return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', timedOut: !!res.error && /ETIMEDOUT/.test(res.error.code || '') };
}

/**
 * Deterministic double check for one week. Never throws; returns
 * { ok, status (logs/doublecheck-latest.json contents or null), error, dataLog }.
 */
function runDoubleCheck({ season, week, trigger = 'daily', offline = false, refresh = true, email = false, timeoutMs = 10 * 60 * 1000 } = {}) {
    const dataArgs = [path.join(REPO, 'scripts/doublecheck-data.js'), String(season), String(week), '--quiet'];
    if (offline) dataArgs.push('--offline');
    if (refresh) dataArgs.push('--refresh');
    const data = runNode(dataArgs, timeoutMs);
    if (data.status !== 0) {
        return { ok: false, status: null, error: `doublecheck-data exit ${data.status}${data.timedOut ? ' (timeout)' : ''}: ${(data.stderr || data.stdout).trim().split('\n').slice(-5).join(' | ')}` };
    }
    const finArgs = [path.join(REPO, 'scripts/doublecheck-finalize.js'), String(season), String(week), '--script-only', '--trigger', trigger, '--quiet'];
    if (email) finArgs.push('--email');
    const fin = runNode(finArgs, 5 * 60 * 1000);
    if (fin.status === 2) {
        return { ok: false, status: null, error: `doublecheck-finalize exit 2: ${(fin.stderr || fin.stdout).trim().split('\n').slice(-5).join(' | ')}` };
    }
    let status = null;
    try { status = JSON.parse(fs.readFileSync(LATEST_FILE, 'utf8')); } catch (e) {
        return { ok: false, status: null, error: `could not read ${LATEST_FILE}: ${e.message}` };
    }
    return { ok: true, status, error: null };
}

/** Compact, email-safe lines describing a status object. */
function summaryLines(status) {
    if (!status) return ['Double check did not run.'];
    const c = status.counts || {};
    const comp = status.completeness || {};
    const L = [
        `${status.overallStatus} — ${status.season} week ${status.week} (${comp.gamesFinal}/${comp.gamesTotal} games final, standings ${comp.standingsPresent ? 'present' : 'not yet written'})`,
        `FAIL ${c.FAIL || 0}, WARN ${c.WARN || 0}, DEFER ${c.DEFER || 0}, INFO ${c.INFO || 0}, result flips ${c.flips || 0}`
    ];
    const findings = Array.isArray(status.findings) ? status.findings : [];
    const flips = findings.filter(f => f.flipsResult);
    if (flips.length) { L.push('RESULT FLIPS:'); for (const f of flips) L.push(`  - ${f.explanation}`); }
    const fails = findings.filter(f => f.severity === 'FAIL' && !f.flipsResult);
    if (fails.length) { L.push('FAIL:'); for (const f of fails.slice(0, 25)) L.push(`  - [${f.bugClassRef}] ${f.explanation}`); if (fails.length > 25) L.push(`  ... and ${fails.length - 25} more`); }
    const warns = findings.filter(f => f.severity === 'WARN');
    if (warns.length) { L.push(`WARN (${warns.length}):`); for (const f of warns.slice(0, 15)) L.push(`  - [${f.bugClassRef}] ${f.explanation}`); if (warns.length > 15) L.push(`  ... and ${warns.length - 15} more`); }
    if (comp.deferred && comp.deferred.length) L.push(`Deferred checks: ${comp.deferred.join(', ')}`);
    if (status.reportFile) L.push(`Report: ${status.reportFile}`);
    return L;
}

module.exports = { pickTargetWeek, weekSignature, readLeagueState, runDoubleCheck, summaryLines, isFinal, LATEST_FILE };
