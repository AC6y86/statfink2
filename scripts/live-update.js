#!/usr/bin/env node
const axios = require('axios');

async function runLiveUpdate() {
    try {
        console.log(`[${new Date().toISOString()}] Starting live game update...`);
        
        const response = await axios.post('http://localhost:8000/api/admin/scheduler/live', {}, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 60000 // 1 minute timeout
        });
        
        console.log(`[${new Date().toISOString()}] Live update completed:`, response.data);
        process.exit(0);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Live update failed:`, error.message);
        process.exit(1);
    }
}

runLiveUpdate();