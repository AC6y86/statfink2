#!/usr/bin/env node

/**
 * Weekly recap generation run (PM2 cron: statfink2-weekly-recaps, Tuesday
 * 10:30 UTC — 30 minutes after statfink2-weekly-validate writes its report).
 *
 * 1. Reads logs/weekly-validation-latest.json to find the just-validated
 *    season/week; skips cleanly off-season, on stale validation, or if the
 *    week's recaps already exist.
 * 2. Drives the /recap slash command headlessly via `claude -p` in --auto
 *    mode: digest -> storylines -> 10 never-before-used styles (all-time
 *    exclusion via scripts/recap-styles-used.js) -> 10 narrator agents ->
 *    fact-check. Reads the DB read-only; writes only recaps/ and logs/.
 * 3. Verifies the output files on disk and writes
 *    logs/weekly-recaps-latest.json (+ capped history) for the admin
 *    dashboard's Recaps tab.
 * 4. Emails joe.paley@gmail.com ONLY on failure (success is visible on
 *    /admin; the weekly validation email already covers the happy path).
 *
 * Nothing here commits to git — new recap files are left for a manual commit.
 *
 * Manual usage:
 *   node scripts/weekly-recap-run.js [--season Y --week N] [--force]
 *       [--force-regenerate] [--dry-run] [--no-email]
 *   --force            relax the validation-status/staleness guards
 *                      (passes --force to recap-data via the /recap prompt)
 *   --force-regenerate ignore "already generated" (picks 10 NEW styles; never
 *                      overwrites existing recap files)
 *   --dry-run          run the guards, print the claude command, exit
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { sendGmail } = require('./lib/gmailSend');
const { parseRecapFilename, parseFactcheckReport, weekPad } = require('../server/utils/recapFiles');

const REPO = path.join(__dirname, '..');
const NOTIFY_EMAIL = 'joe.paley@gmail.com';
const VALIDATION_FILE = path.join(REPO, 'logs/weekly-validation-latest.json');
const LATEST_FILE = path.join(REPO, 'logs/weekly-recaps-latest.json');
const HISTORY_FILE = path.join(REPO, 'logs/weekly-recaps-history.json');
const HISTORY_CAP = 52;
const VALIDATION_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const CLAUDE_TIMEOUT_MS = 30 * 60 * 1000;
const EXPECTED_RECAPS = 10;

const args = process.argv.slice(2);
function argValue(flag) {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
}
const OPTS = {
    season: argValue('--season') ? parseInt(argValue('--season')) : null,
    week: argValue('--week') ? parseInt(argValue('--week')) : null,
    force: args.includes('--force'),
    forceRegenerate: args.includes('--force-regenerate'),
    dryRun: args.includes('--dry-run'),
    email: !args.includes('--no-email')
};

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

function weekRecapFiles(season, week) {
    const dir = path.join(REPO, 'recaps', String(season));
    const prefix = `${season}-week${weekPad(week)}-`;
    try {
        return fs.readdirSync(dir).filter(f => f.startsWith(prefix) && parseRecapFilename(f));
    } catch (_) {
        return [];
    }
}

function factcheckPath(season, week) {
    return path.join(REPO, 'recaps', String(season), 'data', `week${weekPad(week)}-factcheck.md`);
}

/** Decide season/week and whether to run at all. Returns {season, week} or {skip: reason, notify?, fail?}. */
function resolveTarget() {
    if (OPTS.season && OPTS.week) return { season: OPTS.season, week: OPTS.week };
    if (OPTS.season || OPTS.week) return { skip: 'Pass BOTH --season and --week (or neither)', fail: true };

    let validation;
    try {
        validation = JSON.parse(fs.readFileSync(VALIDATION_FILE, 'utf8'));
    } catch (err) {
        return { skip: `No readable weekly validation report (${err.message}) — off-season or validate never ran` };
    }
    if (!validation.season || !validation.week) {
        return { skip: 'Weekly validation report has no season/week' };
    }
    const age = Date.now() - Date.parse(validation.runAt || 0);
    if (!OPTS.force && (isNaN(age) || age > VALIDATION_MAX_AGE_MS)) {
        return { skip: `Weekly validation report is stale (runAt ${validation.runAt}) — off-season` };
    }
    if (!OPTS.force && validation.overallStatus === 'FAIL') {
        return {
            skip: `Weekly validation FAILED for ${validation.season} week ${validation.week} — not generating recaps from bad data`,
            notify: true, fail: true
        };
    }
    if (!OPTS.force && validation.overallStatus === 'SKIPPED') {
        return { skip: `Weekly validation was SKIPPED (off-season)` };
    }
    return { season: validation.season, week: validation.week };
}

function buildClaudeArgs(season, week) {
    const force = OPTS.force ? ' --force' : '';
    // --auto: no approval pauses; --force is only ever injected here by a human-run flag
    const prompt = `/recap ${season} ${week} --auto${force ? '\n\nI explicitly accept generating from unvalidated data: re-run recap-data with --force if it refuses.' : ''}`;
    return [
        '-p', prompt,
        '--output-format', 'json',
        '--model', 'sonnet',
        '--max-turns', '100',
        '--allowedTools',
        'Read', 'Write', 'Glob', 'Grep', 'Task', 'WebSearch', 'TodoWrite',
        'Bash(node scripts/recap-data.js:*)',
        'Bash(node scripts/recap-styles-used.js:*)',
        'Bash(mkdir:*)'
    ];
}

function runClaude(claudeArgs) {
    return new Promise((resolve) => {
        const proc = spawn('claude', claudeArgs, {
            cwd: REPO,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            proc.kill('SIGKILL');
        }, CLAUDE_TIMEOUT_MS);

        proc.stdout.on('data', d => { stdout += d; });
        proc.stderr.on('data', d => { stderr += d; });
        proc.on('error', err => {
            clearTimeout(timer);
            resolve({ exitCode: null, error: `Failed to spawn claude: ${err.message}` });
        });
        proc.on('close', code => {
            clearTimeout(timer);
            if (timedOut) {
                resolve({ exitCode: code, error: `claude timed out after ${CLAUDE_TIMEOUT_MS / 60000} minutes` });
                return;
            }
            let envelope = null;
            try {
                envelope = JSON.parse(stdout);
            } catch (_) { /* non-JSON output */ }
            resolve({
                exitCode: code,
                envelope,
                error: code !== 0
                    ? `claude exited ${code}: ${(stderr || stdout).slice(-2000)}`
                    : (envelope && envelope.is_error ? `claude reported error: ${String(envelope.result).slice(-2000)}` : null)
            });
        });
    });
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
        styleCount: status.styles ? status.styles.length : 0,
        factcheckFails: status.styles
            ? status.styles.filter(s => s.factcheck === 'FAIL').length
            : null
    });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-HISTORY_CAP), null, 2));
}

function buildFailureEmail(status) {
    const subject = `statfink2 weekly recaps ${status.overallStatus} — ` +
        (status.week ? `${status.season} week ${status.week}` : 'no week');
    const lines = [
        `Weekly recap run at ${status.runAt}`,
        '',
        `Status: ${status.overallStatus}`,
        status.reason ? `Reason: ${status.reason}` : null,
        status.error ? `Error: ${status.error}` : null,
        ''
    ].filter(l => l !== null);
    if (status.styles && status.styles.length) {
        lines.push('Generated recaps:');
        for (const s of status.styles) {
            lines.push(`  [${s.factcheck || '?'}] ${s.slug}`);
        }
        lines.push('');
    }
    lines.push('Details: http://localhost:8000/admin/dashboard#recaps');
    lines.push('Manual re-run: node scripts/weekly-recap-run.js --force-regenerate');
    return { subject, body: lines.join('\n') };
}

async function main() {
    log('Weekly recap run starting');
    const startTime = Date.now();

    const status = {
        schemaVersion: 1,
        runAt: new Date().toISOString(),
        trigger: process.env.PM2_HOME ? 'cron' : 'manual',
        season: null,
        week: null,
        overallStatus: 'ERROR',
        reason: null,
        styles: null,
        factcheckFile: null,
        claude: null,
        durationMs: 0,
        error: null,
        email: { sent: false, to: NOTIFY_EMAIL, error: null }
    };
    let notify = false;

    const target = resolveTarget();
    if (target.skip) {
        status.overallStatus = 'SKIPPED';
        status.reason = target.skip;
        notify = !!target.notify;
        if (target.fail) process.exitCode = 1;
        log(`Skipped: ${target.skip}`);
    } else {
        status.season = target.season;
        status.week = target.week;

        const preExisting = weekRecapFiles(target.season, target.week);
        const alreadyDone = preExisting.length >= EXPECTED_RECAPS || fs.existsSync(factcheckPath(target.season, target.week));
        if (alreadyDone && !OPTS.forceRegenerate) {
            status.overallStatus = 'SKIPPED';
            status.reason = `Recaps already generated for ${target.season} week ${target.week} ` +
                `(${preExisting.length} files). Use --force-regenerate to add another batch.`;
            log(`Skipped: ${status.reason}`);
        } else if (OPTS.dryRun) {
            const claudeArgs = buildClaudeArgs(target.season, target.week);
            status.overallStatus = 'SKIPPED';
            status.reason = 'dry run';
            log(`Dry run for ${target.season} week ${target.week}. Would exec:`);
            log(`claude ${claudeArgs.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
        } else {
            // Mark the run in progress so the dashboard shows it live
            writeStatusFile({ ...status, overallStatus: 'RUNNING' });
            log(`Generating recaps for ${target.season} week ${target.week} (headless claude, ${preExisting.length} pre-existing files)`);

            const result = await runClaude(buildClaudeArgs(target.season, target.week));
            status.claude = {
                exitCode: result.exitCode,
                durationMs: result.envelope?.duration_ms ?? null,
                numTurns: result.envelope?.num_turns ?? null,
                costUsd: result.envelope?.total_cost_usd ?? null
            };

            const preSet = new Set(preExisting);
            const newFiles = weekRecapFiles(target.season, target.week).filter(f => !preSet.has(f));
            let factcheck = {};
            try {
                factcheck = parseFactcheckReport(fs.readFileSync(factcheckPath(target.season, target.week), 'utf8'));
                status.factcheckFile = path.relative(REPO, factcheckPath(target.season, target.week));
            } catch (_) { /* no factcheck report produced */ }

            status.styles = newFiles.map(f => {
                const { slug } = parseRecapFilename(f);
                return {
                    slug,
                    file: path.join('recaps', String(target.season), f),
                    factcheck: factcheck[slug]?.verdict || null
                };
            });

            if (result.error) {
                status.overallStatus = 'ERROR';
                status.error = result.error;
                notify = true;
            } else if (newFiles.length < EXPECTED_RECAPS) {
                status.overallStatus = 'FAIL';
                status.error = `Expected ${EXPECTED_RECAPS} new recap files, found ${newFiles.length}`;
                notify = true;
            } else if (!status.factcheckFile) {
                status.overallStatus = 'FAIL';
                status.error = 'No fact-check report was produced';
                notify = true;
            } else if (status.styles.some(s => s.factcheck !== 'PASS')) {
                status.overallStatus = 'FAIL';
                status.error = 'One or more recaps failed (or is missing from) the fact-check';
                notify = true;
            } else {
                status.overallStatus = 'PASS';
            }
            log(`Generation finished: ${status.overallStatus} — ${newFiles.length} new files` +
                (status.error ? ` (${status.error})` : ''));
        }
    }

    status.durationMs = Date.now() - startTime;

    if (notify && OPTS.email) {
        const { subject, body } = buildFailureEmail(status);
        try {
            await sendGmail({ to: NOTIFY_EMAIL, subject, body });
            status.email.sent = true;
            log(`Failure report emailed to ${NOTIFY_EMAIL}: ${subject}`);
        } catch (error) {
            status.email.error = error.message;
            const fallback = path.join(REPO, 'logs', `weekly-recaps-email-failure-${Date.now()}.log`);
            try {
                fs.mkdirSync(path.join(REPO, 'logs'), { recursive: true });
                fs.writeFileSync(fallback, `${subject}\n\n${body}`);
            } catch (_) { /* logging only */ }
            log(`FAILED to send email (${error.message}). Report saved to ${fallback}`);
        }
    }

    if (!OPTS.dryRun) {
        try {
            writeStatusFile(status);
            log(`Status written to ${LATEST_FILE}`);
        } catch (error) {
            log(`Failed to write status file: ${error.message}`);
            process.exitCode = 1;
        }
    }

    log(`Weekly recap run finished: ${status.overallStatus} (${Math.round(status.durationMs / 1000)}s)`);
    if (status.overallStatus === 'ERROR' || status.overallStatus === 'FAIL') process.exitCode = 1;
}

main().catch(err => {
    log(`Fatal error in weekly recap run: ${err.message}`);
    process.exitCode = 1;
});
