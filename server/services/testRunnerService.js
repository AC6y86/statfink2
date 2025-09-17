const { spawn } = require('child_process');
const path = require('path');
const { logInfo, logError } = require('../utils/errorHandler');

class TestRunnerService {
    constructor(db) {
        this.db = db;
    }

    async getAvailableWeeks(season = 2025) {
        try {
            // Get current week from league settings
            const currentSettings = await this.db.get(`
                SELECT current_week
                FROM league_settings
                WHERE league_id = 1
            `);

            // Get all weeks that have any data (from multiple sources)
            const weeks = await this.db.all(`
                SELECT DISTINCT week
                FROM (
                    SELECT DISTINCT week FROM nfl_games WHERE season = ?
                    UNION
                    SELECT DISTINCT week FROM player_stats WHERE season = ?
                    UNION
                    SELECT DISTINCT week FROM weekly_standings WHERE season = ?
                    UNION
                    SELECT ? as week  -- Include current week from settings
                )
                WHERE week IS NOT NULL
                ORDER BY week DESC
            `, [season, season, season, currentSettings?.current_week || 2]);

            return weeks.map(w => w.week);
        } catch (error) {
            logError('Failed to get available weeks', error);
            throw error;
        }
    }

    async runValidateEndOfWeekTest(week, season = 2025) {
        logInfo(`Running validateEndOfWeek test for week ${week}, season ${season}`);

        try {
            // Import and run the test directly
            const { validateEndOfWeek } = require('../../tests/validateEndOfWeek.test');
            const results = await validateEndOfWeek(week, season);

            // Add formatting for better display
            results.formattedSummary = this.formatTestSummary(results);

            logInfo(`Test completed: ${results.summary.passed} passed, ${results.summary.failed} failed, ${results.summary.warnings} warnings`);

            return results;
        } catch (error) {
            logError('Test execution failed', error);
            return {
                week: week,
                season: season,
                timestamp: new Date().toISOString(),
                overallStatus: 'error',
                error: {
                    message: error.message,
                    stack: error.stack
                },
                checks: [],
                summary: {
                    passed: 0,
                    failed: 0,
                    warnings: 0
                }
            };
        }
    }

    formatTestSummary(results) {
        const { summary } = results;
        const total = summary.passed + summary.failed + summary.warnings;

        let statusEmoji = '✅';
        let statusText = 'All checks passed';

        if (results.overallStatus === 'error') {
            statusEmoji = '❌';
            statusText = 'Test execution error';
        } else if (summary.failed > 0) {
            statusEmoji = '❌';
            statusText = `${summary.failed} check${summary.failed > 1 ? 's' : ''} failed`;
        } else if (summary.warnings > 0) {
            statusEmoji = '⚠️';
            statusText = `Passed with ${summary.warnings} warning${summary.warnings > 1 ? 's' : ''}`;
        }

        return {
            statusEmoji,
            statusText,
            total,
            passRate: total > 0 ? ((summary.passed / total) * 100).toFixed(1) : 0
        };
    }

    async runStatsCompletenessTest(week, season = 2025) {
        logInfo(`Running stats completeness test for week ${week}, season ${season}`);

        return new Promise((resolve, reject) => {
            const testPath = path.join(__dirname, '../../tests/verification/stats-completeness.test.js');
            const env = {
                ...process.env,
                TEST_WEEK: week.toString(),
                TEST_SEASON: season.toString()
            };

            const testProcess = spawn('npx', ['jest', testPath, '--json', '--no-coverage'], {
                env: env,
                cwd: path.join(__dirname, '../..')
            });

            let output = '';
            let errorOutput = '';

            testProcess.stdout.on('data', (data) => {
                output += data.toString();
            });

            testProcess.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });

            testProcess.on('close', (code) => {
                try {
                    // Try to parse Jest JSON output
                    const jsonMatch = output.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        const results = JSON.parse(jsonMatch[0]);
                        resolve(this.formatJestResults(results, week, season));
                    } else {
                        // Fallback to simple pass/fail
                        resolve({
                            week: week,
                            season: season,
                            timestamp: new Date().toISOString(),
                            overallStatus: code === 0 ? 'passed' : 'failed',
                            rawOutput: output,
                            errorOutput: errorOutput,
                            exitCode: code
                        });
                    }
                } catch (error) {
                    logError('Failed to parse test output', error);
                    resolve({
                        week: week,
                        season: season,
                        timestamp: new Date().toISOString(),
                        overallStatus: 'error',
                        error: error.message,
                        rawOutput: output,
                        errorOutput: errorOutput
                    });
                }
            });

            testProcess.on('error', (error) => {
                logError('Failed to spawn test process', error);
                reject(error);
            });
        });
    }

    formatJestResults(jestResults, week, season) {
        const testResults = jestResults.testResults[0] || {};
        const tests = testResults.assertionResults || [];

        const formatted = {
            week: week,
            season: season,
            timestamp: new Date().toISOString(),
            overallStatus: jestResults.success ? 'passed' : 'failed',
            checks: [],
            summary: {
                passed: 0,
                failed: 0,
                warnings: 0
            }
        };

        tests.forEach(test => {
            const check = {
                name: test.title || test.fullName,
                status: test.status === 'passed' ? 'passed' : 'failed',
                message: test.failureMessages ? test.failureMessages.join('\n') : 'Test passed',
                duration: test.duration
            };

            formatted.checks.push(check);

            if (check.status === 'passed') {
                formatted.summary.passed++;
            } else {
                formatted.summary.failed++;
            }
        });

        formatted.formattedSummary = this.formatTestSummary(formatted);

        return formatted;
    }
}

module.exports = TestRunnerService;