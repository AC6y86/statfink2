const Database = require('../../server/database/database');
const fs = require('fs').promises;
const path = require('path');
const StatsFetcher = require('./helpers/stats-fetcher');
const { getTestConfig, getTestDescription, logTestConfig, initTestConfig } = require('./helpers/test-config');

describe(`Data Reconciliation (${getTestDescription()})`, () => {
    let db;
    let statsFetcher;
    let testConfig;
    const reportDir = '/tmp/verification-reports';
    
    beforeAll(async () => {
        db = new Database();
        statsFetcher = new StatsFetcher(db);
        await initTestConfig(); // Initialize config from database
        testConfig = getTestConfig();
        await logTestConfig();
        await fs.mkdir(reportDir, { recursive: true });
    });
    
    afterAll(async () => {
        await db.close();
    });
    
    describe('Player ID Reconciliation', () => {
        test('identify and map mismatched player IDs', async () => {
            const { season, week } = testConfig;
            
            // Find players with potential ID mismatches
            const mismatchedPlayers = await db.all(`
                SELECT DISTINCT
                    wr.player_id as roster_id,
                    wr.player_name as roster_name,
                    wr.player_position as position,
                    wr.player_team as team,
                    ps.player_id as stats_id,
                    ps.player_name as stats_name,
                    np.player_id as master_id,
                    np.name as master_name
                FROM weekly_rosters wr
                LEFT JOIN player_stats ps ON 
                    wr.week = ps.week 
                    AND wr.season = ps.season
                    AND LOWER(REPLACE(wr.player_name, ' ', '')) = LOWER(REPLACE(ps.player_name, ' ', ''))
                    AND wr.player_id != ps.player_id
                LEFT JOIN nfl_players np ON 
                    LOWER(REPLACE(np.name, ' ', '')) = LOWER(REPLACE(wr.player_name, ' ', ''))
                WHERE wr.season = ?
                AND wr.week = ?
                AND (ps.player_id IS NOT NULL OR np.player_id IS NOT NULL)
                AND wr.player_id != COALESCE(ps.player_id, np.player_id)
                ORDER BY wr.player_name
                LIMIT 50
            `, [season, week]);
            
            if (mismatchedPlayers.length > 0) {
                console.log(`\n🔄 Found ${mismatchedPlayers.length} potential ID mismatches:`);
                
                const mappings = [];
                const csvLines = ['Current ID,Player Name,Position,Team,Suggested ID,Source'];
                
                for (const player of mismatchedPlayers.slice(0, 20)) {
                    const suggestedId = player.master_id || player.stats_id;
                    const source = player.master_id ? 'nfl_players' : 'player_stats';
                    
                    console.log(`  - ${player.roster_name} (${player.position}):`);
                    console.log(`      Current: ${player.roster_id}`);
                    console.log(`      Suggested: ${suggestedId} (from ${source})`);
                    
                    mappings.push({
                        current_id: player.roster_id,
                        player_name: player.roster_name,
                        position: player.position,
                        team: player.team,
                        suggested_id: suggestedId,
                        source: source
                    });
                    
                    csvLines.push(`${player.roster_id},${player.roster_name},${player.position},${player.team},${suggestedId},${source}`);
                }
                
                // Generate SQL update statements
                const updateStatements = mappings.map(m => 
                    `UPDATE weekly_rosters SET player_id = '${m.suggested_id}' WHERE player_id = '${m.current_id}' AND season = ${season} AND week = ${week}; -- ${m.player_name}`
                );
                
                const sqlFile = path.join(reportDir, 'id-reconciliation.sql');
                await fs.writeFile(sqlFile, updateStatements.join('\n'));
                console.log(`\n📄 SQL reconciliation statements saved to: ${sqlFile}`);
                
                const csvFile = path.join(reportDir, 'id-mappings.csv');
                await fs.writeFile(csvFile, csvLines.join('\n'));
                console.log(`📄 ID mappings CSV saved to: ${csvFile}`);
            }
            
            // This is informational - not necessarily a failure
            console.log(`\n📊 Total potential ID mismatches found: ${mismatchedPlayers.length}`);
        });
        
        test('find players with similar names but different IDs', async () => {
            const { season, week } = testConfig;
            
            const similarPlayers = await db.all(`
                SELECT DISTINCT
                    wr1.player_id as id1,
                    wr1.player_name as name1,
                    wr2.player_id as id2,
                    wr2.player_name as name2,
                    wr1.player_position as position
                FROM weekly_rosters wr1
                JOIN weekly_rosters wr2 ON 
                    wr1.season = wr2.season
                    AND wr1.player_position = wr2.player_position
                    AND wr1.player_id < wr2.player_id
                    AND (
                        LOWER(SUBSTR(wr1.player_name, 1, 5)) = LOWER(SUBSTR(wr2.player_name, 1, 5))
                        OR LOWER(SUBSTR(wr1.player_name, -5)) = LOWER(SUBSTR(wr2.player_name, -5))
                    )
                WHERE wr1.season = ?
                AND wr1.week = ?
                AND LENGTH(wr1.player_name) > 5
                AND LENGTH(wr2.player_name) > 5
                AND ABS(LENGTH(wr1.player_name) - LENGTH(wr2.player_name)) <= 3
                ORDER BY wr1.player_name
                LIMIT 30
            `, [season, week]);
            
            if (similarPlayers.length > 0) {
                console.log(`\n👥 Found ${similarPlayers.length} potential duplicate players:`);
                similarPlayers.forEach(pair => {
                    console.log(`  - "${pair.name1}" (${pair.id1}) vs "${pair.name2}" (${pair.id2}) - ${pair.position}`);
                });
                
                const duplicatesFile = path.join(reportDir, 'potential-duplicates.json');
                await fs.writeFile(duplicatesFile, JSON.stringify(similarPlayers, null, 2));
                console.log(`\n📄 Potential duplicates saved to: ${duplicatesFile}`);
            }
        });
    });
    
    describe('Cross-Source Data Verification', () => {
        test('compare roster data with Tank01 player database', async () => {
            const { season, week } = testConfig;
            
            // Get unique players from rosters
            const rosterPlayers = await db.all(`
                SELECT DISTINCT
                    player_id,
                    player_name,
                    player_position as position,
                    player_team as team
                FROM weekly_rosters
                WHERE season = ?
                AND week = ?
                AND player_position != 'DST'
                ORDER BY player_name
                LIMIT 100
            `, [season, week]);
            
            const unmatchedInTank01 = [];
            
            for (const player of rosterPlayers) {
                // Check if player exists in Tank01 cache
                const tank01Player = await db.get(`
                    SELECT cache_key as player_id, cache_key as player_name
                    FROM tank01_cache
                    WHERE cache_key LIKE ?
                    OR cache_key LIKE ?
                    LIMIT 1
                `, [`%${player.player_id}%`, `%${player.player_name}%`]);
                
                if (!tank01Player) {
                    // Also check nfl_players table
                    const nflPlayer = await db.get(`
                        SELECT player_id, name
                        FROM nfl_players
                        WHERE player_id = ?
                    `, [player.player_id]);
                    
                    if (!nflPlayer) {
                        unmatchedInTank01.push(player);
                    }
                }
            }
            
            if (unmatchedInTank01.length > 0) {
                console.log(`\n⚠️ Found ${unmatchedInTank01.length} roster players not in Tank01/NFL database:`);
                unmatchedInTank01.slice(0, 15).forEach(player => {
                    console.log(`  - ${player.player_name} (${player.position}, ${player.team}) - ID: ${player.player_id}`);
                });
            }
            
            console.log(`\n📊 Checked ${rosterPlayers.length} unique roster players`);
        });
        
        test('validate team abbreviations consistency', async () => {
            const { season, week } = testConfig;
            
            // Get all unique team abbreviations
            const teams = await db.all(`
                SELECT DISTINCT source, team
                FROM (
                    SELECT 'weekly_rosters' as source, player_team as team FROM weekly_rosters WHERE season = ? AND week = ? AND player_team IS NOT NULL
                    UNION ALL
                    SELECT 'nfl_games_home' as source, home_team as team FROM nfl_games WHERE season = ? AND week = ? AND home_team IS NOT NULL
                    UNION ALL
                    SELECT 'nfl_games_away' as source, away_team as team FROM nfl_games WHERE season = ? AND week = ? AND away_team IS NOT NULL
                    UNION ALL
                    SELECT 'nfl_players' as source, team FROM nfl_players WHERE team IS NOT NULL
                    UNION ALL
                    SELECT 'player_stats' as source, team FROM player_stats WHERE season = ? AND week = ? AND team IS NOT NULL
                )
                WHERE team != ''
                ORDER BY team, source
            `, [season, week, season, week, season, week, season, week]);
            
            // Group by team to find inconsistencies
            const teamMap = {};
            teams.forEach(row => {
                if (!teamMap[row.team]) teamMap[row.team] = new Set();
                teamMap[row.team].add(row.source);
            });
            
            console.log('\n🏈 Team Abbreviation Analysis:');
            const inconsistencies = [];
            
            Object.keys(teamMap).sort().forEach(team => {
                const sources = Array.from(teamMap[team]);
                console.log(`  ${team}: ${sources.join(', ')}`);
                
                // Check for potential issues (e.g., LAR vs LA)
                if (team === 'LA' || team === 'LAR') {
                    inconsistencies.push(`Rams inconsistency: ${team} used in ${sources.join(', ')}`);
                }
                if (team === 'WSH' || team === 'WAS') {
                    inconsistencies.push(`Washington inconsistency: ${team} used in ${sources.join(', ')}`);
                }
            });
            
            if (inconsistencies.length > 0) {
                console.log('\n⚠️ Team abbreviation inconsistencies:');
                inconsistencies.forEach(issue => console.log(`  - ${issue}`));
            }
        });
    });
    
    describe('Data Quality Metrics', () => {
        test('calculate overall data quality score', async () => {
            const { season, week } = testConfig;
            
            // Calculate various quality metrics
            const metrics = {};
            
            // 1. Player ID consistency
            const idConsistency = await db.get(`
                SELECT 
                    COUNT(DISTINCT CASE WHEN player_id GLOB '[0-9]*' THEN player_id END) as numeric_ids,
                    COUNT(DISTINCT CASE WHEN player_id LIKE 'DEF_%' THEN player_id END) as def_ids,
                    COUNT(DISTINCT CASE WHEN player_id NOT GLOB '[0-9]*' AND player_id NOT LIKE 'DEF_%' THEN player_id END) as legacy_ids,
                    COUNT(DISTINCT player_id) as total_ids
                FROM weekly_rosters
                WHERE season = ?
                AND week = ?
            `, [season, week]);
            
            metrics.id_consistency_score = ((idConsistency.numeric_ids + idConsistency.def_ids) / idConsistency.total_ids * 100).toFixed(2);
            
            // 2. Stats completeness
            const statsCompleteness = await db.get(`
                SELECT 
                    COUNT(DISTINCT wr.player_id || '-' || wr.week) as total_player_weeks,
                    COUNT(DISTINCT ps.player_id || '-' || ps.week) as player_weeks_with_stats
                FROM weekly_rosters wr
                LEFT JOIN player_stats ps ON 
                    wr.player_id = ps.player_id 
                    AND wr.week = ps.week 
                    AND wr.season = ps.season
                JOIN nfl_games ng ON 
                    wr.week = ng.week 
                    AND wr.season = ng.season
                    AND ng.status = 'Final'
                    AND (ng.home_team = wr.player_team OR ng.away_team = wr.player_team)
                WHERE wr.season = ?
                AND wr.week = ?
                AND wr.roster_position = 'active'
            `, [season, week]);
            
            metrics.stats_completeness_score = (statsCompleteness.player_weeks_with_stats / statsCompleteness.total_player_weeks * 100).toFixed(2);
            
            // 3. Name consistency
            const nameConsistency = await db.get(`
                SELECT 
                    COUNT(DISTINCT player_id) as total_players,
                    COUNT(DISTINCT CASE 
                        WHEN player_id IN (
                            SELECT player_id 
                            FROM weekly_rosters 
                            WHERE season = ?
                            AND week = ?
                            GROUP BY player_id 
                            HAVING COUNT(DISTINCT player_name) > 1
                        ) THEN player_id 
                    END) as players_with_multiple_names
                FROM weekly_rosters
                WHERE season = ?
                AND week = ?
            `, [season, week, season, week]);
            
            metrics.name_consistency_score = ((nameConsistency.total_players - nameConsistency.players_with_multiple_names) / nameConsistency.total_players * 100).toFixed(2);
            
            // 4. Roster completeness (19 players per team per week)
            const rosterCompleteness = await db.get(`
                SELECT 
                    COUNT(*) as total_team_weeks,
                    COUNT(CASE WHEN player_count = 19 THEN 1 END) as complete_rosters
                FROM (
                    SELECT team_id, week, COUNT(*) as player_count
                    FROM weekly_rosters
                    WHERE season = ?
                    AND week = ?
                    GROUP BY team_id, week
                )
            `, [season, week]);
            
            metrics.roster_completeness_score = (rosterCompleteness.complete_rosters / rosterCompleteness.total_team_weeks * 100).toFixed(2);
            
            // Calculate overall quality score
            metrics.overall_quality_score = (
                (parseFloat(metrics.id_consistency_score) +
                 parseFloat(metrics.stats_completeness_score) +
                 parseFloat(metrics.name_consistency_score) +
                 parseFloat(metrics.roster_completeness_score)) / 4
            ).toFixed(2);
            
            console.log('\n📊 Data Quality Metrics:');
            console.log(`  - ID Consistency: ${metrics.id_consistency_score}%`);
            console.log(`    (${idConsistency.numeric_ids} numeric, ${idConsistency.def_ids} DEF, ${idConsistency.legacy_ids} legacy)`);
            console.log(`  - Stats Completeness: ${metrics.stats_completeness_score}%`);
            console.log(`  - Name Consistency: ${metrics.name_consistency_score}%`);
            console.log(`  - Roster Completeness: ${metrics.roster_completeness_score}%`);
            console.log(`\n  🎯 Overall Quality Score: ${metrics.overall_quality_score}%`);
            
            // Save metrics to file
            const metricsFile = path.join(reportDir, 'data-quality-metrics.json');
            await fs.writeFile(metricsFile, JSON.stringify({
                season: season,
                metrics: metrics,
                details: {
                    id_breakdown: idConsistency,
                    stats_coverage: statsCompleteness,
                    name_consistency: nameConsistency,
                    roster_completeness: rosterCompleteness
                },
                generated_at: new Date().toISOString()
            }, null, 2));
            console.log(`\n📄 Quality metrics saved to: ${metricsFile}`);
            
            // Expect high quality scores
            expect(parseFloat(metrics.overall_quality_score)).toBeGreaterThan(80);
        });
    });
    
    describe('Reconciliation Summary', () => {
        test('generate comprehensive reconciliation report', async () => {
            const { season, week } = testConfig;
            
            const summary = {
                season: season,
                week: week,
                generated_at: new Date().toISOString(),
                issues_found: {
                    mismatched_ids: 0,
                    missing_in_master: 0,
                    duplicate_players: 0,
                    name_variations: 0
                },
                recommendations: []
            };
            
            // Count mismatched IDs
            const mismatchedIds = await db.get(`
                SELECT COUNT(DISTINCT wr.player_id) as count
                FROM weekly_rosters wr
                LEFT JOIN nfl_players np ON wr.player_id = np.player_id
                WHERE wr.season = ?
                AND wr.week = ?
                AND np.player_id IS NULL
            `, [season, week]);
            summary.issues_found.missing_in_master = mismatchedIds.count;
            
            // Count potential duplicates
            const duplicates = await db.get(`
                SELECT COUNT(*) as count
                FROM (
                    SELECT player_id
                    FROM weekly_rosters
                    WHERE season = ?
                    AND week = ?
                    GROUP BY player_id
                    HAVING COUNT(DISTINCT player_name) > 1
                )
            `, [season, week]);
            summary.issues_found.name_variations = duplicates.count;
            
            // Generate recommendations
            if (summary.issues_found.missing_in_master > 0) {
                summary.recommendations.push('Run ID reconciliation to map roster players to master database');
            }
            if (summary.issues_found.name_variations > 0) {
                summary.recommendations.push('Standardize player names across all weeks');
            }
            
            console.log(`\n📋 Data Reconciliation Summary (Week ${week}, Season ${season}):`);
            console.log(`  Season: ${summary.season}`);
            console.log('\n  Issues Found:');
            Object.entries(summary.issues_found).forEach(([key, value]) => {
                if (value > 0) {
                    console.log(`    - ${key.replace(/_/g, ' ')}: ${value}`);
                }
            });
            
            if (summary.recommendations.length > 0) {
                console.log('\n  Recommendations:');
                summary.recommendations.forEach(rec => {
                    console.log(`    • ${rec}`);
                });
            }
            
            const summaryFile = path.join(reportDir, 'reconciliation-summary.json');
            await fs.writeFile(summaryFile, JSON.stringify(summary, null, 2));
            console.log(`\n📄 Reconciliation summary saved to: ${summaryFile}`);
        });
    });
});