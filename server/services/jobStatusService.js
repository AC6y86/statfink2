'use strict';

/**
 * Verification status aggregator: one snapshot of every scheduled job, the
 * live-scoring watchdog, the daily validation, the Double Check (with its
 * open questions, Opus resolutions and commissioner rulings), recaps, the
 * log sentinel's error fingerprints and alerts. Served by GET /api/admin/status and /api/internal/status and drawn
 * by helm/admin/js/areas/status.js. See docs/CRON.md "Verification status".
 *
 * Two layers so the policy is testable without a server or a live DB:
 *   readInputs({ repoRoot, statusDir, now })  -> file-derived inputs (never throws)
 *   evaluate(inputs, now)                     -> the response (pure)
 * JobStatusService.snapshot() adds the DB-derived inputs (season/week,
 * offseason, week-advance deadline, alerts) and calls evaluate().
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const jobStatus = require('../../scripts/lib/jobStatus');

const REPO_ROOT = path.join(__dirname, '../..');

const HOUR = 3600;
const DAY = 86400;

/** job -> title, human cadence, expected interval + grace (seconds). Order = display order. */
const CADENCE = {
    'live-loop': { title: 'Live scoring loop', cadence: 'every 60 s', expectedEverySec: 60, graceSec: 120 },
    watchdog: { title: 'Live watchdog', cadence: 'every 2 min', expectedEverySec: 120, graceSec: 13 * 60 },
    notifier: { title: 'Watchdog notifier', cadence: 'every 5 min', expectedEverySec: 5 * 60, graceSec: 25 * 60 },
    'email-poller': { title: 'Roster email poller', cadence: 'every 2 min', expectedEverySec: 120, graceSec: 8 * 60 },
    daily: { title: 'Daily update', cadence: 'daily 13:00 UTC', expectedEverySec: DAY, graceSec: 2 * HOUR },
    validation: { title: 'Daily validation', cadence: 'daily 13:00 UTC', expectedEverySec: DAY, graceSec: 2 * HOUR },
    doublecheck: { title: 'Double Check', cadence: 'daily 06:00 UTC', expectedEverySec: DAY, graceSec: 2 * HOUR },
    reconcile: { title: 'Question reconcile (Opus)', cadence: 'after the Double Check', expectedEverySec: DAY, graceSec: 2 * HOUR, optional: true },
    'nightly-tests': { title: 'Nightly tests', cadence: 'daily 12:00 UTC', expectedEverySec: DAY, graceSec: 2 * HOUR },
    'recap-setup': { title: 'Recap themes', cadence: 'every 30 min (proposes once the week is final)', expectedEverySec: 30 * 60, graceSec: HOUR },
    recaps: { title: 'Weekly recaps', cadence: 'on demand from /admin Recaps', expectedEverySec: 7 * DAY, graceSec: DAY, onDemand: true },
    'weekly-advance': { title: 'Weekly advance', cadence: 'Wed 15:00 UTC (retry Thu)', expectedEverySec: 7 * DAY, graceSec: 2 * DAY },
    // windowAware: only judged stale while a game is in the live window (live.expectedGames > 0);
    // outside a window the job exits `skipped` and the row is ok with reason `idle`.
    'live-review': { title: 'Live play review (Qwen)', cadence: 'every 5 min during games', expectedEverySec: 300, graceSec: 900, windowAware: true },
    'log-sentinel': { title: 'Log sentinel', cadence: 'every 10 min', expectedEverySec: 600, graceSec: 1200 }
};

/** Jobs whose staleness the maintenance lock (< 30 min) explains. */
const MAINTENANCE_JOBS = new Set(['live-loop', 'email-poller', 'watchdog']);
/** Jobs whose staleness is informational when there is no football. */
const OFFSEASON_JOBS = new Set(['live-loop', 'watchdog', 'notifier', 'recaps', 'recap-setup', 'weekly-advance']);
const MAINTENANCE_MAX_SEC = 30 * 60;
/** A Qwen diagnosis older than this is not shown (it describes a moment that has passed). */
const DIAGNOSIS_FRESH_SEC = 30 * 60;
/** The status page shows at most this many live-review rows. */
const LIVE_REVIEW_MAX_ROWS = 40;
/** ... and this many log-error fingerprints (new and spiking first). */
const LOG_ERRORS_MAX_ROWS = 50;

const AWARD_CLASSES = ['DEF_8_INT', 'DEF_8_FUMBLE', 'DEF_8_BLOCKED', 'RETURN_20_KICK', 'RETURN_20_PUNT',
    'OFF_PASS', 'OFF_RUSH', 'OFF_RECOVERY', 'SAFETY_2', 'NOT_A_SCORE'];

const RANK = { ok: 0, warning: 1, critical: 2 };
const worst = (a, b) => (RANK[b] > RANK[a] ? b : a);

// ---------- file reading (tolerant) ----------

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function mtimeMs(file) {
    try { return fs.statSync(file).mtimeMs; } catch (_) { return null; }
}

function readStatusDir(dir) {
    // Same contract as jobStatus.readAllJobStatus, for a non-default directory (tests).
    const out = {};
    let files = [];
    try { files = fs.readdirSync(dir); } catch (_) { return out; }
    for (const f of files) {
        if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
        const rec = readJson(path.join(dir, f));
        if (rec) out[f.slice(0, -5)] = rec;
    }
    return out;
}

/** questions.json / resolutions.json may be an array or { questions|resolutions: [...] } or a map. */
function asList(raw, key) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw[key])) return raw[key];
    if (typeof raw === 'object') return Object.values(raw).filter(v => v && typeof v === 'object');
    return [];
}

function byQuestionId(list) {
    const map = {};
    for (const r of list) {
        const id = r.questionId || r.id;
        if (id) map[id] = r;
    }
    return map;
}

/**
 * Everything the snapshot needs from disk. Never throws; every missing or
 * corrupt file becomes null / {} / [].
 */
// ---- pm2 process state (crashed/errored apps should be red immediately, not after their cadence lapses)
const PM2_JOB_BY_APP = Object.freeze({
    'statfink2': 'server', 'statfink2-live-continuous': 'live-loop', 'statfink2-watchdog': 'watchdog',
    'statfink2-watchdog-notifier': 'notifier', 'statfink2-email-poller': 'email-poller', 'statfink2-daily': 'daily',
    'statfink2-doublecheck-daily': 'doublecheck', 'statfink2-nightly-tests': 'nightly-tests', 'statfink2-recap-setup': 'recap-setup', 'statfink2-weekly-advance': 'weekly-advance',
    'statfink2-live-review': 'live-review', 'statfink2-log-sentinel': 'log-sentinel'
});
/** Always-on apps: "stopped" is a failure. Cron apps sit "stopped" between runs by design. */
const PM2_ALWAYS_ON = new Set(['server', 'live-loop', 'watchdog', 'email-poller']);
const PM2_CACHE_MS = 20 * 1000;
let pm2Cache = { at: 0, value: null };

/** `pm2 jlist` -> { [job]: {app, status, restarts, uptimeMs, pid} }; null when pm2 is unavailable. Cached 20 s. */
function readPm2(now = Date.now(), { execImpl = null } = {}) {
    if (!execImpl && pm2Cache.value !== null && now - pm2Cache.at < PM2_CACHE_MS) return pm2Cache.value;
    let out = null;
    try {
        const { spawnSync } = require('child_process');
        const res = (execImpl || (() => spawnSync('pm2', ['jlist'], { encoding: 'utf8', timeout: 5000 })))();
        const raw = res && typeof res.stdout === 'string' ? res.stdout : (typeof res === 'string' ? res : '');
        const start = raw.indexOf('[');
        const list = start >= 0 ? JSON.parse(raw.slice(start)) : [];
        out = {};
        for (const p of list) {
            const job = PM2_JOB_BY_APP[p.name];
            if (!job) continue;
            const env = p.pm2_env || {};
            out[job] = { app: p.name, status: env.status || 'unknown', restarts: env.restart_time ?? null,
                uptimeMs: env.pm_uptime && env.status === 'online' ? Math.max(0, now - env.pm_uptime) : null, pid: p.pid || null };
        }
    } catch (_) { out = null; }
    if (!execImpl) pm2Cache = { at: now, value: out };
    return out;
}

function readInputs({ repoRoot = REPO_ROOT, statusDir = null, now = Date.now() } = {}) {
    const dir = statusDir || (repoRoot === REPO_ROOT ? jobStatus.STATUS_DIR : path.join(repoRoot, 'logs/status'));
    const statuses = dir === jobStatus.STATUS_DIR ? jobStatus.readAllJobStatus() : readStatusDir(dir);

    const live = readJson(path.join(repoRoot, 'logs/watchdog/live-latest.json'));
    const notifier = readJson(path.join(repoRoot, 'logs/watchdog/notifier-state.json'));
    const emailPollerMtime = mtimeMs(path.join(repoRoot, 'roster_moves/last_check.json'));
    const lockMtime = mtimeMs(path.join(repoRoot, 'logs/maintenance.lock'));
    const maintenanceLockAgeSec = lockMtime === null ? null : Math.max(0, Math.floor((now - lockMtime) / 1000));

    const doublecheck = readJson(path.join(repoRoot, 'logs/doublecheck-latest.json'));
    const workspace = doublecheck && doublecheck.workspace ? String(doublecheck.workspace) : null;
    const questions = workspace ? asList(readJson(path.join(workspace, 'questions.json')), 'questions') : [];
    const resolutions = workspace ? asList(readJson(path.join(workspace, 'resolutions.json')), 'resolutions') : [];
    const rulingsRaw = readJson(path.join(repoRoot, 'logs/doublecheck/rulings.json'));
    const rulings = rulingsRaw && typeof rulingsRaw === 'object' && !Array.isArray(rulingsRaw)
        ? rulingsRaw : byQuestionId(asList(rulingsRaw, 'rulings'));

    const recaps = readJson(path.join(repoRoot, 'logs/weekly-recaps-latest.json'));
    // Fallback for `validation` until the daily job writes logs/status/validation.json
    const weeklyValidation = readJson(path.join(repoRoot, 'logs/weekly-validation-latest.json'));

    // Live play review (scripts/live-review.js): per-play Qwen votes + the watchdog diagnosis
    const liveReview = readJson(path.join(repoRoot, 'logs/live-review/latest.json'));
    const diagnosis = readJson(path.join(repoRoot, 'logs/live-review/diagnosis.json'));

    // Log sentinel (scripts/log-sentinel.js): error fingerprints from the pm2 logs
    const logErrors = readJson(path.join(repoRoot, 'logs/log-sentinel/latest.json'));

    const pm2 = readPm2(now);
    return { statuses, live, notifier, emailPollerMtime, maintenanceLockAgeSec, doublecheck, questions, resolutions, rulings, recaps, weeklyValidation, liveReview, diagnosis, logErrors, pm2 };
}

// ---------- policy (pure) ----------

const iso = ms => (ms == null || Number.isNaN(ms) ? null : new Date(ms).toISOString());
const parseTs = ts => { const ms = ts ? Date.parse(ts) : NaN; return Number.isNaN(ms) ? null : ms; };

/** When each job last ran and what it said, from the heterogeneous sources. */
function jobSources(inputs) {
    const { statuses = {}, live, notifier, emailPollerMtime } = inputs;
    const rec = job => statuses[job] || null;
    const fromRec = (job, fallback = {}) => {
        const r = rec(job);
        return r ? { lastRunMs: parseTs(r.ts), status: r.status, summary: r.summary, season: r.season, week: r.week, link: r.link, details: r.details || {} }
            : { lastRunMs: null, status: 'missing', summary: '', season: null, week: null, link: `/admin/status#${job}`, details: {}, ...fallback };
    };

    const liveTs = live ? parseTs(live.ts) : null;
    const src = {};

    // live-loop: its own heartbeat file, or the watchdog's measurement of it
    const loopRec = fromRec('live-loop');
    const loopFromWatchdog = liveTs != null && live.loopAgeSec != null ? liveTs - live.loopAgeSec * 1000 : null;
    const loopMs = Math.max(loopRec.lastRunMs || 0, loopFromWatchdog || 0) || null;
    src['live-loop'] = { ...loopRec, lastRunMs: loopMs, status: loopRec.status !== 'missing' ? loopRec.status : loopMs ? 'ok' : 'missing',
        summary: loopRec.summary || (loopFromWatchdog ? `loop ticked ${live.loopAgeSec}s before the last watchdog check` : '') };

    // watchdog: live-latest.json
    src.watchdog = live ? {
        lastRunMs: liveTs, status: ['ok', 'warning', 'critical'].includes(live.severity) ? live.severity : 'warning',
        summary: live.summary || '', season: live.season ?? null, week: live.week ?? null, link: '/admin/status#live',
        details: { liveStatus: live.status, expectedGames: live.expectedGames, gamesInProgress: live.gamesInProgress, loopAgeSec: live.loopAgeSec,
            // public_path_unreachable (or the older site_down): which layer the VM-side self-probe failed at
            ...(live.publicPathLayer ? { publicPathLayer: live.publicPathLayer } : {}) }
    } : { lastRunMs: null, status: 'missing', summary: '', season: null, week: null, link: '/admin/status#live', details: {} };

    // notifier: notifier-state.json lastRunAt (+ its status file for the email error)
    const notRec = fromRec('notifier');
    const notMs = Math.max(notRec.lastRunMs || 0, (notifier && parseTs(notifier.lastRunAt)) || 0) || null;
    const lastEmailError = notRec.details && notRec.details.lastEmailError ? notRec.details.lastEmailError : null;
    src.notifier = { ...notRec, lastRunMs: notMs, status: notRec.status !== 'missing' ? notRec.status : notMs ? 'ok' : 'missing',
        summary: notRec.summary || (notifier && notifier.incident ? `open incident: ${notifier.incident.status}` : notMs ? 'no open incident' : ''),
        details: { ...notRec.details, incident: notifier ? notifier.incident || null : null, lastEmailError } };

    // email poller: last_check.json mtime
    const epRec = fromRec('email-poller');
    const epMs = Math.max(epRec.lastRunMs || 0, emailPollerMtime || 0) || null;
    src['email-poller'] = { ...epRec, lastRunMs: epMs, status: epRec.status !== 'missing' ? epRec.status : epMs ? 'ok' : 'missing',
        summary: epRec.summary || (epMs ? 'polling Gmail' : '') };

    for (const job of ['daily', 'validation', 'doublecheck', 'reconcile', 'nightly-tests', 'recap-setup', 'recaps', 'weekly-advance', 'live-review', 'log-sentinel']) src[job] = fromRec(job);
    return src;
}

function evaluateJobs(inputs, now, { offseason, maintenance }) {
    const sources = jobSources(inputs);
    const inWindow = Boolean(inputs.live && inputs.live.expectedGames > 0);
    const jobs = [];
    for (const [job, spec] of Object.entries(CADENCE)) {
        const s = sources[job];
        if (spec.optional && !(inputs.statuses && inputs.statuses[job])) continue;
        const lastRun = s.lastRunMs;
        const ageSec = lastRun == null ? null : Math.max(0, Math.floor((now - lastRun) / 1000));
        const limitSec = spec.expectedEverySec + spec.graceSec;
        const expectedByMs = lastRun == null ? null : lastRun + limitSec * 1000;
        // On-demand jobs (a human presses the button) are never stale.
        const overdue = !spec.onDemand && s.status !== 'running' && ageSec != null && ageSec > limitSec;
        // Window-aware jobs are only expected to run while a game is in the live window.
        const stale = overdue && !(spec.windowAware && !inWindow);
        const idle = Boolean(spec.windowAware && !inWindow && s.status !== 'missing' && (overdue || s.status === 'skipped'));

        let effective;
        let reason = null;
        const p = inputs.pm2 && inputs.pm2[job] ? inputs.pm2[job] : null;
        const pm2Bad = p && (p.status === 'errored' || (PM2_ALWAYS_ON.has(job) && p.status !== 'online' && !maintenance));
        if (pm2Bad) {
            effective = 'critical'; reason = `pm2-${p.status}`;
        } else if (idle) {
            effective = 'ok'; reason = 'idle';
        } else if (stale) {
            if (maintenance && MAINTENANCE_JOBS.has(job)) { effective = 'ok'; reason = 'maintenance'; }
            else if (offseason && OFFSEASON_JOBS.has(job)) { effective = 'ok'; reason = 'offseason'; }
            else { effective = 'critical'; reason = 'stale'; }
        } else if (s.status === 'missing') {
            // No run recorded yet (first run after a deploy, or offseason): nothing to do,
            // so not a warning. Once a run exists, staleness takes over.
            effective = 'ok';
            reason = 'missing';
        } else {
            effective = s.status === 'critical' ? 'critical' : s.status === 'warning' ? 'warning' : 'ok';
        }

        jobs.push({
            job, title: spec.title, cadence: spec.cadence, expectedEverySec: spec.expectedEverySec, graceSec: spec.graceSec,
            lastRun: iso(lastRun), ageSec, expectedBy: iso(expectedByMs), stale, status: s.status, effective, reason,
            summary: s.summary || '', season: s.season ?? null, week: s.week ?? null, link: s.link || `/admin/status#${job}`, details: s.details || {},
            pm2: p
        });
    }
    return jobs;
}

function mergeQuestions(questions, resolutions, rulings) {
    const res = byQuestionId(asList(resolutions, 'resolutions'));
    const rul = rulings || {};
    return (questions || []).map(q => {
        const id = q.id || q.questionId;
        const resolution = res[id] || null;
        const ruling = rul[id] || null;
        const decided = ruling ? ruling.awardClass : resolution ? resolution.awardClass : null;
        const needsRuling = !ruling && (!resolution || resolution.confidence === 'unsure');
        return { ...q, id, resolution, ruling, decided, needsRuling };
    });
}

function summarizeDoublecheck(dc) {
    if (!dc) return null;
    const findings = (dc.findings || []).filter(f => f.severity === 'FAIL' || f.severity === 'WARN');
    return {
        ts: dc.runAt || null, runAt: dc.runAt || null, season: dc.season ?? null, week: dc.week ?? null,
        overallStatus: dc.overallStatus || null, trigger: dc.trigger || null, counts: dc.counts || {}, completeness: dc.completeness || {},
        findings, defensiveScores: Array.isArray(dc.defensiveScores) ? dc.defensiveScores : null,
        questions: dc.questions ?? null, reportFile: dc.reportFile || null, workspace: dc.workspace || null
    };
}

/**
 * The snapshot. inputs: readInputs() plus { settings: {season, week}, offseason,
 * advanceDeadline: {status, message}|null, alerts: {unacknowledged, critical, items} }.
 */
function evaluate(inputs, now = Date.now()) {
    const lockAge = inputs.maintenanceLockAgeSec;
    const maintenance = lockAge != null && lockAge < MAINTENANCE_MAX_SEC;
    const offseason = Boolean(inputs.offseason);
    const jobs = evaluateJobs(inputs, now, { offseason, maintenance });

    const alerts = { unacknowledged: 0, critical: 0, items: [], ...(inputs.alerts || {}) };
    const advanceDeadline = inputs.advanceDeadline ? { status: inputs.advanceDeadline.status, message: inputs.advanceDeadline.message } : null;
    const live = inputs.live || null;

    let overall = jobs.reduce((acc, j) => worst(acc, j.effective), 'ok');
    if (live && live.severity === 'critical' && !offseason) overall = 'critical';
    if (advanceDeadline && advanceDeadline.status === 'failed') overall = 'critical';
    if (alerts.critical > 0) overall = worst(overall, 'warning');

    const v = inputs.statuses && inputs.statuses.validation;
    let validation = v ? { ts: v.ts, status: v.status, summary: v.summary, season: v.season, week: v.week, ...(v.details || {}) } : null;
    if (!validation && inputs.weeklyValidation) {
        // logs/weekly-validation-latest.json (daily job, recap gate) in the same shape
        const w = inputs.weeklyValidation;
        const hv = w.healthValidation || {};
        validation = { ts: w.runAt || null, status: w.overallStatus === 'FAIL' ? 'critical' : w.overallStatus === 'WARN' ? 'warning' : 'ok',
            summary: w.error || '', season: w.season ?? null, week: w.week ?? null, mode: w.mode || 'full', overallStatus: w.overallStatus || null,
            gamesComplete: w.gamesComplete || null, healthSummary: hv.summary || null, checks: hv.checks || null, doubleCheck: w.doubleCheck || null, source: 'weekly-validation-latest' };
    }
    const notifierJob = jobs.find(j => j.job === 'notifier');

    // Live play review: the last 40 plays + the tick summary; a diagnosis only while it is fresh and says something
    const lr = inputs.liveReview && typeof inputs.liveReview === 'object' ? inputs.liveReview : null;
    const liveReview = lr ? {
        ts: lr.ts || null, season: lr.season ?? null, week: lr.week ?? null,
        games: Array.isArray(lr.games) ? lr.games : [],
        reviews: (Array.isArray(lr.reviews) ? lr.reviews : []).slice(-LIVE_REVIEW_MAX_ROWS),
        // The warning summary must not lose unresolved plays outside the display's last 40 rows.
        flaggedReviews: (Array.isArray(lr.reviews) ? lr.reviews : [])
            .filter(r => ['under review', 'miscredit suspected'].includes(r.status))
            .map(({ gameId, season, week, period, clock, scoringTeam, text, status }) =>
                ({ gameId, season, week, period, clock, scoringTeam, text, status })),
        summary: lr.summary && typeof lr.summary === 'object' ? lr.summary : null
    } : null;
    const d = inputs.diagnosis && typeof inputs.diagnosis === 'object' ? inputs.diagnosis : null;
    const dMs = d ? parseTs(d.ts) : null;
    const diagnosis = d && dMs != null && now - dMs <= DIAGNOSIS_FRESH_SEC * 1000 && d.severity !== 'ok' ? {
        ts: d.ts, watchdogTs: d.watchdogTs || null, status: d.status || null, severity: d.severity || 'warning',
        diagnosis: d.diagnosis || '', suggestedAction: d.suggestedAction || '', model: d.model || null
    } : null;
    // Log sentinel: the fingerprints (new -> spiking -> known, capped) + its summary
    const le = inputs.logErrors && typeof inputs.logErrors === 'object' ? inputs.logErrors : null;
    const logErrors = le ? {
        ts: le.ts || null, firstRun: Boolean(le.firstRun),
        summary: le.summary && typeof le.summary === 'object' ? le.summary : null,
        fingerprints: sortLogFingerprints(Array.isArray(le.fingerprints) ? le.fingerprints : []).slice(0, LOG_ERRORS_MAX_ROWS),
        scanned: Array.isArray(le.scanned) ? le.scanned.length : null
    } : null;
    const qwen = {
        configured: Boolean(process.env.QWEN_BASE_URL),
        model: process.env.QWEN_MODEL || null,
        reachable: liveReview && liveReview.summary && typeof liveReview.summary.qwenUnreachable === 'boolean' ? !liveReview.summary.qwenUnreachable : null
    };

    return {
        overall,
        generatedAt: iso(now),
        season: inputs.settings ? inputs.settings.season ?? null : null,
        week: inputs.settings ? inputs.settings.week ?? null : null,
        offseason,
        maintenance,
        maintenanceLockAgeSec: lockAge,
        advanceDeadline,
        jobs,
        live: { latest: live, notifier: inputs.notifier || null, lastEmailError: notifierJob ? notifierJob.details.lastEmailError || null : null },
        validation,
        doublecheck: summarizeDoublecheck(inputs.doublecheck),
        questions: mergeQuestions(inputs.questions, inputs.resolutions, inputs.rulings),
        recaps: inputs.recaps || null,
        liveReview,
        diagnosis,
        logErrors,
        qwen,
        alerts
    };
}

/** new -> spiking -> unacknowledged -> known; most recent first within a group (same order as the sentinel writes). */
function sortLogFingerprints(list) {
    const rank = f => (f.new ? 0 : f.spiking ? 1 : f.known ? 3 : 2);
    return [...list].sort((a, b) => rank(a) - rank(b) || String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
}

// ---------- service ----------

class JobStatusService {
    constructor({ db, healthCheckService = null, repoRoot = REPO_ROOT, statusDir = null } = {}) {
        this.db = db;
        this.healthCheckService = healthCheckService;
        this.repoRoot = repoRoot;
        this.statusDir = statusDir;
    }

    async settings() {
        try {
            const row = this.db.getLeagueSettings ? await this.db.getLeagueSettings()
                : await this.db.get('SELECT season_year, current_week FROM league_settings WHERE league_id = 1');
            return row ? { season: row.season_year, week: row.current_week } : { season: null, week: null };
        } catch (_) { return { season: null, week: null }; }
    }

    /** No games at all this season, or none within a week of now: nothing for the live jobs to do. */
    async isOffseason(season, now) {
        if (season == null) return true;
        try {
            const row = await this.db.get(`
                SELECT COUNT(*) AS total,
                       SUM(CASE WHEN game_time_epoch IS NOT NULL AND ABS(game_time_epoch - ?) <= ? THEN 1 ELSE 0 END) AS near
                FROM nfl_games WHERE season = ?`, [Math.floor(now / 1000), 7 * DAY, season]);
            return !row || !row.total || !row.near;
        } catch (_) { return false; }
    }

    async snapshot(now = Date.now()) {
        const inputs = readInputs({ repoRoot: this.repoRoot, statusDir: this.statusDir, now });
        const settings = await this.settings();
        inputs.settings = settings;
        inputs.offseason = await this.isOffseason(settings.season, now);

        inputs.advanceDeadline = null;
        inputs.alerts = { unacknowledged: 0, critical: 0, items: [] };
        if (this.healthCheckService) {
            if (settings.week != null && settings.season != null) {
                try { inputs.advanceDeadline = await this.healthCheckService.checkWeekAdvanceDeadline(settings.week, settings.season); }
                catch (error) { inputs.advanceDeadline = { status: 'warning', message: `deadline check failed: ${error.message}` }; }
            }
            try {
                const items = await this.healthCheckService.getAlerts({ unacknowledgedOnly: true });
                // 'info' alerts (recoveries, "move queued" notes) are listed but never counted: a count is a call to action
                const actionable = items.filter(a => a.severity !== 'info');
                inputs.alerts = { unacknowledged: actionable.length, critical: items.filter(a => a.severity === 'critical').length, items: items.slice(0, 60) };
            } catch (_) { /* alerts file unreadable: counts stay 0 */ }
        }
        return evaluate(inputs, now);
    }

    // ---------- rulings ----------

    get rulingsFile() { return path.join(this.repoRoot, 'logs/doublecheck/rulings.json'); }

    /** Upsert one commissioner ruling. Returns the stored record. Throws on bad input. */
    saveRuling({ questionId, awardClass, note = '', by = 'session' }) {
        if (!questionId || typeof questionId !== 'string' || questionId.length > 200) throw new Error('questionId is required');
        if (!AWARD_CLASSES.includes(awardClass)) throw new Error(`awardClass must be one of ${AWARD_CLASSES.join(', ')}`);
        const ruling = { questionId, awardClass, note: String(note || '').slice(0, 2000), by, ts: new Date().toISOString() };
        const file = this.rulingsFile;
        const current = readJson(file);
        const all = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
        all[questionId] = ruling;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
        fs.renameSync(tmp, file);
        return ruling;
    }

    /** Re-run the script-only finalize so the ruling reaches report.md / latest.json. */
    runFinalize(season, week, { timeoutMs = 60000 } = {}) {
        return new Promise(resolve => {
            const args = [path.join(this.repoRoot, 'scripts/doublecheck-finalize.js'), String(season), String(week), '--script-only', '--quiet'];
            let child;
            try {
                child = spawn(process.execPath, args, { cwd: this.repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
            } catch (error) {
                return resolve({ exitCode: null, error: error.message, timedOut: false });
            }
            let stderr = '';
            child.stderr.on('data', d => { stderr += d.toString().slice(0, 2000); });
            child.stdout.on('data', () => {});
            const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* gone */ } }, timeoutMs);
            child.on('error', error => { clearTimeout(timer); resolve({ exitCode: null, error: error.message, timedOut: false }); });
            child.on('close', (code, signal) => {
                clearTimeout(timer);
                resolve({ exitCode: code, signal: signal || null, timedOut: signal === 'SIGKILL', error: code ? stderr.trim().slice(-500) || null : null });
            });
        });
    }
}

/** "2026-wk01-..." -> { season: 2026, week: 1 } or null. */
function parseQuestionId(questionId) {
    const m = /^(\d{4})-wk(\d{1,2})-/.exec(String(questionId || ''));
    return m ? { season: Number(m[1]), week: Number(m[2]) } : null;
}

module.exports = { JobStatusService, evaluate, readInputs, readPm2, mergeQuestions, parseQuestionId, CADENCE, AWARD_CLASSES, PM2_JOB_BY_APP, PM2_ALWAYS_ON, MAINTENANCE_MAX_SEC, DIAGNOSIS_FRESH_SEC, LIVE_REVIEW_MAX_ROWS, LOG_ERRORS_MAX_ROWS, REPO_ROOT };
