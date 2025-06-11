const DatabaseManager = require('../database/database');

/**
 * Utility functions for managing weekly roster snapshots
 */

/**
 * Capture roster snapshot for the current week
 */
async function captureCurrentWeekSnapshot() {
    const db = new DatabaseManager();
    
    try {
        // Get current week from league settings
        const leagueSettings = await db.getLeagueSettings();
        const currentWeek = leagueSettings.current_week;
        const season = leagueSettings.season_year;
        
        console.log(`Capturing roster snapshot for Week ${currentWeek}, Season ${season}...`);
        
        const entriesCount = await db.captureWeeklyRosterSnapshot(currentWeek, season);
        
        console.log(`✅ Successfully captured ${entriesCount} roster entries for Week ${currentWeek}`);
        return { week: currentWeek, season, entriesCount };
        
    } catch (error) {
        console.error('Error capturing roster snapshot:', error);
        throw error;
    } finally {
        await db.close();
    }
}

/**
 * Capture roster snapshot for a specific week
 */
async function captureWeekSnapshot(week, season = 2024) {
    const db = new DatabaseManager();
    
    try {
        console.log(`Capturing roster snapshot for Week ${week}, Season ${season}...`);
        
        const entriesCount = await db.captureWeeklyRosterSnapshot(week, season);
        
        console.log(`✅ Successfully captured ${entriesCount} roster entries for Week ${week}`);
        return { week, season, entriesCount };
        
    } catch (error) {
        console.error(`Error capturing roster snapshot for Week ${week}:`, error);
        throw error;
    } finally {
        await db.close();
    }
}

/**
 * Display roster snapshot for a specific team and week
 */
async function showTeamWeeklyRoster(teamId, week, season = 2024) {
    const db = new DatabaseManager();
    
    try {
        const roster = await db.getTeamWeeklyRoster(teamId, week, season);
        
        if (roster.length === 0) {
            console.log(`No roster snapshot found for Team ${teamId}, Week ${week}, Season ${season}`);
            return;
        }
        
        const teamInfo = roster[0];
        console.log(`\n📋 ${teamInfo.team_name} (${teamInfo.owner_name}) - Week ${week}, ${season}`);
        console.log('='.repeat(60));
        
        // Group by roster position
        const starters = roster.filter(p => p.roster_position === 'starter');
        const bench = roster.filter(p => p.roster_position === 'bench');
        const injuredReserve = roster.filter(p => p.roster_position === 'injured_reserve');
        
        if (starters.length > 0) {
            console.log('\n🏈 STARTERS:');
            starters.forEach(player => {
                console.log(`  ${player.player_position}: ${player.player_name} (${player.player_team})`);
            });
        }
        
        if (bench.length > 0) {
            console.log('\n🪑 BENCH:');
            bench.forEach(player => {
                console.log(`  ${player.player_position}: ${player.player_name} (${player.player_team})`);
            });
        }
        
        if (injuredReserve.length > 0) {
            console.log('\n🏥 INJURED RESERVE:');
            injuredReserve.forEach(player => {
                console.log(`  ${player.player_position}: ${player.player_name} (${player.player_team})`);
            });
        }
        
        console.log(`\nTotal Players: ${roster.length}`);
        
    } catch (error) {
        console.error('Error showing team weekly roster:', error);
        throw error;
    } finally {
        await db.close();
    }
}

/**
 * Show available snapshot weeks
 */
async function showAvailableSnapshots(season = 2024) {
    const db = new DatabaseManager();
    
    try {
        const snapshots = await db.getAvailableSnapshotWeeks(season);
        
        if (snapshots.length === 0) {
            console.log(`No roster snapshots found for ${season} season`);
            return;
        }
        
        console.log(`\n📅 Available Roster Snapshots for ${season} Season:`);
        console.log('='.repeat(50));
        
        snapshots.forEach(snapshot => {
            const date = new Date(snapshot.snapshot_date).toLocaleDateString();
            console.log(`Week ${snapshot.week}: ${snapshot.roster_count} entries (captured ${date})`);
        });
        
        return snapshots;
        
    } catch (error) {
        console.error('Error showing available snapshots:', error);
        throw error;
    } finally {
        await db.close();
    }
}

/**
 * Show roster changes between two weeks for a team
 */
async function showRosterChanges(teamId, fromWeek, toWeek, season = 2024) {
    const db = new DatabaseManager();
    
    try {
        const changes = await db.getRosterChangesBetweenWeeks(teamId, fromWeek, toWeek, season);
        
        // Get team info
        const team = await db.getTeam(teamId);
        
        console.log(`\n🔄 Roster Changes for ${team.team_name} (${team.owner_name})`);
        console.log(`   From Week ${fromWeek} to Week ${toWeek}, ${season} Season`);
        console.log('='.repeat(60));
        
        if (changes.added.length > 0) {
            console.log('\n➕ ADDED PLAYERS:');
            changes.added.forEach(player => {
                console.log(`  ${player.player_position}: ${player.player_name} (${player.player_team}) - ${player.roster_position}`);
            });
        }
        
        if (changes.dropped.length > 0) {
            console.log('\n➖ DROPPED PLAYERS:');
            changes.dropped.forEach(player => {
                console.log(`  ${player.player_position}: ${player.player_name} (${player.player_team}) - was ${player.roster_position}`);
            });
        }
        
        if (changes.moved.length > 0) {
            console.log('\n🔀 POSITION CHANGES:');
            changes.moved.forEach(player => {
                const fromRoster = changes.fromWeek === fromWeek ? 
                    changes.moved.find(p => p.player_id === player.player_id) : null;
                console.log(`  ${player.player_position}: ${player.player_name} - moved to ${player.roster_position}`);
            });
        }
        
        if (changes.added.length === 0 && changes.dropped.length === 0 && changes.moved.length === 0) {
            console.log('\n✅ No roster changes between these weeks');
        }
        
        return changes;
        
    } catch (error) {
        console.error('Error showing roster changes:', error);
        throw error;
    } finally {
        await db.close();
    }
}

/**
 * Capture snapshots for multiple weeks (useful for bulk operations)
 */
async function captureMultipleWeekSnapshots(weeks, season = 2024) {
    console.log(`Capturing roster snapshots for weeks ${weeks.join(', ')} in ${season} season...`);
    
    const results = [];
    
    for (const week of weeks) {
        try {
            const result = await captureWeekSnapshot(week, season);
            results.push(result);
        } catch (error) {
            console.error(`Failed to capture Week ${week}:`, error.message);
            results.push({ week, season, error: error.message });
        }
    }
    
    console.log('\n📊 Bulk Snapshot Results:');
    results.forEach(result => {
        if (result.error) {
            console.log(`❌ Week ${result.week}: ${result.error}`);
        } else {
            console.log(`✅ Week ${result.week}: ${result.entriesCount} entries`);
        }
    });
    
    return results;
}

module.exports = {
    captureCurrentWeekSnapshot,
    captureWeekSnapshot,
    showTeamWeeklyRoster,
    showAvailableSnapshots,
    showRosterChanges,
    captureMultipleWeekSnapshots
};

// Command line interface
if (require.main === module) {
    const args = process.argv.slice(2);
    const command = args[0];
    
    async function runCommand() {
        try {
            switch (command) {
                case 'capture':
                    if (args[1]) {
                        await captureWeekSnapshot(parseInt(args[1]), parseInt(args[2]) || 2024);
                    } else {
                        await captureCurrentWeekSnapshot();
                    }
                    break;
                    
                case 'show-team':
                    const teamId = parseInt(args[1]);
                    const week = parseInt(args[2]);
                    const season = parseInt(args[3]) || 2024;
                    await showTeamWeeklyRoster(teamId, week, season);
                    break;
                    
                case 'show-snapshots':
                    await showAvailableSnapshots(parseInt(args[1]) || 2024);
                    break;
                    
                case 'show-changes':
                    const changeTeamId = parseInt(args[1]);
                    const fromWeek = parseInt(args[2]);
                    const toWeek = parseInt(args[3]);
                    const changeSeason = parseInt(args[4]) || 2024;
                    await showRosterChanges(changeTeamId, fromWeek, toWeek, changeSeason);
                    break;
                    
                case 'bulk-capture':
                    const startWeek = parseInt(args[1]);
                    const endWeek = parseInt(args[2]);
                    const bulkSeason = parseInt(args[3]) || 2024;
                    const weekRange = Array.from({length: endWeek - startWeek + 1}, (_, i) => startWeek + i);
                    await captureMultipleWeekSnapshots(weekRange, bulkSeason);
                    break;
                    
                default:
                    console.log('Usage:');
                    console.log('  node rosterSnapshot.js capture [week] [season]     - Capture snapshot');
                    console.log('  node rosterSnapshot.js show-team <teamId> <week> [season] - Show team roster');
                    console.log('  node rosterSnapshot.js show-snapshots [season]    - Show available snapshots');
                    console.log('  node rosterSnapshot.js show-changes <teamId> <fromWeek> <toWeek> [season]');
                    console.log('  node rosterSnapshot.js bulk-capture <startWeek> <endWeek> [season]');
            }
        } catch (error) {
            console.error('Command failed:', error.message);
            process.exit(1);
        }
    }
    
    runCommand().then(() => process.exit(0));
}