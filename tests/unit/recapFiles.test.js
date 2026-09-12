const {
    parseRecapFilename,
    filenamesToSlugs,
    isValidSlug,
    isValidSeason,
    isValidWeek,
    weekPad,
    recapFilename,
    slugToDisplayName,
    parseFactcheckReport
} = require('../../server/utils/recapFiles');

describe('recapFiles', () => {
    describe('parseRecapFilename', () => {
        it('parses a standard recap filename', () => {
            expect(parseRecapFilename('2025-week05-1920s-radio-style.md')).toEqual({
                season: 2025, week: 5, slug: '1920s-radio'
            });
        });

        it('parses multi-hyphen slugs', () => {
            expect(parseRecapFilename('2025-week12-david-attenborough-nature-documentary-style.md'))
                .toEqual({ season: 2025, week: 12, slug: 'david-attenborough-nature-documentary' });
        });

        it('rejects non-week files', () => {
            expect(parseRecapFilename('2025-full-season-30-for-30.md')).toBeNull();
            expect(parseRecapFilename('INDEX.md')).toBeNull();
            expect(parseRecapFilename('styles-ledger.md')).toBeNull();
            expect(parseRecapFilename('storylines.md')).toBeNull();
            expect(parseRecapFilename('week12-digest.md')).toBeNull();
        });

        it('rejects unpadded weeks and missing -style suffix', () => {
            expect(parseRecapFilename('2025-week5-wwe-style.md')).toBeNull();
            expect(parseRecapFilename('2025-week05-wwe.md')).toBeNull();
        });
    });

    describe('filenamesToSlugs', () => {
        it('dedupes across seasons and weeks, sorts, and ignores non-recaps', () => {
            expect(filenamesToSlugs([
                '2025-week05-wwe-style.md',
                '2025-week06-shakespeare-style.md',
                '2026-week01-wwe-style.md',
                '2025-full-season-30-for-30.md',
                'INDEX.md'
            ])).toEqual(['shakespeare', 'wwe']);
        });
    });

    describe('validators', () => {
        it('accepts safe slugs and rejects traversal attempts', () => {
            expect(isValidSlug('film-noir')).toBe(true);
            expect(isValidSlug('1920s-radio')).toBe(true);
            expect(isValidSlug('../etc/passwd')).toBe(false);
            expect(isValidSlug('foo.md')).toBe(false);
            expect(isValidSlug('foo/bar')).toBe(false);
            expect(isValidSlug('foo%2f')).toBe(false);
            expect(isValidSlug('')).toBe(false);
            expect(isValidSlug('a'.repeat(81))).toBe(false);
        });

        it('validates seasons and weeks', () => {
            expect(isValidSeason('2025')).toBe(true);
            expect(isValidSeason('202')).toBe(false);
            expect(isValidSeason('../..')).toBe(false);
            expect(isValidWeek('1')).toBe(true);
            expect(isValidWeek('18')).toBe(true);
            expect(isValidWeek('0')).toBe(false);
            expect(isValidWeek('23')).toBe(false);
            expect(isValidWeek('abc')).toBe(false);
        });
    });

    describe('filename building and display', () => {
        it('round-trips through recapFilename', () => {
            const name = recapFilename(2026, 3, 'film-noir');
            expect(name).toBe('2026-week03-film-noir-style.md');
            expect(parseRecapFilename(name)).toEqual({ season: 2026, week: 3, slug: 'film-noir' });
        });

        it('pads weeks and title-cases slugs', () => {
            expect(weekPad(3)).toBe('03');
            expect(weekPad(12)).toBe('12');
            expect(slugToDisplayName('david-attenborough-nature-documentary'))
                .toBe('David Attenborough Nature Documentary');
        });
    });

    describe('parseFactcheckReport', () => {
        const report = [
            '# Fact-Check Report: 2025 Week 15',
            '',
            '## 2025-week15-film-noir-style.md: PASS',
            'All claims verified.',
            '',
            '## 2025-week15-wwe-announcer-style.md: FAIL',
            '| Claim | Digest | Recap |',
            '',
            '## Summary',
            '- 2025-week15-film-noir-style.md: PASS (0 critical, 1 minor)',
            '- 2025-week15-wwe-announcer-style.md: FAIL (2 critical, 0 minor)'
        ].join('\n');

        it('extracts per-slug verdicts with counts from the summary', () => {
            expect(parseFactcheckReport(report)).toEqual({
                'film-noir': { verdict: 'PASS', critical: 0, minor: 1 },
                'wwe-announcer': { verdict: 'FAIL', critical: 2, minor: 0 }
            });
        });

        it('handles bold markdown around filenames and verdicts', () => {
            expect(parseFactcheckReport('**2025-week15-pirate-style.md**: **PASS**')).toEqual({
                pirate: { verdict: 'PASS', critical: null, minor: null }
            });
        });

        it('returns empty object for reports with no verdict lines', () => {
            expect(parseFactcheckReport('nothing to see here')).toEqual({});
        });
    });
});
