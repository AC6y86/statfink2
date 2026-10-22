#!/usr/bin/env node
/**
 * Daily update (PM2 cron: statfink2-daily, 13:00 UTC).
 *
 * POSTs /api/internal/scheduler/daily (backup first, then sync games, players,
 * injuries, weekly report, FULL health validation) and records the outcome:
 *   - logs/status/daily.json        job status for /admin/status
 *   - logs/status/validation.json   the validation checks (state, not alerts)
 *   - logs/weekly-validation-latest.json ONLY when the current week is complete
 *     (this is what the recap pipeline gates on: "last validated completed week")
 * Never emails. A failed Week Advance Deadline shows as critical on /admin/status.
 */
const axios = require('axios');
const { writeJobStatus } = require('./lib/jobStatus');
const { buildValidationStatus, writeValidationFiles } = require('./lib/validationStatus');

const log = msg => console.log(`[${new Date().toISOString()}] ${msg}`);

async function runDailyUpdate() {
    const t0 = Date.now();
    writeJobStatus('daily', { status: 'running', summary: 'daily update in progress' });
    try {
        log('Starting daily update...');
        const response = await axios.post('http://localhost:8000/api/internal/scheduler/daily', {}, {
            headers: { 'Content-Type': 'application/json', 'X-Internal-Token': 'statfink-internal-cron' },
            timeout: 300000
        });
        const data = response.data && response.data.data ? response.data.data : {};
        const results = data.results || data || {};
        log(`Daily update completed: ${JSON.stringify({ backup: results.backup, errors: results.errors, gamesProcessed: results.gamesProcessed })}`);

        const health = results.validation || null;
        const completion = results.completion || (health && health.completion) || null;
        const errors = Array.isArray(results.errors) ? results.errors : [];
        const failedChecks = health ? (health.checks || []).filter(c => c.status === 'failed').map(c => c.name) : [];
        const deadline = health ? (health.checks || []).find(c => c.name === 'Week Advance Deadline') : null;

        if (health) {
            const status = buildValidationStatus({ health, completion, trigger: 'daily', mode: 'full' });
            const w = writeValidationFiles(status, { weekComplete: !!(completion && completion.isComplete) });
            log(`Validation ${status.overallStatus} for ${status.season} week ${status.week}${w.latestWritten ? ' (week complete: weekly-validation-latest.json updated)' : ''}`);
        }

        const status = errors.length || failedChecks.length ? 'critical' : 'ok';
        const summary = [
            `backup ${results.backup ? 'ok' : 'FAILED'}`,
            errors.length ? `${errors.length} error(s): ${errors.join('; ').slice(0, 200)}` : 'sync ok',
            health ? `validation ${health.summary.passed} passed / ${health.summary.failed} failed / ${health.summary.warnings} warnings` : 'no validation',
            deadline && deadline.status === 'failed' ? 'ADVANCE THE WEEK' : null
        ].filter(Boolean).join(' · ');
        writeJobStatus('daily', { status, summary, season: health ? health.season : null, week: health ? health.week : null, durationMs: Date.now() - t0,
            details: { errors, failedChecks, backup: results.backup, advanceDeadline: deadline ? { status: deadline.status, message: deadline.message } : null } });
        process.exit(0);
    } catch (error) {
        log(`Daily update failed: ${error.message}`);
        if (error.response) log(`Response ${error.response.status}: ${JSON.stringify(error.response.data).slice(0, 300)}`);
        writeJobStatus('daily', { status: 'critical', summary: `daily update failed: ${error.message}`, durationMs: Date.now() - t0 });
        process.exit(1);
    }
}

runDailyUpdate();
