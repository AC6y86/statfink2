/**
 * Tests for ScoringPlayersService - the 13-of-19 scoring player selection
 * that determines every matchup score. Mocked DB, never touches the real one.
 *
 * Selection rules: 1 QB + 4 RB + 4 WR/TE + 1 K + 1 BONUS (best remaining
 * offensive player) + 2 DST (best points-allowed and best yards-allowed).
 */
const ScoringPlayersService = require('../../server/services/scoringPlayersService');

/**
 * Build a mock db whose weekly_rosters query returns the given roster.
 * Records every is_scoring UPDATE so tests can inspect the selections.
 */
function mockDb(roster) {
    const updates = [];
    return {
        updates,
        async all(sql) {
            if (sql.includes('FROM weekly_rosters')) {
                // Service orders by fantasy_points DESC; emulate sqlite
                return [...roster].sort((a, b) => (b.fantasy_points || 0) - (a.fantasy_points || 0));
            }
            if (sql.includes('FROM teams')) {
                return [{ team_id: 1 }];
            }
            if (sql.includes('FROM matchups')) {
                return [];
            }
            return [];
        },
        async get() {
            return { total: 0 };
        },
        async run(sql, params) {
            if (sql.includes('SET is_scoring = 1')) {
                updates.push({ scoring_slot: params[0], player_id: params[2] });
            }
            return {};
        }
    };
}

function player(id, position, fantasyPoints, extra = {}) {
    return {
        player_id: id,
        player_name: id,
        player_position: position,
        fantasy_points: fantasyPoints,
        points_allowed: null,
        yards_allowed: null,
        ...extra
    };
}

/** A standard full 19-player roster: 2 QB, 5 RB, 4 WR, 2 TE, 2 K, 2 DST + 2 extra WR */
function standardRoster() {
    return [
        player('QB1', 'QB', 25), player('QB2', 'QB', 18),
        player('RB1', 'RB', 22), player('RB2', 'RB', 17), player('RB3', 'RB', 14),
        player('RB4', 'RB', 11), player('RB5', 'RB', 8),
        player('WR1', 'WR', 21), player('WR2', 'WR', 16), player('WR3', 'WR', 12),
        player('WR4', 'WR', 9), player('WR5', 'WR', 6), player('WR6', 'WR', 4),
        player('TE1', 'TE', 13), player('TE2', 'TE', 7),
        player('K1', 'K', 10), player('K2', 'K', 5),
        player('DSTA', 'DST', 12, { points_allowed: 10, yards_allowed: 300 }),
        player('DSTB', 'DST', 9, { points_allowed: 17, yards_allowed: 250 })
    ];
}

describe('ScoringPlayersService 13-of-19 selection', () => {
    test('selects exactly 13 players: 1 QB + 4 RB + 4 WR/TE + 1 K + 1 BONUS + 2 DST', async () => {
        const db = mockDb(standardRoster());
        const service = new ScoringPlayersService(db);

        const count = await service.calculateTeamScoringPlayers(1, 1, 2025);

        expect(count).toBe(13);
        const slots = db.updates.map(u => u.scoring_slot);
        expect(slots.filter(s => s === 'QB').length).toBe(1);
        expect(slots.filter(s => s.startsWith('RB')).length).toBe(4);
        expect(slots.filter(s => s.startsWith('WR/TE')).length).toBe(4);
        expect(slots.filter(s => s === 'K').length).toBe(1);
        expect(slots.filter(s => s === 'BONUS').length).toBe(1);
        expect(slots.filter(s => s.startsWith('DST')).length).toBe(2);
    });

    test('picks the highest scorers per position', async () => {
        const db = mockDb(standardRoster());
        const service = new ScoringPlayersService(db);
        await service.calculateTeamScoringPlayers(1, 1, 2025);

        const byId = Object.fromEntries(db.updates.map(u => [u.player_id, u.scoring_slot]));
        expect(byId['QB1']).toBe('QB');           // 25 > 18; QB2 only eligible for BONUS
        expect(byId['QB2']).not.toBe('QB');
        expect(byId['RB5']).toBeUndefined();      // 5th RB out (limit 4)
        expect(byId['K1']).toBe('K');             // 10 > 5
        expect(byId['K2']).toBeUndefined();
    });

    test('BONUS goes to the best remaining offensive player', async () => {
        const db = mockDb(standardRoster());
        const service = new ScoringPlayersService(db);
        await service.calculateTeamScoringPlayers(1, 1, 2025);

        // After 1QB/4RB/4WRTE/1K filled, best remaining is QB2 (18 pts)
        const bonus = db.updates.find(u => u.scoring_slot === 'BONUS');
        expect(bonus.player_id).toBe('QB2');
    });

    test('zero-point players are never selected', async () => {
        const roster = standardRoster().map(p =>
            p.player_id === 'QB1' ? { ...p, fantasy_points: 0 } : p
        );
        const db = mockDb(roster);
        const service = new ScoringPlayersService(db);
        await service.calculateTeamScoringPlayers(1, 1, 2025);

        const byId = Object.fromEntries(db.updates.map(u => [u.player_id, u.scoring_slot]));
        expect(byId['QB1']).toBeUndefined();
        expect(byId['QB2']).toBe('QB'); // the other QB takes the slot
    });

    test('DST_PA goes to fewest points allowed, DST_YA to fewest yards allowed', async () => {
        const db = mockDb(standardRoster());
        const service = new ScoringPlayersService(db);
        await service.calculateTeamScoringPlayers(1, 1, 2025);

        const byId = Object.fromEntries(db.updates.map(u => [u.player_id, u.scoring_slot]));
        expect(byId['DSTA']).toBe('DST_PA'); // 10 points allowed < 17
        expect(byId['DSTB']).toBe('DST_YA'); // 250 yards allowed < 300
    });

    test('when one DST is best in both categories, the other DST still fills the second slot', async () => {
        const roster = standardRoster().map(p => {
            if (p.player_id === 'DSTA') return { ...p, points_allowed: 7, yards_allowed: 200 };
            if (p.player_id === 'DSTB') return { ...p, points_allowed: 24, yards_allowed: 400 };
            return p;
        });
        const db = mockDb(roster);
        const service = new ScoringPlayersService(db);
        const count = await service.calculateTeamScoringPlayers(1, 1, 2025);

        expect(count).toBe(13);
        const byId = Object.fromEntries(db.updates.map(u => [u.player_id, u.scoring_slot]));
        expect(byId['DSTA']).toBe('DST_PA');
        expect(byId['DSTB']).toBe('DST_YA'); // next-best yards, not the same DST twice
    });

    test('DSTs without stats (bye week) are not selected', async () => {
        const roster = standardRoster().map(p =>
            p.player_id === 'DSTB' ? { ...p, fantasy_points: null, points_allowed: null, yards_allowed: null } : p
        );
        const db = mockDb(roster);
        const service = new ScoringPlayersService(db);
        await service.calculateTeamScoringPlayers(1, 1, 2025);

        const dstUpdates = db.updates.filter(u => u.scoring_slot.startsWith('DST'));
        // Only DSTA has stats; it must not be double-counted as a distinct second DST
        const distinctDstIds = new Set(dstUpdates.map(u => u.player_id));
        expect(distinctDstIds.size).toBe(1);
        expect(distinctDstIds.has('DSTA')).toBe(true);
    });
});
