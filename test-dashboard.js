#!/usr/bin/env node

const axios = require('axios');

const BASE_URL = 'http://localhost:3000';

console.log('🏈 StatFink Database Dashboard Test');
console.log('===================================\n');

async function testDashboardEndpoints() {
    console.log('🚀 Testing dashboard API endpoints...\n');

    try {
        // Test main dashboard page
        console.log('1. Testing Dashboard Page...');
        const dashboardRes = await axios.get(`${BASE_URL}/dashboard`);
        console.log(`   ✅ Dashboard page loads (${dashboardRes.data.length} characters)`);

        // Test players API
        console.log('\n2. Testing Players API...');
        const playersRes = await axios.get(`${BASE_URL}/api/players`);
        const players = playersRes.data.data;
        console.log(`   ✅ Players loaded: ${players.length} total`);
        
        // Count by position
        const positions = {};
        players.forEach(player => {
            positions[player.position] = (positions[player.position] || 0) + 1;
        });
        
        console.log('   📊 By Position:');
        Object.entries(positions).forEach(([pos, count]) => {
            console.log(`      ${pos}: ${count}`);
        });

        // Test teams API
        console.log('\n3. Testing Teams API...');
        const teamsRes = await axios.get(`${BASE_URL}/api/teams`);
        const teams = teamsRes.data.data;
        console.log(`   ✅ Teams loaded: ${teams.length} total`);
        
        if (teams.length > 0) {
            console.log(`   📋 Sample team: ${teams[0].team_name} (${teams[0].owner_name})`);
        }

        // Test health endpoint
        console.log('\n4. Testing Health Endpoint...');
        const healthRes = await axios.get(`${BASE_URL}/health`);
        const health = healthRes.data;
        console.log(`   ✅ Server status: ${health.status}`);
        console.log(`   📊 Database: ${health.services?.database}`);
        console.log(`   🔌 Tank01: ${health.services?.tank01}`);
        
        if (health.tank01_stats) {
            console.log(`   📈 API requests: ${health.tank01_stats.requests}`);
            console.log(`   💾 Cache size: ${health.tank01_stats.cache_size}`);
        }

        // Test position filtering
        console.log('\n5. Testing Position Filtering...');
        const qbRes = await axios.get(`${BASE_URL}/api/players/position/QB`);
        const qbs = qbRes.data.data;
        console.log(`   ✅ QBs loaded: ${qbs.length}`);
        
        if (qbs.length > 0) {
            console.log(`   🏈 Sample QB: ${qbs[0].name} (${qbs[0].team})`);
        }

        // Test team roster (if teams exist)
        if (teams.length > 0) {
            console.log('\n6. Testing Team Roster...');
            try {
                const rosterRes = await axios.get(`${BASE_URL}/api/teams/${teams[0].team_id}/roster`);
                const roster = rosterRes.data.data;
                console.log(`   ✅ Roster loaded for ${teams[0].team_name}: ${roster.length} players`);
            } catch (error) {
                console.log(`   ⚠️  Roster empty for ${teams[0].team_name}`);
            }
        }

        console.log('\n📋 Dashboard Features Available:');
        console.log('   • 📊 Real-time player database browser');
        console.log('   • 🔍 Search and filter players by name, position, team');
        console.log('   • 📋 Team roster management');
        console.log('   • 📈 System health monitoring');
        console.log('   • ⚙️  Admin controls for data synchronization (no password required)');
        console.log('   • 📱 Responsive design for mobile/desktop');
        console.log('   • 🎨 Modern UI with color-coded positions');

        console.log('\n🌐 Access Dashboard:');
        console.log(`   Dashboard: ${BASE_URL}/dashboard`);
        console.log(`   Homepage: ${BASE_URL}/`);
        console.log(`   Health: ${BASE_URL}/health`);

        console.log('\n✅ All dashboard tests passed!');

    } catch (error) {
        console.log(`\n❌ Dashboard test failed: ${error.message}`);
        
        if (error.code === 'ECONNREFUSED') {
            console.log('\n💡 Start the server first:');
            console.log('   npm start');
            console.log('   # Then run: node test-dashboard.js');
        }
    }
}

// Check if server is running and test dashboard
axios.get(`${BASE_URL}/health`, { timeout: 5000 })
    .then(() => testDashboardEndpoints())
    .catch(() => {
        console.log('❌ Server not running on http://localhost:3000');
        console.log('\n💡 Start server first:');
        console.log('   npm start');
        console.log('   # Then open: http://localhost:3000/dashboard');
        console.log('   # Or run: node test-dashboard.js');
    });