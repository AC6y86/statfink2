const DatabaseManager = require('../database/database');

/**
 * Display the complete fantasy football schedule
 */
async function showSchedule() {
    console.log('='.repeat(60));
    console.log('STATFINK FANTASY FOOTBALL SCHEDULE - 2024 SEASON');
    console.log('='.repeat(60));
    console.log('Division 1: Teams 1, 3, 5, 7');
    console.log('Division 2: Teams 2, 4, 6, 8');
    console.log('Teams 9-12: Additional teams');
    console.log('='.repeat(60));
    
    const db = new DatabaseManager();
    
    try {
        // Get all teams
        const teams = await db.all('SELECT team_id, team_name, owner_name FROM teams ORDER BY team_id');
        
        console.log('\nTEAMS:');
        teams.forEach(team => {
            console.log(`Team ${team.team_id}: ${team.team_name} (${team.owner_name})`);
        });
        
        // Get all matchups
        const matchups = await db.all(`
            SELECT 
                m.week, m.team1_id, m.team2_id,
                t1.team_name as team1_name, t1.owner_name as team1_owner,
                t2.team_name as team2_name, t2.owner_name as team2_owner
            FROM matchups m
            JOIN teams t1 ON m.team1_id = t1.team_id
            JOIN teams t2 ON m.team2_id = t2.team_id
            ORDER BY m.week, m.matchup_id
        `);
        
        // Group matchups by week
        const matchupsByWeek = {};
        matchups.forEach(matchup => {
            if (!matchupsByWeek[matchup.week]) {
                matchupsByWeek[matchup.week] = [];
            }
            matchupsByWeek[matchup.week].push(matchup);
        });
        
        // Display regular season (weeks 1-14)
        console.log('\n' + '='.repeat(60));
        console.log('REGULAR SEASON (Weeks 1-14)');
        console.log('='.repeat(60));
        
        for (let week = 1; week <= 14; week++) {
            if (matchupsByWeek[week]) {
                console.log(`\nWEEK ${week}:`);
                matchupsByWeek[week].forEach(matchup => {
                    console.log(`  ${matchup.team1_id} vs ${matchup.team2_id}: ${matchup.team1_name} (${matchup.team1_owner}) vs ${matchup.team2_name} (${matchup.team2_owner})`);
                });
            }
        }
        
        // Display playoffs (weeks 15-16)
        console.log('\n' + '='.repeat(60));
        console.log('PLAYOFFS (Weeks 15-16)');
        console.log('='.repeat(60));
        
        if (matchupsByWeek[15]) {
            console.log('\nWEEK 15 - PLAYOFF SEMIFINALS:');
            matchupsByWeek[15].forEach((matchup, index) => {
                let description = '';
                if (index === 0) description = ' (Div 1 1st vs Div 2 2nd)';
                else if (index === 1) description = ' (Div 2 1st vs Div 1 2nd)';
                else if (index < 4) description = ' (Wildcard)';
                else description = ' (Consolation)';
                
                console.log(`  ${matchup.team1_id} vs ${matchup.team2_id}: ${matchup.team1_name} vs ${matchup.team2_name}${description}`);
            });
        }
        
        if (matchupsByWeek[16]) {
            console.log('\nWEEK 16 - CHAMPIONSHIP & PLACEMENT:');
            matchupsByWeek[16].forEach((matchup, index) => {
                let description = '';
                if (index === 0) description = ' (Championship Game)';
                else if (index === 1) description = ' (3rd Place Game)';
                else description = ` (${(index - 1) * 2 + 5}th Place Game)`;
                
                console.log(`  ${matchup.team1_id} vs ${matchup.team2_id}: ${matchup.team1_name} vs ${matchup.team2_name}${description}`);
            });
        }
        
        console.log('\n' + '='.repeat(60));
        console.log('SCHEDULE SUMMARY:');
        console.log(`Total Regular Season Matchups: ${matchups.filter(m => m.week <= 14).length}`);
        console.log(`Total Playoff Matchups: ${matchups.filter(m => m.week >= 15).length}`);
        console.log(`Total Matchups: ${matchups.length}`);
        console.log('='.repeat(60));
        
    } catch (error) {
        console.error('Error displaying schedule:', error);
        throw error;
    } finally {
        await db.close();
    }
}

module.exports = { showSchedule };

// Run directly if called as script
if (require.main === module) {
    showSchedule()
        .then(() => {
            console.log('\nSchedule display completed successfully');
            process.exit(0);
        })
        .catch(error => {
            console.error('Error displaying schedule:', error);
            process.exit(1);
        });
}