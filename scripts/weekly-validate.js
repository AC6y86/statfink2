#!/usr/bin/env node
/**
 * Manual validation of a specific week (no cron, no email).
 *
 * The Tuesday cron that used to run this was folded into the daily update
 * (scripts/daily-update.js runs FULL validation every day and writes
 * logs/weekly-validation-latest.json when the week is complete). Use this
 * tool to (re)generate the validation record for an older week — e.g. so the
 * recap pipeline's gate (scripts/recap-data.js) accepts it.
 *
 *   node scripts/weekly-validate.js --week N [--season Y] [--no-latest]
 *
 * --no-latest   write only logs/status/validation.json, not weekly-validation-latest.json
 */
const axios = require('axios');
const { buildValidationStatus, writeValidationFiles } = require('./lib/validationStatus');

const SERVER = 'http://localhost:8000';
const INTERNAL_HEADERS = { 'X-Internal-Token': 'statfink-internal-cron' };
const args = process.argv.slice(2);
const argValue = f => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const week = argValue('--week') ? parseInt(argValue('--week'), 10) : null;
const season = argValue('--season') ? parseInt(argValue('--season'), 10) : null;
const writeLatest = !args.includes('--no-latest');

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

async function main() {
    const body = {};
    if (week) body.week = week;
    if (season) body.season = season;
    const response = await axios.post(`${SERVER}/api/internal/health/validate`, body, {
        headers: { 'Content-Type': 'application/json', ...INTERNAL_HEADERS }, timeout: 15 * 60 * 1000
    });
    const health = response.data.data;
    if (health.skipped) { log(`Skipped: no games for week ${health.week}/${health.season}`); return; }
    const status = buildValidationStatus({ health, completion: health.completion || null, trigger: 'manual', mode: 'full' });
    const complete = !!(health.completion && health.completion.isComplete);
    const w = writeValidationFiles(status, { weekComplete: writeLatest && complete });
    log(`Validation ${status.overallStatus} for ${status.season} week ${status.week}: ${health.summary.passed} passed, ${health.summary.failed} failed, ${health.summary.warnings} warnings` +
        `${w.latestWritten ? ' — weekly-validation-latest.json updated' : complete ? '' : ' (week not complete: weekly-validation-latest.json untouched)'}`);
    for (const c of health.checks || []) if (c.status !== 'passed') log(`  [${c.status.toUpperCase()}] ${c.name}: ${c.message}`);
    if (status.overallStatus === 'FAIL') process.exitCode = 1;
}

main().catch(err => { console.error(`weekly-validate failed: ${err.message}`); process.exit(1); });
