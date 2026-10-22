'use strict';

/**
 * Independent PFL scoring rubric for the Double Check job.
 *
 * Written from docs/SCORING_SYSTEM.md ONLY. This module deliberately does NOT
 * require scoringService (or any server/services scoring module) so that it
 * is a genuinely independent re-derivation of every fantasy_points value.
 * tests/unit/doublecheckTripwire.test.js enforces that.
 *
 * Rules (docs/SCORING_SYSTEM.md):
 *   Touchdown pass 5; touchdown scored (rush/rec) 8; 2-pt pass/run/rec 2 each.
 *   Passing yards tiers: 175->6, 250->9, 325->12, 400->15 (highest tier only).
 *   Rushing and receiving yard tiers: 50->3, 75->6, 100->9, 150->12, 200->15.
 *   Kicker: FG 2 flat (distance irrelevant), XP 0.5.
 *   Team Defense: TD 8 (int / fumble / blocked-kick returns), safety 2,
 *     least points allowed 5, least yards allowed 5 (split on ties; the split
 *     value is stored in def_points_bonus / def_yards_bonus).
 *   Kick or punt returner: TD 20.
 *   Nothing is negative. Receptions, INTs thrown, fumbles, sacks, def INTs,
 *   FG distance and attempts are worth 0.
 */

const PASSING_TIERS = [[400, 15], [325, 12], [250, 9], [175, 6]];
const YARDAGE_TIERS = [[200, 15], [150, 12], [100, 9], [75, 6], [50, 3]];

const POINTS = Object.freeze({
    PASS_TD: 5,
    TD: 8,
    TWO_PT: 2,
    FG: 2,
    XP: 0.5,
    DEF_TD: 8,
    SAFETY: 2,
    RETURN_TD: 20,
    DEF_BONUS: 5
});

function n(v) {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
}

function tierPoints(yards, tiers) {
    for (const [min, pts] of tiers) {
        if (yards >= min) return { points: pts, tier: min };
    }
    return { points: 0, tier: null };
}

function isDefense(position) {
    return position === 'DST' || position === 'DEF';
}

/**
 * Compute fantasy points for one stat row.
 * @param {object} row  player_stats-shaped object (column names as in the DB)
 * @param {string} position  nfl_players.position ('QB','RB','WR','TE','K','DST', ...).
 *        Required for DST rows: player_stats.position is empty in the DB, so
 *        callers MUST pass the joined nfl_players.position.
 * @returns {{points:number, breakdown:Array<{label:string, detail:string, points:number}>}}
 */
function pointsFor(row, position) {
    const b = [];
    let total = 0;
    const add = (label, detail, pts) => {
        if (pts) { b.push({ label, detail, points: pts }); total += pts; }
    };

    const passTd = n(row.passing_tds);
    add('passing_tds', `${passTd} x ${POINTS.PASS_TD}`, passTd * POINTS.PASS_TD);
    const rushTd = n(row.rushing_tds);
    add('rushing_tds', `${rushTd} x ${POINTS.TD}`, rushTd * POINTS.TD);
    const recTd = n(row.receiving_tds);
    add('receiving_tds', `${recTd} x ${POINTS.TD}`, recTd * POINTS.TD);

    const tpp = n(row.two_point_conversions_pass);
    add('two_point_conversions_pass', `${tpp} x ${POINTS.TWO_PT}`, tpp * POINTS.TWO_PT);
    const tpr = n(row.two_point_conversions_run);
    add('two_point_conversions_run', `${tpr} x ${POINTS.TWO_PT}`, tpr * POINTS.TWO_PT);
    const tpc = n(row.two_point_conversions_rec);
    add('two_point_conversions_rec', `${tpc} x ${POINTS.TWO_PT}`, tpc * POINTS.TWO_PT);

    const py = n(row.passing_yards);
    const pt = tierPoints(py, PASSING_TIERS);
    add('passing_yards', `${py} yds -> tier ${pt.tier ?? 'none'}`, pt.points);
    const ry = n(row.rushing_yards);
    const rt = tierPoints(ry, YARDAGE_TIERS);
    add('rushing_yards', `${ry} yds -> tier ${rt.tier ?? 'none'}`, rt.points);
    const cy = n(row.receiving_yards);
    const ct = tierPoints(cy, YARDAGE_TIERS);
    add('receiving_yards', `${cy} yds -> tier ${ct.tier ?? 'none'}`, ct.points);

    const fg = n(row.field_goals_made);
    add('field_goals_made', `${fg} x ${POINTS.FG}`, fg * POINTS.FG);
    const xp = n(row.extra_points_made);
    add('extra_points_made', `${xp} x ${POINTS.XP}`, xp * POINTS.XP);

    if (isDefense(position)) {
        const dInt = n(row.def_int_return_tds);
        add('def_int_return_tds', `${dInt} x ${POINTS.DEF_TD}`, dInt * POINTS.DEF_TD);
        const dFum = n(row.def_fumble_return_tds);
        add('def_fumble_return_tds', `${dFum} x ${POINTS.DEF_TD}`, dFum * POINTS.DEF_TD);
        const dBlk = n(row.def_blocked_return_tds);
        add('def_blocked_return_tds', `${dBlk} x ${POINTS.DEF_TD}`, dBlk * POINTS.DEF_TD);
        const saf = n(row.safeties);
        add('safeties', `${saf} x ${POINTS.SAFETY}`, saf * POINTS.SAFETY);
        const pb = n(row.def_points_bonus);
        add('def_points_bonus', 'least points allowed (5, split on ties)', pb);
        const yb = n(row.def_yards_bonus);
        add('def_yards_bonus', 'least yards allowed (5, split on ties)', yb);
    }

    const kr = n(row.kick_return_tds);
    add('kick_return_tds', `${kr} x ${POINTS.RETURN_TD}`, kr * POINTS.RETURN_TD);
    const pr = n(row.punt_return_tds);
    add('punt_return_tds', `${pr} x ${POINTS.RETURN_TD}`, pr * POINTS.RETURN_TD);
    const legacy = n(row.return_tds);
    add('return_tds (legacy)', `${legacy} x ${POINTS.RETURN_TD}`, legacy * POINTS.RETURN_TD);

    return { points: Math.round(total * 100) / 100, breakdown: b };
}

/**
 * Least-points / least-yards bonuses among a pool of DST rows.
 * @param {Array<{player_id:string, points_allowed:number|null, yards_allowed:number|null}>} pool
 * @returns {{points:Map<string,number>, yards:Map<string,number>, minPoints:number|null, minYards:number|null}}
 */
function defensiveBonuses(pool) {
    const result = { points: new Map(), yards: new Map(), minPoints: null, minYards: null };
    const withPa = pool.filter(r => r.points_allowed !== null && r.points_allowed !== undefined);
    const withYa = pool.filter(r => r.yards_allowed !== null && r.yards_allowed !== undefined);
    if (withPa.length) {
        const min = Math.min(...withPa.map(r => n(r.points_allowed)));
        const tied = withPa.filter(r => n(r.points_allowed) === min);
        result.minPoints = min;
        for (const r of tied) result.points.set(r.player_id, Math.round((POINTS.DEF_BONUS / tied.length) * 100) / 100);
    }
    if (withYa.length) {
        const min = Math.min(...withYa.map(r => n(r.yards_allowed)));
        const tied = withYa.filter(r => n(r.yards_allowed) === min);
        result.minYards = min;
        for (const r of tied) result.yards.set(r.player_id, Math.round((POINTS.DEF_BONUS / tied.length) * 100) / 100);
    }
    return result;
}

/** Markdown copy of the rules, embedded in every workspace so the auditor never needs docs/. */
const RUBRIC_MARKDOWN = `# PFL scoring rubric (verbatim from docs/SCORING_SYSTEM.md)

| Category | Points |
|---|---|
| Touchdown pass (thrown, by any player) | 5 |
| Touchdown scored (rushing or receiving, by any player) | 8 |
| Two-point conversion pass | 2 |
| Two-point conversion scored (run or reception) | 2 |
| Passing yards 175 / 250 / 325 / 400 | 6 / 9 / 12 / 15 (highest tier reached only, not cumulative) |
| Rushing yards 50 / 75 / 100 / 150 / 200 | 3 / 6 / 9 / 12 / 15 (highest tier only) |
| Receiving yards 50 / 75 / 100 / 150 / 200 | 3 / 6 / 9 / 12 / 15 (highest tier only) |
| Field goal (any distance) | 2 |
| Extra point | 0.5 |
| Team Defense touchdown (INT return, opponent's fumble, blocked punt/kick/FG, muffed punt recovered by coverage team) | 8 |
| Team Defense safety | 2 |
| Team Defense least points allowed this week (among ROSTERED defenses) | 5, split equally on ties |
| Team Defense least yards allowed this week (among ROSTERED defenses) | 5, split equally on ties |
| Kick or punt return touchdown (individual returner) | 20 |

Worth ZERO: receptions, interceptions thrown, fumbles, sacks, defensive interceptions,
fumble recoveries without a TD, FG distance, missed kicks. Nothing is ever negative.
Round to 2 decimals.

## Touchdown award rule (docs/SCORING_SYSTEM.md "Defensive Touchdowns - Exact Award Logic")

The determining question: **did the ball change possession on the play, or was the kick blocked?**

- Takeaway or blocked-kick TD (interception, opponent's fumble, blocked punt/FG/kick,
  muffed punt or returner's fumble recovered by the kicking team) -> **Team Defense +8**, individual 0.
- Regular kickoff or punt return TD (same possession) -> **individual returner +20**, Team Defense 0.
- Blocked punt / blocked FG returned for TD -> Team Defense +8 (NEVER 20).
- Offensive player recovers his own or a teammate's fumble in/into the end zone ->
  **offensive TD: recovering player +8**, Team Defense 0. (Own-fumble recoveries are already
  the player's rushing TD in NFL stats; a teammate's-fumble recovery must be added as a TD scored.)
- Laterals: the parser drops them; flag for commissioner ruling.
- Return TDs by players not in nfl_players (defensive backs etc. are not draftable) are credited
  to nobody by design - report as INFO, not as an error.

## Scoring lineup rule

From the 19-player roster, only players with roster_position = active. Best 13 by points:
1 QB, 4 RB, 4 WR/TE (interchangeable), 1 K, 1 BONUS (best remaining offensive player of any
position), plus 2 Team Defenses chosen NOT by points: DST_PA = rostered defense with the fewest
points allowed, DST_YA = rostered defense with the fewest yards allowed (a different one if
possible). Players with 0 points are never selected, so a lineup may legally have fewer than 13.
The team's official score = sum of the selected players' points (matchups.teamN_scoring_points).
`;

module.exports = { POINTS, PASSING_TIERS, YARDAGE_TIERS, pointsFor, tierPoints, defensiveBonuses, isDefense, RUBRIC_MARKDOWN };
