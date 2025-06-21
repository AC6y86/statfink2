#!/usr/bin/env node

const PFL2024Extractor = require('./extractPFL2024.js');

async function main() {
    const extractor = new PFL2024Extractor();
    
    try {
        await extractor.initialize();
        const weekData = extractor.extractWeekData(1);
        
        console.log('=== ROSTER SIZE CHECK ===');
        
        for (const [teamName, players] of Object.entries(weekData.rosters)) {
            console.log(`${teamName}: ${players.length} players`);
            
            if (players.length !== 19) {
                console.log(`  ❌ ${teamName} roster issues:`);
                players.forEach(p => {
                    console.log(`    - ${p.playerText} (${p.position})`);
                });
                console.log('');
            }
        }
        
    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await extractor.close();
    }
}

main().catch(console.error);