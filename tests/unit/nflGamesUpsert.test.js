/**
 * nflGamesService.upsertGame must never downgrade a Final game: Tank01's
 * schedule endpoint lags the boxscores by hours (2026-09-13: it reported
 * eight finished games as "Scheduled" 90 minutes after they ended).
 */
jest.mock('../../server/utils/errorHandler', () => ({ logInfo: jest.fn(), logError: jest.fn(), logWarn: jest.fn() }));
const NFLGamesService = require('../../server/services/nflGamesService');

function fakeDb(existing) {
    return { runs: [], get: jest.fn(async () => existing), run: jest.fn(async function (sql, params) { this.runs.push(params); }), all: jest.fn(async () => []) };
}

describe('nflGamesService.upsertGame keeps Final games Final', () => {
    test('a schedule row saying Scheduled does not overwrite a Final status or its score', async () => {
        const db = fakeDb({ status: 'Final', home_score: 36, away_score: 31, quarter: null, time_remaining: null });
        const svc = new NFLGamesService(db, null);
        await svc.upsertGame({ gameID: '20260913_BUF@HOU', home: 'HOU', away: 'BUF', gameStatus: 'Scheduled', homePts: '0', awayPts: '0' }, 1, 2026);
        const params = db.runs[0];
        expect(params[10]).toBe('Final');
        expect(params[5]).toBe(36);
        expect(params[6]).toBe(31);
    });

    test('Final/OT is preserved too', async () => {
        const db = fakeDb({ status: 'Final/OT', home_score: 23, away_score: 20, quarter: 'OT', time_remaining: '' });
        const svc = new NFLGamesService(db, null);
        await svc.upsertGame({ gameID: 'g', home: 'KC', away: 'IND', gameStatus: 'Live - In Progress' }, 12, 2025);
        expect(db.runs[0][10]).toBe('Final/OT');
    });

    test('a fresh Final from the feed still lands, and a new game inserts normally', async () => {
        const db = fakeDb({ status: 'Scheduled', home_score: 0, away_score: 0 });
        const svc = new NFLGamesService(db, null);
        await svc.upsertGame({ gameID: 'g', home: 'KC', away: 'IND', gameStatus: 'Final', homePts: '24', awayPts: '21' }, 12, 2025);
        expect(db.runs[0][10]).toBe('Final');
        expect(db.runs[0][5]).toBe(24);
        const db2 = fakeDb(undefined);
        await new NFLGamesService(db2, null).upsertGame({ gameID: 'new', home: 'WSH', away: 'DAL', gameStatus: 'Scheduled' }, 2, 2026);
        expect(db2.runs[0][10]).toBe('Scheduled');
        expect(db2.runs[0][3]).toBe('WAS');
    });
});
