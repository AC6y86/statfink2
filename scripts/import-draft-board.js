#!/usr/bin/env node
/**
 * Import (or reconcile) fantasy rosters from the live draft board.
 *
 * Reads the draft snapshot (https://joepaley.com/draft/api/snapshot by default),
 * matches every pick to nfl_players, and diffs the result against the existing
 * weekly_rosters rows for the target season/week. Rows that already match are
 * left untouched (so is_scoring / scoring_slot set by live scoring survive);
 * only missing picks are inserted and stray rows removed.
 *
 * Usage:
 *   node scripts/import-draft-board.js                 # dry run against current season/week
 *   node scripts/import-draft-board.js --apply         # write changes (backs up DB first)
 *   node scripts/import-draft-board.js --file snap.json --season 2026 --week 1 --apply
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const DatabaseManager = require('../server/database/database');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const APPLY = args.includes('--apply');
const URL = opt('--url', 'https://joepaley.com/draft/api/snapshot');
const FILE = opt('--file', null);
const BACKUP_DIR = '/home/joepaley/backups';
const fold = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

async function loadSnapshot() {
    if (FILE) return JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const res = await axios.get(URL, { timeout: 30000, headers: { 'Cache-Control': 'no-cache' } });
    return res.data;
}

// Match one draft pick to an nfl_players row. Names are compared with
// diacritics stripped and Jr./III suffixes removed. When several rows share a
// name (the table still carries stale placeholder ids like KC_QB1 next to the
// real Tank01 id), prefer the row on the drafted NFL team, then the one most
// recently touched by the player sync, then a numeric Tank01 id.
const normName = s => fold(s).replace(/[.'\u2019-]/g, '').replace(/\s+(jr|sr|iii|ii|iv|v)$/, '').replace(/\s+/g, ' ').trim();
const rank = (pick) => (a, b) =>
    ((b.team === pick.nflTeam) - (a.team === pick.nflTeam)) ||
    String(b.last_updated || '').localeCompare(String(a.last_updated || '')) ||
    ((/^\d+$/.test(b.player_id)) - (/^\d+$/.test(a.player_id)));

async function matchPick(db, pick) {
    if (['TD', 'DST', 'DEF'].includes(pick.position)) {
        return db.get(`SELECT player_id, name, position, team FROM nfl_players WHERE team = ? AND position = 'DST'`, [pick.nflTeam]);
    }
    const position = pick.position === 'PK' ? 'K' : pick.position;
    const rows = await db.all('SELECT player_id, name, position, team, last_updated FROM nfl_players WHERE position = ?', [position]);
    const want = normName(pick.playerName);
    let hits = rows.filter(r => normName(r.name) === want);
    if (!hits.length) {
        hits = rows.filter(r => normName(r.name).includes(want) || want.includes(normName(r.name)));
        if (hits.length > 1) hits = hits.filter(r => r.team === pick.nflTeam);
        if (hits.length !== 1) return null;
        console.warn(`Fuzzy match: ${pick.playerName} (${pick.nflTeam}) -> ${hits[0].name} [${hits[0].player_id}]`);
    }
    hits.sort(rank(pick));
    const best = hits[0];
    if (hits.length > 1) console.warn(`Duplicate ids for ${pick.playerName}: chose ${best.player_id}, skipped ${hits.slice(1).map(h => h.player_id).join(', ')}`);
    if (best.team !== pick.nflTeam) console.warn(`Team mismatch: ${pick.playerName} drafted as ${pick.nflTeam}, table says ${best.team}`);
    return { player_id: best.player_id, name: best.name, position: best.position, team: best.team };
}

async function main() {
    const snapshot = await loadSnapshot();
    if (!snapshot || !Array.isArray(snapshot.picks)) throw new Error('Snapshot has no picks array');
    const expectedPicks = (snapshot.teamCount || 12) * (snapshot.totalRounds || 19);
    console.log(`Snapshot v${snapshot.version} updated ${snapshot.updatedAt}: ${snapshot.picks.length}/${expectedPicks} picks`);
    if (snapshot.picks.length !== expectedPicks) {
        console.warn(`WARNING: draft board shows ${snapshot.picks.length} picks, expected ${expectedPicks} - draft may be incomplete`);
    }

    const db = new DatabaseManager();
    await db.initComplete;
    try {
        const settings = await db.get('SELECT season_year AS season, current_week FROM league_settings LIMIT 1');
        const season = parseInt(opt('--season', settings.season));
        const week = parseInt(opt('--week', settings.current_week));
        console.log(`Target: season ${season}, week ${week}${APPLY ? ' (APPLY)' : ' (dry run)'}`);

        // Owner name -> team_id from the teams table (the DraftImporter's hardcoded map is stale)
        const teams = await db.all('SELECT team_id, owner_name FROM teams');
        const teamByOwner = Object.fromEntries(teams.map(t => [t.owner_name, t.team_id]));
        const unknownOwners = [...new Set(snapshot.picks.map(p => p.fantasyTeam))].filter(o => !teamByOwner[o]);
        if (unknownOwners.length) throw new Error(`Draft board owners not in teams table: ${unknownOwners.join(', ')}`);

        // Match picks to nfl_players
        const desired = {}; // team_id -> Map(player_id -> player row)
        const unmatched = [];
        for (const pick of snapshot.picks) {
            const player = await matchPick(db, pick);
            if (!player) { unmatched.push(pick); continue; }
            const teamId = teamByOwner[pick.fantasyTeam];
            desired[teamId] = desired[teamId] || new Map();
            if (desired[teamId].has(player.player_id)) throw new Error(`Duplicate match within ${pick.fantasyTeam}: ${pick.playerName} -> ${player.player_id}`);
            desired[teamId].set(player.player_id, { ...player, pick });
        }
        if (unmatched.length) {
            console.error(`\nUNMATCHED ${unmatched.length} picks:`);
            for (const p of unmatched) {
                const last = p.playerName.split(' ').slice(-1)[0];
                const similar = await db.all('SELECT player_id, name, position, team FROM nfl_players WHERE name LIKE ? ORDER BY (position = ?) DESC, name LIMIT 5', [`%${last}%`, p.position === 'PK' ? 'K' : p.position]);
                console.error(`  #${p.overall} ${p.playerName} (${p.position}, ${p.nflTeam}) -> ${p.fantasyTeam}` +
                    (similar.length ? `\n     similar: ${similar.map(s => `${s.name} (${s.position}, ${s.team}) [${s.player_id}]`).join('; ')}` : ''));
            }
            throw new Error('Aborting: unmatched picks');
        }
        // Cross-team duplicates
        const seen = new Map();
        for (const [teamId, m] of Object.entries(desired)) for (const pid of m.keys()) {
            if (seen.has(pid)) throw new Error(`Player ${pid} drafted by two teams (${seen.get(pid)} and ${teamId})`);
            seen.set(pid, teamId);
        }

        // Diff against existing rows
        const existing = await db.all('SELECT * FROM weekly_rosters WHERE season = ? AND week = ?', [season, week]);
        const existingByTeam = {};
        for (const r of existing) (existingByTeam[r.team_id] = existingByTeam[r.team_id] || new Map()).set(r.player_id, r);

        const toAdd = [], toRemove = [];
        for (const t of teams) {
            const want = desired[t.team_id] || new Map();
            const have = existingByTeam[t.team_id] || new Map();
            for (const [pid, p] of want) if (!have.has(pid)) toAdd.push({ team: t, player: p });
            for (const [pid, r] of have) if (!want.has(pid)) toRemove.push({ team: t, row: r });
        }

        console.log('\nPer-team (draft / existing):');
        for (const t of teams) console.log(`  ${String(t.team_id).padStart(2)} ${t.owner_name.padEnd(6)} ${(desired[t.team_id] || new Map()).size} / ${(existingByTeam[t.team_id] || new Map()).size}`);
        console.log(`\nTo add (${toAdd.length}):`);
        for (const a of toAdd) console.log(`  + ${a.team.owner_name.padEnd(6)} #${a.player.pick.overall} ${a.player.name} (${a.player.position}, ${a.player.team}) [${a.player.player_id}]`);
        console.log(`To remove (${toRemove.length}):`);
        for (const r of toRemove) console.log(`  - ${r.team.owner_name.padEnd(6)} ${r.row.player_name} (${r.row.player_position}, ${r.row.player_team}) [${r.row.player_id}]${r.row.is_scoring ? ' *scoring*' : ''}`);

        if (!toAdd.length && !toRemove.length) { console.log('\nRosters already match the draft board. Nothing to do.'); return; }
        if (!APPLY) { console.log('\nDry run only. Re-run with --apply to write these changes.'); return; }

        // Backup, then apply atomically
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
        const backupPath = path.join(BACKUP_DIR, `fantasy_football_${stamp}_pre-draft-import.db`);
        await db.run(`VACUUM INTO ?`, [backupPath]);
        console.log(`\nBackup written: ${backupPath}`);

        await db.run('BEGIN IMMEDIATE');
        try {
            for (const r of toRemove) await db.run('DELETE FROM weekly_rosters WHERE weekly_roster_id = ?', [r.row.weekly_roster_id]);
            for (const a of toAdd) await db.run(`
                INSERT INTO weekly_rosters (team_id, player_id, week, season, roster_position, player_name, player_position, player_team)
                VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
                [a.team.team_id, a.player.player_id, week, season, a.player.name, a.player.position, a.player.team]);
            await db.run('COMMIT');
        } catch (e) { await db.run('ROLLBACK'); throw e; }

        const verify = await db.all('SELECT team_id, COUNT(*) n FROM weekly_rosters WHERE season = ? AND week = ? GROUP BY team_id ORDER BY team_id', [season, week]);
        console.log(`\nApplied: +${toAdd.length} / -${toRemove.length}. Per-team counts now: ${verify.map(v => `${v.team_id}:${v.n}`).join(' ')}`);
        const bad = verify.filter(v => v.n !== 19);
        if (bad.length || verify.length !== 12) console.warn('WARNING: not every team has 19 players');
    } finally {
        await db.close();
    }
}

main().catch(err => { console.error('Draft import failed:', err.message); process.exit(1); });
