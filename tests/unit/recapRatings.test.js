const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../../server/utils/recapRatings');
const { buildPrompt, parseReply } = require('../../scripts/recap-rate');

describe('recapRatings', () => {
    let root;
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ratings-')); });
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    test('normaliseStars clamps to 1-5 in half steps', () => {
        expect(R.normaliseStars(4.4)).toBe(4.5);
        expect(R.normaliseStars(4.2)).toBe(4);
        expect(R.normaliseStars(9)).toBe(5);
        expect(R.normaliseStars(0)).toBe(1);
        expect(R.normaliseStars('x')).toBeNull();
    });

    test('normaliseRatings keeps only known slugs and never recommends a fact-check failure', () => {
        const raw = { recommended: 'yoda', ratings: [
            { slug: 'yoda', stars: 5, blurb: 'great' },
            { slug: 'bob-ross', stars: 4.5, blurb: 'fine' },
            { slug: 'bob-ross', stars: 1 },
            { slug: 'nobody', stars: 5 },
            { slug: '../x', stars: 5 },
            { slug: 'larry-david', stars: 'lots' }
        ] };
        const doc = R.normaliseRatings(raw, { season: 2026, week: 1, slugs: ['yoda', 'bob-ross', 'larry-david'], failed: ['yoda'], ratedBy: 't' });
        expect(Object.keys(doc.ratings).sort()).toEqual(['bob-ross', 'yoda']);
        expect(doc.ratings['bob-ross']).toEqual({ stars: 4.5, blurb: 'fine' });
        expect(doc.recommended).toBe('bob-ross');
        expect(doc.ratedBy).toBe('t');
    });

    test('normaliseRatings honours a valid recommendation and falls back to the best when missing', () => {
        const slugs = ['a', 'b'];
        expect(R.normaliseRatings({ recommended: 'b', ratings: [{ slug: 'a', stars: 5 }, { slug: 'b', stars: 3 }] }, { season: 2026, week: 1, slugs }).recommended).toBe('b');
        expect(R.normaliseRatings({ ratings: [{ slug: 'a', stars: 3 }, { slug: 'b', stars: 4 }] }, { season: 2026, week: 1, slugs }).recommended).toBe('b');
        expect(R.normaliseRatings({ ratings: [] }, { season: 2026, week: 1, slugs }).recommended).toBeNull();
    });

    test('write/read round-trip and ratingFor', () => {
        const doc = R.normaliseRatings({ recommended: 'a', ratings: [{ slug: 'a', stars: 4, blurb: 'x' }] }, { season: 2026, week: 3, slugs: ['a'] });
        const file = R.writeRatings(doc, root);
        expect(file).toBe(path.join(root, '2026', 'data', 'week03-ratings.json'));
        const back = R.readRatings(2026, 3, root);
        expect(back.recommended).toBe('a');
        expect(R.ratingFor(back, 'a')).toEqual({ stars: 4, blurb: 'x', recommended: true });
        expect(R.ratingFor(back, 'zzz')).toBeNull();
        expect(R.ratingFor(null, 'a')).toBeNull();
        expect(R.readRatings(2026, 4, root)).toBeNull();
    });

    test('the rating prompt names every recap, the failed ones, and the reply parser tolerates prose', () => {
        const p = buildPrompt(2026, 1, [{ slug: 'a', name: 'A', markdown: '# A\nhi' }, { slug: 'b', name: 'B', markdown: '# B\nyo' }], ['b']);
        expect(p).toMatch(/===== RECAP slug: a \(A\) =====/);
        expect(p).toMatch(/===== RECAP slug: b \(B\) =====/);
        expect(p).toMatch(/FAILED the fact-check and must not be recommended.*: b\./);
        expect(p).toMatch(/Storytelling/);
        expect(parseReply({ result: 'Sure:\n{"recommended":"a","ratings":[{"slug":"a","stars":4}]}' })).toEqual({ recommended: 'a', ratings: [{ slug: 'a', stars: 4 }] });
        expect(() => parseReply({ result: 'nope' })).toThrow(/no JSON object/);
    });
});
