/**
 * Guards the weekly roster copy (database.copyRostersToNextWeek).
 *
 * A past production incident (commit f327966) advanced the week with missing
 * rosters. The league invariant is 12 teams x 19 active players every week;
 * the copy must refuse to run from a source week that violates it and must
 * never leave partial data in the target week.
 */

const { createTempDb, cleanupTempDb } = require('../helpers/tempDb');

const SEASON = 2026;
const TEAMS = 12;
const ACTIVE_PER_TEAM = 19;

describe('copyRostersToNextWeek roster guard', () => {
    let db;

    beforeAll(async () => {
        db = await createTempDb('roster-copy-guard');

        for (let t = 1; t <= TEAMS; t++) {
            await db.run('INSERT INTO teams (team_id, team_name, owner_name) VALUES (?, ?, ?)',
                [t, `Team ${t}`, `Owner ${t}`]);
        }
        // 12 x 19 active players in week 1, plus one IR player on team 1
        for (let t = 1; t <= TEAMS; t++) {
            for (let p = 1; p <= ACTIVE_PER_TEAM; p++) {
                const id = `T${t}P${p}`;
                await db.run('INSERT INTO nfl_players (player_id, name, position, team) VALUES (?, ?, ?, ?)',
                    [id, `Player ${id}`, 'RB', 'KC']);
                await db.run(`INSERT INTO weekly_rosters (team_id, player_id, week, season, roster_position,
                              player_name, player_position, player_team)
                              VALUES (?, ?, 1, ?, 'active', ?, 'RB', 'KC')`,
                    [t, id, SEASON, `Player ${id}`]);
            }
        }
        await db.run("INSERT INTO nfl_players (player_id, name, position, team) VALUES ('IR1', 'Hurt Guy', 'WR', 'SF')");
        await db.run(`INSERT INTO weekly_rosters (team_id, player_id, week, season, roster_position,
                      player_name, player_position, player_team)
                      VALUES (1, 'IR1', 1, ?, 'injured_reserve', 'Hurt Guy', 'WR', 'SF')`, [SEASON]);
    });

    afterAll(async () => {
        await cleanupTempDb(db);
    });

    test('copies a valid 12x19 week completely (IR included)', async () => {
        const result = await db.copyRostersToNextWeek(1, 2, SEASON);
        expect(result.success).toBe(true);
        expect(result.entriesCopied).toBe(TEAMS * ACTIVE_PER_TEAM + 1);

        const active = await db.get(
            "SELECT COUNT(*) as c FROM weekly_rosters WHERE week = 2 AND season = ? AND roster_position = 'active'", [SEASON]);
        expect(active.c).toBe(TEAMS * ACTIVE_PER_TEAM);
    });

    test('refuses to copy when target week already has rosters', async () => {
        const result = await db.copyRostersToNextWeek(1, 2, SEASON);
        expect(result.success).toBe(false);
    });

    test('refuses to copy from a source week violating the 12x19 invariant and leaves no partial data', async () => {
        // Corrupt the source: team 1 drops to 18 active players
        await db.run("DELETE FROM weekly_rosters WHERE week = 1 AND season = ? AND team_id = 1 AND player_id = 'T1P1'", [SEASON]);

        const result = await db.copyRostersToNextWeek(1, 3, SEASON);
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/19|invariant|roster/i);

        const copied = await db.get('SELECT COUNT(*) as c FROM weekly_rosters WHERE week = 3 AND season = ?', [SEASON]);
        expect(copied.c).toBe(0);
    });

    test('refuses to copy from an empty source week', async () => {
        const result = await db.copyRostersToNextWeek(7, 8, SEASON);
        expect(result.success).toBe(false);

        const copied = await db.get('SELECT COUNT(*) as c FROM weekly_rosters WHERE week = 8 AND season = ?', [SEASON]);
        expect(copied.c).toBe(0);
    });
});
