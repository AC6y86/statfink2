// Simple database functionality test

require('dotenv').config();
const DatabaseManager = require('../database/database');
const { Validator } = require('./validation');
const ScoringService = require('../services/scoringService');

async function testDatabase() {
    console.log('🧪 Testing Database Functionality...\n');
    
    const db = new DatabaseManager();
    let testsPassed = 0;
    let testsTotal = 0;
    
    // Helper function for test assertions
    function test(description, testFn) {
        testsTotal++;
        try {
            const result = testFn();
            if (result === true || (result && result.then)) {
                console.log(`✅ ${description}`);
                testsPassed++;
                return result;
            } else {
                console.log(`❌ ${description}: Expected true, got ${result}`);
            }
        } catch (error) {
            console.log(`❌ ${description}: ${error.message}`);
        }
    }
    
    async function asyncTest(description, testFn) {
        testsTotal++;
        try {
            const result = await testFn();
            if (result === true) {
                console.log(`✅ ${description}`);
                testsPassed++;
            } else {
                console.log(`❌ ${description}: Expected true, got ${result}`);
            }
        } catch (error) {
            console.log(`❌ ${description}: ${error.message}`);
        }
    }
    
    // Wait for database to initialize
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    try {
        console.log('📋 Basic Database Operations:');
        
        // Test league settings
        await asyncTest('Get league settings', async () => {
            const settings = await db.getLeagueSettings();
            return settings && typeof settings.league_name === 'string';
        });
        
        // Test teams
        await asyncTest('Get all teams', async () => {
            const teams = await db.getAllTeams();
            return Array.isArray(teams);
        });
        
        // Test scoring rules
        await asyncTest('Get scoring rules', async () => {
            const rules = await db.getScoringRules();
            return Array.isArray(rules) && rules.length > 0;
        });
        
        console.log('\n🔒 Validation Tests:');
        
        // Test validation
        test('Validate valid player', () => {
            return Validator.validatePlayer({
                player_id: 'test123',
                name: 'Test Player',
                position: 'QB',
                team: 'TEST',
                bye_week: 8
            });
        });
        
        test('Validate valid stats', () => {
            return Validator.validatePlayerStats({
                player_id: 'test123',
                week: 1,
                season: 2024,
                passing_yards: 300,
                passing_tds: 2
            });
        });
        
        test('Validate invalid week (should fail)', () => {
            try {
                Validator.validateWeekSeason(25, 2024);
                return false; // Should not reach here
            } catch (error) {
                return true; // Expected to fail
            }
        });
        
        console.log('\n📊 Scoring Service Tests:');
        
        // Test scoring service
        const scoringService = new ScoringService(db);
        
        test('Calculate fantasy points', () => {
            const points = scoringService.calculateFantasyPoints({
                player_id: 'test123',
                week: 1,
                season: 2024,
                passing_yards: 300,
                passing_tds: 2,
                rushing_yards: 50,
                receptions: 5
            });
            return points > 0;
        });
        
        // Test player operations if we have test data
        console.log('\n👥 Player Operations:');
        
        await asyncTest('Get available players by position', async () => {
            const qbs = await db.getAvailablePlayersByPosition('QB');
            return Array.isArray(qbs);
        });
        
        await asyncTest('Check if test player is available', async () => {
            const available = await db.isPlayerAvailable('nonexistent_player_123');
            return available === true; // Should be available since it doesn't exist
        });
        
        console.log('\n📈 Stats Operations:');
        
        await asyncTest('Get player stats by week (empty result OK)', async () => {
            const stats = await db.getPlayerStatsByWeek(1, 2024);
            return Array.isArray(stats);
        });
        
        // Test matchup operations
        console.log('\n🏆 Matchup Operations:');
        
        await asyncTest('Get week matchups (empty result OK)', async () => {
            const matchups = await db.getWeekMatchups(1, 2024);
            return Array.isArray(matchups);
        });
        
        console.log('\n📦 Backup Test:');
        
        const BackupManager = require('./backup');
        const backupManager = new BackupManager(db);
        
        await asyncTest('Export data as JSON', async () => {
            const data = await backupManager.exportDataAsJSON();
            return !!(data && data.timestamp && data.league_settings);
        });
        
        console.log(`\n🎯 Test Results: ${testsPassed}/${testsTotal} tests passed`);
        
        if (testsPassed === testsTotal) {
            console.log('🎉 All tests passed! Database is ready for the Express server.');
        } else {
            console.log('⚠️  Some tests failed. Please review the database setup.');
        }
        
        // Test database operations that require existing data
        const teams = await db.getAllTeams();
        if (teams && teams.length > 0) {
            console.log(`\n📋 Found ${teams.length} teams in database:`);
            teams.slice(0, 3).forEach(team => {
                console.log(`  - ${team.team_name} (${team.owner_name})`);
            });
        } else {
            console.log('\n💡 No teams found. Run `npm run init-league` to set up initial data.');
        }
        
    } catch (error) {
        console.error('❌ Database test failed:', error);
    } finally {
        await db.close();
        console.log('\n✅ Database connection closed.');
    }
}

// Run test if called directly
if (require.main === module) {
    testDatabase().catch(console.error);
}

module.exports = testDatabase;