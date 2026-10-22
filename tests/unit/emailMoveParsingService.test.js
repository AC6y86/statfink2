/**
 * Tests for EmailMoveParsingService - prompt assembly, schema validation
 * with retry, and cross-validation of parser-returned player IDs.
 * Mocked backend (no claude subprocess) and mocked db; no network, no real DB.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const EmailMoveParsingService = require('../../server/services/emailMoveParsingService');
const { OWNERS, EMAILS, CANNED_RESPONSES } = require('../fixtures/rosterMoveEmails');

const PLAYERS = [
    { player_id: 'P_DELL', name: 'Tank Dell', position: 'WR', team: 'HOU' },
    { player_id: 'P_FLACCO', name: 'Joe Flacco', position: 'QB', team: 'CLE' },
    { player_id: 'P_MONT', name: 'David Montgomery', position: 'RB', team: 'DET' },
    { player_id: 'P_HBROWN', name: 'Marquise Brown', position: 'WR', team: 'KC' }
];

function mockDb() {
    return {
        async get(sql, params) {
            if (sql.includes('league_settings')) return { current_week: 18, season_year: 2025 };
            if (sql.includes('FROM nfl_players WHERE player_id')) {
                return PLAYERS.find(p => p.player_id === params[0]) || null;
            }
            return null;
        },
        async all(sql) {
            if (sql.includes("roster_position = 'active'")) {
                return [{ player_id: 'P_DELL', player_name: 'Tank Dell', player_position: 'WR', player_team: 'HOU' }];
            }
            if (sql.includes('injured_reserve')) return [];
            if (sql.includes('FROM nfl_players')) return PLAYERS;
            if (sql.includes('FROM teams')) return [{ team_id: 1, team_name: "Chris's Team", owner_name: 'Chris' }];
            return [];
        }
    };
}

function ownersFile() {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'owners-')), 'owners.json');
    fs.writeFileSync(file, JSON.stringify(OWNERS));
    return file;
}

function service(backendResponses) {
    const responses = Array.isArray(backendResponses) ? [...backendResponses] : [backendResponses];
    const backend = {
        calls: [],
        async run(prompt) {
            this.calls.push(prompt);
            const next = responses.length > 1 ? responses.shift() : responses[0];
            return typeof next === 'string' ? next : JSON.stringify(next);
        }
    };
    return {
        backend,
        svc: new EmailMoveParsingService(mockDb(), { parserBackend: backend, ownersFile: ownersFile() })
    };
}

describe('EmailMoveParsingService', () => {
    test('parses a clean supplemental move', async () => {
        const { svc } = service(CANNED_RESPONSES.simpleSupplemental);
        const result = await svc.parseEmail(EMAILS.simpleSupplemental);

        expect(result.status).toBe('parsed');
        expect(result.moves.length).toBe(1);
        expect(result.moves[0].confidence).toBe('high'); // cross-validation passed
        expect(result.moves[0].drop_quote).toBe("I'll drop Tank Dell");
    });

    test('prompt contains roster, player list, sender identity and the email', async () => {
        const { svc, backend } = service(CANNED_RESPONSES.simpleSupplemental);
        await svc.parseEmail(EMAILS.simpleSupplemental);

        const prompt = backend.calls[0];
        expect(prompt).toContain('P_DELL|Tank Dell|WR|HOU');           // roster + player list
        expect(prompt).toContain('Chris <chris@example.com> - team_id 1'); // sender
        expect(prompt).toContain("I'll drop Tank Dell and pick up Joe Flacco."); // email body
        expect(prompt).toContain('NEVER GUESS');                        // instructions
        expect(prompt).toContain('CURRENT WEEK: 18, SEASON: 2025');
    });

    test('unknown sender short-circuits without calling the backend', async () => {
        const { svc, backend } = service(CANNED_RESPONSES.simpleSupplemental);
        const result = await svc.parseEmail(EMAILS.unknownSender);

        expect(result.status).toBe('unknown_sender');
        expect(backend.calls.length).toBe(0);
    });

    test('banter and hypotheticals come back as not_a_roster_move', async () => {
        const { svc } = service(CANNED_RESPONSES.banter);
        const result = await svc.parseEmail(EMAILS.banter);
        expect(result.status).toBe('not_a_roster_move');
        expect(result.moves.length).toBe(0);
    });

    test('hallucinated player_id is demoted to low confidence', async () => {
        const bad = JSON.parse(JSON.stringify(CANNED_RESPONSES.simpleSupplemental));
        bad.moves[0].add_player_id = 'P_DOES_NOT_EXIST';
        const { svc } = service(bad);

        const result = await svc.parseEmail(EMAILS.simpleSupplemental);
        expect(result.moves[0].confidence).toBe('low');
        expect(result.moves[0].notes).toContain('not found in player table');
    });

    test('id/name mismatch is demoted to low confidence', async () => {
        const bad = JSON.parse(JSON.stringify(CANNED_RESPONSES.simpleSupplemental));
        bad.moves[0].add_player_id = 'P_MONT'; // DB says David Montgomery
        bad.moves[0].add_player_name = 'Joe Flacco';
        const { svc } = service(bad);

        const result = await svc.parseEmail(EMAILS.simpleSupplemental);
        expect(result.moves[0].confidence).toBe('low');
        expect(result.moves[0].notes).toContain('name mismatch');
    });

    test('wrong team_id is demoted to low confidence', async () => {
        const bad = JSON.parse(JSON.stringify(CANNED_RESPONSES.simpleSupplemental));
        bad.moves[0].team_id = 9;
        const { svc } = service(bad);

        const result = await svc.parseEmail(EMAILS.simpleSupplemental);
        expect(result.moves[0].confidence).toBe('low');
        expect(result.moves[0].notes).toContain("does not match sender's team");
    });

    test('markdown-fenced JSON is tolerated', async () => {
        const fenced = '```json\n' + JSON.stringify(CANNED_RESPONSES.simpleSupplemental) + '\n```';
        const { svc } = service(fenced);

        const result = await svc.parseEmail(EMAILS.simpleSupplemental);
        expect(result.status).toBe('parsed');
    });

    test('invalid JSON retries once with a reminder, then succeeds', async () => {
        const { svc, backend } = service(['this is not json at all', CANNED_RESPONSES.simpleSupplemental]);

        const result = await svc.parseEmail(EMAILS.simpleSupplemental);
        expect(result.status).toBe('parsed');
        expect(backend.calls.length).toBe(2);
        expect(backend.calls[1]).toContain('REMINDER');
    });

    test('persistently malformed output becomes ambiguous, never a guess', async () => {
        const { svc, backend } = service('still not json');

        const result = await svc.parseEmail(EMAILS.simpleSupplemental);
        expect(result.status).toBe('ambiguous');
        expect(result.moves).toEqual([]);
        expect(result.questions_for_commissioner[0]).toContain('handle this email manually');
        expect(backend.calls.length).toBe(2);
    });

    test('schema violations (bad enum) also trigger retry then ambiguous', async () => {
        const badEnum = JSON.parse(JSON.stringify(CANNED_RESPONSES.simpleSupplemental));
        badEnum.moves[0].move_type = 'waiver_claim';
        const { svc } = service(badEnum);

        const result = await svc.parseEmail(EMAILS.simpleSupplemental);
        expect(result.status).toBe('ambiguous');
    });

    describe('delegation (owners.json actsFor)', () => {
        const ELI_ROSTER = [{ player_id: 'P_MONT', player_name: 'David Montgomery', player_position: 'RB', player_team: 'DET' }];

        function delegatedService(response) {
            const db = mockDb();
            const baseAll = db.all.bind(db);
            db.all = async (sql, params) => {
                if (sql.includes("roster_position = 'active'") && params[0] === 11) return ELI_ROSTER;
                if (sql.includes('FROM teams')) {
                    return [{ team_id: 1, team_name: "Chris's Team", owner_name: 'Chris' }, { team_id: 11, team_name: "Eli's Team", owner_name: 'Eli' }];
                }
                return baseAll(sql, params);
            };
            const owners = { ...OWNERS, 'chris@example.com': { teamId: 1, ownerName: 'Chris', actsFor: [11] } };
            const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'owners-')), 'owners.json');
            fs.writeFileSync(file, JSON.stringify(owners));
            const backend = { calls: [], async run(prompt) { this.calls.push(prompt); return JSON.stringify(response); } };
            return { backend, svc: new EmailMoveParsingService(db, { parserBackend: backend, ownersFile: file }) };
        }

        test('a move for a delegated team passes cross-validation', async () => {
            const forEli = JSON.parse(JSON.stringify(CANNED_RESPONSES.simpleSupplemental));
            forEli.moves[0].team_id = 11;
            forEli.moves[0].drop_player_id = 'P_MONT';
            forEli.moves[0].drop_player_name = 'David Montgomery';
            const { svc, backend } = delegatedService(forEli);

            const result = await svc.parseEmail(EMAILS.simpleSupplemental);
            expect(result.moves[0].confidence).toBe('high');
            expect(result.moves[0].notes || '').not.toContain('CROSS-VALIDATION');

            const prompt = backend.calls[0];
            expect(prompt).toContain('SENDER MAY ALSO ACT FOR: Eli (Eli\'s Team) - team_id 11');
            expect(prompt).toContain("ELI'S ACTIVE ROSTER (player_id|name|pos|nfl_team):\nP_MONT|David Montgomery|RB|DET");
            expect(prompt).toContain("ELI'S INJURED RESERVE:\n(none)");
        });

        test('a move for a non-delegated team is still demoted', async () => {
            const wrong = JSON.parse(JSON.stringify(CANNED_RESPONSES.simpleSupplemental));
            wrong.moves[0].team_id = 9;
            const { svc } = delegatedService(wrong);

            const result = await svc.parseEmail(EMAILS.simpleSupplemental);
            expect(result.moves[0].confidence).toBe('low');
            expect(result.moves[0].notes).toContain('is not the sender\'s team 1 or a team they act for (11)');
        });

        test('senders without actsFor get no delegation section', async () => {
            const { svc, backend } = service(CANNED_RESPONSES.simpleSupplemental);
            await svc.parseEmail(EMAILS.simpleSupplemental);
            expect(backend.calls[0]).not.toContain('SENDER MAY ALSO ACT FOR:');
        });
    });

    test('plausiblyMatches handles nicknames sharing a last name', () => {
        const { svc } = service(CANNED_RESPONSES.simpleSupplemental);
        expect(svc.plausiblyMatches('Marquise Brown', 'Hollywood Brown')).toBe(true);
        expect(svc.plausiblyMatches('Joe Flacco', 'Flacco')).toBe(true);
        expect(svc.plausiblyMatches('Joe Flacco', 'David Montgomery')).toBe(false);
    });
});

describe('trade followed by IR parsing', () => {
    test('preserves both actions and includes ordered-trade rules and league ownership', async () => {
        const move = { ...CANNED_RESPONSES.simpleSupplemental.moves[0], move_type: 'trade',
            team_id: 1, drop_player_id: 'P_DELL', drop_player_name: 'Tank Dell',
            add_player_id: 'P_MONT', add_player_name: 'David Montgomery',
            partner_team_id: 2, partner_player_id: 'P_MONT', partner_player_name: 'David Montgomery' };
        const result = { ...CANNED_RESPONSES.simpleSupplemental, moves: [move,
            { ...move, move_type: 'ir', drop_player_id: 'P_MONT', drop_player_name: 'David Montgomery',
                add_player_id: 'P_FLACCO', add_player_name: 'Joe Flacco',
                partner_team_id: null, partner_player_id: null, partner_player_name: null }] };
        const { svc, backend } = service(result);
        const parsed = await svc.parseEmail({ ...EMAILS.simpleSupplemental, body: 'Trade Dell for Montgomery; put Montgomery on IR and add Flacco.' });
        expect(parsed.moves.map(m => m.move_type)).toEqual(['trade', 'ir']);
        expect(parsed.moves.every(m => m.confidence !== 'low')).toBe(true);
        expect(backend.calls[0]).toContain('trade first, then IR/drop');
        expect(backend.calls[0]).toContain('CURRENT LEAGUE OWNERSHIP');
    });

    test('mismatched trade incoming IDs fail closed', async () => {
        const result = { ...CANNED_RESPONSES.simpleSupplemental, moves: [{
            ...CANNED_RESPONSES.simpleSupplemental.moves[0], move_type: 'trade',
            partner_team_id: 2, partner_player_id: 'P_MONT', partner_player_name: 'David Montgomery'
        }] };
        const { svc } = service(result);
        expect((await svc.parseEmail(EMAILS.simpleSupplemental)).moves[0].confidence).toBe('low');
    });
});


describe('Dan invalidation notes', () => {
    const body = 'Pete cannot add Brian Robinson; he is already on Joe’s team.';
    const parsed = { status: 'move_invalidation', sender_team_id: 3, summary: 'Pete’s Robinson add is invalid: already owned.', invalidation_quote: body, questions_for_commissioner: [], moves: [] };
    test('keeps a verbatim Dan ruling separate from executable moves', async () => {
        const { svc } = service(parsed);
        svc.resolveSender = jest.fn().mockResolvedValue({ email: 'wdochse@gmail.com', teamId: 3, ownerName: 'Dan', actsFor: [] });
        const result = await svc.parseEmail({ ...EMAILS.banter, from: 'Dan <wdochse@gmail.com>', body });
        expect(result.status).toBe('move_invalidation');
        expect(result.moves).toEqual([]);
        expect(result.invalidation_quote).toBe(body);
    });
    test('another owner cannot be promoted into a Dan ruling', async () => {
        const { svc } = service(parsed);
        const result = await svc.parseEmail({ ...EMAILS.banter, body });
        expect(result.status).toBe('ambiguous');
    });
    test('hallucinated quote does not become a ruling', async () => {
        const { svc } = service(parsed);
        svc.resolveSender = jest.fn().mockResolvedValue({ email: 'wdochse@gmail.com', teamId: 3, ownerName: 'Dan', actsFor: [] });
        const result = await svc.parseEmail({ ...EMAILS.banter, from: 'wdochse@gmail.com', body: 'Dan passes' });
        expect(result.status).toBe('ambiguous');
    });
    test('invalidation cannot contain executable proposals', () => {
        const { svc } = service(parsed);
        expect(svc.validateAgainstSchema({ ...parsed, moves: CANNED_RESPONSES.simpleSupplemental.moves })).toContain('An invalidation note cannot execute moves');
    });
});
