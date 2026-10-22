/**
 * Independent rubric for the Double Check job — every tier boundary, DST
 * gating on position, rounding, legacy return_tds, and the bonus split.
 */
const { pointsFor, defensiveBonuses, tierPoints, PASSING_TIERS, YARDAGE_TIERS, POINTS } = require('../../scripts/lib/doublecheckRubric');

describe('doublecheckRubric.pointsFor', () => {
    test('touchdowns and conversions', () => {
        expect(pointsFor({ passing_tds: 2 }, 'QB').points).toBe(10);
        expect(pointsFor({ rushing_tds: 1, receiving_tds: 1 }, 'RB').points).toBe(16);
        expect(pointsFor({ two_point_conversions_pass: 1, two_point_conversions_run: 1, two_point_conversions_rec: 1 }, 'QB').points).toBe(6);
    });

    test('passing tiers are highest-only and boundaries are inclusive', () => {
        const p = y => pointsFor({ passing_yards: y }, 'QB').points;
        expect(p(174)).toBe(0); expect(p(175)).toBe(6); expect(p(249)).toBe(6);
        expect(p(250)).toBe(9); expect(p(324)).toBe(9); expect(p(325)).toBe(12);
        expect(p(399)).toBe(12); expect(p(400)).toBe(15); expect(p(600)).toBe(15);
    });

    test('rushing/receiving tiers', () => {
        const r = y => pointsFor({ rushing_yards: y }, 'RB').points;
        const c = y => pointsFor({ receiving_yards: y }, 'WR').points;
        for (const f of [r, c]) {
            expect(f(49)).toBe(0); expect(f(50)).toBe(3); expect(f(75)).toBe(6); expect(f(99)).toBe(6);
            expect(f(100)).toBe(9); expect(f(150)).toBe(12); expect(f(200)).toBe(15); expect(f(300)).toBe(15);
        }
        expect(pointsFor({ rushing_yards: 100, receiving_yards: 100 }, 'RB').points).toBe(18);
    });

    test('Stafford 317 yds + 1 TD is 14 (historical bug was 12)', () => {
        expect(pointsFor({ passing_yards: 317, passing_tds: 1 }, 'QB').points).toBe(14);
    });

    test('kickers: FG flat 2, XP 0.5, distance and misses irrelevant', () => {
        expect(pointsFor({ field_goals_made: 3, field_goals_attempted: 5, extra_points_made: 3, extra_points_attempted: 4, field_goals_50_plus: 3 }, 'K').points).toBe(7.5);
    });

    test('nothing is negative; receptions, INTs, fumbles, sacks are zero', () => {
        expect(pointsFor({ receptions: 12, interceptions: 4, fumbles: 3, sacks: 5, def_interceptions: 3, fumbles_recovered: 2 }, 'WR').points).toBe(0);
        expect(pointsFor({ sacks: 5, def_interceptions: 3, fumbles_recovered: 2, def_touchdowns: 2 }, 'DST').points).toBe(0);
    });

    test('DST scoring only applies with a defense position', () => {
        const row = { def_int_return_tds: 1, def_fumble_return_tds: 1, def_blocked_return_tds: 1, safeties: 1, def_points_bonus: 2.5, def_yards_bonus: 5 };
        expect(pointsFor(row, 'DST').points).toBe(33.5);
        expect(pointsFor(row, 'DEF').points).toBe(33.5);
        expect(pointsFor(row, 'QB').points).toBe(0);
        expect(pointsFor(row, null).points).toBe(0);
    });

    test('return TDs are 20 for any row, legacy return_tds included', () => {
        expect(pointsFor({ kick_return_tds: 1 }, 'WR').points).toBe(20);
        expect(pointsFor({ punt_return_tds: 1, receiving_yards: 50 }, 'WR').points).toBe(23);
        expect(pointsFor({ return_tds: 1 }, 'RB').points).toBe(20);
        expect(pointsFor({ kick_return_tds: 1 }, 'DST').points).toBe(20);
    });

    test('rounds to 2 decimals and tolerates strings/nulls', () => {
        expect(pointsFor({ extra_points_made: '3', passing_yards: null, rushing_tds: undefined }, 'K').points).toBe(1.5);
        expect(pointsFor({ def_points_bonus: 1.6666667 }, 'DST').points).toBe(1.67);
    });

    test('breakdown lists only non-zero components with tier detail', () => {
        const { breakdown } = pointsFor({ passing_yards: 287, passing_tds: 1 }, 'QB');
        expect(breakdown.map(b => b.label)).toEqual(['passing_tds', 'passing_yards']);
        expect(breakdown[1].detail).toContain('tier 250');
    });

    test('tier tables are as documented', () => {
        expect(PASSING_TIERS).toEqual([[400, 15], [325, 12], [250, 9], [175, 6]]);
        expect(YARDAGE_TIERS).toEqual([[200, 15], [150, 12], [100, 9], [75, 6], [50, 3]]);
        expect(tierPoints(0, YARDAGE_TIERS)).toEqual({ points: 0, tier: null });
        expect(POINTS.RETURN_TD).toBe(20);
    });
});

describe('doublecheckRubric.defensiveBonuses', () => {
    test('single winners get 5, ties split, NULLs excluded', () => {
        const pool = [
            { player_id: 'DEF_A', points_allowed: 0, yards_allowed: 300 },
            { player_id: 'DEF_B', points_allowed: 0, yards_allowed: 200 },
            { player_id: 'DEF_C', points_allowed: 14, yards_allowed: 200 },
            { player_id: 'DEF_D', points_allowed: null, yards_allowed: null }
        ];
        const b = defensiveBonuses(pool);
        expect(b.minPoints).toBe(0);
        expect(b.minYards).toBe(200);
        expect(b.points.get('DEF_A')).toBe(2.5);
        expect(b.points.get('DEF_B')).toBe(2.5);
        expect(b.points.has('DEF_C')).toBe(false);
        expect(b.yards.get('DEF_B')).toBe(2.5);
        expect(b.yards.get('DEF_C')).toBe(2.5);
        expect(b.points.has('DEF_D')).toBe(false);
    });

    test('three-way tie pays 1.67 each', () => {
        const b = defensiveBonuses([1, 2, 3].map(i => ({ player_id: `DEF_${i}`, points_allowed: 7, yards_allowed: 100 + i })));
        expect([...b.points.values()]).toEqual([1.67, 1.67, 1.67]);
        expect(b.yards.get('DEF_1')).toBe(5);
    });

    test('empty pool', () => {
        const b = defensiveBonuses([]);
        expect(b.minPoints).toBeNull();
        expect(b.points.size).toBe(0);
    });
});
