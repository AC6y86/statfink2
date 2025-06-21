// NFL Team name to abbreviation mappings
const teamAbbreviations = {
    // Full names to abbreviations
    '49ers': 'SF',
    'Bears': 'CHI',
    'Bengals': 'CIN',
    'Bills': 'BUF',
    'Broncos': 'DEN',
    'Browns': 'CLE',
    'Buccaneers': 'TB',
    'Cardinals': 'ARI',
    'Chargers': 'LAC',
    'Chiefs': 'KC',
    'Colts': 'IND',
    'Commanders': 'WSH',
    'Cowboys': 'DAL',
    'Dolphins': 'MIA',
    'Eagles': 'PHI',
    'Falcons': 'ATL',
    'Giants': 'NYG',
    'Jaguars': 'JAX',
    'Jets': 'NYJ',
    'Lions': 'DET',
    'Packers': 'GB',
    'Panthers': 'CAR',
    'Patriots': 'NE',
    'Raiders': 'LV',
    'Rams': 'LAR',
    'Ravens': 'BAL',
    'Saints': 'NO',
    'Seahawks': 'SEA',
    'Steelers': 'PIT',
    'Texans': 'HOU',
    'Titans': 'TEN',
    'Vikings': 'MIN',
    
    // Already abbreviated (passthrough)
    'ARI': 'ARI',
    'ATL': 'ATL',
    'BAL': 'BAL',
    'BUF': 'BUF',
    'CAR': 'CAR',
    'CHI': 'CHI',
    'CIN': 'CIN',
    'CLE': 'CLE',
    'DAL': 'DAL',
    'DEN': 'DEN',
    'DET': 'DET',
    'GB': 'GB',
    'HOU': 'HOU',
    'IND': 'IND',
    'JAX': 'JAX',
    'KC': 'KC',
    'LAC': 'LAC',
    'LAR': 'LAR',
    'LV': 'LV',
    'MIA': 'MIA',
    'MIN': 'MIN',
    'NE': 'NE',
    'NO': 'NO',
    'NYG': 'NYG',
    'NYJ': 'NYJ',
    'PHI': 'PHI',
    'PIT': 'PIT',
    'SEA': 'SEA',
    'SF': 'SF',
    'TB': 'TB',
    'TEN': 'TEN',
    'WAS': 'WAS',
    
    // Special cases
    'DEF': 'DEF',
    'Defense': 'DEF'
};

/**
 * Convert team name to abbreviation
 * @param {string} teamName - Full team name or abbreviation
 * @returns {string} Team abbreviation (2-3 uppercase letters)
 */
function getTeamAbbreviation(teamName) {
    if (!teamName) return '';
    
    // Check if it's already in our mapping
    if (teamAbbreviations[teamName]) {
        return teamAbbreviations[teamName];
    }
    
    // If not found, return the original (it might already be an abbreviation)
    // but ensure it's uppercase and trimmed
    const cleaned = teamName.trim().toUpperCase();
    
    // If it looks like an abbreviation (2-3 uppercase letters), return it
    if (/^[A-Z]{2,3}$/.test(cleaned)) {
        return cleaned;
    }
    
    // Otherwise, log a warning and return the first 3 letters
    console.warn(`Unknown team name: ${teamName}`);
    return cleaned.substring(0, 3);
}

module.exports = {
    teamAbbreviations,
    getTeamAbbreviation
};