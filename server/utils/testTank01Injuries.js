const Tank01Service = require('../services/tank01Service');
require('dotenv').config();

async function testInjuryData() {
    const tank01 = new Tank01Service(process.env.TANK01_API_KEY);
    
    try {
        console.log('Testing Tank01 API for injury data...\n');
        
        // Test 1: Check player list for injury fields
        console.log('1. Checking player list for injury fields...');
        const players = await tank01.getPlayerList();
        if (players && players.length > 0) {
            console.log('Sample player data:');
            console.log(JSON.stringify(players[0], null, 2));
            
            // Check if any players have injury-related fields
            const injuryFields = ['injury', 'injuryStatus', 'status', 'injuryDesignation', 'injuryBodyPart'];
            const foundFields = [];
            
            for (const field of injuryFields) {
                if (players.some(p => p[field])) {
                    foundFields.push(field);
                }
            }
            
            if (foundFields.length > 0) {
                console.log(`\nFound injury fields: ${foundFields.join(', ')}`);
                
                // Find an injured player
                const injuredPlayer = players.find(p => {
                    for (const field of foundFields) {
                        if (p[field] && p[field] !== 'Active' && p[field] !== 'ACT') {
                            return true;
                        }
                    }
                    return false;
                });
                
                if (injuredPlayer) {
                    console.log('\nExample injured player:');
                    console.log(JSON.stringify(injuredPlayer, null, 2));
                }
            } else {
                console.log('\nNo injury fields found in player list');
            }
        }
        
        // Test 2: Check team roster for injury data
        console.log('\n2. Checking team roster for injury fields...');
        const roster = await tank01.getTeamRoster('KC'); // Kansas City Chiefs
        if (roster && roster.length > 0) {
            console.log('\nSample roster player:');
            console.log(JSON.stringify(roster[0], null, 2));
        }
        
        // Test 3: Check player info endpoint
        console.log('\n3. Checking player info endpoint...');
        if (players && players.length > 0) {
            const playerId = players[0].playerID || players[0].id;
            if (playerId) {
                const playerInfo = await tank01.getPlayerInfo(playerId);
                console.log('\nPlayer info sample:');
                console.log(JSON.stringify(playerInfo, null, 2));
            }
        }
        
    } catch (error) {
        console.error('Error testing Tank01 API:', error.message);
    }
}

// Run the test
testInjuryData();