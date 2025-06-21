#!/usr/bin/env node

const PFL2024Extractor = require('../extractPFL2024.js');

async function testWeek16() {
    const extractor = new PFL2024Extractor();
    
    try {
        await extractor.initialize();
        
        // Test extracting Week 16 data only
        console.log('\n=== TESTING WEEK 16 EXTRACTION ===');
        const weekData = extractor.extractWeekData(16);
        
        // Show Mitch's roster with points
        console.log('\n📋 Mitch Week 16 Roster with Points:');
        const mitchRoster = weekData.rosters['Mitch'];
        let totalPoints = 0;
        let starterPoints = 0;
        
        mitchRoster.forEach(player => {
            const points = player.fantasyPoints || 0;
            const starterMark = player.isStarter ? '*' : ' ';
            console.log(`${starterMark}${player.playerText} - ${points} pts`);
            totalPoints += points;
            if (player.isStarter) {
                starterPoints += points;
            }
        });
        
        console.log(`\nTotal Points: ${totalPoints}`);
        console.log(`Starter Points: ${starterPoints}`);
        
        // Test insertion
        console.log('\n=== TESTING DATABASE INSERTION ===');
        await extractor.insertWeekData(weekData);
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
        console.error(error.stack);
    } finally {
        await extractor.close();
    }
}

testWeek16().catch(console.error);