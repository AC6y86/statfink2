/**
 * NFL team-code canonicalization - THE single source of truth.
 *
 * Canonical codes are the 32 entries in CANONICAL_TEAM_CODES (Washington is
 * WAS; Tank01's WSH is an alias). Every consumer (teamNormalization,
 * playerSyncService, healthCheckService, roster writers) must derive from
 * this module - the WSH/nickname drift bug has been fixed three times because
 * independent maps disagreed. Guarded by tests/unit/teamCodeCanonical.test.js.
 */

// Canonical code -> { nickname, city } (city as used by external feeds)
const TEAMS = {
    ARI: { nickname: 'Cardinals', city: 'Arizona' },
    ATL: { nickname: 'Falcons', city: 'Atlanta' },
    BAL: { nickname: 'Ravens', city: 'Baltimore' },
    BUF: { nickname: 'Bills', city: 'Buffalo' },
    CAR: { nickname: 'Panthers', city: 'Carolina' },
    CHI: { nickname: 'Bears', city: 'Chicago' },
    CIN: { nickname: 'Bengals', city: 'Cincinnati' },
    CLE: { nickname: 'Browns', city: 'Cleveland' },
    DAL: { nickname: 'Cowboys', city: 'Dallas' },
    DEN: { nickname: 'Broncos', city: 'Denver' },
    DET: { nickname: 'Lions', city: 'Detroit' },
    GB: { nickname: 'Packers', city: 'Green Bay' },
    HOU: { nickname: 'Texans', city: 'Houston' },
    IND: { nickname: 'Colts', city: 'Indianapolis' },
    JAX: { nickname: 'Jaguars', city: 'Jacksonville' },
    KC: { nickname: 'Chiefs', city: 'Kansas City' },
    LAC: { nickname: 'Chargers', city: 'LA Chargers' },
    LAR: { nickname: 'Rams', city: 'LA Rams' },
    LV: { nickname: 'Raiders', city: 'Las Vegas' },
    MIA: { nickname: 'Dolphins', city: 'Miami' },
    MIN: { nickname: 'Vikings', city: 'Minnesota' },
    NE: { nickname: 'Patriots', city: 'New England' },
    NO: { nickname: 'Saints', city: 'New Orleans' },
    NYG: { nickname: 'Giants', city: 'NY Giants' },
    NYJ: { nickname: 'Jets', city: 'NY Jets' },
    PHI: { nickname: 'Eagles', city: 'Philadelphia' },
    PIT: { nickname: 'Steelers', city: 'Pittsburgh' },
    SEA: { nickname: 'Seahawks', city: 'Seattle' },
    SF: { nickname: '49ers', city: 'San Francisco' },
    TB: { nickname: 'Buccaneers', city: 'Tampa Bay' },
    TEN: { nickname: 'Titans', city: 'Tennessee' },
    WAS: { nickname: 'Commanders', city: 'Washington' }
};

// Alternate codes used by external sources (Tank01, ESPN, older feeds)
const ALT_CODES = {
    WSH: 'WAS',
    GNB: 'GB',
    KAN: 'KC',
    JAC: 'JAX'
};

const CANONICAL_TEAM_CODES = new Set(Object.keys(TEAMS));

// Case-insensitive lookup: canonical codes, alt codes, nicknames, city names,
// and special cases all map to a canonical code.
const lookup = {};
for (const [code, { nickname, city }] of Object.entries(TEAMS)) {
    lookup[code.toLowerCase()] = code;
    lookup[nickname.toLowerCase()] = code;
    lookup[city.toLowerCase()] = code;
}
for (const [alt, code] of Object.entries(ALT_CODES)) {
    lookup[alt.toLowerCase()] = code;
}
lookup['def'] = 'DEF';
lookup['defense'] = 'DEF';

// Legacy export shape (exact-key map) kept for existing require sites
const teamAbbreviations = {};
for (const [code, { nickname }] of Object.entries(TEAMS)) {
    teamAbbreviations[code] = code;
    teamAbbreviations[nickname] = code;
}
for (const [alt, code] of Object.entries(ALT_CODES)) {
    teamAbbreviations[alt] = code;
}
teamAbbreviations['DEF'] = 'DEF';
teamAbbreviations['Defense'] = 'DEF';

/**
 * Convert any team identifier (canonical code, alt code, nickname, city name,
 * any casing) to the canonical abbreviation.
 * @param {string} teamName
 * @returns {string} Canonical team code, or best-effort cleanup for unknowns
 */
function getTeamAbbreviation(teamName) {
    if (!teamName) return '';

    const mapped = lookup[String(teamName).trim().toLowerCase()];
    if (mapped) return mapped;

    // Unknown input: keep old behavior (uppercase passthrough for
    // abbreviation-shaped strings, warn otherwise)
    const cleaned = String(teamName).trim().toUpperCase();
    if (/^[A-Z]{2,3}$/.test(cleaned)) {
        return cleaned;
    }
    console.warn(`Unknown team name: ${teamName}`);
    return cleaned.substring(0, 3);
}

/**
 * True if the code is one of the 32 canonical NFL team codes.
 */
function isCanonicalTeamCode(code) {
    return CANONICAL_TEAM_CODES.has(code);
}

module.exports = {
    teamAbbreviations,
    getTeamAbbreviation,
    isCanonicalTeamCode,
    CANONICAL_TEAM_CODES
};
