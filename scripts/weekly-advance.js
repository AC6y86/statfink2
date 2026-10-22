#!/usr/bin/env node
'use strict';

/**
 * Weekly advance (automatic since 2026-09-15; replaces scripts/weekly-update-check.js).
 *
 * pm2 `statfink2-weekly-advance` runs this Wednesday 15:00 UTC (8am PDT) with a
 * Thursday 15:00 UTC retry, ~9 h before the next kickoff. It gives the league
 * all of Tuesday and Wednesday morning to review the completed week, then runs
 * the weekly update: standings -> advance current_week -> copy rosters
 * (POST /api/internal/scheduler/weekly; the server refuses while any game of
 * the current week is not Final, and the roster copy refuses unless every team
 * has exactly 19 active players).
 *
 * Guards (each writes logs/status/weekly-advance.json so /admin/status shows it):
 *   - logs/HOLD-ADVANCE exists          -> skipped (warning): you are holding the week
 *   - week not complete / no games      -> skipped (ok)
 *   - no validation of THIS week        -> held (warning): run the daily / weekly-validate first
 *   - validation FAIL or WARN           -> held (warning): review and advance by hand
 *   - update ran with errors            -> critical
 *
 * Flags: --dry-run (decide, print, exit)   --force (advance despite validation WARN/FAIL/missing)
 *        --hold "reason" (create logs/HOLD-ADVANCE)   --release (remove it)
 */

const fs = require('fs');
const path = require('path');
const { writeJobStatus } = require('./lib/jobStatus');

const REPO = path.join(__dirname, '..');
const VALIDATION_FILE = path.join(REPO, 'logs/weekly-validation-latest.json');
const HOLD_FILE = path.join(REPO, 'logs/HOLD-ADVANCE');
const BASE_URL = process.env.STATFINK_BASE_URL || 'http://localhost:8000';
const INTERNAL_HEADERS = { 'Content-Type': 'application/json', 'X-Internal-Token': 'statfink-internal-cron' };
const JOB = 'weekly-advance';

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

/**
 * Pure decision: should the weekly update run for the current settings?
 * Returns { action: 'advance' } or { action: 'skip', status, summary }.
 */
function decide({ settings, validation, hold, completion = null, force = false }) {
    const season = settings && Number(settings.season_year);
    const week = settings && Number(settings.current_week);
    if (!season || !week) return { action: 'skip', status: 'warning', summary: 'League settings have no season/current_week' };
    if (week >= 18) return { action: 'skip', status: 'ok', summary: `Week ${week} is the final week — nothing to advance to` };
    if (completion && !completion.complete) {
        return { action: 'skip', status: 'ok',
            summary: completion.total === 0 ? `${season} week ${week}: no games scheduled (offseason?)` : `${season} week ${week}: ${completion.finals}/${completion.total} final — nothing to advance yet` };
    }
    if (hold) {
        return { action: 'skip', status: 'warning',
            summary: `Held by you: ${hold.reason || 'logs/HOLD-ADVANCE present'} — advance from /admin/thisweek or run weekly-advance.js --release` };
    }
    if (force) return { action: 'advance', forced: true };

    const forThisWeek = validation && Number(validation.season) === season && Number(validation.week) === week;
    if (!forThisWeek) {
        return { action: 'skip', status: 'warning',
            summary: `No validation of ${season} week ${week} yet (last: ${validation ? `${validation.season} week ${validation.week}` : 'none'}) — run the daily update or scripts/weekly-validate.js, then advance` };
    }
    if (validation.overallStatus !== 'PASS') {
        return { action: 'skip', status: 'warning',
            summary: `Validation ${validation.overallStatus} for ${season} week ${week} — review /admin/status, then advance by hand or re-run with --force` };
    }
    return { action: 'advance', forced: false };
}

async function fetchJson(url, opts = {}) {
    const res = await fetch(url, { ...opts, headers: { ...INTERNAL_HEADERS, ...(opts.headers || {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok && body.success === undefined) throw new Error(`${url} -> HTTP ${res.status}`);
    return body;
}

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const force = args.includes('--force');

    if (args.includes('--release')) {
        try { fs.unlinkSync(HOLD_FILE); log('Hold released'); } catch (_) { log('No hold to release'); }
        return 0;
    }
    if (args.includes('--hold')) {
        const reason = args[args.indexOf('--hold') + 1] || 'held from the command line';
        fs.writeFileSync(HOLD_FILE, JSON.stringify({ reason, at: new Date().toISOString() }, null, 2) + '\n');
        log(`Hold set: ${reason}`);
        return 0;
    }

    const started = Date.now();
    log(`Weekly advance starting${dryRun ? ' (dry run)' : ''}${force ? ' (FORCED)' : ''}`);

    let settings;
    try {
        const body = await fetchJson(`${BASE_URL}/api/league/settings`);
        settings = body.data;
    } catch (err) {
        const summary = `Server unreachable: ${err.message}`;
        log(summary);
        if (!dryRun) writeJobStatus(JOB, { status: 'critical', summary, durationMs: Date.now() - started, link: '/admin/thisweek' });
        return 1;
    }

    const season = Number(settings.season_year);
    const week = Number(settings.current_week);
    let completion = null;
    try {
        const body = await fetchJson(`${BASE_URL}/api/nfl-games/${week}/${season}`);
        const games = Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : [];
        const finals = games.filter(g => /^Final/.test(g.status || '')).length;
        completion = { total: games.length, finals, complete: games.length > 0 && finals === games.length };
    } catch (err) {
        log(`Could not read week ${week} games (${err.message}); letting the server decide`);
    }
    const hold = fs.existsSync(HOLD_FILE) ? (readJson(HOLD_FILE) || { reason: 'logs/HOLD-ADVANCE present' }) : null;
    const validation = readJson(VALIDATION_FILE);
    const decision = decide({ settings, validation, hold, completion, force });

    if (decision.action === 'skip') {
        log(`Skipped: ${decision.summary}`);
        if (!dryRun) writeJobStatus(JOB, { status: decision.status, summary: decision.summary, season, week, durationMs: Date.now() - started, link: '/admin/thisweek' });
        return 0;
    }

    if (dryRun) {
        log(`Would advance ${season} week ${week} -> ${week + 1}${decision.forced ? ' (forced)' : ` (validation PASS at ${validation.runAt})`}`);
        return 0;
    }

    log(`Advancing ${season} week ${week} -> ${week + 1}${decision.forced ? ' (forced)' : ''}`);
    let body;
    try {
        body = await fetchJson(`${BASE_URL}/api/internal/scheduler/weekly`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(5 * 60 * 1000) });
    } catch (err) {
        const summary = `Weekly update request failed: ${err.message}`;
        log(summary);
        writeJobStatus(JOB, { status: 'critical', summary, season, week, durationMs: Date.now() - started, link: '/admin/thisweek' });
        return 1;
    }

    const r = (body.data && body.data.results) || {};
    const errors = r.errors || [];
    if (!body.success && !r.weekAdvance) {
        // The server declined (games still in progress, already running, ...): nothing changed.
        const notComplete = /Not all games complete/i.test(body.message || '');
        const summary = notComplete ? `${body.message} — week ${week} still in progress` : `Weekly update declined: ${body.message}`;
        log(summary);
        writeJobStatus(JOB, { status: notComplete ? 'ok' : 'warning', summary, season, week, durationMs: Date.now() - started, link: '/admin/thisweek', details: { response: body.data || null } });
        return 0;
    }

    const parts = [`standings ${r.standings ? 'ok' : 'FAILED'}`, `advance ${r.weekAdvance ? 'ok' : 'FAILED'}`, `rosters ${r.rosterCopy ? 'copied' : 'NOT copied'}`];
    const summary = `${r.weekAdvance ? `Advanced to week ${week + 1}` : `Advance FAILED (week ${week})`} · ${parts.join(' · ')}${errors.length ? ` · ${errors.join('; ')}` : ''}${decision.forced ? ' · forced' : ''}`;
    log(summary);
    writeJobStatus(JOB, { status: errors.length || !r.weekAdvance ? 'critical' : 'ok', summary, season, week, durationMs: Date.now() - started, link: '/admin/thisweek',
        details: { standings: !!r.standings, weekAdvance: !!r.weekAdvance, rosterCopy: !!r.rosterCopy, errors, forced: decision.forced, validationRunAt: validation ? validation.runAt : null } });
    return errors.length ? 1 : 0;
}

module.exports = { decide, HOLD_FILE };

if (require.main === module) {
    main().then(code => process.exit(code)).catch(err => { log(`Weekly advance crashed: ${err.message}`); writeJobStatus(JOB, { status: 'critical', summary: `crashed: ${err.message}`, link: '/admin/thisweek' }); process.exit(1); });
}
