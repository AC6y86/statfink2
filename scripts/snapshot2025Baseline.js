#!/usr/bin/env node

/**
 * Snapshot the 2025 season's per-player-week fantasy points into the golden
 * baseline used by the 2025 scoring regression tests:
 *   tests/2025/baseline_2025_fantasy_points.json
 *
 * IMPORTANT: Re-running this script is a scoring-ruling act — it blesses the
 * CURRENT contents of fantasy_football.db as the official 2025 record. Only
 * do this after an intentional, reviewed scoring change (see CLAUDE.md).
 * The git diff of the JSON shows exactly which player-weeks changed.
 *
 * Usage: node scripts/snapshot2025Baseline.js
 */

const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../fantasy_football.db');
const OUT_PATH = path.join(__dirname, '../tests/2025/baseline_2025_fantasy_points.json');
const SEASON = 2025;

const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
    if (err) {
        console.error('Could not open database:', err.message);
        process.exit(1);
    }
});

const query = `
    SELECT
        ps.player_id,
        COALESCE(np.name, ps.player_name) AS name,
        COALESCE(np.position, ps.position) AS position,
        ps.team,
        ps.week,
        ps.fantasy_points,
        EXISTS (
            SELECT 1 FROM weekly_rosters wr
            WHERE wr.season = ps.season AND wr.week = ps.week
            AND wr.player_id = ps.player_id
        ) AS rostered
    FROM player_stats ps
    LEFT JOIN nfl_players np ON np.player_id = ps.player_id
    WHERE ps.season = ${SEASON}
    ORDER BY ps.week, ps.player_id
`;

db.all(query, [], (err, rows) => {
    if (err) {
        console.error('Query failed:', err.message);
        process.exit(1);
    }

    const baseline = {
        _note: 'Golden baseline for 2025 scoring regression tests. Updating this file blesses the current DB as the official 2025 record — only after a reviewed scoring ruling. See CLAUDE.md.',
        season: SEASON,
        generated_at: new Date().toISOString(),
        row_count: rows.length,
        players: rows.map(r => ({
            player_id: r.player_id,
            name: r.name,
            position: r.position,
            team: r.team,
            week: r.week,
            fantasy_points: r.fantasy_points,
            rostered: r.rostered ? 1 : 0
        }))
    };

    fs.writeFileSync(OUT_PATH, JSON.stringify(baseline, null, 1) + '\n');
    const rostered = baseline.players.filter(p => p.rostered).length;
    console.log(`Wrote ${rows.length} player-week rows (${rostered} rostered) to ${path.relative(process.cwd(), OUT_PATH)}`);
    db.close();
});
