#!/usr/bin/env node

/**
 * Weekly validation run (PM2 cron: statfink2-weekly-validate, Tuesday mornings
 * after MNF, before the manual weekly update).
 *
 * 1. Runs the full health validation of the current (just-completed, not yet
 *    advanced) week via the running server's internal endpoint.
 * 2. Runs the deep ESPN verification suite (tests/verification) as a child
 *    process - read-only against the DB, safe alongside live services.
 * 3. Writes logs/weekly-validation-latest.json (+ capped history) for the
 *    admin dashboard.
 * 4. ALWAYS emails joe.paley@gmail.com a summary - PASS or FAIL - so a silent
 *    week means the cron itself is broken.
 *
 * The weekly update (standings/advance/roster copy) stays MANUAL: review this
 * report, then trigger the update from /admin/dashboard.
 *
 * Manual usage:
 *   node scripts/weekly-validate.js [--week N] [--season Y] [--no-email] [--skip-verification]
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { sendGmail } = require('./lib/gmailSend');

const REPO = path.join(__dirname, '..');
const NOTIFY_EMAIL = 'joe.paley@gmail.com';
const SERVER = 'http://localhost:8000';
const INTERNAL_HEADERS = { 'X-Internal-Token': 'statfink-internal-cron' };
const LATEST_FILE = path.join(REPO, 'logs/weekly-validation-latest.json');
const HISTORY_FILE = path.join(REPO, 'logs/weekly-validation-history.json');
const HISTORY_CAP = 60;
// Offseason runs produce a one-line SKIPPED email; set false to silence them.
const SEND_OFFSEASON_EMAIL = true;

const args = process.argv.slice(2);
function argValue(flag) {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
}
const OPTS = {
    week: argValue('--week') ? parseInt(argValue('--week')) : null,
    season: argValue('--season') ? parseInt(argValue('--season')) : null,
    email: !args.includes('--no-email'),
    verification: !args.includes('--skip-verification')
};

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function runHealthValidation() {
    const body = {};
    if (OPTS.week) body.week = OPTS.week;
    if (OPTS.season) body.season = OPTS.season;

    const response = await axios.post(`${SERVER}/api/internal/health/validate`, body, {
        headers: { 'Content-Type': 'application/json', ...INTERNAL_HEADERS },
        timeout: 15 * 60 * 1000
    });
    return response.data.data;
}

function runVerificationSuite(season, week) {
    log(`Running deep verification suite for ${season} week ${week}`);
    const res = spawnSync('npx', [
        'jest', '--config', 'jest.config.slow.js',
        '--selectProjects', 'verification', '--runInBand'
    ], {
        cwd: REPO,
        encoding: 'utf8',
        env: { ...process.env, TEST_SEASON: String(season), TEST_WEEK: String(week) },
        timeout: 25 * 60 * 1000,
        maxBuffer: 64 * 1024 * 1024
    });

    const output = `${res.stdout || ''}\n${res.stderr || ''}`;
    const summaryLine = (output.match(/^Tests:.*$/m) || [null])[0];

    let reports = [];
    try {
        reports = fs.readdirSync('/tmp/verification-reports').filter(f => f.endsWith('.csv'));
    } catch (_) { /* no reports dir */ }

    return {
        ran: true,
        exitCode: res.status,
        passed: res.status === 0,
        summaryLine,
        reports,
        outputTail: output.split('\n').slice(-60).join('\n')
    };
}

function computeOverallStatus(health, verification) {
    if (health.skipped) return 'SKIPPED';
    if (health.overallStatus === 'failed') return 'FAIL';
    if (verification && verification.ran && !verification.passed) return 'FAIL';
    if ((health.summary && health.summary.warnings > 0) ||
        (health.completion && !health.completion.isComplete)) return 'WARN';
    return 'PASS';
}

function writeStatusFile(status) {
    fs.mkdirSync(path.dirname(LATEST_FILE), { recursive: true });
    fs.writeFileSync(LATEST_FILE, JSON.stringify(status, null, 2));

    let history = [];
    try {
        history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        if (!Array.isArray(history)) history = [];
    } catch (_) { /* missing or corrupt: start fresh */ }
    history.push({
        runAt: status.runAt,
        season: status.season,
        week: status.week,
        overallStatus: status.overallStatus,
        healthSummary: status.healthValidation?.summary || null,
        verificationPassed: status.verificationSuite?.ran ? status.verificationSuite.passed : null
    });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-HISTORY_CAP), null, 2));
}

function buildEmail(status) {
    const subject = `statfink2 weekly validation ${status.overallStatus} — ` +
        (status.week ? `${status.season} week ${status.week}` : `${status.season || ''}`.trim() || 'no week');

    const lines = [
        `Weekly validation run at ${status.runAt}`,
        ''
    ];

    if (status.overallStatus === 'SKIPPED') {
        lines.push(`SKIPPED: no games scheduled for week ${status.week}/${status.season} (offseason).`);
        return { subject, body: lines.join('\n') };
    }

    if (status.overallStatus === 'ERROR') {
        lines.push('ERROR: the validation run itself failed.');
        lines.push(status.error || 'unknown error');
        return { subject, body: lines.join('\n') };
    }

    const gc = status.gamesComplete;
    if (gc) {
        lines.push(`Games: ${gc.completedGames}/${gc.totalGames} final${gc.isComplete ? '' : '  << NOT ALL FINAL'}`);
        lines.push('');
    }

    lines.push('HEALTH VALIDATION');
    lines.push('-----------------');
    for (const check of status.healthValidation?.checks || []) {
        const tag = check.status === 'passed' ? 'PASS' : check.status === 'warning' ? 'WARN' : 'FAIL';
        lines.push(`[${tag}] ${check.name}: ${check.message}`);
        if (tag !== 'PASS') {
            for (const d of (check.details || []).slice(0, 10)) {
                lines.push(`    - ${typeof d === 'string' ? d : JSON.stringify(d)}`);
            }
        }
    }
    lines.push('');

    lines.push('DEEP VERIFICATION (ESPN cross-check)');
    lines.push('------------------------------------');
    const v = status.verificationSuite;
    if (!v || !v.ran) {
        lines.push('Skipped.');
    } else {
        lines.push(v.passed ? `PASS — ${v.summaryLine || 'suite green'}` : `FAIL (exit ${v.exitCode}) — ${v.summaryLine || ''}`);
        if (v.reports.length) lines.push(`Reports in /tmp/verification-reports/: ${v.reports.join(', ')}`);
        if (!v.passed) {
            lines.push('', 'Last 60 lines of output:', v.outputTail);
        }
    }
    lines.push('');
    lines.push(`Next step: if this looks good, run the weekly update from ${SERVER}/admin/dashboard to advance the week.`);

    return { subject, body: lines.join('\n') };
}

async function main() {
    log('Weekly validation starting');
    const startTime = Date.now();

    const status = {
        schemaVersion: 1,
        runAt: new Date().toISOString(),
        trigger: process.env.PM2_HOME ? 'cron' : 'manual',
        season: OPTS.season,
        week: OPTS.week,
        gamesComplete: null,
        overallStatus: 'ERROR',
        healthValidation: null,
        verificationSuite: null,
        durationMs: 0,
        error: null,
        email: { sent: false, to: NOTIFY_EMAIL, error: null }
    };

    try {
        const health = await runHealthValidation();
        status.week = health.week;
        status.season = health.season;
        status.gamesComplete = health.completion || null;

        if (health.skipped) {
            status.overallStatus = 'SKIPPED';
            log(`Skipped: no games for week ${health.week}/${health.season} (offseason)`);
        } else {
            status.healthValidation = {
                overallStatus: health.overallStatus,
                summary: health.summary,
                checks: health.checks
            };
            log(`Health validation: ${health.summary.passed} passed, ${health.summary.failed} failed, ${health.summary.warnings} warnings`);

            if (OPTS.verification) {
                status.verificationSuite = runVerificationSuite(health.season, health.week);
                log(`Verification suite: ${status.verificationSuite.passed ? 'PASSED' : `FAILED (exit ${status.verificationSuite.exitCode})`}`);
            }

            status.overallStatus = computeOverallStatus(health, status.verificationSuite);
        }
    } catch (error) {
        status.error = error.message;
        status.overallStatus = 'ERROR';
        log(`Weekly validation error: ${error.message}`);
    }

    status.durationMs = Date.now() - startTime;

    const shouldEmail = OPTS.email &&
        (status.overallStatus !== 'SKIPPED' || SEND_OFFSEASON_EMAIL);

    if (shouldEmail) {
        const { subject, body } = buildEmail(status);
        try {
            await sendGmail({ to: NOTIFY_EMAIL, subject, body });
            status.email.sent = true;
            log(`Report emailed to ${NOTIFY_EMAIL}: ${subject}`);
        } catch (error) {
            status.email.error = error.message;
            const fallback = path.join(REPO, 'logs', `weekly-validation-email-failure-${Date.now()}.log`);
            try {
                fs.mkdirSync(path.join(REPO, 'logs'), { recursive: true });
                fs.writeFileSync(fallback, `${subject}\n\n${body}`);
            } catch (_) { /* logging only */ }
            log(`FAILED to send email (${error.message}). Report saved to ${fallback}`);
            log('If this is a scope error, re-authorize with: node roster_moves/authSetup.js');
            process.exitCode = 1;
        }
    } else {
        log('Email skipped');
    }

    try {
        writeStatusFile(status);
        log(`Status written to ${LATEST_FILE}`);
    } catch (error) {
        log(`Failed to write status file: ${error.message}`);
        process.exitCode = 1;
    }

    log(`Weekly validation finished: ${status.overallStatus} (${Math.round(status.durationMs / 1000)}s)`);
    if (status.overallStatus === 'ERROR') process.exitCode = 1;
}

main().catch(err => {
    log(`Fatal error in weekly validation: ${err.message}`);
    process.exitCode = 1;
});
