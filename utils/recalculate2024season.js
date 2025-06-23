#!/usr/bin/env node

/**
 * Recalculate 2024 Season Script
 * 
 * This script performs a complete recalculation of the 2024 fantasy football season,
 * including syncing games, player stats, calculating fantasy points, and updating team scores.
 * 
 * This is now a thin wrapper around the SeasonRecalculationOrchestrator service
 * which handles all the heavy lifting.
 * 
 * Usage: node utils/recalculate2024season.js
 */

// Load environment variables
require('dotenv').config();

const SeasonRecalculationOrchestrator = require('../server/services/seasonRecalculationOrchestrator');
const { logError } = require('../server/utils/errorHandler');

// Main execution
async function main() {
    const orchestrator = new SeasonRecalculationOrchestrator(2024, 17);
    
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