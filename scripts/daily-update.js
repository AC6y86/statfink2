#!/usr/bin/env node
const axios = require('axios');

async function runDailyUpdate() {
    try {
        console.log(`[${new Date().toISOString()}] Starting daily update...`);
        
        const response = await axios.post('http://localhost:8000/api/admin/scheduler/daily', {}, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 300000 // 5 minute timeout
        });
        
        console.log(`[${new Date().toISOString()}] Daily update completed:`, response.data);
        process.exit(0);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Daily update failed:`, error.message);
        process.exit(1);
    }
}

runDailyUpdate();