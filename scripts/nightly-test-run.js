#!/usr/bin/env node

/**
 * Nightly regression test run (PM2 cron: statfink2-nightly-tests, 12:00 UTC).
 *
 * Runs the fast suite and the 2024+2025 golden scoring regression. The slow
 * suite RECALCULATES both seasons from cache, so it runs against a consistent
 * COPY of the league database (sqlite .backup -> logs/nightly/, passed to jest
 * as STATFINK_SLOW_DB); the official record is never rewritten by a test and
 * the live services keep running. Never emails: the outcome is written to
 * logs/status/nightly-tests.json for /admin/status (a failure turns it red)
 * and failing suite output is saved to logs/nightly-test-failure-<ts>.log.
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { writeJobStatus } = require('./lib/jobStatus');

const REPO = path.join(__dirname, '..');
// The golden-record regression RECALCULATES 2024/2025 from cache. Since
// 2026-09-13 it does so in a consistent COPY of the league database
// (sqlite .backup), never in fantasy_football.db itself - so a bug in a recalc
// path can no longer rewrite the official record unattended, and the live
// services no longer need to be stopped for it.
const FAST_DB_COPY = path.join(REPO, 'logs/nightly/fantasy_football.db.fast');
const SLOW_DB_COPY = path.join(REPO, 'logs/nightly/fantasy_football.db.nightly');
const SUITES = [
    // The Jest config uses child projects, which do not inherit the root setup
    // hook. Be explicit here: run serially against a disposable seeded copy so
    // legacy data-integrity tests still have their fixtures, while concurrent
    // workers can never lock or write the official league database.
    { name: 'fast (unit + integration)', cmd: path.join(REPO, 'node_modules/.bin/jest'),
        // --silent suppresses delayed console output from legacy fire-and-forget
        // service initialization; test failures and their stack traces remain.
        args: ['--config', 'jest.config.js', '--runInBand', '--silent'],
        env: { NODE_ENV: 'production', DATABASE_PATH: FAST_DB_COPY } },
    { name: '2024+2025 scoring regression (on a DB copy)', cmd: 'npm', args: ['run', 'test:integration:slow'], env: { STATFINK_SLOW_DB: SLOW_DB_COPY } }
];

function makeDbCopies() {
    fs.mkdirSync(path.dirname(SLOW_DB_COPY), { recursive: true });
    removeDbCopies();
    // .backup is transactionally consistent even while the live services write (WAL)
    execSync(`sqlite3 "${path.join(REPO, 'fantasy_football.db')}" ".backup '${SLOW_DB_COPY}'"`, { stdio: 'pipe', timeout: 300000 });
    // The slow regression must start pristine even if a legacy fast test writes
    // to its database, so give the fast suite a separate copy of the snapshot.
    fs.copyFileSync(SLOW_DB_COPY, FAST_DB_COPY);
    const size = fs.statSync(SLOW_DB_COPY).size;
    log(`Database copies for fast and regression suites: ${FAST_DB_COPY}, ${SLOW_DB_COPY} (${(size / 1e6).toFixed(0)} MB each)`);
}

function removeDbCopies() {
    for (const dbPath of [FAST_DB_COPY, SLOW_DB_COPY]) {
        for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.unlinkSync(f); } catch (_) { /* absent */ } }
    }
}

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

function runSuite(suite) {
    log(`Running suite: ${suite.name}`);
    const res = spawnSync(suite.cmd, suite.args, {
        env: { ...process.env, ...(suite.env || {}) },
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

async function main() {
    log('Nightly test run starting');
    const startedAt = Date.now();
    const results = [];
    writeJobStatus('nightly-tests', { status: 'running', summary: 'nightly tests running (on a DB copy; services stay up)' });

    // Services keep running: the fast suite uses a throwaway DB and the slow
    // suite a copy of the league DB (see SLOW_DB_COPY).
    try {
        makeDbCopies();
        for (const suite of SUITES) {
            results.push(runSuite(suite));
        }
    } catch (err) {
        log(`Could not prepare the regression run: ${err.message}`);
        results.push({ name: 'setup', passed: false, output: String(err.message) });
    } finally {
        removeDbCopies();
    }

    const failures = results.filter(r => !r.passed);
    const durationMs = Date.now() - startedAt;
    if (failures.length === 0) {
        log('All suites passed.');
        writeJobStatus('nightly-tests', { status: 'ok', summary: `${results.length} suite(s) passed`, durationMs,
            details: { suites: results.map(r => ({ name: r.name, passed: true })) } });
        return;
    }

    // No email (dashboard-only by policy): persist the failing output and mark
    // the job critical so /admin/status turns red.
    const fallback = path.join(REPO, 'logs', `nightly-test-failure-${Date.now()}.log`);
    try {
        fs.mkdirSync(path.join(REPO, 'logs'), { recursive: true });
        fs.writeFileSync(fallback, failures.map(f => `${f.name}\n${f.output}`).join('\n\n'));
    } catch (_) { /* logging only */ }
    log(`${failures.length} suite(s) failed — details saved to ${fallback}`);
    writeJobStatus('nightly-tests', { status: 'critical', summary: `${failures.map(f => f.name).join(', ')} FAILED (${results.length - failures.length} passed) — see ${path.basename(fallback)}`, durationMs,
        details: { suites: results.map(r => ({ name: r.name, passed: r.passed })), failureLog: fallback,
            tails: Object.fromEntries(failures.map(f => [f.name, f.output.split('\n').slice(-40).join('\n')])) } });
    process.exitCode = 1;
}

main().catch(err => {
    log(`Fatal error in nightly test run: ${err.message}`);
    removeDbCopies();
    writeJobStatus('nightly-tests', { status: 'critical', summary: `nightly run crashed: ${err.message}` });
    process.exitCode = 1;
});
