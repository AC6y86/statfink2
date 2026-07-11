#!/usr/bin/env node

/**
 * Nightly regression test run (PM2 cron: statfink2-nightly-tests).
 *
 * Runs the fast suite and the 2024+2025 scoring regression suites, and emails
 * joe.paley@gmail.com ONLY if something fails. Green runs are silent (logged
 * to pm2 logs only).
 *
 * The slow suites recalculate both seasons and need exclusive DB access, so
 * the other pm2 services are stopped for the duration and restarted after.
 *
 * Email uses the roster_moves Gmail OAuth credentials/token. Sending requires
 * the gmail.send scope — if the token predates that scope, re-run:
 *   node roster_moves/authSetup.js
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const REPO = path.join(__dirname, '..');
const NOTIFY_EMAIL = 'joe.paley@gmail.com';
const PM2_SERVICES = ['statfink2', 'statfink2-live-continuous', 'statfink2-email-poller'];
const SUITES = [
    { name: 'fast (unit + integration)', cmd: 'npm', args: ['run', 'test:fast'] },
    { name: '2024+2025 scoring regression', cmd: 'npm', args: ['run', 'test:integration:slow'] }
];

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

function pm2(action) {
    try {
        execSync(`pm2 ${action} ${PM2_SERVICES.join(' ')}`, { stdio: 'pipe', timeout: 120000 });
        log(`pm2 ${action}: ok`);
    } catch (err) {
        log(`pm2 ${action} failed: ${err.message}`);
    }
}

function runSuite(suite) {
    log(`Running suite: ${suite.name}`);
    const res = spawnSync(suite.cmd, suite.args, {
        cwd: REPO,
        encoding: 'utf8',
        timeout: 45 * 60 * 1000,
        maxBuffer: 64 * 1024 * 1024
    });
    const output = `${res.stdout || ''}\n${res.stderr || ''}`;
    const passed = res.status === 0;
    log(`Suite '${suite.name}': ${passed ? 'PASSED' : `FAILED (exit ${res.status})`}`);
    return { name: suite.name, passed, output };
}

async function sendFailureEmail(failures) {
    const credentials = JSON.parse(fs.readFileSync(path.join(REPO, 'roster_moves/credentials.json')));
    const token = JSON.parse(fs.readFileSync(path.join(REPO, 'roster_moves/token.json')));
    const { client_secret, client_id, redirect_uris } = credentials.installed;
    const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    auth.setCredentials(token);
    const gmail = google.gmail({ version: 'v1', auth });

    const date = new Date().toISOString().slice(0, 10);
    const subject = `statfink2 nightly tests FAILED (${date})`;
    const sections = failures.map(f => {
        const tail = f.output.split('\n').slice(-80).join('\n');
        return `===== SUITE FAILED: ${f.name} =====\n\n(last 80 lines)\n${tail}`;
    });
    const body = [
        `Nightly test run on ${new Date().toString()} had failures.`,
        '',
        'A failure in the 2024/2025 regression suites means a scoring-logic',
        'regression (see CLAUDE.md) — the baselines are the blessed official records.',
        '',
        ...sections
    ].join('\n');

    const message = [
        `To: ${NOTIFY_EMAIL}`,
        `Subject: ${subject}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        body
    ].join('\r\n');

    const raw = Buffer.from(message).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    log(`Failure notification sent to ${NOTIFY_EMAIL}`);
}

async function main() {
    log('Nightly test run starting');
    const results = [];

    pm2('stop');
    try {
        for (const suite of SUITES) {
            results.push(runSuite(suite));
        }
    } finally {
        pm2('start');
    }

    const failures = results.filter(r => !r.passed);
    if (failures.length === 0) {
        log('All suites passed — no notification sent.');
        return;
    }

    log(`${failures.length} suite(s) failed — sending notification`);
    try {
        await sendFailureEmail(failures);
    } catch (err) {
        // Double-guard: if email fails, persist the failure locally so it isn't lost
        const fallback = path.join(REPO, 'logs', `nightly-test-failure-${Date.now()}.log`);
        try {
            fs.mkdirSync(path.join(REPO, 'logs'), { recursive: true });
            fs.writeFileSync(fallback, failures.map(f => `${f.name}\n${f.output}`).join('\n\n'));
        } catch (_) { /* logging only */ }
        log(`FAILED to send email (${err.message}). Failure details saved to ${fallback}`);
        log('If this is a scope error, re-authorize with: node roster_moves/authSetup.js');
        process.exitCode = 1;
    }
}

main().catch(err => {
    log(`Fatal error in nightly test run: ${err.message}`);
    pm2('start');
    process.exitCode = 1;
});
