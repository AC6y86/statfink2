/**
 * Regression tests for the end-of-week validation checks, run read-only
 * against the blessed 2025 season data.
 *
 * Guards the fixes for:
 *  - checkCumulativePoints previously using LAG() after a single-week WHERE
 *    filter (prev week always NULL, so the check failed every week >= 2)
 *  - DST bonus checks recomputing the expected bonus (incl. tie splits)
 *    instead of only asserting some bonus exists
 *  - standings checks handling playoff weeks (13+), where W/L/T are frozen
 *  - zero-occurrence weeks (2pt conversions, defensive TDs) warning, not failing
 */
const DatabaseManager = require('../../server/database/database');
const {
    checkTwoPointConversions,
    checkFewestYardsBonus,
    checkFewestPointsBonus,
    checkCumulativePoints,
    checkStandingsUpdated,
    checkStandingsWinLossDeltas
} = require('../validateEndOfWeek.test.js');

const SEASON = 2025;

describe('End-of-week validation checks (2025 blessed data)', () => {
    let db;
    let has2025Data = false;

    beforeAll(async () => {
        db = new DatabaseManager();
        await new Promise(resolve => setTimeout(resolve, 100));
        const row = await db.get(
            'SELECT COUNT(*) as count FROM weekly_standings WHERE season = ?', [SEASON]
        );
        has2025Data = row && row.count > 0;
    });

    afterAll(async () => {
        if (db) {
            await db.close();
        }
    });

    function skipWithout2025(testFn) {
        return async () => {
            if (!has2025Data) {
                console.warn('No 2025 data in database - skipping');
                return;
            }
            await testFn();
        };
    }

    describe('checkCumulativePoints (LAG regression)', () => {
        for (const week of [2, 5, 18]) {
            test(`week ${week}: all teams have correct cumulative points`, skipWithout2025(async () => {
                const result = await checkCumulativePoints(db, week, SEASON);
                expect(result.status).toBe('passed');
                expect(result.value).toBe(12); // all 12 teams correct
            }));
        }
    });

    describe('DST bonus correctness checks', () => {
        // Week 5 has a single leader (5.00 pts); week 17 has a yards tie (2.50 each)
        for (const week of [5, 17]) {
            test(`week ${week}: fewest yards bonus awarded to the correct units`, skipWithout2025(async () => {
                const result = await checkFewestYardsBonus(db, week, SEASON);
                expect(result.status).toBe('passed');
                // Total awarded is always the full 5 points regardless of ties
                expect(result.value).toBeCloseTo(5, 2);
            }));

            test(`week ${week}: fewest points bonus awarded to the correct units`, skipWithout2025(async () => {
                const result = await checkFewestPointsBonus(db, week, SEASON);
                expect(result.status).toBe('passed');
                expect(result.value).toBeCloseTo(5, 2);
            }));
        }
    });

    describe('standings checks across regular season and playoffs', () => {
        for (const week of [5, 12, 13, 17]) {
            test(`week ${week}: standings totals match expected game counts`, skipWithout2025(async () => {
                const result = await checkStandingsUpdated(db, week, SEASON);
                expect(result.status).toBe('passed');
            }));

            test(`week ${week}: matchup winners match standings W/L/T deltas`, skipWithout2025(async () => {
                const result = await checkStandingsWinLossDeltas(db, week, SEASON);
                expect(result.status).toBe('passed');
            }));
        }
    });

    describe('zero-occurrence weeks warn instead of failing', () => {
        test('week 17: zero two-point conversions is a warning', skipWithout2025(async () => {
            const result = await checkTwoPointConversions(db, 17, SEASON);
            expect(result.status).toBe('warning');
        }));
    });
});
