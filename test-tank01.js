#!/usr/bin/env node

const axios = require('axios');

// Test configuration
const BASE_URL = 'http://localhost:3000';
const TANK01_API_KEY = process.env.TANK01_API_KEY;

console.log('🏈 Tank01 API Integration Test');
console.log('================================\n');

async function testHealthEndpoint() {
    console.log('1. Testing Health Endpoint...');
    try {
        const response = await axios.get(`${BASE_URL}/health`);
        const health = response.data;
        
        console.log(`   ✅ Server Status: ${health.status}`);
        console.log(`   📊 Database: ${health.services.database}`);
        console.log(`   🔌 Tank01: ${health.services.tank01}`);
        
        if (health.tank01_stats) {
            console.log(`   📈 API Requests: ${health.tank01_stats.requests}`);
            console.log(`   💾 Cache Size: ${health.tank01_stats.cache_size}`);
        }
        
        return health.services.tank01 !== 'not configured';
    } catch (error) {
        console.log(`   ❌ Health check failed: ${error.message}`);
        return false;
    }
}

async function testSyncStatus() {
    console.log('\n2. Testing Sync Status...');
    try {
        const response = await axios.get(`${BASE_URL}/api/admin/sync/status`);
        
        const data = response.data.data;
        console.log(`   📅 Last Sync: ${data.sync.last_sync || 'Never'}`);
        console.log(`   🔄 Sync In Progress: ${data.sync.sync_in_progress}`);
        console.log(`   🔌 Tank01 Available: ${data.sync.tank01_available}`);
        
        if (data.tank01) {
            console.log(`   ❤️  Tank01 Health: ${data.tank01.status}`);
            if (data.tank01.responseTime) {
                console.log(`   ⚡ Response Time: ${data.tank01.responseTime}`);
            }
        }
        
        return data.sync.tank01_available;
    } catch (error) {
        console.log(`   ❌ Sync status failed: ${error.message}`);
        return false;
    }
}

async function testPlayerSync() {
    console.log('\n3. Testing Player Sync...');
    if (!TANK01_API_KEY) {
        console.log('   ⚠️  No Tank01 API key - sync will fail');
        console.log('   💡 Set TANK01_API_KEY environment variable');
        return false;
    }
    
    try {
        console.log('   🔄 Starting player sync...');
        const response = await axios.post(`${BASE_URL}/api/admin/sync/players`, {}, {
            timeout: 60000 // 60 second timeout
        });
        
        const result = response.data.data;
        console.log(`   ✅ Sync completed!`);
        console.log(`   👥 Players synced: ${result.players_synced}`);
        console.log(`   ⏱️  Duration: ${result.duration}ms`);
        
        return true;
    } catch (error) {
        if (error.response?.data?.error) {
            console.log(`   ❌ Sync failed: ${error.response.data.error}`);
        } else {
            console.log(`   ❌ Sync failed: ${error.message}`);
        }
        return false;
    }
}

async function checkPlayerCount() {
    console.log('\n4. Checking Player Database...');
    try {
        const response = await axios.get(`${BASE_URL}/api/players`);
        const players = response.data.data;
        
        console.log(`   👥 Total Players: ${players.length}`);
        
        // Count by position
        const positions = {};
        players.forEach(player => {
            positions[player.position] = (positions[player.position] || 0) + 1;
        });
        
        console.log('   📊 By Position:');
        Object.entries(positions).forEach(([pos, count]) => {
            console.log(`      ${pos}: ${count}`);
        });
        
        return players.length > 0;
    } catch (error) {
        console.log(`   ❌ Failed to get players: ${error.message}`);
        return false;
    }
}

async function runTests() {
    console.log('🚀 Starting tests...\n');
    
    const healthOk = await testHealthEndpoint();
    const syncOk = await testSyncStatus();
    
    // Only try player sync if we have an API key
    let playerSyncOk = false;
    if (TANK01_API_KEY) {
        playerSyncOk = await testPlayerSync();
    }
    
    const playersOk = await checkPlayerCount();
    
    console.log('\n📋 Summary:');
    console.log(`   Server Health: ${healthOk ? '✅' : '❌'}`);
    console.log(`   Sync Service: ${syncOk ? '✅' : '❌'}`);
    console.log(`   API Key: ${TANK01_API_KEY ? '✅' : '❌'}`);
    console.log(`   Player Sync: ${playerSyncOk ? '✅' : TANK01_API_KEY ? '❌' : '⏸️'}`);
    console.log(`   Player Data: ${playersOk ? '✅' : '❌'}`);
    
    console.log('\n💡 Setup Instructions:');
    console.log('   1. Copy .env.example to .env');
    console.log('   2. Get Tank01 API key from: https://rapidapi.com/tank01/api/tank01-nfl-live-in-game-real-time-statistics-nfl');
    console.log('   3. Set TANK01_API_KEY in .env file');
    console.log('   4. Restart server: npm start');
    console.log('   5. Run this test: node test-tank01.js');
}

// Run tests if server is available
axios.get(`${BASE_URL}/health`, { timeout: 5000 })
    .then(() => runTests())
    .catch(() => {
        console.log('❌ Server not running on http://localhost:3000');
        console.log('💡 Start server first: npm start');
    });