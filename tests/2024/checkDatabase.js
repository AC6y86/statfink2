#!/usr/bin/env node

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'statfinkv1_2024.db');
const db = new sqlite3.Database(dbPath);

console.log('=== DATABASE CHECK ===\n');

// Check total players
db.get("SELECT COUNT(*) as total FROM weekly_player_performance WHERE week = 1", (err, row) => {
    if (err) {
        console.error('Error:', err);
        return;
    }
    console.log(`Total players in Week 1: ${row.total}`);
    
    // Check by team
    db.all(`
        SELECT t.owner_name, COUNT(*) as player_count
        FROM weekly_player_performance w
        JOIN teams t ON w.team_id = t.team_id  
        WHERE w.week = 1
        GROUP BY w.team_id, t.owner_name
        ORDER BY t.owner_name
    `, (err, rows) => {
        if (err) {
            console.error('Error:', err);
            return;
        }
        
        console.log('\nPlayers per team:');
        rows.forEach(row => {
            console.log(`${row.owner_name}: ${row.player_count} players`);
        });
        
        // Check sample of players for Mitch
        db.all(`
            SELECT p.player_name, p.position, w.DidScore
            FROM weekly_player_performance w
            JOIN players p ON w.player_id = p.player_id
            JOIN teams t ON w.team_id = t.team_id
            WHERE w.week = 1 AND t.owner_name = 'Mitch'
            ORDER BY p.position, p.player_name
        `, (err, players) => {
            if (err) {
                console.error('Error:', err);
                return;
            }
            
            console.log(`\nMitch's roster (${players.length} players):`);
            players.forEach(p => {
                console.log(`  ${p.position}: ${p.player_name} ${p.DidScore ? '(starter)' : ''}`);
            });
            
            db.close();
        });
    });
});