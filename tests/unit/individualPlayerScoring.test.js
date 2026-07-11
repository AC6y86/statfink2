// Unit tests for IndividualPlayerScoringService.getStatUpdates
// Pure in-memory — no database access.
const IndividualPlayerScoringService = require('../../server/services/individualPlayerScoringService');

describe('IndividualPlayerScoringService.getStatUpdates', () => {
    let service;

    beforeEach(() => {
        service = new IndividualPlayerScoringService(null);
    });

    describe('offensive_fumble_recovery_td', () => {
        // Per docs/SCORING_SYSTEM.md: an offensive player recovering a fumble for a
        // TD gets 8 points ("Touchdown Scored by any player"), counted in rushing_tds.
        test('teammate-fumble recovery credits a rushing TD (McBride wk 2 2024)', () => {
            const currentStats = { rushing_tds: 0, fumbles: 0 };
            const updates = service.getStatUpdates('offensive_fumble_recovery_td', currentStats, false);
            expect(updates).toEqual({ rushing_tds: 1 });
        });

        test('own-fumble recovery is skipped — already in rushing_tds from Tank01 (Bigsby wk 5 2024)', () => {
            const currentStats = { rushing_tds: 2 };
            const updates = service.getStatUpdates('offensive_fumble_recovery_td', currentStats, true);
            expect(updates).toEqual({});
        });

        test('increments existing rushing TD count', () => {
            const currentStats = { rushing_tds: 1 };
            const updates = service.getStatUpdates('offensive_fumble_recovery_td', currentStats, false);
            expect(updates).toEqual({ rushing_tds: 2 });
        });
    });

    describe('special teams return TDs (20 points, individual player)', () => {
        test('punt return TD increments punt_return_tds (Shaheed wk 6 2024)', () => {
            const updates = service.getStatUpdates('special_teams_punt_return_td', { punt_return_tds: 0 });
            expect(updates).toEqual({ punt_return_tds: 1 });
        });

        test('kick return TD increments kick_return_tds', () => {
            const updates = service.getStatUpdates('special_teams_kick_return_td', {});
            expect(updates).toEqual({ kick_return_tds: 1 });
        });
    });

    test('defensive play types produce no individual player updates', () => {
        expect(service.getStatUpdates('defensive_fumble_return_td', {})).toEqual({});
        expect(service.getStatUpdates('defensive_int_return_td', {})).toEqual({});
        expect(service.getStatUpdates('defensive_blocked_return_td', {})).toEqual({});
    });
});
