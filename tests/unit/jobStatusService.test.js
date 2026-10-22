/**
 * server/services/jobStatusService.js: readInputs() over a temp repo layout
 * and the pure evaluate() policy. No server, no network, no live DB (a fake
 * db with get/all is enough for snapshot()).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { JobStatusService, evaluate, readInputs, mergeQuestions, parseQuestionId, CADENCE, AWARD_CLASSES, PM2_JOB_BY_APP, PM2_ALWAYS_ON, LIVE_REVIEW_MAX_ROWS, LOG_ERRORS_MAX_ROWS } = require('../../server/services/jobStatusService');

const NOW = Date.parse('2026-09-15T15:00:00Z');
const at = (secAgo) => new Date(NOW - secAgo * 1000).toISOString();

let repo;

function writeJson(rel, obj) {
    const file = path.join(repo, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj));
    return file;
}

function touch(rel, secAgo) {
    const file = writeJson(rel, { ts: at(secAgo) });
    const t = new Date(NOW - secAgo * 1000);
    fs.utimesSync(file, t, t);
}

function status(job, secAgo, extra = {}) {
    writeJson(`logs/status/${job}.json`, { job, ts: at(secAgo), status: 'ok', summary: `${job} fine`, season: 2026, week: 2, details: {}, ...extra });
}

/** A repo where everything ran on time. */
function healthyRepo() {
    writeJson('logs/watchdog/live-latest.json', { ts: at(60), status: 'ok', severity: 'ok', summary: 'all good', loopAgeSec: 20, season: 2026, week: 2, signals: [] });
    writeJson('logs/watchdog/notifier-state.json', { lastRunAt: at(120), incident: null });
    touch('roster_moves/last_check.json', 30);
    status('daily', 3600, { details: { advanceDeadline: { status: 'passed' } } });
    status('validation', 3600, { details: { mode: 'daily', overallStatus: 'PASS', gamesComplete: { totalGames: 16, completedGames: 16 }, healthSummary: { passed: 5, failed: 0, warnings: 0 }, checks: [{ name: 'x', status: 'passed', message: 'ok' }] } });
    status('doublecheck', 7200);
    status('nightly-tests', 10000);
    status('recap-setup', 600, { status: 'skipped', summary: '2026 week 2: 9/16 final' });
    status('recaps', 2 * 86400);
    status('weekly-advance', 3 * 86400, { status: 'ok', summary: 'Advanced to week 2' });
    status('live-review', 60, { status: 'ok', summary: '0 plays reviewed' });
    status('log-sentinel', 120, { status: 'ok', summary: 'no new errors; 2 known noise shape(s) suppressed (9,430 entries in 24 h)' });
}

function inputsFor(extra = {}) {
    return { ...readInputs({ repoRoot: repo, now: NOW }), settings: { season: 2026, week: 2 }, offseason: false, advanceDeadline: { status: 'passed', message: 'fine' }, alerts: { unacknowledged: 0, critical: 0, items: [] }, ...extra };
}

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'jobstatus-'));
});

afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
});

describe('readInputs', () => {
    test('tolerates an empty repo: nothing throws, everything is null/empty', () => {
        const inputs = readInputs({ repoRoot: repo, now: NOW });
        expect(inputs.statuses).toEqual({});
        expect(inputs.live).toBeNull();
        expect(inputs.notifier).toBeNull();
        expect(inputs.emailPollerMtime).toBeNull();
        expect(inputs.maintenanceLockAgeSec).toBeNull();
        expect(inputs.doublecheck).toBeNull();
        expect(inputs.questions).toEqual([]);
        expect(inputs.resolutions).toEqual([]);
        expect(inputs.rulings).toEqual({});
        expect(inputs.recaps).toBeNull();
        expect(inputs.liveReview).toBeNull();
        expect(inputs.diagnosis).toBeNull();
        expect(inputs.logErrors).toBeNull();
        const snap = evaluate({ ...inputs, offseason: false }, NOW);
        expect(snap.overall).toBe('ok'); // everything "missing" = never run yet: nothing to do, not a warning
        expect(snap.jobs.every(j => j.status === 'missing' && j.effective === 'ok' && j.reason === 'missing' && !j.stale)).toBe(true);
        expect(snap.jobs.find(j => j.job === 'reconcile')).toBeUndefined();
        expect(snap.validation).toBeNull();
        expect(snap.doublecheck).toBeNull();
        expect(snap.questions).toEqual([]);
        expect(snap.liveReview).toBeNull();
        expect(snap.diagnosis).toBeNull();
        expect(snap.logErrors).toBeNull();
    });

    test('ignores corrupt files and .tmp status files', () => {
        fs.mkdirSync(path.join(repo, 'logs/status'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'logs/status/daily.json'), '{ not json');
        fs.writeFileSync(path.join(repo, 'logs/status/recaps.json.123.tmp'), '{}');
        fs.mkdirSync(path.join(repo, 'logs/watchdog'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'logs/watchdog/live-latest.json'), '');
        fs.mkdirSync(path.join(repo, 'logs/live-review'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'logs/live-review/latest.json'), '{ nope');
        fs.writeFileSync(path.join(repo, 'logs/live-review/diagnosis.json'), '');
        fs.mkdirSync(path.join(repo, 'logs/log-sentinel'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'logs/log-sentinel/latest.json'), '[not json');
        const inputs = readInputs({ repoRoot: repo, now: NOW });
        expect(inputs.statuses).toEqual({});
        expect(inputs.live).toBeNull();
        expect(inputs.liveReview).toBeNull();
        expect(inputs.diagnosis).toBeNull();
        expect(inputs.logErrors).toBeNull();
    });
});

describe('evaluate: staleness with grace', () => {
    test('a healthy repo is all ok', () => {
        healthyRepo();
        const snap = evaluate(inputsFor(), NOW);
        expect(snap.overall).toBe('ok');
        expect(snap.jobs.map(j => j.job)).toEqual(['live-loop', 'watchdog', 'notifier', 'email-poller', 'daily', 'validation', 'doublecheck', 'nightly-tests', 'recap-setup', 'recaps', 'weekly-advance', 'live-review', 'log-sentinel']);
        for (const j of snap.jobs) {
            expect(j.effective).toBe('ok');
            expect(j.stale).toBe(false);
            expect(j.reason).toBeNull();
            expect(j.expectedBy).toBeTruthy();
            expect(j.title).toBe(CADENCE[j.job].title);
        }
        const loop = snap.jobs.find(j => j.job === 'live-loop');
        expect(loop.ageSec).toBe(80); // watchdog 60 s ago measured the loop 20 s before that
        expect(snap.validation).toMatchObject({ ts: at(3600), status: 'ok', mode: 'daily', overallStatus: 'PASS', season: 2026, week: 2 });
        expect(snap.validation.checks).toHaveLength(1);
    });

    test('within expected+grace is fine; past it is stale => critical', () => {
        healthyRepo();
        status('daily', 86400 + 7200 - 60); // 1 min inside the grace window
        let snap = evaluate(inputsFor(), NOW);
        expect(snap.jobs.find(j => j.job === 'daily')).toMatchObject({ stale: false, effective: 'ok' });

        status('daily', 86400 + 7200 + 60); // 1 min past it
        snap = evaluate(inputsFor(), NOW);
        const daily = snap.jobs.find(j => j.job === 'daily');
        expect(daily).toMatchObject({ stale: true, effective: 'critical', reason: 'stale', status: 'ok' });
        expect(Date.parse(daily.expectedBy)).toBe(Date.parse(daily.lastRun) + (86400 + 7200) * 1000);
        expect(snap.overall).toBe('critical');
    });

    test('live loop: stale after 180 s of silence, judged from the watchdog measurement', () => {
        healthyRepo();
        writeJson('logs/watchdog/live-latest.json', { ts: at(60), status: 'ok', severity: 'ok', summary: 'x', loopAgeSec: 130 });
        let snap = evaluate(inputsFor(), NOW);
        expect(snap.jobs.find(j => j.job === 'live-loop')).toMatchObject({ ageSec: 190, stale: true, effective: 'critical' });

        // A fresher heartbeat file wins over the watchdog's older measurement
        status('live-loop', 30);
        snap = evaluate(inputsFor(), NOW);
        expect(snap.jobs.find(j => j.job === 'live-loop')).toMatchObject({ ageSec: 30, stale: false, effective: 'ok' });
    });

    test('watchdog silent for 15 min is stale; notifier and email poller have their own clocks', () => {
        healthyRepo();
        writeJson('logs/watchdog/live-latest.json', { ts: at(16 * 60), status: 'ok', severity: 'ok', summary: 'x', loopAgeSec: 5 });
        writeJson('logs/watchdog/notifier-state.json', { lastRunAt: at(31 * 60), incident: null });
        touch('roster_moves/last_check.json', 11 * 60);
        const snap = evaluate(inputsFor(), NOW);
        const by = Object.fromEntries(snap.jobs.map(j => [j.job, j]));
        expect(by.watchdog).toMatchObject({ stale: true, effective: 'critical' });
        expect(by.notifier).toMatchObject({ stale: true, effective: 'critical' });
        expect(by['email-poller']).toMatchObject({ stale: true, effective: 'critical' });
        expect(by['live-loop']).toMatchObject({ stale: true }); // its last known tick is 16 min old too
    });

    test('a running job is never stale; skipped maps to ok; reconcile only appears when its file exists', () => {
        healthyRepo();
        status('doublecheck', 3 * 86400, { status: 'running' });
        status('nightly-tests', 3600, { status: 'skipped' });
        status('reconcile', 3600, { status: 'warning', summary: '1 unsure' });
        const snap = evaluate(inputsFor(), NOW);
        const by = Object.fromEntries(snap.jobs.map(j => [j.job, j]));
        expect(by.doublecheck).toMatchObject({ status: 'running', stale: false, effective: 'ok' });
        expect(by['nightly-tests']).toMatchObject({ status: 'skipped', effective: 'ok' });
        expect(by.reconcile).toMatchObject({ status: 'warning', effective: 'warning', summary: '1 unsure' });
        expect(snap.overall).toBe('warning');
    });
});

describe('evaluate: maintenance and offseason', () => {
    test('a fresh maintenance lock explains live-loop/watchdog/email-poller silence but not the daily job', () => {
        healthyRepo();
        writeJson('logs/watchdog/live-latest.json', { ts: at(20 * 60), status: 'ok', severity: 'ok', summary: 'x', loopAgeSec: 5 });
        touch('roster_moves/last_check.json', 20 * 60);
        touch('logs/maintenance.lock', 10 * 60);
        status('daily', 2 * 86400);
        const snap = evaluate(inputsFor(), NOW);
        expect(snap.maintenance).toBe(true);
        expect(snap.maintenanceLockAgeSec).toBe(600);
        const by = Object.fromEntries(snap.jobs.map(j => [j.job, j]));
        expect(by['live-loop']).toMatchObject({ stale: true, effective: 'ok', reason: 'maintenance' });
        expect(by.watchdog).toMatchObject({ stale: true, effective: 'ok', reason: 'maintenance' });
        expect(by['email-poller']).toMatchObject({ stale: true, effective: 'ok', reason: 'maintenance' });
        expect(by.daily).toMatchObject({ stale: true, effective: 'critical' });
    });

    test('a stale maintenance lock (>= 30 min) suppresses nothing', () => {
        healthyRepo();
        writeJson('logs/watchdog/live-latest.json', { ts: at(20 * 60), status: 'ok', severity: 'ok', summary: 'x', loopAgeSec: 5 });
        touch('logs/maintenance.lock', 31 * 60);
        const snap = evaluate(inputsFor(), NOW);
        expect(snap.maintenance).toBe(false);
        expect(snap.jobs.find(j => j.job === 'watchdog')).toMatchObject({ stale: true, effective: 'critical', reason: 'stale' });
    });

    test('offseason downgrades live-loop/watchdog/notifier/recaps silence to informational', () => {
        healthyRepo();
        writeJson('logs/watchdog/live-latest.json', { ts: at(3 * 86400), status: 'idle', severity: 'critical', summary: 'x', loopAgeSec: 5 });
        writeJson('logs/watchdog/notifier-state.json', { lastRunAt: at(3 * 86400), incident: null });
        status('recaps', 20 * 86400);
        touch('roster_moves/last_check.json', 3 * 86400);
        const snap = evaluate(inputsFor({ offseason: true }), NOW);
        expect(snap.offseason).toBe(true);
        const by = Object.fromEntries(snap.jobs.map(j => [j.job, j]));
        for (const job of ['live-loop', 'watchdog', 'notifier']) {
            expect(by[job]).toMatchObject({ stale: true, effective: 'ok', reason: 'offseason' });
        }
        // recaps are generated on demand from /admin Recaps: never stale, in or out of season
        expect(by.recaps).toMatchObject({ stale: false, effective: 'ok' });
        expect(by['email-poller']).toMatchObject({ stale: true, effective: 'critical' }); // owners still email moves
        expect(snap.overall).toBe('critical');
        // ...and a critical watchdog severity does not force critical off-season
        touch('roster_moves/last_check.json', 30);
        expect(evaluate(inputsFor({ offseason: true }), NOW).overall).toBe('ok');
    });
});

describe('evaluate: overall roll-up', () => {
    test('worst job wins; watchdog critical, failed advance deadline and unacked critical alerts escalate', () => {
        healthyRepo();
        expect(evaluate(inputsFor(), NOW).overall).toBe('ok');

        status('nightly-tests', 3600, { status: 'warning' });
        expect(evaluate(inputsFor(), NOW).overall).toBe('warning');

        expect(evaluate(inputsFor({ alerts: { unacknowledged: 2, critical: 1, items: [] } }), NOW).overall).toBe('warning');
        expect(evaluate(inputsFor({ advanceDeadline: { status: 'failed', message: 'ADVANCE THE WEEK' } }), NOW).overall).toBe('critical');

        writeJson('logs/watchdog/live-latest.json', { ts: at(60), status: 'dead', severity: 'critical', summary: 'loop dead', loopAgeSec: 900 });
        const snap = evaluate(inputsFor(), NOW);
        expect(snap.overall).toBe('critical');
        expect(snap.jobs.find(j => j.job === 'watchdog')).toMatchObject({ status: 'critical', effective: 'critical', stale: false });
        expect(snap.live.latest.summary).toBe('loop dead');
    });

    test('the response carries every top-level section', () => {
        healthyRepo();
        const snap = evaluate(inputsFor(), NOW);
        expect(Object.keys(snap).sort()).toEqual(['advanceDeadline', 'alerts', 'diagnosis', 'doublecheck', 'generatedAt', 'jobs', 'live', 'liveReview', 'logErrors', 'maintenance',
            'maintenanceLockAgeSec', 'offseason', 'overall', 'questions', 'qwen', 'recaps', 'season', 'validation', 'week'].sort());
        expect(snap.generatedAt).toBe(new Date(NOW).toISOString());
        expect(snap.advanceDeadline).toEqual({ status: 'passed', message: 'fine' });
        expect(snap.alerts).toEqual({ unacknowledged: 0, critical: 0, items: [] });
        expect(Object.keys(snap.jobs[0]).sort()).toEqual(['ageSec', 'cadence', 'details', 'effective', 'expectedBy', 'expectedEverySec', 'graceSec', 'job',
            'lastRun', 'link', 'pm2', 'reason', 'season', 'stale', 'status', 'summary', 'title', 'week'].sort());
    });
});

describe('live play review (Qwen)', () => {
    const inWindow = () => writeJson('logs/watchdog/live-latest.json', { ts: at(60), status: 'ok', severity: 'ok', summary: 'live', loopAgeSec: 20, expectedGames: 3, gamesInProgress: 2, season: 2026, week: 2, signals: [] });
    const noWindow = () => writeJson('logs/watchdog/live-latest.json', { ts: at(60), status: 'idle', severity: 'ok', summary: 'idle', loopAgeSec: 20, expectedGames: 0, gamesInProgress: 0, season: 2026, week: 2, signals: [] });
    const review = (i, extra = {}) => ({
        key: `20260913_BUF@HOU-2-6:1${i}-HOU`, gameId: '20260913_BUF@HOU', playIdx: i, period: 2, clock: `6:1${i}`, text: `play ${i}`, scoringTeam: 'HOU',
        deterministic: { awardClass: 'DEF_8_FUMBLE', votes: { drive: 'DEF_8_FUMBLE', gamebook: null, text: 'DEF_8_FUMBLE' }, agreement: '2/2', expectedCredits: ['HOU DST'] },
        dbCredit: 'HOU DST', qwen: { awardClass: 'DEF_8_FUMBLE', confidence: 'likely', reasoning: 'r', latencyMs: 1200 },
        status: 'confirmed', reason: '', ts: at(600 - i), ...extra
    });
    const latest = (reviews, summary = {}) => writeJson('logs/live-review/latest.json', {
        ts: at(120), season: 2026, week: 2, games: ['20260913_BUF@HOU'], reviews,
        summary: { confirmed: reviews.length, underReview: 0, suspected: 0, qwenUnreachable: false, status: 'ok', summary: `${reviews.length} confirmed`, ...summary }
    });
    const row = snap => snap.jobs.find(j => j.job === 'live-review');

    test('cadence row and pm2 map: a cron app, not always-on', () => {
        expect(CADENCE['live-review']).toMatchObject({ cadence: 'every 5 min during games', expectedEverySec: 300, graceSec: 900, windowAware: true });
        expect(PM2_JOB_BY_APP['statfink2-live-review']).toBe('live-review');
        expect(PM2_ALWAYS_ON.has('live-review')).toBe(false);
    });

    test('outside a game window a skipped or old status is ok with reason idle, never stale', () => {
        healthyRepo();
        noWindow();
        status('live-review', 3 * 3600, { status: 'skipped', summary: 'no games in window' });
        let snap = evaluate(inputsFor(), NOW);
        expect(row(snap)).toMatchObject({ status: 'skipped', stale: false, effective: 'ok', reason: 'idle' });
        expect(snap.overall).toBe('ok');

        // an ok tick from the last window, hours old: idle too (not critical/stale)
        status('live-review', 5 * 3600, { status: 'ok' });
        snap = evaluate(inputsFor(), NOW);
        expect(row(snap)).toMatchObject({ stale: false, effective: 'ok', reason: 'idle' });

        // no watchdog line at all counts as "no window"
        fs.unlinkSync(path.join(repo, 'logs/watchdog/live-latest.json'));
        snap = evaluate(inputsFor(), NOW);
        expect(row(snap)).toMatchObject({ stale: false, effective: 'ok', reason: 'idle' });

        // a fresh warning outside a window (a game just went Final) is still shown as a warning
        inWindow(); noWindow();
        status('live-review', 120, { status: 'warning', summary: '1 miscredit suspected' });
        snap = evaluate(inputsFor(), NOW);
        expect(row(snap)).toMatchObject({ status: 'warning', effective: 'warning', reason: null });
        expect(snap.overall).toBe('warning');
    });

    test('inside a game window the 5 min + 15 min grace applies: 20 min of silence is stale => critical', () => {
        healthyRepo();
        inWindow();
        status('live-review', 19 * 60, { status: 'ok' });
        let snap = evaluate(inputsFor(), NOW);
        expect(row(snap)).toMatchObject({ stale: false, effective: 'ok', reason: null });

        status('live-review', 21 * 60, { status: 'ok' });
        snap = evaluate(inputsFor(), NOW);
        expect(row(snap)).toMatchObject({ stale: true, effective: 'critical', reason: 'stale', status: 'ok' });
        expect(snap.overall).toBe('critical');

        // an old `skipped` inside a window is stale too (the job should be ticking)
        status('live-review', 21 * 60, { status: 'skipped' });
        expect(row(evaluate(inputsFor(), NOW))).toMatchObject({ stale: true, effective: 'critical', reason: 'stale' });

        // a fresh skipped inside a window maps to ok like any other job
        status('live-review', 60, { status: 'skipped' });
        expect(row(evaluate(inputsFor(), NOW))).toMatchObject({ stale: false, effective: 'ok', reason: null });

        // the job's own warning (under review / miscredit suspected) is the only thing that colours the row
        status('live-review', 60, { status: 'warning', summary: '1 under review' });
        snap = evaluate(inputsFor(), NOW);
        expect(row(snap)).toMatchObject({ effective: 'warning' });
        expect(snap.overall).toBe('warning');

        // never run yet, inside a window: still "missing" (first tick is due at the next 5 min mark)
        fs.unlinkSync(path.join(repo, 'logs/status/live-review.json'));
        expect(row(evaluate(inputsFor(), NOW))).toMatchObject({ status: 'missing', effective: 'ok', reason: 'missing' });
    });

    test('liveReview passes through with the summary and the last 40 reviews', () => {
        healthyRepo();
        inWindow();
        status('live-review', 60, { status: 'warning', summary: '1 under review' });
        const reviews = Array.from({ length: 45 }, (_, i) => review(i));
        reviews[44] = review(44, { status: 'under review', reason: 'Qwen disagrees', qwen: { awardClass: 'OFF_RECOVERY', confidence: 'likely', reasoning: 'offense fell on it', latencyMs: 900 } });
        latest(reviews, { confirmed: 44, underReview: 1, status: 'warning', summary: '44 confirmed, 1 under review' });
        const snap = evaluate(inputsFor(), NOW);
        expect(snap.liveReview).toMatchObject({ ts: at(120), season: 2026, week: 2, games: ['20260913_BUF@HOU'] });
        expect(snap.liveReview.summary).toEqual({ confirmed: 44, underReview: 1, suspected: 0, qwenUnreachable: false, status: 'warning', summary: '44 confirmed, 1 under review' });
        expect(snap.liveReview.reviews).toHaveLength(LIVE_REVIEW_MAX_ROWS);
        expect(snap.liveReview.reviews[0].playIdx).toBe(5); // the oldest 5 dropped
        expect(snap.liveReview.reviews[39]).toMatchObject({ playIdx: 44, status: 'under review', qwen: { awardClass: 'OFF_RECOVERY' } });
        // the review status colours the page only through the job row (no double counting)
        expect(snap.overall).toBe('warning');
        expect(snap.jobs.filter(j => j.effective === 'warning').map(j => j.job)).toEqual(['live-review']);
    });

    test('a diagnosis is exposed only while fresh (30 min) and not ok', () => {
        healthyRepo();
        const diag = (secAgo, severity) => writeJson('logs/live-review/diagnosis.json', {
            ts: at(secAgo), watchdogTs: at(secAgo + 30), status: 'stalled', severity, diagnosis: 'The live loop stopped after a Tank01 timeout.', suggestedAction: 'pm2 restart statfink2-live-continuous', model: 'qwen3'
        });
        diag(10 * 60, 'critical');
        let snap = evaluate(inputsFor(), NOW);
        expect(snap.diagnosis).toEqual({ ts: at(600), watchdogTs: at(630), status: 'stalled', severity: 'critical',
            diagnosis: 'The live loop stopped after a Tank01 timeout.', suggestedAction: 'pm2 restart statfink2-live-continuous', model: 'qwen3' });
        expect(snap.overall).toBe('ok'); // an opinion, not a signal

        diag(31 * 60, 'critical');
        expect(evaluate(inputsFor(), NOW).diagnosis).toBeNull();

        diag(60, 'ok');
        expect(evaluate(inputsFor(), NOW).diagnosis).toBeNull();

        writeJson('logs/live-review/diagnosis.json', { severity: 'warning', diagnosis: 'no ts' });
        expect(evaluate(inputsFor(), NOW).diagnosis).toBeNull();
    });

    test('the qwen block reports configuration from the env and reachability from the last tick', () => {
        healthyRepo();
        const saved = { url: process.env.QWEN_BASE_URL, model: process.env.QWEN_MODEL };
        let snap;
        try {
            delete process.env.QWEN_BASE_URL; delete process.env.QWEN_MODEL;
            snap = evaluate(inputsFor(), NOW);
            expect(snap.qwen).toEqual({ configured: false, model: null, reachable: null });

            process.env.QWEN_BASE_URL = 'http://qwen-mac:8080/v1'; process.env.QWEN_MODEL = 'mlx-community/Qwen3-14B-4bit';
            latest([review(1)], { qwenUnreachable: false });
            snap = evaluate(inputsFor(), NOW);
            expect(snap.qwen).toEqual({ configured: true, model: 'mlx-community/Qwen3-14B-4bit', reachable: true });

            latest([review(1, { qwen: null })], { qwenUnreachable: true, status: 'ok', summary: 'Qwen unreachable' });
            expect(evaluate(inputsFor(), NOW).qwen.reachable).toBe(false);

            latest([], {});
            fs.writeFileSync(path.join(repo, 'logs/live-review/latest.json'), JSON.stringify({ ts: at(120), reviews: [], summary: { status: 'ok' } }));
            expect(evaluate(inputsFor(), NOW).qwen.reachable).toBeNull();
        } finally {
            if (saved.url === undefined) delete process.env.QWEN_BASE_URL; else process.env.QWEN_BASE_URL = saved.url;
            if (saved.model === undefined) delete process.env.QWEN_MODEL; else process.env.QWEN_MODEL = saved.model;
        }
    });
});

describe('log sentinel', () => {
    const fp = (i, extra = {}) => ({
        id: `00000000${String(i).padStart(2, '0')}`, job: 'server', level: 'error', fingerprint: `error: shape ${i}`, count10m: 0, count1h: 0, count24h: i, count7d: i,
        firstSeen: at(2 * 86400), lastSeen: at(600 + i), sample: `[ts] ERROR: shape ${i}`, known: false, knownVia: null, new: false, spiking: false, ...extra
    });
    const latest = (fingerprints, summary = {}) => writeJson('logs/log-sentinel/latest.json', {
        ts: at(120), firstRun: false, observedSince: at(3 * 86400), scanned: [{ file: 'statfink2-error-0.log', job: 'server', stream: 'error', bytes: 10, rotated: false, capped: false }],
        entriesSeen: 3, fingerprints, summary: { newCount: 0, spikingCount: 0, knownSuppressed: 0, knownEntries24h: 0, status: 'ok', summary: 'no new errors', ...summary }
    });
    const row = snap => snap.jobs.find(j => j.job === 'log-sentinel');

    test('cadence row (10 min + 20 min grace) and pm2 map: a cron app, not always-on', () => {
        expect(CADENCE['log-sentinel']).toEqual({ title: 'Log sentinel', cadence: 'every 10 min', expectedEverySec: 600, graceSec: 1200 });
        expect(PM2_JOB_BY_APP['statfink2-log-sentinel']).toBe('log-sentinel');
        expect(PM2_ALWAYS_ON.has('log-sentinel')).toBe(false);
    });

    test('the job row follows its status file: ok, warning for a new shape, stale after 30 min of silence, missing before the first run', () => {
        healthyRepo();
        expect(row(evaluate(inputsFor(), NOW))).toMatchObject({ status: 'ok', effective: 'ok', reason: null, title: 'Log sentinel', cadence: 'every 10 min' });
        status('log-sentinel', 60, { status: 'warning', summary: '1 new error shape(s) nobody has seen before' });
        let snap = evaluate(inputsFor(), NOW);
        expect(row(snap)).toMatchObject({ status: 'warning', effective: 'warning', summary: '1 new error shape(s) nobody has seen before' });
        expect(snap.overall).toBe('warning');
        status('log-sentinel', 29 * 60, { status: 'ok' });
        expect(row(evaluate(inputsFor(), NOW))).toMatchObject({ effective: 'ok', stale: false });
        status('log-sentinel', 31 * 60, { status: 'ok' });
        expect(row(evaluate(inputsFor(), NOW))).toMatchObject({ effective: 'critical', reason: 'stale', stale: true });
        fs.unlinkSync(path.join(repo, 'logs/status/log-sentinel.json'));
        expect(row(evaluate(inputsFor(), NOW))).toMatchObject({ status: 'missing', effective: 'ok', reason: 'missing' });
    });

    test('logErrors passes through: summary, new -> spiking -> unacked -> known ordering, capped at 50 rows', () => {
        healthyRepo();
        const list = Array.from({ length: 60 }, (_, i) => fp(i));
        list[3] = fp(3, { known: true, knownVia: 'shipped:fk-constraint-non-draftable-player', count24h: 4594 });
        list[7] = fp(7, { spiking: true, known: true, knownVia: 'acked' });
        list[9] = fp(9, { new: true, firstSeen: at(3600), job: 'live-continuous' });
        latest(list, { newCount: 1, spikingCount: 1, knownSuppressed: 2, status: 'warning', summary: '1 new error shape(s) nobody has seen before; 1 shape(s) spiking' });
        const snap = evaluate(inputsFor(), NOW);
        expect(snap.logErrors).toMatchObject({ ts: at(120), firstRun: false, scanned: 1 });
        expect(snap.logErrors.summary).toEqual({ newCount: 1, spikingCount: 1, knownSuppressed: 2, knownEntries24h: 0, status: 'warning', summary: '1 new error shape(s) nobody has seen before; 1 shape(s) spiking' });
        expect(snap.logErrors.fingerprints).toHaveLength(LOG_ERRORS_MAX_ROWS);
        expect(snap.logErrors.fingerprints[0]).toMatchObject({ id: '0000000009', new: true, job: 'live-continuous' });
        expect(snap.logErrors.fingerprints[1]).toMatchObject({ id: '0000000007', spiking: true });
        expect(snap.logErrors.fingerprints[2]).toMatchObject({ id: '0000000000' }); // most recent unacked next
        expect(snap.logErrors.fingerprints.map(f => f.known)).toEqual([false, true, ...Array(48).fill(false)]); // the known row falls past the cap
        // the page colours only through the job row; a warning latest.json with an ok status file does not double count
        expect(snap.overall).toBe('ok');
        expect(Object.keys(snap.logErrors).sort()).toEqual(['fingerprints', 'firstRun', 'scanned', 'summary', 'ts']);
    });

    test('a latest.json without lists is tolerated', () => {
        healthyRepo();
        writeJson('logs/log-sentinel/latest.json', { ts: at(60) });
        expect(evaluate(inputsFor(), NOW).logErrors).toEqual({ ts: at(60), firstRun: false, summary: null, fingerprints: [], scanned: null });
    });
});

describe('Double Check, questions, resolutions and rulings', () => {
    function dcRepo() {
        const ws = path.join(repo, 'logs/doublecheck/2026/week02');
        writeJson('logs/doublecheck-latest.json', {
            runAt: at(3600), season: 2026, week: 2, overallStatus: 'WARN', workspace: ws, reportFile: path.join(ws, 'report.md'),
            counts: { FAIL: 0, WARN: 1, INFO: 2, DEFER: 0, flips: 0 }, completeness: { gamesFinal: 16, gamesTotal: 16 }, questions: 2,
            findings: [
                { id: 'f1', severity: 'INFO', bugClassRef: 'D1', explanation: 'fine' },
                { id: 'f2', severity: 'WARN', bugClassRef: 'C2', explanation: 'ambiguous fumble', entity: { type: 'player', name: 'X' } },
                { id: 'f3', severity: 'DEFER', bugClassRef: 'A1', explanation: 'later' }
            ],
            defensiveScores: [{ gameId: 'g1', playIdx: 3, scoringTeam: 'HOU', kind: 'TD', awardClass: 'DEF_8_FUMBLE', creditedTo: 'HOU DST', votesAgree: true, agreement: '3/3', questionId: null }]
        });
        writeJson('logs/doublecheck/2026/week02/questions.json', [
            { id: '2026-wk02-g1-play-7', season: 2026, week: 2, gameId: 'g1', playIdx: 7, question: 'Who?', evidence: { tank01Text: 't' }, options: AWARD_CLASSES, relatedFindingIds: ['f2'] },
            { id: '2026-wk02-g2-play-1', season: 2026, week: 2, gameId: 'g2', playIdx: 1, question: 'Safety?', evidence: {}, options: AWARD_CLASSES },
            { id: '2026-wk02-g3-play-2', season: 2026, week: 2, gameId: 'g3', playIdx: 2, question: 'Return?', evidence: {}, options: AWARD_CLASSES }
        ]);
        return ws;
    }

    test('doublecheck keeps FAIL/WARN findings only and merges questions with resolution + ruling', () => {
        dcRepo();
        writeJson('logs/doublecheck/2026/week02/resolutions.json', [
            { questionId: '2026-wk02-g1-play-7', awardClass: 'OFF_RECOVERY', confidence: 'likely', reasoning: 'offense recovered', model: 'opus', ts: at(1800) },
            { questionId: '2026-wk02-g2-play-1', awardClass: 'SAFETY_2', confidence: 'unsure', reasoning: 'cannot tell', model: 'opus', ts: at(1800) }
        ]);
        writeJson('logs/doublecheck/rulings.json', {
            '2026-wk02-g1-play-7': { questionId: '2026-wk02-g1-play-7', awardClass: 'DEF_8_FUMBLE', note: 'gamebook says HST recovered', by: 'tailscale', ts: at(600) }
        });
        const snap = evaluate(inputsFor(), NOW);
        expect(snap.doublecheck).toMatchObject({ ts: at(3600), season: 2026, week: 2, overallStatus: 'WARN', questions: 2 });
        expect(snap.doublecheck.findings.map(f => f.id)).toEqual(['f2']);
        expect(snap.doublecheck.defensiveScores).toHaveLength(1);
        expect(snap.doublecheck.reportFile).toMatch(/report\.md$/);

        expect(snap.questions).toHaveLength(3);
        const [q1, q2, q3] = snap.questions;
        // ruling overrides the resolution
        expect(q1.resolution.awardClass).toBe('OFF_RECOVERY');
        expect(q1.ruling.awardClass).toBe('DEF_8_FUMBLE');
        expect(q1.decided).toBe('DEF_8_FUMBLE');
        expect(q1.needsRuling).toBe(false);
        // unsure resolution, no ruling => still needs a ruling
        expect(q2.resolution.confidence).toBe('unsure');
        expect(q2.ruling).toBeNull();
        expect(q2.decided).toBe('SAFETY_2');
        expect(q2.needsRuling).toBe(true);
        // nothing at all
        expect(q3).toMatchObject({ resolution: null, ruling: null, decided: null, needsRuling: true });
    });

    test('questions/resolutions may be wrapped objects; a likely resolution alone needs no ruling', () => {
        const merged = mergeQuestions(
            [{ id: 'a' }, { id: 'b' }],
            { resolutions: [{ questionId: 'a', awardClass: 'OFF_PASS', confidence: 'certain' }] },
            {}
        );
        expect(merged[0]).toMatchObject({ decided: 'OFF_PASS', needsRuling: false });
        expect(merged[1]).toMatchObject({ decided: null, needsRuling: true });
    });

    test('missing workspace files are tolerated', () => {
        dcRepo();
        fs.unlinkSync(path.join(repo, 'logs/doublecheck/2026/week02/questions.json'));
        const snap = evaluate(inputsFor(), NOW);
        expect(snap.questions).toEqual([]);
        expect(snap.doublecheck.overallStatus).toBe('WARN');
    });

    test('saveRuling validates and upserts logs/doublecheck/rulings.json', () => {
        const svc = new JobStatusService({ db: null, repoRoot: repo });
        expect(() => svc.saveRuling({ questionId: 'q', awardClass: 'NOPE' })).toThrow(/awardClass/);
        expect(() => svc.saveRuling({ questionId: '', awardClass: 'OFF_PASS' })).toThrow(/questionId/);
        const r1 = svc.saveRuling({ questionId: '2026-wk02-g1-play-7', awardClass: 'OFF_PASS', note: 'first', by: 'tailscale' });
        expect(r1).toMatchObject({ questionId: '2026-wk02-g1-play-7', awardClass: 'OFF_PASS', note: 'first', by: 'tailscale' });
        svc.saveRuling({ questionId: '2026-wk02-g2-play-1', awardClass: 'SAFETY_2' });
        const r3 = svc.saveRuling({ questionId: '2026-wk02-g1-play-7', awardClass: 'DEF_8_INT', note: 'changed my mind' });
        const file = JSON.parse(fs.readFileSync(path.join(repo, 'logs/doublecheck/rulings.json'), 'utf8'));
        expect(Object.keys(file).sort()).toEqual(['2026-wk02-g1-play-7', '2026-wk02-g2-play-1']);
        expect(file['2026-wk02-g1-play-7']).toEqual(r3);
        expect(file['2026-wk02-g1-play-7'].by).toBe('session');
    });

    test('parseQuestionId reads the season/week prefix', () => {
        expect(parseQuestionId('2026-wk02-20260913_BUF@HOU-play-12')).toEqual({ season: 2026, week: 2 });
        expect(parseQuestionId('2026-wk18-x')).toEqual({ season: 2026, week: 18 });
        expect(parseQuestionId('nope')).toBeNull();
        expect(parseQuestionId(null)).toBeNull();
    });
});

describe('JobStatusService.snapshot with a fake db', () => {
    function fakeDb({ season = 2026, week = 2, total = 16, near = 16 } = {}) {
        return {
            getLeagueSettings: async () => ({ season_year: season, current_week: week }),
            get: async (sql) => (/FROM nfl_games/.test(sql) ? { total, near } : null),
            all: async () => []
        };
    }
    const health = {
        checkWeekAdvanceDeadline: async (week, season) => ({ name: 'Week Advance Deadline', status: 'passed', message: `week ${week}/${season} fine` }),
        getAlerts: async () => [{ id: '1', severity: 'critical', acknowledged: false }, { id: '2', severity: 'info', acknowledged: false }]
    };

    test('reads settings, offseason, the deadline and alerts live', async () => {
        healthyRepo();
        const svc = new JobStatusService({ db: fakeDb(), healthCheckService: health, repoRoot: repo });
        const snap = await svc.snapshot(NOW);
        expect(snap).toMatchObject({ season: 2026, week: 2, offseason: false, maintenance: false });
        expect(snap.advanceDeadline).toEqual({ status: 'passed', message: 'week 2/2026 fine' });
        expect(snap.alerts).toMatchObject({ unacknowledged: 1, critical: 1 }); // the info alert is listed but never counted
        expect(snap.alerts.items).toHaveLength(2);
        expect(snap.overall).toBe('warning'); // the unacked critical alert
    });

    test('no games this season, or none within a week, means offseason', async () => {
        healthyRepo();
        expect((await new JobStatusService({ db: fakeDb({ total: 0, near: 0 }), repoRoot: repo }).snapshot(NOW)).offseason).toBe(true);
        expect((await new JobStatusService({ db: fakeDb({ total: 272, near: 0 }), repoRoot: repo }).snapshot(NOW)).offseason).toBe(true);
        expect((await new JobStatusService({ db: fakeDb({ total: 272, near: 14 }), repoRoot: repo }).snapshot(NOW)).offseason).toBe(false);
    });

    test('survives a db that throws and a missing health service', async () => {
        healthyRepo();
        const svc = new JobStatusService({ db: { get: async () => { throw new Error('locked'); }, all: async () => [] }, repoRoot: repo });
        const snap = await svc.snapshot(NOW);
        expect(snap.season).toBeNull();
        expect(snap.offseason).toBe(true); // unknown season: nothing to expect of the live jobs
        expect(snap.advanceDeadline).toBeNull();
        expect(snap.alerts).toEqual({ unacknowledged: 0, critical: 0, items: [] });
    });
});

describe('on-demand and weekly jobs (2026-09-15)', () => {
    test('recaps never go stale (generated from /admin Recaps on demand)', () => {
        healthyRepo();
        status('recaps', 40 * 86400);
        const by = Object.fromEntries(evaluate(inputsFor(), NOW).jobs.map(j => [j.job, j]));
        expect(CADENCE.recaps.onDemand).toBe(true);
        expect(by.recaps).toMatchObject({ stale: false, effective: 'ok' });
    });
    test('a held weekly advance is a warning (call to action), a stale one is critical', () => {
        healthyRepo();
        status('weekly-advance', 3600, { status: 'warning', summary: 'Validation WARN for 2026 week 2 — review' });
        let by = Object.fromEntries(evaluate(inputsFor(), NOW).jobs.map(j => [j.job, j]));
        expect(by['weekly-advance']).toMatchObject({ effective: 'warning', stale: false });
        status('weekly-advance', 10 * 86400, { status: 'ok', summary: 'Advanced' });
        by = Object.fromEntries(evaluate(inputsFor(), NOW).jobs.map(j => [j.job, j]));
        expect(by['weekly-advance']).toMatchObject({ effective: 'critical', reason: 'stale' });
        expect(PM2_JOB_BY_APP['statfink2-weekly-advance']).toBe('weekly-advance');
        expect(PM2_JOB_BY_APP['statfink2-recap-setup']).toBe('recap-setup');
    });
    test('recap-setup runs every 30 min and its skipped ticks read ok', () => {
        healthyRepo();
        status('recap-setup', 900, { status: 'skipped', summary: 'waiting' });
        const by = Object.fromEntries(evaluate(inputsFor(), NOW).jobs.map(j => [j.job, j]));
        expect(by['recap-setup']).toMatchObject({ effective: 'ok', stale: false });
        expect(CADENCE['recap-setup']).toMatchObject({ expectedEverySec: 1800, graceSec: 3600 });
    });
});

test('summary retains an unresolved play outside the recent review display window', () => {
    const flagged = { gameId: 'SF', season: 2026, week: 2, period: 'Q1', clock: '8:26', scoringTeam: 'SF', text: 'Lateral TD', status: 'under review', privateExtra: 'omit' };
    const reviews = [flagged, ...Array.from({ length: LIVE_REVIEW_MAX_ROWS }, (_, i) => ({ key: String(i), status: 'confirmed' }))];
    const result = evaluate(inputsFor({ liveReview: { reviews, summary: { underReview: 1 } } }), NOW).liveReview;
    expect(result.reviews).toHaveLength(LIVE_REVIEW_MAX_ROWS);
    expect(result.reviews).not.toContainEqual(flagged);
    expect(result.flaggedReviews).toEqual([{ gameId: 'SF', season: 2026, week: 2, period: 'Q1', clock: '8:26', scoringTeam: 'SF', text: 'Lateral TD', status: 'under review' }]);
});
