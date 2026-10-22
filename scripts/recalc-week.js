#!/usr/bin/env node
/**
 * Recalculate ONE week of the current season after a scoring-logic fix.
 *
 *   node scripts/recalc-week.js <season> <week> [--standings] [--force] [--allow-blessed]
 *
 * Runs the per-week slice of the season recalculation from the cached Tank01
 * boxscores (docs/DOUBLECHECK.md "Repair path"): wipe the week, resync games +
 * stats + scoring plays, fantasy points, defensive bonuses (when every game is
 * Final), scoring lineups / matchup totals, and standings with --standings
 * (only for a week whose standings were already written).
 *
 * Guards (CLAUDE.md): refuses 2024/2025 without --allow-blessed (those seasons
 * are blessed; use utils/recalculate202Xseason.js + re-bless instead); refuses
 * while the watchdog reports games in progress unless --force (SQLite has one
 * writer and the live loop is it during games). Afterwards run
 * `node scripts/doublecheck-daily.js --force --week <week>` to verify.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const SeasonRecalculationOrchestrator = require('../server/services/seasonRecalculationOrchestrator');

const REPO = path.join(__dirname, '..');
const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const season = parseInt(positional[0], 10);
const week = parseInt(positional[1], 10);
const OPTS = { standings: args.includes('--standings'), force: args.includes('--force'), allowBlessed: args.includes('--allow-blessed') };
const log = msg => console.log(`[${new Date().toISOString()}] ${msg}`);

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }

async function main() {
    if (!season || !week || week < 1 || week > 18) {
        console.error('Usage: node scripts/recalc-week.js <season> <week> [--standings] [--force] [--allow-blessed]');
        process.exit(2);
    }
    if (season <= 2025 && !OPTS.allowBlessed) {
        console.error(`${season} is a blessed season. Fix the logic, run utils/recalculate${season}season.js, re-bless (npm run baseline:2025) - or pass --allow-blessed if you really mean it.`);
        process.exit(2);
    }
    const live = readJson(path.join(REPO, 'logs/watchdog/live-latest.json'));
    if (live && live.gamesInProgress > 0 && !OPTS.force) {
        console.error(`${live.gamesInProgress} game(s) in progress (watchdog ${live.ts}); the live loop owns the database now. Retry when idle or pass --force.`);
        process.exit(2);
    }
    log(`Recalculating ${season} week ${week}${OPTS.standings ? ' (+ standings)' : ''}`);
    const orchestrator = new SeasonRecalculationOrchestrator(season, 18);
    try {
        const result = await orchestrator.recalculateWeek(week, { standings: OPTS.standings, log });
        log(`Done: ${result.steps.join(' -> ')}${result.complete ? '' : ' (week not complete: bonuses deferred)'}`);
        log(`Verify: node scripts/doublecheck-daily.js --force --week ${week}`);
    } finally {
        try { orchestrator.db.close(); } catch (_) { /* already closed */ }
    }
}

main().catch(err => { console.error(`recalc-week failed: ${err.message}`); process.exit(1); });
