/**
 * Team code normalization utility
 * Ensures consistent team codes across the application
 *
 * Tank01 API returns "WSH" for Washington, but we use "WAS" internally.
 * All mapping logic lives in utils/teamMappings.js (the single source of
 * truth) - this module is a thin wrapper kept for its established API.
 */

const { getTeamAbbreviation } = require('./teamMappings');

// Kept for backward compatibility with existing imports
const TEAM_CODE_MAPPINGS = {
    'WSH': 'WAS'  // Washington: WSH -> WAS
};

/**
 * Normalize a single team identifier (code, alt code, nickname, city name)
 * to the canonical team code.
 * @param {string} teamCode - The team code to normalize
 * @returns {string} - The normalized team code
 */
function normalizeTeamCode(teamCode) {
    if (!teamCode) return teamCode;
    return getTeamAbbreviation(teamCode);
}

/**
 * Normalize team codes in a game object
 * @param {Object} game - Game object with home/away team codes
 * @returns {Object} - Game object with normalized team codes
 */
function normalizeGameTeams(game) {
    if (!game) return game;

    return {
        ...game,
        home: normalizeTeamCode(game.home),
        away: normalizeTeamCode(game.away),
        home_team: normalizeTeamCode(game.home_team),
        away_team: normalizeTeamCode(game.away_team),
        teamIDHome: game.teamIDHome,  // Keep team IDs as-is
        teamIDAway: game.teamIDAway
    };
}

/**
 * Get the defense player ID for a team
 * @param {string} teamCode - The team code (will be normalized)
 * @returns {string} - The defense player ID (e.g., "DEF_WAS")
 */
function getDefensePlayerId(teamCode) {
    const normalized = normalizeTeamCode(teamCode);
    return normalized ? `DEF_${normalized}` : null;
}

module.exports = {
    normalizeTeamCode,
    normalizeGameTeams,
    getDefensePlayerId,
    TEAM_CODE_MAPPINGS
};
