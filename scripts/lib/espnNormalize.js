'use strict';

/**
 * ESPN summary -> internal-shaped stat lines for the Double Check job.
 *
 * Input is the parsed JSON of
 *   https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=<id>
 * (see scripts/lib/espnClient.js). Output lines use the player_stats column
 * names for the comparable subset (see the "ESPN normalized player line" in
 * the Double Check interface spec) so the rubric can score them directly.
 *
 * Conventions:
 * - Stat values are read by each group's `keys` array (labels only as a
 *   fallback); composite keys ("completions/passingAttempts",
 *   "fieldGoalsMade/fieldGoalAttempts", "sacks-sackYardsLost") are split on
 *   their separator into their component keys.
 * - A player's team is the enclosing boxscore.players[i].team (his team in
 *   THIS game, which survives mid-season trades), canonicalized (WSH -> WAS).
 * - 2-pt conversions are NOT in the boxscore; they are parsed from
 *   scoringPlays[].text and resolved to athlete ids by display name within
 *   the scoring team's boxscore.
 * - DST lines never set defensive-TD columns: the TD dossier owns those.
 * - Every numeric output is a Number; missing groups/keys are 0.
 */

const { getTeamAbbreviation } = require('../../server/utils/teamMappings');

// group -> component key -> internal column
const COLUMN_MAP = {
    passing: {
        passingYards: 'passing_yards',
        passingTouchdowns: 'passing_tds',
        interceptions: 'interceptions'
    },
    rushing: {
        rushingYards: 'rushing_yards',
        rushingTouchdowns: 'rushing_tds'
    },
    receiving: {
        receptions: 'receptions',
        receivingYards: 'receiving_yards',
        receivingTouchdowns: 'receiving_tds'
    },
    fumbles: {
        fumbles: 'fumbles',
        fumblesLost: 'fumbles_lost'
    },
    kicking: {
        fieldGoalsMade: 'field_goals_made',
        fieldGoalAttempts: 'field_goals_attempted',
        extraPointsMade: 'extra_points_made',
        extraPointAttempts: 'extra_points_attempted'
    },
    kickReturns: {
        kickReturnTouchdowns: 'kick_return_tds'
    },
    puntReturns: {
        puntReturnTouchdowns: 'punt_return_tds'
    }
};

// Fallback when a group ships `labels` but no `keys` (label -> ESPN key).
const LABEL_KEYS = {
    passing: { 'C/ATT': 'completions/passingAttempts', YDS: 'passingYards', AVG: 'yardsPerPassAttempt', TD: 'passingTouchdowns', INT: 'interceptions', SACKS: 'sacks-sackYardsLost', QBR: 'adjQBR', RTG: 'QBRating' },
    rushing: { CAR: 'rushingAttempts', YDS: 'rushingYards', AVG: 'yardsPerRushAttempt', TD: 'rushingTouchdowns', LONG: 'longRushing' },
    receiving: { REC: 'receptions', YDS: 'receivingYards', AVG: 'yardsPerReception', TD: 'receivingTouchdowns', LONG: 'longReception', TGTS: 'receivingTargets' },
    fumbles: { FUM: 'fumbles', LOST: 'fumblesLost', REC: 'fumblesRecovered' },
    defensive: { TOT: 'totalTackles', SOLO: 'soloTackles', SACKS: 'sacks', TFL: 'tacklesForLoss', PD: 'passesDefended', 'QB HTS': 'QBHits', TD: 'defensiveTouchdowns' },
    interceptions: { INT: 'interceptions', YDS: 'interceptionYards', TD: 'interceptionTouchdowns' },
    kickReturns: { NO: 'kickReturns', YDS: 'kickReturnYards', AVG: 'yardsPerKickReturn', LONG: 'longKickReturn', TD: 'kickReturnTouchdowns' },
    puntReturns: { NO: 'puntReturns', YDS: 'puntReturnYards', AVG: 'yardsPerPuntReturn', LONG: 'longPuntReturn', TD: 'puntReturnTouchdowns' },
    kicking: { FG: 'fieldGoalsMade/fieldGoalAttempts', PCT: 'fieldGoalPct', LONG: 'longFieldGoalMade', XP: 'extraPointsMade/extraPointAttempts', PTS: 'totalKickingPoints' },
    punting: { NO: 'punts', YDS: 'puntYards', AVG: 'grossAvgPuntYards', TB: 'touchbacks', 'In 20': 'puntsInside20', LONG: 'longPunt' }
};

const NUMERIC_COLUMNS = [
    'passing_yards', 'passing_tds', 'interceptions',
    'rushing_yards', 'rushing_tds',
    'receptions', 'receiving_yards', 'receiving_tds',
    'fumbles', 'fumbles_lost',
    'field_goals_made', 'field_goals_attempted', 'extra_points_made', 'extra_points_attempted',
    'kick_return_tds', 'punt_return_tds',
    'two_point_conversions_pass', 'two_point_conversions_run', 'two_point_conversions_rec'
];

// ---------- small helpers ----------

function num(v) {
    if (v === null || v === undefined) return 0;
    const x = parseFloat(String(v).replace(/,/g, ''));
    return Number.isFinite(x) ? x : 0;
}

function canon(abbr) {
    return abbr ? getTeamAbbreviation(abbr) : '';
}

/**
 * Normalize an athlete display name for matching play text to boxscore
 * athletes: strip Jr./Sr./II/III/IV suffixes, periods and commas, collapse
 * whitespace, lowercase. Hyphens and apostrophes are kept
 * (Smith-Marsette, D'Andre).
 */
function normalizeName(displayName) {
    return String(displayName || '')
        .replace(/[.,]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\s+(jr|sr|ii|iii|iv)$/i, '')
        .toLowerCase();
}

function competitors(summary) {
    const comp = summary && summary.header && summary.header.competitions && summary.header.competitions[0];
    return (comp && comp.competitors) || [];
}

function statusType(summary) {
    const comp = summary && summary.header && summary.header.competitions && summary.header.competitions[0];
    return (comp && comp.status && comp.status.type) || {};
}

function teamStat(summary, teamCanon, statName) {
    const teams = (summary && summary.boxscore && summary.boxscore.teams) || [];
    const t = teams.find(x => canon(x.team && x.team.abbreviation) === teamCanon);
    if (!t) return 0;
    const s = (t.statistics || []).find(x => x.name === statName);
    return s ? num(s.displayValue) : 0;
}

/**
 * Resolve the key list for a stat group: `keys` if present, else map
 * `labels` through LABEL_KEYS, else the labels themselves.
 */
function groupKeys(group) {
    if (Array.isArray(group.keys) && group.keys.length) return group.keys;
    const labelMap = LABEL_KEYS[group.name] || {};
    return (group.labels || []).map(l => labelMap[l] || l);
}

/**
 * Split a composite key/value pair ("completions/passingAttempts" = "21/34",
 * "sacks-sackYardsLost" = "1-8") into [[componentKey, value], ...].
 */
function explode(key, value) {
    const sep = key.includes('/') ? '/' : (key.includes('-') ? '-' : null);
    if (!sep) return [[key, value]];
    const names = key.split(sep);
    const parts = String(value === undefined || value === null ? '' : value).split(sep);
    return names.map((n, i) => [n, parts[i] !== undefined ? parts[i] : '0']);
}

function emptyLine(athlete, teamCanon, ctx) {
    const line = {
        player_id: String(athlete.id),
        name: athlete.displayName || '',
        team: teamCanon,
        eventId: ctx.eventId === undefined ? null : String(ctx.eventId),
        gameId: ctx.gameId === undefined ? null : ctx.gameId
    };
    for (const col of NUMERIC_COLUMNS) line[col] = 0;
    line.raw = {};
    return line;
}

// ---------- 2-pt conversions ----------

const TWO_PT_PAREN = /\(([^()]*Two-Point[^()]*)\)/i;
const TWO_PT_PASS = /^(.+?) Pass to (.+?) for Two-Point Conversion$/i;
const TWO_PT_RUN = /^(.+?) Run for Two-Point Conversion$/i;

/**
 * Parse one scoring-play text for a successful 2-pt conversion.
 * Returns null when there is none (or it failed), else
 * { kind:'pass', passer, receiver } | { kind:'run', rusher } | { kind:'unknown', inner }.
 */
function parseTwoPoint(text) {
    const m = TWO_PT_PAREN.exec(text || '');
    if (!m) return null;
    const inner = m[1].trim();
    if (/failed/i.test(inner)) return null;
    const pass = TWO_PT_PASS.exec(inner);
    if (pass) return { kind: 'pass', passer: pass[1].trim(), receiver: pass[2].trim() };
    const run = TWO_PT_RUN.exec(inner);
    if (run) return { kind: 'run', rusher: run[1].trim() };
    return { kind: 'unknown', inner };
}

// ---------- public API ----------

/**
 * All player lines for one game.
 * @returns {{ lines: Map<string, object>, unresolvedTwoPoint: Array<{text, name}> }}
 */
function playerLines(summary, ctx = {}) {
    const lines = new Map();
    const nameIndex = new Map(); // teamCanon -> Map<normalizedName, player_id>

    const players = (summary && summary.boxscore && summary.boxscore.players) || [];
    for (const side of players) {
        const teamCanon = canon(side.team && side.team.abbreviation);
        if (!nameIndex.has(teamCanon)) nameIndex.set(teamCanon, new Map());
        const names = nameIndex.get(teamCanon);

        for (const group of side.statistics || []) {
            const keys = groupKeys(group);
            const colMap = COLUMN_MAP[group.name] || {};
            for (const entry of group.athletes || []) {
                const athlete = entry.athlete || {};
                if (athlete.id === undefined || athlete.id === null) continue;
                const id = String(athlete.id);
                if (!lines.has(id)) lines.set(id, emptyLine(athlete, teamCanon, ctx));
                const line = lines.get(id);
                const norm = normalizeName(athlete.displayName);
                if (norm && !names.has(norm)) names.set(norm, id);

                const raw = line.raw[group.name] || (line.raw[group.name] = {});
                const stats = entry.stats || [];
                keys.forEach((key, i) => {
                    for (const [component, value] of explode(key, stats[i])) {
                        raw[component] = value === undefined ? '' : String(value);
                        const col = colMap[component];
                        if (col) line[col] = num(value);
                    }
                });
            }
        }
    }

    const unresolvedTwoPoint = [];
    for (const play of (summary && summary.scoringPlays) || []) {
        const parsed = parseTwoPoint(play.text);
        if (!parsed) continue;
        const teamCanon = canon(play.team && play.team.abbreviation);
        const names = nameIndex.get(teamCanon) || new Map();
        const credit = (name, col) => {
            const id = names.get(normalizeName(name));
            if (id) lines.get(id)[col] += 1;
            else unresolvedTwoPoint.push({ text: play.text, name });
        };
        if (parsed.kind === 'pass') {
            credit(parsed.passer, 'two_point_conversions_pass');
            credit(parsed.receiver, 'two_point_conversions_rec');
        } else if (parsed.kind === 'run') {
            credit(parsed.rusher, 'two_point_conversions_run');
        } else {
            unresolvedTwoPoint.push({ text: play.text, name: null });
        }
    }

    return { lines, unresolvedTwoPoint };
}

/**
 * One line per team defense, keyed 'DEF_<CANON>'. Def-TD columns are
 * deliberately absent (the TD dossier decides those).
 */
function dstLines(summary, ctx = {}) {
    const out = new Map();
    const comps = competitors(summary);
    const players = (summary && summary.boxscore && summary.boxscore.players) || [];
    const plays = (summary && summary.scoringPlays) || [];

    const sumGroup = (teamCanon, groupName, key) => {
        const side = players.find(p => canon(p.team && p.team.abbreviation) === teamCanon);
        if (!side) return 0;
        const group = (side.statistics || []).find(g => g.name === groupName);
        if (!group) return 0;
        const idx = groupKeys(group).indexOf(key);
        if (idx < 0) return 0;
        return (group.athletes || []).reduce((acc, a) => acc + num((a.stats || [])[idx]), 0);
    };

    for (const c of comps) {
        const team = canon(c.team && c.team.abbreviation);
        const opp = comps.find(o => o !== c);
        const oppTeam = opp ? canon(opp.team && opp.team.abbreviation) : '';
        out.set(`DEF_${team}`, {
            player_id: `DEF_${team}`,
            name: `${team} DST`,
            team,
            opponent: oppTeam,
            eventId: ctx.eventId === undefined ? null : String(ctx.eventId),
            gameId: ctx.gameId === undefined ? null : ctx.gameId,
            points_allowed: opp ? num(opp.score) : 0,
            yards_allowed: oppTeam ? teamStat(summary, oppTeam, 'totalYards') : 0,
            sacks: sumGroup(team, 'defensive', 'sacks'),
            def_interceptions: sumGroup(team, 'interceptions', 'interceptions'),
            safeties: plays.filter(p => p.type && p.type.text === 'Safety'
                && canon(p.team && p.team.abbreviation) === team).length
        });
    }
    return out;
}

/**
 * Game-level facts: teams, score, status, team totalYards/turnovers.
 */
function gameFacts(summary) {
    const comps = competitors(summary);
    const home = comps.find(c => c.homeAway === 'home') || {};
    const away = comps.find(c => c.homeAway === 'away') || {};
    const type = statusType(summary);
    const homeTeam = canon(home.team && home.team.abbreviation);
    const awayTeam = canon(away.team && away.team.abbreviation);
    const totalYards = {};
    const turnovers = {};
    for (const t of [homeTeam, awayTeam]) {
        if (!t) continue;
        totalYards[t] = teamStat(summary, t, 'totalYards');
        turnovers[t] = teamStat(summary, t, 'turnovers');
    }
    return {
        home: homeTeam,
        away: awayTeam,
        homeScore: num(home.score),
        awayScore: num(away.score),
        completed: type.completed === true,
        statusName: type.name || null,
        totalYards,
        turnovers
    };
}

// ---------- fixture trimming ----------

function pick(obj, keys) {
    const out = {};
    if (!obj) return out;
    for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
    return out;
}

function trimTeam(team) {
    return pick(team, ['id', 'uid', 'abbreviation', 'displayName', 'name', 'location']);
}

/**
 * Reduce a raw ESPN summary to the parts the Double Check job reads, so
 * test fixtures stay small (tests/fixtures/espn/summary-<eventId>.json).
 * Keeps header, boxscore (teams + players), scoringPlays and drives.previous
 * (team/result/isScore plus a slim play list); drops news, videos, odds,
 * pickcenter, winprobability, article, standings, leaders, injuries,
 * broadcasts and every logo/link blob.
 */
function trimSummary(summary) {
    const header = pick(summary.header, ['id', 'uid', 'season', 'week', 'timeValid']);
    header.competitions = ((summary.header && summary.header.competitions) || []).map(c => ({
        ...pick(c, ['id', 'uid', 'date', 'neutralSite', 'status']),
        competitors: (c.competitors || []).map(x => ({
            ...pick(x, ['id', 'uid', 'order', 'homeAway', 'winner', 'score', 'record', 'linescores']),
            team: trimTeam(x.team)
        }))
    }));

    const box = summary.boxscore || {};
    const boxscore = {
        teams: (box.teams || []).map(t => ({
            team: trimTeam(t.team),
            homeAway: t.homeAway,
            statistics: (t.statistics || []).map(s => pick(s, ['name', 'displayValue', 'label']))
        })),
        players: (box.players || []).map(p => ({
            team: trimTeam(p.team),
            statistics: (p.statistics || []).map(g => ({
                ...pick(g, ['name', 'keys', 'labels', 'totals']),
                athletes: (g.athletes || []).map(a => ({
                    athlete: {
                        ...pick(a.athlete, ['id', 'displayName', 'shortName', 'jersey']),
                        position: a.athlete && a.athlete.position ? pick(a.athlete.position, ['abbreviation']) : undefined
                    },
                    stats: a.stats
                }))
            }))
        }))
    };

    const scoringPlays = (summary.scoringPlays || []).map(p => ({
        ...pick(p, ['id', 'type', 'text', 'awayScore', 'homeScore', 'period', 'clock', 'scoringType']),
        team: trimTeam(p.team)
    }));

    const drives = {
        previous: ((summary.drives && summary.drives.previous) || []).map(d => ({
            team: trimTeam(d.team),
            result: d.result,
            isScore: d.isScore,
            plays: (d.plays || []).map(pl => ({
                ...pick(pl, ['id', 'type', 'text', 'scoringPlay', 'isTurnover', 'period', 'clock', 'awayScore', 'homeScore']),
                start: pl.start ? { team: pl.start.team } : undefined,
                end: pl.end ? { team: pl.end.team } : undefined
            }))
        }))
    };

    return { header, boxscore, scoringPlays, drives };
}

/**
 * Same idea for a scoreboard response: season, week and slim events.
 */
function trimScoreboard(scoreboard) {
    return {
        season: scoreboard.season,
        week: scoreboard.week,
        events: (scoreboard.events || []).map(e => ({
            ...pick(e, ['id', 'uid', 'date', 'name', 'shortName', 'season', 'week', 'status']),
            competitions: (e.competitions || []).map(c => ({
                ...pick(c, ['id', 'date', 'neutralSite', 'status']),
                competitors: (c.competitors || []).map(x => ({
                    ...pick(x, ['id', 'homeAway', 'winner', 'score']),
                    team: trimTeam(x.team)
                }))
            }))
        }))
    };
}

module.exports = {
    playerLines,
    dstLines,
    gameFacts,
    normalizeName,
    parseTwoPoint,
    trimSummary,
    trimScoreboard,
    NUMERIC_COLUMNS
};
