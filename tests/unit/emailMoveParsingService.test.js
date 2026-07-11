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

    test('plausiblyMatches handles nicknames sharing a last name', () => {
        const { svc } = service(CANNED_RESPONSES.simpleSupplemental);
        expect(svc.plausiblyMatches('Marquise Brown', 'Hollywood Brown')).toBe(true);
        expect(svc.plausiblyMatches('Joe Flacco', 'Flacco')).toBe(true);
        expect(svc.plausiblyMatches('Joe Flacco', 'David Montgomery')).toBe(false);
    });
});
