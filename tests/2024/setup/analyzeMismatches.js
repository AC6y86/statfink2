const sqlite3 = require('sqlite3').verbose();
const path = require('path');

async function analyzeMismatches() {
    const currentDbPath = path.join(__dirname, '../../fantasy_football.db');
    const db = new sqlite3.Database(currentDbPath);
    
    // Players with -2 point differences
    const playersToCheck = [
        { name: 'James Conner', weeks: [1, 18] },
        { name: 'Saquon Barkley', weeks: [1, 8] },
        { name: 'Deshaun Watson', weeks: [2] },
        { name: 'Gardner Minshew', weeks: [4] },
        { name: 'Jakobi Meyers', weeks: [4] },
        { name: 'Jayden Daniels', weeks: [8] },
        { name: 'Jordan Love', weeks: [11] },
        { name: 'Chase Brown', weeks: [16] }
    ];
    
    console.log('Analyzing fantasy points mismatches...\n');
    
    for (const player of playersToCheck) {
        for (const week of player.weeks) {
            await new Promise((resolve) => {
                db.get(`
                    SELECT *
                    FROM player_stats
                    WHERE player_name = ? AND week = ? AND season = 2024
                `, [player.name, week], (err, row) => {
                    if (err) {
                        console.error('Error:', err);
                    } else if (row) {
                        console.log(`\n${player.name} - Week ${week}:`);
                        console.log(`Position: ${row.position}`);
                        console.log(`Fantasy Points: ${row.fantasy_points}`);
                        
                        // Show relevant stats based on position
                        if (row.position === 'QB') {
                            console.log(`Passing: ${row.passing_yards} yds, ${row.passing_tds} TD, ${row.interceptions} INT`);
                            console.log(`Rushing: ${row.rushing_yards} yds, ${row.rushing_tds} TD`);
                            console.log(`Fumbles: ${row.fumbles}`);
                        } else if (row.position === 'RB') {
                            console.log(`Rushing: ${row.rushing_yards} yds, ${row.rushing_tds} TD`);
                            console.log(`Receiving: ${row.receptions} rec, ${row.receiving_yards} yds, ${row.receiving_tds} TD`);
                            console.log(`Fumbles: ${row.fumbles}`);
                        } else if (row.position === 'WR' || row.position === 'TE') {
                            console.log(`Receiving: ${row.receptions} rec, ${row.receiving_yards} yds, ${row.receiving_tds} TD`);
                            console.log(`Fumbles: ${row.fumbles}`);
                        }
                    }
                    resolve();
                });
            });
        }
    }
    
    db.close();
}

analyzeMismatches().catch(console.error);