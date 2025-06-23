const { logInfo, logError, logWarn } = require('../utils/errorHandler');

class ScoringPlayParserService {
    constructor() {
        // NFL team abbreviation mappings for parsing
        this.teamMappings = {
            'ARI': 'ARI', 'ARIZONA': 'ARI', 'CARDINALS': 'ARI',
            'ATL': 'ATL', 'ATLANTA': 'ATL', 'FALCONS': 'ATL',
            'BAL': 'BAL', 'BALTIMORE': 'BAL', 'RAVENS': 'BAL',
            'BUF': 'BUF', 'BUFFALO': 'BUF', 'BILLS': 'BUF',
            'CAR': 'CAR', 'CAROLINA': 'CAR', 'PANTHERS': 'CAR',
            'CHI': 'CHI', 'CHICAGO': 'CHI', 'BEARS': 'CHI',
            'CIN': 'CIN', 'CINCINNATI': 'CIN', 'BENGALS': 'CIN',
            'CLE': 'CLE', 'CLEVELAND': 'CLE', 'BROWNS': 'CLE',
            'DAL': 'DAL', 'DALLAS': 'DAL', 'COWBOYS': 'DAL',
            'DEN': 'DEN', 'DENVER': 'DEN', 'BRONCOS': 'DEN',
            'DET': 'DET', 'DETROIT': 'DET', 'LIONS': 'DET',
            'GB': 'GB', 'GREEN BAY': 'GB', 'PACKERS': 'GB',
            'HOU': 'HOU', 'HOUSTON': 'HOU', 'TEXANS': 'HOU',
            'IND': 'IND', 'INDIANAPOLIS': 'IND', 'COLTS': 'IND',
            'JAX': 'JAX', 'JACKSONVILLE': 'JAX', 'JAGUARS': 'JAX',
            'KC': 'KC', 'KANSAS CITY': 'KC', 'CHIEFS': 'KC',
            'LV': 'LV', 'LAS VEGAS': 'LV', 'RAIDERS': 'LV',
            'LAC': 'LAC', 'LA CHARGERS': 'LAC', 'CHARGERS': 'LAC',
            'LAR': 'LAR', 'LA RAMS': 'LAR', 'RAMS': 'LAR',
            'MIA': 'MIA', 'MIAMI': 'MIA', 'DOLPHINS': 'MIA',
            'MIN': 'MIN', 'MINNESOTA': 'MIN', 'VIKINGS': 'MIN',
            'NE': 'NE', 'NEW ENGLAND': 'NE', 'PATRIOTS': 'NE',
            'NO': 'NO', 'NEW ORLEANS': 'NO', 'SAINTS': 'NO',
            'NYG': 'NYG', 'NY GIANTS': 'NYG', 'GIANTS': 'NYG',
            'NYJ': 'NYJ', 'NY JETS': 'NYJ', 'JETS': 'NYJ',
            'PHI': 'PHI', 'PHILADELPHIA': 'PHI', 'EAGLES': 'PHI',
            'PIT': 'PIT', 'PITTSBURGH': 'PIT', 'STEELERS': 'PIT',
            'SF': 'SF', 'SAN FRANCISCO': 'SF', '49ERS': 'SF',
            'SEA': 'SEA', 'SEATTLE': 'SEA', 'SEAHAWKS': 'SEA',
            'TB': 'TB', 'TAMPA BAY': 'TB', 'BUCCANEERS': 'TB',
            'TEN': 'TEN', 'TENNESSEE': 'TEN', 'TITANS': 'TEN',
            'WAS': 'WAS', 'WASHINGTON': 'WAS', 'COMMANDERS': 'WAS'
        };
    }

    /**
     * Parse scoring plays from boxscore data
     * Returns array of parsed scoring plays with categorization
     */
    parseScoringPlays(boxScoreData, homeTeam, awayTeam) {
        try {
            const scoringPlays = this.extractScoringPlays(boxScoreData);
            const parsedPlays = [];

            for (const play of scoringPlays) {
                const parsedPlay = this.parseIndividualPlay(play, homeTeam, awayTeam);
                if (parsedPlay) {
                    parsedPlays.push(parsedPlay);
                }
            }

            logInfo(`Parsed ${parsedPlays.length} scoring plays from ${scoringPlays.length} total plays`);
            return parsedPlays;

        } catch (error) {
            logError('Error parsing scoring plays:', error);
            return [];
        }
    }

    /**
     * Extract scoring plays from various boxscore data formats
     */
    extractScoringPlays(boxScoreData) {
        const plays = [];

        // Try different possible locations for scoring plays in the API response
        if (boxScoreData.scoringPlays && Array.isArray(boxScoreData.scoringPlays)) {
            plays.push(...boxScoreData.scoringPlays);
        }

        if (boxScoreData.scoring && Array.isArray(boxScoreData.scoring)) {
            plays.push(...boxScoreData.scoring);
        }

        if (boxScoreData.scoreDetails && Array.isArray(boxScoreData.scoreDetails)) {
            plays.push(...boxScoreData.scoreDetails);
        }

        // Check if plays are nested under quarters
        if (boxScoreData.quarters) {
            for (const quarter of Object.values(boxScoreData.quarters)) {
                if (quarter.scoring && Array.isArray(quarter.scoring)) {
                    plays.push(...quarter.scoring);
                }
            }
        }

        return plays;
    }

    /**
     * Parse an individual scoring play and categorize it
     */
    parseIndividualPlay(play, homeTeam, awayTeam) {
        try {
            // Extract play text/description
            const playText = this.extractPlayText(play);
            if (!playText) {
                return null;
            }

            const normalizedText = playText.toLowerCase();
            const playType = this.categorizePlayType(normalizedText, playText);
            
            // Determine scoring team - first try to extract from play data itself
            let scoringTeam = this.extractScoringTeam(playText, homeTeam, awayTeam, play);

            // Determine play type and team
            const playInfo = {
                originalText: playText,
                normalizedText: normalizedText,
                homeTeam: homeTeam,
                awayTeam: awayTeam,
                scoringTeam: scoringTeam,
                playerName: this.extractPlayerName(playText),
                playType: playType,
                points: this.extractPoints(play, normalizedText),
                quarter: this.extractQuarter(play),
                time: this.extractTime(play)
            };

            return playInfo;

        } catch (error) {
            logWarn('Error parsing individual play:', error.message);
            return null;
        }
    }

    /**
     * Extract play text from various play formats
     */
    extractPlayText(play) {
        if (typeof play === 'string') {
            return play;
        }

        // Handle Tank01 API format with 'score' field
        if (play.score) return play.score;
        if (play.description) return play.description;
        if (play.text) return play.text;
        if (play.playDescription) return play.playDescription;
        if (play.scoreText) return play.scoreText;
        if (play.detail) return play.detail;

        return null;
    }

    /**
     * Categorize the type of scoring play
     */
    categorizePlayType(normalizedText, originalText = '') {
        // Defensive touchdowns - blocked returns (remove "touchdown" requirement)
        if (normalizedText.includes('blocked') && 
            (normalizedText.includes('punt') || normalizedText.includes('kick') || normalizedText.includes('field goal')) &&
            normalizedText.includes('return')) {
            return 'defensive_blocked_return_td';
        }

        // Defensive touchdowns - interception returns (remove "touchdown" requirement)
        if (normalizedText.includes('interception') && 
            normalizedText.includes('return')) {
            return 'defensive_int_return_td';
        }

        // Defensive touchdowns - fumble returns (remove "touchdown" requirement)
        // Only count as defensive if it's likely an opponent's fumble recovered by defense
        if (normalizedText.includes('fumble') && 
            (normalizedText.includes('return') || normalizedText.includes('recovery'))) {
            
            // Check if this is likely an offensive fumble recovery vs defensive fumble return
            // Key indicators for offensive fumble recovery:
            // 1. Very short yardage (0-3 yards) suggests fumble on current drive
            // 2. Description says "recovery" instead of "return" 
            // 3. Player name suggests it's same team that was on offense
            
            const yardageMatch = originalText.match(/(\d+)\s*Yd/i);
            const yardage = yardageMatch ? parseInt(yardageMatch[1]) : null;
            
            // Special cases for offensive fumble recoveries:
            // 1. Short yardage fumble recovery: "Tank Bigsby 3 Yd Fumble Recovery"
            // 2. End zone fumble recovery: "Patrick Ricard Fumble Recovery in End Zone"
            if (normalizedText.includes('recovery')) {
                // Case 1: Short yardage (1-5 yards) suggests offensive fumble recovery
                if (yardage !== null && yardage >= 1 && yardage <= 5) {
                    return null;
                }
                
                // Case 2: "in End Zone" suggests offensive fumble recovery
                // But only for known offensive players (more conservative approach)
                if (normalizedText.includes('in end zone')) {
                    // Look for typical offensive player indicators
                    const offensivePlayerPatterns = [
                        /ricard/i,      // Patrick Ricard (Ravens FB)
                        /fullback/i,    // Any fullback reference
                        /\bfb\b/i       // FB abbreviation
                    ];
                    
                    for (const pattern of offensivePlayerPatterns) {
                        if (pattern.test(originalText)) {
                            return null; // Offensive fumble recovery
                        }
                    }
                    
                    // Default: treat "in End Zone" as defensive if no clear offensive indicators
                    // This is more conservative and prevents missing legitimate defensive TDs
                }
            }
            
            // Everything else is considered defensive fumble return
            return 'defensive_fumble_return_td';
        }

        // Special teams touchdowns - regular punt returns (remove "touchdown" requirement)
        if (normalizedText.includes('punt return') && 
            !normalizedText.includes('blocked')) {
            return 'special_teams_punt_return_td';
        }

        // Special teams touchdowns - regular kick returns (remove "touchdown" requirement)
        if ((normalizedText.includes('kick return') || normalizedText.includes('kickoff return')) && 
            !normalizedText.includes('blocked')) {
            return 'special_teams_kick_return_td';
        }

        // Safeties
        if (normalizedText.includes('safety')) {
            return 'safety';
        }

        // Other touchdown types
        if (normalizedText.includes('touchdown')) {
            // Skip lateral plays - they don't count for individual player fantasy points
            if (normalizedText.includes('lateral')) {
                return null;
            }
            
            if (normalizedText.includes('pass')) {
                // If the play says "pass from [QB]", the extracted player is the receiver
                if (normalizedText.includes('pass from')) {
                    return 'receiving_td';
                } else {
                    return 'passing_td';
                }
            } else if (normalizedText.includes('rush') || normalizedText.includes('run')) {
                return 'rushing_td';
            } else if (normalizedText.includes('receiv')) {
                return 'receiving_td';
            }
        }

        return 'other';
    }

    /**
     * Extract scoring team from play text and API data
     * Priority: API data > text parsing
     */
    extractScoringTeam(playText, homeTeam, awayTeam, playData = null) {
        // First priority: Use team data from the API if available
        if (playData && typeof playData === 'object') {
            if (playData.team) return playData.team;
            if (playData.teamAbbreviation) return playData.teamAbbreviation;
            if (playData.scoringTeam) return playData.scoringTeam;
        }

        // Fallback: Try to find team abbreviations in the text
        const upperText = playText.toUpperCase();
        
        // Try to find team abbreviations in the text first
        for (const [teamName, abbrev] of Object.entries(this.teamMappings)) {
            if (upperText.includes(teamName)) {
                if (abbrev === homeTeam || abbrev === awayTeam) {
                    return abbrev;
                }
            }
        }

        // Try to find home/away team abbreviations directly
        if (upperText.includes(homeTeam.toUpperCase())) {
            return homeTeam;
        }
        if (upperText.includes(awayTeam.toUpperCase())) {
            return awayTeam;
        }

        // If we can't determine from API data or text, return null
        return null;
    }

    /**
     * Extract player name from play text
     */
    extractPlayerName(playText) {
        try {
            // Common patterns for player names in scoring plays
            // e.g., "Jonathan Owens 21 Yd Return of Blocked Punt"
            // e.g., "J.Smith 15 yard interception return for touchdown"
            // e.g., "Marcus Jones 84 yard punt return for touchdown"
            
            const patterns = [
                // Pattern 1: Name followed by number then "Yd" or "yard"
                /^([A-Z][a-z]*\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]*\.?\s*[A-Z][a-z]+)*)\s+\d+\s+(?:Yd|yard)/i,
                // Pattern 2: Name followed by number then "yard" (case insensitive)  
                /^([A-Z][a-z]*\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]*\.?\s*[A-Z][a-z]+)*)\s+\d+\s+yard/i,
                // Pattern 3: Name at start followed by space and action word
                /^([A-Z][a-z]*\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]*\.?\s*[A-Z][a-z]+)*)\s+(?:return|rush|pass|receiv|intercept)/i,
                // Pattern 4: Just first two words (First Last)
                /^([A-Z][a-z]*\.?\s+[A-Z][a-z]+)/
            ];

            for (const pattern of patterns) {
                const match = playText.match(pattern);
                if (match && match[1]) {
                    const name = match[1].trim();
                    // Don't return single words or common non-name words
                    if (name.includes(' ') && !name.toLowerCase().includes('safety')) {
                        return name;
                    }
                }
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Extract points from play data
     */
    extractPoints(play, normalizedText) {
        if (play.points !== undefined) {
            return parseInt(play.points);
        }

        // Safety is 2 points
        if (normalizedText.includes('safety')) {
            return 2;
        }

        // Touchdowns are 6 points (plus extra point/2pt conversion)
        if (normalizedText.includes('touchdown')) {
            return 6;
        }

        // Field goals are 3 points
        if (normalizedText.includes('field goal')) {
            return 3;
        }

        return 0;
    }

    /**
     * Extract quarter from play data
     */
    extractQuarter(play) {
        if (play.quarter !== undefined) {
            return parseInt(play.quarter);
        }
        if (play.qtr !== undefined) {
            return parseInt(play.qtr);
        }
        return null;
    }

    /**
     * Extract time from play data
     */
    extractTime(play) {
        if (play.time) return play.time;
        if (play.timeRemaining) return play.timeRemaining;
        if (play.clock) return play.clock;
        return null;
    }

    /**
     * Get defensive touchdown breakdown for a team from parsed plays
     */
    getDefensiveTouchdownBreakdown(parsedPlays, team) {
        const breakdown = {
            def_int_return_tds: 0,
            def_fumble_return_tds: 0,
            def_blocked_return_tds: 0,
            safeties: 0
        };

        for (const play of parsedPlays) {
            if (play.scoringTeam === team) {
                switch (play.playType) {
                    case 'defensive_int_return_td':
                        breakdown.def_int_return_tds++;
                        break;
                    case 'defensive_fumble_return_td':
                        breakdown.def_fumble_return_tds++;
                        break;
                    case 'defensive_blocked_return_td':
                        breakdown.def_blocked_return_tds++;
                        break;
                    case 'safety':
                        breakdown.safeties++;
                        break;
                }
            }
        }

        return breakdown;
    }

    /**
     * Get special teams touchdown breakdown for individual players
     */
    getSpecialTeamsTouchdowns(parsedPlays) {
        const playerTDs = [];

        for (const play of parsedPlays) {
            if (play.playType === 'special_teams_punt_return_td' || 
                play.playType === 'special_teams_kick_return_td') {
                playerTDs.push({
                    playerName: play.playerName,
                    team: play.scoringTeam,
                    playType: play.playType,
                    originalText: play.originalText
                });
            }
        }

        return playerTDs;
    }

    /**
     * Check if a play type is a defensive play
     */
    isDefensivePlayType(playType) {
        return playType === 'defensive_int_return_td' || 
               playType === 'defensive_fumble_return_td' || 
               playType === 'defensive_blocked_return_td' ||
               playType === 'safety';
    }

    /**
     * Infer which team gets credit for a defensive play
     * This is a best-effort approach since we don't have roster data
     */
    inferDefensiveTeam(playText, homeTeam, awayTeam, playType) {
        // Parse play context to determine which team was on defense
        // For defensive plays, we need to infer from the context and game situation
        
        const lowerText = playText.toLowerCase();
        
        // For safeties, look for sack patterns
        if (playType === 'safety') {
            // Pattern: "[QB] sacked in end zone by [defender] for a Safety"
            // The defending team gets the safety points
            
            // If we can determine the QB's team from context, the defense is the other team
            // For now, we'll use a heuristic: in most games, the visiting team QB gets sacked more
            // But this is not reliable - we need better context
            
            // Alternative: assume the safety goes to the team that's not explicitly mentioned
            // This is still not ideal without roster data
            return null; // Cannot reliably determine without roster data
        }
        
        // For interceptions, fumble returns, and blocked returns:
        // The defensive player making the play belongs to the team that gets credit
        
        // Without roster data, we cannot reliably determine team assignment
        // The proper solution would be to:
        // 1. Maintain a player roster mapping
        // 2. Use game context (possession, down/distance) 
        // 3. Parse additional API data that might contain team info
        
        return null;
    }
}

module.exports = ScoringPlayParserService;