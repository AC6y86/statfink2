const DatabaseManager = require('../database/database');

/**
 * Generate the complete fantasy football schedule based on the division structure
 * Division 1: Teams 1, 3, 5, 7
 * Division 2: Teams 2, 4, 6, 8
 * Additional teams: 9, 10, 11, 12
 */
async function generateSchedule() {
    console.log('Generating complete fantasy football schedule...');
    
    const db = new DatabaseManager();
    
    // Clear existing matchups
    await db.run('DELETE FROM matchups');
    console.log('Cleared existing matchups');
    
    // Regular season schedule (weeks 1-14)
    const regularSeasonMatchups = [
        // WEEK 1
        { week: 1, team1: 1, team2: 8 },
        { week: 1, team1: 3, team2: 6 },
        { week: 1, team1: 2, team2: 7 },
        { week: 1, team1: 4, team2: 5 },
        
        // WEEK 2
        { week: 2, team1: 1, team2: 4 },
        { week: 2, team1: 5, team2: 8 },
        { week: 2, team1: 2, team2: 3 },
        { week: 2, team1: 6, team2: 7 },
        
        // WEEK 3
        { week: 3, team1: 1, team2: 7 },
        { week: 3, team1: 3, team2: 5 },
        { week: 3, team1: 2, team2: 8 },
        { week: 3, team1: 4, team2: 6 },
        
        // WEEK 4
        { week: 4, team1: 1, team2: 3 },
        { week: 4, team1: 5, team2: 7 },
        { week: 4, team1: 2, team2: 4 },
        { week: 4, team1: 6, team2: 8 },
        
        // WEEK 5
        { week: 5, team1: 1, team2: 6 },
        { week: 5, team1: 3, team2: 8 },
        { week: 5, team1: 2, team2: 5 },
        { week: 5, team1: 4, team2: 7 },
        
        // WEEK 6
        { week: 6, team1: 1, team2: 2 },
        { week: 6, team1: 5, team2: 6 },
        { week: 6, team1: 3, team2: 4 },
        { week: 6, team1: 7, team2: 8 },
        
        // WEEK 7
        { week: 7, team1: 1, team2: 5 },
        { week: 7, team1: 3, team2: 7 },
        { week: 7, team1: 2, team2: 6 },
        { week: 7, team1: 4, team2: 8 },
        
        // WEEK 8
        { week: 8, team1: 1, team2: 8 },
        { week: 8, team1: 3, team2: 6 },
        { week: 8, team1: 2, team2: 7 },
        { week: 8, team1: 4, team2: 5 },
        
        // WEEK 9
        { week: 9, team1: 1, team2: 4 },
        { week: 9, team1: 5, team2: 8 },
        { week: 9, team1: 2, team2: 3 },
        { week: 9, team1: 6, team2: 7 },
        
        // WEEK 10
        { week: 10, team1: 1, team2: 7 },
        { week: 10, team1: 3, team2: 5 },
        { week: 10, team1: 2, team2: 8 },
        { week: 10, team1: 4, team2: 6 },
        
        // WEEK 11
        { week: 11, team1: 1, team2: 3 },
        { week: 11, team1: 5, team2: 7 },
        { week: 11, team1: 2, team2: 4 },
        { week: 11, team1: 6, team2: 8 },
        
        // WEEK 12
        { week: 12, team1: 1, team2: 6 },
        { week: 12, team1: 3, team2: 8 },
        { week: 12, team1: 2, team2: 5 },
        { week: 12, team1: 4, team2: 7 },
        
        // WEEK 13
        { week: 13, team1: 1, team2: 2 },
        { week: 13, team1: 5, team2: 6 },
        { week: 13, team1: 3, team2: 4 },
        { week: 13, team1: 7, team2: 8 },
        
        // WEEK 14
        { week: 14, team1: 1, team2: 5 },
        { week: 14, team1: 3, team2: 7 },
        { week: 14, team1: 2, team2: 6 },
        { week: 14, team1: 4, team2: 8 }
    ];
    
    // Insert regular season matchups
    const season = 2024;
    let insertedCount = 0;
    
    for (const matchup of regularSeasonMatchups) {
        try {
            await db.run(
                'INSERT INTO matchups (week, season, team1_id, team2_id, team1_points, team2_points, is_complete) VALUES (?, ?, ?, ?, 0, 0, 0)',
                [matchup.week, season, matchup.team1, matchup.team2]
            );
            insertedCount++;
        } catch (error) {
            console.error(`Error inserting matchup week ${matchup.week}, ${matchup.team1} vs ${matchup.team2}:`, error.message);
        }
    }
    
    // Close database connection
    await db.close();
    
    console.log(`Inserted ${insertedCount} regular season matchups for weeks 1-14`);
    
    // Note: Playoff matchups (weeks 15-16) will be determined based on regular season standings
    // These would be generated later based on final standings
    
    console.log('Schedule generation complete!');
    return insertedCount;
}

/**
 * Generate playoff matchups based on standings (weeks 15-16)
 * Week 15: Division winners play division runner-ups
 * Week 16: Winners and losers from week 15
 */
async function generatePlayoffMatchups() {
    console.log('Generating playoff matchups...');
    
    // This would typically be called after the regular season
    // For now, we'll create placeholder playoff structure
    console.log('Playoff matchups will be generated based on final standings');
    console.log('Week 15: Div 1 first vs Div 2 second, Div 2 first vs Div 1 second');
    console.log('Week 16: Winners play for 1st/2nd, Losers play for 3rd place');
}

// Export functions
module.exports = {
    generateSchedule,
    generatePlayoffMatchups
};

// Run directly if called as script
if (require.main === module) {
    generateSchedule()
        .then(() => {
            console.log('Schedule generation completed successfully');
            process.exit(0);
        })
        .catch(error => {
            console.error('Error generating schedule:', error);
            process.exit(1);
        });
}