const Database = require('../database/database');

async function cleanupDuplicateTeams() {
    const db = new Database();
    
    try {
        console.log('🧹 Cleaning up duplicate teams...');
        
        // First, let's see what teams we have
        const allTeams = await db.all('SELECT team_id, team_name, owner_name FROM teams ORDER BY team_id');
        console.log(`Found ${allTeams.length} total teams`);
        
        // Keep only the first 12 teams (our main roster teams)
        const teamsToKeep = allTeams.slice(0, 12);
        const teamsToDelete = allTeams.slice(12);
        
        console.log(`Keeping ${teamsToKeep.length} teams:`);
        teamsToKeep.forEach(team => {
            console.log(`  Team ${team.team_id}: ${team.team_name} (${team.owner_name})`);
        });
        
        console.log(`\nDeleting ${teamsToDelete.length} duplicate teams...`);
        
        // Delete roster entries for teams to be deleted
        for (const team of teamsToDelete) {
            await db.run('DELETE FROM fantasy_rosters WHERE team_id = ?', [team.team_id]);
            await db.run('DELETE FROM teams WHERE team_id = ?', [team.team_id]);
            console.log(`  ✅ Deleted Team ${team.team_id}: ${team.team_name}`);
        }
        
        // Verify cleanup
        const remainingTeams = await db.all('SELECT team_id, team_name, owner_name FROM teams ORDER BY team_id');
        console.log(`\n📊 Cleanup complete! Remaining teams: ${remainingTeams.length}`);
        
        // Show roster counts for remaining teams
        console.log('\n📋 Final Team Roster Counts:');
        for (const team of remainingTeams) {
            const count = await db.get(
                'SELECT COUNT(*) as count FROM fantasy_rosters WHERE team_id = ?',
                [team.team_id]
            );
            console.log(`  Team ${team.team_id} (${team.owner_name}): ${count.count} players`);
        }
        
    } catch (error) {
        console.error('Error cleaning up teams:', error);
    } finally {
        await db.close();
    }
}

// Run if called directly
if (require.main === module) {
    cleanupDuplicateTeams();
}

module.exports = { cleanupDuplicateTeams };