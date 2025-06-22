const Database = require('../../database/database');

// All 32 NFL teams with their standard abbreviations
const NFL_TEAMS = [
    { abbv: 'ARI', name: 'Arizona Cardinals' },
    { abbv: 'ATL', name: 'Atlanta Falcons' },
    { abbv: 'BAL', name: 'Baltimore Ravens' },
    { abbv: 'BUF', name: 'Buffalo Bills' },
    { abbv: 'CAR', name: 'Carolina Panthers' },
    { abbv: 'CHI', name: 'Chicago Bears' },
    { abbv: 'CIN', name: 'Cincinnati Bengals' },
    { abbv: 'CLE', name: 'Cleveland Browns' },
    { abbv: 'DAL', name: 'Dallas Cowboys' },
    { abbv: 'DEN', name: 'Denver Broncos' },
    { abbv: 'DET', name: 'Detroit Lions' },
    { abbv: 'GB', name: 'Green Bay Packers' },
    { abbv: 'HOU', name: 'Houston Texans' },
    { abbv: 'IND', name: 'Indianapolis Colts' },
    { abbv: 'JAX', name: 'Jacksonville Jaguars' },
    { abbv: 'KC', name: 'Kansas City Chiefs' },
    { abbv: 'LAC', name: 'Los Angeles Chargers' },
    { abbv: 'LAR', name: 'Los Angeles Rams' },
    { abbv: 'LV', name: 'Las Vegas Raiders' },
    { abbv: 'MIA', name: 'Miami Dolphins' },
    { abbv: 'MIN', name: 'Minnesota Vikings' },
    { abbv: 'NE', name: 'New England Patriots' },
    { abbv: 'NO', name: 'New Orleans Saints' },
    { abbv: 'NYG', name: 'New York Giants' },
    { abbv: 'NYJ', name: 'New York Jets' },
    { abbv: 'PHI', name: 'Philadelphia Eagles' },
    { abbv: 'PIT', name: 'Pittsburgh Steelers' },
    { abbv: 'SEA', name: 'Seattle Seahawks' },
    { abbv: 'SF', name: 'San Francisco 49ers' },
    { abbv: 'TB', name: 'Tampa Bay Buccaneers' },
    { abbv: 'TEN', name: 'Tennessee Titans' },
    { abbv: 'WAS', name: 'Washington Commanders' }
];

async function addTeamDefenses() {
    const db = new Database();
    
    try {
        console.log('🛡️  Adding NFL team defenses to database...');
        
        // Check existing defenses
        const existingDefenses = await db.all(
            'SELECT * FROM nfl_players WHERE position = ? ORDER BY team',
            ['DST']
        );
        
        console.log(`Found ${existingDefenses.length} existing defenses:`);
        existingDefenses.forEach(def => {
            console.log(`  - ${def.name} (${def.team})`);
        });
        
        let addedCount = 0;
        let skippedCount = 0;
        
        for (const team of NFL_TEAMS) {
            // Check if defense already exists for this team
            const existingDefense = await db.get(
                'SELECT * FROM nfl_players WHERE position = ? AND team = ?',
                ['DST', team.abbv]
            );
            
            if (existingDefense) {
                console.log(`  ✓ ${team.abbv} defense already exists: ${existingDefense.name}`);
                skippedCount++;
                continue;
            }
            
            // Generate a player ID for the defense (using negative numbers to avoid conflicts)
            const playerId = `DEF_${team.abbv}`;
            const defensePlayer = {
                player_id: playerId,
                name: `${team.name} Defense`,
                position: 'DST',
                team: team.abbv,
                bye_week: null // Will be set during sync if available
            };
            
            try {
                await db.run(
                    'INSERT INTO nfl_players (player_id, name, position, team, bye_week, last_updated) VALUES (?, ?, ?, ?, ?, datetime("now"))',
                    [defensePlayer.player_id, defensePlayer.name, defensePlayer.position, defensePlayer.team, defensePlayer.bye_week]
                );
                
                console.log(`  ✅ Added ${team.abbv} defense: ${defensePlayer.name}`);
                addedCount++;
                
            } catch (error) {
                console.error(`  ❌ Error adding ${team.abbv} defense:`, error.message);
            }
        }
        
        console.log(`\n📊 Defense Addition Summary:`);
        console.log(`✅ Added: ${addedCount} new team defenses`);
        console.log(`⏭️  Skipped: ${skippedCount} existing defenses`);
        console.log(`🎯 Total: ${addedCount + skippedCount} of 32 NFL team defenses`);
        
        // Verify final count
        const finalDefenses = await db.all(
            'SELECT team, name FROM nfl_players WHERE position = ? ORDER BY team',
            ['DST']
        );
        
        console.log(`\n🛡️  Final Defense Roster (${finalDefenses.length} teams):`);
        finalDefenses.forEach(def => {
            console.log(`  ${def.team}: ${def.name}`);
        });
        
        if (finalDefenses.length === 32) {
            console.log('\n🎉 SUCCESS: All 32 NFL team defenses are now in the database!');
        } else {
            console.log(`\n⚠️  WARNING: Expected 32 defenses, but found ${finalDefenses.length}`);
        }
        
    } catch (error) {
        console.error('Error adding team defenses:', error);
    } finally {
        await db.close();
    }
}

// Function to ensure defenses persist after sync
function createDefensePreservationHook() {
    return {
        name: 'DefensePreservation',
        description: 'Ensures all 32 NFL team defenses remain in database after player sync',
        
        async beforeSync(db) {
            console.log('🛡️  Preserving team defenses before sync...');
            // Store existing defenses that might not come from API
            const defenses = await db.all('SELECT * FROM nfl_players WHERE position = ?', ['DST']);
            return { preservedDefenses: defenses };
        },
        
        async afterSync(db, preserved) {
            console.log('🛡️  Restoring team defenses after sync...');
            const currentDefenses = await db.all('SELECT team FROM nfl_players WHERE position = ?', ['DST']);
            const currentTeams = new Set(currentDefenses.map(d => d.team));
            
            let restored = 0;
            for (const defense of preserved.preservedDefenses) {
                if (!currentTeams.has(defense.team)) {
                    await db.run(
                        'INSERT INTO nfl_players (player_id, name, position, team, bye_week, last_updated) VALUES (?, ?, ?, ?, ?, datetime("now"))',
                        [defense.player_id, defense.name, defense.position, defense.team, defense.bye_week]
                    );
                    restored++;
                    console.log(`  ✅ Restored ${defense.team} defense`);
                }
            }
            
            if (restored > 0) {
                console.log(`🛡️  Restored ${restored} team defenses after sync`);
            }
        }
    };
}

// Run if called directly
if (require.main === module) {
    addTeamDefenses();
}

module.exports = { addTeamDefenses, createDefensePreservationHook };