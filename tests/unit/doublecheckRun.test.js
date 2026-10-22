const { pickTargetWeek, weekSignature, summaryLines } = require('../../scripts/lib/doublecheckRun');

describe('doublecheckRun helpers', () => {
    const games = [
        { game_id: 'a', week: 1, status: 'Final', home_score: 24, away_score: 21 },
        { game_id: 'b', week: 1, status: 'Final/OT', home_score: 23, away_score: 20 },
        { game_id: 'c', week: 2, status: 'Final', home_score: 10, away_score: 7 },
        { game_id: 'd', week: 2, status: 'Scheduled', home_score: 0, away_score: 0 },
        { game_id: 'e', week: 3, status: 'Scheduled', home_score: 0, away_score: 0 }
    ];

    test('pickTargetWeek: most recent week with a final game, never beyond current_week', () => {
        expect(pickTargetWeek(games, 3)).toBe(2);
        expect(pickTargetWeek(games, 1)).toBe(1);
        expect(pickTargetWeek(games.filter(g => g.status === 'Scheduled'), 3)).toBeNull();
        expect(pickTargetWeek([], 1)).toBeNull();
    });

    test('weekSignature changes when a game goes final, a score moves, or standings appear', () => {
        const s1 = weekSignature(games, 2, 0);
        expect(weekSignature(games, 2, 0)).toBe(s1);
        expect(weekSignature(games.map(g => (g.game_id === 'd' ? { ...g, status: 'Final' } : g)), 2, 0)).not.toBe(s1);
        expect(weekSignature(games.map(g => (g.game_id === 'c' ? { ...g, home_score: 13 } : g)), 2, 0)).not.toBe(s1);
        expect(weekSignature(games, 2, 12)).not.toBe(s1);
        expect(weekSignature(games, 1, 0)).not.toBe(s1);
    });

    test('summaryLines leads with status, flips first, then FAIL and WARN', () => {
        const lines = summaryLines({ overallStatus: 'FAIL', season: 2026, week: 1, counts: { FAIL: 1, WARN: 1, DEFER: 0, INFO: 2, flips: 1 },
            completeness: { gamesFinal: 16, gamesTotal: 16, standingsPresent: true, deferred: [] },
            findings: [{ severity: 'FAIL', bugClassRef: 'A1', flipsResult: true, explanation: 'flip!' }, { severity: 'WARN', bugClassRef: 'E3', explanation: 'ir' }],
            reportFile: '/r.md' });
        expect(lines[0]).toMatch(/^FAIL — 2026 week 1/);
        expect(lines.indexOf('RESULT FLIPS:')).toBeGreaterThan(0);
        expect(lines.indexOf('RESULT FLIPS:')).toBeLessThan(lines.indexOf('WARN (1):'));
        expect(lines[lines.length - 1]).toBe('Report: /r.md');
        expect(summaryLines(null)).toEqual(['Double check did not run.']);
    });
});
