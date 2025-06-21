const DatabaseManager = require('../server/database/database');

async function populatePlayerMapping() {
    const db = new DatabaseManager();
    
    try {
        console.log('Starting player mapping population...');
        
        // Get all unique player combinations from weekly_rosters and player_stats
        const mappings = await db.all(`
            SELECT DISTINCT 
                wr.player_id as our_player_id,
                ps.player_id as tank01_player_id,
                wr.player_name as player_name
            FROM weekly_rosters wr
            INNER JOIN player_stats ps ON wr.player_name = ps.player_name
            WHERE ps.player_id IS NOT NULL
              AND wr.player_id IS NOT NULL
        `);
        
        console.log(`Found ${mappings.length} player mappings to create`);
        
        // Insert mappings into tank01_player_mapping table
        let inserted = 0;
        let skipped = 0;
        
        for (const mapping of mappings) {
            try {
                await db.run(`
                    INSERT OR IGNORE INTO tank01_player_mapping 
                    (our_player_id, tank01_player_id, player_name)
                    VALUES (?, ?, ?)
                `, [mapping.our_player_id, mapping.tank01_player_id, mapping.player_name]);
                inserted++;
            } catch (error) {
                console.error(`Failed to insert mapping for ${mapping.player_name}:`, error.message);
                skipped++;
            }
        }
        
        console.log(`\nMapping population complete!`);
        console.log(`- Inserted: ${inserted} mappings`);
        console.log(`- Skipped: ${skipped} mappings`);
        
        // Verify some mappings
        console.log('\nSample mappings created:');
        const samples = await db.all(`
            SELECT * FROM tank01_player_mapping 
            ORDER BY player_name 
            LIMIT 5
        `);
        
        samples.forEach(sample => {
            console.log(`  ${sample.player_name}: ${sample.our_player_id} -> ${sample.tank01_player_id}`);
        });
        
    } catch (error) {
        console.error('Error populating player mappings:', error);
    } finally {
        await db.close();
    }
}

// Run the script
populatePlayerMapping().catch(console.error);