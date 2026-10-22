/**
 * Tests for HealthCheckService - alert storage and the DST sanity check that
 * detects silently-swallowed scoring play parse failures.
 * Mocked DB and /tmp alert files; never touches the real database.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const HealthCheckService = require('../../server/services/healthCheckService');

function tmpAlertsFile() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'health-test-')), 'alerts.json');
}

describe('HealthCheckService alerts', () => {
    test('recordAlert persists to file and getAlerts returns newest first', async () => {
        const service = new HealthCheckService({}, { alertsFile: tmpAlertsFile() });

        await service.recordAlert('warning', 'test', 'first');
        await service.recordAlert('critical', 'test', 'second');

        const alerts = await service.getAlerts();
        expect(alerts.length).toBe(2);
        expect(alerts[0].message).toBe('second');
        expect(alerts[0].severity).toBe('critical');
        expect(alerts[0].acknowledged).toBe(false);
    });

    test('keeps only the most recent 200 alerts', async () => {
        const service = new HealthCheckService({}, { alertsFile: tmpAlertsFile() });

        for (let i = 0; i < 205; i++) {
            await service.recordAlert('info', 'test', `alert-${i}`);
        }

        const alerts = await service.getAlerts();
        expect(alerts.length).toBe(200);
        expect(alerts[0].message).toBe('alert-204'); // newest kept
        expect(alerts[alerts.length - 1].message).toBe('alert-5'); // oldest 5 dropped
    });

    test('acknowledge specific alerts and all alerts', async () => {
        const service = new HealthCheckService({}, { alertsFile: tmpAlertsFile() });

        const a = await service.recordAlert('warning', 'test', 'one');
        await service.recordAlert('warning', 'test', 'two');

        await service.acknowledgeAlerts([a.id]);
        let unacked = await service.getAlerts({ unacknowledgedOnly: true });
        expect(unacked.length).toBe(1);
        expect(unacked[0].message).toBe('two');

        await service.acknowledgeAlerts();
        unacked = await service.getAlerts({ unacknowledgedOnly: true });
        expect(unacked.length).toBe(0);
    });

    test('survives a corrupt alerts file', async () => {
        const file = tmpAlertsFile();
        fs.writeFileSync(file, 'this is not json{{{');
        const service = new HealthCheckService({}, { alertsFile: file });

        await service.recordAlert('info', 'test', 'after corruption');
        const alerts = await service.getAlerts();
        expect(alerts.length).toBe(1);
    });
});

describe('HealthCheckService DST sanity check (check 6)', () => {
    function dbWithBoxscore(boxscoreBody) {
        return {
            async all(sql) {
                if (sql.includes('FROM nfl_games')) {
                    return [{
                        game_id: 'G1', home_team: 'CHI', away_team: 'TEN',
                        home_score: 24, away_score: 17, status: 'Final'
                    }];
                }
                return []; // no missing DSTs
            },
            async get(sql) {
                if (sql.includes('tank01_cache')) {
                    return { response_data: JSON.stringify({ body: boxscoreBody }) };
                }
                if (sql.includes('def_yards_bonus')) {
                    return { yards_bonus_count: 2, points_bonus_count: 2 };
                }
                return null;
            }
        };
    }

    test('flags a completed game whose boxscore parses to zero scoring plays', async () => {
        // 41 combined points but no parseable scoring plays = parser swallowed something
        const db = dbWithBoxscore({ gameID: 'G1', somethingUnexpected: true });
        const service = new HealthCheckService(db, { alertsFile: tmpAlertsFile() });

        const check = await service.checkDSTSanity(1, 2025);

        expect(check.status).toBe('failed');
        expect(check.details.some(d => d.includes('0 scoring plays'))).toBe(true);
    });

    test('passes when the boxscore yields scoring plays and bonuses are applied', async () => {
        const db = dbWithBoxscore({
            gameID: 'G1',
            scoringPlays: [{ score: 'Someone 5 Yd Run (Kicker Kick)', team: 'CHI' }]
        });
        const service = new HealthCheckService(db, { alertsFile: tmpAlertsFile() });

        const check = await service.checkDSTSanity(1, 2025);

        expect(check.status).toBe('passed');
    });

    test('flags missing defensive bonuses when all games are final', async () => {
        const db = dbWithBoxscore({
            gameID: 'G1',
            scoringPlays: [{ score: 'Someone 5 Yd Run (Kicker Kick)', team: 'CHI' }]
        });
        db.get = (origGet => async sql => {
            if (sql.includes('def_yards_bonus')) {
                return { yards_bonus_count: 0, points_bonus_count: 0 };
            }
            return origGet(sql);
        })(db.get.bind(db));
        const service = new HealthCheckService(db, { alertsFile: tmpAlertsFile() });

        const check = await service.checkDSTSanity(1, 2025);

        expect(check.status).toBe('failed');
        expect(check.details.some(d => d.includes('fewest-yards-allowed'))).toBe(true);
        expect(check.details.some(d => d.includes('fewest-points-allowed'))).toBe(true);
    });
});

describe('HealthCheckService freshness check (check 5)', () => {
    test('skips freshness in the offseason (no games scheduled)', async () => {
        const db = {
            async get(sql) {
                if (sql.includes('FROM nfl_games')) return { count: 0 };
                return null;
            }
        };
        const service = new HealthCheckService(db, { alertsFile: tmpAlertsFile() });

        const check = await service.checkFreshness(1, 2026);

        expect(check.status).toBe('passed');
        expect(check.message).toContain('offseason');
    });

    test('fails when the daily update is stale during the season', async () => {
        const staleDate = new Date(Date.now() - 30 * 3600000).toISOString();
        const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-backups-'));
        fs.writeFileSync(path.join(backupDir, `fantasy_football_${new Date().toISOString().slice(0, 10)}.db`), 'x');

        const db = {
            async get(sql) {
                if (sql.includes('FROM nfl_games')) return { count: 16 };
                if (sql.includes('last_daily_update')) return { last_daily_update: staleDate };
                return null;
            }
        };
        const service = new HealthCheckService(db, { alertsFile: tmpAlertsFile(), backupDir });

        const check = await service.checkFreshness(1, 2025);

        expect(check.status).toBe('failed');
        expect(check.message).toContain('daily update');
    });
});

describe('HealthCheckService team code check (check 7)', () => {
    test('flags non-canonical team codes like WSH and full team names', async () => {
        const db = {
            async all(sql) {
                if (sql.includes('FROM player_stats')) return [{ code: 'CHI' }, { code: 'WSH' }];
                if (sql.includes('FROM weekly_rosters')) return [{ code: 'Commanders' }];
                if (sql.includes('FROM nfl_games')) return [{ code: 'WAS' }];
                return [];
            }
        };
        const service = new HealthCheckService(db, { alertsFile: tmpAlertsFile() });

        const check = await service.checkTeamCodes(1, 2025);

        expect(check.status).toBe('warning');
        expect(check.details).toContain("player_stats: 'WSH'");
        expect(check.details).toContain("weekly_rosters: 'Commanders'");
        expect(check.details.some(d => d.includes("'WAS'"))).toBe(false); // WAS is canonical
    });
});

describe('HealthCheckService stats completeness check (check 2)', () => {
    function dbWithMissing(rows) {
        return {
            async all(sql) {
                if (sql.includes('FROM weekly_rosters wr')) return rows;
                return [];
            },
            async get() { return null; }
        };
    }
    const row = (name, injury_designation) => ({
        player_id: name, player_name: name, player_position: 'RB', player_team: 'SEA',
        team_id: 11, injury_designation
    });

    test('passes when nobody is missing', async () => {
        const service = new HealthCheckService(dbWithMissing([]), { alertsFile: tmpAlertsFile() });
        const check = await service.checkStatsCompleteness(1, 2026);
        expect(check.status).toBe('passed');
        expect(check.details).toEqual([]);
    });

    test('passes (expected) when every missing player carries an injury designation', async () => {
        const service = new HealthCheckService(
            dbWithMissing([row('Zach Charbonnet', 'Out'), row('De\'Zhaun Stribling', 'Questionable')]),
            { alertsFile: tmpAlertsFile() }
        );
        const check = await service.checkStatsCompleteness(1, 2026);
        expect(check.status).toBe('passed');
        expect(check.message).toMatch(/2 active player\(s\).*expected/);
        expect(check.details).toHaveLength(2);
        expect(check.details[0]).toMatch(/Charbonnet.*Out, expected/);
    });

    test('warns only for missing players with no injury designation', async () => {
        const service = new HealthCheckService(
            dbWithMissing([row('Healthy Guy', null), row('Blank Guy', ''), row('Hurt Guy', 'Out')]),
            { alertsFile: tmpAlertsFile() }
        );
        const check = await service.checkStatsCompleteness(1, 2026);
        expect(check.status).toBe('warning');
        expect(check.message).toMatch(/^2 active player\(s\).*no injury designation \(1 more are injured\/out, expected\)/);
        expect(check.details[0]).toMatch(/Healthy Guy/);
        expect(check.details[2]).toMatch(/Hurt Guy.*Out, expected/);
    });
});

describe('HealthCheckService alert policy (dedupe, warnings are state)', () => {
    test('the same unacknowledged source+message within 24h bumps a counter instead of appending', async () => {
        const service = new HealthCheckService({}, { alertsFile: tmpAlertsFile() });
        const first = await service.recordAlert('critical', 'validation:Freshness', 'Week 1/2026: stale');
        const again = await service.recordAlert('critical', 'validation:Freshness', 'Week 1/2026: stale', ['detail']);
        expect(again.id).toBe(first.id);
        const alerts = await service.getAlerts();
        expect(alerts.length).toBe(1);
        expect(alerts[0].count).toBe(2);
        expect(alerts[0].lastSeen).toBeTruthy();
        expect(alerts[0].details).toEqual(['detail']);
        // acknowledged alerts do not absorb a recurrence
        await service.acknowledgeAlerts([first.id]);
        await service.recordAlert('critical', 'validation:Freshness', 'Week 1/2026: stale');
        expect((await service.getAlerts()).length).toBe(2);
    });

    test('runValidation records alerts only for FAILED checks; warnings stay in the results', async () => {
        const service = new HealthCheckService({}, { alertsFile: tmpAlertsFile() });
        service.checkRosterInvariant = async () => ({ name: 'Roster Invariant (12x19)', status: 'passed', message: 'ok' });
        service.checkFreshness = async () => ({ name: 'Freshness', status: 'warning', message: 'meh' });
        service.checkWeekAdvanceDeadline = async () => ({ name: 'Week Advance Deadline', status: 'failed', message: 'ADVANCE' });
        service.checkStatsCompleteness = async () => ({ name: 'Stats Completeness', status: 'warning', message: 'x' });
        const results = await service.runValidation(1, 2026, { mode: 'light' });
        expect(results.summary).toEqual({ passed: 1, failed: 1, warnings: 2 });
        const alerts = await service.getAlerts();
        expect(alerts.map(a => a.source)).toEqual(['validation:Week Advance Deadline']);
        expect(alerts[0].severity).toBe('critical');
    });

    test('full mode registers Schedule Integrity and Clock Sanity after Team Code Consistency; deferred is counted, not failed', async () => {
        const service = new HealthCheckService({}, { alertsFile: tmpAlertsFile(), espnCacheDir: '/tmp/espn-cache-for-test' });
        const passed = name => async () => ({ name, status: 'passed', message: 'ok' });
        service.checkRosterInvariant = passed('Roster Invariant (12x19)');
        service.checkFreshness = passed('Freshness');
        service.checkWeekAdvanceDeadline = passed('Week Advance Deadline');
        service.checkMatchupConsistency = passed('Matchup Consistency');
        service.checkDSTSanity = passed('DST Sanity');
        service.checkTeamCodes = passed('Team Code Consistency');
        service.checkEndOfWeekSuite = passed('End-of-Week Suite');
        const seen = [];
        service.checkScheduleIntegrity = async (week, season) => { seen.push(['schedule', week, season]); return { name: 'Schedule Integrity', status: 'deferred', message: 'no ESPN scoreboard cached yet' }; };
        service.checkClockSanity = async (week, season) => { seen.push(['clock', week, season]); return { name: 'Clock Sanity', status: 'warning', message: 'tz' }; };

        const results = await service.runValidation(3, 2026, { mode: 'full', recordAlerts: false });
        const names = results.checks.map(c => c.name);
        expect(names.indexOf('Schedule Integrity')).toBe(names.indexOf('Team Code Consistency') + 1);
        expect(names.indexOf('Clock Sanity')).toBe(names.indexOf('Schedule Integrity') + 1);
        expect(seen).toEqual([['schedule', 3, 2026], ['clock', 3, 2026]]);
        expect(results.summary).toEqual({ passed: 7, failed: 0, warnings: 1, deferred: 1 });
        expect(results.overallStatus).toBe('passed');
        expect(service.espnCacheDir).toBe('/tmp/espn-cache-for-test');

        // light mode does not run them
        const light = await service.runValidation(3, 2026, { mode: 'light', recordAlerts: false });
        expect(light.checks.map(c => c.name)).not.toContain('Schedule Integrity');
    });

    test('espnCacheDir defaults to logs/doublecheck/espn and the wrappers hand it to sanityChecks', () => {
        const service = new HealthCheckService({}, { alertsFile: tmpAlertsFile() });
        expect(service.espnCacheDir).toBe(path.resolve(__dirname, '../../logs/doublecheck/espn'));
        expect(typeof service.checkScheduleIntegrity).toBe('function');
        expect(typeof service.checkClockSanity).toBe('function');
    });

    test('full-mode End-of-Week Suite never launches the ESPN scrape in-process', async () => {
        const calls = [];
        const service = new HealthCheckService({}, { alertsFile: tmpAlertsFile(), testRunnerService: {
            runValidateEndOfWeekTest: async (week, season, opts) => { calls.push(opts); return { overallStatus: 'passed', checks: [], summary: { passed: 0, failed: 0, warnings: 0 } }; }
        } });
        await service.checkEndOfWeekSuite(1, 2026);
        expect(calls).toEqual([{ espn: false }]);
    });
});
