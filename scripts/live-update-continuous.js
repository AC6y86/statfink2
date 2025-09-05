#!/usr/bin/env node
const axios = require('axios');

// This script runs continuously every minute to update live game scores
// It replaces the multiple time-windowed cron jobs with a single always-on process
// The API will only update games that are actually in progress or recently scheduled

async function runLiveUpdate() {
    const timestamp = new Date().toISOString();
    
    try {
        console.log(`[${timestamp}] Starting continuous live game update...`);
        
        const response = await axios.post('http://localhost:8000/api/internal/scheduler/live', {}, {
            headers: { 
                'Content-Type': 'application/json',
                'X-Internal-Token': 'statfink-internal-cron'
            },
            timeout: 50000 // 50 second timeout (must be less than 1 minute interval)
        });
        
        const result = response.data;
        if (result.results && result.results.gamesInProgress > 0) {
            console.log(`[${timestamp}] Live update completed: ${result.results.gamesInProgress} games in progress`);
        } else {
            // Less verbose logging when no games are active
            console.log(`[${timestamp}] No active games`);
        }
        
    } catch (error) {
        console.error(`[${timestamp}] Live update failed:`, error.message);
        if (error.response) {
            console.error(`Response status: ${error.response.status}`);
            console.error(`Response data:`, error.response.data);
        }
    }
}

// Run immediately on startup
runLiveUpdate();

// Then run every minute
setInterval(runLiveUpdate, 60000);

// Keep the process running
process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully');
    process.exit(0);
});