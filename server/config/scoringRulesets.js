/**
 * Season-gated scoring-logic fixes.
 *
 * 2024 and 2025 are complete, blessed seasons (CLAUDE.md): their official
 * record must not change, and the nightly golden-record regression
 * recalculates both from cache with the CURRENT code. So every parser or
 * scorer fix that would alter a historical result is gated here by the first
 * season it applies to. Old seasons keep the behaviour they were blessed with;
 * the known errors that behaviour produced are documented in
 * docs/DEFENSIVE_SCORING.md ("2025 known-unfixed errors").
 *
 * Callers pass the season they are scoring; an unknown/undefined season gets
 * the legacy rules so a forgotten argument can never rewrite history.
 */

const RULE_FIRST_SEASON = Object.freeze({
    // "Blocked Kick Recovered by X" / "Blocked punt recovered by X in end zone"
    // are defensive TDs even without the word "return" (PHI wk3 2025, DAL wk9 2025).
    blockedKickRecovery: 2026,
    // A kickoff recovered by the kicking team in the end zone is a special-teams
    // takeaway -> Team Defense TD (SEA wk2 2025, Holani).
    kickoffRecoveryTakeaway: 2026,
    // When the scoring plays were parsed, their safety count is the answer even
    // when it is 0; never fall back to Tank01's DST.safeties field (SEA wk7 2025).
    parsedSafetiesAuthoritative: 2026,
    // Credit 2-pt conversions from the scoring-play text when Tank01's per-player
    // two-point fields are missing (Daniels -> McCaffrey wk2 2025).
    twoPointFromPlayText: 2026,
    // A receiver recovering his own fumble after a completed pass is not a takeaway.
    sameReceiverFumbleRecovery: 2026
});

function rulesFor(season) {
    const y = Number(season);
    const rules = {};
    for (const [rule, first] of Object.entries(RULE_FIRST_SEASON)) {
        rules[rule] = Number.isFinite(y) && y >= first;
    }
    return rules;
}

const LEGACY_RULES = Object.freeze(rulesFor(undefined));

module.exports = { RULE_FIRST_SEASON, rulesFor, LEGACY_RULES };
