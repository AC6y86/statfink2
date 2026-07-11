const Database = require('../server/database/database');
const StatsFetcher = require('./verification/helpers/stats-fetcher');

// W/L/T only accumulate during the regular season (standingsService.js line ~44);
// weeks 13+ are playoffs and standings records are frozen.
const REGULAR_SEASON_WEEKS = 12;

async function validateEndOfWeek(week, season = null) {
    const db = new Database();
    const statsFetcher = new StatsFetcher(db);

    if (!week || !season) {
        const settings = await db.get(
            'SELECT current_week, season_year FROM league_settings WHERE league_id = 1'
        );
        week = week || settings?.current_week;
        season = season || settings?.season_year;
        if (!week || !season) {
            await db.close();
            throw new Error('Week/season not provided and league_settings has no current week/season');
        }
    }

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

        // Check 7: Matchup winners reflected in standings W/L/T deltas
        const winLossCheck = await checkStandingsWinLossDeltas(db, week, season);
        results.checks.push(winLossCheck);

        // Check 8: Players with 0 stats (ESPN lookup)
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

    // A week with zero 2pt conversions among rostered players is unusual but
    // legitimate (happened 2025 week 17) — warn, don't fail.
    return {
        name: 'Two-Point Conversions',
        status: twoPointStats.total_2pt > 0 ? 'passed' : 'warning',
        message: twoPointStats.total_2pt > 0
            ? `Found ${twoPointStats.total_2pt} two-point conversions (${details.join(', ')})`
            : 'No two-point conversions found in week — unusual but can be legitimate; verify against boxscores',
        value: twoPointStats.total_2pt || 0
    };
}

// Recompute the expected defensive bonus (5 pts split among tied leaders) the
// same way scoringService.calculateDefensiveBonuses does, and compare against
// what is stored. This validates the bonus went to the RIGHT units, not merely
// that some bonus exists.
async function checkDefensiveBonus(db, week, season, { statColumn, bonusColumn, checkName }) {
    const gameStatus = await db.get(`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN status LIKE 'Final%' THEN 1 ELSE 0 END) as final
        FROM nfl_games WHERE week = ? AND season = ?
    `, [week, season]);

    if (!gameStatus || gameStatus.total === 0 || gameStatus.final < gameStatus.total) {
        return {
            name: checkName,
            status: 'warning',
            message: gameStatus && gameStatus.total > 0
                ? `Bonus check deferred — ${gameStatus.final}/${gameStatus.total} games final`
                : `No games found for week ${week}/${season} — bonus check skipped`,
            value: 0
        };
    }

    // Same population as scoringService.calculateDefensiveBonuses: rostered DSTs
    const dstStats = await db.all(`
        SELECT ps.player_id,
               COALESCE(NULLIF(ps.player_name, ''), ps.player_id) as player_name,
               ps.${statColumn} as stat_value, ps.${bonusColumn} as stored_bonus
        FROM player_stats ps
        JOIN nfl_players p ON ps.player_id = p.player_id
        WHERE ps.week = ? AND ps.season = ? AND p.position = 'DST'
        AND ps.player_id IN (
            SELECT DISTINCT player_id FROM weekly_rosters
            WHERE week = ? AND season = ?
        )
    `, [week, season, week, season]);

    if (dstStats.length === 0) {
        return {
            name: checkName,
            status: 'failed',
            message: 'No rostered DST stat rows found for the week',
            value: 0
        };
    }

    const lowest = Math.min(...dstStats.map(s => s.stat_value));
    const tied = dstStats.filter(s => s.stat_value === lowest);
    const expectedBonus = 5 / tied.length;

    const issues = [];
    for (const dst of dstStats) {
        const expected = dst.stat_value === lowest ? expectedBonus : 0;
        if (Math.abs((dst.stored_bonus || 0) - expected) > 0.01) {
            issues.push(`${dst.player_name}: expected ${expected.toFixed(2)}, stored ${(dst.stored_bonus || 0).toFixed(2)} (${statColumn}=${dst.stat_value}, lowest=${lowest})`);
        }
    }

    return {
        name: checkName,
        status: issues.length === 0 ? 'passed' : 'failed',
        message: issues.length === 0
            ? `Bonus correct: ${tied.map(t => t.player_name).join(', ')} at ${lowest} ${statColumn.replace('_', ' ')} (${expectedBonus.toFixed(2)} pts each)`
            : `${issues.length} DST unit(s) with incorrect ${bonusColumn}`,
        value: expectedBonus * tied.length,
        details: issues
    };
}

async function checkFewestYardsBonus(db, week, season) {
    return checkDefensiveBonus(db, week, season, {
        statColumn: 'yards_allowed',
        bonusColumn: 'def_yards_bonus',
        checkName: 'Fewest Yards Allowed Bonus'
    });
}

async function checkFewestPointsBonus(db, week, season) {
    return checkDefensiveBonus(db, week, season, {
        statColumn: 'points_allowed',
        bonusColumn: 'def_points_bonus',
        checkName: 'Fewest Points Allowed Bonus'
    });
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

    // A week with zero defensive TDs among rostered units is unusual but
    // legitimate (happened 2025 week 6) — warn, don't fail.
    return {
        name: 'Defensive Touchdowns',
        status: totalTDs > 0 ? 'passed' : 'warning',
        message: totalTDs > 0
            ? `Found ${totalTDs} defensive touchdowns from ${defTDStats.length} units`
            : 'No defensive touchdowns found in week — unusual but can be legitimate; verify against boxscores',
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
    // NB: a window LAG() here would run after the single-week WHERE filter and
    // always return NULL — the previous week must come from a subquery.
    const standings = await db.all(`
        SELECT
            ws.team_id,
            t.team_name,
            ws.week,
            ws.points_for_week,
            ws.cumulative_points,
            (SELECT prev.cumulative_points
             FROM weekly_standings prev
             WHERE prev.team_id = ws.team_id
               AND prev.season = ws.season
               AND prev.week = ws.week - 1) as prev_cumulative
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

    // During the regular season each team plays one counted game per week;
    // in the playoffs (week 13+) records are frozen at 12 games.
    const expectedGames = Math.min(week, REGULAR_SEASON_WEEKS);

    for (const matchup of matchups) {
        if (matchup.team1_points !== null && matchup.team2_points !== null) {
            const team1Standing = standingsMap[matchup.team1_id];
            const team2Standing = standingsMap[matchup.team2_id];

            if (team1Standing && team2Standing) {
                const totalGames1 = team1Standing.wins + team1Standing.losses + team1Standing.ties;
                const totalGames2 = team2Standing.wins + team2Standing.losses + team2Standing.ties;

                if (totalGames1 === expectedGames && totalGames2 === expectedGames) {
                    validMatchups++;
                } else {
                    invalidMatchups++;
                    if (totalGames1 !== expectedGames) {
                        issues.push(`${matchup.team1_name}: Total games (${totalGames1}) doesn't match expected ${expectedGames} for week ${week}`);
                    }
                    if (totalGames2 !== expectedGames) {
                        issues.push(`${matchup.team2_name}: Total games (${totalGames2}) doesn't match expected ${expectedGames} for week ${week}`);
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

// Verify each matchup's winner/loser (by scoring points) is reflected in the
// standings W/L/T deltas from the previous week. Catches a standings run that
// credited the wrong team, which the totals-only check above cannot see.
async function checkStandingsWinLossDeltas(db, week, season) {
    const matchups = await db.all(`
        SELECT m.team1_id, m.team2_id,
               m.team1_scoring_points as team1_points,
               m.team2_scoring_points as team2_points,
               t1.team_name as team1_name, t2.team_name as team2_name
        FROM matchups m
        JOIN teams t1 ON m.team1_id = t1.team_id
        JOIN teams t2 ON m.team2_id = t2.team_id
        WHERE m.week = ? AND m.season = ?
    `, [week, season]);

    const standingsRows = await db.all(`
        SELECT team_id, week, wins, losses, ties
        FROM weekly_standings
        WHERE season = ? AND week IN (?, ?)
    `, [season, week, week - 1]);

    const current = {};
    const previous = {};
    for (const row of standingsRows) {
        if (row.week === week) current[row.team_id] = row;
        else previous[row.team_id] = row;
    }

    const issues = [];
    let checked = 0;

    // Playoff weeks (13+) don't count toward W/L/T — records must stay frozen.
    const isPlayoffWeek = week > REGULAR_SEASON_WEEKS;

    for (const m of matchups) {
        if (m.team1_points === null || m.team2_points === null) continue;

        const expected = {};
        if (isPlayoffWeek) {
            expected[m.team1_id] = { wins: 0, losses: 0, ties: 0 };
            expected[m.team2_id] = { wins: 0, losses: 0, ties: 0 };
        } else if (Math.abs(m.team1_points - m.team2_points) < 0.001) {
            expected[m.team1_id] = { wins: 0, losses: 0, ties: 1 };
            expected[m.team2_id] = { wins: 0, losses: 0, ties: 1 };
        } else if (m.team1_points > m.team2_points) {
            expected[m.team1_id] = { wins: 1, losses: 0, ties: 0 };
            expected[m.team2_id] = { wins: 0, losses: 1, ties: 0 };
        } else {
            expected[m.team1_id] = { wins: 0, losses: 1, ties: 0 };
            expected[m.team2_id] = { wins: 1, losses: 0, ties: 0 };
        }

        for (const [teamId, exp] of Object.entries(expected)) {
            const cur = current[teamId];
            if (!cur) {
                issues.push(`Team ${teamId}: no week ${week} standings row`);
                continue;
            }
            const prev = previous[teamId] || { wins: 0, losses: 0, ties: 0 };
            const name = String(teamId) === String(m.team1_id) ? m.team1_name : m.team2_name;
            for (const col of ['wins', 'losses', 'ties']) {
                const delta = cur[col] - prev[col];
                if (delta !== exp[col]) {
                    issues.push(`${name}: ${col} delta ${delta}, expected ${exp[col]} (scored ${m.team1_points} vs ${m.team2_points})`);
                }
            }
            checked++;
        }
    }

    return {
        name: 'Standings Win/Loss Deltas',
        status: issues.length === 0 ? 'passed' : 'failed',
        message: issues.length === 0
            ? `All ${checked} team results match standings W/L/T deltas`
            : `${issues.length} standings delta mismatch(es)`,
        value: checked,
        details: issues.slice(0, 10)
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
        AND ng.status LIKE 'Final%'
        AND ps.stat_id IS NULL
        ORDER BY wr.team_id, wr.player_name
    `, [season, week]);

    // ESPN-verify sequentially (gentle on ESPN; statuses are cached by
    // StatsFetcher). 60 covers even the worst rest-heavy week 18; anything
    // beyond is reported as unchecked.
    const ESPN_CHECK_LIMIT = 60;
    const confirmedMissing = [];   // ESPN says the player played / has stats
    const unknownStatus = [];      // ESPN lookup failed or returned 'unknown'
    const validReasons = [];
    const unchecked = playersWithoutStats.slice(ESPN_CHECK_LIMIT);

    for (const player of playersWithoutStats.slice(0, ESPN_CHECK_LIMIT)) {
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
                const entry = {
                    name: player.player_name,
                    team: player.player_team,
                    position: player.player_position,
                    fantasyTeam: player.team_id,
                    espnStatus: status,
                    espnStats: espnStats
                };
                // Only a positive ESPN signal (played/has stats) confirms data is
                // missing; 'unknown' is a lookup problem, not a data problem.
                if (espnStats || status === 'active' || status === 'played') {
                    confirmedMissing.push(entry);
                } else {
                    unknownStatus.push(entry);
                }
            }
        } catch (error) {
            unknownStatus.push({
                name: player.player_name,
                team: player.player_team,
                position: player.player_position,
                fantasyTeam: player.team_id,
                espnStatus: 'lookup-failed',
                espnStats: null
            });
        }
    }

    // Fail only on ESPN-confirmed missing data; lookup failures and unchecked
    // players warn, so ESPN flakiness cannot hard-fail an automated run.
    const status = confirmedMissing.length > 0 ? 'failed' :
                   (unknownStatus.length > 0 || unchecked.length > 0) ? 'warning' : 'passed';
    const actuallyMissing = [...confirmedMissing, ...unknownStatus];

    return {
        name: 'Players with Missing Stats (ESPN Check)',
        status: status,
        message: playersWithoutStats.length === 0
            ? 'All active players with completed games have stats'
            : confirmedMissing.length > 0
                ? `${confirmedMissing.length} player(s) ESPN-confirmed missing stats (${playersWithoutStats.length} total without stats, ${unchecked.length} unchecked)`
                : `${playersWithoutStats.length} player(s) without stats: ${validReasons.length} valid reasons, ${unknownStatus.length} unknown, ${unchecked.length} unchecked`,
        value: confirmedMissing.length,
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
            ),
            ...(unchecked.length > 0
                ? [`Unchecked (beyond ESPN limit of ${ESPN_CHECK_LIMIT}): ${unchecked.slice(0, 10).map(p => p.player_name).join(', ')}${unchecked.length > 10 ? ` +${unchecked.length - 10} more` : ''}`]
                : [])
        ]
    };
}

// Export for use in tests and API (individual checks exported for unit testing)
module.exports = {
    validateEndOfWeek,
    checkTwoPointConversions,
    checkFewestYardsBonus,
    checkFewestPointsBonus,
    checkDefensiveTouchdowns,
    checkCumulativePoints,
    checkStandingsUpdated,
    checkStandingsWinLossDeltas
};

// Allow running directly from command line.
// Usage: node validateEndOfWeek.test.js [week] [season]
// Omitted args default to league_settings current_week / season_year.
if (require.main === module) {
    const week = process.argv[2] ? parseInt(process.argv[2]) : null;
    const season = process.argv[3] ? parseInt(process.argv[3]) : null;

    validateEndOfWeek(week, season).then(results => {
        console.log(JSON.stringify(results, null, 2));
        process.exit(results.overallStatus === 'passed' ? 0 : 1);
    }).catch(error => {
        console.error('Test failed:', error);
        process.exit(1);
    });
}