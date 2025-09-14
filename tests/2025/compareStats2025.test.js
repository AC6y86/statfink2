const StatsComparator2025 = require('./StatsComparator2025');
const expectedStats = require('./week1_2025_expected_stats');

describe('2025 Week 1 Stats Verification', () => {
    let comparator;

    beforeEach(() => {
        comparator = new StatsComparator2025();
    });

    afterEach(async () => {
        await comparator.close();
    });

    describe('Database Connection', () => {
        test('should initialize database connection successfully', async () => {
            await expect(comparator.initialize()).resolves.not.toThrow();
            expect(comparator.db).toBeTruthy();
        });
    });

    describe('Week 1 Stats Comparison', () => {
        beforeEach(async () => {
            await comparator.initialize();
        });

        test('should verify all Week 1 2025 stats match expected values', async () => {
            await comparator.compareWeek1Stats();

            // Check that there are no mismatches
            if (comparator.mismatches.length > 0) {
                console.log('\n❌ Player mismatches found:');
                comparator.mismatches.forEach(m => {
                    if (m.issue === 'points_mismatch' || !m.issue) {
                        console.log(`   ${m.owner} - ${m.player}: ${m.dbPoints} vs ${m.expectedPoints}`);
                    } else {
                        console.log(`   ${m.owner} - ${m.player}: ${m.issue}`);
                    }
                });
            }

            if (comparator.teamMismatches.length > 0) {
                console.log('\n❌ Team mismatches found:');
                comparator.teamMismatches.forEach(m => {
                    console.log(`   ${m.owner}: ${m.issue} - ${JSON.stringify(m)}`);
                });
            }

            expect(comparator.mismatches.length).toBe(0);
            expect(comparator.teamMismatches.length).toBe(0);
        });

        test('each team should have exactly 19 players', async () => {
            const dbStats = await comparator.getWeek1StatsFromDatabase();
            const teamMappings = await comparator.getTeamMappings();

            // Group by team
            const playersByTeam = {};
            dbStats.forEach(stat => {
                const ownerName = teamMappings[stat.team_id];
                if (!playersByTeam[ownerName]) {
                    playersByTeam[ownerName] = [];
                }
                playersByTeam[ownerName].push(stat);
            });

            // Check each team has 19 players
            Object.keys(expectedStats.teams).forEach(ownerName => {
                const teamPlayers = playersByTeam[ownerName] || [];
                expect(teamPlayers.length).toBe(19);
            });
        });

        test('team totals should match expected values', async () => {
            const dbStats = await comparator.getWeek1StatsFromDatabase();
            const teamMappings = await comparator.getTeamMappings();

            // Calculate team totals
            const teamTotals = {};
            dbStats.forEach(stat => {
                const ownerName = teamMappings[stat.team_id];
                if (!teamTotals[ownerName]) {
                    teamTotals[ownerName] = 0;
                }
                teamTotals[ownerName] += stat.fantasy_points || 0;
            });

            // Compare with expected
            Object.entries(expectedStats.teams).forEach(([ownerName, team]) => {
                const actualTotal = Math.round(teamTotals[ownerName] * 10) / 10;
                const expectedTotal = team.total;
                const diff = Math.abs(actualTotal - expectedTotal);

                if (diff > 0.1) {
                    console.log(`Team total mismatch for ${ownerName}: ${actualTotal} vs ${expectedTotal}`);
                }

                expect(diff).toBeLessThanOrEqual(0.1);
            });
        });

        test('should handle player name variations correctly', () => {
            const testCases = [
                ['Patrick Mahomes', 'Patrick Mahomes'],
                ['Patrick Mahomes Jr.', 'Patrick Mahomes'],
                ['Aaron Jones Sr.', 'Aaron Jones'],
                ['Amon-Ra St. Brown', 'Amon-Ra St. Brown'],
                ['DeVonta Smith Jr.', 'DeVonta Smith']
            ];

            testCases.forEach(([input, expected]) => {
                const normalized = comparator.normalizePlayerName(input);
                const expectedNorm = comparator.normalizePlayerName(expected);
                expect(normalized).toBe(expectedNorm);
            });
        });

        test('should handle defense team variations correctly', () => {
            const testCases = [
                ['San Francisco 49ers Defense', '49ers', true],
                ['Baltimore Ravens Defense', 'Ravens', true],
                ['Patriots DST', 'Patriots', true],
                ['Bears', 'Bears', true],
                ['Dallas Cowboys Defense', 'Cowboys', true]
            ];

            testCases.forEach(([dbName, expName, shouldMatch]) => {
                const dbNorm = comparator.normalizeDefenseName(dbName, '');
                const expNorm = comparator.normalizeDefenseName(expName, '');

                if (shouldMatch) {
                    expect(dbNorm.includes(expNorm) || expNorm.includes(dbNorm)).toBe(true);
                }
            });
        });
    });

    describe('Reporting', () => {
        beforeEach(async () => {
            await comparator.initialize();
        });

        test('should generate comprehensive report', async () => {
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

            await comparator.compareWeek1Stats();
            comparator.generateReport();

            // Check that report was generated
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('WEEK 1 2025 STATS VERIFICATION REPORT')
            );

            consoleSpy.mockRestore();
        });
    });
});

// Run comparison and display results if executed directly
if (require.main === module) {
    console.log('Running 2025 Week 1 Stats Verification...\n');

    const comparator = new StatsComparator2025();

    (async () => {
        try {
            await comparator.initialize();
            await comparator.compareWeek1Stats();
            comparator.generateReport();

            // Exit with appropriate code
            const hasErrors = comparator.mismatches.length > 0 ||
                              comparator.teamMismatches.length > 0;
            process.exit(hasErrors ? 1 : 0);
        } catch (error) {
            console.error('Fatal error:', error);
            process.exit(1);
        } finally {
            await comparator.close();
        }
    })();
}