#!/usr/bin/env node

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Database path
const dbPath = path.join(__dirname, '../fantasy_football.db');

async function populateWeeklyRosters() {
    console.log('Populating weekly_rosters from fantasy_rosters...');
    
    const db = new sqlite3.Database(dbPath);
    
    try {
        // Get all teams
        const teams = await new Promise((resolve, reject) => {
            db.all('SELECT team_id FROM teams ORDER BY team_id', (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
        
        console.log(`Found ${teams.length} teams`);
        
        let totalInserted = 0;
        
        // For each week (1-17) and each team, copy fantasy roster to weekly roster
        for (let week = 1; week <= 17; week++) {
            for (const team of teams) {
                const teamId = team.team_id;
                
                // Get team's fantasy roster
                const roster = await new Promise((resolve, reject) => {
                    db.all(`
                        SELECT fr.*, p.name, p.position, p.team
                        FROM fantasy_rosters fr
                        JOIN nfl_players p ON fr.player_id = p.player_id
                        WHERE fr.team_id = ?
                    `, [teamId], (err, rows) => {
                        if (err) reject(err);
                        else resolve(rows);
                    });
                });
                
                // Insert each player into weekly_rosters
                for (const player of roster) {
                    await new Promise((resolve, reject) => {
                        db.run(`
                            INSERT INTO weekly_rosters 
                            (team_id, player_id, week, season, roster_position, player_name, player_position, player_team)
                            VALUES (?, ?, ?, 2024, ?, ?, ?, ?)
                        `, [
                            teamId,
                            player.player_id,
                            week,
                            player.roster_position,
                            player.name,
                            player.position,
                            player.team
                        ], (err) => {
                            if (err) reject(err);
                            else resolve();
                        });
                    });
                    
                    totalInserted++;
                }
            }
            
            if (week % 5 === 0) {
                console.log(`Completed week ${week}`);
            }
        }
        
        console.log(`\\n✅ Successfully populated weekly_rosters!`);
        console.log(`Total entries inserted: ${totalInserted}`);
        console.log(`Expected: ${teams.length * 17 * 19} (${teams.length} teams × 17 weeks × 19 players)`);
        
    } catch (error) {
        console.error('Error populating weekly rosters:', error);
    } finally {
        db.close();
    }
}

if (require.main === module) {
    populateWeeklyRosters().catch(console.error);
}

module.exports = { populateWeeklyRosters };