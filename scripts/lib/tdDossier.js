'use strict';

/**
 * TD dossier for the Double Check job.
 *
 * Merges Tank01 scoringPlays with ESPN scoringPlays + drive plays for one NFL
 * game, assigns a deterministic award class to every scoring play (per
 * docs/SCORING_SYSTEM.md "Defensive Touchdowns - Exact Award Logic" and
 * docs/DEFENSIVE_SCORING.md), lists the player_stats credits that class
 * implies, and compares them with what the DB actually stored.
 *
 * Independence: this module must NOT require any server/services scoring
 * module (tests/unit/doublecheckTripwire.test.js). It only uses
 * server/utils/teamMappings (team-code canonicalization) and
 * scripts/lib/doublecheckRubric (point values for the markdown legend).
 *
 * The determining question (league rule): did the ball change possession on
 * the play, or was the kick blocked?  Three independent signals vote on it:
 *
 *   drive    ESPN drive play `isTurnover` (true -> takeaway) / drive team ==
 *            scoring team (-> same possession)
 *   gamebook NFL gamebook prose in the ESPN drive play text: "INTERCEPTED by",
 *            "RECOVERED by HST-T.Togiai" (upper-case RECOVERED is the GSIS
 *            convention for a change of possession; lower-case "recovered by"
 *            means the offense kept the ball), "MUFFS", "is BLOCKED"
 *   text     the scoring-play texts themselves (Tank01 + ESPN): "Interception
 *            Return" / "Kickoff Return" / "pass from" / "Yd Rush" / "Blocked"
 *
 * The award class is DEFINITE only when the non-null votes agree; a
 * disagreement (or no vote at all on a fumble/recovery play) is AMBIGUOUS and
 * becomes a QUESTION for the reconcile step. ESPN `type.text` is advisory only
 * (it says "Fumble Return Touchdown" for an offensive aborted-snap recovery)
 * and never votes.
 *
 * Every game also gets a score reconciliation: the scoring plays of each source
 * (TD 6 + try, FG 3, safety 2 — or the source's own running score) must reproduce the final score; a phantom
 * safety or a missing final FG shows up there deterministically.
 */

const { getTeamAbbreviation } = require('../../server/utils/teamMappings');
const { POINTS } = require('./doublecheckRubric');

const AWARD_CLASSES = Object.freeze([
    'DEF_8_INT', 'DEF_8_FUMBLE', 'DEF_8_BLOCKED', 'RETURN_20_KICK', 'RETURN_20_PUNT',
    'OFF_PASS', 'OFF_RUSH', 'OFF_RECOVERY', 'SAFETY_2', 'AMBIGUOUS', 'NOT_TD'
]);

/** Options a question may be answered with (plan contract; NOT_A_SCORE = nullified / not a scoring play). */
const QUESTION_OPTIONS = Object.freeze([
    'DEF_8_INT', 'DEF_8_FUMBLE', 'DEF_8_BLOCKED', 'RETURN_20_KICK', 'RETURN_20_PUNT',
    'OFF_PASS', 'OFF_RUSH', 'OFF_RECOVERY', 'SAFETY_2', 'NOT_A_SCORE'
]);

/** Columns each decided award class credits (used by finalize to derive credits from a bare ruling). */
const CLASS_CREDIT_COLUMNS = Object.freeze({
    DEF_8_INT: 'def_int_return_tds', DEF_8_FUMBLE: 'def_fumble_return_tds', DEF_8_BLOCKED: 'def_blocked_return_tds',
    SAFETY_2: 'safeties', RETURN_20_KICK: 'kick_return_tds', RETURN_20_PUNT: 'punt_return_tds',
    OFF_RUSH: 'rushing_tds', OFF_RECOVERY: 'rushing_tds'
});

// NFL gamebook (GSIS) team codes that differ from the league's canonical codes.
// Everything else (incl. WSH/JAC via teamMappings ALT_CODES) goes through getTeamAbbreviation.
const GAMEBOOK_TEAM_CODES = Object.freeze({
    ARZ: 'ARI', BLT: 'BAL', CLV: 'CLE', HST: 'HOU', LA: 'LAR', SD: 'LAC', STL: 'LAR', OAK: 'LV', JAC: 'JAX', WSH: 'WAS'
});

/** Text that makes a scoring play a plausible defensive score (takeaway / block / safety). */
const DEFENSIVE_CANDIDATE_RE = /intercept|fumble|recover|block|muff|safety/i;

const TD_COLUMNS = Object.freeze([
    'passing_tds', 'rushing_tds', 'receiving_tds', 'kick_return_tds', 'punt_return_tds',
    'def_int_return_tds', 'def_fumble_return_tds', 'def_blocked_return_tds', 'safeties'
]);
const TWO_PT_COLUMNS = Object.freeze(['two_point_conversions_pass', 'two_point_conversions_run', 'two_point_conversions_rec']);
const DEF_COLUMNS = Object.freeze(['def_int_return_tds', 'def_fumble_return_tds', 'def_blocked_return_tds', 'safeties']);
const PLAYER_TD_COLUMNS = Object.freeze(['passing_tds', 'rushing_tds', 'receiving_tds', 'kick_return_tds', 'punt_return_tds']);

// Which DB columns are worth showing for a non-DST player involved in a play of this class.
const CLASS_PLAYER_COLUMNS = Object.freeze({
    OFF_PASS: ['passing_tds', 'receiving_tds'],
    OFF_RUSH: ['rushing_tds'],
    OFF_RECOVERY: ['rushing_tds', 'receiving_tds'],
    RETURN_20_KICK: ['kick_return_tds', 'punt_return_tds'],
    RETURN_20_PUNT: ['punt_return_tds', 'kick_return_tds'],
    DEF_8_INT: ['kick_return_tds', 'punt_return_tds', 'rushing_tds'],
    DEF_8_FUMBLE: ['kick_return_tds', 'punt_return_tds', 'rushing_tds'],
    DEF_8_BLOCKED: ['kick_return_tds', 'punt_return_tds', 'rushing_tds'],
    SAFETY_2: [],
    AMBIGUOUS: PLAYER_TD_COLUMNS,
    NOT_TD: []
});

// Tank01 playerList uses 'PK' for kickers; nfl_players uses 'K'.
const NON_RETURNER_POS = new Set(['K', 'PK', 'P']);

/* ------------------------------------------------------------------ helpers */

function lookup(mapOrObj, key) {
    if (!mapOrObj || key === undefined || key === null) return undefined;
    const k = String(key);
    if (typeof mapOrObj.get === 'function') return mapOrObj.get(k) || mapOrObj.get(key);
    return mapOrObj[k];
}

function canon(team) {
    if (!team) return null;
    const c = getTeamAbbreviation(String(team));
    return c ? String(c).toUpperCase() : String(team).toUpperCase();
}

function normClock(clock) {
    if (clock === undefined || clock === null) return null;
    const s = String(clock).trim();
    const m = s.match(/^(\d{1,2}):(\d{1,2})$/);
    if (!m) return s;
    return `${parseInt(m[1], 10)}:${m[2].padStart(2, '0')}`;
}

function clockSeconds(clock) {
    const n = normClock(clock);
    const m = n && n.match(/^(\d+):(\d+)$/);
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : -1;
}

function normScoringText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[’]/g, "'")
        .replace(/[^a-z0-9']+/g, ' ')
        .trim();
}

/** Tank01 'Q1'..'Q4','OT' or ESPN 1..5 -> period number (OT == 5). */
function periodNumber(p) {
    if (p === undefined || p === null) return null;
    if (typeof p === 'number') return p;
    const s = String(p).trim().toUpperCase();
    if (s === 'OT') return 5;
    const m = s.match(/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
}

function periodLabel(n) {
    if (n === null || n === undefined) return null;
    return n >= 5 ? 'OT' : `Q${n}`;
}

function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normName(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/\b(jr|sr|ii|iii|iv)\.?$/g, '')
        .replace(/[.'’-]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function num(v) {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
}

/** Deterministic id for the question a play raises (shared with the checks and finalize layers). */
function questionIdFor(season, week, gameId, playIdx) {
    return `${season}-wk${String(week).padStart(2, '0')}-${gameId}-play-${playIdx}`;
}

/* --------------------------------------------------------- gamebook parsing */

/** NFL gamebook team code (HST, ARZ, BLT, CLV, LA, ...) -> canonical league code. */
function gamebookTeam(code) {
    if (!code) return null;
    const up = String(code).trim().toUpperCase();
    if (GAMEBOOK_TEAM_CODES[up]) return GAMEBOOK_TEAM_CODES[up];
    return canon(up);
}

/**
 * Parse NFL gamebook prose (the ESPN drive play text) for the possession
 * facts that decide a scoring play.
 *
 *   "R.Stonehouse punt is BLOCKED by D.Hardy, Center-M.Cox, RECOVERED by CHI-J.Owens at TEN 21. J.Owens for 21 yards, TOUCHDOWN."
 *   "C.Stroud FUMBLES (Aborted) at ARZ 2, recovered by HST-W.Marks at ARZ 7. W.Marks for 7 yards, TOUCHDOWN."
 *   "J.McCarthy pass short left intended for J.Jefferson INTERCEPTED by N.Wright at CHI 26. N.Wright for 74 yards, TOUCHDOWN."
 *   "M.Washington MUFFS catch, RECOVERED by NE-B.Schooler at MIA 12."
 *
 * GSIS convention: upper-case RECOVERED marks a change of possession, lower-case
 * "recovered by" a recovery by the team that had the ball. INTERCEPTED is always
 * a change of possession. The last recovery/interception in the text wins.
 *
 * @returns {{ recoveredBy: string|null, recovered: boolean, recoveredUpper: boolean, recoveredPlayer: string|null,
 *             interceptedBy: string|null, intercepted: boolean, interceptedPlayer: string|null,
 *             muffed: boolean, blocked: boolean, lateral: boolean, fumbled: boolean,
 *             touchdownBy: string|null, touchdownPlayer: string|null }}
 */
function parseGamebook(playText) {
    const t = String(playText || '');
    const out = {
        recoveredBy: null, recovered: false, recoveredUpper: false, recoveredPlayer: null,
        interceptedBy: null, intercepted: false, interceptedPlayer: null,
        muffed: /\bMUFFS?\b|\bmuffed\b/i.test(t),
        blocked: /\bBLOCKED\b/i.test(t),
        lateral: /\blateral/i.test(t),
        fumbled: /\bFUMBLES?\b/i.test(t),
        touchdownBy: null, touchdownPlayer: null
    };
    const PLAYER = "([A-Z][A-Za-z'.\\-]*(?:\\s(?:Jr|Sr|II|III|IV)\\.?)?)";
    let m;
    const recRe = new RegExp(`\\b(RECOVERED|[Rr]ecovered) by (?:([A-Z]{2,3})-)?${PLAYER}`, 'g');
    while ((m = recRe.exec(t)) !== null) {
        out.recovered = true;
        out.recoveredUpper = m[1] === 'RECOVERED';
        out.recoveredBy = m[2] ? gamebookTeam(m[2]) : null;
        out.recoveredPlayer = m[3] || null;
    }
    const intRe = new RegExp(`\\bINTERCEPTED by (?:([A-Z]{2,3})-)?${PLAYER}`, 'gi');
    while ((m = intRe.exec(t)) !== null) {
        out.intercepted = true;
        out.interceptedBy = m[1] ? gamebookTeam(m[1]) : null;
        out.interceptedPlayer = m[2] || null;
    }
    const tdRe = new RegExp(`(?:([A-Z]{2,3})-)?${PLAYER} (?:for -?\\d+ yards?|(?:up the middle|left|right|scrambles)[^,.]*?),? TOUCHDOWN`, 'g');
    while ((m = tdRe.exec(t)) !== null) {
        out.touchdownBy = m[1] ? gamebookTeam(m[1]) : null;
        out.touchdownPlayer = m[2] || null;
    }
    return out;
}

/* ------------------------------------------------------------------ votes */

/** ESPN drive play vote: takeaway (isTurnover) / same (drive team == scoring team) / null. */
function driveVote(drive, scoringTeam) {
    if (!drive) return null;
    if (drive.isTurnover === true) return 'takeaway';
    if (drive.team && scoringTeam && drive.team === scoringTeam) return 'same';
    return null; // drive belongs to the other team but ESPN says no turnover (punt return, blocked FG...): no opinion
}

/** Gamebook vote from parseGamebook(): takeaway / same / null. */
function gamebookVote(gb, scoringTeam) {
    if (!gb) return null;
    if (gb.intercepted) return (gb.interceptedBy && scoringTeam && gb.interceptedBy !== scoringTeam) ? null : 'takeaway';
    if (gb.recovered) {
        if (gb.recoveredBy && scoringTeam && gb.recoveredBy !== scoringTeam) return null; // someone else recovered last: unreadable
        return gb.recoveredUpper ? 'takeaway' : 'same';
    }
    return null;
}

/** Scoring-play text vote: takeaway / same / return / blocked / null (fumble recoveries say nothing). */
function textVote(text) {
    const t = String(text || '');
    if (!t.trim()) return null;
    if (/intercept/i.test(t)) return 'takeaway';
    if (/block/i.test(t)) return 'blocked';
    if (/recovered (kickoff|onside)|kickoff recover|onside kick recover/i.test(t)) return 'takeaway';
    if (/muff/i.test(t)) return 'takeaway';
    if (/(punt|kick(?:off)?) return/i.test(t)) return 'return';
    if (/pass from|\bYd (?:Rush|Run)\b/i.test(t)) return 'same';
    return null;
}

/** Non-null votes must agree on possession ('return' counts as same possession; 'blocked' is not a possession vote). */
function voteConsensus(votes) {
    const kinds = new Set();
    for (const v of Object.values(votes || {})) {
        if (v === null || v === undefined || v === 'blocked') continue;
        kinds.add(v === 'return' ? 'same' : v);
    }
    return { agree: kinds.size <= 1, consensus: kinds.size === 1 ? [...kinds][0] : null, cast: Object.values(votes || {}).filter(v => v !== null && v !== undefined).length };
}

function fmtVotes(votes) {
    return `drive=${votes.drive || '-'} gamebook=${votes.gamebook || '-'} text=${votes.text || '-'}`;
}

/* ------------------------------------------------------------- 2-pt parsing */

/**
 * Parse a scoring-play text suffix such as
 *   "(J.J. McCarthy Pass to Adam Thielen for Two-Point Conversion)"
 *   "(Rhamondre Stevenson Run for Two-Point Conversion)"
 *   "(Two-Point Pass Conversion Failed)" / "(Two-Point Run Conversion Failed)"
 * Both Tank01 `score` and ESPN scoringPlays[].text use this format.
 * @param {string} text
 * @param {function(string): (string|null)} [resolver] name -> player_id
 * @returns {{attempted:boolean, success:boolean|null, pass, run, rec, passName, runName, recName}|null}
 *   null when the text carries no two-point information at all.
 */
function extractTwoPoint(text, resolver) {
    const t = String(text || '');
    if (!/two[- ]point/i.test(t)) return null;
    const res = (n) => (n && typeof resolver === 'function' ? (resolver(n) || null) : null);
    const out = { attempted: true, success: null, pass: null, run: null, rec: null, passName: null, runName: null, recName: null };
    let m = t.match(/\(([^()]+?) Pass to ([^()]+?) for Two[- ]Point Conversion\)/i);
    if (m) {
        out.success = true;
        out.passName = m[1].trim();
        out.recName = m[2].trim();
        out.pass = res(out.passName);
        out.rec = res(out.recName);
        return out;
    }
    m = t.match(/\(([^()]+?) Run for Two[- ]Point Conversion\)/i);
    if (m) {
        out.success = true;
        out.runName = m[1].trim();
        out.run = res(out.runName);
        return out;
    }
    if (/Two[- ]Point (?:Pass |Run |Rush )?Conversion Failed|ATTEMPT FAILS/i.test(t)) {
        out.success = false;
        return out;
    }
    // Two-point mentioned but in an unrecognised form.
    return out;
}

/* ---------------------------------------------------------------- matching */

function flattenDrivePlays(espnSummary) {
    const out = [];
    const drives = espnSummary && espnSummary.drives && espnSummary.drives.previous;
    for (const d of drives || []) {
        for (const p of d.plays || []) {
            out.push({ drive: d, play: p });
        }
    }
    return out;
}

function espnTeamIdMap(espnSummary) {
    const map = {};
    const comps = espnSummary && espnSummary.header && espnSummary.header.competitions;
    const competitors = comps && comps[0] && comps[0].competitors;
    for (const c of competitors || []) {
        if (c && c.id !== undefined && c.team) map[String(c.id)] = canon(c.team.abbreviation);
    }
    return map;
}

/** Running score a source reports after a play ({home, away}) or null. */
function scoreAfter(p) {
    if (!p || p.homeScore === undefined || p.homeScore === null || p.awayScore === undefined || p.awayScore === null) return null;
    const h = Number(p.homeScore), a = Number(p.awayScore);
    return Number.isFinite(h) && Number.isFinite(a) ? { home: h, away: a } : null;
}

function sameScoreAfter(a, b) {
    if (!a || !b) return false;
    if (a.homeScore === undefined || b.homeScore === undefined) return false;
    return num(a.homeScore) === num(b.homeScore) && num(a.awayScore) === num(b.awayScore);
}

/**
 * Match Tank01 scoringPlays to ESPN scoringPlays and ESPN drive plays.
 * Match key: period + clock (+ scoring team); fallback: period + score after the play.
 * @param {Array} tank01Plays  Tank01 body.scoringPlays
 * @param {Array} espnScoringPlays  ESPN summary.scoringPlays
 * @param {Array} espnDrivePlays  either flattened [{drive, play}] or raw drive plays
 * @returns {{ matched: Array<{tank01, espn, drive, matchedBy}>, espnOnly: Array }}
 */
function matchPlays(tank01Plays, espnScoringPlays, espnDrivePlays) {
    const espnPlays = (espnScoringPlays || []).map(p => ({ p, used: false }));
    const drivePlays = (espnDrivePlays || []).map(x => (x && x.play ? x : { drive: null, play: x }))
        .filter(x => x.play && x.play.scoringPlay);

    function findDrive(period, clock, tank01Play, espnPlay) {
        let hit = drivePlays.find(x => periodNumber(x.play.period && x.play.period.number) === period
            && normClock(x.play.clock && x.play.clock.displayValue) === clock);
        if (!hit) {
            hit = drivePlays.find(x => periodNumber(x.play.period && x.play.period.number) === period
                && (sameScoreAfter(x.play, espnPlay) || sameScoreAfter(x.play, tank01Play)));
        }
        if (!hit && espnPlay && espnPlay.id !== undefined) {
            hit = drivePlays.find(x => String(x.play.id) === String(espnPlay.id));
        }
        return hit || null;
    }

    const matched = [];
    for (const t of tank01Plays || []) {
        const period = periodNumber(t.scorePeriod);
        const clock = normClock(t.scoreTime);
        const team = canon(t.team);
        let matchedBy = null;
        let hit = espnPlays.find(e => !e.used
            && periodNumber(e.p.period && e.p.period.number) === period
            && normClock(e.p.clock && e.p.clock.displayValue) === clock
            && canon(e.p.team && e.p.team.abbreviation) === team);
        if (hit) matchedBy = 'period+clock+team';
        if (!hit) {
            hit = espnPlays.find(e => !e.used
                && periodNumber(e.p.period && e.p.period.number) === period
                && normClock(e.p.clock && e.p.clock.displayValue) === clock);
            if (hit) matchedBy = 'period+clock (team differs)';
        }
        // ESPN and Tank01 occasionally put the same scoring play one second apart.
        // Keep this tier deliberately narrow: same period, canonical team, and
        // normalized scoring text, with exactly a one-second clock discrepancy.
        if (!hit && clockSeconds(clock) >= 0) {
            hit = espnPlays.find(e => !e.used
                && periodNumber(e.p.period && e.p.period.number) === period
                && canon(e.p.team && e.p.team.abbreviation) === team
                && Math.abs(clockSeconds(e.p.clock && e.p.clock.displayValue) - clockSeconds(clock)) === 1
                && normScoringText(e.p.text) === normScoringText(t.score));
            if (hit) matchedBy = 'period+clock±1s+team+text';
        }
        if (!hit) {
            hit = espnPlays.find(e => !e.used
                && periodNumber(e.p.period && e.p.period.number) === period
                && sameScoreAfter(e.p, t));
            if (hit) matchedBy = 'period+score';
        }
        if (hit) hit.used = true;
        const espn = hit ? hit.p : null;
        const drive = findDrive(period, clock, t, espn);
        matched.push({ tank01: t, espn, drive, matchedBy });
    }
    const espnOnly = espnPlays.filter(e => !e.used).map(e => e.p);
    return { matched, espnOnly };
}

/* ----------------------------------------------------------- play building */

function kindOf(tank01Play, espnPlay) {
    const st = tank01Play && String(tank01Play.scoreType || '').toUpperCase();
    const text = `${tank01Play ? tank01Play.score : ''} ${espnPlay ? espnPlay.text : ''}`;
    const espnKind = espnPlay && espnPlay.scoringType && String(espnPlay.scoringType.name || '').toLowerCase();
    if (st === 'TD') return 'TD';
    if (st === 'FG') return 'FG';
    if (st === 'SF' || /safety/i.test(text)) return 'SAFETY';
    if (st === 'XP' || st === 'PAT') return 'XP';
    if (st === '2PT' || st === 'TPC' || st === '2PC') return '2PT';
    // a blocked/failed try returned by the defense ("Markquese Bell Defensive PAT Conversion"): 2 points, no TD
    if (/defensive (?:pat|two[- ]point|extra point)?\s*conversion|defensive two[- ]point/i.test(text)) return '2PT';
    if (espnKind === 'touchdown') return 'TD';
    if (espnKind === 'field-goal') return 'FG';
    if (espnKind === 'safety') return 'SAFETY';
    if (/field goal/i.test(text)) return 'FG';
    if (/two[- ]point/i.test(text) && !/touchdown|\bTD\b|Yd (?:pass|rush|run|return)/i.test(text)) return '2PT';
    if (/touchdown|\bTD\b/i.test(text)) return 'TD';
    return 'OTHER';
}

/**
 * Determine each Tank01 player's role in the play from the play text.
 * Roles: passer, receiver, rusher, returner, recoverer, fumbler, kicker, interceptor.
 */
function roleFor(name, text) {
    if (!name) return null;
    const n = escapeRe(name);
    const roles = [];
    if (new RegExp(`${n} \\d+ Yd pass from`, 'i').test(text)) roles.push('receiver');
    if (new RegExp(`pass from ${n}\\b`, 'i').test(text)) roles.push('passer');
    if (new RegExp(`${n} \\d+ Yd (?:Rush|Run)\\b`, 'i').test(text)) roles.push('rusher');
    if (new RegExp(`${n} \\d+ Yd (?:Interception|Int) Return`, 'i').test(text)) roles.push('interceptor');
    else if (new RegExp(`${n} \\d+ Yd .*Return`, 'i').test(text)) roles.push('returner');
    if (new RegExp(`${n} \\d+ Yd Fumble (?:Recovery|Return)`, 'i').test(text)) roles.push('recoverer');
    if (new RegExp(`${n} (?:Fumble\\b|Aborted Snap)`, 'i').test(text)) roles.push('fumbler');
    if (new RegExp(`\\(${n} (?:Kick|PAT)`, 'i').test(text) || new RegExp(`${n} \\d+ Yd Field Goal`, 'i').test(text)) roles.push('kicker');
    return roles;
}

function buildPlayers(tank01Play, ctx) {
    const text = String(tank01Play.score || '');
    const players = [];
    for (const id of tank01Play.playerIDs || []) {
        const ps = lookup(ctx.playerStats, id);
        const pp = lookup(ctx.playerPositions, id);
        const np = lookup(ctx.nflPlayers, id);
        const name = (ps && ps.longName) || (pp && pp.name) || (np && np.name) || null;
        const pos = (pp && pp.pos) || (np && np.position) || null;
        const roles = roleFor(name, text) || [];
        players.push({
            id: String(id),
            name,
            pos,
            team: canon((ps && (ps.teamAbv || ps.team)) || (pp && pp.team) || (np && np.team) || null),
            roles,
            draftable: !!np,
            fumbles: ps && ps.Defense ? num(ps.Defense.fumbles) : 0
        });
    }
    return players;
}

/**
 * Build a name -> player_id resolver from Tank01 playerStats (+ playerPositions),
 * preferring players of `team`.
 */
function buildResolver(ctx, team) {
    const byTeam = new Map();
    const all = new Map();
    const add = (map, name, id) => {
        const k = normName(name);
        if (k && !map.has(k)) map.set(k, String(id));
    };
    const stats = ctx.playerStats || {};
    const statEntries = typeof stats.entries === 'function' ? [...stats.entries()] : Object.entries(stats);
    for (const [id, ps] of statEntries) {
        if (!ps || !ps.longName) continue;
        add(all, ps.longName, ps.playerID || id);
        if (canon(ps.teamAbv || ps.team) === team) add(byTeam, ps.longName, ps.playerID || id);
    }
    const pos = ctx.playerPositions || {};
    const posEntries = typeof pos.entries === 'function' ? [...pos.entries()] : Object.entries(pos);
    for (const [id, p] of posEntries) {
        if (!p || !p.name) continue;
        add(all, p.name, id);
        if (canon(p.team) === team) add(byTeam, p.name, id);
    }
    return (name) => {
        const k = normName(name);
        return byTeam.get(k) || all.get(k) || null;
    };
}

/* ------------------------------------------------------- classification */

function pick(players, role) {
    return players.find(p => p.roles && p.roles.includes(role)) || null;
}

function firstNonKicker(players) {
    return players.find(p => !NON_RETURNER_POS.has(String(p.pos || '').toUpperCase()) && !(p.roles || []).includes('kicker')) || null;
}

function nameFromText(text, re) {
    const m = String(text || '').match(re);
    return m ? m[1].trim() : null;
}

function credit(player_id, column, delta, note) {
    const c = { player_id: String(player_id), column, delta };
    if (note) c.note = note;
    return c;
}

/**
 * Deterministic award class for one merged play. Pure: uses only the fields on
 * `merged` (see buildMergedPlay). Returns
 * { awardClass, expectedCredits, exemptions, reasons, votes, votesAgree, gamebook }.
 */
function classifyPlay(merged) {
    const reasons = [];
    const exemptions = [];
    const credits = [];
    const t = merged.tank01;
    const e = merged.espn;
    const drive = e && e.drive;
    const scoringTeam = merged.scoringTeam;
    const defId = `DEF_${scoringTeam}`;
    // Strip the try-for-point parenthetical ("(Joshua Karty PAT blocked)", "(Two-Point Pass
    // Conversion Failed)") and the gamebook's post-TOUCHDOWN sentences ("extra point is
    // Blocked") so a blocked PAT after a normal TD is never read as a blocked-kick return.
    const stripTry = s => String(s || '').replace(/\s*\([^()]*\)\s*$/g, '').replace(/\s*\([^()]*(?:kick|pat|conversion|point)[^()]*\)/gi, '');
    const tText = t ? stripTry(t.text) : '';
    const gamebook = drive ? stripTry(String(drive.playText || '').replace(/(TOUCHDOWN[.!?])[\s\S]*$/i, '$1')) : '';
    const eText = e ? `${e.typeText || ''} ${stripTry(e.text)} ${gamebook}` : '';
    const allText = `${tText} ${eText}`;
    const scoringTexts = `${tText} ${e ? stripTry(e.text) : ''}`; // ESPN's type label is advisory: it never votes
    const players = (t && t.players) || [];

    // The three possession votes (see the module header).
    const gb = gamebook ? parseGamebook(gamebook) : null;
    const votes = merged.kind === 'TD'
        ? { drive: driveVote(drive, scoringTeam), gamebook: gamebookVote(gb, scoringTeam), text: textVote(scoringTexts) }
        : { drive: null, gamebook: null, text: null };
    const { agree: votesAgree, consensus, cast } = voteConsensus(votes);
    const done = (awardClass) => ({ awardClass, expectedCredits: credits, exemptions, reasons, votes, votesAgree, gamebook: gb });

    if (merged.kind === 'SAFETY') {
        credits.push(credit(defId, 'safeties', 1));
        reasons.push('safety: 2 points to the scoring team defense');
        return done('SAFETY_2');
    }
    if (merged.kind !== 'TD') {
        reasons.push(`${merged.kind}: not a touchdown (kicker check covers FG/XP)`);
        return done('NOT_TD');
    }
    if (!t) {
        reasons.push('ESPN scoring play has no Tank01 counterpart (Tank01 missing this play)');
        return done('AMBIGUOUS');
    }
    // A lateral only matters when it is part of the scoring play itself (the
    // scoring-play texts), not somewhere earlier in the gamebook prose of the
    // same drive play (IND wk18 2025: two laterals, then a fumble RECOVERED by
    // HOU for a TD - a plain takeaway).
    if (/lateral/i.test(scoringTexts)) {
        reasons.push('play text mentions a lateral: scorer/possession needs a ruling');
        return done('AMBIGUOUS');
    }

    // A kickoff/onside kick recovered by the kicking team in the end zone is a
    // special-teams takeaway (docs/SCORING_SYSTEM.md): Team Defense +8.
    if (!/fumble/i.test(scoringTexts) && /recovered (kickoff|onside)|kickoff recover|onside kick recover/i.test(scoringTexts)) {
        if (!votesAgree) {
            reasons.push(`kickoff/onside recovery but the possession votes disagree (${fmtVotes(votes)})`);
            return done('AMBIGUOUS');
        }
        credits.push(credit(defId, 'def_fumble_return_tds', 1));
        reasons.push('kickoff / onside kick recovered by the kicking team: special-teams takeaway -> team defense TD');
        return done('DEF_8_FUMBLE');
    }

    if (merged.espnAvailable && !e) {
        reasons.push('no ESPN scoring play matched this Tank01 play (period/clock/team/score)');
        return done('AMBIGUOUS');
    }
    if (e && merged.espnScoringTeam && merged.espnScoringTeam !== scoringTeam) {
        reasons.push(`Tank01 says ${scoringTeam} scored, ESPN says ${merged.espnScoringTeam}`);
        return done('AMBIGUOUS');
    }
    if (e && merged.espnPeriod && merged.espnPeriod !== merged.period) {
        reasons.push(`Tank01 period ${merged.period} != ESPN period ${merged.espnPeriod}`);
        return done('AMBIGUOUS');
    }
    if (!merged.espnAvailable) {
        reasons.push('ESPN summary unavailable: classified from Tank01 text only');
    }

    if (drive) reasons.push(`ESPN drive play isTurnover=${drive.isTurnover === true}`);
    else if (e) reasons.push('ESPN drive play not found: possession change unknown');
    reasons.push(`votes: ${fmtVotes(votes)}${cast ? (votesAgree ? ' (agree)' : ' (DISAGREE)') : ' (no possession signal)'}`);

    // Blocked kick: always a defensive TD, never a 20-point return. The block
    // itself decides; the possession votes are recorded but not required.
    if (/block/i.test(allText)) {
        credits.push(credit(defId, 'def_blocked_return_tds', 1));
        reasons.push('blocked kick/punt/FG in play text -> team defense TD (never a 20-point return)');
        return done('DEF_8_BLOCKED');
    }
    if (!votesAgree) {
        reasons.push('possession votes disagree: needs a ruling');
        return done('AMBIGUOUS');
    }
    if (consensus === 'takeaway') {
        if (/intercept/i.test(allText)) {
            credits.push(credit(defId, 'def_int_return_tds', 1));
            reasons.push(drive ? 'possession changed on an interception' : 'interception return per play text (no ESPN drive data)');
            return done('DEF_8_INT');
        }
        credits.push(credit(defId, 'def_fumble_return_tds', 1));
        reasons.push(/muff/i.test(allText)
            ? 'possession changed on a muffed kick (special-teams takeaway)'
            : 'possession changed on a fumble (takeaway)');
        return done('DEF_8_FUMBLE');
    }

    // Regular kick / punt return (same possession, special teams).
    const ret = allText.match(/(punt|kick(?:off)?) return/i);
    if (ret && consensus === 'same') {
        const isPunt = /punt/i.test(ret[1]);
        const column = isPunt ? 'punt_return_tds' : 'kick_return_tds';
        const cls = isPunt ? 'RETURN_20_PUNT' : 'RETURN_20_KICK';
        let returner = pick(players, 'returner') || firstNonKicker(players);
        const textName = nameFromText(tText, /^(.+?) \d+ Yd (?:Punt|Kickoff|Kick) Return/i);
        if (!returner && textName) returner = { id: null, name: textName, pos: null, draftable: false };
        reasons.push(`${isPunt ? 'punt' : 'kickoff'} return with no possession change -> 20 points to the returner, defense 0`);
        if (!returner) {
            reasons.push('returner could not be identified from Tank01 playerIDs or text');
            return done('AMBIGUOUS');
        }
        if (!returner.draftable) {
            exemptions.push(`non-draftable returner ${returner.name || returner.id} (${returner.pos || '?'}) — credited to nobody by design`);
            return done(cls);
        }
        credits.push(credit(returner.id, column, 1));
        return done(cls);
    }

    // Same possession.
    if (e && e.typeText && /return/i.test(e.typeText) && drive && drive.team === scoringTeam && drive.isTurnover !== true) {
        reasons.push(`ESPN label advisory only: possession did not change (ESPN type "${e.typeText}", drive team == scoring team)`);
    }
    const passM = tText.match(/^(.+?) \d+ Yd pass from (.+?)(?: \(|$)/i);
    if (consensus === 'same' && (passM || /pass from/i.test(tText))) {
        if (!drive && merged.espnAvailable) reasons.push('same possession inferred from "pass from" text (no drive data)');
        const receiver = pick(players, 'receiver') || (players.length > 1 ? players[1] : null);
        const passer = pick(players, 'passer') || players[0] || null;
        if (!passer || !receiver) {
            reasons.push('passer/receiver could not be resolved from Tank01 playerIDs');
            return done('AMBIGUOUS');
        }
        credits.push(credit(passer.id, 'passing_tds', 1));
        credits.push(credit(receiver.id, 'receiving_tds', 1));
        reasons.push(`offensive passing TD: ${passer.name} -> ${receiver.name}`);
        return done('OFF_PASS');
    }
    if (/fumble|recover/i.test(allText)) {
        // "N plays" in Tank01 scoreDetails does NOT prove same possession here:
        // Chaisson's takeaway TD reads "1 play, -19 yards". Only a same-possession
        // vote (ESPN isTurnover=false on the scoring team's drive, or the gamebook's
        // lower-case "recovered by") does.
        if (consensus !== 'same') {
            reasons.push(cast === 0
                ? 'fumble recovery with no ESPN possession data and a silent gamebook: cannot tell takeaway from offensive recovery'
                : 'fumble recovery: possession signal inconsistent');
            return done('AMBIGUOUS');
        }
        const recoverer = pick(players, 'recoverer') || firstNonKicker(players);
        if (!recoverer) {
            reasons.push('recoverer could not be identified');
            return done('AMBIGUOUS');
        }
        const own = (recoverer.roles || []).includes('fumbler') || recoverer.fumbles > 0;
        const fumbler = players.find(p => p !== recoverer && (p.roles || []).includes('fumbler'));
        const note = own
            ? 'own-fumble recovery: already a rushing TD in NFL stats'
            : `teammate's fumble${fumbler ? ` (${fumbler.name})` : ''} recovered for TD: "Touchdown Scored (by any player)" -> rushing_tds`;
        credits.push(credit(recoverer.id, 'rushing_tds', 1, note));
        reasons.push(`offensive fumble recovery by ${recoverer.name} on a ${scoringTeam} possession (${note}); team defense gets 0`);
        return done('OFF_RECOVERY');
    }
    const rushM = tText.match(/^(.+?) \d+ Yd (?:Rush|Run)\b/i);
    if (consensus === 'same' && (rushM || /\bYd (?:Rush|Run)\b/i.test(tText) || cast > 0)) {
        const rusher = pick(players, 'rusher') || firstNonKicker(players);
        if (!rusher) {
            reasons.push('rusher could not be identified');
            return done('AMBIGUOUS');
        }
        if (!rushM) reasons.push('same possession with unrecognised text form: treated as a rushing TD');
        credits.push(credit(rusher.id, 'rushing_tds', 1));
        reasons.push(`offensive rushing TD by ${rusher.name}`);
        return done('OFF_RUSH');
    }
    reasons.push('touchdown text not recognised and no possession data');
    return done('AMBIGUOUS');
}

/* ------------------------------------------------------------ DB credit */

function columnsForClass(awardClass, hasTwoPoint) {
    const cols = new Set(CLASS_PLAYER_COLUMNS[awardClass] || PLAYER_TD_COLUMNS);
    if (hasTwoPoint) TWO_PT_COLUMNS.forEach(c => cols.add(c));
    return [...cols];
}

/**
 * The TD / 2-pt / safety columns actually stored for every player involved in
 * the play plus both team defenses.
 */
function dbCreditFor(play, dbRows, teams) {
    const rows = new Map((dbRows || []).map(r => [String(r.player_id), r]));
    const home = (teams && teams.homeTeam) || play.homeTeam;
    const away = (teams && teams.awayTeam) || play.awayTeam;
    const hasTwoPoint = !!(play.twoPoint && (play.twoPoint.pass || play.twoPoint.run || play.twoPoint.rec));
    const playerCols = columnsForClass(play.awardClass, hasTwoPoint);
    const ids = new Set();
    for (const c of play.expectedCredits || []) ids.add(String(c.player_id));
    for (const p of (play.tank01 && play.tank01.players) || []) {
        if (p.id && !NON_RETURNER_POS.has(String(p.pos || '').toUpperCase())) ids.add(String(p.id));
    }
    if (play.twoPoint) ['pass', 'run', 'rec'].forEach(k => { if (play.twoPoint[k]) ids.add(String(play.twoPoint[k])); });
    if (home) ids.add(`DEF_${home}`);
    if (away) ids.add(`DEF_${away}`);

    const out = {};
    for (const id of ids) {
        const row = rows.get(id);
        if (!row) continue;
        const isDef = id.startsWith('DEF_');
        const cols = isDef ? [...DEF_COLUMNS, ...(hasTwoPoint ? [] : [])] : playerCols;
        const expectedCols = (play.expectedCredits || []).filter(c => String(c.player_id) === id).map(c => c.column);
        const all = [...new Set([...cols, ...expectedCols])];
        if (!all.length) continue;
        out[id] = {};
        for (const col of all) out[id][col] = num(row[col]);
    }
    return out;
}

/* ------------------------------------------------------------- dossier */

function buildMergedPlay(m, ctx) {
    const t = m.tank01;
    const e = m.espn;
    const period = t ? periodNumber(t.scorePeriod) : periodNumber(e.period && e.period.number);
    const clock = t ? normClock(t.scoreTime) : normClock(e.clock && e.clock.displayValue);
    const scoringTeam = t ? canon(t.team) : canon(e.team && e.team.abbreviation);
    const defendingTeam = scoringTeam === ctx.homeTeam ? ctx.awayTeam : ctx.homeTeam;
    const kind = kindOf(t, e);

    let espn = null;
    if (e) {
        let drive = null;
        if (m.drive) {
            const dp = m.drive.play;
            const d = m.drive.drive;
            drive = {
                team: d && d.team ? canon(d.team.abbreviation) : null,
                result: d ? d.result : null,
                isTurnover: dp.isTurnover === true,
                startTeam: dp.start && dp.start.team ? (ctx.teamIds[String(dp.start.team.id)] || canon(dp.start.team.abbreviation) || String(dp.start.team.id)) : null,
                endTeam: dp.end && dp.end.team ? (ctx.teamIds[String(dp.end.team.id)] || canon(dp.end.team.abbreviation) || String(dp.end.team.id)) : null,
                playText: dp.text || null
            };
        }
        espn = { typeText: e.type ? e.type.text : null, text: e.text, team: canon(e.team && e.team.abbreviation), drive, scoreAfter: scoreAfter(e) };
    }
    const merged = {
        kind,
        period: periodLabel(period),
        periodNumber: period,
        clock,
        scoringTeam,
        defendingTeam,
        tank01: t ? {
            text: t.score,
            scoreType: t.scoreType,
            scoreDetails: t.scoreDetails,
            scoreAfter: scoreAfter(t),
            players: buildPlayers(t, ctx)
        } : null,
        espn,
        espnAvailable: ctx.espnAvailable,
        espnScoringTeam: e ? canon(e.team && e.team.abbreviation) : null,
        espnPeriod: e ? periodLabel(periodNumber(e.period && e.period.number)) : null,
        matchedBy: m.matchedBy || null
    };
    return merged;
}

function twoPointFor(merged, ctx) {
    const resolver = buildResolver(ctx, merged.scoringTeam);
    const fromTank = merged.tank01 ? extractTwoPoint(merged.tank01.text, resolver) : null;
    const fromEspn = merged.espn ? extractTwoPoint(merged.espn.text, resolver) : null;
    const parsed = (fromTank && fromTank.success !== null) ? fromTank : (fromEspn && fromEspn.success !== null ? fromEspn : (fromTank || fromEspn));
    if (!parsed) return { twoPoint: null, credits: [], reasons: [] };
    const reasons = [];
    const credits = [];
    if (parsed.success === false) {
        reasons.push('2-pt attempt failed: no conversion credit');
        return { twoPoint: { pass: null, run: null, rec: null }, credits, reasons };
    }
    if (parsed.success === null) {
        reasons.push('2-pt text present but not parseable');
        return { twoPoint: { pass: null, run: null, rec: null }, credits, reasons };
    }
    if (fromTank && fromEspn && fromTank.success !== null && fromEspn.success !== null
        && (fromTank.passName !== fromEspn.passName || fromTank.runName !== fromEspn.runName || fromTank.recName !== fromEspn.recName)) {
        reasons.push('Tank01 and ESPN disagree on the 2-pt players; Tank01 used');
    }
    const twoPoint = { pass: parsed.pass, run: parsed.run, rec: parsed.rec };
    const unresolved = [];
    if (parsed.passName) {
        if (parsed.pass) credits.push(credit(parsed.pass, 'two_point_conversions_pass', 1, `2-pt pass by ${parsed.passName}`));
        else unresolved.push(parsed.passName);
    }
    if (parsed.recName) {
        if (parsed.rec) credits.push(credit(parsed.rec, 'two_point_conversions_rec', 1, `2-pt reception by ${parsed.recName}`));
        else unresolved.push(parsed.recName);
    }
    if (parsed.runName) {
        if (parsed.run) credits.push(credit(parsed.run, 'two_point_conversions_run', 1, `2-pt run by ${parsed.runName}`));
        else unresolved.push(parsed.runName);
    }
    reasons.push(`2-pt conversion good: ${parsed.runName ? `${parsed.runName} run` : `${parsed.passName} pass to ${parsed.recName}`}`);
    if (unresolved.length) reasons.push(`2-pt player name(s) not resolved to an id: ${unresolved.join(', ')}`);
    return { twoPoint, credits, reasons };
}

function playerName(id, dossierCtx) {
    if (String(id).startsWith('DEF_')) return String(id);
    const np = lookup(dossierCtx.nflPlayers, id);
    if (np && np.name) return np.name;
    const pp = lookup(dossierCtx.playerPositions, id);
    if (pp && pp.name) return pp.name;
    const ps = lookup(dossierCtx.playerStats, id);
    if (ps && ps.longName) return ps.longName;
    const row = (dossierCtx.dbRows || []).find(r => String(r.player_id) === String(id));
    return (row && (row.name || row.player_name)) || String(id);
}

/* ------------------------------------------------------ score reconciliation */

/**
 * Points the try-for-point parenthetical of a scoring text adds to a TD:
 * "(X Kick)" / "(X PAT)" -> 1 unless failed/blocked/missed/no good;
 * "(... for Two-Point Conversion)" -> 2; "(Two-Point ... Failed)" -> 0; none -> 0.
 */
function tryPoints(text) {
    const t = String(text || '');
    let pts = 0;
    const re = /\(([^()]*)\)/g;
    let m;
    while ((m = re.exec(t)) !== null) {
        const inner = m[1];
        if (/two[- ]point/i.test(inner)) {
            if (!/fail|no good|unsuccessful/i.test(inner)) pts += 2;
        } else if (/\b(kick|pat|extra point)\b/i.test(inner)) {
            if (!/fail|block|missed|no good|aborted|wide|short/i.test(inner)) pts += 1;
        }
    }
    return pts;
}

function playPoints(kind, text) {
    switch (kind) {
        case 'TD': return 6 + tryPoints(text);
        case 'FG': return 3;
        case 'SAFETY': return 2;
        case 'XP': return 1;
        case '2PT': return 2;
        default: return 0;
    }
}

/**
 * Reproduce the final score from the scoring plays of each source.
 *
 * Per play: TD 6 + the try read from the text ("(X Kick)" +1 unless failed /
 * blocked / missed, "for Two-Point Conversion" +2, otherwise +0), FG 3,
 * safety 2, a defensive conversion return 2. Both sources also report their
 * own running score after every play; a source reproduces the final when its
 * text tally does OR its running score after the last play does (Tank01 and
 * ESPN drop the "(Kick)" now and then, and Tank01 sometimes books the XP on
 * the next play's running score — but a play missing from the list is
 * missing from both tallies).
 *
 * @param {Array} plays  dossier plays ({kind, scoringTeam, tank01:{text, scoreAfter}|null, espn:{text, team, scoreAfter}|null})
 * @param {number|null} finalHome
 * @param {number|null} finalAway
 * @param {{home: string, away: string}} teams
 * @returns {{ tank01: {home, away, plays, lastReported, okText, okReported, ok}, espn: {...}, final: {home, away} }}
 *   ok is null when the source has no plays or the final score is unknown.
 */
function reconcileScore(plays, finalHome, finalAway, teams = {}) {
    const home = teams.home ? canon(teams.home) : null;
    const away = teams.away ? canon(teams.away) : null;
    const fh = finalHome === null || finalHome === undefined ? null : num(finalHome);
    const fa = finalAway === null || finalAway === undefined ? null : num(finalAway);
    const tally = () => ({ home: 0, away: 0, plays: 0, lastReported: null, okText: null, okReported: null, ok: null });
    const out = { tank01: tally(), espn: tally(), final: { home: fh, away: fa } };
    const add = (src, team, kind, text, after) => {
        const b = out[src];
        b.plays++;
        const pts = playPoints(kind, text);
        if (team === home) b.home += pts; else if (team === away) b.away += pts;
        if (after) b.lastReported = { home: after.home, away: after.away };
    };
    for (const p of plays || []) {
        if (p.tank01) add('tank01', canon(p.scoringTeam), p.kind, p.tank01.text, p.tank01.scoreAfter || null);
        if (p.espn) add('espn', canon(p.espn.team || p.scoringTeam), p.kind, p.espn.text, p.espn.scoreAfter || null);
    }
    for (const src of ['tank01', 'espn']) {
        const b = out[src];
        if (!b.plays || fh === null || fa === null) continue;
        b.okText = b.home === fh && b.away === fa;
        b.okReported = b.lastReported ? (b.lastReported.home === fh && b.lastReported.away === fa) : null;
        b.ok = b.okText || b.okReported === true;
    }
    return out;
}

/* ---------------------------------------------------------- defensive scores */

function isDefensiveCandidate(play) {
    if (play.kind === 'SAFETY' || play.awardClass === 'SAFETY_2') return true;
    if (String(play.awardClass || '').startsWith('DEF_8_')) return true;
    if (play.awardClass !== 'AMBIGUOUS') return false;
    // the try parenthetical ("(Drew Stevens PAT blocked)") is not the play
    const noTry = s => String(s || '').replace(/\([^()]*\)/g, ' ');
    const gamebook = play.espn && play.espn.drive ? String(play.espn.drive.playText || '').replace(/(TOUCHDOWN[.!?])[\s\S]*$/i, '$1') : '';
    const txt = `${noTry(play.tank01 ? play.tank01.text : '')} ${play.espn ? `${play.espn.typeText || ''} ${noTry(play.espn.text)} ${noTry(gamebook)}` : ''}`;
    return DEFENSIVE_CANDIDATE_RE.test(txt);
}

/**
 * Who the DB credits for this play. DB rows are per game, so for the team
 * defenses only the scoring team's DEF row counts, and only the column the
 * play could have produced (its expected column; every column if the play is
 * AMBIGUOUS). Individual players show every TD column they hold.
 */
const ROLE_COLUMNS = Object.freeze({
    passer: ['passing_tds'], receiver: ['receiving_tds'], rusher: ['rushing_tds'], recoverer: ['rushing_tds'], fumbler: ['rushing_tds'],
    returner: ['kick_return_tds', 'punt_return_tds'], interceptor: [], kicker: []
});

function creditedTo(play) {
    const out = [];
    const expectedCols = new Set((play.expectedCredits || []).map(c => `${c.player_id}.${c.column}`));
    const players = (play.tank01 && play.tank01.players) || [];
    for (const [pid, cols] of Object.entries(play.dbCredit || {})) {
        const isDef = pid.startsWith('DEF_');
        if (isDef && pid !== `DEF_${play.scoringTeam}`) continue;
        // an individual's credit is only "for this play" in the columns his role on the play can produce
        const player = players.find(p => String(p.id) === pid);
        const roles = (player && player.roles) || [];
        const roleCols = roles.length ? new Set(roles.flatMap(r => ROLE_COLUMNS[r] || [])) : null;
        for (const [col, v] of Object.entries(cols)) {
            if (!(num(v) > 0) || !TD_COLUMNS.includes(col)) continue;
            if (isDef && play.awardClass !== 'AMBIGUOUS' && !expectedCols.has(`${pid}.${col}`)) continue;
            if (!isDef && roleCols && !roleCols.has(col) && !expectedCols.has(`${pid}.${col}`)) continue;
            out.push({ player_id: pid, column: col, value: num(v) });
        }
    }
    return out;
}

/* ------------------------------------------------------------- dossier */

/**
 * Build the dossier for one game.  See INTERFACES.md "TD dossier" for the shape.
 * `finalScore` ({home, away}, e.g. from nfl_games) overrides the Tank01 body's
 * homePts/awayPts as the score the plays must reproduce.
 */
function buildGameDossier({ gameId, season, week, homeTeam, awayTeam, tank01Body, espnSummary, playerPositions, nflPlayers, dbRows, finalScore }) {
    const body = tank01Body || {};
    const home = canon(homeTeam || body.home);
    const away = canon(awayTeam || body.away);
    const ctx = {
        homeTeam: home,
        awayTeam: away,
        playerStats: body.playerStats || {},
        playerPositions: playerPositions || {},
        nflPlayers: nflPlayers || {},
        dbRows: dbRows || [],
        espnAvailable: !!espnSummary,
        teamIds: espnTeamIdMap(espnSummary)
    };

    const { matched, espnOnly } = matchPlays(body.scoringPlays || [], espnSummary ? espnSummary.scoringPlays || [] : [], flattenDrivePlays(espnSummary));
    const mergedAll = matched.map(m => buildMergedPlay(m, ctx));
    for (const e of espnOnly) {
        const drive = flattenDrivePlays(espnSummary).find(x => x.play.scoringPlay && String(x.play.id) === String(e.id)) || null;
        mergedAll.push(buildMergedPlay({ tank01: null, espn: e, drive, matchedBy: null }, ctx));
    }
    mergedAll.sort((a, b) => (a.periodNumber - b.periodNumber) || (clockSeconds(b.clock) - clockSeconds(a.clock)));

    const plays = mergedAll.map((merged, i) => {
        const cls = classifyPlay(merged);
        const tp = (merged.kind === 'TD' || merged.kind === '2PT') ? twoPointFor(merged, ctx) : { twoPoint: null, credits: [], reasons: [] };
        const play = {
            idx: i + 1,
            kind: merged.kind,
            period: merged.period,
            clock: merged.clock,
            scoringTeam: merged.scoringTeam,
            defendingTeam: merged.defendingTeam,
            tank01: merged.tank01 ? {
                text: merged.tank01.text,
                scoreType: merged.tank01.scoreType,
                scoreDetails: merged.tank01.scoreDetails,
                scoreAfter: merged.tank01.scoreAfter,
                players: merged.tank01.players.map(p => ({ id: p.id, name: p.name, pos: p.pos, team: p.team, roles: p.roles, draftable: p.draftable }))
            } : null,
            espn: merged.espn,
            awardClass: cls.awardClass,
            votes: cls.votes,
            votesAgree: cls.votesAgree,
            gamebook: cls.gamebook,
            twoPoint: tp.twoPoint,
            expectedCredits: [...cls.expectedCredits, ...tp.credits],
            exemptions: cls.exemptions,
            dbCredit: {},
            agreement: null,
            reasons: [...cls.reasons, ...tp.reasons],
            questionId: null
        };
        if (merged.matchedBy && merged.matchedBy !== 'period+clock+team') play.reasons.push(`ESPN match by ${merged.matchedBy}`);
        play.dbCredit = dbCreditFor(play, ctx.dbRows, { homeTeam: home, awayTeam: away });
        // What the rules cannot decide becomes a question (answered by reconcile / a ruling).
        if (play.kind === 'TD' && (play.awardClass === 'AMBIGUOUS' || play.votesAgree === false)) {
            play.questionId = questionIdFor(season, week, gameId || body.gameID, play.idx);
        }
        return play;
    });

    // Aggregate expected vs stored across the game (a player with two TDs of
    // the same kind needs the sum, not a per-play >= 1 test).
    const expectedTotals = {};
    const expectedPlays = {};
    const bump = (pid, col, delta, idx) => {
        expectedTotals[pid] = expectedTotals[pid] || {};
        expectedTotals[pid][col] = (expectedTotals[pid][col] || 0) + delta;
        if (idx !== undefined) {
            expectedPlays[pid] = expectedPlays[pid] || {};
            expectedPlays[pid][col] = expectedPlays[pid][col] || [];
            if (delta) expectedPlays[pid][col].push(idx);
        }
    };
    for (const d of [`DEF_${home}`, `DEF_${away}`]) DEF_COLUMNS.forEach(c => bump(d, c, 0));
    for (const p of plays) {
        for (const c of p.expectedCredits) bump(c.player_id, c.column, c.delta, p.idx);
        // Columns shown for involved players default to an expectation of 0 so over-credits surface.
        for (const [pid, cols] of Object.entries(p.dbCredit)) {
            for (const col of Object.keys(cols)) bump(pid, col, 0);
        }
    }
    const rowsById = new Map(ctx.dbRows.map(r => [String(r.player_id), r]));
    const dbTotals = {};
    for (const [pid, cols] of Object.entries(expectedTotals)) {
        dbTotals[pid] = {};
        const row = rowsById.get(pid);
        for (const col of Object.keys(cols)) dbTotals[pid][col] = row ? num(row[col]) : 0;
    }
    const ambiguousIdx = plays.filter(p => p.awardClass === 'AMBIGUOUS').map(p => p.idx);
    const discrepancies = [];
    if (ctx.dbRows.length) {
        for (const [pid, cols] of Object.entries(expectedTotals)) {
            for (const [col, expected] of Object.entries(cols)) {
                const actual = dbTotals[pid][col];
                if (actual === expected) continue;
                const d = { player_id: pid, name: playerName(pid, ctx), column: col, expected, actual,
                    plays: (expectedPlays[pid] && expectedPlays[pid][col]) || [] };
                if (ambiguousIdx.length && actual > expected) d.note = `may be explained by ambiguous play(s) ${ambiguousIdx.join(', ')}`;
                discrepancies.push(d);
            }
        }
    }
    for (const p of plays) {
        if (!ctx.dbRows.length || p.awardClass === 'AMBIGUOUS' || p.awardClass === 'NOT_TD') {
            p.agreement = null;
            continue;
        }
        p.agreement = p.expectedCredits.every(c => (dbTotals[c.player_id] && dbTotals[c.player_id][c.column] || 0) >= (expectedTotals[c.player_id][c.column] || 0));
    }

    const tdPlays = plays.filter(p => p.kind === 'TD');
    const summary = {
        tds: tdPlays.length,
        agreed: plays.filter(p => p.agreement === true).length,
        disagreed: plays.filter(p => p.agreement === false).length,
        ambiguous: plays.filter(p => p.awardClass === 'AMBIGUOUS').length,
        questions: plays.filter(p => p.questionId).length
    };

    // Final score: nfl_games (caller) > Tank01 body > ESPN header.
    const espnFinal = espnFinalScore(espnSummary, home, away);
    const tankHome = body.homePts !== undefined && body.homePts !== null ? num(body.homePts) : null;
    const tankAway = body.awayPts !== undefined && body.awayPts !== null ? num(body.awayPts) : null;
    const fin = finalScore && finalScore.home !== undefined && finalScore.home !== null && finalScore.away !== undefined && finalScore.away !== null
        ? { home: num(finalScore.home), away: num(finalScore.away) }
        : tankHome !== null && tankAway !== null ? { home: tankHome, away: tankAway }
            : espnFinal;
    const scoreCheck = reconcileScore(plays, fin ? fin.home : null, fin ? fin.away : null, { home, away });
    scoreCheck.tank01Final = tankHome !== null && tankAway !== null ? { home: tankHome, away: tankAway } : null;
    scoreCheck.espnFinal = espnFinal;

    const theGameId = gameId || body.gameID;
    const defensiveScores = plays.filter(isDefensiveCandidate).map(p => ({
        gameId: theGameId,
        playIdx: p.idx,
        kind: p.kind === 'SAFETY' ? 'SAFETY' : 'TD',
        period: p.period,
        clock: p.clock,
        scoringTeam: p.scoringTeam,
        text: (p.tank01 && p.tank01.text) || (p.espn && p.espn.text) || null,
        awardClass: p.awardClass,
        expectedCredits: p.expectedCredits.map(c => ({ player_id: c.player_id, column: c.column })),
        creditedTo: creditedTo(p).map(c => ({ player_id: c.player_id, column: c.column })),
        votes: p.votes,
        votesAgree: p.votesAgree,
        agreement: p.agreement,
        questionId: p.questionId
    }));

    return {
        gameId: theGameId,
        season,
        week,
        game: {
            home, away,
            homeScore: tankHome,
            awayScore: tankAway,
            status: body.gameStatus || null,
            espnAvailable: ctx.espnAvailable
        },
        plays,
        unmatched: {
            tank01Only: ctx.espnAvailable ? plays.filter(p => p.tank01 && !p.espn).map(p => p.idx) : [],
            espnOnly: espnOnly.map(e => ({ typeText: e.type ? e.type.text : null, text: e.text }))
        },
        expectedTotals,
        dbTotals,
        discrepancies,
        scoreCheck,
        defensiveScores,
        summary
    };
}

function espnFinalScore(espnSummary, home, away) {
    const comps = espnSummary && espnSummary.header && espnSummary.header.competitions;
    const competitors = comps && comps[0] && comps[0].competitors;
    if (!competitors) return null;
    let h = null, a = null;
    for (const c of competitors) {
        if (!c || !c.team) continue;
        const team = canon(c.team.abbreviation);
        const isHome = c.homeAway ? c.homeAway === 'home' : team === home;
        if (isHome || team === home) h = num(c.score);
        else if (c.homeAway === 'away' || team === away) a = num(c.score);
    }
    return h === null || a === null ? null : { home: h, away: a };
}

/* ------------------------------------------------------------ markdown */

const LEGEND = [
    `DEF_8_INT / DEF_8_FUMBLE / DEF_8_BLOCKED — possession changed (interception, opponent's fumble incl. muffs) or the kick was blocked: Team Defense DEF_<team> gets ${POINTS.DEF_TD} (def_int_return_tds / def_fumble_return_tds / def_blocked_return_tds +1). Blocked kicks are never 20-point returns.`,
    `RETURN_20_KICK / RETURN_20_PUNT — regular kickoff/punt return, no possession change: the individual returner gets ${POINTS.RETURN_TD} (kick_return_tds / punt_return_tds +1); Team Defense gets 0. A returner not in nfl_players (CB/S/LB) is credited to nobody by design (INFO exemption).`,
    `OFF_PASS — same-possession passing TD: passer passing_tds +1 (${POINTS.PASS_TD} pts), receiver receiving_tds +1 (${POINTS.TD} pts).`,
    `OFF_RUSH / OFF_RECOVERY — same-possession rushing TD or an offensive player recovering his own/teammate's fumble in the end zone: scorer rushing_tds +1 (${POINTS.TD} pts); Team Defense gets 0 even if ESPN labels it "Fumble Return".`,
    `SAFETY_2 — safety: DEF_<team> safeties +1 (${POINTS.SAFETY} pts). 2-pt conversions: two_point_conversions_pass/run/rec +1 (${POINTS.TWO_PT} pts each) on top of the TD.`,
    'AMBIGUOUS — the script could not decide (possession votes disagree, no vote at all on a fumble recovery, lateral, no ESPN match, sources disagree): raised as a question for the reconcile step / a ruling. NOT_TD — FG/XP, covered by the kicker check.'
];

function mdEscape(s) {
    return String(s === undefined || s === null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function renderGameMarkdown(dossier) {
    const g = dossier.game || {};
    const lines = [];
    lines.push(`# Game ${dossier.gameId} — ${g.away || '?'} @ ${g.home || '?'}`);
    lines.push('');
    lines.push(`Season ${dossier.season ?? '?'} week ${dossier.week ?? '?'} · Final score ${g.away || '?'} ${g.awayScore ?? '?'} – ${g.home || '?'} ${g.homeScore ?? '?'} · Tank01 status: ${g.status || 'unknown'} · ESPN summary: ${g.espnAvailable ? 'available' : 'NOT available'}`);
    lines.push('');
    lines.push(`Scoring plays: ${dossier.plays.length} (TDs ${dossier.summary.tds}) · agreed ${dossier.summary.agreed} · disagreed ${dossier.summary.disagreed} · ambiguous ${dossier.summary.ambiguous} · questions ${dossier.summary.questions ?? 0}`);
    lines.push('');
    const sc = dossier.scoreCheck;
    if (sc) {
        const one = (label, b) => `${label} ${g.away || '?'} ${b.away} – ${g.home || '?'} ${b.home} (${b.plays} plays${b.ok === null ? ', not checked' : b.ok ? ', OK' : ', MISMATCH'})`;
        lines.push(`Score check: final ${g.away || '?'} ${sc.final.away ?? '?'} – ${g.home || '?'} ${sc.final.home ?? '?'} · ${one('Tank01 plays', sc.tank01)} · ${one('ESPN plays', sc.espn)}`);
        lines.push('');
    }
    lines.push('## Award-class legend');
    lines.push('');
    for (const l of LEGEND) lines.push(`- ${l}`);
    lines.push('');
    lines.push('Rule: did the ball change possession on the play, or was the kick blocked? Three signals vote — ESPN drive `isTurnover`/drive team, the gamebook prose ("RECOVERED by", "INTERCEPTED by", "MUFFS", "BLOCKED"), and the scoring-play text; the class is definite only when the non-null votes agree. ESPN `type.text` is advisory only. Agreement compares the expected credits (aggregated per player across this game) against the stored player_stats row for this game.');
    lines.push('');
    const questions = dossier.plays.filter(p => p.questionId);
    lines.push('## Questions');
    lines.push('');
    if (!questions.length) lines.push('None — every scoring play was decided by the rules.');
    for (const p of questions) lines.push(`- \`${p.questionId}\` — play ${p.idx} (${p.period} ${p.clock} ${p.scoringTeam}): "${mdEscape((p.tank01 && p.tank01.text) || (p.espn && p.espn.text))}" · votes ${fmtVotes(p.votes || {})} · ${p.awardClass === 'AMBIGUOUS' ? 'AMBIGUOUS' : `classified ${p.awardClass} but the votes disagree`}`);
    lines.push('');
    if (dossier.defensiveScores && dossier.defensiveScores.length) {
        lines.push('## Defensive scores (takeaways, blocks, safeties, and candidates)');
        lines.push('');
        lines.push('| play | kind | team | award class | votes | agree | credited in DB | question |');
        lines.push('|---|---|---|---|---|---|---|---|');
        for (const d of dossier.defensiveScores) {
            lines.push(`| ${d.playIdx} | ${d.kind} | ${d.scoringTeam} | ${d.awardClass} | ${fmtVotes(d.votes || {})} | ${d.votesAgree === false ? '**no**' : 'yes'} | ${d.creditedTo.length ? d.creditedTo.map(c => `${c.player_id}.${c.column}`).join('; ') : 'nobody'} | ${d.questionId || ''} |`);
        }
        lines.push('');
    }

    if (dossier.discrepancies && dossier.discrepancies.length) {
        lines.push('## Discrepancies (expected vs stored, whole game)');
        lines.push('');
        lines.push('| player_id | name | column | expected | stored | plays | note |');
        lines.push('|---|---|---|---|---|---|---|');
        for (const d of dossier.discrepancies) {
            lines.push(`| ${d.player_id} | ${mdEscape(d.name)} | ${d.column} | ${d.expected} | ${d.actual} | ${d.plays.join(', ')} | ${mdEscape(d.note || '')} |`);
        }
        lines.push('');
    }
    if (dossier.unmatched && (dossier.unmatched.tank01Only.length || dossier.unmatched.espnOnly.length)) {
        lines.push('<a id="unmatched"></a>');
        lines.push('## Unmatched plays');
        lines.push('');
        if (dossier.unmatched.tank01Only.length) lines.push(`- Tank01 plays with no ESPN match: ${dossier.unmatched.tank01Only.map(i => `play-${i}`).join(', ')}`);
        for (const e of dossier.unmatched.espnOnly) lines.push(`- ESPN-only: ${mdEscape(e.typeText)} — ${mdEscape(e.text)}`);
        lines.push('');
    }

    lines.push('## Plays');
    lines.push('');
    for (const p of dossier.plays) {
        const kindLabel = p.kind === 'SAFETY' ? 'SAFETY' : p.kind;
        lines.push(`<a id="play-${p.idx}"></a>`);
        lines.push(`### Play ${p.idx} — ${p.period} ${p.clock} ${p.scoringTeam} ${kindLabel}`);
        lines.push('');
        lines.push(`- Award class: **${p.awardClass}**${p.agreement === null ? ' · agreement: n/a' : p.agreement ? ' · agreement: AGREE' : ' · agreement: **DISAGREE**'}${p.questionId ? ` · question \`${p.questionId}\`` : ''}`);
        if (p.kind === 'TD') lines.push(`- Votes: ${fmtVotes(p.votes || {})} → ${p.votesAgree === false ? '**DISAGREE**' : 'agree'}${p.gamebook ? ` · gamebook: recoveredBy ${p.gamebook.recoveredBy || '-'}${p.gamebook.recovered ? (p.gamebook.recoveredUpper ? ' (RECOVERED)' : ' (recovered)') : ''}, interceptedBy ${p.gamebook.intercepted ? (p.gamebook.interceptedBy || 'yes') : '-'}, muffed ${p.gamebook.muffed}, blocked ${p.gamebook.blocked}, lateral ${p.gamebook.lateral}` : ''}`);
        lines.push(`- Scoring team ${p.scoringTeam}, defending team ${p.defendingTeam}`);
        if (p.tank01) {
            lines.push(`- Tank01: "${mdEscape(p.tank01.text)}" · scoreType ${p.tank01.scoreType} · scoreDetails "${mdEscape(p.tank01.scoreDetails)}"`);
            const pl = p.tank01.players.map(x => `${x.name || '?'} (${x.pos || '?'}, ${x.id})`).join('; ');
            lines.push(`- Tank01 players: ${pl || 'none'}`);
        } else {
            lines.push('- Tank01: (no Tank01 scoring play for this ESPN play)');
        }
        if (p.espn) {
            lines.push(`- ESPN: type "${mdEscape(p.espn.typeText)}" · "${mdEscape(p.espn.text)}"`);
            if (p.espn.drive) {
                const d = p.espn.drive;
                lines.push(`- ESPN drive: team ${d.team || '?'} · result "${mdEscape(d.result)}" · isTurnover ${d.isTurnover} · possession ${d.startTeam || '?'} → ${d.endTeam || '?'}`);
                lines.push(`- Gamebook: "${mdEscape(d.playText)}"`);
            } else {
                lines.push('- ESPN drive: (no drive play found)');
            }
        } else {
            lines.push(`- ESPN: ${dossier.game && dossier.game.espnAvailable ? '(no ESPN scoring play matched)' : '(ESPN summary not available)'}`);
        }
        if (p.twoPoint) {
            const tp = [];
            if (p.twoPoint.pass) tp.push(`pass ${p.twoPoint.pass}`);
            if (p.twoPoint.rec) tp.push(`rec ${p.twoPoint.rec}`);
            if (p.twoPoint.run) tp.push(`run ${p.twoPoint.run}`);
            lines.push(`- Two-point: ${tp.length ? tp.join(', ') : 'attempted, no credit'}`);
        }
        lines.push(`- Reasons: ${p.reasons.map(mdEscape).join(' | ') || 'none'}`);
        if (p.exemptions.length) lines.push(`- Exemptions: ${p.exemptions.map(mdEscape).join(' | ')}`);
        lines.push(`- Expected credits: ${p.expectedCredits.length ? p.expectedCredits.map(c => `${c.player_id}.${c.column} +${c.delta}${c.note ? ` (${mdEscape(c.note)})` : ''}`).join('; ') : 'none'}`);
        const ids = Object.keys(p.dbCredit);
        if (ids.length) {
            const cols = [...new Set(ids.flatMap(id => Object.keys(p.dbCredit[id])))];
            lines.push('');
            lines.push(`| DB credited | ${cols.join(' | ')} |`);
            lines.push(`|---|${cols.map(() => '---').join('|')}|`);
            for (const id of ids) {
                lines.push(`| ${id} | ${cols.map(c => (p.dbCredit[id][c] === undefined ? '' : p.dbCredit[id][c])).join(' | ')} |`);
            }
        } else {
            lines.push('- DB credited: (no rows)');
        }
        lines.push('');
    }
    return lines.join('\n');
}

module.exports = {
    AWARD_CLASSES,
    QUESTION_OPTIONS,
    CLASS_CREDIT_COLUMNS,
    GAMEBOOK_TEAM_CODES,
    TD_COLUMNS,
    TWO_PT_COLUMNS,
    LEGEND,
    buildGameDossier,
    classifyPlay,
    matchPlays,
    extractTwoPoint,
    dbCreditFor,
    renderGameMarkdown,
    parseGamebook,
    gamebookTeam,
    reconcileScore,
    tryPoints,
    questionIdFor,
    // exposed for tests / other doublecheck modules
    driveVote,
    gamebookVote,
    textVote,
    voteConsensus,
    normClock,
    periodNumber,
    buildResolver
};
