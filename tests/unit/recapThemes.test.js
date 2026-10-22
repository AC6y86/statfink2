const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('../../server/utils/recapThemes');
const { parseThemes, buildPrompt } = require('../../scripts/recap-setup');

describe('recapThemes', () => {
    let root;
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'themes-')); });
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    test('slugify matches the recap filename slug rules', () => {
        expect(T.slugify("Morgan Freeman's narration!")).toBe('morgan-freemans-narration');
        expect(T.slugify('  1920s   Radio  ')).toBe('1920s-radio');
    });
    test('add / remove / round-trip through the themes file', () => {
        const doc = { season: 2026, week: 3, proposedAt: null, proposedBy: 'manual', generatedAt: null, themes: [] };
        const t = T.addTheme(doc, { name: 'Courtroom drama', description: 'objection!' });
        expect(t).toMatchObject({ slug: 'courtroom-drama', origin: 'commissioner' });
        expect(() => T.addTheme(doc, { name: 'courtroom  drama' })).toThrow(/already/);
        expect(() => T.addTheme(doc, { name: 'x' })).toThrow(/3-80/);
        T.writeThemes(doc, root);
        expect(T.readThemes(2026, 3, root).themes).toHaveLength(1);
        expect(T.listThemeWeeks(2026, root).map(d => d.week)).toEqual([3]);
        expect(T.slugsProposedThisSeason(2026, root)).toEqual(['courtroom-drama']);
        T.removeTheme(doc, 'courtroom-drama');
        expect(() => T.removeTheme(doc, 'courtroom-drama')).toThrow(/No theme/);
        expect(doc.themes).toHaveLength(0);
    });
    test('parseThemes keeps valid, unique, non-excluded suggestions', () => {
        const envelope = { result: 'Here you go:\n[{"name":"WWE announcer","slug":"wwe-announcer"},{"name":"Bob Ross","slug":"bob-ross","description":"happy little touchdowns"},{"name":"Bob Ross","slug":"bob-ross"},{"name":"x"}]' };
        const out = parseThemes(envelope, ['wwe-announcer']);
        expect(out.map(t => t.slug)).toEqual(['bob-ross']);
        expect(out[0]).toMatchObject({ origin: 'suggested', description: 'happy little touchdowns' });
        expect(() => parseThemes({ result: 'no json' }, [])).toThrow(/no JSON array/);
    });
    test('the prompt carries the exclusion list and count', () => {
        const p = buildPrompt(2026, 12, ['pirate', 'wwe'], 7);
        expect(p).toMatch(/Propose 7 /);
        expect(p).toMatch(/- pirate\n- wwe/);
        expect(p).toMatch(/Thanksgiving/);
        expect(p).toMatch(/PARTICULAR PERSON/);
        expect(p).toMatch(/do NOT propose formats/);
    });
});
