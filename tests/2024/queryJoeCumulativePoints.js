#!/usr/bin/env node

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'statfinkv1_2024.db');
const db = new sqlite3.Database(dbPath);

console.log('=== JOE\'S CUMULATIVE POINTS BY WEEK ===\n');

// Query cumulative points for Joe across all weeks
db.all(`
    SELECT w.week, w.cumulative_points, w.weekly_points, w.wins, w.losses
    FROM weekly_team_totals w
    JOIN teams t ON w.team_id = t.team_id  
    WHERE t.owner_name = 'Joe'
    ORDER BY w.week
`, (err, rows) => {
    if (err) {
        console.error('Error:', err);
        return;
    }
    
    if (rows.length === 0) {
        console.log('No data found for Joe');
        db.close();
        return;
    }
    
    console.log('Week\tWeekly\tCumulative\tRecord');
    console.log('====\t======\t==========\t======');
    
    rows.forEach(row => {
        const week = row.week.toString().padEnd(4);
        const weekly = row.weekly_points.toString().padEnd(6);
        const cumulative = row.cumulative_points.toString().padEnd(10);
        const record = `${row.wins}-${row.losses}`;
        console.log(`${week}\t${weekly}\t${cumulative}\t${record}`);
    });
    
    console.log(`\nTotal weeks of data: ${rows.length}`);
    
    db.close();
});