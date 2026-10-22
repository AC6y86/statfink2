#!/usr/bin/env node
'use strict';

/**
 * Daily Double Check (PM2 cron: statfink2-doublecheck-daily, 06:00 UTC).
 *
 * Runs the deterministic Double Check (docs/DOUBLECHECK.md) for the most
 * recent week that has at least one Final game: every rostered player's stats
 * vs ESPN, lineups and matchups re-derived from the rubric, every touchdown
 * and safety classified from Tank01 + ESPN scoring plays (three-vote
 * possession + score reconciliation), one named check per historical bug
 * class. Read-only against the DB; ~25 s online.
 *
 * Then, if the run left open QUESTIONS (plays the rules cannot decide),
 * scripts/doublecheck-reconcile.js asks Claude Opus for a verdict on each and
 * finalize re-applies them; verdicts are reviewable on /admin/status.
 *
 * Writes logs/status/doublecheck.json (+ reconcile.json) for /admin/status and
 * logs/doublecheck-latest.json (+ workspace). Never emails (dashboard-only
 * policy; the watchdog notifier is the only emailer).
 *
 * - Skips the audit when nothing changed since the last run (same final games,
 *   scores, standings presence) unless --force — but still refreshes the
 *   status file so "is it running" stays true.
 * - The morning after the manual weekly update the target is the previous
 *   week with standings present, so the deferred standings checks resolve.
 *
 * Manual: node scripts/doublecheck-daily.js [--force] [--week N] [--offline] [--no-reconcile] [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pickTargetWeek, weekSignature, readLeagueState, runDoubleCheck, summaryLines } = require('./lib/doublecheckRun');
const { writeJobStatus } = require('./lib/jobStatus');

const REPO = path.join(__dirname, '..');
const STATE_FILE = path.join(REPO, 'logs/doublecheck-daily-state.json');
const RECONCILE_SCRIPT = path.join(REPO, 'scripts/doublecheck-reconcile.js');

const args = process.argv.slice(2);
const argValue = f => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const OPTS = {
    force: args.includes('--force'),
    week: argValue('--week') ? parseInt(argValue('--week'), 10) : null,
    offline: args.includes('--offline'),
    reconcile: !args.includes('--no-reconcile'),
    dryRun: args.includes('--dry-run')
};

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return {}; } }
function writeState(state) { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
/**
 * Job-status colour for a double-check verdict. INCOMPLETE only means "some
 * checks are deferred until the week completes / standings are written"; with
 * nothing found that is a normal mid-week state, not a warning.
 */
function kindOf(overall, counts = {}) {
    if (overall === 'FAIL' || overall === 'ERROR') return 'critical';
    if (overall === 'WARN') return 'warning';
    if (overall === 'INCOMPLETE') return (counts.FAIL || 0) === 0 && (counts.WARN || 0) === 0 ? 'ok' : 'warning';
    return 'ok';
}

function runReconcile(season, week) {
    if (!fs.existsSync(RECONCILE_SCRIPT)) {
        log('Reconcile script not present; open questions stay on the status page');
        return null;
    }
    const t0 = Date.now();
    writeJobStatus('reconcile', { status: 'running', summary: `asking Claude about open questions for ${season} week ${week}`, season, week });
    const res = spawnSync(process.execPath, [RECONCILE_SCRIPT, String(season), String(week), '--quiet'], { cwd: REPO, encoding: 'utf8', timeout: 20 * 60 * 1000, env: process.env });
    const out = `${res.stdout || ''}\n${res.stderr || ''}`.trim().split('\n').filter(Boolean);
    const summary = out.slice(-3).join(' | ').slice(0, 400) || `exit ${res.status}`;
    const status = res.status === 0 ? 'ok' : 'warning';
    writeJobStatus('reconcile', { status, summary, season, week, durationMs: Date.now() - t0, details: { exitCode: res.status } });
    log(`Reconcile: ${status} — ${summary}`);
    return { exitCode: res.status };
}

async function main() {
    const t0 = Date.now();
    const league = await readLeagueState();
    if (!league.season || !league.games.length) {
        log(`No games loaded for season ${league.season || '?'} — skipping (offseason)`);
        writeJobStatus('doublecheck', { status: 'skipped', summary: 'offseason: no games loaded' });
        return;
    }
    const week = OPTS.week || pickTargetWeek(league.games, league.currentWeek);
    if (!week) {
        log(`No final games yet in ${league.season} (current week ${league.currentWeek}) — skipping`);
        writeJobStatus('doublecheck', { status: 'skipped', summary: `no final games yet in ${league.season} week ${league.currentWeek}`, season: league.season, week: league.currentWeek });
        return;
    }

    const signature = weekSignature(league.games, week, league.standingsByWeek[week] || 0);
    const state = readState();
    if (!OPTS.force && state.lastSignature === signature && state.lastStatus && state.lastStatus !== 'ERROR') {
        log(`Nothing changed since ${state.lastRunAt} (${league.season} week ${week}, ${state.lastStatus}) — skipping`);
        // keep the previous verdict visible; only the heartbeat moves
        writeJobStatus('doublecheck', { status: kindOf(state.lastStatus, state.lastCounts || {}), summary: `${state.lastStatus} — unchanged since ${state.lastRunAt}${state.lastSummary ? `: ${state.lastSummary}` : ''}`,
            season: league.season, week, details: { skipped: true, lastRunAt: state.lastRunAt, openQuestions: state.openQuestions || 0 } });
        return;
    }
    if (OPTS.dryRun) { log(`Would run double check for ${league.season} week ${week}; signature ${signature}`); return; }

    log(`Double check ${league.season} week ${week} (${OPTS.offline ? 'offline' : 'online'})`);
    writeJobStatus('doublecheck', { status: 'running', summary: `auditing ${league.season} week ${week}`, season: league.season, week });
    const res = runDoubleCheck({ season: league.season, week, trigger: 'daily', offline: OPTS.offline, refresh: true, email: false });
    const status = res.status;
    const overall = res.ok ? status.overallStatus : 'ERROR';
    const lines = res.ok ? summaryLines(status) : [`ERROR: ${res.error}`];
    for (const line of lines) log(line);

    const openQuestions = res.ok && Array.isArray(status.questions) ? status.questions.filter(q => q.status === 'open').length : 0;
    let reconcile = null;
    if (openQuestions > 0 && OPTS.reconcile) reconcile = runReconcile(league.season, week);
    // re-read after reconcile (finalize rewrote latest.json)
    let final = status;
    if (reconcile) { try { final = JSON.parse(fs.readFileSync(path.join(REPO, 'logs/doublecheck-latest.json'), 'utf8')); } catch (_) { /* keep */ } }
    const finalOverall = res.ok ? final.overallStatus : 'ERROR';
    const stillOpen = res.ok && Array.isArray(final.questions) ? final.questions.filter(q => q.status === 'open').length : 0;
    const c = (final && final.counts) || {};
    const lastSummary = res.ok ? `FAIL ${c.FAIL || 0}, WARN ${c.WARN || 0}, DEFER ${c.DEFER || 0}${c.flips ? `, ${c.flips} result flip(s)` : ''}${stillOpen ? `, ${stillOpen} question(s) need a ruling` : ''}` : res.error;

    writeState({ lastRunAt: new Date().toISOString(), season: league.season, week, lastSignature: signature, lastStatus: finalOverall, lastCounts: c, lastSummary, openQuestions: stillOpen, error: res.error || null });
    writeJobStatus('doublecheck', { status: kindOf(finalOverall, c), summary: `${finalOverall === 'INCOMPLETE' && kindOf(finalOverall, c) === 'ok' ? 'OK so far (deferred until the week completes)' : finalOverall} — ${league.season} week ${week}: ${lastSummary}`, season: league.season, week, durationMs: Date.now() - t0,
        details: { counts: final && final.counts, completeness: final && final.completeness, openQuestions: stillOpen, reportFile: final && final.reportFile, error: res.error || null } });
    if (finalOverall === 'FAIL' || finalOverall === 'ERROR') process.exitCode = 1;
}

main().catch(err => { console.error(`doublecheck-daily failed: ${err.message}`); writeJobStatus('doublecheck', { status: 'critical', summary: `crashed: ${err.message}` }); process.exit(2); });
