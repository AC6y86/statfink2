/**
 * Guards the week-advance deadline check (healthCheckService).
 *
 * The weekly update is deliberately manual, but it MUST happen before the
 * next week's Thursday-night kickoff - live updates poll current_week, so an
 * unadvanced week silently loses Thursday stats. The daily update runs this
 * check and alerts/emails when the deadline is near.
 */

const { createTempDb, cleanupTempDb } = require('../helpers/tempDb');
const HealthCheckService = require('../../server/services/healthCheckService');

const SEASON = 2026;
const HOUR = 3600;

describe('checkWeekAdvanceDeadline', () => {
    let db;
    let service;
    const now = Math.floor(Date.now() / 1000);

    beforeAll(async () => {
        db = await createTempDb('advance-deadline');
        service = new HealthCheckService(db);
    });

    afterAll(async () => {
        await cleanupTempDb(db);
    });

    async function setGames(games) {
        await db.run('DELETE FROM nfl_games');
        for (const [id, week, status, epoch] of games) {
            await db.run(`INSERT INTO nfl_games (game_id, week, season, home_team, away_team, status, game_time_epoch)
                          VALUES (?, ?, ?, 'KC', 'SF', ?, ?)`, [id, week, SEASON, status, epoch]);
        }
    }

    test('passes while current week still has unfinished games', async () => {
        await setGames([
            ['A', 1, 'Final', now - 24 * HOUR],
            ['B', 1, 'Scheduled', now + 4 * HOUR],
            ['C', 2, 'Scheduled', now + 5 * 24 * HOUR]
        ]);
        const result = await service.checkWeekAdvanceDeadline(1, SEASON);
        expect(result.status).toBe('passed');
    });

    test('fails when week is complete and next kickoff is under 24h away', async () => {
        await setGames([
            ['A', 1, 'Final', now - 48 * HOUR],
            ['B', 1, 'Final/OT', now - 30 * HOUR],
            ['C', 2, 'Scheduled', now + 12 * HOUR]
        ]);
        const result = await service.checkWeekAdvanceDeadline(1, SEASON);
        expect(result.status).toBe('failed');
        expect(result.message).toMatch(/advance/i);
    });

    test('passes when week is complete but next kickoff is comfortably away', async () => {
        await setGames([
            ['A', 1, 'Final', now - 20 * HOUR],
            ['C', 2, 'Scheduled', now + 3 * 24 * HOUR]
        ]);
        const result = await service.checkWeekAdvanceDeadline(1, SEASON);
        expect(result.status).toBe('passed');
    });

    test('warns when week has been complete >72h with no next-week schedule synced', async () => {
        await setGames([
            ['A', 1, 'Final', now - 5 * 24 * HOUR]
        ]);
        const result = await service.checkWeekAdvanceDeadline(1, SEASON);
        expect(result.status).toBe('warning');
    });

    test('passes in the offseason (no games at all)', async () => {
        await setGames([]);
        const result = await service.checkWeekAdvanceDeadline(1, SEASON);
        expect(result.status).toBe('passed');
    });

    test('passes after the final week of the season (week 18, nothing to advance to)', async () => {
        await setGames([
            ['A', 18, 'Final', now - 10 * 24 * HOUR]
        ]);
        const result = await service.checkWeekAdvanceDeadline(18, SEASON);
        expect(result.status).toBe('passed');
    });
});
