require('dotenv').config();
const DatabaseManager = require('../server/database/database');
const ScoringService = require('../server/services/scoringService');

async function recalculateAll2024From2PT() {
    const db = new DatabaseManager();
    const scoringService = new ScoringService(db);
    
    try {
        console.log('Recalculating all 2024 fantasy points to capture 2-point conversions...');
        
        // Get all 2024 stats with raw data
        const stats = await db.all(`
            SELECT * FROM player_stats 
            WHERE season = 2024 AND raw_stats IS NOT NULL
        `);
        
        console.log(`Found ${stats.length} player stats for 2024 season`);
        
        let updated = 0;
        let total2PT = 0;
        
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
                console.log(`Found 2PT for ${stat.player_name} (Week ${stat.week}): Pass=${twoPointPass}, Run=${twoPointRun}, Rec=${twoPointRec}`);
                total2PT += twoPointPass + twoPointRun + twoPointRec;
                
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
                
                updated++;
            }
        }
        
        console.log(`\nUpdated ${updated} player records with 2-point conversions`);
        console.log(`Total 2-point conversions found: ${total2PT}`);
        
        // Recalculate all team scores for 2024
        console.log('\nRecalculating all 2024 team scores...');
        const weeks = await db.all('SELECT DISTINCT week FROM player_stats WHERE season = 2024 ORDER BY week');
        
        for (const weekRow of weeks) {
            const week = weekRow.week;
            console.log(`  Recalculating Week ${week}...`);
            
            const teams = await db.all('SELECT team_id FROM teams');
            for (const team of teams) {
                const totalPoints = await db.get(`
                    SELECT SUM(ps.fantasy_points) as total_points
                    FROM weekly_rosters wr
                    JOIN tank01_player_mapping m ON wr.player_id = m.our_player_id
                    JOIN player_stats ps ON m.tank01_player_id = ps.player_id
                    WHERE wr.team_id = ? AND wr.roster_position = 'active'
                        AND ps.week = ? AND ps.season = 2024
                        AND wr.week = ? AND wr.season = 2024
                `, [team.team_id, week, week]);
                
                await db.run(`
                    UPDATE matchups 
                    SET team1_points = CASE WHEN team1_id = ? THEN ? ELSE team1_points END,
                        team2_points = CASE WHEN team2_id = ? THEN ? ELSE team2_points END
                    WHERE week = ? AND season = 2024 
                        AND (team1_id = ? OR team2_id = ?)
                `, [team.team_id, totalPoints.total_points || 0, 
                    team.team_id, totalPoints.total_points || 0,
                    week, team.team_id, team.team_id]);
            }
        }
        
        console.log('\nRecalculation complete!');
        
    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await db.close();
    }
}

recalculateAll2024From2PT();