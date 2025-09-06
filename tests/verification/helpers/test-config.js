/**
 * Configuration helper for verification tests
 * Allows overriding season and week via environment variables
 */

function getTestConfig() {
    // Default to 2025 season, week 1
    const config = {
        season: parseInt(process.env.TEST_SEASON || '2025'),
        week: parseInt(process.env.TEST_WEEK || '1')
    };
    
    // Validate inputs
    if (config.season < 2020 || config.season > 2030) {
        throw new Error(`Invalid TEST_SEASON: ${config.season}. Must be between 2020 and 2030.`);
    }
    
    if (config.week < 1 || config.week > 18) {
        throw new Error(`Invalid TEST_WEEK: ${config.week}. Must be between 1 and 18.`);
    }
    
    return config;
}

/**
 * Get formatted description for test suite
 */
function getTestDescription() {
    const { season, week } = getTestConfig();
    return `Season ${season}, Week ${week}`;
}

/**
 * Log current test configuration
 */
function logTestConfig() {
    const { season, week } = getTestConfig();
    console.log(`\n🏈 Running verification tests for Season ${season}, Week ${week}`);
    console.log(`   (Set TEST_SEASON and TEST_WEEK environment variables to override)\n`);
}

module.exports = {
    getTestConfig,
    getTestDescription,
    logTestConfig
};