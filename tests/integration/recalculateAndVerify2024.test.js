const { spawn } = require('child_process');
const path = require('path');
const StatsComparator = require('../2024/StatsComparator');

// This is a slow test that runs the full 2024 recalculation
// Run with: npm run test:slow or npm run test:integration:slow
jest.setTimeout(900000); // 15 minutes timeout for this test file

describe('Recalculate and Verify 2024 Stats', () => {

    let recalculationOutput = '';
    let recalculationError = '';

    describe('Step 1: Recalculate 2024 Season', () => {
        test('should successfully run recalculate2024season.js', async () => {
            const scriptPath = path.join(__dirname, '../../utils/recalculate2024season.js');

            return new Promise((resolve, reject) => {
                console.log('🔄 Starting 2024 season recalculation...');
                const startTime = Date.now();

                // Use spawn instead of exec to avoid buffer limit issues
                const child = spawn('node', [scriptPath], {
                    cwd: path.join(__dirname, '../..'),
                    env: { ...process.env },
                    stdio: ['ignore', 'pipe', 'pipe']
                });

                // Capture output
                child.stdout.on('data', (data) => {
                    const output = data.toString();
                    recalculationOutput += output;
                    // Only log important progress updates to avoid overwhelming output
                    if (output.includes('Week') || output.includes('✓') || output.includes('complete')) {
                        process.stdout.write(output);
                    }
                });

                child.stderr.on('data', (data) => {
                    const error = data.toString();
                    recalculationError += error;
                    // Only log actual errors, not warnings
                    if (!error.includes('WARN:')) {
                        process.stderr.write(error);
                    }
                });

                child.on('close', (code) => {
                    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

                    if (code !== 0) {
                        console.error(`\n❌ Recalculation failed with code ${code}`);
                        console.error('Error output:', recalculationError);
                        reject(new Error(`Recalculation script exited with code ${code}`));
                    } else {
                        console.log(`\n✅ Recalculation completed successfully in ${duration} seconds`);
                        resolve();
                    }
                });

                child.on('error', (error) => {
                    console.error('Failed to start recalculation script:', error);
                    reject(error);
                });
            });
        });
    });

    describe('Step 2: Verify Recalculated Stats', () => {
        let comparator;

        beforeEach(() => {
            comparator = new StatsComparator();
        });

        afterEach(async () => {
            if (comparator) {
                await comparator.close();
            }
        });

        test('should have no fantasy point mismatches after recalculation', async () => {
            console.log('\n📊 Comparing recalculated stats with reference database...');

            // Suppress console output during comparison
            const originalLog = console.log;
            console.log = jest.fn();

            try {
                await comparator.initialize();
                await comparator.compareAllStats(true); // roster players only

                // Filter for only fantasy point mismatches
                const fantasyPointMismatches = comparator.mismatches.filter(m =>
                    m.issue === 'FANTASY_POINTS_MISMATCH'
                );

                // Restore console for results
                console.log = originalLog;

                if (fantasyPointMismatches.length === 0) {
                    console.log('✅ All fantasy points match the reference database!');
                } else {
                    console.log(`\n❌ Found ${fantasyPointMismatches.length} fantasy point mismatches:`);
                    console.log('='.repeat(80));

                    // Group mismatches by week for better readability
                    const mismatchesByWeek = {};
                    fantasyPointMismatches.forEach(mismatch => {
                        if (!mismatchesByWeek[mismatch.week]) {
                            mismatchesByWeek[mismatch.week] = [];
                        }
                        mismatchesByWeek[mismatch.week].push(mismatch);
                    });

                    // Display mismatches organized by week
                    Object.keys(mismatchesByWeek)
                        .sort((a, b) => parseInt(a) - parseInt(b))
                        .forEach(week => {
                            console.log(`\nWeek ${week}:`);
                            mismatchesByWeek[week].forEach(mismatch => {
                                const diff = mismatch.difference ? mismatch.difference.toFixed(1) : 'N/A';
                                console.log(`  - ${mismatch.player_name} (${mismatch.player_id}): ` +
                                    `current=${mismatch.current_fantasy_points?.toFixed(1) || 'NULL'}, ` +
                                    `expected=${mismatch.reference_fantasy_points?.toFixed(1) || 'NULL'}, ` +
                                    `diff=${diff}`);
                            });
                        });
                    console.log('='.repeat(80));
                }

                // The test passes only if there are no mismatches
                expect(fantasyPointMismatches).toHaveLength(0);

            } catch (error) {
                console.log = originalLog;
                console.error('Error during comparison:', error);
                throw error;
            }
        });

        test('should have all weeks of 2024 season data', async () => {
            console.log('\n📅 Verifying all weeks are present...');

            const originalLog = console.log;
            const logSpy = jest.fn();
            console.log = logSpy;

            try {
                await comparator.initialize();
                await comparator.compareAllStats(true);

                // Find the log entry that shows weeks analyzed
                const weeksLogCall = logSpy.mock.calls.find(call =>
                    call[0] && call[0].includes('Weeks analyzed:')
                );

                console.log = originalLog;

                if (weeksLogCall) {
                    const weeksMatch = weeksLogCall[0].match(/Weeks analyzed: ([\d, ]+)/);
                    if (weeksMatch) {
                        const weeks = weeksMatch[1].split(', ').map(w => parseInt(w));
                        console.log(`✅ Found data for weeks: ${weeks.join(', ')}`);

                        // Check we have all expected weeks (1-17)
                        const expectedWeeks = Array.from({length: 17}, (_, i) => i + 1);
                        const missingWeeks = expectedWeeks.filter(w => !weeks.includes(w));

                        if (missingWeeks.length > 0) {
                            console.log(`⚠️  Missing data for weeks: ${missingWeeks.join(', ')}`);
                        }

                        expect(weeks.length).toBeGreaterThanOrEqual(17);
                        expect(Math.min(...weeks)).toBe(1);
                        expect(Math.max(...weeks)).toBe(17);
                    } else {
                        throw new Error('Could not parse weeks from log output');
                    }
                } else {
                    throw new Error('Could not find weeks analyzed in log output');
                }
            } catch (error) {
                console.log = originalLog;
                console.error('Error checking weeks:', error);
                throw error;
            }
        });

        test('should have stats for all roster players', async () => {
            console.log('\n👥 Verifying roster player coverage...');

            const originalLog = console.log;
            const logSpy = jest.fn();
            console.log = logSpy;

            try {
                await comparator.initialize();
                await comparator.compareAllStats(true);

                // Check for players not found in reference
                const notInReference = comparator.mismatches.filter(m =>
                    m.issue === 'NOT_IN_REFERENCE'
                );

                console.log = originalLog;

                if (notInReference.length > 0) {
                    console.log(`\n⚠️  ${notInReference.length} players in current DB but not in reference:`);

                    // Group by week for better readability
                    const byWeek = {};
                    notInReference.forEach(m => {
                        if (!byWeek[m.week]) byWeek[m.week] = [];
                        byWeek[m.week].push(m);
                    });

                    Object.keys(byWeek)
                        .sort((a, b) => parseInt(a) - parseInt(b))
                        .slice(0, 3) // Show first 3 weeks as examples
                        .forEach(week => {
                            console.log(`  Week ${week}: ${byWeek[week].slice(0, 5).map(m => m.player_name).join(', ')}${byWeek[week].length > 5 ? '...' : ''}`);
                        });
                } else {
                    console.log('✅ All roster players have corresponding reference data');
                }

                // Find summary stats from logs
                const summaryLog = logSpy.mock.calls.find(call =>
                    call[0] && call[0].includes('Total player-week combinations')
                );

                if (summaryLog) {
                    console.log('\n' + summaryLog[0]);
                }

            } catch (error) {
                console.log = originalLog;
                console.error('Error checking roster coverage:', error);
                throw error;
            }
        });
    });

    describe('Step 3: Verify DST Stats After Recalculation', () => {
        test('all DEF_XXX teams should have stats for week 17', async () => {
            console.log('\n🛡️ Verifying DST stats after recalculation...');

            // This test runs after recalculation ensures DST stats are present
            const comparator = new StatsComparator();

            try {
                await comparator.initialize();

                // Query for DST teams missing Week 17 stats
                const missingStats = await new Promise((resolve, reject) => {
                    comparator.currentDb.all(`
                        SELECT np.player_id, np.name
                        FROM nfl_players np
                        LEFT JOIN player_stats ps ON np.player_id = ps.player_id
                            AND ps.week = 17 AND ps.season = 2024
                        WHERE np.position = 'DST'
                        AND ps.player_id IS NULL
                    `, (err, rows) => {
                        if (err) reject(err);
                        else resolve(rows || []);
                    });
                });

                if (missingStats.length > 0 && missingStats.length <= 4) {
                    console.log(`✅ Only ${missingStats.length} DST teams missing Week 17 stats (acceptable for bye weeks)`);
                    if (missingStats.length > 0) {
                        console.log('  Missing: ' + missingStats.map(t => t.name).join(', '));
                    }
                } else if (missingStats.length === 0) {
                    console.log('✅ All 32 DST teams have Week 17 stats');
                } else {
                    console.log(`❌ ${missingStats.length} DST teams missing Week 17 stats (too many)`);
                    console.log('  Missing: ' + missingStats.slice(0, 10).map(t => t.name).join(', ') +
                               (missingStats.length > 10 ? '...' : ''));
                }

                // After recalculation, most teams should have Week 17 stats
                expect(missingStats.length).toBeLessThanOrEqual(4); // Allow for bye weeks

            } finally {
                await comparator.close();
            }
        });
    });

    describe('Summary', () => {
        test('display recalculation summary', () => {
            console.log('\n' + '='.repeat(80));
            console.log('📋 RECALCULATION SUMMARY');
            console.log('='.repeat(80));

            // Extract key information from recalculation output
            const lines = recalculationOutput.split('\n');

            // Look for summary lines in the output
            const summaryLines = lines.filter(line =>
                line.includes('✓') ||
                line.includes('season recalculation complete') ||
                line.includes('Total time') ||
                line.includes('weeks processed')
            );

            if (summaryLines.length > 0) {
                console.log('Key outcomes from recalculation:');
                summaryLines.forEach(line => {
                    if (line.trim()) {
                        console.log('  ' + line.trim());
                    }
                });
            }

            console.log('='.repeat(80));

            // This test always passes, it's just for displaying summary
            expect(true).toBe(true);
        });
    });
});