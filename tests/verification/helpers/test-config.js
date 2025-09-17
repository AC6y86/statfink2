/**
 * Configuration helper for verification tests
 * Allows overriding season and week via environment variables
 * Dynamically reads current week from database if not overridden
 */

const Database = require('../../../server/database/database');

let cachedConfig = null;

async function getTestConfigAsync() {
    // Check environment variables first (for override)
    if (process.env.TEST_SEASON && process.env.TEST_WEEK) {
        const config = {
            season: parseInt(process.env.TEST_SEASON),
            week: parseInt(process.env.TEST_WEEK)
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

    // Try to get from database
    try {
        const db = new Database();
        const settings = await db.get('SELECT current_week, season_year FROM league_settings WHERE league_id = 1');
        await db.close();

        if (settings && settings.current_week && settings.season_year) {
            return {
                season: settings.season_year,
                week: settings.current_week
            };
        }
    } catch (error) {
        // Database not available, use defaults
        console.log('Could not read from database, using defaults:', error.message);
    }

    // Fall back to hardcoded defaults (updated to week 2 for 2025)
    return {
        season: 2025,
        week: 2
    };
}

// Synchronous wrapper that uses cached value or defaults
function getTestConfig() {
    // If we have a cached config, return it
    if (cachedConfig) {
        return cachedConfig;
    }

    // Check environment variables first (synchronous)
    if (process.env.TEST_SEASON && process.env.TEST_WEEK) {
        const config = {
            season: parseInt(process.env.TEST_SEASON),
            week: parseInt(process.env.TEST_WEEK)
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

    // Return defaults if no override and no cache
    // This will be updated async on first test run
    return {
        season: 2025,
        week: 2
    };
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
async function logTestConfig() {
    // Try to get async config first for most accurate info
    try {
        const config = await getTestConfigAsync();
        cachedConfig = config; // Cache for future synchronous calls
        console.log(`\n🏈 Running verification tests for Season ${config.season}, Week ${config.week}`);
        console.log(`   (Set TEST_SEASON and TEST_WEEK environment variables to override)\n`);
    } catch (error) {
        // Fall back to synchronous version
        const { season, week } = getTestConfig();
        console.log(`\n🏈 Running verification tests for Season ${season}, Week ${week}`);
        console.log(`   (Set TEST_SEASON and TEST_WEEK environment variables to override)\n`);
    }
}

/**
 * Initialize config cache asynchronously
 * Call this in beforeAll() hooks to ensure database values are loaded
 */
async function initTestConfig() {
    try {
        cachedConfig = await getTestConfigAsync();
    } catch (error) {
        // Ignore errors, will use defaults
    }
}

module.exports = {
    getTestConfig,
    getTestConfigAsync,
    getTestDescription,
    logTestConfig,
    initTestConfig
};