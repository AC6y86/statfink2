/**
 * Follow-ups from the verification-strategy review (2026-09-13):
 *  1. deferred-only results read as ok on the status page
 *  2. pm2 process state in the aggregator
 *  5. per-week recalculation runs the pipeline steps in order
 */
const { statusKind, isDeferredWarning } = require('../../scripts/lib/validationStatus');
const { evaluate, readPm2, PM2_ALWAYS_ON } = require('../../server/services/jobStatusService');

describe('1. deferred-only validation results are ok, real warnings are warnings', () => {
    const check = (name, status, message, details) => ({ name, status, message, details });
    test('isDeferredWarning recognises the mid-week wording', () => {
        expect(isDeferredWarning(check('DST Sanity', 'warning', '10/16 games final - bonus check deferred'))).toBe(true);
        expect(isDeferredWarning(check('End-of-Week Suite', 'warning', '4 passed, 0 failed, 3 warnings', [
            'Fewest Yards Allowed Bonus: Bonus check deferred — 10/16 games final',
            'Standings Win/Loss Deltas: Deferred — week 1 standings not yet calculated']))).toBe(true);
        expect(isDeferredWarning(check('End-of-Week Suite', 'warning', '4 passed, 0 failed, 3 warnings', [
            'Fewest Yards Allowed Bonus: Bonus check deferred — 10/16 games final',
            'Two-Point Conversions: found 0 but boxscores show 2']))).toBe(false);
        expect(isDeferredWarning(check('Team Code Consistency', 'warning', '1 non-canonical team code(s) found'))).toBe(false);
        expect(isDeferredWarning(check('x', 'passed', 'deferred'))).toBe(false);
    });
    test('statusKind: WARN made only of deferred checks is ok; a real warning stays warning; FAIL is critical', () => {
        const deferredOnly = { healthValidation: { checks: [check('DST Sanity', 'warning', 'bonus check deferred - 2/16 games final')] }, doubleCheck: { overallStatus: 'INCOMPLETE' } };
        expect(statusKind('WARN', deferredOnly)).toBe('ok');
        const real = { healthValidation: { checks: [check('Team Code Consistency', 'warning', '1 non-canonical team code(s) found')] } };
        expect(statusKind('WARN', real)).toBe('warning');
        expect(statusKind('WARN', { healthValidation: { checks: [] }, doubleCheck: { overallStatus: 'WARN' } })).toBe('warning');
        expect(statusKind('FAIL', real)).toBe('critical');
        expect(statusKind('PASS', real)).toBe('ok');
        expect(statusKind('SKIPPED')).toBe('skipped');
    });
});

describe('2. pm2 process state in the aggregator', () => {
    const now = Date.parse('2026-09-14T10:00:00Z');
    const fresh = (job, status = 'ok') => ({ job, ts: new Date(now - 60 * 1000).toISOString(), status, summary: 's', details: {} });
    const base = () => ({
        statuses: { daily: fresh('daily'), validation: fresh('validation'), doublecheck: fresh('doublecheck'), 'nightly-tests': fresh('nightly-tests'), recaps: fresh('recaps'), notifier: fresh('notifier') },
        live: { ts: new Date(now - 60 * 1000).toISOString(), severity: 'ok', status: 'idle', loopAgeSec: 30, summary: '' },
        notifier: { lastRunAt: new Date(now - 60 * 1000).toISOString(), incident: null },
        emailPollerMtime: now - 60 * 1000, maintenanceLockAgeSec: null, doublecheck: null, questions: [], resolutions: [], rulings: {}, recaps: null, weeklyValidation: null,
        offseason: false, alerts: { unacknowledged: 0, critical: 0, items: [] }
    });
    test('readPm2 parses jlist output and maps app names to jobs', () => {
        const jlist = JSON.stringify([
            { name: 'statfink2-watchdog', pid: 1, pm2_env: { status: 'online', restart_time: 2, pm_uptime: now - 5000 } },
            { name: 'statfink2-daily', pid: 0, pm2_env: { status: 'stopped', restart_time: 0 } },
            { name: 'unrelated', pm2_env: { status: 'online' } }
        ]);
        const p = readPm2(now, { execImpl: () => ({ stdout: `some banner\n${jlist}` }) });
        expect(p.watchdog).toEqual(expect.objectContaining({ app: 'statfink2-watchdog', status: 'online', restarts: 2 }));
        expect(p.watchdog.uptimeMs).toBe(5000);
        expect(p.daily.status).toBe('stopped');
        expect(p.unrelated).toBeUndefined();
        expect(readPm2(now, { execImpl: () => { throw new Error('no pm2'); } })).toBeNull();
    });
    test('an errored app is critical immediately; a stopped always-on app is critical; stopped cron apps are fine', () => {
        const inputs = base();
        inputs.pm2 = { doublecheck: { app: 'statfink2-doublecheck-daily', status: 'errored', restarts: 15 }, daily: { status: 'stopped' }, watchdog: { status: 'stopped' } };
        const snap = evaluate(inputs, now);
        const byJob = Object.fromEntries(snap.jobs.map(j => [j.job, j]));
        expect(byJob.doublecheck.effective).toBe('critical');
        expect(byJob.doublecheck.reason).toBe('pm2-errored');
        expect(byJob.daily.effective).toBe('ok');
        expect(byJob.watchdog.effective).toBe('critical');
        expect(byJob.watchdog.reason).toBe('pm2-stopped');
        expect(snap.overall).toBe('critical');
        expect(PM2_ALWAYS_ON.has('watchdog')).toBe(true);
    });
    test('a stopped always-on app during maintenance is not critical; no pm2 info changes nothing', () => {
        const inputs = base();
        inputs.maintenanceLockAgeSec = 60;
        inputs.pm2 = { 'live-loop': { status: 'stopped' } };
        const snap = evaluate(inputs, now);
        expect(snap.jobs.find(j => j.job === 'live-loop').effective).toBe('ok');
        const plain = evaluate({ ...base(), pm2: null }, now);
        expect(plain.jobs.every(j => j.pm2 === null)).toBe(true);
    });
});

describe('5. recalculateWeek runs the per-week pipeline in order', () => {
    const SeasonRecalculationOrchestrator = require('../../server/services/seasonRecalculationOrchestrator');
    function build(complete) {
        const o = Object.create(SeasonRecalculationOrchestrator.prototype);
        o.season = 2026; const calls = [];
        const rec = (name, ret) => async (...a) => { calls.push([name, ...a]); return ret; };
        o.dstManagementService = { ensureDSTPlayersExist: rec('ensureDST') };
        o.dataCleanupService = { cleanWeekData: rec('clean') };
        o.syncWeekGames = rec('games'); o.syncWeekStatsDirectly = rec('stats');
        o.fantasyPointsCalculationService = { calculateWeekFantasyPoints: rec('points'), calculateEndOfWeekDSTBonuses: rec('dstPoints') };
        o.nflGamesService = { areAllWeekGamesComplete: rec('complete', { isComplete: complete, completedGames: complete ? 16 : 10, totalGames: 16 }) };
        o.scoringService = { calculateDefensiveBonuses: rec('bonuses') };
        o.scoringPlayersService = { calculateScoringPlayers: rec('lineups') };
        o.standingsService = { calculateWeeklyStandings: rec('standings') };
        return { o, calls };
    }
    test('complete week with standings', async () => {
        const { o, calls } = build(true);
        const r = await o.recalculateWeek(3, { standings: true, log: () => {} });
        expect(calls.map(c => c[0])).toEqual(['ensureDST', 'clean', 'games', 'stats', 'points', 'complete', 'bonuses', 'dstPoints', 'lineups', 'standings']);
        expect(calls[1]).toEqual(['clean', 3, 2026]);
        expect(r.complete).toBe(true);
    });
    test('incomplete week skips bonuses and standings but still rewrites lineups/matchup totals', async () => {
        const { o, calls } = build(false);
        const r = await o.recalculateWeek(1, { log: () => {} });
        expect(calls.map(c => c[0])).toEqual(['ensureDST', 'clean', 'games', 'stats', 'points', 'complete', 'lineups']);
        expect(r.complete).toBe(false);
        expect(r.steps.some(s => /bonuses skipped/.test(s))).toBe(true);
    });
});

describe('a status is a call to action: deferrals are not warnings', () => {
    const { computeOverallStatus } = require('../../scripts/lib/validationStatus');
    const HealthCheckService = require('../../server/services/healthCheckService');
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const tmpAlerts = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hc-')), 'alerts.json');

    test('an unfinished week with only deferred checks is PASS; a real warning is WARN; a failed check is FAIL', () => {
        const health = (checks, over = 'passed') => ({ season: 2026, week: 1, overallStatus: over, checks,
            summary: { passed: checks.filter(c => c.status === 'passed').length, failed: checks.filter(c => c.status === 'failed').length,
                warnings: checks.filter(c => c.status === 'warning').length, deferred: checks.filter(c => c.status === 'deferred').length },
            completion: { isComplete: false, totalGames: 16, completedGames: 10 } });
        const deferred = [{ name: 'DST Sanity', status: 'deferred', message: '10/16 games final - bonus check deferred' }, { name: 'Roster Invariant (12x19)', status: 'passed', message: 'ok' }];
        expect(computeOverallStatus(health(deferred), { overallStatus: 'INCOMPLETE' })).toBe('PASS');
        expect(computeOverallStatus(health([...deferred, { name: 'Team Code Consistency', status: 'warning', message: "player_stats: 'WSH'" }]), null)).toBe('WARN');
        expect(computeOverallStatus(health(deferred), { overallStatus: 'WARN' })).toBe('WARN');
        expect(computeOverallStatus(health([{ name: 'Freshness', status: 'failed', message: 'stale' }], 'failed'), null)).toBe('FAIL');
    });

    test('DST Sanity reports deferred (not warning) while games are in progress, and runValidation counts it separately', async () => {
        const db = { async all(sql) {
            if (sql.includes('FROM nfl_games')) return [{ game_id: 'G1', home_team: 'CHI', away_team: 'TEN', home_score: 7, away_score: 3, status: 'Q2 5:00' }];
            return [];
        }, async get() { return null; } };
        const service = new HealthCheckService(db, { alertsFile: tmpAlerts() });
        const check = await service.checkDSTSanity(1, 2026);
        expect(check.status).toBe('deferred');
        expect(check.message).toMatch(/bonus check deferred/);
        service.checkRosterInvariant = async () => ({ name: 'Roster Invariant (12x19)', status: 'passed', message: 'ok' });
        service.checkFreshness = async () => ({ name: 'Freshness', status: 'passed', message: 'ok' });
        service.checkWeekAdvanceDeadline = async () => ({ name: 'Week Advance Deadline', status: 'passed', message: 'ok' });
        service.checkMatchupConsistency = async () => ({ name: 'Matchup Consistency', status: 'passed', message: 'ok' });
        service.checkTeamCodes = async () => ({ name: 'Team Code Consistency', status: 'passed', message: 'ok' });
        service.checkScheduleIntegrity = async () => ({ name: 'Schedule Integrity', status: 'passed', message: 'ok' });
        service.checkClockSanity = async () => ({ name: 'Clock Sanity', status: 'passed', message: 'ok' });
        service.checkEndOfWeekSuite = async () => ({ name: 'End-of-Week Suite', status: 'deferred', message: 'deferred' });
        const results = await service.runValidation(1, 2026, { mode: 'full', recordAlerts: false });
        expect(results.summary).toEqual({ passed: 7, failed: 0, warnings: 0, deferred: 2 });
        expect(results.overallStatus).toBe('passed');
    });

    test('End-of-Week Suite rolls up: failed > warning > deferred > passed', async () => {
        const mk = checks => new HealthCheckService({}, { alertsFile: tmpAlerts(), testRunnerService: { runValidateEndOfWeekTest: async () => ({ overallStatus: 'passed', checks, summary: {} }) } });
        expect((await mk([{ status: 'deferred' }, { status: 'passed' }]).checkEndOfWeekSuite(1, 2026)).status).toBe('deferred');
        expect((await mk([{ status: 'deferred' }, { status: 'warning' }]).checkEndOfWeekSuite(1, 2026)).status).toBe('warning');
        expect((await mk([{ status: 'failed' }, { status: 'warning' }]).checkEndOfWeekSuite(1, 2026)).status).toBe('failed');
        expect((await mk([{ status: 'passed' }]).checkEndOfWeekSuite(1, 2026)).status).toBe('passed');
    });
});
