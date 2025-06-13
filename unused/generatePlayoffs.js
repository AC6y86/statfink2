const DatabaseManager = require('../database/database');

/**
 * Generate playoff matchups for weeks 15-16
 * This will be called after regular season to determine playoff seeding
 */
async function generatePlayoffMatchups() {
    console.log('Generating playoff matchups for weeks 15-16...');
    
    const db = new DatabaseManager();
    const season = 2024;
    
    try {
        // Get all teams with their standings (wins, losses, total points)
        const teams = await db.all(`
            SELECT team_id, team_name, owner_name, wins, losses, total_points
            FROM teams 
            ORDER BY wins DESC, losses ASC, total_points DESC
        `);
        
        console.log('Current team standings:');
        teams.forEach((team, index) => {
            console.log(`${index + 1}. ${team.team_name} (${team.owner_name}) - ${team.wins}-${team.losses}, ${team.total_points} pts`);
        });
        
        // For now, let's create a sample playoff structure
        // In a real scenario, this would be based on actual season standings
        
        // Week 15 - Division leaders vs runner-ups (cross-division)
        // Assuming teams 1,3,5,7 are division 1 and teams 2,4,6,8 are division 2
        // Teams 9-12 could be wildcards or have their own bracket
        
        const week15Matchups = [
            // Division winners vs cross-division runner-ups
            { week: 15, team1: 1, team2: 4, description: "Div 1 1st vs Div 2 2nd" },
            { week: 15, team1: 2, team2: 3, description: "Div 2 1st vs Div 1 2nd" },
            // Additional playoff games for teams 5-12
            { week: 15, team1: 5, team2: 8, description: "Wildcard matchup" },
            { week: 15, team1: 6, team2: 7, description: "Wildcard matchup" },
            { week: 15, team1: 9, team2: 12, description: "Consolation semifinal" },
            { week: 15, team1: 10, team2: 11, description: "Consolation semifinal" }
        ];
        
        // Week 16 - Championship and consolation games
        const week16Matchups = [
            // These would be determined by week 15 results
            // For now, creating placeholder matchups
            { week: 16, team1: 1, team2: 2, description: "Championship game (winners of week 15)" },
            { week: 16, team1: 3, team2: 4, description: "3rd place game (losers of week 15)" },
            { week: 16, team1: 5, team2: 6, description: "5th place game" },
            { week: 16, team1: 7, team2: 8, description: "7th place game" },
            { week: 16, team1: 9, team2: 10, description: "9th place game" },
            { week: 16, team1: 11, team2: 12, description: "11th place game" }
        ];
        
        // Clear any existing playoff matchups
        await db.run('DELETE FROM matchups WHERE week >= 15');
        console.log('Cleared existing playoff matchups');
        
        // Insert Week 15 matchups
        let insertedCount = 0;
        for (const matchup of week15Matchups) {
            try {
                await db.run(
                    'INSERT INTO matchups (week, season, team1_id, team2_id, team1_points, team2_points, is_complete) VALUES (?, ?, ?, ?, 0, 0, 0)',
                    [matchup.week, season, matchup.team1, matchup.team2]
                );
                console.log(`Week ${matchup.week}: ${matchup.description} (${matchup.team1} vs ${matchup.team2})`);
                insertedCount++;
            } catch (error) {
                console.error(`Error inserting playoff matchup: ${error.message}`);
            }
        }
        
        // Insert Week 16 matchups
        for (const matchup of week16Matchups) {
            try {
                await db.run(
                    'INSERT INTO matchups (week, season, team1_id, team2_id, team1_points, team2_points, is_complete) VALUES (?, ?, ?, ?, 0, 0, 0)',
                    [matchup.week, season, matchup.team1, matchup.team2]
                );
                console.log(`Week ${matchup.week}: ${matchup.description} (${matchup.team1} vs ${matchup.team2})`);
                insertedCount++;
            } catch (error) {
                console.error(`Error inserting playoff matchup: ${error.message}`);
            }
        }
        
        console.log(`\nInserted ${insertedCount} playoff matchups for weeks 15-16`);
        console.log('\nNote: Week 16 matchups are placeholders and should be updated based on Week 15 results');
        
    } catch (error) {
        console.error('Error generating playoff matchups:', error);
        throw error;
    } finally {
        await db.close();
    }
}

/**
 * Update Week 16 matchups based on Week 15 results
 * This should be called after Week 15 is completed
 */
async function updateWeek16BasedOnWeek15Results() {
    console.log('Updating Week 16 matchups based on Week 15 results...');
    
    const db = new DatabaseManager();
    const season = 2024;
    
    try {
        // Get Week 15 results
        const week15Results = await db.all(`
            SELECT m.*, 
                   t1.team_name as team1_name, t2.team_name as team2_name,
                   CASE 
                       WHEN m.team1_points > m.team2_points THEN m.team1_id
                       WHEN m.team2_points > m.team1_points THEN m.team2_id
                       ELSE NULL
                   END as winner_id,
                   CASE 
                       WHEN m.team1_points < m.team2_points THEN m.team1_id
                       WHEN m.team2_points < m.team1_points THEN m.team2_id
                       ELSE NULL
                   END as loser_id
            FROM matchups m
            JOIN teams t1 ON m.team1_id = t1.team_id
            JOIN teams t2 ON m.team2_id = t2.team_id
            WHERE m.week = 15 AND m.season = ? AND m.is_complete = 1
            ORDER BY m.matchup_id
        `, [season]);
        
        if (week15Results.length < 2) {
            console.log('Week 15 results not complete yet. Cannot update Week 16 matchups.');
            return;
        }
        
        // Update championship game (winners of first two Week 15 games)
        const championshipTeam1 = week15Results[0].winner_id;
        const championshipTeam2 = week15Results[1].winner_id;
        
        if (championshipTeam1 && championshipTeam2) {
            await db.run(`
                UPDATE matchups 
                SET team1_id = ?, team2_id = ?
                WHERE week = 16 AND season = ? 
                ORDER BY matchup_id LIMIT 1
            `, [championshipTeam1, championshipTeam2, season]);
            
            console.log(`Updated championship game: Team ${championshipTeam1} vs Team ${championshipTeam2}`);
        }
        
        // Update 3rd place game (losers of first two Week 15 games)
        const thirdPlaceTeam1 = week15Results[0].loser_id;
        const thirdPlaceTeam2 = week15Results[1].loser_id;
        
        if (thirdPlaceTeam1 && thirdPlaceTeam2) {
            await db.run(`
                UPDATE matchups 
                SET team1_id = ?, team2_id = ?
                WHERE week = 16 AND season = ? 
                ORDER BY matchup_id LIMIT 1 OFFSET 1
            `, [thirdPlaceTeam1, thirdPlaceTeam2, season]);
            
            console.log(`Updated 3rd place game: Team ${thirdPlaceTeam1} vs Team ${thirdPlaceTeam2}`);
        }
        
    } catch (error) {
        console.error('Error updating Week 16 matchups:', error);
        throw error;
    } finally {
        await db.close();
    }
}

module.exports = {
    generatePlayoffMatchups,
    updateWeek16BasedOnWeek15Results
};

// Run directly if called as script
if (require.main === module) {
    generatePlayoffMatchups()
        .then(() => {
            console.log('Playoff generation completed successfully');
            process.exit(0);
        })
        .catch(error => {
            console.error('Error generating playoffs:', error);
            process.exit(1);
        });
}