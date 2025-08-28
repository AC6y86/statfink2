#!/usr/bin/env node
const axios = require('axios');

async function checkAndRunWeeklyUpdate() {
    try {
        console.log(`[${new Date().toISOString()}] Checking if weekly update needed...`);
        
        // First check the scheduler status using internal endpoint
        const statusResponse = await axios.get('http://localhost:8000/api/internal/scheduler/status', {
            headers: {
                'X-Internal-Token': 'statfink-internal-cron'
            }
        });
        const status = statusResponse.data.data;
        
        // Check if we've already run the weekly update recently (within 24 hours)
        if (status.lastWeeklyUpdate) {
            const lastRun = new Date(status.lastWeeklyUpdate);
            const hoursSinceLastRun = (Date.now() - lastRun.getTime()) / (1000 * 60 * 60);
            
            if (hoursSinceLastRun < 24) {
                console.log(`[${new Date().toISOString()}] Weekly update already ran ${hoursSinceLastRun.toFixed(1)} hours ago`);
                process.exit(0);
            }
        }
        
        // Try to run the weekly update
        const response = await axios.post('http://localhost:8000/api/internal/scheduler/weekly', {}, {
            headers: { 
                'Content-Type': 'application/json',
                'X-Internal-Token': 'statfink-internal-cron'
            },
            timeout: 300000 // 5 minute timeout
        });
        
        if (response.data.success) {
            console.log(`[${new Date().toISOString()}] Weekly update completed:`, response.data);
        } else {
            console.log(`[${new Date().toISOString()}] Weekly update not ready:`, response.data.message);
        }
        
        process.exit(0);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Weekly update check failed:`, error.message);
        if (error.response) {
            console.error(`Response status: ${error.response.status}`);
            console.error(`Response data:`, error.response.data);
        }
        process.exit(1);
    }
}

checkAndRunWeeklyUpdate();