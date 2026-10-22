/**
 * The live stats writer must skip boxscore entries for players who are not in
 * nfl_players (non-draftable positions) instead of failing the FK per player.
 */
jest.mock('../../server/utils/errorHandler', () => ({ logInfo: jest.fn(), logError: jest.fn(), logWarn: jest.fn() }));
const { logInfo, logError } = require('../../server/utils/errorHandler');
const NFLGamesService = require('../../server/services/nflGamesService');

function fakeDb() {
    return {
        runs: [],
        async get(sql) { if (/FROM nfl_games/.test(sql)) return { week: 1, season: 2026 }; return undefined; },
        async all(sql) { if (/FROM nfl_players/.test(sql)) return [{ player_id: '100' }, { player_id: 'DEF_KC' }]; return []; },
        async run(sql, params) { this.runs.push(params); }
    };
}

describe('nflGamesService.updatePlayerStatsFromBoxScore skips non-draftable players', () => {
    test('inserts known players, skips unknown ones without errors, logs one summary', async () => {
        const db = fakeDb();
        const svc = new NFLGamesService(db, null);
        svc.scoringService = { calculateFantasyPoints: () => 0 };
        await svc.updatePlayerStatsFromBoxScore('20260913_KC@LAC', {
            '100': { longName: 'Known Guy', teamAbv: 'KC', Passing: { passYds: '10' } },
            '4685287': { longName: 'Jihaad Campbell', teamAbv: 'PHI', Defense: { totalTackles: '9' } },
            '999': { longName: 'Some Punter', teamAbv: 'KC', Punting: {} }
        });
        expect(db.runs.length).toBe(1);
        expect(db.runs[0][0]).toBe('100');
        expect(logError).not.toHaveBeenCalled();
        const summary = logInfo.mock.calls.map(c => c[0]).find(m => /skipped 2 non-draftable/.test(m));
        expect(summary).toMatch(/Updated 1 player stats for game 20260913_KC@LAC/);
    });
});
