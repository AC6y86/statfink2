'use strict';

/**
 * Independent re-implementation of the official scoring-lineup selection
 * (mirrors the rule in docs/SCORING_SYSTEM.md; does NOT import
 * scoringPlayersService).
 *
 * Input: array of roster entries for ONE fantasy team and week:
 *   { player_id, position, roster_position, points, points_allowed, yards_allowed }
 * Output: { selected: [{player_id, slot, points}], total, slotCounts }
 *
 * Rules: only roster_position === 'active'; offensive slots filled greedily by
 * points desc (1 QB, 4 RB, 4 WR/TE, 1 K), then 1 BONUS = best remaining
 * offensive player; players with 0/NULL points are never selected; DST_PA =
 * rostered active DST with the lowest points_allowed, DST_YA = lowest
 * yards_allowed not already chosen (falls back to the same DST if it is the
 * only one with stats). DSTs with NULL points_allowed (bye / no row) are
 * ineligible.
 */

const LIMITS = { QB: 1, RB: 4, WR_TE: 4, K: 1, BONUS: 1, DST: 2 };

function slotType(position) {
    if (position === 'QB') return 'QB';
    if (position === 'RB' || position === 'FB') return 'RB';
    if (position === 'WR' || position === 'TE') return 'WR_TE';
    if (position === 'K') return 'K';
    if (position === 'DST' || position === 'DEF') return 'DST';
    return null;
}

function num(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }

function selectLineup(roster) {
    const active = roster.filter(r => r.roster_position === 'active');
    const selected = [];
    const used = new Set();
    const counts = { QB: 0, RB: 0, WR_TE: 0, K: 0, BONUS: 0, DST: 0 };

    const offense = active
        .filter(r => slotType(r.position) && slotType(r.position) !== 'DST')
        .map(r => ({ ...r, points: num(r.points) }))
        .filter(r => r.points > 0)
        .sort((a, b) => b.points - a.points || String(a.player_id).localeCompare(String(b.player_id)));

    for (const p of offense) {
        const t = slotType(p.position);
        if (counts[t] < LIMITS[t]) {
            counts[t]++;
            used.add(p.player_id);
            selected.push({ player_id: p.player_id, slot: t === 'WR_TE' ? `WR/TE${counts[t]}` : (t === 'RB' ? `RB${counts[t]}` : t), points: p.points, position: p.position });
        }
    }
    for (const p of offense) {
        if (used.has(p.player_id)) continue;
        if (counts.BONUS < LIMITS.BONUS) {
            counts.BONUS++;
            used.add(p.player_id);
            selected.push({ player_id: p.player_id, slot: 'BONUS', points: p.points, position: p.position });
            break;
        }
    }

    const dsts = active
        .filter(r => slotType(r.position) === 'DST' && r.points_allowed !== null && r.points_allowed !== undefined)
        .map(r => ({ ...r, points: num(r.points) }));
    const byPa = [...dsts].sort((a, b) => num(a.points_allowed) - num(b.points_allowed) || num(a.yards_allowed) - num(b.yards_allowed));
    const byYa = [...dsts].sort((a, b) => num(a.yards_allowed) - num(b.yards_allowed) || num(a.points_allowed) - num(b.points_allowed));
    if (byPa.length) {
        const pa = byPa[0];
        counts.DST++;
        used.add(pa.player_id);
        selected.push({ player_id: pa.player_id, slot: 'DST_PA', points: pa.points, position: 'DST' });
        const ya = byYa.find(d => !used.has(d.player_id)) || null;
        if (ya) {
            counts.DST++;
            used.add(ya.player_id);
            selected.push({ player_id: ya.player_id, slot: 'DST_YA', points: ya.points, position: 'DST' });
        }
    }

    const total = Math.round(selected.reduce((s, p) => s + p.points, 0) * 100) / 100;
    return { selected, total, slotCounts: counts };
}

/** Compare a stored lineup (rows with is_scoring/scoring_slot/points) to an independent one. */
function compareLineups(storedRows, independent) {
    const stored = storedRows.filter(r => Number(r.is_scoring) === 1);
    const storedTotal = Math.round(stored.reduce((s, r) => s + num(r.points), 0) * 100) / 100;
    const storedIds = new Set(stored.map(r => String(r.player_id)));
    const indIds = new Set(independent.selected.map(r => String(r.player_id)));
    const onlyStored = [...storedIds].filter(id => !indIds.has(id));
    const onlyIndependent = [...indIds].filter(id => !storedIds.has(id));
    // Ties: two players with equal points may legitimately swap (selection is DB-order on ties)
    const ptsOf = (ids, rows) => ids.map(id => num((rows.find(r => String(r.player_id) === id) || {}).points)).sort((a, b) => a - b).join(',');
    const tieEquivalent = onlyStored.length === onlyIndependent.length && onlyStored.length > 0
        && ptsOf(onlyStored, stored) === ptsOf(onlyIndependent, independent.selected)
        && Math.abs(storedTotal - independent.total) < 0.005;
    return {
        tieEquivalent,
        storedTotal,
        independentTotal: independent.total,
        totalsMatch: Math.abs(storedTotal - independent.total) < 0.005,
        setsMatch: onlyStored.length === 0 && onlyIndependent.length === 0,
        onlyStored,
        onlyIndependent
    };
}

module.exports = { LIMITS, slotType, selectLineup, compareLineups };
