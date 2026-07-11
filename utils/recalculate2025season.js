#!/usr/bin/env node

/**
 * Recalculate 2025 Season Script
 *
 * Complete recalculation of the 2025 fantasy football season (18 weeks),
 * including syncing games, player stats, calculating fantasy points, and
 * updating team scores. All 2025 boxscores are permanently cached in
 * tank01_cache, so this runs offline.
 *
 * Thin wrapper around the SeasonRecalculationOrchestrator service.
 *
 * Usage: node utils/recalculate2025season.js
 */

// Load environment variables
require('dotenv').config();

const SeasonRecalculationOrchestrator = require('../server/services/seasonRecalculationOrchestrator');
const { logError } = require('../server/utils/errorHandler');

// Main execution
async function main() {
    const orchestrator = new SeasonRecalculationOrchestrator(2025, 18);

    try {
        await orchestrator.run();
        process.exit(0);
    } catch (error) {
        logError('Fatal error:', error);
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    main();
}

module.exports = main;
