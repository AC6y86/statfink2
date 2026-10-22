#!/usr/bin/env node

/**
 * Podcast fact pack generator - the computed half of the PFL Live briefing
 * (/prepare-podcast-data).
 *
 * Usage: node scripts/podcast-data.js [season] [week] [--allow-incomplete] [--out <path>]
 *
 * With no arguments: the current season and its most recent COMPLETE week
 * (every NFL game Final and weekly_standings written).
 *
 * Produces podcast/{season}/data/week{NN}-facts.md, laid out in the briefing's
 * 13 sections. Everything that can be computed is computed here so no number
 * in the briefing is ever worked out by hand; the parts that need judgment
 * are left as `<!-- ANALYST: ... -->` markers for the skill to fill.
 *
 * League facts that shape the output:
 * - The scoring lineup is picked automatically (best scorers per slot), so
 *   there are no start/sit decisions. "Bench" here means active players who
 *   did not count.
 * - W-L records only move in weeks 1-12; head-to-head metrics use those weeks.
 * - There are no projections, waivers or FAAB in this league's data.
 *
 * The DB is opened READ-ONLY: this script can never corrupt the official
 * record and never contends with the live services' writes.
 */

const sqlite3 = require('sqlite3');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const DB_PATH = path.join(REPO, 'fantasy_football.db');
const VALIDATION_FILE = path.join(REPO, 'logs/weekly-validation-latest.json');
const HISTORY_DIR = path.join(REPO, 'podcast/history');
// Seasons whose team scores in fantasy_football.db are not the league's real
// ones. 2024 predates statfink2: its Team Defenses sit outside the scoring
// lineup there, so team totals and some results differ from the official 2024
// record. Team scores for these seasons are read from the official record.
const REFERENCE_TEAM_SCORES = { 2024: path.join(REPO, 'tests/2024/statfinkv1_2024.db') };
const REGULAR_SEASON_WEEKS = 12;
const POINTS_FINAL_WEEK = 17; // the points race is settled on week-17 cumulative points (server/routes/payouts.js)
const SLOT_ORDER = ['QB', 'RB1', 'RB2', 'RB3', 'RB4', 'WR/TE1', 'WR/TE2', 'WR/TE3', 'WR/TE4', 'K', 'BONUS', 'DST_PA', 'DST_YA'];
const SKILL = ['QB', 'RB', 'WR', 'TE'];
const SWING = 10;          // pts above/below a player's own prior average that makes a week notable
const CONTRIBUTOR_AVG = 8; // prior average that makes a zero worth reporting
const LUCK_GAP = 1;        // wins above/below expected that gets called out

// ---------- args ----------
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const positional = args.filter((a, i) => !a.startsWith('--') && (outIdx < 0 || i !== outIdx + 1));
const allowIncomplete = args.includes('--allow-incomplete');

if (args.includes('--help') || positional.some(a => !/^\d+$/.test(a))) {
    console.error('Usage: node scripts/podcast-data.js [season] [week] [--allow-incomplete] [--out <path>]');
    process.exit(1);
}

// ---------- tiny read-only db helpers ----------
const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, err => {
    if (err) {
        console.error(`Cannot open ${DB_PATH} read-only: ${err.message}`);
        process.exit(1);
    }
});
const all = (sql, params = []) => new Promise((res, rej) =>
    db.all(sql, params, (e, rows) => (e ? rej(e) : res(rows))));
const get = (sql, params = []) => new Promise((res, rej) =>
    db.get(sql, params, (e, row) => (e ? rej(e) : res(row))));

// Team scores from a season's official record (read-only), keyed by owner name
// because team ids differ between databases.
const referenceScores = file => new Promise((res, rej) => {
    const ref = new sqlite3.Database(file, sqlite3.OPEN_READONLY, err => {
        if (err) return rej(err);
        ref.all(`
            SELECT w.week, t.owner_name, w.weekly_points, w.wins, w.losses
            FROM weekly_team_totals w JOIN teams t ON t.team_id = w.team_id
        `, [], (e, rows) => {
            ref.close();
            return e ? rej(e) : res(rows);
        });
    });
});

// ---------- formatting ----------
const fmt = n => (n === null || n === undefined || Number.isNaN(n)) ? 'n/a'
    : String(Math.round(n * 100) / 100 || 0);
const signed = n => (n === null || n === undefined || Number.isNaN(n)) ? 'n/a' : `${Math.round(n * 100) > 0 ? '+' : ''}${fmt(n)}`;
const pts = n => `${fmt(n)} pt${Math.round(n * 100) === 100 ? '' : 's'}`;
const pct = n => (n === null || n === undefined || Number.isNaN(n)) ? 'n/a' : `${(n * 100).toFixed(1)}%`;
const rec = r => `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ''}`;
const avg = xs => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
const sum = xs => xs.reduce((s, x) => s + x, 0);
const table = (head, rows) => [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map(r => `| ${r.join(' | ')} |`)
];
// Competition ranking: tied rows share a rank and are marked "T".
const rankBy = (rows, better) => {
    const out = new Map();
    for (const r of rows) {
        const rank = 1 + rows.filter(o => better(o, r)).length;
        const tied = rows.some(o => o !== r && !better(o, r) && !better(r, o));
        out.set(r, { rank, label: `${tied ? 'T' : ''}${rank}` });
    }
    return out;
};
const streakOf = games => {
    if (!games || games.length === 0) return '-';
    let n = 1;
    const last = games[games.length - 1].res;
    for (let i = games.length - 2; i >= 0 && games[i].res === last; i--) n++;
    return `${last}${n}`;
};

async function main() {
    const settings = await get('SELECT season_year, current_week FROM league_settings LIMIT 1');
    const season = positional[0] ? parseInt(positional[0]) : settings.season_year;

    // ---------- which week ----------
    const teams = await all(`
        SELECT t.team_id, t.team_name, t.owner_name,
               COALESCE(sta.division, t.division) as division, sta.draft_slot
        FROM teams t
        LEFT JOIN season_team_assignments sta ON sta.team_id = t.team_id AND sta.season = ?
        ORDER BY t.team_id
    `, [season]);
    const N = teams.length;
    const divisionsFromSeason = teams.some(t => t.draft_slot !== null);
    const gameStatus = await all(`
        SELECT week, COUNT(*) as total,
               SUM(CASE WHEN status LIKE 'Final%' THEN 1 ELSE 0 END) as final
        FROM nfl_games WHERE season = ? GROUP BY week
    `, [season]);
    const standingsWeeks = await all(
        'SELECT week, COUNT(*) as n FROM weekly_standings WHERE season = ? GROUP BY week', [season]);
    const gamesFinal = w => {
        const g = gameStatus.find(x => x.week === w);
        return !!g && g.total > 0 && g.final === g.total;
    };
    const hasStandings = w => (standingsWeeks.find(x => x.week === w) || {}).n === N;
    const completeWeeks = gameStatus.map(g => g.week).filter(w => gamesFinal(w) && hasStandings(w));

    let week = positional[1] ? parseInt(positional[1]) : null;
    if (!week) {
        if (completeWeeks.length === 0) {
            console.error(`No complete week found for ${season} (needs every NFL game Final and weekly_standings written).`);
            process.exit(1);
        }
        week = Math.max(...completeWeeks);
    }
    const weekComplete = completeWeeks.includes(week);
    if (!weekComplete && !allowIncomplete) {
        const g = gameStatus.find(x => x.week === week);
        console.error(`${season} week ${week} is not complete ` +
            `(${g ? `${g.final}/${g.total} NFL games final` : 'no NFL games found'}, ` +
            `weekly_standings ${hasStandings(week) ? 'written' : 'not written'}). ` +
            (completeWeeks.length ? `Latest complete week is ${Math.max(...completeWeeks)}. ` : '') +
            'Pass --allow-incomplete to build a partial fact pack anyway.');
        process.exit(1);
    }

    const outPath = outIdx >= 0 ? args[outIdx + 1]
        : path.join(REPO, `podcast/${season}/data/week${String(week).padStart(2, '0')}-facts.md`);
    const quality = [];   // DATA QUALITY NOTES, collected as we go
    const owner = id => (teams.find(t => t.team_id === id) || {}).owner_name || `team ${id}`;
    const teamLabel = id => {
        const t = teams.find(x => x.team_id === id);
        return t ? `${t.owner_name} (${t.team_name})` : `team ${id}`;
    };

    // ---------- validation status (informational) ----------
    let validationNote;
    try {
        const v = JSON.parse(fs.readFileSync(VALIDATION_FILE, 'utf8'));
        validationNote = (v.season === season && v.week === week)
            ? `${v.overallStatus} (run ${v.runAt})`
            : `no record for this week (latest validation is ${v.season} week ${v.week}: ${v.overallStatus})`;
        if (v.season === season && v.week === week && !['PASS', 'WARN'].includes(v.overallStatus)) {
            quality.push(`Weekly validation for this week is ${v.overallStatus} - treat every number as provisional.`);
        }
    } catch (e) {
        validationNote = `unavailable (${e.message})`;
    }
    if (!divisionsFromSeason) quality.push(`No division assignments are stored for ${season}; divisions shown are the current ones from the teams table.`);
    if (!weekComplete) quality.push(`Week ${week} was NOT complete when this was generated - scores are partial.`);

    // ---------- matchups, week points, head-to-head games ----------
    const allMatchups = await all(`
        SELECT season, week, team1_id, team2_id, is_playoff,
               team1_scoring_points as p1, team2_scoring_points as p2
        FROM matchups ORDER BY season, week, matchup_id
    `);
    const unverified = [];  // past seasons whose team results could not be trusted
    for (const s of Object.keys(REFERENCE_TEAM_SCORES).map(Number)) {
        const rows = allMatchups.filter(m => m.season === s);
        if (rows.length === 0) continue;
        try {
            const ref = await referenceScores(REFERENCE_TEAM_SCORES[s]);
            const idOf = name => (teams.find(t => t.owner_name === name) || {}).team_id;
            const score = {}, record = {};
            for (const r of ref) {
                score[`${r.week}|${idOf(r.owner_name)}`] = r.weekly_points;
                if (r.week === REGULAR_SEASON_WEEKS) record[idOf(r.owner_name)] = r;
            }
            let changed = 0;
            const tally = {};
            for (const m of rows) {
                for (const [side, id] of [['p1', m.team1_id], ['p2', m.team2_id]]) {
                    const official = score[`${m.week}|${id}`];
                    if (official === undefined) throw new Error(`no official score for ${owner(id)} week ${m.week}`);
                    if (Math.abs(official - m[side]) > 0.005) changed++;
                    m[side] = official;
                }
                if (m.week > REGULAR_SEASON_WEEKS || m.is_playoff) continue;
                for (const [id, mine, theirs] of [[m.team1_id, m.p1, m.p2], [m.team2_id, m.p2, m.p1]]) {
                    const t = (tally[id] = tally[id] || { wins: 0, losses: 0, ties: 0 });
                    if (mine > theirs) t.wins++; else if (mine < theirs) t.losses++; else t.ties++;
                }
            }
            const off = teams.filter(t => !record[t.team_id] || !tally[t.team_id] ||
                record[t.team_id].wins !== tally[t.team_id].wins || record[t.team_id].losses !== tally[t.team_id].losses);
            if (off.length) throw new Error(`records rebuilt from its scores do not match its own week-${REGULAR_SEASON_WEEKS} records for ${off.map(t => t.owner_name).join(', ')}`);
            quality.push(`${s} team scores come from the official ${s} record (${path.relative(REPO, REFERENCE_TEAM_SCORES[s])}), not fantasy_football.db: ` +
                `${changed} of ${rows.length * 2} team scores in fantasy_football.db differ from it. ` +
                `Records rebuilt from the official scores match the official week-${REGULAR_SEASON_WEEKS} records for all ${teams.length} teams.`);
        } catch (e) {
            unverified.push(s);
            quality.push(`${s} is left out of team history (head-to-head, streaks, team scoring records, final standings): ` +
                `its team scores in fantasy_football.db are not the official ones and the official record could not be used (${e.message}).`);
        }
    }
    const played = allMatchups.filter(m =>
        (m.season < season && !unverified.includes(m.season)) || (m.season === season && m.week <= week));
    if (REFERENCE_TEAM_SCORES[season]) {
        quality.push(`${season} team scores come from the official ${season} record, but lineups come from fantasy_football.db, whose ${season} lineups leave out Team Defenses - expect lineup totals that do not match the official scores.`);
    }
    const weekPts = {};   // season -> week -> team_id -> points
    const games = {};     // season -> team_id -> regular-season head-to-head games
    const bracket = [];   // rows flagged is_playoff
    for (const m of played) {
        const byWeek = (weekPts[m.season] = weekPts[m.season] || {});
        const byTeam = (byWeek[m.week] = byWeek[m.week] || {});
        for (const [id, p] of [[m.team1_id, m.p1], [m.team2_id, m.p2]]) {
            if (byTeam[id] !== undefined && Math.abs(byTeam[id] - p) > 0.005) {
                quality.push(`${m.season} week ${m.week}: ${owner(id)} has two different scores in matchups (${fmt(byTeam[id])} and ${fmt(p)}).`);
            }
            byTeam[id] = p;
        }
        if (m.is_playoff) { bracket.push(m); continue; }
        if (m.week > REGULAR_SEASON_WEEKS) continue;
        const res1 = m.p1 > m.p2 ? 'W' : m.p1 < m.p2 ? 'L' : 'T';
        const res2 = res1 === 'W' ? 'L' : res1 === 'L' ? 'W' : 'T';
        const bySeason = (games[m.season] = games[m.season] || {});
        (bySeason[m.team1_id] = bySeason[m.team1_id] || []).push({ season: m.season, week: m.week, res: res1, opp: m.team2_id, pf: m.p1, pa: m.p2 });
        (bySeason[m.team2_id] = bySeason[m.team2_id] || []).push({ season: m.season, week: m.week, res: res2, opp: m.team1_id, pf: m.p2, pa: m.p1 });
    }
    const thisWeek = played.filter(m => m.season === season && m.week === week);
    if (thisWeek.length === 0) {
        console.error(`No matchups found for ${season} week ${week}.`);
        process.exit(1);
    }
    const playoffWeek = week > REGULAR_SEASON_WEEKS;
    const h2hWeeks = Math.min(week, REGULAR_SEASON_WEEKS);
    const ptsOf = (teamId, w, s = season) => ((weekPts[s] || {})[w] || {})[teamId];

    // All-play: a team's score against every other team's score that week.
    const allPlayWeek = (w, s = season) => {
        const pts = (weekPts[s] || {})[w] || {};
        const out = {};
        for (const id of Object.keys(pts)) {
            const others = Object.keys(pts).filter(o => o !== id).map(o => pts[o]);
            out[id] = {
                wins: others.filter(p => p < pts[id]).length,
                losses: others.filter(p => p > pts[id]).length,
                ties: others.filter(p => p === pts[id]).length,
                n: others.length
            };
        }
        return out;
    };

    const snapshot = w => {
        const rows = teams.map(t => {
            const g = ((games[season] || {})[t.team_id] || []).filter(x => x.week <= w);
            const scores = [];
            for (let i = 1; i <= w; i++) {
                const p = ptsOf(t.team_id, i);
                if (p !== undefined) scores.push(p);
            }
            const ap = { wins: 0, losses: 0, ties: 0 };
            let xw = 0;
            for (let i = 1; i <= w; i++) {
                const r = allPlayWeek(i)[t.team_id];
                if (!r) continue;
                ap.wins += r.wins; ap.losses += r.losses; ap.ties += r.ties;
                if (i <= REGULAR_SEASON_WEEKS && r.n > 0) xw += (r.wins + 0.5 * r.ties) / r.n;
            }
            let highScores = 0;
            for (let i = 1; i <= w; i++) {
                const r = allPlayWeek(i)[t.team_id];
                if (r && r.losses === 0) highScores++;
            }
            return {
                team_id: t.team_id, owner: t.owner_name, team_name: t.team_name, division: t.division,
                games: g, scores, highScores,
                wins: g.filter(x => x.res === 'W').length,
                losses: g.filter(x => x.res === 'L').length,
                ties: g.filter(x => x.res === 'T').length,
                pf: sum(scores), pa: sum(g.map(x => x.pa)),
                allPlay: ap, xw
            };
        });
        const site = rankBy(rows, (a, b) => a.wins > b.wins || (a.wins === b.wins && a.pf > b.pf));
        const byPf = rankBy(rows, (a, b) => a.pf > b.pf);
        const byPa = rankBy(rows, (a, b) => a.pa > b.pa);
        for (const r of rows) {
            r.site = site.get(r); r.ptsRank = byPf.get(r); r.paRank = byPa.get(r);
            r.luck = r.wins + 0.5 * r.ties - r.xw;
        }
        return rows.sort((a, b) => a.site.rank - b.site.rank || b.pf - a.pf);
    };
    const now = snapshot(week);
    const prev = week > 1 ? snapshot(week - 1) : [];
    const cur = id => now.find(r => r.team_id === id);
    const was = id => prev.find(r => r.team_id === id);
    const seasonAvg = id => avg(cur(id).scores);
    const last3 = id => cur(id).scores.length > 3 ? avg(cur(id).scores.slice(-3)) : null;
    const fmt3 = id => last3(id) === null ? 'n/a (needs 4+ weeks)' : fmt(last3(id));

    // Cross-check against the stored standings.
    const stored = await all(
        'SELECT team_id, wins, losses, ties, cumulative_points FROM weekly_standings WHERE season = ? AND week = ?',
        [season, week]);
    if (stored.length === 0) {
        quality.push(`weekly_standings has no rows for week ${week}; standings here are computed from matchups.`);
    }
    for (const s of stored) {
        const r = cur(s.team_id);
        if (!r) continue;
        if (s.wins !== r.wins || s.losses !== r.losses || s.ties !== r.ties || Math.abs(s.cumulative_points - r.pf) > 0.01) {
            quality.push(`INCONSISTENCY: ${r.owner} - weekly_standings says ${rec(s)}, ${fmt(s.cumulative_points)} pts; ` +
                `matchups add up to ${rec(r)}, ${fmt(r.pf)} pts.`);
        }
    }

    // ---------- rosters and player stats ----------
    const rosterSql = `
        SELECT wr.team_id, wr.player_id, wr.player_name, wr.player_position, wr.player_team,
               wr.roster_position, wr.is_scoring, wr.scoring_slot, wr.ir_date,
               ps.fantasy_points as pts, ps.stat_id
        FROM weekly_rosters wr
        LEFT JOIN player_stats ps ON ps.player_id = wr.player_id
            AND ps.week = wr.week AND ps.season = wr.season
        WHERE wr.season = ? AND wr.week = ?
    `;
    const roster = await all(rosterSql, [season, week]);
    const rosterPrev = week > 1 ? await all(rosterSql, [season, week - 1]) : [];
    const latestRosterWeek = (await get('SELECT MAX(week) as w FROM weekly_rosters WHERE season = ?', [season])).w;
    const nextRosterWeek = Math.min(latestRosterWeek, week + 1);
    const rosterNext = nextRosterWeek === week ? roster : await all(rosterSql, [season, nextRosterWeek]);
    const active = (rows, teamId) => rows.filter(r => r.team_id === teamId && r.roster_position === 'active');
    const counted = (rows, teamId) => rows.filter(r => r.team_id === teamId && r.is_scoring === 1)
        .sort((a, b) => SLOT_ORDER.indexOf(a.scoring_slot) - SLOT_ORDER.indexOf(b.scoring_slot));
    const uncounted = (rows, teamId) => active(rows, teamId).filter(r => r.is_scoring !== 1 && (r.pts || 0) > 0)
        .sort((a, b) => b.pts - a.pts);
    const player = r => `${r.player_name} (${r.player_position}, ${r.player_team})`;

    const short = teams.map(t => ({ t, n: active(roster, t.team_id).length })).filter(x => x.n !== 19);
    if (short.length) {
        quality.push(`INCONSISTENCY: ${short.length} team${short.length === 1 ? '' : 's'} without exactly 19 active players in week ${week} ` +
            `(league rule: 19): ${short.map(x => `${x.t.owner_name} ${x.n}`).join(', ')}.`);
    }
    for (const t of teams) {
        const lineupTotal = sum(counted(roster, t.team_id).map(r => r.pts || 0));
        const official = ptsOf(t.team_id, week);
        if (official !== undefined && Math.abs(lineupTotal - official) > 0.01) {
            quality.push(`INCONSISTENCY: ${t.owner_name}'s scoring lineup adds up to ${fmt(lineupTotal)} but the official score is ${fmt(official)}.`);
        }
    }

    const priorRows = await all(
        'SELECT player_id, week, fantasy_points as pts FROM player_stats WHERE season = ? AND week <= ? ORDER BY week',
        [season, week]);
    const statLine = {};  // player_id -> [{week, pts}] for games with a stat line
    for (const r of priorRows) (statLine[r.player_id] = statLine[r.player_id] || []).push(r);
    const prior = id => (statLine[id] || []).filter(x => x.week < week).map(x => x.pts || 0);
    const priorAvg = id => avg(prior(id));
    const vsPrior = r => (r.stat_id === null || prior(r.player_id).length === 0) ? null : (r.pts || 0) - priorAvg(r.player_id);
    const priorNote = r => `prior avg ${fmt(priorAvg(r.player_id))} over ${prior(r.player_id).length} game${prior(r.player_id).length === 1 ? '' : 's'}`;

    const nflTeams = new Set();
    const playingIn = {};  // week -> Set of NFL teams with a game
    for (const g of await all('SELECT week, home_team, away_team FROM nfl_games WHERE season = ?', [season])) {
        nflTeams.add(g.home_team); nflTeams.add(g.away_team);
        (playingIn[g.week] = playingIn[g.week] || new Set()).add(g.home_team).add(g.away_team);
    }
    const onBye = (nflTeam, w) => playingIn[w] ? (nflTeams.has(nflTeam) && !playingIn[w].has(nflTeam)) : null;

    const injuryRows = await all(`
        SELECT player_id, injury_designation, injury_description FROM nfl_players
        WHERE injury_designation IS NOT NULL AND injury_designation != ''
    `);
    const injury = Object.fromEntries(injuryRows.map(r => [r.player_id, r]));

    const shareRows = await all(`
        SELECT wr.team_id,
               SUM(CASE WHEN wr.is_scoring = 1 THEN COALESCE(ps.fantasy_points, 0) ELSE 0 END) as counted,
               SUM(COALESCE(ps.fantasy_points, 0)) as total
        FROM weekly_rosters wr
        LEFT JOIN player_stats ps ON ps.player_id = wr.player_id
            AND ps.week = wr.week AND ps.season = wr.season
        WHERE wr.season = ? AND wr.week <= ? AND wr.roster_position = 'active'
        GROUP BY wr.team_id
    `, [season, week]);
    const seasonShare = Object.fromEntries(shareRows.map(r => [r.team_id, r.total ? r.counted / r.total : null]));
    const weekShare = id => {
        const total = sum(active(roster, id).map(r => r.pts || 0));
        return total ? sum(counted(roster, id).map(r => r.pts || 0)) / total : null;
    };
    const leftOut = id => sum(uncounted(roster, id).map(r => r.pts));

    // ---------- build the fact pack ----------
    const L = [];
    const push = (...lines) => L.push(...lines);
    const analyst = text => push(`<!-- ANALYST: ${text} -->`, '');

    push(`# PFL Live — ${season} Week ${week} Data Briefing`, '');
    push(`- Generated: ${new Date().toISOString()}`);
    push(`- Source: fantasy_football.db (the league's official record), read-only`);
    push(`- Weekly validation: ${validationNote}`);
    push(`- Week status: ${weekComplete ? 'complete (every NFL game final)' : 'IN PROGRESS - scores are partial'}`, '');

    // 1
    push('## 1. LEAGUE CONTEXT', '');
    push(...table(['Item', 'Value'], [
        ['League', 'Peninsula Football League (PFL)'],
        ['Season', String(season)],
        ['Week covered', `${week} (${playoffWeek ? 'playoff weeks: W-L records are frozen at their week-12 values' : `regular season, head-to-head weeks 1-${REGULAR_SEASON_WEEKS}`})`],
        ['League "current week" setting', String(settings.current_week)],
        ['Teams', `${N}, in two divisions (Odd / Even, by draft slot)`],
        ['Roster', '19 active players per team every week; a player is either Active or on Injured Reserve'],
        ['Roster minimums', '2 QB, 5 RB, 6 WR/TE, 2 K, 2 DEF'],
        ['Scoring lineup', '13 slots: 1 QB, 4 RB, 4 WR/TE, 1 K, 1 Bonus (best remaining offensive player), 2 Team Defense'],
        ['Lineup selection', 'AUTOMATIC: the highest scorers at each slot count. Owners make no start/sit decisions'],
        ['Scoring format', 'Custom, no points per reception. TD scored 8, TD pass 5, 2-pt conversion 2. Yardage pays only at thresholds: passing 175/250/325/400 yds = 6/9/12/15; rushing and receiving 50/75/100/150/200 yds = 3/6/9/12/15. Kicker: FG 2, extra point 0.5. Team Defense: TD 8, safety 2, plus 5 each for fewest points allowed and fewest yards allowed among the drafted defenses (ties split). Kick or punt return TD: 20 to the returner'],
        ['Standings order on the site', 'Wins, then cumulative points'],
        ['Points race', `Cumulative points (the "PFL Cup"), settled on the week-${POINTS_FINAL_WEEK} total`],
        ['Playoff format', `Head-to-head ends after week ${REGULAR_SEASON_WEEKS}. Seeds 1-2: top team in each division; seeds 3-4: next team in each division; seeds 5-8: next four by cumulative points. Week 13: 5v8, 6v7 (seeds 1-4 bye). Week 14: seed 3 and seed 4 play the week-13 winners (seeds 1-2 bye). Week 15: seeds 1-2 play the week-14 winners. Week 16: winners play for 1st/2nd, losers for the next place. Week 17: no head-to-head, cumulative points only`],
        ['Injured Reserve rule', 'A player must stay on IR at least 3 weeks before he can be brought back'],
        ['Roster moves', 'IR moves, supplemental (drop/add) moves and trades. No waivers, no FAAB'],
        ['Prizes', `Paid for the weekly high score (every week), the top 6 in cumulative points through week ${POINTS_FINAL_WEEK}, and the top 4 in the head-to-head playoffs. Each IR move carries a fee that funds an extra pool split among the top 3 in points and the top 3 in head-to-head`],
        ['Projections', 'None exist in the league data']
    ]), '');

    // 2
    push('## 2. CURRENT STANDINGS', '');
    push(`Through week ${week}. "Rank" is the site order (wins, then cumulative points); "Pts rank" is the points race. T = tied.`, '');
    push(...table(
        ['Rank', 'Team', 'Owner', 'Div', 'Record', 'PF', 'Pts rank', 'PA', 'Prev rank', 'Prev pts rank', 'Streak'],
        now.map(r => [
            r.site.label, r.team_name, r.owner, r.division || 'n/a', rec(r), fmt(r.pf), r.ptsRank.label, fmt(r.pa),
            was(r.team_id) ? was(r.team_id).site.label : '-',
            was(r.team_id) ? was(r.team_id).ptsRank.label : '-',
            streakOf(r.games)
        ])), '');
    if (playoffWeek) push(`PA and streaks cover head-to-head weeks 1-${REGULAR_SEASON_WEEKS} only.`, '');
    for (const div of [...new Set(now.map(r => r.division).filter(Boolean))].sort()) {
        push(`**${div} division** (site order): ` +
            now.filter(r => r.division === div).map(r => `${r.owner} ${rec(r)}, ${fmt(r.pf)}`).join('; '), '');
    }

    // 3
    push(`## 3. THIS WEEK'S RESULTS`, '');
    push('No pre-game projections exist, so "favorite/underdog" is given as who entered the week higher in the standings.',
        'The lineup is automatic: "did not count" lists active players who scored but were outside the 13 scoring slots.',
        'Offensive slots are filled only by players who scored, so a slot can be empty. The two Team Defense slots are always filled, even by a defense with 0.',
        'DST_PA and DST_YA are slot names (the roster\'s defense with the fewest points allowed, then its other defense). They do NOT say which bonus a defense earned.', '');
    const results = thisWeek.map(m => {
        const winner = m.p1 > m.p2 ? m.team1_id : m.p2 > m.p1 ? m.team2_id : null;
        const loser = winner === null ? null : winner === m.team1_id ? m.team2_id : m.team1_id;
        return { ...m, winner, loser, margin: Math.abs(m.p1 - m.p2) };
    });
    const moves = await all(`
        SELECT rm.*, t.owner_name, pt.owner_name as partner_owner
        FROM roster_moves rm
        JOIN teams t ON t.team_id = rm.team_id
        LEFT JOIN teams pt ON pt.team_id = rm.partner_team_id
        WHERE rm.season = ? AND rm.week IN (?, ?)
        ORDER BY rm.move_timestamp
    `, [season, week, week + 1]);
    const weekPtsOfPlayer = id => {
        const s = (statLine[id] || []).find(x => x.week === week);
        return s ? (s.pts || 0) : null;
    };
    const onRoster = (teamId, playerId) => roster.find(r => r.team_id === teamId && r.player_id === playerId);
    const playerWeek = (teamId, playerId, name) => {
        const r = onRoster(teamId, playerId);
        const p = weekPtsOfPlayer(playerId);
        if (p === null) return `${name}: no week-${week} stat line`;
        return `${name}: ${pts(p)} in week ${week}` +
            (r ? ` (${r.is_scoring === 1 ? 'counted' : 'did not count'} for ${owner(teamId)})` : '');
    };

    for (const m of results) {
        push(`### ${owner(m.team1_id)} ${fmt(m.p1)} - ${fmt(m.p2)} ${owner(m.team2_id)}${m.is_playoff ? ' (playoff bracket game)' : ''}`, '');
        push(`- Teams: ${teamLabel(m.team1_id)} vs ${teamLabel(m.team2_id)}`);
        push(m.winner === null ? `- Result: TIE at ${fmt(m.p1)}`
            : `- Winner: ${owner(m.winner)}. Loser: ${owner(m.loser)}. Margin: ${fmt(m.margin)}`);
        push('- Pre-game projection: not available');
        if (week > 1 && m.winner !== null) {
            const a = was(m.winner), b = was(m.loser);
            push(`- Entering the week: ${a.owner} was ${rec(a)}, rank ${a.site.label}, ${fmt(avg(a.scores))} pts/wk; ` +
                `${b.owner} was ${rec(b)}, rank ${b.site.label}, ${fmt(avg(b.scores))} pts/wk. ` +
                (a.site.rank === b.site.rank ? 'They were level in the standings.'
                    : `The ${a.site.rank < b.site.rank ? 'higher' : 'lower'}-ranked team won.`));
        }
        for (const id of [m.team1_id, m.team2_id]) {
            const lineup = counted(roster, id);
            push('', `**${owner(id)}** — ${fmt(ptsOf(id, week))} pts`, '');
            push(`- Scoring lineup: ${lineup.map(r => `${r.scoring_slot} ${r.player_name} ${fmt(r.pts || 0)}`).join('; ')}`);
            push(`- Top scorers: ${[...lineup].sort((a, b) => (b.pts || 0) - (a.pts || 0)).slice(0, 3).map(r => `${player(r)} ${fmt(r.pts || 0)}`).join('; ')}`);
            const empty = SLOT_ORDER.filter(s => !lineup.some(r => r.scoring_slot === s));
            if (empty.length) push(`- Scoring slots left empty (no eligible player scored): ${empty.join(', ')}`);
            const out = uncounted(roster, id);
            push(`- Did not count: ${out.length ? out.map(r => `${player(r)} ${fmt(r.pts)}`).join('; ') : 'none'}`);
            push(`- Points that did not count: ${fmt(leftOut(id))}. Counted share of all active-roster points: ${pct(weekShare(id))}`);
            const drops = active(roster, id).filter(r => vsPrior(r) !== null && vsPrior(r) <= -SWING)
                .sort((a, b) => vsPrior(a) - vsPrior(b));
            push(`- ${SWING}+ below own prior average: ${drops.length
                ? drops.map(r => `${player(r)} ${fmt(r.pts || 0)} (${priorNote(r)})`).join('; ')
                : (week === 1 ? 'n/a in week 1' : 'none')}`);
            const low = lineup.filter(r => SKILL.includes(r.player_position) && (r.pts || 0) <= 2);
            if (low.length) push(`- Counted with 2 pts or fewer: ${low.map(r => `${player(r)} ${fmt(r.pts || 0)}`).join('; ')}`);
            const zeros = active(roster, id).filter(r => (r.pts || 0) === 0 && prior(r.player_id).length > 0 && priorAvg(r.player_id) >= CONTRIBUTOR_AVG);
            if (zeros.length) {
                push(`- Scored 0 despite a prior average of ${CONTRIBUTOR_AVG}+: ` + zeros.map(r => {
                    const why = onBye(r.player_team, week) ? 'NFL team had no game'
                        : r.stat_id === null ? 'no stat line' : 'has a stat line worth 0';
                    const inj = injury[r.player_id] ? `; currently ${injury[r.player_id].injury_designation}` : '';
                    return `${player(r)} (${priorNote(r)}; ${why}${inj})`;
                }).join('; '));
            }
            const mine = moves.filter(x => x.week === week && (x.team_id === id || x.partner_team_id === id));
            for (const x of mine) {
                const mineIsDropper = x.team_id === id;
                const got = mineIsDropper ? [x.added_player_id, x.added_player_name] : [x.dropped_player_id, x.dropped_player_name];
                push(`- Roster move effective this week (${x.move_type}): added ${playerWeek(id, got[0], got[1])}`);
            }
        }
        const involved = moves.filter(x => x.week === week &&
            [x.team_id, x.partner_team_id].some(id => id === m.team1_id || id === m.team2_id));
        push('', '- Optimal lineup score: equal to the actual score by rule (the lineup is selected automatically).');
        push(`- Lineup decisions: none exist in this league. Roster moves that took effect this week for these two teams: ${involved.length ? `${involved.length}, listed per team above` : 'none'}.`, '');
    }

    // 4
    push('## 4. WEEKLY SUPERLATIVES', '');
    const teamScores = teams.map(t => ({ id: t.team_id, pts: ptsOf(t.team_id, week) })).filter(x => x.pts !== undefined)
        .sort((a, b) => b.pts - a.pts);
    const leagueAvgWeek = avg(teamScores.map(x => x.pts));
    const decided = results.filter(m => m.winner !== null);
    const byMargin = [...results].sort((a, b) => a.margin - b.margin);
    const allCounted = roster.filter(r => r.is_scoring === 1).sort((a, b) => (b.pts || 0) - (a.pts || 0));
    const allActive = roster.filter(r => r.roster_position === 'active');
    const topUncounted = allActive.filter(r => r.is_scoring !== 1).sort((a, b) => (b.pts || 0) - (a.pts || 0))[0];
    const worstDrop = allActive.filter(r => vsPrior(r) !== null).sort((a, b) => vsPrior(a) - vsPrior(b))[0];
    const upsets = week > 1 ? decided
        .map(m => ({ m, gap: was(m.winner).site.rank - was(m.loser).site.rank }))
        .filter(x => x.gap > 0).sort((a, b) => b.gap - a.gap) : [];
    const shares = teams.map(t => ({ id: t.team_id, share: weekShare(t.team_id), left: leftOut(t.team_id) }))
        .filter(x => x.share !== null);
    const sup = [];
    const top = teamScores[0], bottom = teamScores[teamScores.length - 1];
    sup.push(['Highest team score', `${owner(top.id)}, ${fmt(top.pts)}`]);
    sup.push(['Lowest team score', `${owner(bottom.id)}, ${fmt(bottom.pts)}`]);
    sup.push(['League average score', fmt(leagueAvgWeek)]);
    const line = m => `${owner(m.team1_id)} ${fmt(m.p1)} - ${fmt(m.p2)} ${owner(m.team2_id)} (margin ${fmt(m.margin)})`;
    sup.push(['Closest matchup', line(byMargin[0])]);
    sup.push(['Largest blowout', line(byMargin[byMargin.length - 1])]);
    sup.push(['Biggest upset versus projection', 'not calculable (no projections)']);
    sup.push(['Biggest upset versus standings', week === 1 ? 'n/a in week 1'
        : upsets.length === 0 ? 'none (no lower-ranked team won)'
            : upsets.filter(u => u.gap === upsets[0].gap).map(u =>
                `${owner(u.m.winner)} (entered rank ${was(u.m.winner).site.label}) beat ${owner(u.m.loser)} (entered rank ${was(u.m.loser).site.label}), ${fmt(ptsOf(u.m.winner, week))}-${fmt(ptsOf(u.m.loser, week))}`)
                .join('; ') + ` (${upsets[0].gap} places${upsets.filter(u => u.gap === upsets[0].gap).length > 1 ? ', tied' : ''})`]);
    sup.push(['Best individual performance', allCounted[0]
        ? `${player(allCounted[0])}, ${fmt(allCounted[0].pts)} for ${owner(allCounted[0].team_id)}` : 'n/a']);
    sup.push(['Best performance that did not count', topUncounted && topUncounted.pts > 0
        ? `${player(topUncounted)}, ${fmt(topUncounted.pts)} for ${owner(topUncounted.team_id)}` : 'none']);
    sup.push(['Largest drop from own prior average', worstDrop
        ? `${player(worstDrop)}, ${fmt(worstDrop.pts || 0)} for ${owner(worstDrop.team_id)} (${priorNote(worstDrop)})`
        : 'n/a (no prior games)']);
    if (shares.length) {
        const byLeft = [...shares].sort((a, b) => b.left - a.left);
        const byShare = [...shares].sort((a, b) => b.share - a.share);
        sup.push(['Most points that did not count', `${owner(byLeft[0].id)}, ${fmt(byLeft[0].left)}`]);
        sup.push(['Highest counted share', `${owner(byShare[0].id)}, ${pct(byShare[0].share)}`]);
        sup.push(['Lowest counted share', `${owner(byShare[byShare.length - 1].id)}, ${pct(byShare[byShare.length - 1].share)}`]);
    }
    push(...table(['Superlative', 'Fact'], sup), '');
    push('Counted share = points in the scoring lineup / points by all active players. It reflects roster depth, not a lineup decision.', '');
    push('**Top 10 individual performances (counted):**', '');
    allCounted.slice(0, 10).forEach((r, i) => push(`${i + 1}. ${player(r)} — ${fmt(r.pts || 0)} for ${owner(r.team_id)}`));
    push('');

    // 5
    push('## 5. TEAM PERFORMANCE METRICS', '');
    const leagueAvgSeason = avg(now.flatMap(r => r.scores));
    const remaining = allMatchups.filter(m => m.season === season && m.week > week && m.week <= REGULAR_SEASON_WEEKS && !m.is_playoff);
    const sosPast = id => avg(cur(id).games.map(g => seasonAvg(g.opp)));
    const sosFuture = id => avg(remaining.filter(m => m.team1_id === id || m.team2_id === id)
        .map(m => seasonAvg(m.team1_id === id ? m.team2_id : m.team1_id)));
    push(`Through week ${week}. League average score per team-week this season: ${fmt(leagueAvgSeason)}.`, '');
    push(...table(
        ['Owner', 'Record', 'Avg score', 'Last 3 avg', 'PF rank', 'PA rank (1 = most against)', 'Avg margin', 'Weekly high scores', 'Weekly scores'],
        now.map(r => [
            r.owner, rec(r), fmt(seasonAvg(r.team_id)), fmt3(r.team_id), r.ptsRank.label, r.paRank.label,
            signed(avg(r.games.map(g => g.pf - g.pa))), String(r.highScores), r.scores.map(fmt).join(', ')
        ])), '');
    push(...table(
        ['Owner', 'All-play record', 'All-play win %', 'Expected wins', 'Actual wins', 'Actual - expected', 'Opp avg faced (SOS)', 'Opp avg remaining', 'Trend (last 3 - season avg)', 'Counted share (season)'],
        now.map(r => [
            r.owner, rec(r.allPlay),
            pct((r.allPlay.wins + 0.5 * r.allPlay.ties) / ((r.allPlay.wins + r.allPlay.losses + r.allPlay.ties) || 1)),
            fmt(r.xw), fmt(r.wins + 0.5 * r.ties), signed(r.luck),
            fmt(sosPast(r.team_id)), fmt(sosFuture(r.team_id)),
            r.scores.length > 3 ? signed(last3(r.team_id) - seasonAvg(r.team_id)) : 'n/a (needs 4+ weeks)',
            pct(seasonShare[r.team_id])
        ])), '');
    push('Definitions:', '');
    push('- All-play record: the record a team would have if it played every other team every week.');
    push(`- Expected wins: all-play win % summed week by week over head-to-head weeks (1-${REGULAR_SEASON_WEEKS}). Ties count as half a win.`);
    push('- Opp avg faced (SOS): mean of the season scoring averages of the opponents played so far. Opp avg remaining: the same for the rest of the head-to-head schedule.');
    push('- Avg margin: mean of points for minus points against in head-to-head games.');
    push('- Weekly high scores: weeks in which the team had the league\'s top score (a tie for the top counts for each team). The weekly high score carries a prize.');
    push('- Manager lineup efficiency: NOT APPLICABLE. The lineup is automatic, so actual score = optimal score. Counted share is given instead.');
    push('- Last 3 avg and trend need at least 4 weeks; before that they would only repeat the season average.', '');

    // 6
    push('## 6. SCHEDULE LUCK', '');
    const byLuck = [...now].sort((a, b) => b.luck - a.luck);
    const leaguePaAvg = avg(now.filter(r => r.games.length).map(r => r.pa / r.games.length));
    push(`Sorted by actual wins minus expected wins. League average points against per game: ${fmt(leaguePaAvg)}.`, '');
    push(...table(
        ['Owner', 'Record', 'All-play', 'Expected wins', 'Actual - expected', 'PF rank', 'PA per game', 'PA per game vs league avg'],
        byLuck.map(r => [
            r.owner, rec(r), rec(r.allPlay), fmt(r.xw), signed(r.luck), r.ptsRank.label,
            r.games.length ? fmt(r.pa / r.games.length) : 'n/a',
            r.games.length ? signed(r.pa / r.games.length - leaguePaAvg) : 'n/a'
        ])), '');
    const over = byLuck.filter(r => r.luck >= LUCK_GAP);
    const under = byLuck.filter(r => r.luck <= -LUCK_GAP);
    push(`- Records ${LUCK_GAP}+ win above expected: ${over.length ? over.map(r => `${r.owner} (${rec(r)}, all-play ${rec(r.allPlay)}, ${signed(r.luck)})`).join('; ') : 'none'}`);
    push(`- Records ${LUCK_GAP}+ win below expected: ${under.length ? under.map(r => `${r.owner} (${rec(r)}, all-play ${rec(r.allPlay)}, ${signed(r.luck)})`).join('; ') : 'none'}`);
    const byPaPg = now.filter(r => r.games.length).sort((a, b) => b.pa / b.games.length - a.pa / a.games.length);
    if (byPaPg.length) {
        const hi = byPaPg[0], lo = byPaPg[byPaPg.length - 1];
        push(`- Most points against per game: ${hi.owner}, ${fmt(hi.pa / hi.games.length)}. Fewest: ${lo.owner}, ${fmt(lo.pa / lo.games.length)}`);
    }
    const lostHigh = [], wonLow = [];
    for (const r of now) {
        for (const g of r.games) {
            const ap = allPlayWeek(g.week)[r.team_id];
            if (g.res === 'L' && ap.wins >= ap.n - 2) lostHigh.push(`${r.owner} lost in week ${g.week} with ${fmt(g.pf)} (beat ${ap.wins} of ${ap.n} other scores)`);
            if (g.res === 'W' && ap.wins <= 2) wonLow.push(`${r.owner} won in week ${g.week} with ${fmt(g.pf)} (beat ${ap.wins} of ${ap.n} other scores)`);
        }
    }
    push(`- Losses with a top-3 score of the week: ${lostHigh.length ? lostHigh.join('; ') : 'none'}`);
    push(`- Wins with a bottom-3 score of the week: ${wonLow.length ? wonLow.join('; ') : 'none'}`, '');
    if (week < 4) push(`Only ${week} week${week === 1 ? '' : 's'} played: these gaps rest on a small sample.`, '');

    // 7
    push('## 7. TRANSACTIONS', '');
    push('The league has IR moves (injured player to IR, replacement added), IR returns, supplemental moves (drop/add) and trades. There are no waiver claims and no FAAB. "When" is the time the move was recorded in the system (UTC), which can be later than when the owner asked for it.', '');
    const describe = x => {
        if (x.move_type === 'trade') {
            return [
                x.move_timestamp, `wk ${x.week}`, 'trade',
                `${x.owner_name} and ${x.partner_owner || `team ${x.partner_team_id}`}`,
                `${x.owner_name} sent ${x.dropped_player_name} (${x.dropped_player_position}), received ${x.added_player_name} (${x.added_player_position})`,
                x.week === week
                    ? `${playerWeek(x.team_id, x.added_player_id, x.added_player_name)}; ${playerWeek(x.partner_team_id, x.dropped_player_id, x.dropped_player_name)}`
                    : 'takes effect next week'
            ];
        }
        const out = `${x.dropped_player_name} (${x.dropped_player_position})`;
        const into = `${x.added_player_name} (${x.added_player_position})`;
        return [
            x.move_timestamp, `wk ${x.week}`, x.move_type, x.owner_name,
            x.move_type === 'ir' ? `${out} to IR; ${into} added`
                : x.move_type === 'ir_return' ? `${into} activated from IR; ${out} dropped`
                    : `${out} dropped; ${into} added`,
            x.week === week
                ? `${playerWeek(x.team_id, x.added_player_id, x.added_player_name)}; ${playerWeek(null, x.dropped_player_id, x.dropped_player_name)}`
                : 'takes effect next week'
        ];
    };
    const head = ['When', 'Effective', 'Type', 'Team(s)', 'Move', `Week ${week} impact`];
    const effectiveNow = moves.filter(x => x.week === week);
    const effectiveNext = moves.filter(x => x.week === week + 1);
    push(`**Effective for week ${week}** (made after week ${week - 1} closed):`, '');
    push(...(effectiveNow.length ? table(head, effectiveNow.map(describe)) : ['(none)']), '');
    push(`**Effective for week ${week + 1}** (made so far):`, '');
    push(...(effectiveNext.length ? table(head, effectiveNext.map(describe)) : ['(none recorded yet)']), '');
    const seasonMoves = await all(`
        SELECT team_id, partner_team_id, move_type, trade_id, move_id FROM roster_moves
        WHERE season = ? AND week <= ?
    `, [season, week + 1]);
    const countOf = (id, types) => seasonMoves.filter(x => x.team_id === id && types.includes(x.move_type)).length;
    const tradesOf = id => new Set(seasonMoves
        .filter(x => x.move_type === 'trade' && (x.team_id === id || x.partner_team_id === id))
        .map(x => x.trade_id || x.move_id)).size;
    push(`**Moves this season by owner** (effective through week ${week + 1}; only IR moves and IR returns carry the fee):`, '');
    push(...table(['Owner', 'IR moves + IR returns', 'Supplemental', 'Trades'], now.map(r => [
        r.owner, String(countOf(r.team_id, ['ir', 'ir_return'])), String(countOf(r.team_id, ['supplemental'])),
        String(tradesOf(r.team_id))
    ])), '');

    // 8
    push('## 8. ROSTER CHANGES AND PLAYER CONTEXT', '');
    push(`> Injury designations are the CURRENT status at generation time, not necessarily the status during week ${week} games.`,
        `> Rosters for the next matchup are the week-${nextRosterWeek} snapshot.`, '');
    const byesKnown = !!playingIn[week + 1];
    if (!byesKnown) quality.push(`No NFL schedule stored for week ${week + 1}; bye weeks could not be determined.`);
    const trendOf = id => {
        const g = (statLine[id] || []).map(x => x.pts || 0);
        if (g.length < 4) return null;
        return { recent: avg(g.slice(-2)), earlier: avg(g.slice(0, -2)), n: g.length };
    };
    for (const r of now) {
        const id = r.team_id;
        push(`### ${r.owner}`, '');
        const ir = rosterNext.filter(x => x.team_id === id && x.roster_position === 'injured_reserve');
        push(`- On league IR: ${ir.length ? ir.map(x => `${player(x)}${x.ir_date ? `, since ${x.ir_date.slice(0, 10)}` : ''}`).join('; ') : 'none'}`);
        const hurt = active(rosterNext, id).filter(x => injury[x.player_id]);
        if (hurt.length === 0) push('- Active players with an injury designation: none');
        else {
            push('- Active players with an injury designation:');
            for (const x of hurt) {
                const i = injury[x.player_id];
                push(`  - ${player(x)} — ${i.injury_designation}${i.injury_description ? `. ${i.injury_description}` : ''}`);
            }
        }
        if (week > 1) {
            const before = new Set(counted(rosterPrev, id).map(x => x.player_id));
            const after = new Set(counted(roster, id).map(x => x.player_id));
            const entered = counted(roster, id).filter(x => !before.has(x.player_id));
            const left = counted(rosterPrev, id).filter(x => !after.has(x.player_id));
            push(`- Counted in week ${week} but not week ${week - 1}: ${entered.length ? entered.map(x => `${x.player_name} ${x.player_position} ${fmt(x.pts || 0)}`).join('; ') : 'none'}`);
            push(`- Counted in week ${week - 1} but not week ${week}: ${left.length ? left.map(x => {
                const t = onRoster(id, x.player_id);
                return `${x.player_name} ${x.player_position} (${fmt(x.pts || 0)} then, ${t ? `${fmt(t.pts || 0)} now` : 'no longer on roster'})`;
            }).join('; ') : 'none'}`);
        }
        const rises = active(roster, id).filter(x => vsPrior(x) !== null && vsPrior(x) >= SWING).sort((a, b) => vsPrior(b) - vsPrior(a));
        push(`- ${SWING}+ above own prior average this week: ${rises.length ? rises.map(x => `${player(x)} ${fmt(x.pts || 0)} (${priorNote(x)})`).join('; ') : (week === 1 ? 'n/a in week 1' : 'none')}`);
        const trends = active(rosterNext, id).map(x => ({ x, t: trendOf(x.player_id) }))
            .filter(o => o.t && Math.abs(o.t.recent - o.t.earlier) >= CONTRIBUTOR_AVG)
            .sort((a, b) => Math.abs(b.t.recent - b.t.earlier) - Math.abs(a.t.recent - a.t.earlier));
        push(`- Multi-week change (last 2 games vs earlier games, ${CONTRIBUTOR_AVG}+ pts): ` + (week < 4 ? 'n/a (needs 4+ games)'
            : trends.length ? trends.map(o => `${player(o.x)} ${fmt(o.t.recent)} vs ${fmt(o.t.earlier)} (${o.t.n} games)`).join('; ') : 'none'));
        if (byesKnown) {
            const byes = active(rosterNext, id).filter(x => onBye(x.player_team, week + 1));
            push(`- On bye in week ${week + 1}: ${byes.length ? byes.map(player).join('; ') : 'none'}`);
        } else push(`- On bye in week ${week + 1}: not available`);
        push('');
    }

    // 9
    push('## 9. HISTORICAL CONTEXT', '');
    const seasonsInDb = Object.keys(weekPts).map(Number).sort();
    push(`Week-by-week team results cover ${seasonsInDb.join(', ')}. Other seasons come from podcast/history (final points standings and draft boards only).`, '');

    // 9a. points titles. The database is the official record; podcast/history
    // holds the league's own sheets and emails. Where both cover a season and
    // disagree, both are shown - this script never picks a champion.
    const dbFinals = {};    // season -> { lastWeek, rows }
    const cumulative = (s, throughWeek, teamId) => sum(Object.keys(weekPts[s]).map(Number)
        .filter(w => w <= throughWeek).map(w => weekPts[s][w][teamId] || 0));
    for (const s of seasonsInDb.filter(x => x < season)) {
        const lastWeek = Math.min(POINTS_FINAL_WEEK, Math.max(...Object.keys(weekPts[s]).map(Number)));
        dbFinals[s] = {
            lastWeek,
            rows: teams.map(t => ({ team_id: t.team_id, owner: t.owner_name, points: cumulative(s, lastWeek, t.team_id) }))
                .sort((a, b) => b.points - a.points)
        };
    }
    const fileFinals = {};  // season -> { rows, complete, winner, teams, notes }
    try {
        for (const f of fs.readdirSync(HISTORY_DIR).filter(x => /^season-\d{4}\.json$/.test(x)).sort()) {
            const h = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), 'utf8'));
            if (h.season >= season) continue;
            fileFinals[h.season] = {
                rows: (h.standings || []).map(x => ({ owner: x.owner, points: x.points, note: x.note })),
                complete: !!h.standingsComplete, teams: h.teams, notes: h.notes,
                winner: /^unknown/i.test(h.pointsWinner || 'unknown') ? null : h.pointsWinner
            };
        }
    } catch (e) {
        quality.push(`podcast/history could not be read (${e.message}); no pre-${seasonsInDb[0]} history is available.`);
    }
    const disputed = {};    // season -> text, where the two sources name different winners
    for (const y of Object.keys(dbFinals).map(Number)) {
        const d = dbFinals[y], f = fileFinals[y];
        if (!f || f.rows.length === 0) continue;
        const differs = f.rows.filter(x => {
            const r = d.rows.find(o => o.owner === x.owner);
            return r && Math.abs(r.points - x.points) > 0.01;
        });
        if (f.winner && f.winner !== d.rows[0].owner) {
            const fw = f.rows.find(x => x.owner === f.winner);
            disputed[y] = `database: ${d.rows[0].owner} (${fmt(d.rows[0].points)}); league sheet: ${f.winner}${fw ? ` (${fmt(fw.points)})` : ''}`;
            quality.push(`CONFLICT: the ${y} points winner differs by source - ${disputed[y]}. Report both; do not name a ${y} champion without a commissioner ruling.`);
        }
        if (differs.length === 0) continue;
        let best = { week: null, hits: 0 };
        for (let w = 1; w <= d.lastWeek; w++) {
            const hits = f.rows.filter(x => {
                const r = d.rows.find(o => o.owner === x.owner);
                return r && Math.abs(cumulative(y, w, r.team_id) - x.points) <= 0.01;
            }).length;
            if (hits > best.hits) best = { week: w, hits };
        }
        const worst = differs.map(x => ({ x, r: d.rows.find(o => o.owner === x.owner) }))
            .sort((a, b) => Math.abs(b.r.points - b.x.points) - Math.abs(a.r.points - a.x.points))[0];
        quality.push(`${y} totals differ between the database (through week ${d.lastWeek}) and podcast/history/season-${y}.json for ` +
            `${differs.length} of ${f.rows.length} listed owners (largest gap: ${worst.x.owner}, ${fmt(worst.r.points)} vs ${fmt(worst.x.points)}). ` +
            (best.hits > 0 ? `The history figures match the database's totals through week ${best.week} for ${best.hits} of ${f.rows.length} owners.`
                : 'No stored week reproduces the history figures.'));
    }
    const partial = Object.keys(fileFinals).map(Number).filter(y => !dbFinals[y] && !fileFinals[y].complete);
    if (partial.length) quality.push(`Final standings are incomplete in podcast/history for: ${partial.join(', ')}.`);
    const years = [...new Set([...Object.keys(dbFinals), ...Object.keys(fileFinals)].map(Number))].sort((a, b) => b - a);
    const titleRows = [];
    for (const y of years) {
        const d = dbFinals[y], f = fileFinals[y];
        if (d) {
            const [a, b] = d.rows, z = d.rows[d.rows.length - 1];
            titleRows.push([String(y), String(d.rows.length), a.owner, fmt(a.points), `${b.owner} (${fmt(b.points)})`,
                fmt(a.points - b.points), `${z.owner} (${fmt(z.points)})`,
                `${REFERENCE_TEAM_SCORES[y] ? `official ${y} record` : 'database'}, through week ${d.lastWeek}`]);
        }
        if (f && f.rows.length && (!d || disputed[y])) {
            const a = f.rows.find(x => x.owner === f.winner) || (f.complete ? f.rows[0] : null);
            const rest = f.rows.filter(x => x !== a);
            const b = rest[0], z = f.rows[f.rows.length - 1];
            titleRows.push([String(y), String(f.teams || f.rows.length),
                a ? a.owner : 'unknown', a ? fmt(a.points) : 'n/a',
                a && b ? `${b.owner} (${fmt(b.points)})${f.complete ? '' : ', standings partial'}` : 'n/a',
                a && b ? fmt(a.points - b.points) : 'n/a',
                f.complete ? `${z.owner} (${fmt(z.points)})` : 'n/a',
                `podcast/history${d ? ' (league sheet) - CONFLICTS with the database' : ''}`]);
        }
    }
    const covered = years.filter(y => dbFinals[y] || fileFinals[y].rows.length);
    const missing = [];
    for (let y = Math.min(...years, season); y < season; y++) if (!covered.includes(y)) missing.push(y);
    if (missing.length) quality.push(`No final standings at all for: ${missing.join(', ')}.`);

    push('**Points titles (cumulative points, the "PFL Cup"):**', '');
    push(...table(['Season', 'Teams', 'Points winner', 'Points', 'Runner-up', 'Margin', 'Last', 'Source'], titleRows), '');
    if (Object.keys(disputed).length) {
        push(`DISPUTED: ${Object.keys(disputed).map(y => `${y} (${disputed[y]})`).join('; ')}. Present both figures; do not state either owner as that season's champion.`, '');
    }
    const finishSeasons = years.filter(y => dbFinals[y] || (fileFinals[y].complete && fileFinals[y].rows.length));
    const finishRows = y => (dbFinals[y] || fileFinals[y]).rows;
    push('**Final points finishes by current owner** (week-by-week records where they exist, otherwise complete podcast/history standings):', '');
    push(...table(['Owner', 'Undisputed points titles', 'Disputed', 'Finishes (season: place of teams)'],
        now.map(r => teams.find(t => t.team_id === r.team_id)).map(t => {
            const fin = finishSeasons.map(y => {
                const i = finishRows(y).findIndex(x => x.owner === t.owner_name);
                return i < 0 ? null : `${y}${disputed[y] ? '*' : ''}: ${i + 1}/${finishRows(y).length}`;
            }).filter(Boolean);
            const titles = finishSeasons.filter(y => !disputed[y] && finishRows(y)[0].owner === t.owner_name);
            const inDispute = Object.keys(disputed).filter(y =>
                dbFinals[y].rows[0].owner === t.owner_name || fileFinals[y].winner === t.owner_name);
            return [t.owner_name, titles.length ? `${titles.length} (${titles.join(', ')})` : '0',
                inDispute.length ? inDispute.join(', ') : '-', fin.length ? fin.join(', ') : 'none on record'];
        })), '');
    if (Object.keys(disputed).length) push('\\* = season whose points winner is disputed; the place shown is the database order.');
    const strangers = [...new Set(finishSeasons.flatMap(y => finishRows(y).map(x => x.owner))
        .filter(n => !teams.some(t => t.owner_name === n)))];
    push('Owners are listed in current standings order. Season totals are not like-for-like: the number of teams and of weeks played differs between seasons.',
        `Older files give first names only. A finish is credited to a current owner only on an exact first-name match, and that match is an assumption, not a verified identity${strangers.length ? `. Names credited to no current owner: ${strangers.join(', ')}` : ''}.`,
        'Head-to-head playoff champions and playoff appearances are not reliably stored (see section 13).', '');
    if (strangers.length) quality.push(`History names matched to no current owner (their finishes are credited to nobody): ${strangers.join(', ')}. Shared or changed teams before 2020 are not resolved.`);

    // 9b. head-to-head
    const meetings = (a, b) => Object.keys(games).map(Number).sort()
        .flatMap(s => ((games[s] || {})[a] || []).filter(g => g.opp === b));
    const h2hLine = (a, b, beforeWeek) => {
        const g = meetings(a, b).filter(x => x.season < season || x.week < beforeWeek);
        if (g.length === 0) return `${owner(a)} vs ${owner(b)}: no prior regular-season meetings in the database`;
        const w = g.filter(x => x.res === 'W').length, l = g.filter(x => x.res === 'L').length, t = g.filter(x => x.res === 'T').length;
        const lead = w > l ? `${owner(a)} leads ${w}-${l}` : l > w ? `${owner(b)} leads ${l}-${w}` : `tied ${w}-${l}`;
        return `${owner(a)} vs ${owner(b)}: ${lead}${t ? ` with ${t} tie${t === 1 ? '' : 's'}` : ''} ` +
            `(${g.map(x => `${x.season} wk ${x.week}: ${x.res === 'T' ? `tie ${fmt(x.pf)}` : `${owner(x.res === 'W' ? a : b)} ${fmt(Math.max(x.pf, x.pa))}-${fmt(Math.min(x.pf, x.pa))}`}`).join('; ')})`;
    };
    push(`**Head-to-head before this week** (regular-season games, ${seasonsInDb[0]} onward):`, '');
    for (const m of results) push(`- ${h2hLine(m.team1_id, m.team2_id, week)}`);
    push('');

    // 9c. scoring records
    const everyScore = [];
    for (const s of seasonsInDb) {
        for (const w of Object.keys(weekPts[s]).map(Number)) {
            for (const id of Object.keys(weekPts[s][w]).map(Number)) everyScore.push({ s, w, id, pts: weekPts[s][w][id] });
        }
    }
    everyScore.sort((a, b) => b.pts - a.pts);
    const where = x => `${owner(x.id)} ${fmt(x.pts)} (${x.s} wk ${x.w})`;
    push(`**Team scoring records** (${everyScore.length} team-weeks, ${seasonsInDb[0]} onward):`, '');
    push(`- Five highest: ${everyScore.slice(0, 5).map(where).join('; ')}`);
    push(`- Five lowest: ${everyScore.slice(-5).reverse().map(where).join('; ')}`);
    push(`- All-time average team score: ${fmt(avg(everyScore.map(x => x.pts)))}. This week's league average: ${fmt(leagueAvgWeek)}`);
    push(`- Where this week's scores rank among all ${everyScore.length}: ` + teamScores.map(x =>
        `${owner(x.id)} ${fmt(x.pts)} = #${1 + everyScore.filter(e => e.pts > x.pts).length}`).join('; '));
    const seasonScores = everyScore.filter(x => x.s === season);
    push(`- ${season} season high: ${where(seasonScores[0])}. Season low: ${where(seasonScores[seasonScores.length - 1])}`, '');

    const bestEver = await all(`
        SELECT wr.season, wr.week, wr.team_id, wr.player_name, wr.player_position, ps.fantasy_points as pts
        FROM weekly_rosters wr
        JOIN player_stats ps ON ps.player_id = wr.player_id AND ps.week = wr.week AND ps.season = wr.season
        WHERE wr.is_scoring = 1 AND (wr.season < ? OR (wr.season = ? AND wr.week <= ?))
        ORDER BY ps.fantasy_points DESC
    `, [season, season, week]);
    if (bestEver.length && allCounted[0]) {
        push(`**Individual scoring records** (counted performances, ${Math.min(...bestEver.map(x => x.season))} onward):`, '');
        push(`- Five highest: ${bestEver.slice(0, 5).map(x => `${x.player_name} ${x.player_position} ${fmt(x.pts)} for ${owner(x.team_id)} (${x.season} wk ${x.week})`).join('; ')}`);
        push(`- This week's best, ${allCounted[0].player_name} ${fmt(allCounted[0].pts)}, ranks #${1 + bestEver.filter(x => x.pts > allCounted[0].pts).length} of ${bestEver.length}`, '');
    }

    // 9d. streaks
    const longest = { W: null, L: null };
    for (const s of Object.keys(games).map(Number)) {
        for (const id of Object.keys(games[s]).map(Number)) {
            let run = 0, kind = null, start = null;
            for (const g of games[s][id]) {
                if (g.res === kind) run++;
                else { kind = g.res; run = 1; start = g.week; }
                if ((kind === 'W' || kind === 'L') && (!longest[kind] || run > longest[kind].run)) {
                    longest[kind] = { run, id, s, start, end: g.week };
                }
            }
        }
    }
    push(`**Streaks** (regular-season head-to-head, within one season, ${seasonsInDb[0]} onward):`, '');
    for (const k of ['W', 'L']) {
        if (longest[k]) push(`- Longest ${k === 'W' ? 'winning' : 'losing'} streak: ${longest[k].run}, ${owner(longest[k].id)} (${longest[k].s} weeks ${longest[k].start}-${longest[k].end}). Ties for the record are not listed`);
    }
    push(`- Current streaks: ${now.map(r => `${r.owner} ${streakOf(r.games)}`).join(', ')}`, '');
    // 9e. draft history of the week's headline players
    const boards = [];
    try {
        for (const f of fs.readdirSync(HISTORY_DIR).filter(x => /^draft-\d{4}\.json$/.test(x)).sort().reverse()) {
            const d = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), 'utf8'));
            boards.push({ season: d.season, picks: d.picks || [] });
        }
    } catch (e) { /* already reported with the season files */ }
    if (boards.length) {
        const plain = n => n.toLowerCase().replace(/ (jr|sr|ii|iii|iv)\.?$/, '').replace(/[^a-z ]/g, '').trim();
        const headline = [...allCounted.slice(0, 10), ...allActive.filter(r =>
            moves.some(x => x.move_type === 'trade' && [x.added_player_id, x.dropped_player_id].includes(r.player_id)))]
            .filter((r, i, a) => r.player_position !== 'DST' && a.findIndex(o => o.player_id === r.player_id) === i);
        push(`**Earlier drafts of this week's top 10 scorers and traded players** (boards on file: ${boards.map(b => b.season).join(', ')}; there is no ${season} board):`, '');
        for (const r of headline) {
            const hits = boards.flatMap(b => b.picks.filter(k => plain(k.player || '') === plain(r.player_name))
                .map(k => `${b.season} round ${k.round} by ${k.owner}`));
            push(`- ${r.player_name} (${owner(r.team_id)} in week ${week}): ${hits.length ? `drafted ${hits.join('; ')}` : 'not found on any board on file'}`);
        }
        push('', 'A board shows who drafted a player, not who held him all season. "Not found" can mean a spelling difference in an old sheet.', '');
    }
    analyst('Optional: add up to three more facts from podcast/history that bear on THIS week\'s results or next week\'s matchups, each naming its source file. Delete this marker whether or not you add any.');

    // 10
    push('## 10. BIGGEST CHANGES SINCE LAST WEEK', '');
    if (week === 1) push('n/a in week 1 (no prior week).', '');
    else {
        const moved = now.map(r => ({
            r, site: was(r.team_id).site.rank - r.site.rank, pts: was(r.team_id).ptsRank.rank - r.ptsRank.rank,
            swing: ptsOf(r.team_id, week) - avg(was(r.team_id).scores),
            wow: ptsOf(r.team_id, week) - ptsOf(r.team_id, week - 1),
            xw: r.xw - was(r.team_id).xw, luck: r.luck - was(r.team_id).luck
        }));
        push(...table(
            ['Owner', 'Rank change', 'Pts rank change', `Wk ${week} score`, 'vs own prior avg', `vs wk ${week - 1} score`, 'Expected wins added', 'Actual - expected, change'],
            [...moved].sort((a, b) => b.site - a.site || b.pts - a.pts).map(x => [
                x.r.owner,
                `${was(x.r.team_id).site.label} → ${x.r.site.label} (${signed(x.site)})`,
                `${was(x.r.team_id).ptsRank.label} → ${x.r.ptsRank.label} (${signed(x.pts)})`,
                fmt(ptsOf(x.r.team_id, week)), signed(x.swing), signed(x.wow), fmt(x.xw), signed(x.luck)
            ])), '');
        const bySwing = [...moved].sort((a, b) => b.swing - a.swing);
        push(`- Biggest rise in the standings: ${[...moved].sort((a, b) => b.site - a.site).slice(0, 3).filter(x => x.site > 0).map(x => `${x.r.owner} ${signed(x.site)}`).join('; ') || 'none'}`);
        push(`- Biggest drop in the standings: ${[...moved].sort((a, b) => a.site - b.site).slice(0, 3).filter(x => x.site < 0).map(x => `${x.r.owner} ${signed(x.site)}`).join('; ') || 'none'}`);
        push(`- Furthest above own prior average: ${bySwing.slice(0, 3).map(x => `${x.r.owner} ${signed(x.swing)}`).join('; ')}`);
        push(`- Furthest below own prior average: ${bySwing.slice(-3).reverse().map(x => `${x.r.owner} ${signed(x.swing)}`).join('; ')}`);
        push(`- Major roster changes: ${moves.length} move${moves.length === 1 ? '' : 's'} recorded (${moves.filter(x => x.move_type === 'trade').length} trade${moves.filter(x => x.move_type === 'trade').length === 1 ? '' : 's'}); see section 7`, '');
        push('Expected wins added = this week\'s all-play win %, i.e. the share of the other 11 scores the team beat.', '');
    }

    // 11
    push('## 11. STORY CANDIDATES', '');
    analyst('Write 5-10 factual story candidates in the form the skill gives (Headline / Involved / Evidence / Why notable). No jokes, no subjective labels, no numbers that do not appear in sections 2-10 or 12.');

    // 12
    push('## 12. NEXT WEEK PREVIEW', '');
    const next = allMatchups.filter(m => m.season === season && m.week === week + 1);
    if (next.length === 0) push(`No matchups are stored for week ${week + 1}.`, '');
    else {
        push(`Week ${week + 1}. Projected scores: not available (no projections). Rosters are the week-${nextRosterWeek} snapshot and can still change.`, '');
        const ng = gameStatus.find(x => x.week === week + 1);
        const started = ng ? (await get(
            "SELECT COUNT(*) as n FROM nfl_games WHERE season = ? AND week = ? AND status != 'Scheduled'", [season, week + 1])).n : 0;
        if (started > 0) {
            const text = `WEEK ${week + 1} HAD ALREADY STARTED when this was generated: ${ng.final} of ${ng.total} NFL games final, ` +
                `${started - ng.final} in progress, ${ng.total - started} not yet started. This is no longer a preview of unplayed games, ` +
                `and injury notes that look ahead to a game may describe one already played. No week-${week + 1} scores are included.`;
            push(`> ${text}`, '');
            quality.push(text);
        }
        if (week + 1 > REGULAR_SEASON_WEEKS) {
            push(`Week ${week + 1} is a playoff week. The stored pairings below may be schedule placeholders rather than the seeded bracket - confirm against the site before describing them as playoff games.`, '');
            quality.push(`Week ${week + 1} pairings come from the matchups table; in playoff weeks those rows are not guaranteed to be the seeded bracket.`);
        } else {
            push(`Head-to-head weeks remaining after week ${week}: ${REGULAR_SEASON_WEEKS - week}.`, '');
        }
        for (const m of next) {
            const a = cur(m.team1_id), b = cur(m.team2_id);
            push(`### ${a.owner} vs ${b.owner}${m.is_playoff ? ' (playoff bracket game)' : ''}`, '');
            push(...table(['', a.owner, b.owner], [
                ['Team', a.team_name, b.team_name],
                ['Record', rec(a), rec(b)],
                ['Rank (site)', a.site.label, b.site.label],
                ['Points rank', a.ptsRank.label, b.ptsRank.label],
                ['Cumulative points', fmt(a.pf), fmt(b.pf)],
                ['Division', a.division || 'n/a', b.division || 'n/a'],
                ['Season avg', fmt(seasonAvg(a.team_id)), fmt(seasonAvg(b.team_id))],
                ['Last 3 avg', fmt3(a.team_id), fmt3(b.team_id)],
                ['Last week', fmt(ptsOf(a.team_id, week)), fmt(ptsOf(b.team_id, week))],
                ['Streak', streakOf(a.games), streakOf(b.games)],
                ['All-play', rec(a.allPlay), rec(b.allPlay)]
            ]), '');
            for (const r of [a, b]) {
                const act = active(rosterNext, r.team_id);
                const byes = byesKnown ? act.filter(x => onBye(x.player_team, week + 1)) : null;
                push(`- ${r.owner} on bye: ${byes === null ? 'not available' : byes.length ? byes.map(player).join('; ') : 'none'}`);
                const hurt = act.filter(x => injury[x.player_id]);
                push(`- ${r.owner} injury designations: ${hurt.length ? hurt.map(x => `${player(x)} ${injury[x.player_id].injury_designation}`).join('; ') : 'none'}`);
            }
            push(`- Head-to-head: ${h2hLine(m.team1_id, m.team2_id, week + 1)}`);
            const gap = Math.abs(a.pf - b.pf);
            const winsGap = Math.abs(a.wins - b.wins);
            push(`- Standings: ${winsGap === 0 ? 'level on wins' : `${(a.wins > b.wins ? a : b).owner} is ${winsGap} win${winsGap === 1 ? '' : 's'} ahead`}; ` +
                `${gap === 0 ? 'level on points' : `${(a.pf > b.pf ? a : b).owner} leads by ${fmt(gap)} cumulative points`}. ` +
                (a.division && a.division === b.division ? `Both are in the ${a.division} division.` : 'They are in different divisions.'));
            push('');
        }
        analyst('Optional: replace this marker with one "Standings implications" list covering the matchups above, using only what follows arithmetically from section 2. No predictions.');
    }

    // 13
    push('## 13. DATA QUALITY NOTES', '');
    push('**Unavailable in the league data:**', '');
    push('- Pre-game projections and projected scores (so no favorite/underdog by projection and no upset-versus-projection).');
    push('- Waiver claims and FAAB: the league does not use them.');
    push('- Start/sit decisions, optimal-lineup gaps and manager lineup efficiency: the lineup is automatic, so these do not exist. "Counted share" is reported instead.');
    push('- Head-to-head playoff champions and playoff appearances: bracket games are only partly flagged in the database and are absent from podcast/history.');
    push(`- Reliable week-by-week team results before ${seasonsInDb[0]}: only final points standings (some seasons) and draft boards exist.`);
    push('- Injury status as of game time: only the current designation is stored.', '');
    push('**Assumptions:**', '');
    push('- Standings rank uses the site order (wins, then cumulative points). The points race is ranked separately.');
    push(`- Head-to-head metrics (record, PA, margin, streak, expected wins, SOS) use weeks 1-${REGULAR_SEASON_WEEKS} and ignore rows flagged as playoff games.`);
    push('- League documents do not say whether "top team in each division" means by record or by points; division lists use the site order.');
    push('- A player\'s "prior average" counts only weeks where he has a stat line.');
    push('- Roster-move timestamps are the time the move was recorded (UTC), not the time the owner requested it.');
    push(`- Past seasons' final points standings are the database totals through week ${POINTS_FINAL_WEEK}, the week the points prizes are settled on. Any later week counts only toward that week's high score.`, '');
    push('**Found while generating:**', '');
    push(...(quality.length ? [...new Set(quality)].map(q => `- ${q}`) : ['- No inconsistencies found: stored standings match the matchups, every lineup adds up to its official score, and every team has 19 active players.']), '');
    analyst('Replace this marker with an "Analyst notes" list (bold label, then bullets) for anything you found while filling sections 9, 11 and 12. Delete the marker and add nothing if you found nothing.');

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, L.join('\n'));
    console.log(`Fact pack written to ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);
    console.log(`Season ${season}, week ${week}${weekComplete ? '' : ' (INCOMPLETE)'}; ${quality.length} data quality note(s).`);
}

main()
    .then(() => db.close())
    .catch(err => {
        console.error(`podcast-data failed: ${err.stack || err.message}`);
        db.close();
        process.exit(1);
    });
