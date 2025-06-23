const { logInfo, logError, logWarn } = require('../utils/errorHandler');

class IndividualPlayerScoringService {
    constructor(db) {
        this.db = db;
    }

    /**
     * Process individual player scoring from parsed scoring plays
     * Updates player stats with TDs, conversions, etc. that are missed from base stats
     */
    async processIndividualPlayerScoring(parsedPlays, week, season) {
        try {
            for (const play of parsedPlays) {
                await this.processIndividualPlay(play, week, season);
            }
        } catch (error) {
            logError('Error processing individual player scoring:', error);
        }
    }

    /**
     * Process a single scoring play for individual player stats
     */
    async processIndividualPlay(play, week, season) {
        if (!play.playerName || !play.scoringTeam || !play.playType) {
            return; // Skip plays without essential data
        }

        try {
            // Find the player in our database
            const player = await this.findPlayer(play.playerName, play.scoringTeam);
            
            if (!player) {
                logWarn(`Player not found: ${play.playerName} (${play.scoringTeam})`);
                return;
            }

            // Get current player stats for this week
            const currentStats = await this.getPlayerStats(player.player_id, week, season);
            
            if (!currentStats) {
                logWarn(`No stats found for ${player.name} Week ${week}`);
                return;
            }

            // Update stats based on play type
            const updates = this.getStatUpdates(play.playType, currentStats);
            
            if (Object.keys(updates).length > 0) {
                await this.updatePlayerStats(player.player_id, week, season, updates);
                logInfo(`Updated ${player.name}: ${Object.entries(updates).map(([key, val]) => `${key}=${val}`).join(', ')}`);
            }

        } catch (error) {
            logWarn(`Error processing play for ${play.playerName}:`, error.message);
        }
    }

    /**
     * Find player in database by name and team
     */
    async findPlayer(playerName, team) {
        // Try exact name match first
        let player = await this.db.get(
            'SELECT * FROM nfl_players WHERE name = ? AND (team = ? OR team LIKE ?)',
            [playerName, team, `%${team}%`]
        );

        if (player) return player;

        // Try partial name match (handle name variations)
        const nameParts = playerName.toLowerCase().split(' ');
        if (nameParts.length >= 2) {
            const firstName = nameParts[0];
            const lastName = nameParts[nameParts.length - 1];
            
            player = await this.db.get(`
                SELECT * FROM nfl_players 
                WHERE (name LIKE ? OR name LIKE ?) 
                AND (team = ? OR team LIKE ?)
                LIMIT 1
            `, [`${firstName}%${lastName}%`, `%${lastName}%`, team, `%${team}%`]);
        }

        return player;
    }

    /**
     * Get current player stats for a week
     */
    async getPlayerStats(playerId, week, season) {
        return await this.db.get(
            'SELECT * FROM player_stats WHERE player_id = ? AND week = ? AND season = ?',
            [playerId, week, season]
        );
    }

    /**
     * Determine what stats need to be updated based on play type
     */
    getStatUpdates(playType, currentStats) {
        const updates = {};

        switch (playType) {
            case 'special_teams_punt_return_td':
                updates.punt_return_tds = (currentStats.punt_return_tds || 0) + 1;
                break;

            case 'special_teams_kick_return_td':
                updates.kick_return_tds = (currentStats.kick_return_tds || 0) + 1;
                break;

            case 'receiving_td':
                updates.receiving_tds = (currentStats.receiving_tds || 0) + 1;
                break;

            case 'rushing_td':
                updates.rushing_tds = (currentStats.rushing_tds || 0) + 1;
                break;

            case 'passing_td':
                updates.passing_tds = (currentStats.passing_tds || 0) + 1;
                break;

            // Add more play types as needed
            default:
                // No updates for unhandled play types
                break;
        }

        return updates;
    }

    /**
     * Update player stats in database
     */
    async updatePlayerStats(playerId, week, season, updates) {
        const setClause = Object.keys(updates).map(key => `${key} = ?`).join(', ');
        const values = Object.values(updates);
        
        await this.db.run(
            `UPDATE player_stats SET ${setClause} WHERE player_id = ? AND week = ? AND season = ?`,
            [...values, playerId, week, season]
        );
    }

    /**
     * Process all games for a specific week
     */
    async processWeekScoring(scoringPlayParser, tank01Service, week, season) {
        try {
            // Get all games for the week
            const games = await this.db.all(
                'SELECT * FROM nfl_games WHERE week = ? AND season = ?',
                [week, season]
            );

            logInfo(`Processing individual player scoring for ${games.length} games in Week ${week}`);

            for (const game of games) {
                try {
                    // Get boxscore data
                    const boxScore = await tank01Service.getNFLBoxScore(game.game_id);
                    
                    if (boxScore && boxScore.scoringPlays) {
                        // Parse scoring plays
                        const parsedPlays = scoringPlayParser.parseScoringPlays(
                            boxScore, 
                            game.home_team, 
                            game.away_team
                        );

                        // Process individual player scoring
                        await this.processIndividualPlayerScoring(parsedPlays, week, season);
                    }
                } catch (error) {
                    logWarn(`Failed to process game ${game.game_id}:`, error.message);
                }
            }

        } catch (error) {
            logError('Error processing week scoring:', error);
        }
    }
}

module.exports = IndividualPlayerScoringService;