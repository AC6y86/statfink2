const { ENTRIES, knownErrorsFor, matchFinding } = require('../../server/config/knownScoringErrors');
const { RULE_FIRST_SEASON } = require('../../server/config/scoringRulesets');

describe('knownScoringErrors registry (accepted errors in blessed seasons)', () => {
    test('every entry is well-formed, unique, and points at a blessed season with a fix from a later season', () => {
        const ids = new Set();
        for (const e of ENTRIES) {
            expect(typeof e.id).toBe('string');
            expect(ids.has(e.id)).toBe(false); ids.add(e.id);
            expect([2024, 2025]).toContain(e.season);
            expect(e.week).toBeGreaterThanOrEqual(1);
            expect(typeof e.game_id).toBe('string');
            expect(e.status).toBe('accepted');
            expect(e.fixedFrom).toBeGreaterThanOrEqual(2026);
            expect(typeof e.cause).toBe('string');
            if (e.player_id) {
                expect(typeof e.column).toBe('string');
                expect(e.stored).not.toBe(e.correct);
            }
            if (RULE_FIRST_SEASON[e.rule] !== undefined) expect(RULE_FIRST_SEASON[e.rule]).toBe(e.fixedFrom);
        }
        expect(ENTRIES.length).toBeGreaterThan(0);
    });

    test('knownErrorsFor filters by season and week', () => {
        expect(knownErrorsFor(2025, 3).map(e => e.id)).toEqual(['2025-wk03-DEF_PHI-blocked-fg', '2025-wk03-lane-team-code-wsh']);
        expect(knownErrorsFor(2025, 2).length).toBe(3);
        expect(knownErrorsFor(2026, 1)).toEqual([]);
        expect(knownErrorsFor(2025).length).toBe(ENTRIES.length);
    });

    const phi = knownErrorsFor(2025, 3).find(e => e.id === '2025-wk03-DEF_PHI-blocked-fg');
    const aubrey = knownErrorsFor(2025, 12).find(e => e.id === '2025-wk12-aubrey-missing-fg');
    const boxPhiDal = knownErrorsFor(2025, 12).find(e => e.id === '2025-wk12-PHI@DAL-boxscore-incomplete');

    test('matches the error by player id + column (stat finding)', () => {
        const f = { bugClassRef: 'S1', entity: { type: 'player', id: '3953687' }, internal: { field_goals_made: 0 }, expected: { field_goals_made: 1 }, explanation: 'x' };
        expect(matchFinding(aubrey, f, 2025, 12)).toBe(true);
        expect(matchFinding(aubrey, { ...f, internal: { extra_points_made: 3 }, expected: {}, explanation: 'extra points' }, 2025, 12)).toBe(false);
        expect(matchFinding(aubrey, f, 2025, 11)).toBe(false);
    });

    test('matches a play finding by game + player id/name in the text + column', () => {
        const f = { bugClassRef: 'B2', entity: { type: 'play', id: '20250921_LAR@PHI#11', gameId: '20250921_LAR@PHI' }, explanation: 'DEF_8_BLOCKED ... Expected DEF_PHI.def_blocked_return_tds+1; DB has {...}' };
        expect(matchFinding(phi, f, 2025, 3)).toBe(true);
        expect(matchFinding(phi, { ...f, explanation: 'Expected DEF_LAR.def_int_return_tds+1' }, 2025, 3)).toBe(false);
    });

    test('matches an incomplete-boxscore finding by game + name when the entry names no column', () => {
        const f = { bugClassRef: 'B8', entity: { type: 'game', id: '20251123_PHI@DAL', gameId: '20251123_PHI@DAL' }, explanation: '1 ESPN scoring play(s) have no Tank01 counterpart in 20251123_PHI@DAL: Brandon Aubrey 42 Yd Field Goal' };
        expect(matchFinding(boxPhiDal, f, 2025, 12)).toBe(true);
    });

    test('matches the direct consequence on the affected owner\'s matchup total', () => {
        const f = { bugClassRef: 'S2', entity: { type: 'matchup', id: '9', owner: 'Joe' }, explanation: "Joe's stored score 119.5 differs from the ESPN-derived best lineup 127.5." };
        expect(matchFinding(phi, f, 2025, 3)).toBe(true);
        expect(matchFinding(phi, { ...f, entity: { ...f.entity, owner: 'Sean' } }, 2025, 3)).toBe(false);
        expect(matchFinding(phi, { ...f, bugClassRef: 'A1' }, 2025, 3)).toBe(false);
    });
});
