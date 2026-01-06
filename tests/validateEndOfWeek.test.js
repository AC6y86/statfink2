const Database = require('../server/database/database');
const StatsFetcher = require('./verification/helpers/stats-fetcher');

async function validateEndOfWeek(week, season = 2025) {
    const db = new Database();
    const statsFetcher = new StatsFetcher(db);
    const results = {
        week: week,
        season: season,
        timestamp: new Date().toISOString(),
        checks: [],
        errors: [],
        warnings: [],
        summary: {
            passed: 0,
            failed: 0,
            warnings: 0
        }
    };

    try {
        // Check 1: Two-point conversions
        const twoPointCheck = await checkTwoPointConversions(db, week, season);
        results.checks.push(twoPointCheck);

        // Check 2: Fewest yards allowed bonus
        const fewestYardsCheck = await checkFewestYardsBonus(db, week, season);
        results.checks.push(fewestYardsCheck);

        // Check 3: Fewest points allowed bonus
        const fewestPointsCheck = await checkFewestPointsBonus(db, week, season);
        results.checks.push(fewestPointsCheck);

        // Check 4: Defensive touchdowns
        const defTDCheck = await checkDefensiveTouchdowns(db, week, season);
        results.checks.push(defTDCheck);

        // Check 5: Cumulative points updated
        const cumulativePointsCheck = await checkCumulativePoints(db, week, season);
        results.checks.push(cumulativePointsCheck);

        // Check 6: Standings updated
        const standingsCheck = await checkStandingsUpdated(db, week, season);
        results.checks.push(standingsCheck);

        // Check 7: Players with 0 stats (ESPN lookup)
        const zeroStatsCheck = await checkPlayersWithZeroStats(db, statsFetcher, week, season);
        results.checks.push(zeroStatsCheck);

        // Calculate summary
        results.checks.forEach(check => {
            if (check.status === 'passed') results.summary.passed++;
            else if (check.status === 'failed') results.summary.failed++;
            else if (check.status === 'warning') results.summary.warnings++;
        });

        results.overallStatus = results.summary.failed === 0 ? 'passed' : 'failed';

    } catch (error) {
        results.errors.push({
            message: 'Test execution error',
            error: error.message,
            stack: error.stack
        });
        results.overallStatus = 'error';
    } finally {
        if (statsFetcher) {
            await statsFetcher.cleanup();
        }
        await db.close();
    }

    return results;
}

async function checkTwoPointConversions(db, week, season) {
    const twoPointStats = await db.get(`
        SELECT
            SUM(two_point_conversions_pass) as pass_2pt,
            SUM(two_point_conversions_run) as run_2pt,
            SUM(two_point_conversions_rec) as rec_2pt,
            SUM(two_point_conversions_pass + two_point_conversions_run + two_point_conversions_rec) as total_2pt
        FROM player_stats
        WHERE week = ? AND season = ?
    `, [week, season]);

    const details = [];
    if (twoPointStats.pass_2pt > 0) details.push(`${twoPointStats.pass_2pt} passing`);
    if (twoPointStats.run_2pt > 0) details.push(`${twoPointStats.run_2pt} rushing`);
    if (twoPointStats.rec_2pt > 0) details.push(`${twoPointStats.rec_2pt} receiving`);

    return {
        name: 'Two-Point Conversions',
        status: twoPointStats.total_2pt > 0 ? 'passed' : 'failed',
        message: twoPointStats.total_2pt > 0
            ? `Found ${twoPointStats.total_2pt} two-point conversions (${details.join(', ')})`
            : 'No two-point conversions found in week',
        value: twoPointStats.total_2pt || 0
    };
}

async function checkFewestYardsBonus(db, week, season) {
    const bonusStats = await db.all(`
        SELECT
            player_id,
            player_name,
            position,
            def_yards_bonus
        FROM player_stats
        WHERE week = ? AND season = ?
        AND def_yards_bonus > 0
        ORDER BY def_yards_bonus DESC
    `, [week, season]);

    const totalBonus = bonusStats.reduce((sum, stat) => sum + stat.def_yards_bonus, 0);

    return {
        name: 'Fewest Yards Allowed Bonus',
        status: bonusStats.length > 0 ? 'passed' : 'failed',
        message: bonusStats.length > 0
            ? `${bonusStats.length} DST units received fewest yards bonus (${totalBonus.toFixed(1)} total points)`
            : 'No fewest yards allowed bonus awarded',
        value: totalBonus,
        details: bonusStats.map(s => `${s.player_name}: ${s.def_yards_bonus} points`)
    };
}

async function checkFewestPointsBonus(db, week, season) {
    const bonusStats = await db.all(`
        SELECT
            player_id,
            player_name,
            position,
            def_points_bonus
        FROM player_stats
        WHERE week = ? AND season = ?
        AND def_points_bonus > 0
        ORDER BY def_points_bonus DESC
    `, [week, season]);

    const totalBonus = bonusStats.reduce((sum, stat) => sum + stat.def_points_bonus, 0);

    return {
        name: 'Fewest Points Allowed Bonus',
        status: bonusStats.length > 0 ? 'passed' : 'failed',
        message: bonusStats.length > 0
            ? `${bonusStats.length} DST units received fewest points bonus (${totalBonus.toFixed(1)} total points)`
            : 'No fewest points allowed bonus awarded',
        value: totalBonus,
        details: bonusStats.map(s => `${s.player_name}: ${s.def_points_bonus} points`)
    };
}

async function checkDefensiveTouchdowns(db, week, season) {
    const defTDStats = await db.all(`
        SELECT
            player_id,
            player_name,
            position,
            def_touchdowns,
            def_int_return_tds,
            def_fumble_return_tds,
            def_blocked_return_tds,
            (COALESCE(def_touchdowns, 0) + COALESCE(def_int_return_tds, 0) +
             COALESCE(def_fumble_return_tds, 0) + COALESCE(def_blocked_return_tds, 0)) as total_def_tds
        FROM player_stats
        WHERE week = ? AND season = ?
        AND (def_touchdowns > 0 OR def_int_return_tds > 0 OR
             def_fumble_return_tds > 0 OR def_blocked_return_tds > 0)
        ORDER BY total_def_tds DESC
    `, [week, season]);

    const totalTDs = defTDStats.reduce((sum, stat) => sum + stat.total_def_tds, 0);

    return {
        name: 'Defensive Touchdowns',
        status: totalTDs > 0 ? 'passed' : 'failed',
        message: totalTDs > 0
            ? `Found ${totalTDs} defensive touchdowns from ${defTDStats.length} units`
            : 'No defensive touchdowns found in week',
        value: totalTDs,
        details: defTDStats.map(s => {
            const tdTypes = [];
            if (s.def_int_return_tds > 0) tdTypes.push(`${s.def_int_return_tds} INT return`);
            if (s.def_fumble_return_tds > 0) tdTypes.push(`${s.def_fumble_return_tds} fumble return`);
            if (s.def_blocked_return_tds > 0) tdTypes.push(`${s.def_blocked_return_tds} blocked kick return`);
            if (s.def_touchdowns > 0) tdTypes.push(`${s.def_touchdowns} other defensive`);
            return `${s.player_name || s.player_id}: ${s.total_def_tds} TD${s.total_def_tds > 1 ? 's' : ''} (${tdTypes.join(', ')})`;
        })
    };
}

async function checkCumulativePoints(db, week, season) {
    const standings = await db.all(`
        SELECT
            ws.team_id,
            t.team_name,
            ws.week,
            ws.points_for_week,
            ws.cumulative_points,
            LAG(ws.cumulative_points) OVER (PARTITION BY ws.team_id ORDER BY ws.week) as prev_cumulative
        FROM weekly_standings ws
        JOIN teams t ON ws.team_id = t.team_id
        WHERE ws.season = ? AND ws.week = ?
        ORDER BY ws.team_id
    `, [season, week]);

    let correctCount = 0;
    let incorrectCount = 0;
    const issues = [];

    for (const row of standings) {
        const expectedCumulative = (row.prev_cumulative || 0) + row.points_for_week;
        const difference = Math.abs(row.cumulative_points - expectedCumulative);

        if (difference < 0.01) {
            correctCount++;
        } else {
            incorrectCount++;
            issues.push(`${row.team_name}: Expected ${expectedCumulative.toFixed(2)}, got ${row.cumulative_points.toFixed(2)}`);
        }
    }

    return {
        name: 'Cumulative Points Update',
        status: incorrectCount === 0 ? 'passed' : 'failed',
        message: incorrectCount === 0
            ? `All ${correctCount} teams have correct cumulative points`
            : `${incorrectCount} teams have incorrect cumulative points`,
        value: correctCount,
        details: issues.slice(0, 5)
    };
}

async function checkStandingsUpdated(db, week, season) {
    const matchups = await db.all(`
        SELECT
            m.matchup_id,
            m.team1_id,
            m.team2_id,
            m.team1_scoring_points as team1_points,
            m.team2_scoring_points as team2_points,
            t1.team_name as team1_name,
            t2.team_name as team2_name
        FROM matchups m
        JOIN teams t1 ON m.team1_id = t1.team_id
        JOIN teams t2 ON m.team2_id = t2.team_id
        WHERE m.week = ? AND m.season = ?
    `, [week, season]);

    const standings = await db.all(`
        SELECT
            team_id,
            wins,
            losses,
            ties
        FROM weekly_standings
        WHERE week = ? AND season = ?
    `, [week, season]);

    const standingsMap = {};
    standings.forEach(s => {
        standingsMap[s.team_id] = s;
    });

    let validMatchups = 0;
    let invalidMatchups = 0;
    const issues = [];

    for (const matchup of matchups) {
        if (matchup.team1_points !== null && matchup.team2_points !== null) {
            const team1Standing = standingsMap[matchup.team1_id];
            const team2Standing = standingsMap[matchup.team2_id];

            if (team1Standing && team2Standing) {
                const totalGames1 = team1Standing.wins + team1Standing.losses + team1Standing.ties;
                const totalGames2 = team2Standing.wins + team2Standing.losses + team2Standing.ties;

                if (totalGames1 === week && totalGames2 === week) {
                    validMatchups++;
                } else {
                    invalidMatchups++;
                    if (totalGames1 !== week) {
                        issues.push(`${matchup.team1_name}: Total games (${totalGames1}) doesn't match week ${week}`);
                    }
                    if (totalGames2 !== week) {
                        issues.push(`${matchup.team2_name}: Total games (${totalGames2}) doesn't match week ${week}`);
                    }
                }
            }
        }
    }

    return {
        name: 'Standings Update',
        status: invalidMatchups === 0 ? 'passed' : 'failed',
        message: invalidMatchups === 0
            ? `All ${validMatchups} matchups properly reflected in standings`
            : `${invalidMatchups} matchups not properly reflected in standings`,
        value: validMatchups,
        details: issues.slice(0, 5)
    };
}

async function checkPlayersWithZeroStats(db, statsFetcher, week, season) {
    const playersWithoutStats = await db.all(`
        SELECT
            wr.player_id,
            wr.player_name,
            wr.player_position,
            wr.player_team,
            wr.week,
            wr.team_id,
            ng.game_id,
            ng.status as game_status,
            ng.home_team,
            ng.away_team,
            ng.home_score,
            ng.away_score
        FROM weekly_rosters wr
        JOIN nfl_games ng ON
            wr.week = ng.week
            AND wr.season = ng.season
            AND (ng.home_team = wr.player_team OR ng.away_team = wr.player_team)
        LEFT JOIN player_stats ps ON
            wr.player_id = ps.player_id
            AND wr.week = ps.week
            AND wr.season = ps.season
        WHERE wr.season = ?
        AND wr.week = ?
        AND wr.roster_position = 'active'
        AND ng.status = 'Final'
        AND ps.stat_id IS NULL
        ORDER BY wr.team_id, wr.player_name
        LIMIT 20
    `, [season, week]);

    const actuallyMissing = [];
    const validReasons = [];

    for (const player of playersWithoutStats.slice(0, 10)) {
        try {
            const result = await statsFetcher.checkPlayerGameStatus(
                player.player_id,
                player.player_name,
                player.week,
                season
            );

            // Handle both old (string) and new (object) formats
            const status = typeof result === 'string' ? result : result.status;
            const espnStats = typeof result === 'object' ? result.stats : null;

            const validStatuses = ['suspended', 'inactive', 'injured', 'dnp', 'backup'];

            if (validStatuses.includes(status)) {
                validReasons.push({
                    name: player.player_name,
                    team: player.player_team,
                    reason: status
                });
            } else {
                actuallyMissing.push({
                    name: player.player_name,
                    team: player.player_team,
                    position: player.player_position,
                    fantasyTeam: player.team_id,
                    espnStatus: status,
                    espnStats: espnStats
                });
            }
        } catch (error) {
            actuallyMissing.push({
                name: player.player_name,
                team: player.player_team,
                position: player.player_position,
                fantasyTeam: player.team_id,
                espnStatus: 'lookup-failed',
                espnStats: null
            });
        }
    }

    const status = actuallyMissing.length === 0 ? 'passed' :
                   actuallyMissing.length <= 3 ? 'warning' : 'failed';

    return {
        name: 'Players with Missing Stats (ESPN Check)',
        status: status,
        message: actuallyMissing.length === 0
            ? `All players have stats or valid reasons (${validReasons.length} inactive/injured)`
            : `${actuallyMissing.length} active players missing stats (checked ${playersWithoutStats.length} total)`,
        value: actuallyMissing.length,
        details: [
            ...actuallyMissing.slice(0, 5).map(p => {
                let line = `${p.name} (${p.position}, ${p.team}) - Team ${p.fantasyTeam} [ESPN: ${p.espnStatus}`;

                // Add ESPN stats if available
                if (p.espnStats) {
                    const stats = p.espnStats;
                    const statParts = [];

                    // Format stats based on what's available
                    if (stats.carries !== undefined || stats.rushYards !== undefined) {
                        statParts.push(`Rush: ${stats.carries || 0}/${stats.rushYards || 0}/${stats.rushTD || 0}`);
                    }
                    if (stats.receptions !== undefined || stats.recYards !== undefined) {
                        statParts.push(`Rec: ${stats.receptions || 0}/${stats.recYards || 0}/${stats.recTD || 0}`);
                    }
                    if (stats.completions !== undefined || stats.attempts !== undefined) {
                        statParts.push(`Pass: ${stats.completions || 0}/${stats.attempts || 0}/${stats.passYards || 0}/${stats.passTD || 0}`);
                    }

                    if (statParts.length > 0) {
                        line += ` - ${statParts.join(', ')}`;
                    } else if (stats.rawCells) {
                        // Show raw data if we couldn't parse specific stats
                        line += ` - Raw: ${stats.rawCells}`;
                    }
                }
                line += ']';
                return line;
            }),
            ...validReasons.slice(0, 3).map(p =>
                `✓ ${p.name} (${p.team}) - ${p.reason}`
            )
        ]
    };
}

// Export for use in tests and API
module.exports = { validateEndOfWeek };

// Allow running directly from command line
if (require.main === module) {
    const week = process.argv[2] ? parseInt(process.argv[2]) : null;
    const season = process.argv[3] ? parseInt(process.argv[3]) : 2025;

    if (!week) {
        console.error('Usage: node validateEndOfWeek.test.js <week> [season]');
        process.exit(1);
    }

    validateEndOfWeek(week, season).then(results => {
        console.log(JSON.stringify(results, null, 2));
        process.exit(results.overallStatus === 'passed' ? 0 : 1);
    }).catch(error => {
        console.error('Test failed:', error);
        process.exit(1);
    });
}