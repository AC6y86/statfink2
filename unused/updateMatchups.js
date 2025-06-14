#!/usr/bin/env node

const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

// Database path
const dbPath = path.join(__dirname, '../fantasy_football.db');

// Character to team ID mapping
const charToTeam = {
    '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, 
    '7': 7, '8': 8, '9': 9, 'a': 10, 'b': 11, 'c': 12
};

function parseMatchupLine(line) {
    const pairs = line.trim().split(' ');
    const matchups = [];
    
    for (const pair of pairs) {
        if (pair.length === 2) {
            const team1 = charToTeam[pair[0]];
            const team2 = charToTeam[pair[1]];
            if (team1 && team2) {
                matchups.push([team1, team2]);
            }
        }
    }
    
    return matchups;
}

async function updateMatchups() {
    console.log('Updating matchups from legacy data...');
    
    // Read the matchups file
    const matchupsFile = path.join(__dirname, '../statfink_legacy/data/matchups.txt');
    const fileContent = fs.readFileSync(matchupsFile, 'utf8');
    const lines = fileContent.trim().split('\n');
    
    const db = new sqlite3.Database(dbPath);
    
    try {
        // Clear existing matchups
        await new Promise((resolve, reject) => {
            db.run('DELETE FROM matchups WHERE season = 2024', (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        
        console.log('Cleared existing 2024 matchups');
        
        let totalInserted = 0;
        
        // Process each week (limit to first 17 weeks)
        for (let i = 0; i < Math.min(lines.length, 17); i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            const week = i + 1;
            const matchups = parseMatchupLine(line);
            
            console.log(`Week ${week}: ${line} -> ${matchups.length} matchups`);
            
            // Insert matchups for this week
            for (const [team1, team2] of matchups) {
                await new Promise((resolve, reject) => {
                    db.run(`
                        INSERT INTO matchups (team1_id, team2_id, week, season, team1_points, team2_points)
                        VALUES (?, ?, ?, 2024, 0, 0)
                    `, [team1, team2, week], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
                
                totalInserted++;
            }
        }
        
        console.log(`\\n✅ Successfully updated matchups!`);
        console.log(`Total matchups inserted: ${totalInserted}`);
        
        // Show a sample of Week 1 matchups
        const week1Matchups = await new Promise((resolve, reject) => {
            db.all(`
                SELECT m.*, t1.owner_name as team1_owner, t2.owner_name as team2_owner
                FROM matchups m
                JOIN teams t1 ON m.team1_id = t1.team_id
                JOIN teams t2 ON m.team2_id = t2.team_id
                WHERE m.week = 1 AND m.season = 2024
                ORDER BY m.team1_id
            `, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
        
        console.log('\\nWeek 1 Matchups:');
        week1Matchups.forEach(m => {
            console.log(`  ${m.team1_owner} vs ${m.team2_owner}`);
        });
        
    } catch (error) {
        console.error('Error updating matchups:', error);
    } finally {
        db.close();
    }
}

if (require.main === module) {
    updateMatchups().catch(console.error);
}

module.exports = { updateMatchups };