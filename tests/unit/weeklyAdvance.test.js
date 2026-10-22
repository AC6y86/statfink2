const { decide } = require('../../scripts/weekly-advance');

const settings = { season_year: 2026, current_week: 1 };
const pass = { season: 2026, week: 1, overallStatus: 'PASS', runAt: '2026-09-15T13:00:00Z' };

describe('weekly-advance decide()', () => {
    test('advances on a PASS validation of the current week', () => {
        expect(decide({ settings, validation: pass, hold: null })).toEqual({ action: 'advance', forced: false });
    });
    test('holds when the validation is for another week', () => {
        const d = decide({ settings, validation: { ...pass, week: 18, season: 2025 }, hold: null });
        expect(d.action).toBe('skip');
        expect(d.status).toBe('warning');
        expect(d.summary).toMatch(/No validation of 2026 week 1/);
    });
    test('holds on WARN and FAIL', () => {
        for (const s of ['WARN', 'FAIL']) {
            const d = decide({ settings, validation: { ...pass, overallStatus: s }, hold: null });
            expect(d.action).toBe('skip');
            expect(d.status).toBe('warning');
        }
    });
    test('a hold file wins over everything except the final week', () => {
        const d = decide({ settings, validation: pass, hold: { reason: 'checking DEF_SEA' }, force: true });
        expect(d.action).toBe('skip');
        expect(d.summary).toMatch(/checking DEF_SEA/);
    });
    test('--force advances despite a missing or failed validation', () => {
        expect(decide({ settings, validation: null, hold: null, force: true })).toEqual({ action: 'advance', forced: true });
    });
    test('an incomplete week is ok (nothing to do), a complete one proceeds to the validation gate', () => {
        expect(decide({ settings, validation: null, hold: null, completion: { total: 16, finals: 15, complete: false } })).toMatchObject({ action: 'skip', status: 'ok' });
        expect(decide({ settings, validation: pass, hold: null, completion: { total: 16, finals: 16, complete: true } })).toEqual({ action: 'advance', forced: false });
        expect(decide({ settings, validation: null, hold: null, completion: { total: 16, finals: 16, complete: true } })).toMatchObject({ action: 'skip', status: 'warning' });
    });
    test('week 18 has nothing to advance to', () => {
        const d = decide({ settings: { season_year: 2026, current_week: 18 }, validation: pass, hold: null });
        expect(d).toMatchObject({ action: 'skip', status: 'ok' });
    });
});
