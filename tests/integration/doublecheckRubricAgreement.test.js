/**
 * SLOW / read-only: the independent rubric and lineup selector must agree with
 * the official record for every 2024 and 2025 row. Reads fantasy_football.db
 * READ-ONLY. Wired into jest.config.slow.js (allowlist) and ignored by
 * jest.config.js. A mismatch here means either scoringService drifted from
 * docs/SCORING_SYSTEM.md or the independent rubric did — investigate both.
 */
const path = require('path');
const sqlite3 = require('sqlite3');
const { pointsFor } = require('../../scripts/lib/doublecheckRubric');
const { selectLineup, compareLineups } = require('../../scripts/lib/doublecheckLineup');
const ScoringService = require('../../server/services/scoringService');
const { ENTRIES: KNOWN_ERRORS } = require('../../server/config/knownScoringErrors');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../../fantasy_football.db');
const SEASONS = [2024, 2025];

function open() {
    return new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);
}
const all = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));

describe('doublecheck independent rubric agrees with the official record', () => {
    let db;
    beforeAll(() => { db = open(); });
    afterAll(() => new Promise(res => db.close(res)));

    test('pointsFor(row) === fantasy_points for every 2024/2025 row', async () => {
        const rows = await all(db, `
            SELECT ps.*, COALESCE(NULLIF(ps.position, ''), np.position) AS pos
            FROM player_stats ps LEFT JOIN nfl_players np ON np.player_id = ps.player_id
            WHERE ps.season IN (${SEASONS.join(',')})`);
        expect(rows.length).toBeGreaterThan(5000);
        const bad = [];
        for (const r of rows) {
            const p = pointsFor(r, r.pos).points;
            if (Math.abs(p - (r.fantasy_points || 0)) > 0.005) bad.push(`${r.season} wk${r.week} ${r.player_id} (${r.pos}) stored=${r.fantasy_points} rubric=${p}`);
        }
        expect(bad).toEqual([]);
    });

    test('pointsFor(row) === scoringService.calculateFantasyPoints(row) for every 2024/2025 row', async () => {
        const rows = await all(db, `
            SELECT ps.*, COALESCE(NULLIF(ps.position, ''), np.position) AS pos
            FROM player_stats ps LEFT JOIN nfl_players np ON np.player_id = ps.player_id
            WHERE ps.season IN (${SEASONS.join(',')})`);
        const svc = new ScoringService(null);
        const bad = [];
        for (const r of rows) {
            const theirs = svc.calculateFantasyPoints({ ...r, position: r.pos });
            const ours = pointsFor(r, r.pos).points;
            if (Math.abs(theirs - ours) > 0.005) bad.push(`${r.season} wk${r.week} ${r.player_id} svc=${theirs} rubric=${ours}`);
        }
        expect(bad).toEqual([]);
    });

    test('every registered known error still reads exactly as registered in the official record', async () => {
        // server/config/knownScoringErrors.json documents errors deliberately left in
        // blessed seasons. If a recalc or edit changes one of these rows, update the
        // registry on purpose (and the docs) rather than letting it drift silently.
        const drift = [];
        for (const e of KNOWN_ERRORS) {
            if (!e.player_id || !e.column) continue;
            const row = await all(db, `SELECT ${e.column} AS v FROM player_stats WHERE player_id = ? AND season = ? AND week = ?`, [e.player_id, e.season, e.week]);
            const stored = row.length ? row[0].v : null;
            if (Number(stored) !== Number(e.stored)) drift.push(`${e.id}: registry says ${e.column}=${e.stored}, database has ${stored}`);
        }
        expect(drift).toEqual([]);
    });

    test('independent lineup matches stored is_scoring totals for every 2025 team-week', async () => {
        const rows = await all(db, `
            SELECT wr.team_id, wr.week, wr.player_id, wr.roster_position, wr.is_scoring,
                   COALESCE(NULLIF(ps.position,''), np.position, wr.player_position) AS position,
                   ps.fantasy_points AS points, ps.points_allowed, ps.yards_allowed
            FROM weekly_rosters wr
            LEFT JOIN player_stats ps ON ps.player_id = wr.player_id AND ps.week = wr.week AND ps.season = wr.season
            LEFT JOIN nfl_players np ON np.player_id = wr.player_id
            WHERE wr.season = 2025`);
        const byTeamWeek = new Map();
        for (const r of rows) {
            const k = `${r.team_id}|${r.week}`;
            if (!byTeamWeek.has(k)) byTeamWeek.set(k, []);
            byTeamWeek.get(k).push(r);
        }
        expect(byTeamWeek.size).toBe(12 * 18);
        const bad = [];
        for (const [k, roster] of byTeamWeek) {
            const ind = selectLineup(roster.map(r => ({ ...r, points_allowed: r.points === null ? null : r.points_allowed })));
            const cmp = compareLineups(roster, ind);
            if (!cmp.totalsMatch) bad.push(`${k} stored=${cmp.storedTotal} independent=${cmp.independentTotal} onlyStored=${cmp.onlyStored} onlyInd=${cmp.onlyIndependent}`);
        }
        expect(bad).toEqual([]);
    });
});
