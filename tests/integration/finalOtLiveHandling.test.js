/**
 * Guards Final/OT game-status handling in nflGamesService.
 *
 * Overtime finals are stored as 'Final/OT' (14 games in 2025). Exact
 * comparisons against 'Final' treated them as live forever: the live-update
 * loop re-polled them every minute and areAllWeekGamesComplete never saw the
 * week finish. Completeness paths were fixed in b3fdb01; these tests pin the
 * remaining live-path behavior.
 */

const { createTempDb, cleanupTempDb } = require('../helpers/tempDb');
const NFLGamesService = require('../../server/services/nflGamesService');

const SEASON = 2026;

describe('Final/OT handling in nflGamesService', () => {
    let db;

    beforeAll(async () => {
        db = await createTempDb('final-ot');

        const sixHoursAgo = Math.floor(Date.now() / 1000) - 6 * 3600;
        const games = [
            ['G_FINAL', 'Final', sixHoursAgo],
            ['G_FINAL_OT', 'Final/OT', sixHoursAgo]
        ];
        for (const [id, status, epoch] of games) {
            await db.run(`INSERT INTO nfl_games (game_id, week, season, home_team, away_team,
                          home_score, away_score, status, game_time_epoch)
                          VALUES (?, 1, ?, 'KC', 'SF', 21, 27, ?, ?)`,
                [id, SEASON, status, epoch]);
        }
    });

    afterAll(async () => {
        await cleanupTempDb(db);
    });

    test('areAllWeekGamesComplete counts Final/OT as complete', async () => {
        const service = new NFLGamesService(db, null);
        const completion = await service.areAllWeekGamesComplete(1, SEASON);
        expect(completion.totalGames).toBe(2);
        expect(completion.completedGames).toBe(2);
        expect(completion.isComplete).toBe(true);
    });

    test('live update does not re-poll long-finished Final/OT games', async () => {
        const service = new NFLGamesService(db, null);
        const polled = [];
        service.updateGameFromAPI = async (gameId) => {
            polled.push(gameId);
            return false;
        };

        const result = await service.updateLiveScores(1, SEASON);

        expect(result.success).toBe(true);
        // Both games ended >4h ago: neither the plain Final nor the Final/OT
        // game should be treated as live.
        expect(polled).toEqual([]);
    });
});
