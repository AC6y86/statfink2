const { spawn } = require('child_process');
const path = require('path');
const BaselineComparator2025 = require('../2025/BaselineComparator2025');

// Recalculates the ENTIRE 2025 season from cached boxscores, then verifies
// every rostered player-week against the golden baseline
// (tests/2025/baseline_2025_fantasy_points.json).
//
// IMPORTANT: This test should ALWAYS pass. The baseline is the blessed
// official 2025 record, corrected per commissioner ruling for 16 as-played
// scorekeeping errors (see docs/DEFENSIVE_SCORING.md "2025 Official-Record
// Corrections"). A mismatch after recalculation means a scoring-logic
// regression — fix the logic, never the baseline or the test. For an
// INTENTIONAL scoring change (commissioner ruling), re-bless with
// `npm run baseline:2025` and commit the JSON diff.
//
// Run with: npm run test:slow or npm run test:integration:slow
jest.setTimeout(900000); // 15 minutes for the full-season recalculation

describe('Recalculate and Verify 2025 Stats', () => {

    describe('Step 1: Recalculate 2025 Season', () => {
        test('should successfully run recalculate2025season.js', async () => {
            const scriptPath = path.join(__dirname, '../../utils/recalculate2025season.js');

            return new Promise((resolve, reject) => {
                console.log('🔄 Starting 2025 season recalculation...');
                const startTime = Date.now();

                const child = spawn('node', [scriptPath], {
                    cwd: path.join(__dirname, '../..'),
                    env: { ...process.env },
                    stdio: ['ignore', 'pipe', 'pipe']
                });

                child.stdout.on('data', (data) => {
                    const output = data.toString();
                    if (output.includes('Week') || output.includes('✓') || output.includes('complete')) {
                        process.stdout.write(output);
                    }
                });

                let stderr = '';
                child.stderr.on('data', (data) => {
                    stderr += data.toString();
                });

                child.on('close', (code) => {
                    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                    console.log(`Recalculation finished in ${elapsed}s with exit code ${code}`);
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error(`recalculate2025season.js exited with code ${code}\n${stderr.slice(-2000)}`));
                    }
                });
            });
        });
    });

    describe('Step 2: Verify Recalculated Stats', () => {
        let comparator;

        beforeEach(async () => {
            comparator = new BaselineComparator2025();
            await comparator.initialize();
        });

        afterEach(async () => {
            await comparator.close();
        });

        test('should have no fantasy point mismatches after recalculation', async () => {
            const mismatches = await comparator.compareAll(true);
            const pointMismatches = mismatches.filter(m => m.issue === 'FANTASY_POINTS_MISMATCH');

            if (pointMismatches.length > 0) {
                console.log('\n=== 2025 POST-RECALC MISMATCHES ===');
                pointMismatches.forEach(m => {
                    console.log(`${m.player_name} (Week ${m.week}): current=${m.current_fantasy_points}, baseline=${m.baseline_fantasy_points}, diff=${m.difference.toFixed(1)}`);
                });
            }
            expect(pointMismatches).toHaveLength(0);
        }, 120000);

        test('should have no missing rostered player-weeks after recalculation', async () => {
            const mismatches = await comparator.compareAll(true);
            const missing = mismatches.filter(m => m.issue !== 'FANTASY_POINTS_MISMATCH');
            if (missing.length > 0) {
                console.log('\n=== 2025 POST-RECALC MISSING ROWS ===');
                missing.forEach(m => console.log(`${m.issue}: ${m.player_name} week ${m.week}`));
            }
            expect(missing).toHaveLength(0);
        }, 120000);
    });
});
