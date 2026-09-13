#!/usr/bin/env node

process.env.NODE_ENV = 'production';

const DatabaseManager = require('../server/database/database');
const { applySeasonMatchups } = require('../server/services/seasonMatchupService');

function parseArgs(argv) {
    const seasonIndex = argv.indexOf('--season');
    if (seasonIndex === -1 || !argv[seasonIndex + 1]) {
        throw new Error('Usage: node scripts/apply-season-matchups.js --season YEAR [--apply]');
    }

    return {
        season: Number(argv[seasonIndex + 1]),
        dryRun: !argv.includes('--apply')
    };
}

async function main() {
    const { season, dryRun } = parseArgs(process.argv.slice(2));
    const db = new DatabaseManager();

    try {
        await db.initComplete;
        const result = await applySeasonMatchups(db, season, { dryRun });

        console.log(`${dryRun ? 'DRY RUN' : 'APPLIED'}: season ${season} (${result.mode})`);
        for (const assignment of result.assignments) {
            console.log(
                `  Slot ${assignment.draftSlot}: ${assignment.ownerName} ` +
                `(team_id ${assignment.teamId}, ${assignment.division})`
            );
        }
        console.log('Week 1:');
        for (const matchup of result.weeks[1]) {
            console.log(`  ${matchup.team1Owner} vs ${matchup.team2Owner}`);
        }
        if (dryRun) console.log('No database changes made. Pass --apply to commit this schedule.');
    } finally {
        await db.close();
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = { parseArgs };
