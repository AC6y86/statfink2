/**
 * Guards against the full-roster matchup-score overwrite bug
 * (docs/DEFENSIVE_SCORING.md: "teamScoreService full-roster overwrite bug").
 *
 * matchups.teamX_scoring_points must ONLY ever be the sum of is_scoring=1
 * lineup players. The overwrite (summing all 19 active players) has been
 * removed three times from different call paths; these tests make sure no
 * loaded copies of it remain.
 */

const fs = require('fs');
const path = require('path');
const { createTempDb, cleanupTempDb } = require('../helpers/tempDb');
const ScoringPlayersService = require('../../server/services/scoringPlayersService');
const TeamScoreService = require('../../server/services/teamScoreService');
const recalcUtil = require('../../server/utils/recalculateFantasyPoints');

describe('Matchup score integrity (full-roster overwrite bug)', () => {
    let db;

    beforeAll(async () => {
        db = await createTempDb('matchup-integrity');

        // Two teams, three active players each: two flagged is_scoring plus one
        // active-but-not-scoring player whose points would leak in if any
        // full-roster writer runs.
        await db.run("INSERT INTO teams (team_id, team_name, owner_name) VALUES (1, 'T1', 'O1'), (2, 'T2', 'O2')");
        const players = [
            ['P1', 'Player One', 'QB', 'KC', 1, 1, 10],
            ['P2', 'Player Two', 'RB', 'SF', 1, 1, 20],
            ['P3', 'Player Three', 'WR', 'GB', 1, 0, 5],
            ['P4', 'Player Four', 'QB', 'DAL', 2, 1, 8],
            ['P5', 'Player Five', 'RB', 'PHI', 2, 1, 12],
            ['P6', 'Player Six', 'WR', 'DET', 2, 0, 7]
        ];
        for (const [id, name, pos, team, teamId, isScoring, pts] of players) {
            await db.run('INSERT INTO nfl_players (player_id, name, position, team) VALUES (?, ?, ?, ?)',
                [id, name, pos, team]);
            await db.run(`INSERT INTO weekly_rosters (team_id, player_id, week, season, roster_position,
                          player_name, player_position, player_team, is_scoring)
                          VALUES (?, ?, 1, 2026, 'active', ?, ?, ?, ?)`,
                [teamId, id, name, pos, team, isScoring]);
            await db.run('INSERT INTO player_stats (player_id, week, season, fantasy_points) VALUES (?, 1, 2026, ?)',
                [id, pts]);
        }
        await db.run('INSERT INTO matchups (week, season, team1_id, team2_id) VALUES (1, 2026, 1, 2)');
    });

    afterAll(async () => {
        await cleanupTempDb(db);
    });

    test('updateMatchupScoringTotals writes lineup-based sums (the one legitimate writer)', async () => {
        const service = new ScoringPlayersService(db);
        await service.updateMatchupScoringTotals(1, 2026);

        const m = await db.get('SELECT team1_scoring_points, team2_scoring_points FROM matchups WHERE week = 1 AND season = 2026');
        expect(m.team1_scoring_points).toBeCloseTo(30); // P1 + P2, NOT + P3
        expect(m.team2_scoring_points).toBeCloseTo(20); // P4 + P5, NOT + P6
    });

    test('teamScoreService no longer carries the full-roster writers', () => {
        const service = new TeamScoreService(db);
        expect(service.recalculateTeamScores).toBeUndefined();
        expect(service.recalculateSeasonScores).toBeUndefined();
    });

    test('recalculateFantasyPoints util no longer exports a full-roster matchup writer', () => {
        expect(recalcUtil.recalculateTeamScores).toBeUndefined();
    });

    test('no route or service calls teamScoreService.recalculateTeamScores anymore', () => {
        const roots = ['server/routes', 'server/services', 'server/utils', 'scripts'];
        const offenders = [];
        for (const root of roots) {
            const dir = path.join(__dirname, '../../', root);
            for (const file of walkJs(dir)) {
                const src = fs.readFileSync(file, 'utf8');
                // Calls only; comments explaining the bug's history are fine
                if (/\.\s*recalculateTeamScores\s*\(|\.\s*recalculateSeasonScores\s*\(/.test(src)) {
                    offenders.push(path.relative(path.join(__dirname, '../..'), file));
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});

function walkJs(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walkJs(full));
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}
