// Compares current 2025 fantasy points against the golden baseline
// (tests/2025/baseline_2025_fantasy_points.json).
//
// IMPORTANT: This test should ALWAYS pass. The baseline is the blessed
// official 2025 record (statfink2 was the league's scorer in 2025), corrected
// per commissioner ruling (2026-07-11, all verified against ESPN play data)
// for 16 as-played scorekeeping errors — see docs/DEFENSIVE_SCORING.md
// "2025 Official-Record Corrections". Highlights: 12 uncredited return TDs
// (+20 each, unrostered), Lockett wk5 +8 / Titans DST wk5 -8, Patriots DST
// wk7 +8, Woody Marks wk15 +8; net matchup effect: Pete over Dan in wk 12.
// A mismatch means a scoring-logic regression — fix the logic, never the
// baseline or the test. If a scoring change is INTENTIONAL (commissioner
// ruling), re-bless with `npm run baseline:2025` and commit the JSON diff.
const BaselineComparator2025 = require('../2025/BaselineComparator2025');

describe('2025 Baseline Comparison (Integration)', () => {
    let comparator;

    beforeEach(async () => {
        comparator = new BaselineComparator2025();
        await comparator.initialize();
    });

    afterEach(async () => {
        await comparator.close();
    });

    test('should have no fantasy point mismatches for roster players', async () => {
        const mismatches = await comparator.compareAll(true);

        const pointMismatches = mismatches.filter(m => m.issue === 'FANTASY_POINTS_MISMATCH');
        if (pointMismatches.length > 0) {
            console.log('\n=== 2025 BASELINE MISMATCHES ===');
            pointMismatches.forEach(m => {
                console.log(`${m.player_name} (Week ${m.week}): current=${m.current_fantasy_points}, baseline=${m.baseline_fantasy_points}, diff=${m.difference.toFixed(1)}`);
            });
        }
        expect(pointMismatches).toHaveLength(0);
    }, 60000);

    test('should have no missing player-weeks in either direction', async () => {
        const mismatches = await comparator.compareAll(true);
        const missing = mismatches.filter(m => m.issue !== 'FANTASY_POINTS_MISMATCH');
        expect(missing).toHaveLength(0);
    }, 60000);

    test('baseline covers all 18 weeks of 2025', () => {
        const weeks = [...new Set(comparator.baseline.players.map(p => p.week))].sort((a, b) => a - b);
        expect(weeks).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    });

    test('baseline has substantial rostered coverage each week', () => {
        // Rostered players who did not play (bye/inactive) have no player_stats
        // row, so weekly counts sit below the full 12x19=228 roster size.
        // Historical range is 162-207; 12*13=156 is the sanity floor.
        for (let week = 1; week <= 18; week++) {
            const rostered = comparator.baseline.players.filter(p => p.week === week && p.rostered);
            expect(rostered.length).toBeGreaterThanOrEqual(12 * 13);
        }
    });
});
