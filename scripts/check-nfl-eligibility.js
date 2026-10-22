#!/usr/bin/env node
/**
 * Read-only IR eligibility check against live NFL.com.
 *
 * Runs the exact same gate DatabaseManager.validateRosterMove applies to an
 * ordinary IR move (server/services/nflRosterEligibilityService.js), for an
 * explicit player, without touching the pending queue and without writing to
 * the database. Useful for replaying historical email requests.
 *
 *   node scripts/check-nfl-eligibility.js --name "Isiah Pacheco" --team DET --season 2026 --week 3
 *   node scripts/check-nfl-eligibility.js --player-id 4361529 --season 2026 --week 3   # name/team read from the DB (read-only)
 *   node scripts/check-nfl-eligibility.js --name "Nico Collins" --team HOU             # season/week default to league_settings (read-only)
 *
 * Options: --json (evidence only, machine-readable), --timeout <ms>.
 * Exit codes: 0 eligible, 2 ineligible (definitive), 3 NFL.com data unavailable, 1 usage error.
 */
const path = require('path');
const NflRosterEligibilityService = require('../server/services/nflRosterEligibilityService');

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) args[key] = true;
        else { args[key] = next; i++; }
    }
    return args;
}

function openReadOnly() {
    const sqlite3 = require('sqlite3');
    const dbPath = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, '..', 'fantasy_football.db'));
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
    const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
    const close = () => new Promise(resolve => db.close(() => resolve()));
    return { get, close };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || (!args.name && !args['player-id'])) {
        console.error('Usage: node scripts/check-nfl-eligibility.js (--name "Full Name" --team CODE | --player-id ID) [--season YYYY --week N] [--json] [--timeout ms]');
        process.exit(1);
    }

    let name = args.name || null;
    let team = args.team || null;
    let season = args.season ? parseInt(args.season, 10) : null;
    let week = args.week ? parseInt(args.week, 10) : null;

    if (args['player-id'] || !season || !week) {
        const db = openReadOnly();
        try {
            if (args['player-id']) {
                const row = await db.get('SELECT player_id, name, position, team FROM nfl_players WHERE player_id = ?', [String(args['player-id'])]);
                if (!row) { console.error(`Player ${args['player-id']} not found in nfl_players`); process.exit(1); }
                name = name || row.name;
                team = team || row.team;
                if (!args.json) console.error(`Player ${row.player_id}: ${row.name} ${row.position} ${row.team}`);
            }
            if (!season || !week) {
                const s = await db.get('SELECT season_year, current_week FROM league_settings LIMIT 1');
                season = season || s.season_year;
                week = week || s.current_week;
            }
        } finally {
            await db.close();
        }
    }
    if (!team) { console.error('--team is required with --name'); process.exit(1); }

    const service = new NflRosterEligibilityService({ timeoutMs: args.timeout ? parseInt(args.timeout, 10) : undefined });
    if (!args.json) console.error(`Checking ${name} (${team}) for ${season} week ${week} against live NFL.com...`);
    try {
        const evidence = await service.checkIrEligibility({ playerName: name, team, season, week });
        if (args.json) console.log(JSON.stringify(evidence, null, 2));
        else {
            console.log(`ELIGIBLE: ${evidence.reason}`);
            console.log(`  observed: ${evidence.observedStatus}`);
            console.log(`  sources:  ${evidence.sources.join('\n            ')}`);
        }
        process.exit(0);
    } catch (error) {
        const evidence = error.evidence || { eligible: false, code: error.code || 'ERROR', reason: error.message };
        if (args.json) console.log(JSON.stringify(evidence, null, 2));
        else {
            console.log(`${error.code === 'NFL_INELIGIBLE' ? 'INELIGIBLE' : 'UNAVAILABLE'}: ${error.message}`);
            if (evidence.sources && evidence.sources.length) console.log(`  sources:  ${evidence.sources.join('\n            ')}`);
        }
        process.exit(error.code === 'NFL_INELIGIBLE' ? 2 : 3);
    }
}

main().catch(error => { console.error(error); process.exit(3); });
