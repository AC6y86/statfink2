const { selectLineup, compareLineups, slotType } = require('../../scripts/lib/doublecheckLineup');

const mk = (id, position, points, extra = {}) => ({ player_id: id, position, points, roster_position: 'active', ...extra });

describe('doublecheckLineup.selectLineup', () => {
    test('fills 1 QB, 4 RB, 4 WR/TE, 1 K, 1 BONUS, 2 DST by the documented rule', () => {
        const roster = [
            mk('qb1', 'QB', 20), mk('qb2', 'QB', 25),
            mk('rb1', 'RB', 10), mk('rb2', 'RB', 9), mk('rb3', 'RB', 8), mk('rb4', 'RB', 3), mk('rb5', 'RB', 30),
            mk('wr1', 'WR', 12), mk('wr2', 'WR', 6), mk('te1', 'TE', 9), mk('te2', 'TE', 0), mk('wr3', 'WR', 15), mk('wr4', 'WR', 14),
            mk('k1', 'K', 7.5), mk('k2', 'K', 8),
            mk('d1', 'DST', 8, { points_allowed: 20, yards_allowed: 250 }),
            mk('d2', 'DST', 0, { points_allowed: 10, yards_allowed: 300 }),
            mk('ir', 'RB', 40, { roster_position: 'injured_reserve' }),
            mk('bench0', 'WR', 0)
        ];
        const out = selectLineup(roster);
        const ids = out.selected.map(s => s.player_id);
        expect(ids).toContain('qb2'); expect(ids).not.toContain('ir');
        expect(out.slotCounts).toEqual({ QB: 1, RB: 4, WR_TE: 4, K: 1, BONUS: 1, DST: 2 });
        // best remaining offensive player is qb1 (20) -> BONUS
        expect(out.selected.find(s => s.slot === 'BONUS').player_id).toBe('qb1');
        expect(out.selected.find(s => s.slot === 'DST_PA').player_id).toBe('d2');
        expect(out.selected.find(s => s.slot === 'DST_YA').player_id).toBe('d1');
        expect(out.total).toBe(25 + 30 + 10 + 9 + 8 + 15 + 14 + 12 + 9 + 8 + 20 + 8 + 0);
        expect(ids).not.toContain('te2');
    });

    test('zero-point players are never selected and DSTs without stats are ineligible', () => {
        const out = selectLineup([mk('qb', 'QB', 0), mk('rb', 'RB', 3), mk('d', 'DST', 0, { points_allowed: null })]);
        expect(out.selected.map(s => s.player_id)).toEqual(['rb']);
        expect(out.total).toBe(3);
    });

    test('a single eligible DST takes DST_PA only', () => {
        const out = selectLineup([mk('d', 'DST', 5, { points_allowed: 3, yards_allowed: 100 })]);
        expect(out.selected.map(s => s.slot)).toEqual(['DST_PA']);
    });

    test('FB counts as RB; unknown positions are ignored', () => {
        expect(slotType('FB')).toBe('RB');
        expect(slotType('CB')).toBeNull();
    });
});

describe('doublecheckLineup.compareLineups', () => {
    test('reports totals and set differences', () => {
        const ind = selectLineup([mk('a', 'QB', 10), mk('b', 'RB', 5)]);
        const stored = [{ player_id: 'a', is_scoring: 1, points: 10 }, { player_id: 'c', is_scoring: 1, points: 5 }, { player_id: 'b', is_scoring: 0, points: 5 }];
        const cmp = compareLineups(stored, ind);
        expect(cmp.totalsMatch).toBe(true);
        expect(cmp.setsMatch).toBe(false);
        expect(cmp.onlyStored).toEqual(['c']);
        expect(cmp.onlyIndependent).toEqual(['b']);
    });
});
