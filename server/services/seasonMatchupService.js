const { buildRegularSeasonMatchups } = require('../config/seasonMatchups');

const FIRST_REGULAR_WEEK = 1;
const LAST_REGULAR_WEEK = 12;
const MATCHUPS_PER_WEEK = 6;

async function tableExists(db, tableName) {
    const row = await db.get(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        [tableName]
    );
    return Boolean(row);
}

async function getExistingRegularSeasonRows(db, season) {
    return db.all(`
        SELECT matchup_id, week, team1_id, team2_id,
               team1_scoring_points, team2_scoring_points
        FROM matchups
        WHERE season = ? AND week BETWEEN ? AND ?
        ORDER BY week, matchup_id
    `, [season, FIRST_REGULAR_WEEK, LAST_REGULAR_WEEK]);
}

function validateExistingShape(rows, season) {
    if (rows.length === 0) return 'create';

    const expected = (LAST_REGULAR_WEEK - FIRST_REGULAR_WEEK + 1) * MATCHUPS_PER_WEEK;
    if (rows.length !== expected) {
        throw new Error(
            `Season ${season} has ${rows.length} regular-season matchup rows; ` +
            `expected either 0 or ${expected}`
        );
    }

    for (let week = FIRST_REGULAR_WEEK; week <= LAST_REGULAR_WEEK; week += 1) {
        const count = rows.filter(row => row.week === week).length;
        if (count !== MATCHUPS_PER_WEEK) {
            throw new Error(`Season ${season} week ${week} has ${count} matchups; expected 6`);
        }
    }
    return 'update';
}

async function scoreForTeam(db, teamId, week, season) {
    const result = await db.get(`
        SELECT COALESCE(SUM(ps.fantasy_points), 0) AS total
        FROM weekly_rosters wr
        JOIN player_stats ps
          ON ps.player_id = wr.player_id
         AND ps.week = wr.week
         AND ps.season = wr.season
        WHERE wr.team_id = ?
          AND wr.week = ?
          AND wr.season = ?
          AND wr.is_scoring = 1
    `, [teamId, week, season]);
    return result.total;
}

async function applySeasonMatchups(db, season, { dryRun = true } = {}) {
    const numericSeason = Number(season);
    if (!Number.isInteger(numericSeason)) throw new Error(`Invalid season: ${season}`);

    if (!(await tableExists(db, 'season_team_assignments'))) {
        throw new Error(
            'season_team_assignments is missing; apply ' +
            'server/database/migrations/add_season_team_assignments.sql first'
        );
    }

    const teams = await db.all('SELECT team_id, owner_name FROM teams ORDER BY team_id');
    const schedule = buildRegularSeasonMatchups(numericSeason, teams);
    const existingRows = await getExistingRegularSeasonRows(db, numericSeason);
    const mode = validateExistingShape(existingRows, numericSeason);

    if (dryRun) {
        return { dryRun: true, mode, ...schedule };
    }

    await db.beginTransaction();
    try {
        await db.run('DELETE FROM season_team_assignments WHERE season = ?', [numericSeason]);
        for (const assignment of schedule.assignments) {
            await db.run(`
                INSERT INTO season_team_assignments (season, draft_slot, team_id, division)
                VALUES (?, ?, ?, ?)
            `, [numericSeason, assignment.draftSlot, assignment.teamId, assignment.division]);
        }

        for (let week = FIRST_REGULAR_WEEK; week <= LAST_REGULAR_WEEK; week += 1) {
            const desired = schedule.weeks[week];
            const current = existingRows.filter(row => row.week === week);

            for (let index = 0; index < desired.length; index += 1) {
                const matchup = desired[index];
                const team1Points = await scoreForTeam(db, matchup.team1Id, week, numericSeason);
                const team2Points = await scoreForTeam(db, matchup.team2Id, week, numericSeason);

                if (mode === 'update') {
                    await db.run(`
                        UPDATE matchups
                        SET team1_id = ?, team2_id = ?,
                            team1_scoring_points = ?, team2_scoring_points = ?,
                            is_playoff = 0
                        WHERE matchup_id = ?
                    `, [
                        matchup.team1Id, matchup.team2Id,
                        team1Points, team2Points,
                        current[index].matchup_id
                    ]);
                } else {
                    await db.run(`
                        INSERT INTO matchups
                            (week, season, team1_id, team2_id,
                             team1_scoring_points, team2_scoring_points, is_playoff)
                        VALUES (?, ?, ?, ?, ?, ?, 0)
                    `, [
                        week, numericSeason, matchup.team1Id, matchup.team2Id,
                        team1Points, team2Points
                    ]);
                }
            }
        }

        await db.commit();
    } catch (error) {
        await db.rollback();
        throw error;
    }

    return { dryRun: false, mode, ...schedule };
}

module.exports = {
    applySeasonMatchups,
    getExistingRegularSeasonRows,
    validateExistingShape
};
