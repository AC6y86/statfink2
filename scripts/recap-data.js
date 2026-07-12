#!/usr/bin/env node

/**
 * Recap data digest generator - the SINGLE data source for /recap narrators.
 *
 * Usage: node scripts/recap-data.js <season> <week> [--force] [--out <path>]
 *
 * Produces a compact markdown fact sheet (matchups, standings + movement,
 * scoring lineups, top performances/busts, close calls, streaks, head-to-head,
 * injuries) at recaps/{season}/data/week{NN}-digest.md. Every number the
 * narrator agents cite comes verbatim from this file - they have no DB access.
 *
 * Gates:
 * - Weekly validation (logs/weekly-validation-latest.json) must be PASS/WARN
 *   for the requested week; older weeks need --force (the log only holds the
 *   latest run).
 * - Refuses if any team violates the 19-active-players invariant.
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
const REGULAR_SEASON_WEEKS = 12;

// ---------- args ----------
const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const season = parseInt(positional[0]);
const week = parseInt(positional[1]);
const force = args.includes('--force');
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? args[outIdx + 1]
    : path.join(REPO, `recaps/${season}/data/week${String(week).padStart(2, '0')}-digest.md`);

if (!season || !week) {
    console.error('Usage: node scripts/recap-data.js <season> <week> [--force] [--out <path>]');
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

const fmt = n => (n === null || n === undefined) ? '?' : (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ''));

async function main() {
    // ---------- validation gate ----------
    let validationNote = 'not checked';
    try {
        const v = JSON.parse(fs.readFileSync(VALIDATION_FILE, 'utf8'));
        if (v.season === season && v.week === week) {
            validationNote = `${v.overallStatus} (run ${v.runAt})`;
            if (!['PASS', 'WARN'].includes(v.overallStatus) && !force) {
                console.error(`Weekly validation for ${season} week ${week} is ${v.overallStatus} - fix validation or pass --force.`);
                process.exit(1);
            }
        } else if (!force) {
            console.error(`No validation record for ${season} week ${week} (latest is ${v.season} week ${v.week}). ` +
                'Re-run validation for this week or pass --force for an older, already-blessed week.');
            process.exit(1);
        } else {
            validationNote = `none for this week (latest: ${v.season} wk ${v.week}); --force used`;
        }
    } catch (e) {
        if (!force) {
            console.error(`Cannot read ${VALIDATION_FILE} (${e.message}) - pass --force to proceed without the gate.`);
            process.exit(1);
        }
        validationNote = `unavailable (${e.message}); --force used`;
    }

    // ---------- invariant gate ----------
    const badTeams = await all(`
        SELECT t.team_id, t.team_name, COUNT(wr.player_id) as active
        FROM teams t
        LEFT JOIN weekly_rosters wr ON t.team_id = wr.team_id
            AND wr.week = ? AND wr.season = ? AND wr.roster_position = 'active'
        GROUP BY t.team_id HAVING active != 19
    `, [week, season]);
    if (badTeams.length > 0) {
        console.error(`Roster invariant violated for ${season} week ${week}: ` +
            badTeams.map(t => `${t.team_name}=${t.active}`).join(', '));
        process.exit(1);
    }

    const matchups = await all(`
        SELECT m.matchup_id, m.team1_id, m.team2_id,
               m.team1_scoring_points as p1, m.team2_scoring_points as p2,
               t1.team_name as n1, t1.owner_name as o1,
               t2.team_name as n2, t2.owner_name as o2
        FROM matchups m
        JOIN teams t1 ON m.team1_id = t1.team_id
        JOIN teams t2 ON m.team2_id = t2.team_id
        WHERE m.week = ? AND m.season = ?
        ORDER BY m.matchup_id
    `, [week, season]);
    if (matchups.length === 0) {
        console.error(`No matchups found for ${season} week ${week}.`);
        process.exit(1);
    }

    const owners = {};
    for (const m of matchups) {
        owners[m.team1_id] = m.o1;
        owners[m.team2_id] = m.o2;
    }

    // Per-team game results weeks 1..week (for streaks/H2H); records freeze
    // after week 12 but game outcomes still exist in playoff weeks.
    const allResults = await all(`
        SELECT week, team1_id, team2_id, team1_scoring_points as p1, team2_scoring_points as p2
        FROM matchups WHERE season = ? AND week <= ? ORDER BY week
    `, [season, week]);
    const gamesByTeam = {};
    for (const r of allResults) {
        if (r.p1 === null || r.p2 === null) continue;
        const res1 = r.p1 > r.p2 ? 'W' : r.p1 < r.p2 ? 'L' : 'T';
        (gamesByTeam[r.team1_id] = gamesByTeam[r.team1_id] || []).push({ week: r.week, res: res1, opp: r.team2_id, pf: r.p1, pa: r.p2 });
        (gamesByTeam[r.team2_id] = gamesByTeam[r.team2_id] || []).push({ week: r.week, res: res1 === 'W' ? 'L' : res1 === 'L' ? 'W' : 'T', opp: r.team1_id, pf: r.p2, pa: r.p1 });
    }
    const streak = games => {
        if (!games || games.length === 0) return '-';
        let n = 1;
        const last = games[games.length - 1].res;
        for (let i = games.length - 2; i >= 0 && games[i].res === last; i--) n++;
        return `${last}${n}`;
    };

    const standings = await all(`
        SELECT ws.team_id, t.team_name, t.owner_name, ws.wins, ws.losses, ws.ties,
               ws.points_for_week, ws.cumulative_points, ws.weekly_rank
        FROM weekly_standings ws JOIN teams t ON ws.team_id = t.team_id
        WHERE ws.week = ? AND ws.season = ?
        ORDER BY ws.cumulative_points DESC
    `, [week, season]);
    const prevStandings = week > 1 ? await all(`
        SELECT team_id, cumulative_points FROM weekly_standings
        WHERE week = ? AND season = ? ORDER BY cumulative_points DESC
    `, [week - 1, season]) : [];
    const prevRank = {};
    prevStandings.forEach((r, i) => { prevRank[r.team_id] = i + 1; });

    const seasonAvg = await all(`
        SELECT team_id, AVG(points_for_week) as avg FROM weekly_standings
        WHERE season = ? AND week <= ? GROUP BY team_id
    `, [season, week]);
    const avgByTeam = Object.fromEntries(seasonAvg.map(r => [r.team_id, r.avg]));
    const leagueAvg = standings.reduce((s, r) => s + r.points_for_week, 0) / (standings.length || 1);

    const lineups = await all(`
        SELECT wr.team_id, wr.player_name, wr.player_position, wr.scoring_slot,
               COALESCE(ps.fantasy_points, 0) as pts
        FROM weekly_rosters wr
        LEFT JOIN player_stats ps ON wr.player_id = ps.player_id
            AND ps.week = wr.week AND ps.season = wr.season
        WHERE wr.week = ? AND wr.season = ? AND wr.is_scoring = 1
        ORDER BY wr.team_id, pts DESC
    `, [week, season]);

    const injuries = await all(`
        SELECT t.owner_name, np.name, np.position, np.team,
               np.injury_designation, np.injury_description
        FROM weekly_rosters wr
        JOIN nfl_players np ON wr.player_id = np.player_id
        JOIN teams t ON wr.team_id = t.team_id
        WHERE wr.week = ? AND wr.season = ? AND wr.roster_position = 'active'
          AND np.injury_designation IN ('Out', 'Injured Reserve')
        ORDER BY t.owner_name, np.name
    `, [week, season]);

    // ---------- build digest ----------
    const W = String(week).padStart(2, '0');
    const playoff = week > REGULAR_SEASON_WEEKS;
    const L = [];
    L.push(`# PFL ${season} Week ${week} — Data Digest`);
    L.push('');
    L.push(`- Generated: ${new Date().toISOString()}`);
    L.push(`- Weekly validation: ${validationNote}`);
    L.push(`- Week type: ${playoff ? `PLAYOFFS (weeks ${REGULAR_SEASON_WEEKS + 1}+; W-L-T records are FROZEN at their week-${REGULAR_SEASON_WEEKS} values - do not describe playoff games as changing records)` : `regular season (weeks 1-${REGULAR_SEASON_WEEKS})`}`);
    L.push(`- This digest is the SOLE authoritative source for recap facts. Copy numbers verbatim.`);
    L.push('');

    L.push('## Matchup Results');
    L.push('');
    L.push('| Matchup | Score | Winner | Margin |');
    L.push('|---------|-------|--------|--------|');
    for (const m of matchups) {
        const winner = m.p1 > m.p2 ? m.o1 : m.p2 > m.p1 ? m.o2 : 'TIE';
        L.push(`| ${m.o1} (${m.n1}) vs ${m.o2} (${m.n2}) | ${fmt(m.p1)} - ${fmt(m.p2)} | ${winner} | ${fmt(Math.abs(m.p1 - m.p2))} |`);
    }
    L.push('');

    L.push(`## Standings Through Week ${week} (ranked by cumulative points)`);
    L.push('');
    L.push('| Rank | Owner | Record | Week Pts | Week Rank | Cumulative | Movement |');
    L.push('|------|-------|--------|----------|-----------|------------|----------|');
    standings.forEach((r, i) => {
        const rank = i + 1;
        const prev = prevRank[r.team_id];
        const move = !prev ? '-' : prev === rank ? '=' : prev > rank ? `▲${prev - rank}` : `▼${rank - prev}`;
        const delta = r.points_for_week - (avgByTeam[r.team_id] || 0);
        L.push(`| ${rank} | ${r.owner_name} | ${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ''} | ${fmt(r.points_for_week)} (${delta >= 0 ? '+' : ''}${fmt(delta)} vs own avg) | ${r.weekly_rank} | ${fmt(r.cumulative_points)} | ${move} |`);
    });
    L.push('');
    L.push(`League average this week: ${fmt(leagueAvg)} points.`);
    L.push('');

    L.push('## Scoring Lineups (the players who counted)');
    L.push('');
    for (const r of standings) {
        const rows = lineups.filter(l => l.team_id === r.team_id);
        L.push(`**${r.owner_name}** (${fmt(r.points_for_week)}): ` +
            rows.map(l => `${l.player_name || '?'} ${l.player_position} ${fmt(l.pts)}`).join(', '));
    }
    L.push('');

    const scorers = lineups.filter(l => l.player_name).sort((a, b) => b.pts - a.pts);
    L.push('## Top 10 Performances (scoring lineups league-wide)');
    L.push('');
    scorers.slice(0, 10).forEach((l, i) =>
        L.push(`${i + 1}. ${l.player_name} (${l.player_position}) — ${fmt(l.pts)} pts for ${owners[l.team_id] || `team ${l.team_id}`}`));
    L.push('');

    const busts = scorers.filter(l => ['QB', 'RB', 'WR', 'TE'].includes(l.player_position) && l.pts <= 2);
    L.push('## Busts (skill players in scoring lineups, ≤2 pts)');
    L.push('');
    L.push(busts.length === 0 ? '(none this week)'
        : busts.map(l => `- ${l.player_name} (${l.player_position}) — ${fmt(l.pts)} pts for ${owners[l.team_id] || `team ${l.team_id}`}`).join('\n'));
    L.push('');

    const close = matchups.filter(m => Math.abs(m.p1 - m.p2) < 10);
    L.push('## Close Calls (margin under 10)');
    L.push('');
    L.push(close.length === 0 ? '(none this week)'
        : close.map(m => `- ${m.o1} ${fmt(m.p1)} vs ${m.o2} ${fmt(m.p2)} (margin ${fmt(Math.abs(m.p1 - m.p2))})`).join('\n'));
    L.push('');

    L.push('## Streaks & Recent Form (game results, incl. playoff weeks)');
    L.push('');
    for (const r of standings) {
        const g = gamesByTeam[r.team_id] || [];
        L.push(`- ${r.owner_name}: streak ${streak(g)}, last 5: ${g.slice(-5).map(x => x.res).join('')}`);
    }
    L.push('');

    L.push('## Head-to-Head History (this season, before this week)');
    L.push('');
    let anyH2H = false;
    for (const m of matchups) {
        const prior = (gamesByTeam[m.team1_id] || []).filter(g => g.opp === m.team2_id && g.week < week);
        if (prior.length > 0) {
            anyH2H = true;
            const desc = prior.map(g =>
                `week ${g.week}: ${g.res === 'W' ? `${m.o1} won ${fmt(g.pf)}-${fmt(g.pa)}` : g.res === 'L' ? `${m.o2} won ${fmt(g.pa)}-${fmt(g.pf)}` : `tied ${fmt(g.pf)}`}`).join('; ');
            L.push(`- ${m.o1} vs ${m.o2}: ${desc}`);
        }
    }
    if (!anyH2H) L.push('(all first meetings this season)');
    L.push('');

    L.push('## Injury Report');
    L.push('');
    L.push('> CAVEAT (reproduce in the recap): Injury designations reflect CURRENT');
    L.push(`> status at generation time, not necessarily during Week ${week} games.`);
    L.push('');
    L.push(injuries.length === 0 ? '(no rostered players currently Out or on IR)'
        : injuries.map(i => `- ${i.owner_name}: ${i.name} (${i.position}, ${i.team}) — ${i.injury_designation}${i.injury_description ? `, ${i.injury_description}` : ''}`).join('\n'));
    L.push('');

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, L.join('\n'));
    console.log(`Digest written to ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);
}

main()
    .then(() => db.close())
    .catch(err => {
        console.error(`recap-data failed: ${err.message}`);
        db.close();
        process.exit(1);
    });
