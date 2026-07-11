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
