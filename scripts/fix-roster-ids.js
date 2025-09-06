#!/usr/bin/env node

/**
 * Fix Roster Player IDs
 * 
 * This script identifies and fixes player ID mismatches in the weekly_rosters table.
 * It maps old-style player IDs to Tank01 numeric IDs for proper stats linkage.
 * 
 * Usage:
 *   node scripts/fix-roster-ids.js                    # Dry run - shows what would be changed
 *   node scripts/fix-roster-ids.js --execute          # Actually perform the updates
 *   node scripts/fix-roster-ids.js --season 2025      # Fix specific season only
 *   node scripts/fix-roster-ids.js --backup           # Create backup before changes
 */

const Database = require('../server/database/database');
const fs = require('fs').promises;
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
const isDryRun = !args.includes('--execute');
const shouldBackup = args.includes('--backup');
const seasonIndex = args.indexOf('--season');
const specificSeason = seasonIndex !== -1 && args[seasonIndex + 1] ? parseInt(args[seasonIndex + 1]) : null;

console.log('='.repeat(60));
console.log('ROSTER PLAYER ID FIX UTILITY');
console.log('='.repeat(60));
console.log(`Mode: ${isDryRun ? 'DRY RUN (use --execute to apply changes)' : 'EXECUTE MODE'}`);
if (specificSeason) console.log(`Season: ${specificSeason}`);
console.log('');

async function createBackup(db) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(__dirname, `../roster_backup_${timestamp}.json`);
    
    console.log('Creating backup...');
    const rosters = await db.all('SELECT * FROM weekly_rosters ORDER BY team_id, week, season');
    await fs.writeFile(backupFile, JSON.stringify(rosters, null, 2));
    console.log(`Backup saved to: ${backupFile}`);
    console.log('');
}

async function findMismatches(db, season = null) {
    const seasonClause = season ? 'AND wr.season = ?' : '';
    const seasonParam = season ? [season] : [];
    
    // Find players with old-style IDs that have exact name matches in nfl_players
    const exactMatches = await db.all(`
        SELECT DISTINCT
            wr.player_id as old_id,
            wr.player_name,
            wr.player_position as position,
            np.player_id as new_id,
            COUNT(DISTINCT wr.team_id) as teams_affected,
            COUNT(DISTINCT wr.week) as weeks_affected
        FROM weekly_rosters wr
        JOIN nfl_players np ON LOWER(TRIM(wr.player_name)) = LOWER(TRIM(np.name))
        WHERE wr.player_id != np.player_id
        AND np.player_id GLOB '[0-9]*'
        AND wr.player_id NOT GLOB '[0-9]*'
        AND wr.player_id NOT LIKE 'DEF_%'
        ${seasonClause}
        GROUP BY wr.player_id, np.player_id
        ORDER BY wr.player_name
    `, ...seasonParam);
    
    // Find known ID mappings based on stats correlation
    const statsBasedMatches = await db.all(`
        SELECT DISTINCT
            wr.player_id as old_id,
            wr.player_name,
            wr.player_position as position,
            ps.player_id as new_id,
            ps.player_name as stats_name,
            COUNT(DISTINCT wr.team_id) as teams_affected,
            COUNT(DISTINCT wr.week) as weeks_affected
        FROM weekly_rosters wr
        JOIN player_stats ps ON LOWER(TRIM(wr.player_name)) = LOWER(TRIM(ps.player_name))
            AND wr.week = ps.week
            AND wr.season = ps.season
        WHERE wr.player_id != ps.player_id
        AND ps.player_id GLOB '[0-9]*'
        AND wr.player_id NOT GLOB '[0-9]*'
        AND wr.player_id NOT LIKE 'DEF_%'
        AND ps.fantasy_points > 0
        ${seasonClause}
        GROUP BY wr.player_id, ps.player_id
        ORDER BY wr.player_name
    `, ...seasonParam);
    
    // Combine and deduplicate matches
    const allMatches = new Map();
    
    exactMatches.forEach(match => {
        allMatches.set(match.old_id, {
            ...match,
            source: 'exact_name_match'
        });
    });
    
    statsBasedMatches.forEach(match => {
        if (!allMatches.has(match.old_id)) {
            allMatches.set(match.old_id, {
                ...match,
                source: 'stats_correlation'
            });
        }
    });
    
    return Array.from(allMatches.values());
}

async function findOrphanedEntries(db, season = null) {
    const seasonClause = season ? 'AND wr.season = ?' : '';
    const seasonParam = season ? [season] : [];
    
    const orphaned = await db.all(`
        SELECT DISTINCT
            wr.player_id,
            wr.player_name,
            wr.player_position as position,
            COUNT(DISTINCT wr.team_id) as teams_affected,
            COUNT(DISTINCT wr.week) as weeks_affected
        FROM weekly_rosters wr
        LEFT JOIN nfl_players np ON wr.player_id = np.player_id
        WHERE np.player_id IS NULL
        ${seasonClause}
        GROUP BY wr.player_id
        ORDER BY wr.player_name
    `, ...seasonParam);
    
    return orphaned;
}

async function applyFixes(db, matches, isDryRun) {
    console.log(`Found ${matches.length} player ID mismatches to fix`);
    console.log('');
    
    let updateCount = 0;
    
    for (const match of matches) {
        console.log(`${match.player_name} (${match.position})`);
        console.log(`  Old ID: ${match.old_id}`);
        console.log(`  New ID: ${match.new_id}`);
        console.log(`  Affects: ${match.teams_affected} team(s), ${match.weeks_affected} week(s)`);
        console.log(`  Source: ${match.source}`);
        
        if (!isDryRun) {
            const result = await db.run(
                'UPDATE weekly_rosters SET player_id = ? WHERE player_id = ?',
                [match.new_id, match.old_id]
            );
            console.log(`  ✓ Updated ${result.changes} roster entries`);
            updateCount += result.changes;
        } else {
            const count = await db.get(
                'SELECT COUNT(*) as count FROM weekly_rosters WHERE player_id = ?',
                [match.old_id]
            );
            console.log(`  → Would update ${count.count} roster entries`);
        }
        console.log('');
    }
    
    return updateCount;
}

async function main() {
    const db = new Database();
    
    try {
        // Create backup if requested
        if (shouldBackup && !isDryRun) {
            await createBackup(db);
        }
        
        // Find mismatches
        console.log('ANALYZING PLAYER ID MISMATCHES');
        console.log('-'.repeat(60));
        const matches = await findMismatches(db, specificSeason);
        
        if (matches.length === 0) {
            console.log('No player ID mismatches found!');
            console.log('');
        } else {
            // Apply fixes
            const updateCount = await applyFixes(db, matches, isDryRun);
            
            if (!isDryRun) {
                console.log('='.repeat(60));
                console.log(`COMPLETE: Updated ${updateCount} roster entries`);
            } else {
                console.log('='.repeat(60));
                console.log('DRY RUN COMPLETE');
                console.log('Run with --execute to apply these changes');
            }
        }
        
        // Check for orphaned entries
        console.log('');
        console.log('CHECKING FOR ORPHANED ENTRIES');
        console.log('-'.repeat(60));
        const orphaned = await findOrphanedEntries(db, specificSeason);
        
        if (orphaned.length === 0) {
            console.log('No orphaned roster entries found!');
        } else {
            console.log(`Found ${orphaned.length} players without matching nfl_players records:`);
            console.log('');
            orphaned.forEach(entry => {
                console.log(`  - ${entry.player_name} (${entry.position}): ${entry.player_id}`);
                console.log(`    Affects: ${entry.teams_affected} team(s), ${entry.weeks_affected} week(s)`);
            });
            console.log('');
            console.log('These entries need manual review or additional player records.');
        }
        
        // Summary of remaining issues
        console.log('');
        console.log('VALIDATION SUMMARY');
        console.log('-'.repeat(60));
        
        const currentSeason = specificSeason || await db.get('SELECT MAX(season) as season FROM weekly_rosters').then(r => r.season);
        
        const invalidOffensive = await db.get(`
            SELECT COUNT(DISTINCT player_id) as count
            FROM weekly_rosters
            WHERE player_position IN ('QB', 'RB', 'WR', 'TE', 'K')
            AND player_id NOT GLOB '[0-9]*'
            AND season = ?
        `, [currentSeason]);
        
        const invalidDefensive = await db.get(`
            SELECT COUNT(DISTINCT player_id) as count
            FROM weekly_rosters
            WHERE player_position IN ('DST', 'DEF')
            AND player_id NOT LIKE 'DEF_%'
            AND season = ?
        `, [currentSeason]);
        
        console.log(`Season ${currentSeason} Status:`);
        console.log(`  Offensive players with non-numeric IDs: ${invalidOffensive.count}`);
        console.log(`  Defenses with invalid IDs: ${invalidDefensive.count}`);
        console.log(`  Orphaned roster entries: ${orphaned.length}`);
        
        if (invalidOffensive.count === 0 && invalidDefensive.count === 0 && orphaned.length === 0) {
            console.log('');
            console.log('✓ All player IDs are properly formatted!');
        }
        
    } catch (error) {
        console.error('Error:', error);
    } finally {
        await db.close();
    }
}

main().catch(console.error);