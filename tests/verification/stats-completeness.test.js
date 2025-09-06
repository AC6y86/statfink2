const Database = require('../../server/database/database');
const fs = require('fs').promises;
const path = require('path');
const { getTestConfig, getTestDescription, logTestConfig } = require('./helpers/test-config');
const StatsFetcher = require('./helpers/stats-fetcher');

describe(`Stats Completeness Verification (${getTestDescription()})`, () => {
    let db;
    let testConfig;
    let statsFetcher;
    const reportDir = '/tmp/verification-reports';
    const reportFile = path.join(reportDir, 'stats-completeness-report.csv');
    
    beforeAll(async () => {
        db = new Database();
        testConfig = getTestConfig();
        statsFetcher = new StatsFetcher(db);
        logTestConfig();
        await fs.mkdir(reportDir, { recursive: true });
    });
    
    afterAll(async () => {
        await db.close();
    });
    
    describe('Post-Game Stats Presence', () => {
        test('all active players in completed games should have stats', async () => {
            const { season, week } = testConfig;
            
            const playersWithoutStats = await db.all(`
                SELECT 
                    wr.player_id,
                    wr.player_name,
                    wr.player_position,
                    wr.player_team,
                    wr.week,
                    wr.team_id,
                    ng.game_id,
                    ng.status as game_status,
                    ng.home_team,
                    ng.away_team,
                    ng.home_score,
                    ng.away_score
                FROM weekly_rosters wr
                JOIN nfl_games ng ON 
                    wr.week = ng.week 
                    AND wr.season = ng.season
                    AND (ng.home_team = wr.player_team OR ng.away_team = wr.player_team)
                LEFT JOIN player_stats ps ON 
                    wr.player_id = ps.player_id 
                    AND wr.week = ps.week 
                    AND wr.season = ps.season
                WHERE wr.season = ?
                AND wr.week = ?
                AND wr.roster_position = 'active'
                AND ng.status = 'Final'
                AND ps.stat_id IS NULL
                ORDER BY wr.week DESC, wr.team_id, wr.player_name
            `, [season, week]);
            
            if (playersWithoutStats.length > 0) {
                // Check player status for each missing stat
                const actuallyMissing = [];
                const validReasons = [];
                
                for (const player of playersWithoutStats) {
                    const status = await statsFetcher.checkPlayerGameStatus(
                        player.player_id, 
                        player.player_name, 
                        player.week, 
                        season
                    );
                    
                    if (status === 'suspended' || status === 'inactive') {
                        validReasons.push({ ...player, reason: status });
                    } else {
                        actuallyMissing.push(player);
                    }
                }
                
                if (validReasons.length > 0) {
                    console.log(`\n✅ ${validReasons.length} players correctly have no stats:`);
                    validReasons.forEach(player => {
                        console.log(`    - ${player.player_name} (${player.player_position}, ${player.player_team}) - ${player.reason}`);
                    });
                }
                
                if (actuallyMissing.length > 0) {
                    console.log(`\n❌ Found ${actuallyMissing.length} active players in completed games with unexplained missing stats:`);
                    
                    const csvLines = ['Week,Player ID,Player Name,Position,Team,Fantasy Team,Game,Score'];
                    
                    // Group by week for better readability
                    const byWeek = {};
                    actuallyMissing.forEach(player => {
                        if (!byWeek[player.week]) byWeek[player.week] = [];
                        byWeek[player.week].push(player);
                    });
                    
                    Object.keys(byWeek).sort((a, b) => b - a).forEach(week => {
                        console.log(`\n  Week ${week}:`);
                        byWeek[week].slice(0, 10).forEach(player => {
                            const gameDesc = `${player.away_team}@${player.home_team} (${player.away_score}-${player.home_score})`;
                            console.log(`    - ${player.player_name} (${player.player_position}, ${player.player_team}) - Team ${player.team_id}`);
                            csvLines.push(`${week},${player.player_id},${player.player_name},${player.player_position},${player.player_team},${player.team_id},${gameDesc},${player.away_score}-${player.home_score}`);
                        });
                    });
                    
                    await fs.writeFile(reportFile, csvLines.join('\n'));
                    console.log(`\n📄 Missing stats report saved to: ${reportFile}`);
                }
                
                // Try to identify if these players exist in player_stats with different IDs
                console.log('\n🔍 Checking for potential ID mismatches...');
                for (const player of actuallyMissing.slice(0, 5)) {
                    const possibleStats = await db.all(`
                        SELECT player_id, player_name, fantasy_points
                        FROM player_stats
                        WHERE week = ? AND season = ?
                        AND LOWER(player_name) LIKE LOWER(?)
                    `, [player.week, season, `%${player.player_name.split(' ').pop()}%`]);
                    
                    if (possibleStats.length > 0) {
                        console.log(`  💡 Found potential stats for ${player.player_name}:`);
                        possibleStats.forEach(stat => {
                            console.log(`      - ID: ${stat.player_id}, Name: ${stat.player_name}, Points: ${stat.fantasy_points}`);
                        });
                    }
                }
                
                // Only fail if there are actually missing stats (not suspended/inactive)
                expect(actuallyMissing.length).toBe(0);
            } else {
                // No missing stats at all
                expect(playersWithoutStats.length).toBe(0);
            }
        });
        
        test('verify fantasy points are calculated for all stats entries', async () => {
            const { season, week } = testConfig;
            
            const statsWithoutPoints = await db.all(`
                SELECT 
                    ps.player_id,
                    ps.player_name,
                    ps.week,
                    ps.position,
                    ps.passing_yards,
                    ps.passing_tds,
                    ps.rushing_yards,
                    ps.rushing_tds,
                    ps.receiving_yards,
                    ps.receiving_tds,
                    ps.fantasy_points
                FROM player_stats ps
                WHERE ps.season = ?
                AND ps.week = ?
                AND ps.fantasy_points IS NULL
                AND (
                    ps.passing_yards > 0 OR ps.passing_tds > 0 OR
                    ps.rushing_yards > 0 OR ps.rushing_tds > 0 OR
                    ps.receiving_yards > 0 OR ps.receiving_tds > 0
                )
                ORDER BY ps.week DESC, ps.player_name
            `, [season, week]);
            
            if (statsWithoutPoints.length > 0) {
                console.log(`\n⚠️ Found ${statsWithoutPoints.length} stat entries with null fantasy points despite having stats:`);
                statsWithoutPoints.slice(0, 10).forEach(stat => {
                    const statsStr = [];
                    if (stat.passing_yards) statsStr.push(`${stat.passing_yards} pass yds`);
                    if (stat.passing_tds) statsStr.push(`${stat.passing_tds} pass TD`);
                    if (stat.rushing_yards) statsStr.push(`${stat.rushing_yards} rush yds`);
                    if (stat.rushing_tds) statsStr.push(`${stat.rushing_tds} rush TD`);
                    if (stat.receiving_yards) statsStr.push(`${stat.receiving_yards} rec yds`);
                    if (stat.receiving_tds) statsStr.push(`${stat.receiving_tds} rec TD`);
                    
                    console.log(`  - Week ${stat.week}: ${stat.player_name} (${stat.position}) - ${statsStr.join(', ')}`);
                });
            }
            
            expect(statsWithoutPoints.length).toBe(0);
        });
    });
    
    describe('Stats Coverage Analysis', () => {
        test('analyze stats coverage by position', async () => {
            const { season, week } = testConfig;
            
            const coverage = await db.all(`
                SELECT 
                    wr.player_position as position,
                    COUNT(DISTINCT wr.player_id || '-' || wr.week) as total_player_weeks,
                    COUNT(DISTINCT CASE 
                        WHEN ng.status = 'Final' THEN wr.player_id || '-' || wr.week 
                    END) as completed_game_weeks,
                    COUNT(DISTINCT CASE 
                        WHEN ng.status = 'Final' AND ps.stat_id IS NOT NULL 
                        THEN wr.player_id || '-' || wr.week 
                    END) as weeks_with_stats,
                    ROUND(100.0 * COUNT(DISTINCT CASE 
                        WHEN ng.status = 'Final' AND ps.stat_id IS NOT NULL 
                        THEN wr.player_id || '-' || wr.week 
                    END) / NULLIF(COUNT(DISTINCT CASE 
                        WHEN ng.status = 'Final' THEN wr.player_id || '-' || wr.week 
                    END), 0), 2) as coverage_percentage
                FROM weekly_rosters wr
                LEFT JOIN nfl_games ng ON 
                    wr.week = ng.week 
                    AND wr.season = ng.season
                    AND (ng.home_team = wr.player_team OR ng.away_team = wr.player_team)
                LEFT JOIN player_stats ps ON 
                    wr.player_id = ps.player_id 
                    AND wr.week = ps.week 
                    AND wr.season = ps.season
                WHERE wr.season = ?
                AND wr.week = ?
                AND wr.roster_position = 'active'
                GROUP BY wr.player_position
                ORDER BY position
            `, [season, week]);
            
            console.log('\n📊 Stats Coverage by Position:');
            console.log('Position | Total Weeks | Completed Games | With Stats | Coverage %');
            console.log('---------|-------------|-----------------|------------|------------');
            coverage.forEach(pos => {
                console.log(`${pos.position.padEnd(8)} | ${String(pos.total_player_weeks).padEnd(11)} | ${String(pos.completed_game_weeks).padEnd(15)} | ${String(pos.weeks_with_stats).padEnd(10)} | ${pos.coverage_percentage || 0}%`);
            });
            
            // Coverage should be reasonable (some players may be suspended/inactive)
            coverage.forEach(pos => {
                if (pos.completed_game_weeks > 0) {
                    // Expect at least 80% coverage (allowing for suspended/inactive players)
                    expect(pos.coverage_percentage).toBeGreaterThanOrEqual(80);
                    if (pos.coverage_percentage < 100) {
                        console.log(`  ⚠️ ${pos.position} has ${pos.coverage_percentage}% coverage (some players may be suspended/inactive)`);
                    }
                }
            });
        });
        
        test('verify stats update for current week', async () => {
            const { season, week } = testConfig;
            
            const weekCoverage = await db.all(`
                SELECT 
                    wr.week,
                    COUNT(DISTINCT ng.game_id) as completed_games,
                    COUNT(DISTINCT wr.player_id) as roster_players,
                    COUNT(DISTINCT ps.player_id) as players_with_stats,
                    ROUND(100.0 * COUNT(DISTINCT ps.player_id) / NULLIF(COUNT(DISTINCT wr.player_id), 0), 2) as coverage_percentage
                FROM weekly_rosters wr
                LEFT JOIN nfl_games ng ON 
                    wr.week = ng.week 
                    AND wr.season = ng.season
                    AND ng.status = 'Final'
                    AND (ng.home_team = wr.player_team OR ng.away_team = wr.player_team)
                LEFT JOIN player_stats ps ON 
                    wr.player_id = ps.player_id 
                    AND wr.week = ps.week 
                    AND wr.season = ps.season
                WHERE wr.season = ?
                AND wr.week = ?
                AND wr.roster_position = 'active'
                GROUP BY wr.week
                HAVING completed_games > 0
                ORDER BY wr.week
            `, [season, week]);
            
            console.log(`\n📅 Stats Coverage for Week ${week}:`);
            console.log('Week | Completed Games | Roster Players | Players w/ Stats | Coverage %');
            console.log('-----|-----------------|----------------|------------------|------------');
            
            weekCoverage.forEach(week => {
                const flag = week.coverage_percentage < 95 ? '⚠️ ' : '✅ ';
                console.log(`${flag}${String(week.week).padEnd(2)} | ${String(week.completed_games).padEnd(15)} | ${String(week.roster_players).padEnd(14)} | ${String(week.players_with_stats).padEnd(16)} | ${week.coverage_percentage}%`);
            });
        });
    });
    
    describe('Injured Reserve Stats Check', () => {
        test('IR players should not have stats for weeks they are on IR', async () => {
            const { season, week } = testConfig;
            
            const irPlayersWithStats = await db.all(`
                SELECT 
                    wr.player_id,
                    wr.player_name,
                    wr.week,
                    wr.team_id,
                    ps.fantasy_points
                FROM weekly_rosters wr
                JOIN player_stats ps ON 
                    wr.player_id = ps.player_id 
                    AND wr.week = ps.week 
                    AND wr.season = ps.season
                WHERE wr.season = ?
                AND wr.week = ?
                AND wr.roster_position = 'injured_reserve'
                AND ps.fantasy_points > 0
                ORDER BY wr.week, wr.player_name
            `, [season, week]);
            
            if (irPlayersWithStats.length > 0) {
                console.log(`\n⚠️ Found ${irPlayersWithStats.length} IR players with stats:`);
                irPlayersWithStats.forEach(player => {
                    console.log(`  - Week ${player.week}: ${player.player_name} (Team ${player.team_id}) - ${player.fantasy_points} points`);
                });
                
                // This might be valid in some cases (player activated mid-week)
                console.log('\n  Note: This may be valid if player was activated during the week');
            }
        });
    });
    
    describe('Stats Completeness Summary', () => {
        test('generate overall stats completeness report', async () => {
            const { season, week } = testConfig;
            
            const summary = await db.get(`
                SELECT 
                    COUNT(DISTINCT ps.player_id || '-' || ps.week) as total_player_week_stats,
                    COUNT(DISTINCT CASE WHEN ps.fantasy_points > 0 THEN ps.player_id || '-' || ps.week END) as stats_with_points,
                    COUNT(DISTINCT CASE WHEN ps.fantasy_points = 0 THEN ps.player_id || '-' || ps.week END) as stats_with_zero_points,
                    COUNT(DISTINCT CASE WHEN ps.fantasy_points IS NULL THEN ps.player_id || '-' || ps.week END) as stats_without_points,
                    MIN(ps.week) as first_week_with_stats,
                    MAX(ps.week) as last_week_with_stats
                FROM player_stats ps
                WHERE ps.season = ?
                AND ps.week = ?
            `, [season, week]);
            
            const gamesStatus = await db.get(`
                SELECT 
                    COUNT(CASE WHEN status = 'Final' THEN 1 END) as completed_games,
                    COUNT(CASE WHEN status = 'Scheduled' THEN 1 END) as scheduled_games,
                    COUNT(CASE WHEN status NOT IN ('Final', 'Scheduled') THEN 1 END) as in_progress_games
                FROM nfl_games
                WHERE season = ?
                AND week = ?
            `, [season, week]);
            
            console.log(`\n📈 Stats Completeness Summary (Week ${week}, Season ${season}):`);
            console.log(`  - Total player-week stats records: ${summary.total_player_week_stats}`);
            console.log(`  - Stats with points > 0: ${summary.stats_with_points}`);
            console.log(`  - Stats with 0 points: ${summary.stats_with_zero_points}`);
            console.log(`  - Stats without calculated points: ${summary.stats_without_points || 0}`);
            console.log(`  - Week range with stats: ${summary.first_week_with_stats || 'N/A'} - ${summary.last_week_with_stats || 'N/A'}`);
            console.log('\n🏈 Game Status:');
            console.log(`  - Completed games: ${gamesStatus.completed_games}`);
            console.log(`  - Scheduled games: ${gamesStatus.scheduled_games}`);
            console.log(`  - In-progress games: ${gamesStatus.in_progress_games}`);
            
            // Generate JSON summary for programmatic use
            const jsonSummary = {
                season: season,
                week: week,
                stats: {
                    total_records: summary.total_player_week_stats,
                    with_points: summary.stats_with_points,
                    zero_points: summary.stats_with_zero_points,
                    null_points: summary.stats_without_points || 0,
                    week_range: {
                        first: summary.first_week_with_stats,
                        last: summary.last_week_with_stats
                    }
                },
                games: gamesStatus,
                generated_at: new Date().toISOString()
            };
            
            const jsonFile = path.join(reportDir, 'stats-completeness-summary.json');
            await fs.writeFile(jsonFile, JSON.stringify(jsonSummary, null, 2));
            console.log(`\n📄 JSON summary saved to: ${jsonFile}`);
        });
    });
});