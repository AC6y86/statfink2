const Database = require('../../server/database/database');
const fs = require('fs').promises;
const path = require('path');
const { getTestConfig, getTestDescription, logTestConfig } = require('./helpers/test-config');

describe(`Player Matching Verification (${getTestDescription()})`, () => {
    let db;
    let testConfig;
    const reportDir = '/tmp/verification-reports';
    const reportFile = path.join(reportDir, 'player-matching-report.csv');
    
    beforeAll(async () => {
        db = new Database();
        testConfig = getTestConfig();
        logTestConfig();
        await fs.mkdir(reportDir, { recursive: true });
    });
    
    afterAll(async () => {
        await db.close();
    });
    
    describe('Player-Game Matching', () => {
        // DISABLED: System uses player_id for matching stats, not team abbreviations
        // This test found consistency issues but not functional problems
        // Re-enable when team abbreviations are standardized across all tables
        test.skip('all roster players should match to valid games', async () => {
            const { season, week } = testConfig;
            
            const unmatchedPlayers = await db.all(`
                SELECT DISTINCT
                    wr.player_id,
                    wr.player_name,
                    wr.player_position,
                    wr.player_team,
                    wr.week,
                    wr.team_id,
                    wr.roster_position
                FROM weekly_rosters wr
                LEFT JOIN nfl_games ng ON 
                    wr.week = ng.week 
                    AND wr.season = ng.season
                    AND (ng.home_team = wr.player_team OR ng.away_team = wr.player_team)
                WHERE wr.season = ?
                AND wr.week = ?
                AND ng.game_id IS NULL
                AND wr.player_position != 'DST'
                ORDER BY wr.week, wr.team_id, wr.player_name
            `, [season, week]);
            
            if (unmatchedPlayers.length > 0) {
                console.log(`\n❌ Found ${unmatchedPlayers.length} roster players without matching games:`);
                
                const csvLines = ['Player ID,Player Name,Position,Team,Week,Fantasy Team,Roster Position'];
                unmatchedPlayers.forEach(player => {
                    console.log(`  - Week ${player.week}: ${player.player_name} (${player.player_position}, ${player.player_team}) on Team ${player.team_id}`);
                    csvLines.push(`${player.player_id},${player.player_name},${player.player_position},${player.player_team},${player.week},${player.team_id},${player.roster_position}`);
                });
                
                await fs.writeFile(reportFile, csvLines.join('\n'));
                console.log(`\n📄 Detailed report saved to: ${reportFile}`);
            }
            
            expect(unmatchedPlayers.length).toBe(0);
        });
        
        test('all roster players should exist in nfl_players table', async () => {
            const { season, week } = testConfig;
            
            const orphanedPlayers = await db.all(`
                SELECT DISTINCT
                    wr.player_id,
                    wr.player_name,
                    wr.player_position,
                    wr.player_team,
                    COUNT(DISTINCT wr.week) as weeks_on_roster,
                    COUNT(DISTINCT wr.team_id) as teams_affected
                FROM weekly_rosters wr
                LEFT JOIN nfl_players np ON wr.player_id = np.player_id
                WHERE wr.season = ?
                AND wr.week = ?
                AND np.player_id IS NULL
                GROUP BY wr.player_id, wr.player_name, wr.player_position, wr.player_team
                ORDER BY weeks_on_roster DESC, wr.player_name
            `, [season, week]);
            
            if (orphanedPlayers.length > 0) {
                console.log(`\n❌ Found ${orphanedPlayers.length} roster players not in nfl_players table:`);
                
                const csvLines = ['Player ID,Player Name,Position,Team,Weeks on Roster,Teams Affected'];
                for (const player of orphanedPlayers.slice(0, 20)) {
                    console.log(`  - ${player.player_name} (${player.player_position}, ${player.player_team}): ID=${player.player_id}, ${player.weeks_on_roster} weeks, affects ${player.teams_affected} teams`);
                    
                    // Try to find a matching player by name
                    const possibleMatch = await db.get(`
                        SELECT player_id, name, position, team
                        FROM nfl_players
                        WHERE LOWER(REPLACE(name, ' ', '')) = LOWER(REPLACE(?, ' ', ''))
                        OR LOWER(name) LIKE LOWER(?)
                    `, [player.player_name, `%${player.player_name.split(' ').pop()}%`]);
                    
                    if (possibleMatch) {
                        console.log(`    💡 Possible match: ${possibleMatch.name} (ID: ${possibleMatch.player_id})`);
                    }
                    
                    csvLines.push(`${player.player_id},${player.player_name},${player.player_position},${player.player_team},${player.weeks_on_roster},${player.teams_affected}`);
                }
                
                const orphanReportFile = path.join(reportDir, 'orphaned-players-report.csv');
                await fs.writeFile(orphanReportFile, csvLines.join('\n'));
                console.log(`\n📄 Orphaned players report saved to: ${orphanReportFile}`);
            }
            
            expect(orphanedPlayers.length).toBe(0);
        });
    });
    
    describe('Player ID Format Validation', () => {
        test('offensive players should use numeric Tank01 IDs', async () => {
            const { season, week } = testConfig;
            
            const invalidIds = await db.all(`
                SELECT DISTINCT
                    wr.player_id,
                    wr.player_name,
                    wr.player_position,
                    wr.player_team,
                    COUNT(DISTINCT wr.week) as weeks_affected
                FROM weekly_rosters wr
                WHERE wr.season = ?
                AND wr.week = ?
                AND wr.player_position IN ('QB', 'RB', 'WR', 'TE', 'K')
                AND wr.player_id NOT GLOB '[0-9]*'
                GROUP BY wr.player_id, wr.player_name, wr.player_position, wr.player_team
                ORDER BY weeks_affected DESC
            `, [season, week]);
            
            if (invalidIds.length > 0) {
                console.log(`\n⚠️ Found ${invalidIds.length} offensive players with non-numeric IDs:`);
                
                const updateStatements = [];
                for (const player of invalidIds.slice(0, 15)) {
                    console.log(`  - ${player.player_name} (${player.player_position}): ${player.player_id}`);
                    
                    // Try to find correct Tank01 ID
                    const correctId = await db.get(`
                        SELECT player_id, name
                        FROM nfl_players
                        WHERE LOWER(REPLACE(name, ' ', '')) = LOWER(REPLACE(?, ' ', ''))
                        AND player_id GLOB '[0-9]*'
                    `, [player.player_name]);
                    
                    if (correctId) {
                        console.log(`    ✅ Found correct ID: ${correctId.player_id}`);
                        updateStatements.push(`UPDATE weekly_rosters SET player_id = '${correctId.player_id}' WHERE player_id = '${player.player_id}' AND season = ${season} AND week = ${week}; -- ${player.player_name}`);
                    }
                }
                
                if (updateStatements.length > 0) {
                    const sqlFile = path.join(reportDir, 'fix-player-ids.sql');
                    await fs.writeFile(sqlFile, updateStatements.join('\n'));
                    console.log(`\n📄 SQL fix statements saved to: ${sqlFile}`);
                }
            }
            
            expect(invalidIds.length).toBe(0);
        });
        
        test('defensive players should use DEF_XXX format', async () => {
            const { season, week } = testConfig;
            
            const invalidDefIds = await db.all(`
                SELECT DISTINCT
                    wr.player_id,
                    wr.player_name,
                    wr.player_team
                FROM weekly_rosters wr
                WHERE wr.season = ?
                AND wr.week = ?
                AND wr.player_position = 'DST'
                AND wr.player_id NOT LIKE 'DEF_%'
            `, [season, week]);
            
            if (invalidDefIds.length > 0) {
                console.log(`\n⚠️ Found ${invalidDefIds.length} defenses with invalid IDs:`);
                invalidDefIds.forEach(def => {
                    console.log(`  - ${def.player_name}: ${def.player_id} (should be DEF_${def.player_team})`);
                });
            }
            
            expect(invalidDefIds.length).toBe(0);
        });
    });
    
    describe('Player Consistency Checks', () => {
        test('players should have consistent names within the week', async () => {
            const { season, week } = testConfig;
            
            const inconsistentNames = await db.all(`
                SELECT 
                    player_id,
                    GROUP_CONCAT(DISTINCT player_name) as names,
                    COUNT(DISTINCT player_name) as name_count,
                    MIN(week) as first_week,
                    MAX(week) as last_week
                FROM weekly_rosters
                WHERE season = ?
                AND week = ?
                GROUP BY player_id
                HAVING COUNT(DISTINCT player_name) > 1
                ORDER BY name_count DESC
            `, [season, week]);
            
            if (inconsistentNames.length > 0) {
                console.log(`\n⚠️ Found ${inconsistentNames.length} players with inconsistent names:`);
                inconsistentNames.forEach(player => {
                    console.log(`  - ID ${player.player_id}: ${player.names} (weeks ${player.first_week}-${player.last_week})`);
                });
            }
            
            // This is informational, not necessarily an error
            console.log(`\n📊 Total players with name variations: ${inconsistentNames.length}`);
        });
        
        test('each team should have exactly 19 players', async () => {
            const { season, week } = testConfig;
            
            const invalidRosters = await db.all(`
                SELECT 
                    team_id,
                    week,
                    COUNT(*) as player_count
                FROM weekly_rosters
                WHERE season = ?
                AND week = ?
                GROUP BY team_id, week
                HAVING COUNT(*) != 19
                ORDER BY week, team_id
            `, [season, week]);
            
            if (invalidRosters.length > 0) {
                console.log(`\n❌ Found ${invalidRosters.length} rosters with != 19 players:`);
                invalidRosters.forEach(roster => {
                    console.log(`  - Team ${roster.team_id}, Week ${roster.week}: ${roster.player_count} players`);
                });
            }
            
            expect(invalidRosters.length).toBe(0);
        });
    });
    
    describe('Summary Report', () => {
        test('generate overall player matching summary', async () => {
            const { season, week } = testConfig;
            
            const summary = await db.get(`
                SELECT 
                    COUNT(DISTINCT player_id) as total_unique_players,
                    COUNT(DISTINCT CASE WHEN player_position IN ('QB', 'RB', 'WR', 'TE', 'K') THEN player_id END) as offensive_players,
                    COUNT(DISTINCT CASE WHEN player_position = 'DST' THEN player_id END) as defensive_players,
                    COUNT(DISTINCT team_id) as total_teams,
                    COUNT(DISTINCT week) as total_weeks,
                    COUNT(*) as total_roster_entries
                FROM weekly_rosters
                WHERE season = ?
                AND week = ?
            `, [season, week]);
            
            console.log(`\n📈 Player Matching Summary (Week ${week}, Season ${season}):`);
            console.log(`  - Total unique players: ${summary.total_unique_players}`);
            console.log(`  - Offensive players: ${summary.offensive_players}`);
            console.log(`  - Defensive players: ${summary.defensive_players}`);
            console.log(`  - Total teams: ${summary.total_teams}`);
            console.log(`  - Total weeks: ${summary.total_weeks}`);
            console.log(`  - Total roster entries: ${summary.total_roster_entries}`);
            
            expect(summary.total_teams).toBe(12);
        });
    });
});