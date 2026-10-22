#!/usr/bin/env node
'use strict';
const { applyDossierTotals } = require('./lib/doublecheckPointComparison');

/**
 * Double Check — deterministic extraction layer.
 *
 * Usage:
 *   node scripts/doublecheck-data.js <season> <week> [--db <path>] [--out <dir>]
 *        [--offline] [--no-espn] [--refresh] [--rerun-standings] [--quiet]
 *
 * Reads the league database READ-ONLY (never writes it), pulls the week's ESPN
 * game summaries into a permanent file cache, independently recomputes every
 * player's points (scripts/lib/doublecheckRubric.js — which does NOT import the
 * production scoring code), re-selects every scoring lineup, builds a
 * touchdown dossier per game (Tank01 + ESPN scoring plays with possession
 * data), runs one named check per historical bug class
 * (scripts/lib/doublecheckChecks.js) and writes a file workspace
 * (docs/DOUBLECHECK.md):
 *
 *   logs/doublecheck/<season>/week<NN>/
 *     manifest.json  checks.json  questions.json  league.md  games/game-<gameId>.md
 *
 * questions.json holds what the rules could not decide (ambiguous scoring
 * plays, disagreeing possession votes); scripts/doublecheck-reconcile.js asks
 * Claude Opus to answer them and scripts/doublecheck-finalize.js applies
 * rulings > resolutions to the findings.
 *
 * Findings never change data. The report says what logic to fix and which
 * recalc to run (CLAUDE.md: never fix stats by editing the database).
 *
 * --db <path>          audit another database (e.g. a pre-correction backup);
 *                      opened immutable so its -wal/-shm are never touched
 * --out <dir>          workspace directory (default logs/doublecheck/<season>/week<NN>)
 * --offline            ESPN from the file cache only (no network)
 * --no-espn            skip ESPN entirely (ESPN-dependent checks DEFER)
 * --refresh            rebuild even if a fresh workspace exists
 * --rerun-standings    after the manual weekly update: offline re-extract so the
 *                      standings checks (A1/F3/F4) stop deferring
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');

const rubric = require('./lib/doublecheckRubric');
const { selectLineup, compareLineups } = require('./lib/doublecheckLineup');
const checks = require('./lib/doublecheckChecks');
const espnClient = require('./lib/espnClient');
const espnNormalize = require('./lib/espnNormalize');
const { getTeamAbbreviation } = require('../server/utils/teamMappings');
const seasonMatchups = require('../server/config/seasonMatchups');

let tdDossier = null;
try { tdDossier = require('./lib/tdDossier'); } catch (e) { tdDossier = null; }

const REPO = path.join(__dirname, '..');
const DEFAULT_DB = path.join(REPO, 'fantasy_football.db');
const LOG_ROOT = path.join(REPO, 'logs/doublecheck');
const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const positional = argv.filter(a => !a.startsWith('--'));
const flag = f => argv.includes(f);
const optVal = f => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };

const season = parseInt(positional[0], 10);
const week = parseInt(positional[1], 10);
if (!season || !week || week < 1 || week > 18) {
    console.error('Usage: node scripts/doublecheck-data.js <season> <week> [--db <path>] [--out <dir>] [--offline] [--no-espn] [--refresh] [--rerun-standings] [--quiet]');
    process.exit(2);
}
const OPTS = {
    db: optVal('--db') ? path.resolve(optVal('--db')) : DEFAULT_DB,
    out: optVal('--out') ? path.resolve(optVal('--out')) : path.join(LOG_ROOT, String(season), `week${weekPad(week)}`),
    offline: flag('--offline') || flag('--rerun-standings'),
    noEspn: flag('--no-espn'),
    refresh: flag('--refresh'),
    rerunStandings: flag('--rerun-standings'),
    quiet: flag('--quiet')
};
const IS_LIVE_DB = OPTS.db === DEFAULT_DB;
const HASH_DIR = optVal('--out') ? OPTS.out : LOG_ROOT;

function weekPad(w) { return String(w).padStart(2, '0'); }
function log(msg) { if (!OPTS.quiet) console.log(`[${new Date().toISOString()}] ${msg}`); }
function num(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function r2(x) { return Math.round(x * 100) / 100; }
function fmt(v) { return v === null || v === undefined ? '-' : (Number.isInteger(v) ? String(v) : (typeof v === 'number' ? String(r2(v)) : String(v))); }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }; }
function writeFile(p, content) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }
function isFinal(status) { return /^Final/i.test(String(status || '')); }

// ---------------------------------------------------------------- db

function openDb() {
    const uri = IS_LIVE_DB ? OPTS.db : `file:${OPTS.db}?immutable=1`;
    const mode = IS_LIVE_DB ? sqlite3.OPEN_READONLY : (sqlite3.OPEN_READONLY | sqlite3.OPEN_URI);
    return new Promise((res, rej) => {
        const db = new sqlite3.Database(uri, mode, err => (err ? rej(new Error(`Cannot open ${OPTS.db} read-only: ${err.message}`)) : res(db)));
    });
}
const all = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
const get = (db, sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));

const STAT_COLUMNS = ['passing_yards', 'passing_tds', 'interceptions', 'rushing_yards', 'rushing_tds', 'receiving_yards', 'receiving_tds', 'receptions',
    'fumbles', 'sacks', 'def_interceptions', 'fumbles_recovered', 'def_touchdowns', 'safeties', 'points_allowed', 'yards_allowed',
    'field_goals_made', 'field_goals_attempted', 'extra_points_made', 'extra_points_attempted',
    'two_point_conversions_pass', 'two_point_conversions_run', 'two_point_conversions_rec',
    'return_tds', 'kick_return_tds', 'punt_return_tds', 'def_int_return_tds', 'def_fumble_return_tds', 'def_blocked_return_tds',
    'def_points_bonus', 'def_yards_bonus', 'fantasy_points'];
const COMPARE_FIELDS = ['passing_yards', 'passing_tds', 'interceptions', 'rushing_yards', 'rushing_tds', 'receiving_yards', 'receiving_tds', 'receptions',
    'field_goals_made', 'field_goals_attempted', 'extra_points_made', 'extra_points_attempted',
    'two_point_conversions_pass', 'two_point_conversions_run', 'two_point_conversions_rec', 'kick_return_tds', 'punt_return_tds'];
const DST_COMPARE_FIELDS = ['points_allowed', 'yards_allowed', 'sacks', 'def_interceptions', 'safeties', 'def_int_return_tds', 'def_fumble_return_tds', 'def_blocked_return_tds'];
const NONZERO_STAT_FIELDS = STAT_COLUMNS.filter(c => !['fantasy_points', 'def_points_bonus', 'def_yards_bonus', 'points_allowed', 'yards_allowed'].includes(c));

async function buildSnapshot(db) {
    const S = { season, week, dbPath: OPTS.db, nowIso: new Date().toISOString() };
    S.settings = await get(db, 'SELECT * FROM league_settings LIMIT 1') || {};
    S.currentWeek = num(S.settings.current_week);
    S.currentSeason = num(S.settings.season_year);
    S.lastDailyUpdate = S.settings.last_daily_update ? toIso(S.settings.last_daily_update) : null;

    const teams = await all(db, 'SELECT team_id, team_name, owner_name FROM teams ORDER BY team_id');
    S.teams = new Map(teams.map(t => [t.team_id, t]));
    S.teamRows = teams;

    const games = await all(db, 'SELECT * FROM nfl_games WHERE season = ? ORDER BY week, game_date, game_id', [season]);
    // *_raw keeps the stored value: D1 checks the raw codes, everything else joins on the canonical ones.
    S.seasonGames = games.map(g => ({ ...g, home_team_raw: g.home_team, away_team_raw: g.away_team, home_team: getTeamAbbreviation(g.home_team) || g.home_team, away_team: getTeamAbbreviation(g.away_team) || g.away_team, final: isFinal(g.status) }));
    S.weekGames = S.seasonGames.filter(g => g.week === week);
    S.gamesById = new Map(S.seasonGames.map(g => [g.game_id, g]));
    if (S.weekGames.length === 0) throw new Error(`No nfl_games rows for ${season} week ${week} - nothing to check (offseason or schedule not loaded).`);

    S.rosters = await all(db, `SELECT wr.*, t.owner_name AS owner FROM weekly_rosters wr JOIN teams t ON t.team_id = wr.team_id WHERE wr.season = ? AND wr.week = ? ORDER BY wr.team_id, wr.player_position, wr.player_name`, [season, week]);
    S.rosterCounts = await all(db, `SELECT season, week, team_id,
            SUM(CASE WHEN roster_position = 'active' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN roster_position = 'injured_reserve' THEN 1 ELSE 0 END) AS ir,
            COUNT(*) AS total FROM weekly_rosters WHERE season = ? GROUP BY season, week, team_id`, [season]);

    S.stats = await all(db, `SELECT ps.*, COALESCE(NULLIF(ps.position, ''), np.position) AS pos, np.name AS np_name, np.team AS np_team
        FROM player_stats ps LEFT JOIN nfl_players np ON np.player_id = ps.player_id WHERE ps.season = ? AND ps.week = ?`, [season, week]);
    for (const r of S.stats) { r.position = r.pos; r.name = r.player_name || r.np_name || r.player_id; r.team_raw = r.team || null; r.team = getTeamAbbreviation(r.team || r.np_team || '') || r.team || r.np_team || null; }

    const players = await all(db, 'SELECT player_id, name, position, team, last_updated, injury_designation FROM nfl_players');
    S.players = new Map(players.map(p => [p.player_id, { ...p, team: getTeamAbbreviation(p.team) || p.team }]));

    S.matchups = await all(db, 'SELECT * FROM matchups WHERE season = ? AND week = ? ORDER BY matchup_id', [season, week]);
    S.seasonMatchups = await all(db, 'SELECT * FROM matchups WHERE season = ? ORDER BY week, matchup_id', [season]);
    S.standingsCur = await all(db, 'SELECT * FROM weekly_standings WHERE season = ? AND week = ?', [season, week]);
    S.standingsPrev = week > 1 ? await all(db, 'SELECT * FROM weekly_standings WHERE season = ? AND week = ?', [season, week - 1]) : [];

    // Tank01 cache: boxscores keyed by the nfl_games.game_id (Tank01 ids keep WSH), player list for positions
    S.boxscores = new Map();
    for (const g of S.weekGames) {
        const row = await get(db, 'SELECT response_data FROM tank01_cache WHERE cache_key = ?', [`boxscore_${g.game_id}`]);
        if (!row) continue;
        try { const j = JSON.parse(row.response_data); S.boxscores.set(g.game_id, j.body || j); } catch (_) { /* ignore bad cache */ }
    }
    S.playerPositions = new Map();
    const pl = await get(db, "SELECT response_data FROM tank01_cache WHERE cache_key = 'playerList'");
    if (pl) {
        try { for (const p of (JSON.parse(pl.response_data).body || [])) S.playerPositions.set(String(p.playerID), { name: p.longName, pos: p.pos, team: getTeamAbbreviation(p.team) || p.team }); } catch (_) { /* ignore */ }
    }

    S.dupes = {
        player_stats: await all(db, 'SELECT player_id, week, COUNT(*) AS n FROM player_stats WHERE season = ? GROUP BY player_id, week HAVING n > 1', [season]),
        weekly_rosters: await all(db, 'SELECT team_id, player_id, week, COUNT(*) AS n FROM weekly_rosters WHERE season = ? GROUP BY team_id, player_id, week HAVING n > 1', [season]),
        matchups: await all(db, 'SELECT week, MIN(team1_id, team2_id) AS team1_id, MAX(team1_id, team2_id) AS team2_id, COUNT(*) AS n FROM matchups WHERE season = ? AND is_playoff = 0 GROUP BY week, MIN(team1_id, team2_id), MAX(team1_id, team2_id) HAVING n > 1', [season])
    };
    S.legacyReturnTds = (await get(db, 'SELECT COUNT(*) AS c FROM player_stats WHERE return_tds > 0')).c;

    // IR returns: active this week, IR last week -> how many consecutive IR weeks before this one
    S.irReturns = [];
    if (week > 1) {
        const hist = await all(db, 'SELECT week, team_id, player_id, player_name, roster_position FROM weekly_rosters WHERE season = ? AND week < ? ORDER BY player_id, week DESC', [season, week]);
        const byPlayer = new Map();
        for (const h of hist) { if (!byPlayer.has(h.player_id)) byPlayer.set(h.player_id, []); byPlayer.get(h.player_id).push(h); }
        for (const r of S.rosters) {
            if (r.roster_position !== 'active') continue;
            const h = byPlayer.get(r.player_id) || [];
            if (!h.length || h[0].week !== week - 1 || h[0].roster_position !== 'injured_reserve') continue;
            let n = 0; for (const x of h) { if (x.roster_position === 'injured_reserve') n++; else break; }
            S.irReturns.push({ player_id: r.player_id, player_name: r.player_name, team_id: r.team_id, owner: r.owner, weeksOnIr: n });
        }
    }

    // never-varies: non-zero counts per column for this week and prior weeks
    const nvCols = checks.NV_COLUMNS;
    const nvSql = `SELECT week, ${nvCols.map(c => `SUM(CASE WHEN ${c} > 0 THEN 1 ELSE 0 END) AS ${c}`).join(', ')} FROM player_stats WHERE season = ? AND week <= ? GROUP BY week`;
    const nvRows = await all(db, nvSql, [season, week]);
    S.nvCurrent = nvRows.find(r => r.week === week) || {};
    S.nvPrior = {};
    for (const c of nvCols) S.nvPrior[c] = nvRows.filter(r => r.week < week).map(r => num(r[c]));

    // season-wide compact rows for closed-week hashes
    S.hashRows = {
        rosters: await all(db, 'SELECT week, team_id, player_id, roster_position, is_scoring FROM weekly_rosters WHERE season = ? AND week < ? ORDER BY week, team_id, player_id', [season, week]),
        stats: await all(db, 'SELECT week, player_id, fantasy_points FROM player_stats WHERE season = ? AND week < ? ORDER BY week, player_id', [season, week]),
        matchups: S.seasonMatchups.filter(m => m.week < week)
    };

    // matchup template for this season (only when a reviewed draft order exists)
    try { S.template = seasonMatchups.buildRegularSeasonMatchups(season, teams).weeks[week] || null; } catch (_) { S.template = null; }

    // operational context (live repo only)
    S.validation = readJson(path.join(REPO, 'logs/weekly-validation-latest.json'));
    S.watchdog = readJson(path.join(REPO, 'logs/watchdog/live-latest.json'));
    S.maintenanceLock = fs.existsSync(path.join(REPO, 'logs/maintenance.lock'));
    return S;
}

function toIso(dbTs) {
    // SQLite CURRENT_TIMESTAMP is UTC without a zone marker
    const s = String(dbTs);
    if (/[TZ]/.test(s)) return new Date(s).toISOString();
    return new Date(s.replace(' ', 'T') + 'Z').toISOString();
}

// ---------------------------------------------------------------- espn

async function pullEspn(S) {
    const espn = { ok: false, fetched: 0, cached: 0, failed: [], facts: new Map(), lines: new Map(), dst: new Map(), eventByGame: new Map(), summaries: new Map(), unmatchedGames: [], unmatchedEvents: [] };
    if (OPTS.noEspn) { espn.failed.push({ gameId: '*', error: '--no-espn' }); return espn; }
    let res;
    try {
        res = await espnClient.fetchWeek(season, week, S.weekGames.map(g => ({ game_id: g.game_id, home_team: g.home_team, away_team: g.away_team, status: g.status })), { offline: OPTS.offline });
    } catch (e) {
        espn.failed.push({ gameId: '*', error: e.message });
        return espn;
    }
    espn.fetched = res.status.fetched; espn.cached = res.status.cached; espn.failed = res.status.failed || [];
    espn.unmatchedGames = res.unmatchedGames || []; espn.unmatchedEvents = res.unmatchedEvents || [];
    for (const m of res.matches) espn.eventByGame.set(m.gameId, m);
    espn.stale = [];
    for (const [gameId, body] of res.summaries) {
        if (!body) continue;
        const ev = espn.eventByGame.get(gameId) || {};
        // A game that is Final internally must be compared against a COMPLETE ESPN
        // summary; a cached in-progress snapshot (.partial.json from --offline or a
        // fetch that beat ESPN's status flip) would produce false stat mismatches.
        let facts = null;
        try { facts = espnNormalize.gameFacts(body); } catch (e) { espn.failed.push({ gameId, error: `normalize: ${e.message}` }); continue; }
        const g = S.gamesById.get(gameId);
        if (g && g.final && !facts.completed) {
            espn.stale.push(gameId);
            espn.failed.push({ gameId, eventId: ev.eventId, error: 'ESPN summary is not complete although the game is Final (stale partial cache; rerun without --offline)' });
            continue;
        }
        espn.summaries.set(gameId, body);
        try {
            espn.facts.set(gameId, facts);
            const pl = espnNormalize.playerLines(body, { gameId, eventId: ev.eventId });
            for (const [pid, line] of pl.lines) espn.lines.set(String(pid), line);
            for (const [pid, line] of espnNormalize.dstLines(body, { gameId, eventId: ev.eventId })) espn.dst.set(pid, line);
        } catch (e) {
            espn.failed.push({ gameId, error: `normalize: ${e.message}` });
        }
    }
    // ok = every FINAL game we know about has a usable summary
    const finalIds = S.weekGames.filter(g => g.final).map(g => g.game_id);
    const missingFinal = finalIds.filter(id => !espn.summaries.has(id));
    espn.ok = missingFinal.length === 0 && !espn.failed.some(f => f.gameId === '*');
    espn.missingFinal = missingFinal;
    return espn;
}

// ---------------------------------------------------------------- dossiers

function buildDossiers(S, espn) {
    const dossiers = new Map();
    for (const g of S.weekGames) {
        const box = S.boxscores.get(g.game_id) || null;
        const summary = espn.summaries.get(g.game_id) || null;
        if (!box && !summary) continue;
        const dbRows = S.stats.filter(r => r.game_id === g.game_id);
        if (tdDossier) {
            try {
                const finalScore = g.final && g.home_score !== null && g.home_score !== undefined && g.away_score !== null && g.away_score !== undefined ? { home: g.home_score, away: g.away_score } : null;
                dossiers.set(g.game_id, tdDossier.buildGameDossier({ gameId: g.game_id, season, week, homeTeam: g.home_team, awayTeam: g.away_team, tank01Body: box, espnSummary: summary, playerPositions: S.playerPositions, nflPlayers: S.players, dbRows, finalScore }));
            } catch (e) {
                dossiers.set(g.game_id, { gameId: g.game_id, plays: [], unmatched: { tank01Only: [], espnOnly: [] }, expectedTotals: {}, dbTotals: {}, discrepancies: [], error: e.message, summary: { tds: 0, agreed: 0, disagreed: 0, ambiguous: 0 } });
            }
        } else {
            dossiers.set(g.game_id, { gameId: g.game_id, plays: [], unmatched: { tank01Only: [], espnOnly: [] }, expectedTotals: {}, dbTotals: {}, discrepancies: [], error: 'tdDossier module not available', summary: { tds: 0, agreed: 0, disagreed: 0, ambiguous: 0 } });
        }
    }
    return dossiers;
}

// ---------------------------------------------------------------- compute

function hasNonZero(row, fields) { return fields.some(f => num(row[f]) !== 0); }

function compute(S, espn, dossiers) {
    const C = { espn, dossiers, players: new Map(), teams: new Map(), matchups: [], standingsCur: new Map(), standingsPrev: new Map() };
    C.gameCount = S.weekGames.length;
    C.finalCount = S.weekGames.filter(g => g.final).length;
    C.allFinal = C.finalCount === C.gameCount;
    for (const s of S.standingsCur) C.standingsCur.set(s.team_id, s);
    for (const s of S.standingsPrev) C.standingsPrev.set(s.team_id, s);
    C.standingsPresent = C.standingsCur.size > 0;

    const gameByTeam = new Map();
    for (const g of S.weekGames) { gameByTeam.set(g.home_team, g); gameByTeam.set(g.away_team, g); }

    // expected TD-column totals per player from the dossiers
    const tdExpected = new Map(); // pid -> {column: n}
    for (const d of dossiers.values()) {
        for (const [pid, cols] of Object.entries(d.expectedTotals || {})) {
            const cur = tdExpected.get(pid) || {}; for (const [c, n] of Object.entries(cols)) cur[c] = num(cur[c]) + num(n); tdExpected.set(pid, cur);
        }
    }

    const ids = new Set();
    for (const r of S.rosters) ids.add(String(r.player_id));
    for (const r of S.stats) ids.add(String(r.player_id));
    for (const [pid, line] of espn.lines) { if (S.players.has(pid) && hasNonZero(line, COMPARE_FIELDS)) ids.add(pid); }
    for (const pid of espn.dst.keys()) if (S.players.has(pid)) ids.add(pid);

    const internalById = new Map(S.stats.map(r => [String(r.player_id), r]));
    const rosterById = new Map(S.rosters.map(r => [String(r.player_id), r]));

    for (const pid of ids) {
        const np = S.players.get(pid) || null;
        const internal = internalById.get(pid) || null;
        const roster = rosterById.get(pid) || null;
        const isDst = pid.startsWith('DEF_') || (np && np.position === 'DST') || (roster && roster.player_position === 'DST');
        const position = isDst ? 'DST' : ((internal && internal.position) || (np && np.position) || (roster && roster.player_position) || null);
        const espnLine = isDst ? (espn.dst.get(pid) || null) : (espn.lines.get(pid) || null);
        const nflTeam = (roster && roster.player_team) || (internal && internal.team) || (espnLine && espnLine.team) || (np && np.team) || null;
        let game = internal && internal.game_id ? S.gamesById.get(internal.game_id) || null : null;
        if (!game && espnLine && espnLine.gameId) game = S.gamesById.get(espnLine.gameId) || null;
        if (!game && nflTeam) game = gameByTeam.get(nflTeam) || null;
        const P = {
            player_id: pid, name: (np && np.name) || (roster && roster.player_name) || (internal && internal.name) || (espnLine && espnLine.name) || pid,
            position, nflTeam, roster: roster ? { team_id: roster.team_id, owner: roster.owner, roster_position: roster.roster_position, is_scoring: num(roster.is_scoring), scoring_slot: roster.scoring_slot, ir_date: roster.ir_date, player_team: roster.player_team } : null,
            internal, espn: espnLine, game, bye: !game,
            pointsStored: internal ? num(internal.fantasy_points) : 0,
            hasStats: internal ? hasNonZero(internal, NONZERO_STAT_FIELDS) : false
        };
        const ri = rubric.pointsFor(internal || {}, position);
        P.pointsInternal = internal ? ri.points : 0;
        P.breakdownInternal = ri.breakdown;
        // ESPN-derived row
        if (espnLine) {
            const row = {};
            if (isDst) {
                row.points_allowed = espnLine.points_allowed; row.yards_allowed = espnLine.yards_allowed; row.sacks = espnLine.sacks; row.def_interceptions = espnLine.def_interceptions;
                row.safeties = espnLine.safeties;
                row.def_points_bonus = internal ? internal.def_points_bonus : 0; row.def_yards_bonus = internal ? internal.def_yards_bonus : 0; // bonuses cancel out; B6 checks them
                row.def_int_return_tds = 0; row.def_fumble_return_tds = 0; row.def_blocked_return_tds = 0;
            } else {
                for (const f of COMPARE_FIELDS) row[f] = num(espnLine[f]);
            }
            const exp = tdExpected.get(pid);
            const dossier = game ? dossiers.get(game.game_id) : null;
            Object.assign(row, applyDossierTotals(row, exp, { isDst, dossier }));
            P.espnRow = row;
            const re = rubric.pointsFor(row, position);
            P.pointsEspn = re.points; P.breakdownEspn = re.breakdown;
            const fields = isDst ? DST_COMPARE_FIELDS : COMPARE_FIELDS;
            P.diffs = [];
            for (const f of fields) {
                const iv = internal ? (internal[f] === null || internal[f] === undefined ? null : num(internal[f])) : null;
                const ev = row[f] === null || row[f] === undefined ? null : num(row[f]);
                if (iv === ev) continue;
                if (internal === null) continue;
                let affects = false;
                if (!isDst || !['points_allowed', 'yards_allowed', 'sacks', 'def_interceptions'].includes(f)) {
                    const patched = { ...internal, [f]: ev };
                    affects = Math.abs(rubric.pointsFor(patched, position).points - P.pointsInternal) > 0.005;
                }
                P.diffs.push({ field: f, internal: iv, espn: ev, affectsPoints: affects });
            }
        } else {
            P.espnRow = null; P.pointsEspn = null; P.breakdownEspn = []; P.diffs = [];
        }
        // status
        if (!game) P.status = 'BYE';
        else if (!game.final) P.status = internal ? 'IN_PROGRESS' : 'NOT_STARTED';
        else if (!internal && espnLine && (isDst || hasNonZero(espnLine, COMPARE_FIELDS))) P.status = 'INTERNAL_MISSING';
        else if (internal && !espnLine && espn.ok && P.hasStats) P.status = 'ESPN_MISSING';
        else if (!internal && !espnLine) P.status = 'NO_STATS';
        else if (internal && !espnLine) P.status = espn.ok ? 'NO_STATS' : 'ESPN_UNAVAILABLE';
        else P.status = P.diffs.length ? 'DIFF' : 'MATCH';
        P.internalSummary = internal ? Object.fromEntries(STAT_COLUMNS.filter(c => num(internal[c]) !== 0).map(c => [c, internal[c]])) : null;
        P.espnSummary = espnLine ? Object.fromEntries(Object.entries(P.espnRow || {}).filter(([, v]) => num(v) !== 0)) : null;
        P.truthPoints = P.espnRow ? P.pointsEspn : P.pointsStored;
        C.players.set(pid, P);
    }

    // teams
    for (const t of S.teamRows) {
        const rows = S.rosters.filter(r => r.team_id === t.team_id);
        if (!rows.length) continue;
        const roster = rows.map(r => C.players.get(String(r.player_id))).filter(Boolean);
        const T = { team_id: t.team_id, owner: t.owner_name, team_name: t.team_name, roster, activeCount: rows.filter(r => r.roster_position === 'active').length, irCount: rows.filter(r => r.roster_position === 'injured_reserve').length };
        const lineupInput = pts => roster.map(P => ({ player_id: P.player_id, position: P.position, roster_position: P.roster.roster_position, points: pts(P), points_allowed: P.internal ? P.internal.points_allowed : (P.espn ? P.espn.points_allowed : null), yards_allowed: P.internal ? P.internal.yards_allowed : (P.espn ? P.espn.yards_allowed : null) }));
        const storedRows = roster.map(P => ({ player_id: P.player_id, is_scoring: P.roster.is_scoring, points: P.pointsStored }));
        T.storedIds = new Set(storedRows.filter(r => r.is_scoring === 1).map(r => r.player_id));
        T.storedTotal = r2(storedRows.filter(r => r.is_scoring === 1).reduce((s, r) => s + r.points, 0));
        T.indInternal = selectLineup(lineupInput(P => P.pointsStored));
        T.cmpInternal = compareLineups(storedRows, T.indInternal);
        T.indTruth = selectLineup(lineupInput(P => P.truthPoints));
        T.truthTotal = espn.ok || espn.summaries.size ? T.indTruth.total : null;
        C.teams.set(t.team_id, T);
    }

    // matchups
    for (const m of S.matchups) {
        const T1 = C.teams.get(m.team1_id), T2 = C.teams.get(m.team2_id);
        const M = {
            matchup_id: m.matchup_id, team1_id: m.team1_id, team2_id: m.team2_id, is_playoff: num(m.is_playoff),
            owner1: T1 ? T1.owner : String(m.team1_id), owner2: T2 ? T2.owner : String(m.team2_id),
            stored1: num(m.team1_scoring_points), stored2: num(m.team2_scoring_points),
            lineupSum1: T1 ? T1.storedTotal : 0, lineupSum2: T2 ? T2.storedTotal : 0,
            espn1: T1 && T1.truthTotal !== null ? T1.truthTotal : null, espn2: T2 && T2.truthTotal !== null ? T2.truthTotal : null
        };
        const w = (a, b) => (Math.abs(a - b) < 0.001 ? 'tie' : a > b ? 1 : 2);
        M.winnerStored = w(M.stored1, M.stored2);
        M.winnerEspn = M.espn1 !== null && M.espn2 !== null ? w(M.espn1, M.espn2) : null;
        M.flipsEspn = M.winnerEspn !== null && M.winnerEspn !== M.winnerStored;
        C.matchups.push(M);
    }

    // bonuses: pool = DSTs on ANY roster row this week with a stat row (mirrors calculateDefensiveBonuses)
    const pool = [];
    for (const r of S.rosters) {
        if (!String(r.player_id).startsWith('DEF_')) continue;
        const P = C.players.get(String(r.player_id));
        if (!P || !P.internal || P.internal.points_allowed === null) continue;
        pool.push({ player_id: P.player_id, points_allowed: P.internal.points_allowed, yards_allowed: P.internal.yards_allowed, stored_points_bonus: num(P.internal.def_points_bonus), stored_yards_bonus: num(P.internal.def_yards_bonus), roster_position: r.roster_position, team_id: r.team_id, owner: r.owner });
    }
    C.bonuses = { pool, expected: rubric.defensiveBonuses(pool) };

    // closed-week hashes
    C.hashes = computeHashes(S);
    return C;
}

function computeHashes(S) {
    const file = path.join(HASH_DIR, `hashes-${season}.json`);
    const prev = readJson(file) || { season, weeks: {} };
    const out = { season, updatedAt: new Date().toISOString(), dbPath: OPTS.db, weeks: { ...prev.weeks } };
    const res = { checked: [], changed: [], firstRun: !readJson(file) };
    const weeks = new Set([...S.hashRows.rosters.map(r => r.week), ...S.hashRows.stats.map(r => r.week), ...S.hashRows.matchups.map(r => r.week)]);
    for (const w of [...weeks].sort((a, b) => a - b)) {
        const parts = {
            rosters: S.hashRows.rosters.filter(r => r.week === w).map(r => `${r.team_id}|${r.player_id}|${r.roster_position}|${num(r.is_scoring)}`).join('\n'),
            stats: S.hashRows.stats.filter(r => r.week === w).map(r => `${r.player_id}|${r2(num(r.fantasy_points))}`).join('\n'),
            matchups: S.hashRows.matchups.filter(r => r.week === w).map(r => `${r.team1_id}|${r.team2_id}|${r2(num(r.team1_scoring_points))}|${r2(num(r.team2_scoring_points))}`).join('\n')
        };
        const h = {}; for (const [k, v] of Object.entries(parts)) h[k] = crypto.createHash('sha256').update(v).digest('hex').slice(0, 16);
        const old = prev.weeks && prev.weeks[w];
        if (old && old.dbPath === OPTS.db) {
            const diff = Object.keys(h).filter(k => old[k] !== h[k]);
            if (diff.length) res.changed.push({ week: w, what: diff.join(', '), previous: Object.fromEntries(diff.map(k => [k, old[k]])), current: Object.fromEntries(diff.map(k => [k, h[k]])) });
            else res.checked.push(w);
        } else if (old) {
            res.checked.push(w); // different DB; don't compare
        }
        out.weeks[w] = { ...h, dbPath: OPTS.db, recordedAt: old && old.dbPath === OPTS.db && !res.changed.some(c => c.week === w) ? old.recordedAt : new Date().toISOString() };
    }
    res.file = file; res.next = out;
    return res;
}

// ---------------------------------------------------------------- writers

function playerFields(P) {
    return P.position === 'DST' ? DST_COMPARE_FIELDS : COMPARE_FIELDS;
}

/** One row per rostered player: internal vs ESPN, scoring-relevant columns only. */
function playerRow(P) {
    const diffs = (P.diffs || []).map(d => `${d.field} ${fmt(d.internal)}→${fmt(d.espn)}${d.affectsPoints ? '!' : ''}`).join('; ');
    const nonzero = P.internal ? playerFields(P).filter(f => num(P.internal[f]) !== 0).map(f => `${f} ${fmt(P.internal[f])}`).join(', ') : 'no row';
    const rp = P.roster ? `${P.roster.roster_position === 'active' ? 'active' : 'IR'}${P.roster.is_scoring ? ` · slot ${P.roster.scoring_slot || '?'}` : ''}` : '-';
    return `<a id="player-${P.player_id}"></a>| ${P.name} (${P.player_id}) | ${P.position || '?'} | ${P.nflTeam || '?'} | ${rp} | ${P.game ? `${P.game.game_id} (${P.game.status})` : 'BYE'} | ${P.status} | ${fmt(P.pointsStored)} | ${fmt(P.pointsInternal)} | ${P.pointsEspn === null ? 'n/a' : fmt(P.pointsEspn)} | ${nonzero} | ${diffs} |`;
}

function writeTeamsSection(S, C, result, L) {
    L.push('<a id="teams"></a>');
    L.push('## Teams (rosters, stored lineups, stats vs ESPN)');
    L.push('');
    for (const T of C.teams.values()) {
        const m = C.matchups.find(x => x.team1_id === T.team_id || x.team2_id === T.team_id);
        const oppId = m ? (m.team1_id === T.team_id ? m.team2_id : m.team1_id) : null;
        const opp = oppId ? C.teams.get(oppId) : null;
        const teamFindings = result.findings.filter(f => f.entity && f.entity.fantasyTeamId === T.team_id && f.severity !== 'INFO');
        L.push(`<a id="team-${T.team_id}"></a>`);
        L.push(`### ${T.owner} — team_id ${T.team_id} ("${T.team_name}")`);
        L.push('');
        L.push(`- Roster: ${T.activeCount} active, ${T.irCount} IR (league rule: exactly 19 active)`);
        L.push(`- Matchup: ${m ? `vs ${opp ? opp.owner : oppId} — stored ${m.team1_id === T.team_id ? fmt(m.stored1) : fmt(m.stored2)} to ${m.team1_id === T.team_id ? fmt(m.stored2) : fmt(m.stored1)}${m.is_playoff ? ' (playoff row)' : ''}` : 'none this week'}`);
        L.push(`- Stored scoring lineup (is_scoring=1): ${T.storedIds.size} players, total ${fmt(T.storedTotal)} · independent best lineup on stored points: ${fmt(T.indInternal.total)} — ${T.cmpInternal.totalsMatch && T.cmpInternal.setsMatch ? 'MATCHES' : `DIFFERS: only-stored [${T.cmpInternal.onlyStored.join(', ')}], only-independent [${T.cmpInternal.onlyIndependent.join(', ')}]`} · ESPN-truth best lineup: ${T.truthTotal === null ? 'n/a' : fmt(T.truthTotal)}`);
        L.push(`  - slots: ${T.indInternal.selected.map(sl => `${sl.slot}=${(C.players.get(String(sl.player_id)) || { name: sl.player_id }).name} ${fmt(sl.points)}`).join('; ')}`);
        if (teamFindings.length) L.push(`- Findings: ${teamFindings.map(f => `[${f.severity}] ${f.bugClassRef} ${f.check}: ${f.explanation}`).join(' · ')}`);
        L.push('');
        L.push('| player | pos | team | roster | game | status | stored pts | rubric(internal) | rubric(ESPN) | internal stats | differences vs ESPN |');
        L.push('|---|---|---|---|---|---|---|---|---|---|---|');
        const ordered = [...T.roster].sort((a, b) => (a.roster.roster_position === b.roster.roster_position ? 0 : a.roster.roster_position === 'active' ? -1 : 1) || String(a.position).localeCompare(String(b.position)) || a.name.localeCompare(b.name));
        for (const P of ordered) L.push(playerRow(P));
        L.push('');
    }
}

function writeGameFiles(S, C) {
    for (const g of S.weekGames) {
        const d = C.dossiers.get(g.game_id);
        const file = path.join(OPTS.out, checks.gameFile(g.game_id));
        let md;
        if (d && tdDossier && typeof tdDossier.renderGameMarkdown === 'function' && !d.error) {
            md = tdDossier.renderGameMarkdown(d);
        } else {
            const L = [`# ${g.game_id} — ${g.away_team} ${fmt(g.away_score)} @ ${g.home_team} ${fmt(g.home_score)} (${g.status})`, ''];
            if (!d) L.push('_No cached Tank01 boxscore and no ESPN summary for this game yet._');
            else L.push(`_Dossier unavailable: ${d.error}_`);
            md = L.join('\n');
        }
        const hdr = `<!-- season ${season} week ${week}; status ${g.status}; final=${g.final} -->\n`;
        writeFile(file, hdr + md + '\n');
    }
}

function writeLeague(S, C, result) {
    const L = [];
    L.push(`# League view — ${season} week ${week}`);
    L.push('');
    L.push(`Written by scripts/doublecheck-data.js (read-only). Findings and the checklist are in checks.json; open questions in questions.json; per-game scoring plays in games/. See docs/DOUBLECHECK.md.`);
    L.push('');
    L.push(`- current_week in league_settings: ${S.currentWeek} (season ${S.currentSeason}); games final ${C.finalCount}/${C.gameCount}; standings for week ${week}: ${C.standingsPresent ? 'present' : 'NOT written yet (manual weekly update)'}`);
    L.push(`- ESPN: ${C.espn.ok ? 'ok' : 'INCOMPLETE'} — ${C.espn.summaries.size} summaries (${C.espn.fetched} fetched, ${C.espn.cached} cached, ${C.espn.failed.length} failed)`);
    L.push(`- Questions for the reconcile step: ${result.questions.length}; defensive scores / candidates: ${result.defensiveScores.length}`);
    L.push('');
    L.push('<a id="matchups"></a>');
    L.push('## Matchups');
    L.push('');
    L.push('| matchup | team 1 | stored | lineup Σ | ESPN-truth | team 2 | stored | lineup Σ | ESPN-truth | winner (stored) | winner (ESPN) | flips? |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const m of C.matchups) L.push(`| ${m.matchup_id}${m.is_playoff ? ' (playoff)' : ''} | ${m.owner1} | ${fmt(m.stored1)} | ${fmt(m.lineupSum1)} | ${fmt(m.espn1)} | ${m.owner2} | ${fmt(m.stored2)} | ${fmt(m.lineupSum2)} | ${fmt(m.espn2)} | ${m.winnerStored === 'tie' ? 'tie' : m.winnerStored === 1 ? m.owner1 : m.owner2} | ${m.winnerEspn === null ? '-' : m.winnerEspn === 'tie' ? 'tie' : m.winnerEspn === 1 ? m.owner1 : m.owner2} | ${m.flipsEspn ? '**YES**' : 'no'} |`);
    if (S.template) { L.push(''); L.push(`Template pairings for week ${week} (docs/MATCHUPS.md via season_team_assignments): ${S.template.map(p => `${p.team1Owner} v ${p.team2Owner}`).join(', ')}`); }
    L.push('');
    L.push('<a id="standings"></a>');
    L.push('## Standings');
    L.push('');
    if (!C.standingsPresent) L.push(`_No weekly_standings rows for week ${week} yet — written by the manual weekly update. Standings checks DEFER._`);
    else {
        L.push('| team | prev W-L-T | cur W-L-T | prev cumulative | points_for_week | cur cumulative | rank |');
        L.push('|---|---|---|---|---|---|---|');
        for (const T of C.teams.values()) { const c = C.standingsCur.get(T.team_id) || {}, p = C.standingsPrev.get(T.team_id) || {}; L.push(`| ${T.owner} | ${fmt(p.wins)}-${fmt(p.losses)}-${fmt(p.ties)} | ${fmt(c.wins)}-${fmt(c.losses)}-${fmt(c.ties)} | ${fmt(p.cumulative_points)} | ${fmt(c.points_for_week)} | ${fmt(c.cumulative_points)} | ${fmt(c.weekly_rank)} |`); }
    }
    L.push('');
    L.push('<a id="dst"></a>');
    L.push('## Team defenses and bonuses');
    L.push('');
    L.push(`Bonus pool = every DST on any roster row this week with a stat row (${C.bonuses.pool.length}). Least points allowed: ${fmt(C.bonuses.expected.minPoints)}; least yards allowed: ${fmt(C.bonuses.expected.minYards)}. ${C.allFinal ? '' : '**Week not complete: bonuses are awarded at end of week.**'}`);
    L.push('');
    L.push('| DST | owner | roster | game | PA | YA | int/fum/blk TDs | safeties | stored pts bonus | expected | stored yds bonus | expected | fantasy_points |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const P of [...C.players.values()].filter(p => p.position === 'DST').sort((a, b) => a.player_id.localeCompare(b.player_id))) {
        const i = P.internal || {};
        L.push(`| ${P.player_id} | ${P.roster ? P.roster.owner : '-'} | ${P.roster ? P.roster.roster_position : '-'} | ${P.game ? `${P.game.game_id} (${P.game.status})` : 'bye'} | ${fmt(i.points_allowed)} | ${fmt(i.yards_allowed)} | ${fmt(i.def_int_return_tds)}/${fmt(i.def_fumble_return_tds)}/${fmt(i.def_blocked_return_tds)} | ${fmt(i.safeties)} | ${fmt(i.def_points_bonus)} | ${fmt(C.bonuses.expected.points.get(P.player_id) || 0)} | ${fmt(i.def_yards_bonus)} | ${fmt(C.bonuses.expected.yards.get(P.player_id) || 0)} | ${fmt(P.pointsStored)} |`);
    }
    L.push('');
    L.push('<a id="games"></a>');
    L.push('## Games');
    L.push('');
    L.push('| game | status | score | Tank01 boxscore cached | ESPN event | ESPN status | scoring plays (Tank01/ESPN) | TD verdicts agreed/disagreed/ambiguous | score check Tank01 / ESPN | questions |');
    L.push('|---|---|---|---|---|---|---|---|---|---|');
    const scLabel = t => (!t || t.ok === null ? '-' : t.ok ? 'OK' : `MISMATCH (${t.away}-${t.home})`);
    for (const g of S.weekGames) {
        const d = C.dossiers.get(g.game_id); const ev = C.espn.eventByGame.get(g.game_id); const f = C.espn.facts.get(g.game_id);
        L.push(`| ${g.game_id} | ${g.status} | ${g.away_team} ${fmt(g.away_score)} @ ${g.home_team} ${fmt(g.home_score)} | ${S.boxscores.has(g.game_id) ? 'yes' : 'NO'} | ${ev ? ev.eventId : '-'} | ${f ? f.statusName : '-'} | ${d ? `${d.plays.filter(p => p.tank01).length}/${d.plays.filter(p => p.espn).length}` : '-'} | ${d && d.summary ? `${d.summary.agreed}/${d.summary.disagreed}/${d.summary.ambiguous}` : '-'} | ${d && d.scoreCheck ? `${scLabel(d.scoreCheck.tank01)} / ${scLabel(d.scoreCheck.espn)}` : '-'} | ${d && d.summary ? fmt(d.summary.questions || 0) : '-'} |`);
    }
    L.push('');
    L.push('<a id="defensive-scores"></a>');
    L.push('## Defensive scores (takeaways, blocked kicks, safeties, and candidates)');
    L.push('');
    L.push('| game | play | kind | team | award class | votes (drive / gamebook / text) | agree | credited in DB | question |');
    L.push('|---|---|---|---|---|---|---|---|---|');
    for (const x of result.defensiveScores) L.push(`| ${x.gameId} | [${x.playIdx}](games/game-${x.gameId}.md#play-${x.playIdx}) | ${x.kind} | ${x.scoringTeam} | ${x.awardClass} | ${(x.votes || {}).drive || '-'} / ${(x.votes || {}).gamebook || '-'} / ${(x.votes || {}).text || '-'} | ${x.votesAgree === false ? '**no**' : 'yes'} | ${x.creditedTo.length ? x.creditedTo.map(c => `${c.player_id}.${c.column}`).join('; ') : 'nobody'} | ${x.questionId || ''} |`);
    if (!result.defensiveScores.length) L.push('| _none_ | | | | | | | | |');
    L.push('');
    L.push('<a id="questions"></a>');
    L.push('## Questions (what the rules could not decide)');
    L.push('');
    for (const q of result.questions) L.push(`- \`${q.id}\` — ${q.question}${q.gameId ? ` (${q.gameId}${q.playIdx ? ` play ${q.playIdx}` : ''})` : ''}${q.evidence && q.evidence.tank01Text ? `: "${q.evidence.tank01Text}"` : ''} · votes ${q.evidence && q.evidence.votes ? `${q.evidence.votes.drive || '-'} / ${q.evidence.votes.gamebook || '-'} / ${q.evidence.votes.text || '-'}` : '-'}`);
    if (!result.questions.length) L.push('None.');
    L.push('');
    L.push('<a id="rosters"></a>');
    L.push('## Roster invariants');
    L.push('');
    L.push('| team | owner | active | IR | DSTs (active) | is_scoring count | stored total | independent total |');
    L.push('|---|---|---|---|---|---|---|---|');
    for (const T of C.teams.values()) L.push(`| ${T.team_id} | ${T.owner} | ${T.activeCount} | ${T.irCount} | ${T.roster.filter(P => P.position === 'DST' && P.roster.roster_position === 'active').length} | ${T.storedIds.size} | ${fmt(T.storedTotal)} | ${fmt(T.indInternal.total)} |`);
    if (S.irReturns.length) { L.push(''); L.push(`IR returns this week: ${S.irReturns.map(r => `${r.player_name} (${r.owner}, ${r.weeksOnIr} wk on IR)`).join('; ')}`); }
    L.push('');
    L.push('<a id="team-codes"></a>');
    L.push('## Team codes');
    L.push('');
    const codes = new Set([...S.stats.map(r => r.team), ...S.rosters.map(r => r.player_team), ...S.weekGames.flatMap(g => [g.home_team, g.away_team])].filter(Boolean));
    L.push(`Distinct codes in use: ${[...codes].sort().join(', ')}`);
    L.push('');
    L.push('<a id="stat-diffs"></a>');
    L.push('## Player stat differences vs ESPN (all players with a stat row or an ESPN line)');
    L.push('');
    L.push('| player | pos | team | owner | status | stored pts | rubric(internal) | rubric(ESPN) | differences |');
    L.push('|---|---|---|---|---|---|---|---|---|');
    const withDiff = [...C.players.values()].filter(P => P.position !== 'DST' && (P.status === 'DIFF' || P.status === 'ESPN_MISSING' || P.status === 'INTERNAL_MISSING')).sort((a, b) => (b.roster ? 1 : 0) - (a.roster ? 1 : 0) || a.name.localeCompare(b.name));
    for (const P of withDiff) L.push(`| ${P.name} | ${P.position} | ${P.nflTeam} | ${P.roster ? P.roster.owner : '-'} | ${P.status} | ${fmt(P.pointsStored)} | ${fmt(P.pointsInternal)} | ${fmt(P.pointsEspn)} | ${(P.diffs || []).map(d => `${d.field} ${fmt(d.internal)}→${fmt(d.espn)}${d.affectsPoints ? '!' : ''}`).join('; ')} |`);
    if (!withDiff.length) L.push('| _none_ | | | | | | | | |');
    L.push('');
    L.push('## Unrostered players with stats');
    L.push('');
    L.push('| player | pos | team | game | stored pts | rubric(internal) | rubric(ESPN) | status |');
    L.push('|---|---|---|---|---|---|---|---|');
    for (const P of [...C.players.values()].filter(P => !P.roster && (P.internal || P.espn)).sort((a, b) => b.pointsStored - a.pointsStored)) {
        L.push(`<a id="unrostered-${P.player_id}"></a>| ${P.name} (${P.player_id}) | ${P.position} | ${P.nflTeam} | ${P.game ? P.game.game_id : '-'} | ${fmt(P.pointsStored)} | ${fmt(P.pointsInternal)} | ${fmt(P.pointsEspn)} | ${P.status} |`);
    }
    L.push('');
    L.push('<a id="season-invariants"></a>');
    L.push('## Season-wide invariants');
    L.push('');
    L.push(`- Duplicate rows: player_stats ${S.dupes.player_stats.length}, weekly_rosters ${S.dupes.weekly_rosters.length}, matchups ${S.dupes.matchups.length}; legacy return_tds rows: ${S.legacyReturnTds}`);
    L.push(`- Roster counts by week (active/IR): ${[...new Set(S.rosterCounts.map(r => r.week))].sort((a, b) => a - b).map(w => { const rows = S.rosterCounts.filter(r => r.week === w); return `wk${w}: ${rows.filter(r => r.active === 19).length}/${rows.length} teams at 19`; }).join('; ')}`);
    L.push(`- Closed-week hashes: ${C.hashes.checked.length} unchanged, ${C.hashes.changed.length} changed${C.hashes.firstRun ? ' (first run: baseline recorded)' : ''}`);
    L.push('');
    L.push('<a id="never-varies"></a>');
    L.push('## Signal counts (players with a non-zero value) — this week vs prior weeks');
    L.push('');
    L.push('| column | this week | prior weeks |');
    L.push('|---|---|---|');
    for (const c of checks.NV_COLUMNS) L.push(`| ${c} | ${fmt(num(S.nvCurrent[c]))} | ${(S.nvPrior[c] || []).join(', ') || '-'} |`);
    L.push('');
    L.push('<a id="checklist"></a>');
    L.push('## Script checklist');
    L.push('');
    L.push('| id | check | status | summary |');
    L.push('|---|---|---|---|');
    for (const c of result.checklist) L.push(`| ${c.id} | ${c.name} | ${c.status} | ${c.summary} |`);
    L.push('');
    L.push('## Findings (FAIL/WARN/DEFER)');
    L.push('');
    for (const f of result.findings.filter(f => f.severity !== 'INFO')) L.push(`- [${f.severity}] ${f.bugClassRef} ${f.check}${f.entity && f.entity.name ? ` — ${f.entity.name}` : ''}: ${f.explanation}`);
    L.push('');
    writeTeamsSection(S, C, result, L);
    writeFile(path.join(OPTS.out, 'league.md'), L.join('\n'));
}

function writeManifest(S, C, result, timing) {
    const scoreCheck = {
        games: S.weekGames.map(g => {
            const d = C.dossiers.get(g.game_id);
            const sc = d && d.scoreCheck;
            return { gameId: g.game_id, final: g.final, home: g.home_team, away: g.away_team, finalScore: sc ? sc.final : null,
                tank01: sc ? { home: sc.tank01.home, away: sc.tank01.away, plays: sc.tank01.plays, ok: sc.tank01.ok } : null,
                espn: sc ? { home: sc.espn.home, away: sc.espn.away, plays: sc.espn.plays, ok: sc.espn.ok } : null };
        })
    };
    scoreCheck.mismatches = scoreCheck.games.filter(g => g.final && ((g.tank01 && g.tank01.ok === false) || (g.espn && g.espn.ok === false))).map(g => g.gameId);
    scoreCheck.checked = scoreCheck.games.filter(g => g.final && ((g.tank01 && g.tank01.ok !== null) || (g.espn && g.espn.ok !== null))).length;
    const manifest = {
        schemaVersion: SCHEMA_VERSION, season, week, generatedAt: new Date().toISOString(), trigger: OPTS.rerunStandings ? 'standings-rerun' : (IS_LIVE_DB ? 'manual' : 'calibration'),
        dbPath: OPTS.db, workspace: OPTS.out, currentWeek: S.currentWeek, currentSeason: S.currentSeason,
        games: S.weekGames.map(g => ({ game_id: g.game_id, home: g.home_team, away: g.away_team, status: g.status, final: g.final, espnEventId: (C.espn.eventByGame.get(g.game_id) || {}).eventId || null, espnFetched: C.espn.summaries.has(g.game_id), boxscoreCached: S.boxscores.has(g.game_id), hasPlays: !!(C.dossiers.get(g.game_id) && C.dossiers.get(g.game_id).plays.length) })),
        gamesFinal: C.finalCount, gamesTotal: C.gameCount, allFinal: C.allFinal, standingsPresent: C.standingsPresent,
        espn: { ok: C.espn.ok, fetched: C.espn.fetched, cached: C.espn.cached, failed: C.espn.failed, missingFinal: C.espn.missingFinal || [], unmatchedGames: C.espn.unmatchedGames, unmatchedEvents: C.espn.unmatchedEvents },
        espnStale: C.espn.stale || [],
        validation: S.validation ? { status: S.validation.overallStatus, runAt: S.validation.runAt, season: S.validation.season, week: S.validation.week } : null,
        watchdog: S.watchdog ? { ts: S.watchdog.ts, status: S.watchdog.status, severity: S.watchdog.severity } : null,
        coverage: { playersChecked: C.players.size, rosteredPlayers: S.rosters.length, statRows: S.stats.length, espnLines: C.espn.lines.size, scoringPlays: [...C.dossiers.values()].reduce((s, d) => s + d.plays.length, 0), touchdowns: [...C.dossiers.values()].reduce((s, d) => s + d.plays.filter(p => p.kind === 'TD').length, 0), teams: C.teams.size, games: C.gameCount },
        deferred: result.checklist.filter(c => c.status === 'DEFER').map(c => c.id),
        knownErrors: result.knownErrors,
        checklistSummary: Object.fromEntries(['PASS', 'FAIL', 'WARN', 'DEFER', 'INFO'].map(s => [s, result.checklist.filter(c => c.status === s).length])),
        findingCounts: Object.fromEntries(['FAIL', 'WARN', 'INFO', 'DEFER'].map(s => [s, result.findings.filter(f => f.severity === s).length])),
        questionCount: result.questions.length,
        defensiveScores: result.defensiveScores,
        scoreCheck,
        files: { checks: 'checks.json', league: 'league.md', questions: 'questions.json', resolutions: 'resolutions.json', games: 'games/' },
        timing
    };
    writeFile(path.join(OPTS.out, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return manifest;
}

// ---------------------------------------------------------------- main

async function main() {
    const t0 = Date.now();
    const manifestPath = path.join(OPTS.out, 'manifest.json');
    if (!OPTS.refresh && !OPTS.rerunStandings && fs.existsSync(manifestPath)) {
        const m = readJson(manifestPath);
        if (m && m.dbPath === OPTS.db && Date.now() - Date.parse(m.generatedAt) < 24 * 3600000) {
            log(`Workspace ${OPTS.out} is fresh (${m.generatedAt}); use --refresh to rebuild.`);
            return;
        }
    }
    log(`Double check ${season} week ${week} — db ${OPTS.db}${IS_LIVE_DB ? '' : ' (immutable)'} → ${OPTS.out}`);
    const db = await openDb();
    let S;
    try { S = await buildSnapshot(db); } finally { await new Promise(res => db.close(res)); }
    const tDb = Date.now();
    log(`DB snapshot: ${S.weekGames.length} games (${S.weekGames.filter(g => g.final).length} final), ${S.rosters.length} roster rows, ${S.stats.length} stat rows, ${S.boxscores.size} cached boxscores, ${S.playerPositions.size} player positions`);

    const espn = await pullEspn(S);
    const tEspn = Date.now();
    log(`ESPN: ${espn.summaries.size} summaries (${espn.fetched} fetched, ${espn.cached} cached, ${espn.failed.length} failed)${espn.ok ? '' : ' — INCOMPLETE'}`);

    const dossiers = buildDossiers(S, espn);
    log(`Dossiers: ${dossiers.size} games, ${[...dossiers.values()].reduce((s, d) => s + d.plays.length, 0)} scoring plays${tdDossier ? '' : ' (tdDossier module missing)'}`);

    const C = compute(S, espn, dossiers);
    const result = checks.runChecks(S, C);
    const tChecks = Date.now();

    if (fs.existsSync(OPTS.out) && OPTS.refresh) {
        // teams/, rubric.md, progress.json belonged to the retired LLM runbook; clear them and the games dir
        for (const sub of ['teams', 'games', 'rubric.md', 'progress.json']) fs.rmSync(path.join(OPTS.out, sub), { recursive: true, force: true });
    }
    const generatedAt = new Date().toISOString();
    writeFile(path.join(OPTS.out, 'checks.json'), JSON.stringify({ generatedAt, season, week, findings: result.findings, checklist: result.checklist, knownErrors: result.knownErrors, defensiveScores: result.defensiveScores, questionIds: result.questions.map(q => q.id) }, null, 2));
    writeFile(path.join(OPTS.out, 'questions.json'), JSON.stringify({ generatedAt, season, week, questions: result.questions }, null, 2));
    writeGameFiles(S, C);
    writeLeague(S, C, result);
    const timing = { dbMs: tDb - t0, espnMs: tEspn - tDb, computeMs: tChecks - tEspn, totalMs: Date.now() - t0 };
    const manifest = writeManifest(S, C, result, timing);
    // persist closed-week hashes (a log file, never the DB)
    writeFile(C.hashes.file, JSON.stringify(C.hashes.next, null, 2));

    const counts = manifest.findingCounts;
    log(`Checks: ${result.checklist.map(c => `${c.id}=${c.status}`).join(' ')}`);
    log(`Findings: FAIL ${counts.FAIL}, WARN ${counts.WARN}, DEFER ${counts.DEFER}, INFO ${counts.INFO}; questions ${manifest.questionCount}; defensive scores ${result.defensiveScores.length}; score mismatches ${manifest.scoreCheck.mismatches.length}; ${timing.totalMs} ms`);
    log(`Workspace ready: ${OPTS.out} — next: node scripts/doublecheck-finalize.js ${season} ${week}${manifest.questionCount ? ` (then node scripts/doublecheck-reconcile.js ${season} ${week} for the ${manifest.questionCount} question(s))` : ''}`);
}

main().catch(err => {
    console.error(`doublecheck-data failed: ${err.message}`);
    if (!OPTS.quiet) console.error(err.stack);
    process.exit(2);
});
