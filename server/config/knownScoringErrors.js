/**
 * Known, accepted scoring errors in blessed seasons (see knownScoringErrors.json).
 *
 *   knownErrorsFor(season, week) -> entries for that week
 *   matchFinding(entry, finding, season, week) -> true when a Double Check
 *       finding describes this known error (or its direct consequence on the
 *       affected owner's matchup total)
 */
const REGISTRY = require('./knownScoringErrors.json');

const ENTRIES = Object.freeze((REGISTRY.entries || []).map(e => Object.freeze({ ...e })));

function knownErrorsFor(season, week) {
    const s = Number(season), w = Number(week);
    return ENTRIES.filter(e => e.season === s && (week === undefined || e.week === w));
}

function textOf(finding) {
    return `${finding.explanation || ''} ${JSON.stringify(finding.expected || {})} ${JSON.stringify(finding.internal || {})}`;
}

function matchFinding(entry, finding, season, week) {
    if (!entry || !finding) return false;
    if (entry.season !== Number(season) || entry.week !== Number(week)) return false;
    if (entry.status && entry.status !== 'accepted') return false;
    const e = finding.entity || {};
    const text = textOf(finding);

    const nameHit = entry.name && text.includes(entry.name);
    const idHit = entry.player_id && (String(e.id) === String(entry.player_id) || text.includes(entry.player_id));
    const gameHit = entry.game_id && (e.gameId === entry.game_id || String(e.id) === entry.game_id || String(e.id).startsWith(`${entry.game_id}#`));

    // The error itself: same player (by id or name within the same game), same column if one is named
    if (idHit || (gameHit && nameHit)) {
        return !entry.column || text.includes(entry.column);
    }
    // Direct consequence: the affected owner's matchup total differs from ESPN truth
    if (entry.owner && e.type === 'matchup' && finding.bugClassRef === 'S2' && e.owner === entry.owner) return true;
    return false;
}

module.exports = { ENTRIES, knownErrorsFor, matchFinding };
