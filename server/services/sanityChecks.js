'use strict';

/**
 * Basic sanity checks run by HealthCheckService.runValidation (full mode).
 *
 *   checkScheduleIntegrity({ db, week, season, espnCacheDir, now })
 *   checkClockSanity({ db, week, season, timedatectlImpl, now })
 *
 * Both return the standard check shape { name, status, message, details } with
 * status 'passed' | 'warning' | 'failed' | 'deferred'. A status is a call to
 * action: failed = the record is wrong, warning = look at it, deferred = the
 * information is not available yet (renders as info).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getTeamAbbreviation } = require('../utils/teamMappings');

const KICKOFF_TOLERANCE_SEC = 5 * 60;
const WEEK_SPAN_SEC = 5.5 * 24 * 3600;      // Thursday night -> Tuesday morning
const BYE_WEEKS = [5, 14];                   // NFL byes fall inside this range
const NAME_SCHEDULE = 'Schedule Integrity';
const NAME_CLOCK = 'Clock Sanity';

function canon(code) { return getTeamAbbreviation(code) || code; }
function pad2(n) { return String(n).padStart(2, '0'); }

function readScoreboard(espnCacheDir, season, week) {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(espnCacheDir, String(season), `week${pad2(week)}`, 'scoreboard.json'), 'utf8'));
        const body = raw && raw.body ? raw.body : raw;
        return Array.isArray(body && body.events) ? { events: body.events, fetchedAt: raw.fetchedAt || null } : null;
    } catch (_) { return null; }
}

/** ESPN events -> [{ eventId, home, away, dateMs, weekNumber }] (canonical codes). */
function espnEvents(events) {
    const out = [];
    for (const e of events || []) {
        const comp = e.competitions && e.competitions[0];
        if (!comp || !Array.isArray(comp.competitors)) continue;
        const home = comp.competitors.find(c => c.homeAway === 'home');
        const away = comp.competitors.find(c => c.homeAway === 'away');
        if (!home || !away) continue;
        out.push({ eventId: e.id, home: canon(home.team.abbreviation), away: canon(away.team.abbreviation), dateMs: Date.parse(e.date), weekNumber: e.week && e.week.number });
    }
    return out;
}

/** A usable kickoff epoch, or null. Unscheduled (TBD) rows store NULL, which Number() turns into 0 - never a real kickoff. */
function kickoffEpoch(g) {
    const e = Number(g && g.game_time_epoch);
    return Number.isFinite(e) && e > 0 ? e : null;
}

async function checkScheduleIntegrity({ db, week, season, espnCacheDir, now = Date.now() }) {
    const rows = await db.all('SELECT game_id, week, season, home_team, away_team, game_date, game_time, game_time_epoch, status FROM nfl_games WHERE season = ? ORDER BY week, game_time_epoch', [season]);
    const games = rows.map(g => ({ ...g, home_team: canon(g.home_team), away_team: canon(g.away_team) }));
    const issues = [], warnings = [];
    const byWeek = new Map();
    for (const g of games) { if (!byWeek.has(g.week)) byWeek.set(g.week, []); byWeek.get(g.week).push(g); }

    // duplicates + id consistency
    const seen = new Map();
    for (const g of games) {
        seen.set(g.game_id, (seen.get(g.game_id) || 0) + 1);
        const m = /^(\d{8})_([A-Z]{2,3})@([A-Z]{2,3})$/.exec(String(g.game_id));
        if (!m) { warnings.push(`${g.game_id}: unexpected game_id format`); continue; }
        const [, date, away, home] = m;
        if (canon(away) !== g.away_team || canon(home) !== g.home_team) issues.push(`${g.game_id}: id teams ${away}@${home} but columns say ${g.away_team}@${g.home_team}`);
        if (g.game_date && String(g.game_date) !== date) issues.push(`${g.game_id}: id date ${date} but game_date is ${g.game_date}`);
    }
    for (const [id, n] of seen) if (n > 1) issues.push(`duplicate game_id ${id} (${n} rows)`);

    // per-week shape
    const teamWeeks = new Map(); // team -> Set(weeks)
    for (const [w, list] of byWeek) {
        const teams = new Map();
        for (const g of list) for (const t of [g.home_team, g.away_team]) {
            teams.set(t, (teams.get(t) || 0) + 1);
            if (!teamWeeks.has(t)) teamWeeks.set(t, new Set());
            teamWeeks.get(t).add(w);
        }
        for (const [t, n] of teams) if (n > 1) issues.push(`week ${w}: ${t} appears in ${n} games`);
        if (list.length < 13 || list.length > 16) warnings.push(`week ${w}: ${list.length} games (expected 13-16)`);
        const epochs = list.map(kickoffEpoch).filter(Number.isFinite);
        if (epochs.length) {
            const start = Math.min(...epochs);
            for (const g of list) {
                const e = kickoffEpoch(g);
                if (Number.isFinite(e) && e > start + WEEK_SPAN_SEC) warnings.push(`${g.game_id}: kickoff ${new Date(e * 1000).toISOString()} is ${((e - start) / 86400).toFixed(1)} days after the first game of week ${w} - wrong week?`);
                if (!Number.isFinite(e) && Number.isFinite(start) && start * 1000 - now < 7 * 86400000 && start * 1000 > now - 86400000) warnings.push(`${g.game_id}: no kickoff time (TBD) with the week starting within 7 days`);
            }
        }
    }
    // byes: a team absent in week N (5..14) must play in N-1 and N+1 when those weeks are loaded
    const allTeams = [...teamWeeks.keys()];
    for (let w = BYE_WEEKS[0]; w <= BYE_WEEKS[1]; w++) {
        if (!byWeek.has(w) || !byWeek.has(w - 1) || !byWeek.has(w + 1)) continue;
        for (const t of allTeams) {
            const ws = teamWeeks.get(t);
            if (!ws.has(w) && (!ws.has(w - 1) || !ws.has(w + 1))) warnings.push(`${t}: no game in week ${w} and also missing week ${!ws.has(w - 1) ? w - 1 : w + 1} - schedule gap`);
        }
    }

    // ESPN comparison for this week and next (from the Double Check's cached scoreboard)
    const espnNotes = [];
    let espnChecked = 0;
    for (const w of [week, week + 1]) {
        const sb = espnCacheDir ? readScoreboard(espnCacheDir, season, w) : null;
        if (!sb) continue;
        espnChecked++;
        const list = byWeek.get(w) || [];
        const events = espnEvents(sb.events);
        const key = g => `${g.home}|${g.away}`;
        const ours = new Map(list.map(g => [`${g.home_team}|${g.away_team}`, g]));
        const theirs = new Map(events.map(e => [key(e), e]));
        for (const [k, e] of theirs) {
            const g = ours.get(k);
            if (!g) { warnings.push(`week ${w}: ESPN has ${e.away}@${e.home} (${new Date(e.dateMs).toISOString()}) but nfl_games does not`); continue; }
            if (e.weekNumber && Number(e.weekNumber) !== Number(w)) warnings.push(`${g.game_id}: ESPN puts this game in week ${e.weekNumber}`);
            const epoch = kickoffEpoch(g);
            if (Number.isFinite(epoch) && Number.isFinite(e.dateMs) && Math.abs(epoch * 1000 - e.dateMs) > KICKOFF_TOLERANCE_SEC * 1000) {
                warnings.push(`${g.game_id}: kickoff ${new Date(epoch * 1000).toISOString()} here vs ${new Date(e.dateMs).toISOString()} on ESPN (moved/flexed?)`);
            }
        }
        for (const [k, g] of ours) if (!theirs.has(k)) warnings.push(`${g.game_id}: not on ESPN's week ${w} scoreboard`);
        espnNotes.push(`week ${w}: ${events.length} ESPN events compared`);
    }

    let status = issues.length ? 'failed' : warnings.length ? 'warning' : (espnChecked === 0 ? 'deferred' : 'passed');
    const message = issues.length ? `${issues.length} schedule inconsistenc${issues.length === 1 ? 'y' : 'ies'}`
        : warnings.length ? `${warnings.length} schedule warning(s)`
            : espnChecked === 0 ? `Internal schedule consistent (${games.length} games); ESPN kickoff comparison deferred - no cached scoreboard for week ${week} yet`
                : `Schedule consistent (${games.length} games) and kickoffs match ESPN (${espnNotes.join(', ')})`;
    return { name: NAME_SCHEDULE, status, message, details: [...issues, ...warnings, ...(issues.length || warnings.length ? espnNotes : [])] };
}

// ---- clock

const ET_TIME = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true });
const ET_DATE = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

/** '1:00 PM' -> '1:00p'; '8:20 PM' -> '8:20p'; matches Tank01's game_time text. */
function etTimeText(epochSec) {
    const s = ET_TIME.format(new Date(epochSec * 1000)); // e.g. "1:00 PM"
    return s.replace(/\s*(AM|PM)$/i, (_, ap) => ap.toLowerCase()[0]);
}
function etDateText(epochSec) {
    const parts = Object.fromEntries(ET_DATE.formatToParts(new Date(epochSec * 1000)).map(p => [p.type, p.value]));
    return `${parts.year}${parts.month}${parts.day}`;
}
function normalizeTimeText(t) {
    return String(t || '').trim().toLowerCase().replace(/\s+/g, '').replace(/(am|pm)$/, m => m[0]);
}

function defaultTimedatectl() {
    const res = spawnSync('timedatectl', ['show', '-p', 'NTPSynchronized', '-p', 'Timezone'], { encoding: 'utf8', timeout: 5000 });
    if (res.error || res.status !== 0) return null;
    const out = {};
    for (const line of String(res.stdout).split('\n')) { const [k, v] = line.split('='); if (k && v !== undefined) out[k.trim()] = v.trim(); }
    return out;
}

async function checkClockSanity({ db, week, season, timedatectlImpl = defaultTimedatectl, now = Date.now() }) {
    const issues = [], warnings = [], notes = [];
    let clockInfo = null;
    try { clockInfo = timedatectlImpl(); } catch (_) { clockInfo = null; }
    if (!clockInfo) notes.push('timedatectl unavailable - NTP state not verified');
    else {
        if (String(clockInfo.NTPSynchronized).toLowerCase() !== 'yes') issues.push(`server clock is NOT NTP-synchronised (NTPSynchronized=${clockInfo.NTPSynchronized})`);
        if (clockInfo.Timezone && !/^(Etc\/)?UTC$/i.test(clockInfo.Timezone)) warnings.push(`server timezone is ${clockInfo.Timezone}, expected UTC (cron schedules and game windows assume UTC)`);
    }
    const rows = await db.all('SELECT game_id, week, game_date, game_time, game_time_epoch FROM nfl_games WHERE season = ? AND week IN (?, ?) ORDER BY week, game_time_epoch', [season, week, week + 1]);
    let checked = 0;
    for (const g of rows) {
        const e = kickoffEpoch(g);
        if (!Number.isFinite(e) || !g.game_time || /tbd/i.test(g.game_time)) continue;
        checked++;
        const expectTime = etTimeText(e), gotTime = normalizeTimeText(g.game_time);
        if (expectTime !== gotTime) warnings.push(`${g.game_id}: game_time '${g.game_time}' but the kickoff epoch is ${expectTime} ET`);
        const expectDate = etDateText(e);
        if (g.game_date && String(g.game_date) !== expectDate) warnings.push(`${g.game_id}: game_date ${g.game_date} but the kickoff epoch is ${expectDate} ET`);
    }
    const status = issues.length ? 'failed' : warnings.length ? 'warning' : 'passed';
    const message = issues.length ? issues[0]
        : warnings.length ? `${warnings.length} clock/timezone inconsistenc${warnings.length === 1 ? 'y' : 'ies'}`
            : `Clock NTP-synchronised${clockInfo && clockInfo.Timezone ? ` (${clockInfo.Timezone})` : ''}; ${checked} kickoff time(s) consistent with their epochs`;
    return { name: NAME_CLOCK, status, message, details: [...issues, ...warnings, ...notes] };
}

module.exports = {
    kickoffEpoch, checkScheduleIntegrity, checkClockSanity, espnEvents, etTimeText, etDateText, normalizeTimeText, readScoreboard, KICKOFF_TOLERANCE_SEC, NAME_SCHEDULE, NAME_CLOCK };
