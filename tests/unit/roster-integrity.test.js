const Database = require('../../server/database/database');

describe('Roster Player ID Integrity', () => {
    let db;
    
    beforeAll(async () => {
        db = new Database();
    });
    
    afterAll(async () => {
        await db.close();
    });
    
    describe('Roster Entry Validation', () => {
        test('all roster entries should have valid nfl_players records', async () => {
            const orphanedEntries = await db.all(`
                SELECT DISTINCT 
                    wr.player_id,
                    wr.player_name,
                    wr.player_position as position,
                    wr.player_team as team,
                    COUNT(*) as roster_count
                FROM weekly_rosters wr
                LEFT JOIN nfl_players np ON wr.player_id = np.player_id
                WHERE np.player_id IS NULL
                GROUP BY wr.player_id
            `);
            
            if (orphanedEntries.length > 0) {
                console.log('Orphaned roster entries found:');
                orphanedEntries.forEach(entry => {
                    console.log(`  - ${entry.player_name} (${entry.player_id}) - ${entry.roster_count} roster entries`);
                });
            }
            
            expect(orphanedEntries).toHaveLength(0);
        });
        
        test('no duplicate player entries in same week/team roster', async () => {
            const duplicates = await db.all(`
                SELECT 
                    team_id,
                    player_id,
                    week,
                    season,
                    COUNT(*) as count
                FROM weekly_rosters
                GROUP BY team_id, player_id, week, season
                HAVING COUNT(*) > 1
            `);
            
            if (duplicates.length > 0) {
                console.log('Duplicate roster entries found:');
                duplicates.forEach(dup => {
                    console.log(`  - Team ${dup.team_id}, Player ${dup.player_id}, Week ${dup.week}/${dup.season}: ${dup.count} entries`);
                });
            }
            
            expect(duplicates).toHaveLength(0);
        });
    });
    
    describe('Player ID Format Validation', () => {
        test('offensive players should use numeric Tank01 IDs', async () => {
            const invalidOffensiveIds = await db.all(`
                SELECT DISTINCT
                    wr.player_id,
                    wr.player_name,
                    wr.player_position as position,
                    COUNT(DISTINCT wr.team_id) as teams_affected
                FROM weekly_rosters wr
                WHERE wr.player_position IN ('QB', 'RB', 'WR', 'TE', 'K')
                AND wr.player_id NOT GLOB '[0-9]*'
                AND wr.season = (SELECT MAX(season) FROM weekly_rosters)
                GROUP BY wr.player_id
            `);
            
            if (invalidOffensiveIds.length > 0) {
                console.log('Offensive players with non-numeric IDs:');
                invalidOffensiveIds.forEach(player => {
                    console.log(`  - ${player.player_name} (${player.position}): ${player.player_id} - affects ${player.teams_affected} team(s)`);
                });
            }
            
            expect(invalidOffensiveIds).toHaveLength(0);
        });
        
        test('defensive players should use DEF_XXX format', async () => {
            const invalidDefenseIds = await db.all(`
                SELECT DISTINCT
                    wr.player_id,
                    wr.player_name,
                    wr.player_team as team
                FROM weekly_rosters wr
                WHERE (wr.player_position = 'DST' OR wr.player_position = 'DEF')
                AND wr.player_id NOT LIKE 'DEF_%'
                AND wr.season = (SELECT MAX(season) FROM weekly_rosters)
            `);
            
            if (invalidDefenseIds.length > 0) {
                console.log('Defenses with invalid IDs:');
                invalidDefenseIds.forEach(def => {
                    console.log(`  - ${def.player_name}: ${def.player_id}`);
                });
            }
            
            expect(invalidDefenseIds).toHaveLength(0);
        });
        
        test('identify all legacy player ID formats', async () => {
            const legacyFormats = await db.all(`
                SELECT DISTINCT
                    wr.player_id,
                    wr.player_name,
                    wr.player_position as position,
                    CASE
                        WHEN wr.player_id LIKE '%_%' AND wr.player_id NOT LIKE 'DEF_%' THEN 'underscore_format'
                        WHEN wr.player_id GLOB '[A-Z]*_[A-Z]*[0-9]' THEN 'team_position_format'
                        ELSE 'other_legacy'
                    END as format_type
                FROM weekly_rosters wr
                WHERE wr.player_id NOT GLOB '[0-9]*'
                AND wr.player_id NOT LIKE 'DEF_%'
                AND wr.season = (SELECT MAX(season) FROM weekly_rosters)
                ORDER BY format_type, wr.player_name
            `);
            
            if (legacyFormats.length > 0) {
                console.log('Legacy player ID formats found:');
                const grouped = {};
                legacyFormats.forEach(player => {
                    if (!grouped[player.format_type]) grouped[player.format_type] = [];
                    grouped[player.format_type].push(player);
                });
                
                Object.keys(grouped).forEach(format => {
                    console.log(`\n  ${format}:`);
                    grouped[format].forEach(player => {
                        console.log(`    - ${player.player_name} (${player.position}): ${player.player_id}`);
                    });
                });
            }
            
            // This is informational, not a failure
            console.log(`Total legacy IDs: ${legacyFormats.length}`);
        });
    });
    
    describe('Stats Linkage Verification', () => {
        test('roster players with game stats should be properly linked', async () => {
            const currentSeason = await db.get('SELECT MAX(season) as season FROM weekly_rosters');
            const currentWeek = await db.get('SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?', [currentSeason.season]);
            
            const unlinkableStats = await db.all(`
                SELECT 
                    wr.player_id as roster_id,
                    wr.player_name,
                    wr.player_position as position,
                    wr.team_id,
                    ps.player_id as stats_id,
                    ps.fantasy_points
                FROM weekly_rosters wr
                LEFT JOIN player_stats ps ON wr.player_id = ps.player_id 
                    AND ps.week = wr.week 
                    AND ps.season = wr.season
                JOIN nfl_games ng ON ng.week = wr.week 
                    AND ng.season = wr.season
                    AND (ng.home_team = wr.player_team OR ng.away_team = wr.player_team)
                WHERE wr.week = ?
                AND wr.season = ?
                AND wr.roster_position = 'active'
                AND ps.player_id IS NULL
                AND ng.status != 'Scheduled'
                LIMIT 20
            `, [currentWeek.week, currentSeason.season]);
            
            if (unlinkableStats.length > 0) {
                console.log(`\nPlayers on active rosters with games played but no stats (Week ${currentWeek.week}/${currentSeason.season}):`);
                unlinkableStats.forEach(player => {
                    console.log(`  - Team ${player.team_id}: ${player.player_name} (${player.position}) - ID: ${player.roster_id}`);
                });
                
                // Try to find matching stats with different IDs
                console.log('\nSearching for potential matches in player_stats...');
                for (const player of unlinkableStats.slice(0, 5)) {
                    const possibleStats = await db.all(`
                        SELECT player_id, player_name, fantasy_points
                        FROM player_stats
                        WHERE player_name = ?
                        AND week = ?
                        AND season = ?
                    `, [player.player_name, currentWeek.week, currentSeason.season]);
                    
                    if (possibleStats.length > 0) {
                        console.log(`  Found stats for ${player.player_name}:`);
                        possibleStats.forEach(stat => {
                            console.log(`    - Stats ID: ${stat.player_id}, Points: ${stat.fantasy_points}`);
                        });
                    }
                }
            }
            
            // This is informational - may not be a failure if games haven't been played
            console.log(`Total unlinked active players: ${unlinkableStats.length}`);
        });
        
        test('identify stats records without roster entries', async () => {
            const currentSeason = await db.get('SELECT MAX(season) as season FROM player_stats');
            
            const orphanedStats = await db.all(`
                SELECT 
                    ps.player_id,
                    ps.player_name,
                    ps.week,
                    ps.fantasy_points,
                    np.position
                FROM player_stats ps
                LEFT JOIN weekly_rosters wr ON ps.player_id = wr.player_id 
                    AND ps.week = wr.week 
                    AND ps.season = wr.season
                LEFT JOIN nfl_players np ON ps.player_id = np.player_id
                WHERE wr.player_id IS NULL
                AND ps.season = ?
                AND ps.fantasy_points > 0
                ORDER BY ps.fantasy_points DESC
                LIMIT 20
            `, [currentSeason.season]);
            
            if (orphanedStats.length > 0) {
                console.log('\nPlayers with stats but no roster entries:');
                orphanedStats.forEach(player => {
                    console.log(`  - ${player.player_name} (${player.position || 'Unknown'}): ${player.fantasy_points} pts in Week ${player.week}`);
                });
            }
            
            // This is informational
            console.log(`Total orphaned stat records with points: ${orphanedStats.length}`);
        });
    });
    
    describe('Fix Recommendations', () => {
        test('generate player ID mapping recommendations', async () => {
            const currentSeason = await db.get('SELECT MAX(season) as season FROM weekly_rosters');
            
            // Find potential matches between roster entries and player stats
            const potentialMappings = await db.all(`
                SELECT DISTINCT
                    wr.player_id as roster_id,
                    wr.player_name as roster_name,
                    np2.player_id as suggested_id,
                    np2.name as suggested_name,
                    wr.player_position as position
                FROM weekly_rosters wr
                LEFT JOIN nfl_players np1 ON wr.player_id = np1.player_id
                LEFT JOIN nfl_players np2 ON LOWER(REPLACE(wr.player_name, ' ', '')) = LOWER(REPLACE(np2.name, ' ', ''))
                WHERE np1.player_id IS NULL
                AND np2.player_id IS NOT NULL
                AND np2.player_id GLOB '[0-9]*'
                AND wr.season = ?
                ORDER BY wr.player_name
            `, [currentSeason.season]);
            
            if (potentialMappings.length > 0) {
                console.log('\nSuggested player ID mappings:');
                console.log('-- SQL Update statements to fix player IDs:');
                potentialMappings.forEach(mapping => {
                    console.log(`UPDATE weekly_rosters SET player_id = '${mapping.suggested_id}' WHERE player_id = '${mapping.roster_id}' AND season = ${currentSeason.season}; -- ${mapping.roster_name}`);
                });
            }
            
            // Also check for similar names with slight differences
            const similarNames = await db.all(`
                SELECT DISTINCT
                    wr.player_id as roster_id,
                    wr.player_name as roster_name,
                    ps.player_id as stats_id,
                    ps.player_name as stats_name
                FROM weekly_rosters wr
                CROSS JOIN player_stats ps
                WHERE wr.player_id != ps.player_id
                AND wr.season = ps.season
                AND wr.week = ps.week
                AND LOWER(SUBSTR(wr.player_name, 1, 5)) = LOWER(SUBSTR(ps.player_name, 1, 5))
                AND LOWER(SUBSTR(wr.player_name, -5)) = LOWER(SUBSTR(ps.player_name, -5))
                AND ps.fantasy_points > 0
                AND wr.season = ?
                LIMIT 10
            `, [currentSeason.season]);
            
            if (similarNames.length > 0) {
                console.log('\nPotential name mismatches:');
                similarNames.forEach(match => {
                    console.log(`  - Roster: "${match.roster_name}" (${match.roster_id})`);
                    console.log(`    Stats: "${match.stats_name}" (${match.stats_id})`);
                });
            }
            
            // This test is informational only
            expect(true).toBe(true);
        });
    });
});