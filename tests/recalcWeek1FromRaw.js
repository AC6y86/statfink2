require('dotenv').config();
const DatabaseManager = require('../server/database/database');
const ScoringService = require('../server/services/scoringService');

async function recalculateWeek1FromRaw() {
    const db = new DatabaseManager();
    const scoringService = new ScoringService(db);
    
    try {
        console.log('Recalculating Week 1 2024 fantasy points from raw stats...');
        
        // Get all Week 1 stats with raw data
        const stats = await db.all(`
            SELECT * FROM player_stats 
            WHERE week = 1 AND season = 2024 AND raw_stats IS NOT NULL
        `);
        
        console.log(`Found ${stats.length} players with raw stats for Week 1`);
        
        let updated = 0;
        for (const stat of stats) {
            const rawData = JSON.parse(stat.raw_stats);
            
            // Check for 2-point conversions in raw data
            let twoPointPass = 0;
            let twoPointRun = 0;
            let twoPointRec = 0;
            
            if (rawData.Passing && rawData.Passing.passingTwoPointConversion) {
                twoPointPass = parseInt(rawData.Passing.passingTwoPointConversion) || 0;
            }
            if (rawData.Rushing && rawData.Rushing.rushingTwoPointConversion) {
                twoPointRun = parseInt(rawData.Rushing.rushingTwoPointConversion) || 0;
            }
            if (rawData.Receiving && rawData.Receiving.receivingTwoPointConversion) {
                twoPointRec = parseInt(rawData.Receiving.receivingTwoPointConversion) || 0;
            }
            
            if (twoPointPass > 0 || twoPointRun > 0 || twoPointRec > 0) {
                console.log(`\nFound 2-point conversions for ${stat.player_name}:`);
                console.log(`  Pass: ${twoPointPass}, Run: ${twoPointRun}, Rec: ${twoPointRec}`);
                
                // Update the database
                await db.run(`
                    UPDATE player_stats 
                    SET two_point_conversions_pass = ?,
                        two_point_conversions_run = ?,
                        two_point_conversions_rec = ?
                    WHERE stat_id = ?
                `, [twoPointPass, twoPointRun, twoPointRec, stat.stat_id]);
                
                // Get updated stats for fantasy point calculation
                const updatedStat = await db.get(`
                    SELECT * FROM player_stats WHERE stat_id = ?
                `, [stat.stat_id]);
                
                // Recalculate fantasy points
                const fantasyPoints = await scoringService.calculateFantasyPoints(updatedStat);
                
                await db.run(`
                    UPDATE player_stats 
                    SET fantasy_points = ?
                    WHERE stat_id = ?
                `, [fantasyPoints, stat.stat_id]);
                
                console.log(`  Updated fantasy points: ${fantasyPoints}`);
                updated++;
            }
        }
        
        console.log(`\nUpdated ${updated} players with 2-point conversions`);
        
        // Recalculate team scores
        console.log('Recalculating team scores...');
        const teams = await db.all('SELECT team_id FROM teams');
        for (const team of teams) {
            const totalPoints = await db.get(`
                SELECT SUM(ps.fantasy_points) as total_points
                FROM weekly_rosters wr
                JOIN tank01_player_mapping m ON wr.player_id = m.our_player_id
                JOIN player_stats ps ON m.tank01_player_id = ps.player_id
                WHERE wr.team_id = ? AND wr.roster_position = 'active'
                    AND ps.week = 1 AND ps.season = 2024
                    AND wr.week = 1 AND wr.season = 2024
            `, [team.team_id]);
            
            await db.run(`
                UPDATE matchups 
                SET team1_points = CASE WHEN team1_id = ? THEN ? ELSE team1_points END,
                    team2_points = CASE WHEN team2_id = ? THEN ? ELSE team2_points END
                WHERE week = 1 AND season = 2024 
                    AND (team1_id = ? OR team2_id = ?)
            `, [team.team_id, totalPoints.total_points || 0, 
                team.team_id, totalPoints.total_points || 0,
                team.team_id, team.team_id]);
        }
        
        // Check final results
        const swiftStats = await db.get(`
            SELECT * FROM player_stats 
            WHERE player_id = '4259545' AND week = 1 AND season = 2024
        `);
        
        console.log('\nFinal D\'Andre Swift Week 1 stats:');
        console.log('Rushing yards:', swiftStats.rushing_yards);
        console.log('Receiving 2PT conversions:', swiftStats.two_point_conversions_rec);
        console.log('Fantasy points:', swiftStats.fantasy_points);
        
        const calebStats = await db.get(`
            SELECT * FROM player_stats 
            WHERE player_id = '4431611' AND week = 1 AND season = 2024
        `);
        
        console.log('\nFinal Caleb Williams Week 1 stats:');
        console.log('Passing yards:', calebStats.passing_yards);
        console.log('Passing TDs:', calebStats.passing_tds);
        console.log('Passing 2PT conversions:', calebStats.two_point_conversions_pass);
        console.log('Fantasy points:', calebStats.fantasy_points);
        
    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await db.close();
    }
}

recalculateWeek1FromRaw();