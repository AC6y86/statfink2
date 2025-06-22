require('dotenv').config();
const Tank01Service = require('../server/services/tank01Service');
const DatabaseManager = require('../server/database/database');

async function checkWeek1TwoPointConversions() {
    const db = new DatabaseManager();
    
    const tank01 = new Tank01Service(process.env.TANK01_API_KEY, db);
    
    try {
        console.log('Fetching Week 1 2024 boxscore data from Tank01...');
        const boxScoreData = await tank01.getPlayerStats(1, 2024);
        
        // Look for D'Andre Swift in the data
        for (const gameId of Object.keys(boxScoreData)) {
            const game = boxScoreData[gameId];
            
            if (game.playerStats) {
                for (const playerKey of Object.keys(game.playerStats)) {
                    const player = game.playerStats[playerKey];
                    
                    // Check if this is D'Andre Swift
                    if (player.longName && player.longName.includes('Swift')) {
                        console.log('\n=== D\'Andre Swift Stats ===');
                        console.log('Player:', player.longName);
                        console.log('Team:', player.team);
                        console.log('Full data:', JSON.stringify(player, null, 2));
                        
                        // Look for any 2-point conversion related fields
                        const allKeys = getAllKeys(player);
                        const twoPointKeys = allKeys.filter(key => 
                            key.toLowerCase().includes('two') || 
                            key.toLowerCase().includes('2pt') || 
                            key.toLowerCase().includes('conversion')
                        );
                        
                        if (twoPointKeys.length > 0) {
                            console.log('\n2-Point Conversion Fields Found:', twoPointKeys);
                        }
                    }
                }
            }
        }
        
        // Also check a specific game if we know Swift played
        console.log('\n=== Checking all player stats for 2-point conversion fields ===');
        let samplePlayer = null;
        for (const gameId of Object.keys(boxScoreData)) {
            const game = boxScoreData[gameId];
            if (game.playerStats) {
                const playerKeys = Object.keys(game.playerStats);
                if (playerKeys.length > 0) {
                    samplePlayer = game.playerStats[playerKeys[0]];
                    break;
                }
            }
        }
        
        if (samplePlayer) {
            console.log('Sample player structure:', Object.keys(samplePlayer));
            if (samplePlayer.Rushing) {
                console.log('Rushing fields:', Object.keys(samplePlayer.Rushing));
            }
            if (samplePlayer.Passing) {
                console.log('Passing fields:', Object.keys(samplePlayer.Passing));
            }
            if (samplePlayer.Receiving) {
                console.log('Receiving fields:', Object.keys(samplePlayer.Receiving));
            }
        }
        
    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await db.close();
    }
}

function getAllKeys(obj, prefix = '') {
    let keys = [];
    for (const key in obj) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        keys.push(fullKey);
        if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
            keys = keys.concat(getAllKeys(obj[key], fullKey));
        }
    }
    return keys;
}

checkWeek1TwoPointConversions();