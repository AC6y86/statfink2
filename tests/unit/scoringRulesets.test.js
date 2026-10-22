const { rulesFor, RULE_FIRST_SEASON, LEGACY_RULES } = require('../../server/config/scoringRulesets');

describe('scoringRulesets (season-gated fixes)', () => {
    const RULES = ['blockedKickRecovery', 'kickoffRecoveryTakeaway', 'parsedSafetiesAuthoritative', 'twoPointFromPlayText'];

    test('every rule starts in 2026 — blessed 2024/2025 must not change', () => {
        for (const r of RULES) expect(RULE_FIRST_SEASON[r]).toBe(2026);
    });

    test('2024 and 2025 get the legacy behaviour', () => {
        for (const season of [2024, 2025, '2025']) {
            const rules = rulesFor(season);
            for (const r of RULES) expect(rules[r]).toBe(false);
        }
    });

    test('2026 and later get the fixes', () => {
        for (const season of [2026, '2026', 2027]) {
            const rules = rulesFor(season);
            for (const r of RULES) expect(rules[r]).toBe(true);
        }
    });

    test('an omitted or unparseable season is legacy (a forgotten argument can never rewrite history)', () => {
        for (const season of [undefined, null, '', 'abc', NaN]) {
            const rules = rulesFor(season);
            for (const r of RULES) expect(rules[r]).toBe(false);
        }
        expect(LEGACY_RULES).toEqual(rulesFor(undefined));
    });
});
