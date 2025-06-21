#!/usr/bin/env node

const PFL2024Extractor = require('./extractPFL2024.js');

async function main() {
    const extractor = new PFL2024Extractor();
    
    try {
        await extractor.initialize();
        
        // Extract Week 1 data
        const weekData = extractor.extractWeekData(1);
        
        console.log('=== EXTRACTED DATA ANALYSIS ===\n');
        
        // Check Mitch specifically
        const mitchRoster = weekData.rosters['Mitch'];
        console.log(`Mitch has ${mitchRoster.length} players:`);
        
        // Group by position
        const byPosition = {};
        mitchRoster.forEach(player => {
            if (!byPosition[player.position]) {
                byPosition[player.position] = [];
            }
            byPosition[player.position].push(player.playerText);
        });
        
        Object.keys(byPosition).forEach(pos => {
            console.log(`${pos}: ${byPosition[pos].length} players`);
            byPosition[pos].forEach(player => {
                console.log(`  - ${player}`);
            });
        });
        
        console.log('\n=== EXPECTED: 19 PLAYERS ===');
        console.log('QB: 3, RB: 6, WR: 5, TE: 1, K: 2, DEF: 2');
        
    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await extractor.close();
    }
}

main().catch(console.error);