'use strict';

/**
 * A partial touchdown ledger must not replace an official individual boxscore.
 * Ambiguous plays remain visible in T1/B4 and go through rulings/reconciliation.
 * DST TDs have no equivalent ESPN boxscore fields, so their dossier remains
 * the source. A complete ledger still handles PFL-specific recovery awards.
 */
function applyDossierTotals(row, expected, { isDst = false, dossier = null } = {}) {
    if (!expected) return row;
    const incomplete = !dossier || Boolean(dossier.error) || (dossier.plays || [])
        .some(p => p.awardClass === 'AMBIGUOUS' || p.votesAgree === false);
    if (!isDst && incomplete) return row;
    return { ...row, ...expected };
}

module.exports = { applyDossierTotals };
