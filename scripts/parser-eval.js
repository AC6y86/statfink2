#!/usr/bin/env node
/**
 * Live eval of the email roster-move parser against the REAL headless
 * Claude backend and REAL database context (read-only - nothing is queued
 * or executed). Not part of npm test: run it when the prompt, schema, or
 * model changes, via `npm run test:parser-eval`.
 *
 * Eval emails are generated from the current roster so expected player IDs
 * are exact. Each case costs one real claude -p call (~30-90s each).
 *
 * Exit code 0 = all cases passed, 1 = failures (or could not build cases).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const DatabaseManager = require('../server/database/database');
const EmailMoveParsingService = require('../server/services/emailMoveParsingService');
const { extractLatestMessage } = require('./roster-email-poller');

const SENDER = 'parser-eval@statfink.test';

function evalEmail(id, body, subject = 'roster move') {
    return { gmailMessageId: `eval-${id}`, threadId: null, from: SENDER, subject, date: new Date().toUTCString(), body };
}

async function buildCases(db, teamId) {
    const { current_week: week, season_year: season } = await db.get(
        'SELECT current_week, season_year FROM league_settings WHERE league_id = 1'
    );

    const rosterPlayers = await db.all(`
        SELECT player_id, player_name FROM weekly_rosters
        WHERE team_id = ? AND week = ? AND season = ? AND roster_position = 'active'
          AND player_position IN ('RB', 'WR')
        ORDER BY player_name LIMIT 2
    `, [teamId, week, season]);

    // Uniquely-named free agents only, so a correct parse can never be
    // ambiguous about which player the name refers to
    const freeAgents = await db.all(`
        SELECT player_id, name FROM nfl_players
        WHERE position IN ('RB', 'WR')
          AND player_id NOT IN (SELECT player_id FROM weekly_rosters WHERE week = ? AND season = ?)
          AND name IN (SELECT name FROM nfl_players GROUP BY name HAVING COUNT(*) = 1)
        ORDER BY name LIMIT 2
    `, [week, season]);

    if (rosterPlayers.length < 2 || freeAgents.length < 2) {
        throw new Error(`Not enough roster players (${rosterPlayers.length}) or free agents (${freeAgents.length}) to build eval cases`);
    }
    const [r1, r2] = rosterPlayers;
    const [f1, f2] = freeAgents;

    return [
        {
            name: 'plain drop+add defaults to IR',
            email: evalEmail('ir-default', `Hey Joe, I'll drop ${r1.player_name} and pick up ${f1.name}. Thanks!`),
            check: p => p.status === 'parsed'
                && p.moves.length === 1
                && p.moves[0].move_type === 'ir'
                && p.moves[0].drop_player_id === String(r1.player_id)
                && p.moves[0].add_player_id === String(f1.player_id)
        },
        {
            name: 'explicit supplemental is supplemental',
            email: evalEmail('supplemental',
                `The supplemental draft has started! I'll drop ${r1.player_name} and pick up ${f1.name}.`, 'supplemental'),
            check: p => p.status === 'parsed'
                && p.moves.length === 1
                && p.moves[0].move_type === 'supplemental'
                && p.moves[0].drop_player_id === String(r1.player_id)
        },
        {
            name: 'two moves in one email',
            email: evalEmail('two-moves',
                `Drop ${r1.player_name} and pick up ${f1.name}. Also drop ${r2.player_name} for ${f2.name}.`),
            check: p => p.status === 'parsed' && p.moves.length === 2
        },
        {
            name: 'banter is not a move',
            email: evalEmail('banter', `That ${f1.name} pickup last week really paid off, great move!`, 'nice one'),
            check: p => p.status === 'not_a_roster_move' && p.moves.length === 0
        },
        {
            name: 'hypothetical is not a move',
            email: evalEmail('hypothetical',
                `I'm thinking about dropping ${r1.player_name}, maybe for ${f1.name}. What do you think?`, 'thoughts?'),
            check: p => p.status === 'not_a_roster_move' && p.moves.length === 0
        },
        {
            name: 'contradictory email is ambiguous',
            email: evalEmail('ambiguous',
                `Drop both my kickers... actually never mind, just drop Smithergill and grab whoever is best available.`),
            check: p => p.status === 'ambiguous'
                && p.moves.every(m => m.confidence !== 'high')
                && p.questions_for_commissioner.length > 0
        },
        {
            name: 'quoted thread (poller-stripped) parses the confirmation',
            email: evalEmail('quoted', extractLatestMessage(
                `Yes confirmed, drop ${r1.player_name} for ${f1.name}.\n\nOn Tue, Jun 9, Joe wrote:\n> Did you want to make that move?\n> Or drop ${r2.player_name} instead?`)),
            check: p => p.status === 'parsed'
                && p.moves.length === 1
                && p.moves[0].drop_player_id === String(r1.player_id)
        }
    ];
}

async function main() {
    const db = new DatabaseManager();
    await new Promise(resolve => setTimeout(resolve, 1000)); // wait for DB init

    try {
        // Evaluate as a real team so the roster context is authentic; use the
        // first team in the real owners mapping (falls back to team 5 = Joe)
        let teamId = 5;
        try {
            const owners = JSON.parse(fs.readFileSync(path.join(__dirname, '../roster_moves/owners.json'), 'utf8'));
            teamId = Object.values(owners)[0]?.teamId ?? teamId;
        } catch { /* fall back */ }

        const ownersFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'parser-eval-')), 'owners.json');
        fs.writeFileSync(ownersFile, JSON.stringify({ [SENDER]: { teamId, ownerName: 'Eval' } }));

        const svc = new EmailMoveParsingService(db, { ownersFile }); // real HeadlessClaudeBackend
        const cases = await buildCases(db, teamId);

        console.log(`Running ${cases.length} live parser eval cases as team ${teamId} (model: ${process.env.ROSTER_PARSER_MODEL || 'opus'})\n`);

        let failures = 0;
        for (const c of cases) {
            const started = Date.now();
            process.stdout.write(`  ${c.name} ... `);
            try {
                const parsed = await svc.parseEmail(c.email);
                const ok = c.check(parsed);
                console.log(`${ok ? 'PASS' : 'FAIL'} (${Math.round((Date.now() - started) / 1000)}s)`);
                if (!ok) {
                    failures++;
                    console.log(`    status=${parsed.status}, moves=${JSON.stringify(parsed.moves, null, 2).split('\n').join('\n    ')}`);
                    if (parsed.questions_for_commissioner?.length) {
                        console.log(`    questions: ${parsed.questions_for_commissioner.join(' | ')}`);
                    }
                }
            } catch (error) {
                failures++;
                console.log(`ERROR (${error.message})`);
            }
        }

        console.log(`\n${cases.length - failures}/${cases.length} passed`);
        process.exitCode = failures > 0 ? 1 : 0;
    } finally {
        db.close();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
