#!/usr/bin/env node

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'statfinkv1_2024.db');
const db = new sqlite3.Database(dbPath);

console.log('=== SCORING DATA CHECK ===\n');

// Check team totals table for Week 1
db.all(`
    SELECT t.owner_name, w.weekly_points, w.cumulative_points, w.wins, w.losses
    FROM weekly_team_totals w
    JOIN teams t ON w.team_id = t.team_id  
    WHERE w.week = 1
    ORDER BY t.owner_name
`, (err, rows) => {
    if (err) {
        console.error('Error:', err);
        return;
    }
    
    console.log('Week 1 Team Scoring Data:');
    console.log('Team\t\tWeekly\tCumulative\tRecord');
    console.log('====\t\t======\t==========\t======');
    
    rows.forEach(row => {
        const team = row.owner_name.padEnd(8);
        const weekly = row.weekly_points.toString().padEnd(6);
        const cumulative = row.cumulative_points.toString().padEnd(10);
        const record = `${row.wins}-${row.losses}`;
        console.log(`${team}\t${weekly}\t${cumulative}\t${record}`);
    });
    
    // Check if we have any non-zero values
    const hasWeeklyPoints = rows.some(r => r.weekly_points > 0);
    const hasCumulativePoints = rows.some(r => r.cumulative_points > 0);
    const hasRecords = rows.some(r => r.wins > 0 || r.losses > 0);
    
    console.log('\n=== ANALYSIS ===');
    console.log(`Weekly points extracted: ${hasWeeklyPoints ? 'YES' : 'NO'}`);
    console.log(`Cumulative points extracted: ${hasCumulativePoints ? 'YES' : 'NO'}`);
    console.log(`Records extracted: ${hasRecords ? 'YES' : 'NO'}`);
    
    if (!hasWeeklyPoints || !hasCumulativePoints || !hasRecords) {
        console.log('\n❌ Some scoring data is missing - extraction may need debugging');
    } else {
        console.log('\n✅ All scoring data successfully extracted!');
    }
    
    db.close();
});