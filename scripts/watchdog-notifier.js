#!/usr/bin/env node

/**
 * Live-scoring watchdog NOTIFIER (PM2 cron: statfink2-watchdog-notifier,
 * every 5 minutes).
 *
 * Reads the lines scripts/live-watchdog.js appended to
 * logs/watchdog/live-*.jsonl since the last run (byte cursor saved in
 * logs/watchdog/notifier-state.json), decides whether an incident opened,
 * escalated, needs a reminder or closed, and notifies:
 *
 *   - every transition   -> POST /api/internal/health/alert (dashboard alerts)
 *   - critical incidents -> email joe.paley@gmail.com, re-sent hourly while
 *                           open, once more on recovery with the duration
 *   - warnings           -> dashboard only (the daily 13:00 UTC email already
 *                           summarizes unacknowledged alerts)
 *
 * Policy (all thresholds about time-in-state live HERE, not in the watchdog):
 *   - an incident opens after 2 consecutive bad lines (~4 min); a single
 *     Tank01 hiccup never pages
 *   - a warning incident escalates to critical after 2 consecutive critical lines
 *   - the first ok/idle line closes it
 *   - maintenance lines (nightly tests) are ignored
 *   - no line for 15 min with no maintenance lock = the watchdog itself is dead
 *
 * Manual usage:
 *   node scripts/watchdog-notifier.js [--dry-run] [--no-email]
 *     --dry-run  print the decisions, send nothing, save no state
 *     --no-email dashboard alerts only
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const wl = require('./lib/watchdogLog');

const NOTIFY_EMAIL = 'joe.paley@gmail.com';
const SERVER = 'http://localhost:8000';
const INTERNAL_HEADERS = { 'X-Internal-Token': 'statfink-internal-cron' };
const ALERT_SOURCE = 'live-watchdog';

const OPEN_AFTER_CONSECUTIVE_BAD = 2;
const REMIND_EVERY_MS = 60 * 60 * 1000;
const WATCHDOG_SILENT_MS = 15 * 60 * 1000;

const RUNBOOK = {
    server_down: [
        'pm2 logs statfink2 --lines 100',
        'pm2 restart statfink2'
    ],
    stalled: [
        'pm2 logs statfink2-live-continuous --lines 50',
        'pm2 logs statfink2 --lines 200   (Tank01 errors? quota?)',
        'pm2 restart statfink2-live-continuous'
    ],
    misconfigured: [
        'ADVANCE THE WEEK from the admin dashboard (weekly update), or: node scripts/weekly-update-check.js',
        'Live updates only poll current_week - until you advance, the new week\'s stats are not collected'
    ],
    degraded: [
        'pm2 logs statfink2 --lines 200 | grep -i "error\\|tank01"',
        'curl -s localhost:8000/health   (Tank01 daily request count / key status)'
    ],
    watchdog_dead: [
        'pm2 logs statfink2-watchdog --lines 50',
        'pm2 restart statfink2-watchdog'
    ],
    maintenance: [
        'pm2 logs statfink2-nightly-tests --lines 50',
        'rm logs/maintenance.lock && pm2 start statfink2 statfink2-live-continuous statfink2-email-poller'
    ]
};

const SEVERITY_RANK = { ok: 0, info: 0, warning: 1, critical: 2 };

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

function isBad(line) {
    return line.severity === 'warning' || line.severity === 'critical';
}

function formatDuration(ms) {
    const min = Math.round(ms / 60000);
    if (min < 60) return `${min}m`;
    const h = Math.floor(min / 60);
    return `${h}h ${min - h * 60}m`;
}

function failingSignals(line) {
    return (line.signals || []).filter(s => !s.ok);
}

function buildEmail(kind, incident, now) {
    const line = incident.line || {};
    const since = incident.since;
    const duration = formatDuration(now - Date.parse(since));
    const status = incident.status;
    const runbook = RUNBOOK[status] || RUNBOOK.degraded;
    const failing = failingSignals(line).map(s => `  - ${s.name}: ${s.detail || 'failed'}`);
    const context = [];
    if (line.week) context.push(`week ${line.week}/${line.season}`);
    if (line.expectedGames !== undefined && line.expectedGames !== null) context.push(`${line.expectedGames} game(s) in live window`);
    if (line.gamesInProgress !== undefined) context.push(`${line.gamesInProgress} in progress`);
    if (line.loopAgeSec !== undefined && line.loopAgeSec !== null) context.push(`loop ticked ${line.loopAgeSec}s ago`);

    let subject;
    let headline;
    if (kind === 'recovered') {
        subject = `statfink2 LIVE: RECOVERED after ${duration} (${status})`;
        headline = `Live scoring recovered. The ${status} incident that opened ${since} lasted ${duration}.`;
    } else if (kind === 'reminder') {
        subject = `statfink2 LIVE: STILL ${status.toUpperCase()} for ${duration}`;
        headline = `Live scoring is still ${status} - open since ${since} (${duration}).`;
    } else if (kind === 'escalated') {
        subject = `statfink2 LIVE: CRITICAL ${status} - ${incident.summary}`.slice(0, 140);
        headline = `Live scoring incident escalated to CRITICAL (${status}); open since ${since} (${duration}).`;
    } else {
        subject = `statfink2 LIVE: CRITICAL ${status} - ${incident.summary}`.slice(0, 140);
        headline = `Live scoring is ${status.toUpperCase()} (critical) since ${since}.`;
    }

    const body = [
        headline,
        '',
        incident.summary || '',
        context.length ? `(${context.join(', ')})` : '',
        '',
        ...(kind !== 'recovered' && failing.length ? ['Failing signals:', ...failing, ''] : []),
        ...(kind !== 'recovered' ? ['What to look at:', ...runbook.map(r => `  ${r}`), ''] : []),
        `Watchdog log: logs/watchdog/${wl.dayFileName(new Date(now))}`,
        'Dashboard: /admin/dashboard -> Status tab -> Live Scoring Watchdog'
    ].join('\n');

    return { type: 'email', kind, subject, body };
}

function alertAction(severity, message, details = null) {
    return { type: 'alert', severity, message, details };
}

/**
 * Pure policy: (saved state, new lines) -> (next state, actions).
 * Actions: {type:'alert', severity, message, details} and
 *          {type:'email', kind, subject, body}.
 * The executor marks incident.lastEmailAt only after a send succeeds, so a
 * failed send is retried on the next run.
 */
function applyPolicy(state, lines, { now = Date.now(), lockAgeSec = null } = {}) {
    const s = {
        incident: null,
        badStreak: [],
        lastLineTs: null,
        ...JSON.parse(JSON.stringify(state || {}))
    };
    const actions = [];
    const nowIso = new Date(now).toISOString();

    const closeIncident = (line) => {
        const inc = s.incident;
        const duration = formatDuration(Date.parse(line ? line.ts : nowIso) - Date.parse(inc.since));
        actions.push(alertAction('info',
            `Live scoring recovered after ${duration} (${inc.status})`,
            line ? [line.summary] : null));
        if (inc.severity === 'critical') {
            actions.push(buildEmail('recovered', inc, line ? Date.parse(line.ts) : now));
        }
        s.incident = null;
        s.badStreak = [];
    };

    for (const line of lines) {
        if (!line || !line.ts) continue;
        s.lastLineTs = line.ts;

        // Nightly-test window: neither bad nor a recovery. A stale lock is
        // written as maintenance/warning and handled like any bad line.
        if (line.status === 'maintenance' && !isBad(line)) continue;

        if (!isBad(line)) {
            s.badStreak = [];
            if (s.incident) closeIncident(line);
            continue;
        }

        s.badStreak.push({ ts: line.ts, status: line.status, severity: line.severity });
        if (s.badStreak.length > 10) s.badStreak.shift();
        const lastTwo = s.badStreak.slice(-OPEN_AFTER_CONSECUTIVE_BAD);
        const details = failingSignals(line).map(sg => `${sg.name}: ${sg.detail || 'failed'}`);

        if (!s.incident) {
            if (s.badStreak.length >= OPEN_AFTER_CONSECUTIVE_BAD) {
                const severity = lastTwo.every(l => l.severity === 'critical') ? 'critical' : 'warning';
                s.incident = {
                    status: line.status,
                    severity,
                    since: s.badStreak[0].ts,
                    summary: line.summary,
                    line,
                    openedAt: nowIso,
                    lastAlertAt: nowIso,
                    lastEmailAt: null,
                    emails: 0
                };
                actions.push(alertAction(severity, `Live scoring ${line.status}: ${line.summary}`, details));
                if (severity === 'critical') actions.push(buildEmail('opened', s.incident, now));
            }
            continue;
        }

        // Open incident: track the latest picture, escalate on sustained critical
        const inc = s.incident;
        const statusChanged = inc.status !== line.status;
        inc.status = line.status;
        inc.summary = line.summary;
        inc.line = line;
        if (inc.severity !== 'critical' && lastTwo.length === OPEN_AFTER_CONSECUTIVE_BAD &&
            lastTwo.every(l => l.severity === 'critical')) {
            inc.severity = 'critical';
            inc.lastAlertAt = nowIso;
            actions.push(alertAction('critical', `Live scoring escalated to critical (${line.status}): ${line.summary}`, details));
            actions.push(buildEmail('escalated', inc, now));
        } else if (statusChanged) {
            inc.lastAlertAt = nowIso;
            actions.push(alertAction(inc.severity, `Live scoring incident now ${line.status}: ${line.summary}`, details));
        }
    }

    // Watchdog silence = the watchdog itself is dead (dead-man's switch)
    if (lockAgeSec === null && s.lastLineTs && now - Date.parse(s.lastLineTs) > WATCHDOG_SILENT_MS) {
        const silentFor = formatDuration(now - Date.parse(s.lastLineTs));
        const summary = `No watchdog log line for ${silentFor} (last ${s.lastLineTs}) - statfink2-watchdog is not running`;
        if (!s.incident || s.incident.status !== 'watchdog_dead') {
            const prior = s.incident;
            s.incident = {
                status: 'watchdog_dead',
                severity: 'critical',
                since: prior ? prior.since : s.lastLineTs,
                summary,
                line: { ts: s.lastLineTs, status: 'watchdog_dead', severity: 'critical', summary, signals: [] },
                openedAt: nowIso,
                lastAlertAt: nowIso,
                lastEmailAt: prior ? prior.lastEmailAt : null,
                emails: prior ? prior.emails : 0
            };
            actions.push(alertAction('critical', `Live watchdog silent: ${summary}`));
            actions.push(buildEmail('opened', s.incident, now));
        } else {
            s.incident.summary = summary;
            s.incident.line.summary = summary;
        }
    }

    // Critical incidents: retry a never-sent email, and remind hourly
    if (s.incident && s.incident.severity === 'critical' && !actions.some(a => a.type === 'email')) {
        const lastEmail = s.incident.lastEmailAt ? Date.parse(s.incident.lastEmailAt) : null;
        if (lastEmail === null) {
            actions.push(buildEmail('opened', s.incident, now));
        } else if (now - lastEmail >= REMIND_EVERY_MS) {
            actions.push(buildEmail('reminder', s.incident, now));
        }
    }

    return { state: s, actions };
}

// ---------- Executor ----------

async function postAlert(action) {
    await axios.post(`${SERVER}/api/internal/health/alert`, {
        severity: action.severity,
        source: ALERT_SOURCE,
        message: action.message,
        details: action.details
    }, { headers: { 'Content-Type': 'application/json', ...INTERNAL_HEADERS }, timeout: 10000 });
}

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const emailEnabled = !args.includes('--no-email');
    const now = Date.now();

    const state = wl.readJson(wl.NOTIFIER_STATE_FILE, {}) || {};
    const { lines, cursor } = wl.readLinesSince(state.cursor);
    // First run ever (or --dry-run, which never saves a cursor): don't replay
    // the whole day, just the last few lines - enough to open an incident
    // from an existing bad streak.
    const effective = state.cursor ? lines : lines.slice(-OPEN_AFTER_CONSECUTIVE_BAD);
    const lockAgeSec = wl.maintenanceLockAgeSec();

    const { state: next, actions } = applyPolicy(state, effective, { now, lockAgeSec });
    next.cursor = cursor;
    next.lastRunAt = new Date(now).toISOString();

    log(`${effective.length} new line(s)${lockAgeSec !== null ? ', maintenance lock present' : ''}; ` +
        `incident: ${next.incident ? `${next.incident.status} (${next.incident.severity}) since ${next.incident.since}` : 'none'}; ` +
        `${actions.length} action(s)${dryRun ? ' [DRY RUN]' : ''}`);

    for (const action of actions) {
        log(`ACTION ${action.type}${action.kind ? `/${action.kind}` : ''}: ${action.subject || action.message}`);
        if (dryRun) continue;

        if (action.type === 'alert') {
            try {
                await postAlert(action);
            } catch (error) {
                log(`Dashboard alert failed (${error.message}) - server down?`);
            }
        } else if (action.type === 'email') {
            if (!emailEnabled) {
                log('Email suppressed (--no-email)');
                continue;
            }
            try {
                const { sendGmail } = require('./lib/gmailSend');
                await sendGmail({ to: NOTIFY_EMAIL, subject: action.subject, body: action.body });
                log(`Emailed ${NOTIFY_EMAIL}: ${action.subject}`);
                if (next.incident) {
                    next.incident.lastEmailAt = new Date().toISOString();
                    next.incident.emails = (next.incident.emails || 0) + 1;
                }
            } catch (error) {
                const fallback = path.join(wl.WATCHDOG_DIR, `notifier-email-failure-${Date.now()}.log`);
                try {
                    wl.ensureDir();
                    fs.writeFileSync(fallback, `${action.subject}\n\n${action.body}`);
                } catch (_) { /* logging only */ }
                log(`FAILED to send email (${error.message}). Saved to ${fallback}; will retry next run.`);
                log('If this is a scope/token error, re-authorize with: node roster_moves/authSetup.js');
                process.exitCode = 1;
            }
        }
    }

    if (!dryRun) {
        wl.writeJsonAtomic(wl.NOTIFIER_STATE_FILE, next);
    }
}

module.exports = { applyPolicy, buildEmail, RUNBOOK, OPEN_AFTER_CONSECUTIVE_BAD, REMIND_EVERY_MS, WATCHDOG_SILENT_MS };

if (require.main === module) {
    main().catch(err => {
        log(`Fatal: ${err.message}`);
        process.exit(1);
    });
}
