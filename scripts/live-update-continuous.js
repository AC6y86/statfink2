#!/usr/bin/env node
const axios = require('axios');

// This script runs continuously every 60 seconds to update live game scores
// It replaces the multiple time-windowed cron jobs with a single always-on process
// The API will only update games that are actually in progress or recently scheduled

// Alert after this many consecutive failures (15 minutes of dead updates)
const FAILURE_ALERT_THRESHOLD = 15;
let consecutiveFailures = 0;
let alertSent = false;

async function recordHealthAlert(severity, message) {
    try {
        await axios.post('http://localhost:8000/api/internal/health/alert', {
            severity,
            source: 'live-update-continuous',
            message
        }, {
            headers: {
                'Content-Type': 'application/json',
                'X-Internal-Token': 'statfink-internal-cron'
            },
            timeout: 10000
        });
    } catch (error) {
        // If the server is down the alert call fails too; nothing else to do
        console.error(`[${new Date().toISOString()}] Failed to record health alert:`, error.message);
    }
}

async function runLiveUpdate() {
    const timestamp = new Date().toISOString();

    try {
        console.log(`[${timestamp}] Starting continuous live game update...`);

        const response = await axios.post('http://localhost:8000/api/internal/scheduler/live', {}, {
            headers: {
                'Content-Type': 'application/json',
                'X-Internal-Token': 'statfink-internal-cron'
            },
            timeout: 55000 // 55 second timeout (must be less than 60 second interval)
        });

        const result = response.data;
        if (result.results && result.results.gamesInProgress > 0) {
            console.log(`[${timestamp}] Live update completed: ${result.results.gamesInProgress} games in progress`);
        } else {
            // Less verbose logging when no games are active
            console.log(`[${timestamp}] No active games`);
        }

        if (alertSent) {
            await recordHealthAlert('info', `Live updates recovered after ${consecutiveFailures} consecutive failures`);
        }
        consecutiveFailures = 0;
        alertSent = false;

    } catch (error) {
        console.error(`[${timestamp}] Live update failed:`, error.message);
        if (error.response) {
            console.error(`Response status: ${error.response.status}`);
            console.error(`Response data:`, error.response.data);
        }

        consecutiveFailures++;
        if (consecutiveFailures >= FAILURE_ALERT_THRESHOLD && !alertSent) {
            alertSent = true;
            await recordHealthAlert('critical',
                `Live updates have failed ${consecutiveFailures} times in a row (last error: ${error.message})`);
        }
    }
}

// Run immediately on startup
runLiveUpdate();

// Then run every 60 seconds
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