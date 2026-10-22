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

describe('IndividualPlayerScoringService.applyTwoPointConversions (season-gated, from play text)', () => {
    // In-memory fake DB: nfl_players + player_stats maps
    function fakeDb({ players, stats }) {
        const db = {
            players, stats, updates: [], inserts: [],
            async get(sql, params) {
                if (/FROM nfl_players p\s+JOIN player_stats ps/i.test(sql)) {
                    const [name, week, season, gameId] = params;
                    const p = players.find(x => x.name === name);
                    return p && stats[p.player_id] && stats[p.player_id].game_id === gameId ? p : undefined;
                }
                if (/FROM player_stats WHERE player_id/i.test(sql)) return stats[params[0]];
                return undefined;
            },
            async all(sql, params) {
                if (/FROM nfl_players WHERE name = \?/i.test(sql)) return players.filter(x => x.name === params[0]);
                return [];
            },
            async run(sql, params) {
                if (/INSERT INTO player_stats/i.test(sql)) { db.inserts.push(params); stats[params[0]] = { player_id: params[0], game_id: params[3] }; }
                if (/UPDATE player_stats SET/i.test(sql)) { db.updates.push({ sql, params }); }
            }
        };
        return db;
    }
    const DANIELS = { player_id: '4426348', name: 'Jayden Daniels', position: 'QB', team: 'WAS' };
    const MCCAFFREY = { player_id: '4569618', name: 'Luke McCaffrey', position: 'WR', team: 'WAS' };
    const play = { playerName: 'Deebo Samuel', scoringTeam: 'WAS', playType: null,
        twoPoint: { passer: 'Jayden Daniels', receiver: 'Luke McCaffrey' } };

    test('2026: fills a missing Tank01 two-point field for passer and receiver; receiver gets a minimal row', async () => {
        const db = fakeDb({ players: [DANIELS, MCCAFFREY], stats: { '4426348': { player_id: '4426348', game_id: 'g1', two_point_conversions_pass: 0 } } });
        const svc = new IndividualPlayerScoringService(db);
        const res = await svc.applyTwoPointConversions([play], 2, 2026, 'g1');
        expect(res.applied).toBe(2);
        expect(db.updates.map(u => u.sql.match(/SET (\w+) = \?/)[1]).sort()).toEqual(['two_point_conversions_pass', 'two_point_conversions_rec']);
        expect(db.inserts.length).toBe(1);
        expect(db.inserts[0][0]).toBe('4569618');
    });

    test('never double-counts a conversion Tank01 already recorded', async () => {
        const db = fakeDb({ players: [DANIELS, MCCAFFREY], stats: {
            '4426348': { player_id: '4426348', game_id: 'g1', two_point_conversions_pass: 1 },
            '4569618': { player_id: '4569618', game_id: 'g1', two_point_conversions_rec: 1 } } });
        const res = await new IndividualPlayerScoringService(db).applyTwoPointConversions([play], 2, 2026, 'g1');
        expect(res.applied).toBe(0);
        expect(db.updates).toEqual([]);
    });

    test('two conversions by the same passer in one game raise the column to 2, not 1', async () => {
        const db = fakeDb({ players: [DANIELS, MCCAFFREY], stats: { '4426348': { player_id: '4426348', game_id: 'g1', two_point_conversions_pass: 1 }, '4569618': { player_id: '4569618', game_id: 'g1', two_point_conversions_rec: 2 } } });
        await new IndividualPlayerScoringService(db).applyTwoPointConversions([play, play], 2, 2026, 'g1');
        expect(db.updates.length).toBe(1);
        expect(db.updates[0].params[0]).toBe(2);
    });

    test('2025 (legacy): nothing is applied — blessed record unchanged', async () => {
        const db = fakeDb({ players: [DANIELS, MCCAFFREY], stats: { '4426348': { player_id: '4426348', game_id: 'g1', two_point_conversions_pass: 0 } } });
        const res = await new IndividualPlayerScoringService(db).applyTwoPointConversions([play], 2, 2025, 'g1');
        expect(res.applied).toBe(0);
        expect(db.updates).toEqual([]);
        expect(db.inserts).toEqual([]);
    });

    test('rush conversions and plays without twoPoint are handled', async () => {
        const db = fakeDb({ players: [{ player_id: '1', name: 'Rhamondre Stevenson', position: 'RB', team: 'NE' }], stats: { '1': { player_id: '1', game_id: 'g2', two_point_conversions_run: 0 } } });
        const res = await new IndividualPlayerScoringService(db).applyTwoPointConversions([
            { scoringTeam: 'NE', playType: 'other', twoPoint: { rusher: 'Rhamondre Stevenson' } },
            { scoringTeam: 'NE', playType: 'other', twoPoint: null }
        ], 2, 2026, 'g2');
        expect(res.applied).toBe(1);
        expect(db.updates[0].sql).toContain('two_point_conversions_run');
    });
});
