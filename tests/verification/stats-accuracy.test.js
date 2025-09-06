const Database = require('../../server/database/database');
const fs = require('fs').promises;
const path = require('path');
const StatsFetcher = require('./helpers/stats-fetcher');
const { getTestConfig, getTestDescription, logTestConfig } = require('./helpers/test-config');

describe(`Stats Accuracy Verification (${getTestDescription()})`, () => {
    let db;
    let statsFetcher;
    let testConfig;
    const reportDir = '/tmp/verification-reports';
    const reportFile = path.join(reportDir, 'stats-accuracy-report.csv');
    
    beforeAll(async () => {
        db = new Database();
        statsFetcher = new StatsFetcher(db);
        testConfig = getTestConfig();
        logTestConfig();
        await fs.mkdir(reportDir, { recursive: true });
    });
    
    afterAll(async () => {
        await db.close();
    });
    
    describe('Fantasy Points Calculation Verification', () => {
        test('verify fantasy points match calculated values based on scoring rules', async () => {
            const { season, week } = testConfig;
            
            // Get scoring rules
            const scoringRules = await db.all(`
                SELECT stat_category, points_per_unit
                FROM scoring_rules
                WHERE is_active = 1
            `);
            
            const scoringMap = {};
            scoringRules.forEach(rule => {
                scoringMap[rule.stat_category] = rule.points_per_unit;
            });
            
            // Get player stats for verification
            const playerStats = await db.all(`
                SELECT 
                    ps.*,
                    np.position
                FROM player_stats ps
                JOIN nfl_players np ON ps.player_id = np.player_id
                WHERE ps.season = ?
                AND ps.week = ?
                AND ps.fantasy_points IS NOT NULL
                ORDER BY ps.week DESC, ps.fantasy_points DESC
                LIMIT 100
            `, [season, week]);
            
            const discrepancies = [];
            
            for (const stat of playerStats) {
                let calculatedPoints = 0;
                
                // Passing
                if (stat.passing_yards) calculatedPoints += stat.passing_yards * (scoringMap['passing_yards'] || 0.04);
                if (stat.passing_tds) calculatedPoints += stat.passing_tds * (scoringMap['passing_touchdown'] || 4);
                if (stat.interceptions) calculatedPoints += stat.interceptions * (scoringMap['interception'] || -2);
                
                // Rushing
                if (stat.rushing_yards) calculatedPoints += stat.rushing_yards * (scoringMap['rushing_yards'] || 0.1);
                if (stat.rushing_tds) calculatedPoints += stat.rushing_tds * (scoringMap['rushing_touchdown'] || 6);
                
                // Receiving
                if (stat.receiving_yards) calculatedPoints += stat.receiving_yards * (scoringMap['receiving_yards'] || 0.1);
                if (stat.receiving_tds) calculatedPoints += stat.receiving_tds * (scoringMap['receiving_touchdown'] || 6);
                if (stat.receptions) calculatedPoints += stat.receptions * (scoringMap['reception'] || 0.5);
                
                // Fumbles
                if (stat.fumbles) calculatedPoints += stat.fumbles * (scoringMap['fumble_lost'] || -2);
                
                // 2-point conversions
                if (stat.two_point_conversions_pass) calculatedPoints += stat.two_point_conversions_pass * (scoringMap['two_point_conversion_pass'] || 2);
                if (stat.two_point_conversions_run) calculatedPoints += stat.two_point_conversions_run * (scoringMap['two_point_conversion_run'] || 2);
                if (stat.two_point_conversions_rec) calculatedPoints += stat.two_point_conversions_rec * (scoringMap['two_point_conversion_rec'] || 2);
                
                // Return TDs
                if (stat.return_tds) calculatedPoints += stat.return_tds * (scoringMap['return_touchdown'] || 6);
                
                // Kicker stats
                if (stat.position === 'K') {
                    if (stat.extra_points_made) calculatedPoints += stat.extra_points_made * (scoringMap['extra_point'] || 1);
                    if (stat.field_goals_0_39) calculatedPoints += stat.field_goals_0_39 * (scoringMap['field_goal_0_39'] || 3);
                    if (stat.field_goals_40_49) calculatedPoints += stat.field_goals_40_49 * (scoringMap['field_goal_40_49'] || 4);
                    if (stat.field_goals_50_plus) calculatedPoints += stat.field_goals_50_plus * (scoringMap['field_goal_50_plus'] || 5);
                }
                
                // DST stats
                if (stat.position === 'DST') {
                    if (stat.sacks) calculatedPoints += stat.sacks * (scoringMap['sack'] || 1);
                    if (stat.def_interceptions) calculatedPoints += stat.def_interceptions * (scoringMap['def_interception'] || 2);
                    if (stat.fumbles_recovered) calculatedPoints += stat.fumbles_recovered * (scoringMap['fumble_recovery'] || 2);
                    if (stat.def_touchdowns) calculatedPoints += stat.def_touchdowns * (scoringMap['def_touchdown'] || 6);
                    if (stat.safeties) calculatedPoints += stat.safeties * (scoringMap['safety'] || 2);
                    
                    // Points allowed bonuses
                    if (stat.def_points_allowed_bonus) calculatedPoints += stat.def_points_allowed_bonus;
                    if (stat.def_yards_allowed_bonus) calculatedPoints += stat.def_yards_allowed_bonus;
                }
                
                // Round to 2 decimal places
                calculatedPoints = Math.round(calculatedPoints * 100) / 100;
                const storedPoints = Math.round(stat.fantasy_points * 100) / 100;
                
                const difference = Math.abs(calculatedPoints - storedPoints);
                
                if (difference > 0.1) {
                    discrepancies.push({
                        player_id: stat.player_id,
                        player_name: stat.player_name,
                        week: stat.week,
                        position: stat.position,
                        stored_points: storedPoints,
                        calculated_points: calculatedPoints,
                        difference: difference
                    });
                }
            }
            
            if (discrepancies.length > 0) {
                console.log(`\n❌ Found ${discrepancies.length} fantasy point calculation discrepancies:`);
                
                const csvLines = ['Player ID,Player Name,Week,Position,Stored Points,Calculated Points,Difference'];
                discrepancies.slice(0, 20).forEach(disc => {
                    console.log(`  - Week ${disc.week}: ${disc.player_name} (${disc.position}) - Stored: ${disc.stored_points}, Calculated: ${disc.calculated_points}, Diff: ${disc.difference.toFixed(2)}`);
                    csvLines.push(`${disc.player_id},${disc.player_name},${disc.week},${disc.position},${disc.stored_points},${disc.calculated_points},${disc.difference.toFixed(2)}`);
                });
                
                await fs.writeFile(reportFile, csvLines.join('\n'));
                console.log(`\n📄 Discrepancies report saved to: ${reportFile}`);
            }
            
            expect(discrepancies.length).toBe(0);
        });
    });
    
    describe('Stats Comparison with External Sources', () => {
        test('compare stats with Tank01 API cached data', async () => {
            const { season, week } = testConfig;
            
            // Get a sample of recent stats to verify
            const recentStats = await db.all(`
                SELECT 
                    ps.*,
                    np.position,
                    np.name as player_name_normalized
                FROM player_stats ps
                JOIN nfl_players np ON ps.player_id = np.player_id
                JOIN nfl_games ng ON 
                    ps.week = ng.week 
                    AND ps.season = ng.season
                    AND ng.status = 'Final'
                WHERE ps.season = ?
                AND ps.week = ?
                AND ps.fantasy_points > 0
                ORDER BY ps.week DESC, ps.fantasy_points DESC
                LIMIT 50
            `, [season, week]);
            
            const mismatches = [];
            
            for (const stat of recentStats) {
                // Try to get cached Tank01 data
                const cachedData = await statsFetcher.getCachedStats(stat.player_id, stat.week, season);
                
                if (cachedData) {
                    // Compare key stats
                    const statMismatch = {
                        player_id: stat.player_id,
                        player_name: stat.player_name,
                        week: stat.week,
                        differences: []
                    };
                    
                    // Compare offensive stats
                    if (stat.position !== 'DST' && stat.position !== 'K') {
                        if (Math.abs((stat.passing_yards || 0) - (cachedData.passing_yards || 0)) > 5) {
                            statMismatch.differences.push(`passing_yards: DB=${stat.passing_yards}, API=${cachedData.passing_yards}`);
                        }
                        if ((stat.passing_tds || 0) !== (cachedData.passing_tds || 0)) {
                            statMismatch.differences.push(`passing_tds: DB=${stat.passing_tds}, API=${cachedData.passing_tds}`);
                        }
                        if (Math.abs((stat.rushing_yards || 0) - (cachedData.rushing_yards || 0)) > 2) {
                            statMismatch.differences.push(`rushing_yards: DB=${stat.rushing_yards}, API=${cachedData.rushing_yards}`);
                        }
                        if ((stat.rushing_tds || 0) !== (cachedData.rushing_tds || 0)) {
                            statMismatch.differences.push(`rushing_tds: DB=${stat.rushing_tds}, API=${cachedData.rushing_tds}`);
                        }
                        if (Math.abs((stat.receiving_yards || 0) - (cachedData.receiving_yards || 0)) > 2) {
                            statMismatch.differences.push(`receiving_yards: DB=${stat.receiving_yards}, API=${cachedData.receiving_yards}`);
                        }
                        if ((stat.receiving_tds || 0) !== (cachedData.receiving_tds || 0)) {
                            statMismatch.differences.push(`receiving_tds: DB=${stat.receiving_tds}, API=${cachedData.receiving_tds}`);
                        }
                    }
                    
                    if (statMismatch.differences.length > 0) {
                        mismatches.push(statMismatch);
                    }
                }
            }
            
            if (mismatches.length > 0) {
                console.log(`\n⚠️ Found ${mismatches.length} stats mismatches with Tank01 data:`);
                mismatches.slice(0, 10).forEach(mismatch => {
                    console.log(`  - Week ${mismatch.week}: ${mismatch.player_name}`);
                    mismatch.differences.forEach(diff => {
                        console.log(`      ${diff}`);
                    });
                });
                
                const mismatchFile = path.join(reportDir, 'tank01-mismatches.json');
                await fs.writeFile(mismatchFile, JSON.stringify(mismatches, null, 2));
                console.log(`\n📄 Tank01 mismatches saved to: ${mismatchFile}`);
            }
            
            console.log(`\n📊 Checked ${recentStats.length} player stats against Tank01 cache`);
        });
        
        test('verify DST scoring accuracy', async () => {
            const { season, week } = testConfig;
            
            const dstStats = await db.all(`
                SELECT 
                    ps.*,
                    ng.home_score,
                    ng.away_score,
                    ng.home_team,
                    ng.away_team
                FROM player_stats ps
                JOIN nfl_games ng ON 
                    ps.game_id = ng.game_id
                WHERE ps.season = ?
                AND ps.week = ?
                AND ps.position = 'DST'
                AND ps.fantasy_points IS NOT NULL
                ORDER BY ps.week DESC
            `, [season, week]);
            
            const dstDiscrepancies = [];
            
            for (const dst of dstStats) {
                // Determine opponent score
                const team = dst.team || dst.player_id.replace('DEF_', '');
                const opponentScore = team === ng.home_team ? ng.away_score : ng.home_score;
                
                // Calculate expected points allowed bonus
                let expectedPointsBonus = 0;
                if (opponentScore === 0) expectedPointsBonus = 10;
                else if (opponentScore <= 6) expectedPointsBonus = 7;
                else if (opponentScore <= 13) expectedPointsBonus = 4;
                else if (opponentScore <= 20) expectedPointsBonus = 1;
                else if (opponentScore <= 27) expectedPointsBonus = 0;
                else if (opponentScore <= 34) expectedPointsBonus = -1;
                else expectedPointsBonus = -4;
                
                if (Math.abs((dst.def_points_allowed_bonus || 0) - expectedPointsBonus) > 0.1) {
                    dstDiscrepancies.push({
                        team: team,
                        week: dst.week,
                        opponent_score: opponentScore,
                        stored_bonus: dst.def_points_allowed_bonus || 0,
                        expected_bonus: expectedPointsBonus
                    });
                }
            }
            
            if (dstDiscrepancies.length > 0) {
                console.log(`\n⚠️ Found ${dstDiscrepancies.length} DST scoring discrepancies:`);
                dstDiscrepancies.forEach(disc => {
                    console.log(`  - Week ${disc.week}: ${disc.team} - Opponent scored ${disc.opponent_score}, Bonus: ${disc.stored_bonus} (expected ${disc.expected_bonus})`);
                });
            }
            
            expect(dstDiscrepancies.length).toBe(0);
        });
    });
    
    describe('Historical Stats Consistency', () => {
        test('verify stats remain consistent over time', async () => {
            const { season, week } = testConfig;
            
            // Check if any stats have been modified after initial creation
            const modifiedStats = await db.all(`
                SELECT 
                    player_id,
                    player_name,
                    week,
                    created_at,
                    last_updated,
                    fantasy_points
                FROM player_stats
                WHERE season = ?
                AND week = ?
                AND created_at IS NOT NULL
                AND last_updated IS NOT NULL
                AND datetime(last_updated) > datetime(created_at, '+1 hour')
                ORDER BY week DESC, last_updated DESC
                LIMIT 20
            `, [season, week]);
            
            if (modifiedStats.length > 0) {
                console.log(`\n📝 Found ${modifiedStats.length} stats modified after creation:`);
                modifiedStats.forEach(stat => {
                    const created = new Date(stat.created_at).toLocaleString();
                    const updated = new Date(stat.last_updated).toLocaleString();
                    console.log(`  - Week ${stat.week}: ${stat.player_name} - Created: ${created}, Updated: ${updated}`);
                });
                
                // This is informational - modifications might be legitimate corrections
                console.log('\n  Note: Modifications might be legitimate corrections or updates');
            }
        });
    });
    
    describe('Stats Accuracy Summary', () => {
        test('generate overall accuracy report', async () => {
            const { season, week } = testConfig;
            
            const summary = await db.get(`
                SELECT 
                    COUNT(*) as total_stats,
                    COUNT(CASE WHEN fantasy_points > 0 THEN 1 END) as stats_with_points,
                    AVG(fantasy_points) as avg_fantasy_points,
                    MAX(fantasy_points) as max_fantasy_points,
                    COUNT(DISTINCT player_id) as unique_players,
                    COUNT(DISTINCT week) as weeks_with_stats
                FROM player_stats
                WHERE season = ?
                AND week = ?
            `, [season, week]);
            
            const positionBreakdown = await db.all(`
                SELECT 
                    ps.position,
                    COUNT(*) as count,
                    AVG(ps.fantasy_points) as avg_points,
                    MAX(ps.fantasy_points) as max_points
                FROM player_stats ps
                WHERE ps.season = ?
                AND ps.week = ?
                AND ps.fantasy_points > 0
                GROUP BY ps.position
                ORDER BY avg_points DESC
            `, [season, week]);
            
            console.log(`\n📈 Stats Accuracy Summary (Week ${week}, Season ${season}):`);
            console.log(`  - Total stat records: ${summary.total_stats}`);
            console.log(`  - Records with points > 0: ${summary.stats_with_points}`);
            console.log(`  - Average fantasy points: ${summary.avg_fantasy_points?.toFixed(2) || 'N/A'}`);
            console.log(`  - Max fantasy points: ${summary.max_fantasy_points?.toFixed(2) || 'N/A'}`);
            console.log(`  - Unique players: ${summary.unique_players}`);
            console.log(`  - Weeks with stats: ${summary.weeks_with_stats}`);
            
            console.log('\n📊 Points by Position:');
            console.log('Position | Count | Avg Points | Max Points');
            console.log('---------|-------|------------|------------');
            positionBreakdown.forEach(pos => {
                console.log(`${pos.position.padEnd(8)} | ${String(pos.count).padEnd(5)} | ${pos.avg_points.toFixed(2).padEnd(10)} | ${pos.max_points.toFixed(2)}`);
            });
            
            // Save summary to JSON
            const accuracySummary = {
                season: season,
                week: week,
                overall: summary,
                by_position: positionBreakdown,
                generated_at: new Date().toISOString()
            };
            
            const summaryFile = path.join(reportDir, 'stats-accuracy-summary.json');
            await fs.writeFile(summaryFile, JSON.stringify(accuracySummary, null, 2));
            console.log(`\n📄 Accuracy summary saved to: ${summaryFile}`);
        });
    });
});