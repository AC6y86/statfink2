/**
 * Compares 2025 per-player-week fantasy points in the live database against
 * the golden baseline (tests/2025/baseline_2025_fantasy_points.json).
 *
 * Unlike the 2024 comparator (which matches by name against an external v1
 * database), the baseline came from this same database, so rows are keyed
 * exactly on player_id + week — no name fuzzing.
 *
 * Mismatch kinds:
 *   FANTASY_POINTS_MISMATCH — same player-week, different points
 *   MISSING_FROM_DB         — baseline row has no counterpart in the DB
 *   MISSING_FROM_BASELINE   — DB row has no counterpart in the baseline
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const SEASON = 2025;

class BaselineComparator2025 {
    constructor() {
        this.dbPath = path.join(__dirname, '../../fantasy_football.db');
        this.baselinePath = path.join(__dirname, 'baseline_2025_fantasy_points.json');
        this.db = null;
        this.baseline = null;
        this.mismatches = [];
    }

    async initialize() {
        this.baseline = require(this.baselinePath);
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(this.dbPath, sqlite3.OPEN_READONLY, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    async getCurrentStats() {
        return new Promise((resolve, reject) => {
            this.db.all(`
                SELECT
                    ps.player_id,
                    COALESCE(np.name, ps.player_name) AS name,
                    COALESCE(np.position, ps.position) AS position,
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
            `, [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    /**
     * Compare current DB against the baseline.
     * rosterPlayersOnly: restrict to player-weeks on a fantasy roster
     * (the strict regression gate, mirroring the 2024 roster mode).
     */
    async compareAll(rosterPlayersOnly = true) {
        this.mismatches = [];

        const currentRows = await this.getCurrentStats();
        const current = new Map(currentRows.map(r => [`${r.player_id}_${r.week}`, r]));
        const baselineRows = this.baseline.players.filter(p => !rosterPlayersOnly || p.rostered);

        for (const b of baselineRows) {
            const key = `${b.player_id}_${b.week}`;
            const c = current.get(key);
            if (!c) {
                this.mismatches.push({
                    issue: 'MISSING_FROM_DB',
                    week: b.week, player_id: b.player_id, player_name: b.name,
                    position: b.position,
                    baseline_fantasy_points: b.fantasy_points, current_fantasy_points: null
                });
            } else if (Math.abs((c.fantasy_points || 0) - (b.fantasy_points || 0)) > 0.05) {
                this.mismatches.push({
                    issue: 'FANTASY_POINTS_MISMATCH',
                    week: b.week, player_id: b.player_id, player_name: b.name,
                    position: b.position,
                    baseline_fantasy_points: b.fantasy_points,
                    current_fantasy_points: c.fantasy_points,
                    difference: (c.fantasy_points || 0) - (b.fantasy_points || 0)
                });
            }
        }

        const baselineKeys = new Set(this.baseline.players.map(p => `${p.player_id}_${p.week}`));
        for (const r of currentRows) {
            if (rosterPlayersOnly && !r.rostered) continue;
            if (!baselineKeys.has(`${r.player_id}_${r.week}`)) {
                this.mismatches.push({
                    issue: 'MISSING_FROM_BASELINE',
                    week: r.week, player_id: r.player_id, player_name: r.name,
                    position: r.position,
                    baseline_fantasy_points: null, current_fantasy_points: r.fantasy_points
                });
            }
        }

        this.mismatches.sort((a, b) => a.week - b.week || String(a.player_name).localeCompare(String(b.player_name)));
        return this.mismatches;
    }

    async close() {
        return new Promise((resolve) => {
            if (this.db) this.db.close(() => resolve());
            else resolve();
        });
    }
}

module.exports = BaselineComparator2025;
