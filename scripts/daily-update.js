#!/usr/bin/env node
const axios = require('axios');

async function runDailyUpdate() {
    try {
        console.log(`[${new Date().toISOString()}] Starting daily update...`);
        
        const response = await axios.post('http://localhost:8000/api/internal/scheduler/daily', {}, {
            headers: { 
                'Content-Type': 'application/json',
                'X-Internal-Token': 'statfink-internal-cron'
            },
            timeout: 300000 // 5 minute timeout
        });
        
        console.log(`[${new Date().toISOString()}] Daily update completed:`, response.data);
        process.exit(0);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Daily update failed:`, error.message);
        if (error.response) {
            console.error(`Response status: ${error.response.status}`);
            console.error(`Response data:`, error.response.data);
        }
        process.exit(1);
    }
}

runDailyUpdate();