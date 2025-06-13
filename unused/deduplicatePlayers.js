const Database = require('../database/database');

async function deduplicatePlayers() {
    const db = new Database();
    
    try {
        console.log('🔍 Finding duplicate players in database...');
        
        // First, let's analyze the duplicates we found
        const duplicateNames = await db.all(`
            SELECT name, COUNT(*) as count 
            FROM nfl_players 
            GROUP BY name 
            HAVING COUNT(*) > 1 
            ORDER BY count DESC, name
        `);
        
        console.log(`Found ${duplicateNames.length} duplicate player names:`);
        
        let totalDuplicatesRemoved = 0;
        let playersUpdated = 0;
        
        for (const duplicate of duplicateNames) {
            console.log(`\n📋 Processing: ${duplicate.name} (${duplicate.count} entries)`);
            
            // Get all entries for this player name
            const players = await db.all(
                'SELECT * FROM nfl_players WHERE name = ? ORDER BY last_updated DESC',
                [duplicate.name]
            );
            
            // Show current entries
            players.forEach((player, index) => {
                console.log(`  ${index + 1}. ID: ${player.player_id}, Team: ${player.team}, Position: ${player.position}, Updated: ${player.last_updated}`);
            });
            
            // Apply deduplication logic
            const result = await deduplicatePlayerGroup(db, duplicate.name, players);
            totalDuplicatesRemoved += result.removed;
            playersUpdated += result.updated;
        }
        
        console.log(`\n📊 Deduplication Summary:`);
        console.log(`✅ Duplicate entries removed: ${totalDuplicatesRemoved}`);
        console.log(`🔄 Player records updated: ${playersUpdated}`);
        
        // Verify cleanup
        const remainingDuplicates = await db.all(`
            SELECT name, COUNT(*) as count 
            FROM nfl_players 
            GROUP BY name 
            HAVING COUNT(*) > 1
        `);
        
        console.log(`\n🎯 Remaining duplicates: ${remainingDuplicates.length}`);
        if (remainingDuplicates.length > 0) {
            console.log('⚠️  Some duplicates remain (likely different players with same name):');
            remainingDuplicates.forEach(dup => {
                console.log(`  - ${dup.name} (${dup.count} entries)`);
            });
        } else {
            console.log('🎉 All duplicates successfully resolved!');
        }
        
    } catch (error) {
        console.error('Error deduplicating players:', error);
    } finally {
        await db.close();
    }
}

async function deduplicatePlayerGroup(db, playerName, players) {
    let removed = 0;
    let updated = 0;
    
    // Strategy: Keep numeric IDs over team-specific IDs, and prefer more recent data
    
    // Separate players by ID type
    const numericIdPlayers = players.filter(p => /^\d+$/.test(p.player_id));
    const teamSpecificIdPlayers = players.filter(p => /^[A-Z]+_/.test(p.player_id));
    const otherIdPlayers = players.filter(p => !/^\d+$/.test(p.player_id) && !/^[A-Z]+_/.test(p.player_id));
    
    console.log(`    Numeric IDs: ${numericIdPlayers.length}, Team IDs: ${teamSpecificIdPlayers.length}, Other: ${otherIdPlayers.length}`);
    
    if (numericIdPlayers.length > 0 && teamSpecificIdPlayers.length > 0) {
        // Case 1: Same player with both numeric and team-specific IDs
        // Keep the numeric ID (from API), remove team-specific
        
        const keepPlayer = numericIdPlayers[0]; // Most recent numeric ID
        const removeIds = teamSpecificIdPlayers.map(p => p.player_id);
        
        console.log(`    Strategy: Keep numeric ID ${keepPlayer.player_id}, remove team IDs: ${removeIds.join(', ')}`);
        
        // Update any roster entries that reference the old IDs
        for (const oldId of removeIds) {
            const rosterEntries = await db.all(
                'SELECT * FROM fantasy_rosters WHERE player_id = ?',
                [oldId]
            );
            
            for (const entry of rosterEntries) {
                await db.run(
                    'UPDATE fantasy_rosters SET player_id = ? WHERE roster_id = ?',
                    [keepPlayer.player_id, entry.roster_id]
                );
                console.log(`    🔄 Updated roster entry: ${oldId} → ${keepPlayer.player_id}`);
                updated++;
            }
            
            // Update any player stats entries that reference the old IDs
            const statsEntries = await db.all(
                'SELECT * FROM player_stats WHERE player_id = ?',
                [oldId]
            );
            
            for (const entry of statsEntries) {
                await db.run(
                    'UPDATE player_stats SET player_id = ? WHERE stat_id = ?',
                    [keepPlayer.player_id, entry.stat_id]
                );
                console.log(`    🔄 Updated stats entry: ${oldId} → ${keepPlayer.player_id}`);
                updated++;
            }
            
            // Remove the duplicate player record
            await db.run('DELETE FROM nfl_players WHERE player_id = ?', [oldId]);
            console.log(`    ❌ Removed duplicate: ${oldId}`);
            removed++;
        }
        
    } else if (numericIdPlayers.length > 1) {
        // Case 2: Multiple numeric IDs for same name
        // This might be team transfers or different players with same name
        
        // Group by position to see if they're the same player
        const positionGroups = {};
        numericIdPlayers.forEach(player => {
            if (!positionGroups[player.position]) {
                positionGroups[player.position] = [];
            }
            positionGroups[player.position].push(player);
        });
        
        console.log(`    Position groups: ${Object.keys(positionGroups).join(', ')}`);
        
        // If same position, likely same player - keep most recent
        for (const [position, groupPlayers] of Object.entries(positionGroups)) {
            if (groupPlayers.length > 1) {
                const keepPlayer = groupPlayers[0]; // Most recent (already sorted by last_updated DESC)
                const removeIds = groupPlayers.slice(1).map(p => p.player_id);
                
                console.log(`    Strategy: Keep most recent ${position} ${keepPlayer.player_id}, remove: ${removeIds.join(', ')}`);
                
                // Update roster entries
                for (const oldId of removeIds) {
                    const rosterEntries = await db.all(
                        'SELECT * FROM fantasy_rosters WHERE player_id = ?',
                        [oldId]
                    );
                    
                    for (const entry of rosterEntries) {
                        await db.run(
                            'UPDATE fantasy_rosters SET player_id = ? WHERE roster_id = ?',
                            [keepPlayer.player_id, entry.roster_id]
                        );
                        console.log(`    🔄 Updated roster entry: ${oldId} → ${keepPlayer.player_id}`);
                        updated++;
                    }
                    
                    // Update stats entries
                    const statsEntries = await db.all(
                        'SELECT * FROM player_stats WHERE player_id = ?',
                        [oldId]
                    );
                    
                    for (const entry of statsEntries) {
                        await db.run(
                            'UPDATE player_stats SET player_id = ? WHERE stat_id = ?',
                            [keepPlayer.player_id, entry.stat_id]
                        );
                        console.log(`    🔄 Updated stats entry: ${oldId} → ${keepPlayer.player_id}`);
                        updated++;
                    }
                    
                    // Remove duplicate
                    await db.run('DELETE FROM nfl_players WHERE player_id = ?', [oldId]);
                    console.log(`    ❌ Removed duplicate: ${oldId}`);
                    removed++;
                }
            }
        }
        
        // If different positions, they might be different players - leave them alone
        if (Object.keys(positionGroups).length > 1) {
            console.log(`    ⚠️  Different positions detected - leaving as separate players`);
        }
        
    } else if (teamSpecificIdPlayers.length > 1) {
        // Case 3: Multiple team-specific IDs
        // Keep the most recent one
        
        const keepPlayer = teamSpecificIdPlayers[0]; // Most recent
        const removeIds = teamSpecificIdPlayers.slice(1).map(p => p.player_id);
        
        console.log(`    Strategy: Keep most recent team ID ${keepPlayer.player_id}, remove: ${removeIds.join(', ')}`);
        
        // Update roster entries and remove duplicates
        for (const oldId of removeIds) {
            const rosterEntries = await db.all(
                'SELECT * FROM fantasy_rosters WHERE player_id = ?',
                [oldId]
            );
            
            for (const entry of rosterEntries) {
                await db.run(
                    'UPDATE fantasy_rosters SET player_id = ? WHERE roster_id = ?',
                    [keepPlayer.player_id, entry.roster_id]
                );
                console.log(`    🔄 Updated roster entry: ${oldId} → ${keepPlayer.player_id}`);
                updated++;
            }
            
            // Update stats entries
            const statsEntries = await db.all(
                'SELECT * FROM player_stats WHERE player_id = ?',
                [oldId]
            );
            
            for (const entry of statsEntries) {
                await db.run(
                    'UPDATE player_stats SET player_id = ? WHERE stat_id = ?',
                    [keepPlayer.player_id, entry.stat_id]
                );
                console.log(`    🔄 Updated stats entry: ${oldId} → ${keepPlayer.player_id}`);
                updated++;
            }
            
            await db.run('DELETE FROM nfl_players WHERE player_id = ?', [oldId]);
            console.log(`    ❌ Removed duplicate: ${oldId}`);
            removed++;
        }
    } else {
        console.log(`    ℹ️  No clear deduplication strategy - leaving as-is`);
    }
    
    return { removed, updated };
}

// Run if called directly
if (require.main === module) {
    deduplicatePlayers();
}

module.exports = { deduplicatePlayers };