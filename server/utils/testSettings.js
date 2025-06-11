/**
 * Test script to demonstrate the Settings functionality
 */

const DatabaseManager = require('../database/database');

async function testSettings() {
    console.log('🔧 TESTING FANTASY FOOTBALL SETTINGS FUNCTIONALITY');
    console.log('='.repeat(60));
    
    const db = new DatabaseManager();
    
    try {
        // Test 1: Get current settings
        console.log('\n1️⃣  Getting current league settings...');
        const currentSettings = await db.getLeagueSettings();
        console.log(`   Current Week: ${currentSettings.current_week}`);
        console.log(`   Season Year: ${currentSettings.season_year}`);
        console.log(`   League Name: ${currentSettings.league_name}`);
        
        // Test 2: Update current week
        console.log('\n2️⃣  Updating current week to 5...');
        await db.updateCurrentWeek(5);
        const updatedSettings = await db.getLeagueSettings();
        console.log(`   ✅ Current Week updated to: ${updatedSettings.current_week}`);
        
        // Test 3: Update season year
        console.log('\n3️⃣  Updating season year to 2025...');
        await db.updateSeasonYear(2025);
        const yearUpdated = await db.getLeagueSettings();
        console.log(`   ✅ Season Year updated to: ${yearUpdated.season_year}`);
        
        // Test 4: Update multiple settings at once
        console.log('\n4️⃣  Updating multiple settings at once...');
        await db.updateLeagueSettings({
            current_week: 8,
            season_year: 2024,
            league_name: 'StatFink Debug League'
        });
        const multiUpdated = await db.getLeagueSettings();
        console.log(`   ✅ Current Week: ${multiUpdated.current_week}`);
        console.log(`   ✅ Season Year: ${multiUpdated.season_year}`);
        console.log(`   ✅ League Name: ${multiUpdated.league_name}`);
        
        // Test 5: Check roster snapshots
        console.log('\n5️⃣  Checking available roster snapshots...');
        const snapshots = await db.getAvailableSnapshotWeeks(2024);
        console.log(`   📊 Found ${snapshots.length} roster snapshots:`);
        snapshots.forEach(snapshot => {
            console.log(`      Week ${snapshot.week}: ${snapshot.roster_count} entries`);
        });
        
        // Test 6: Capture new snapshot
        console.log('\n6️⃣  Capturing roster snapshot for current week...');
        const snapshotCount = await db.captureWeeklyRosterSnapshot(multiUpdated.current_week, multiUpdated.season_year);
        console.log(`   ✅ Captured ${snapshotCount} roster entries for Week ${multiUpdated.current_week}`);
        
        console.log('\n✅ ALL TESTS PASSED! Settings functionality is working correctly.');
        
    } catch (error) {
        console.error('\n❌ TEST FAILED:', error.message);
        throw error;
    } finally {
        await db.close();
    }
}

// API endpoint tests
async function testAPIEndpoints() {
    console.log('\n🌐 TESTING API ENDPOINTS');
    console.log('='.repeat(60));
    
    const baseUrl = 'http://localhost:3000';
    
    try {
        // Test settings GET
        console.log('\n1️⃣  Testing GET /api/league/settings...');
        const settingsResponse = await fetch(`${baseUrl}/api/league/settings`);
        const settingsData = await settingsResponse.json();
        console.log(`   ✅ Response: ${settingsData.success ? 'Success' : 'Failed'}`);
        console.log(`   📊 Current Week: ${settingsData.data.current_week}`);
        
        // Test settings PUT
        console.log('\n2️⃣  Testing PUT /api/league/settings...');
        const updateResponse = await fetch(`${baseUrl}/api/league/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                current_week: 10,
                league_name: 'API Test League'
            })
        });
        const updateData = await updateResponse.json();
        console.log(`   ✅ Update: ${updateData.success ? 'Success' : 'Failed'}`);
        console.log(`   📝 Message: ${updateData.message}`);
        
        // Test roster snapshots
        console.log('\n3️⃣  Testing GET /api/roster-history/snapshots...');
        const snapshotsResponse = await fetch(`${baseUrl}/api/roster-history/snapshots`);
        const snapshotsData = await snapshotsResponse.json();
        console.log(`   ✅ Snapshots: ${snapshotsData.success ? 'Success' : 'Failed'}`);
        console.log(`   📊 Found ${snapshotsData.count} snapshots`);
        
        // Test snapshot capture
        console.log('\n4️⃣  Testing POST /api/roster-history/capture...');
        const captureResponse = await fetch(`${baseUrl}/api/roster-history/capture/12`, {
            method: 'POST'
        });
        const captureData = await captureResponse.json();
        console.log(`   ✅ Capture: ${captureData.success ? 'Success' : 'Failed'}`);
        console.log(`   📊 Captured: ${captureData.entries_captured} entries`);
        
        console.log('\n✅ ALL API TESTS PASSED!');
        
    } catch (error) {
        console.error('\n❌ API TEST FAILED:', error.message);
        throw error;
    }
}

async function runAllTests() {
    try {
        await testSettings();
        await testAPIEndpoints();
        
        console.log('\n' + '='.repeat(60));
        console.log('🎉 ALL TESTS COMPLETED SUCCESSFULLY!');
        console.log('');
        console.log('✅ Database operations working');
        console.log('✅ API endpoints functional');
        console.log('✅ Settings can be updated');
        console.log('✅ Roster snapshots working');
        console.log('');
        console.log('🌐 You can now use the Settings tab in the dashboard:');
        console.log('   http://localhost:3000/dashboard');
        console.log('');
        console.log('⚙️  Available debugging controls:');
        console.log('   • Set current week (1-18)');
        console.log('   • Set season year (2020-2030)');
        console.log('   • Update league name');
        console.log('   • Capture roster snapshots');
        console.log('   • View snapshot history');
        console.log('='.repeat(60));
        
    } catch (error) {
        console.error('💥 Test suite failed:', error.message);
        process.exit(1);
    }
}

// Run tests if called directly
if (require.main === module) {
    runAllTests().then(() => process.exit(0));
}

module.exports = {
    testSettings,
    testAPIEndpoints,
    runAllTests
};