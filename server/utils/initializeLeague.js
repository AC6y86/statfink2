require('dotenv').config();
const DatabaseManager = require('../database/database');

async function initializeLeague() {
    const db = new DatabaseManager();
    
    // Wait for database to initialize
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    try {
        console.log('Initializing league...\n');
        
        // Initialize league settings
        console.log('1. Setting up league configuration...');
        await db.run(`
            INSERT OR IGNORE INTO league_settings 
            (league_id, league_name, max_teams, season_year, current_week)
            VALUES (1, 'StatFink Fantasy League', 12, 2024, 1)
        `);
        
        // Add your teams here - update with actual team/owner names
        console.log('\n2. Adding teams...');
        const teams = [
            { name: 'Team Alpha', owner: 'John Smith' },
            { name: 'Team Beta', owner: 'Jane Doe' },
            { name: 'Team Gamma', owner: 'Bob Johnson' },
            { name: 'Team Delta', owner: 'Alice Williams' },
            { name: 'Team Epsilon', owner: 'Charlie Brown' },
            { name: 'Team Zeta', owner: 'Diana Prince' },
            { name: 'Team Eta', owner: 'Bruce Wayne' },
            { name: 'Team Theta', owner: 'Clark Kent' },
            { name: 'Team Iota', owner: 'Tony Stark' },
            { name: 'Team Kappa', owner: 'Steve Rogers' },
            { name: 'Team Lambda', owner: 'Natasha Romanoff' },
            { name: 'Team Mu', owner: 'Peter Parker' }
        ];

        for (const team of teams) {
            try {
                await db.run(
                    'INSERT INTO teams (team_name, owner_name) VALUES (?, ?)',
                    [team.name, team.owner]
                );
                console.log(`  ✓ Added: ${team.name} (${team.owner})`);
            } catch (err) {
                if (err.message.includes('UNIQUE')) {
                    console.log(`  - Skipped: ${team.name} (already exists)`);
                } else {
                    throw err;
                }
            }
        }
        
        // Verify setup
        console.log('\n3. Verifying setup...');
        const settings = await db.getLeagueSettings();
        const allTeams = await db.getAllTeams();
        
        console.log(`\n✅ League initialized successfully!`);
        console.log(`   - League: ${settings.league_name}`);
        console.log(`   - Season: ${settings.season_year}`);
        console.log(`   - Teams: ${allTeams.length}/${settings.max_teams}`);
        console.log(`   - Current Week: ${settings.current_week}`);
        
    } catch (error) {
        console.error('❌ Error initializing league:', error);
        process.exit(1);
    } finally {
        await db.close();
    }
}

// Run if called directly
if (require.main === module) {
    initializeLeague();
}

module.exports = initializeLeague;