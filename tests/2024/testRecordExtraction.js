#!/usr/bin/env node

const PFL2024Extractor = require('./extractPFL2024.js');

async function main() {
    const extractor = new PFL2024Extractor();
    
    try {
        await extractor.initialize();
        
        // Extract Week 1 data to get teams
        const weekData = extractor.extractWeekData(1);
        
        console.log('=== RECORD EXTRACTION TEST ===\n');
        
        console.log('Team stats after extraction:');
        for (const [teamName, stats] of Object.entries(weekData.teamStats)) {
            console.log(`${teamName}: W=${stats.wins} L=${stats.losses} (${stats.record}) - Weekly: ${stats.weeklyPoints}, Cumulative: ${stats.cumulativePoints}`);
        }
        
    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await extractor.close();
    }
}

main().catch(console.error);