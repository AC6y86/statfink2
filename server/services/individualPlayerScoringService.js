const { logInfo, logError, logWarn } = require('../utils/errorHandler');

class IndividualPlayerScoringService {
    constructor(db) {
        this.db = db;
    }

    /**
     * Process individual player scoring from parsed scoring plays
     * Updates player stats with TDs, conversions, etc. that are missed from base stats
     */
    async processIndividualPlayerScoring(parsedPlays, week, season, gameId = null, boxScorePlayerStats = null) {
        try {
            for (const play of parsedPlays) {
                await this.processIndividualPlay(play, week, season, gameId, boxScorePlayerStats);
            }
        } catch (error) {
            logError('Error processing individual player scoring:', error);
        }
    }

    /**
     * Process a single scoring play for individual player stats
     */
    async processIndividualPlay(play, week, season, gameId = null, boxScorePlayerStats = null) {
        if (!play.playerName || !play.scoringTeam || !play.playType) {
            return; // Skip plays without essential data
        }

        try {
            // Find the player in our database
            const player = await this.findPlayer(play.playerName, play.scoringTeam, { week, season, gameId });

            if (!player) {
                logWarn(`Player not found: ${play.playerName} (${play.scoringTeam})`);
                return;
            }

            // Get current player stats for this week
            let currentStats = await this.getPlayerStats(player.player_id, week, season);

            if (!currentStats) {
                // Player scored but has no base stats row (e.g. a returner with no
                // offensive touches) — create a minimal row so the TD isn't dropped
                await this.db.run(`
                    INSERT INTO player_stats (player_id, week, season, game_id, player_name, team, position)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [player.player_id, week, season, gameId, player.name, play.scoringTeam, player.position]);
                logInfo(`Created stats row for ${player.name} Week ${week} (scoring play with no base stats)`);
                currentStats = await this.getPlayerStats(player.player_id, week, season);
            }

            // Did the recovering player fumble on the play himself? (Tank01 boxscore
            // Defense.fumbles — own-fumble recovery TDs are already in rushing_tds)
            const boxEntry = boxScorePlayerStats ? boxScorePlayerStats[player.player_id] : null;
            const ownFumble = parseInt(boxEntry?.Defense?.fumbles || 0) > 0;

            // Update stats based on play type
            const updates = this.getStatUpdates(play.playType, currentStats, ownFumble);

            if (Object.keys(updates).length > 0) {
                await this.updatePlayerStats(player.player_id, week, season, updates);
                logInfo(`Updated ${player.name}: ${Object.entries(updates).map(([key, val]) => `${key}=${val}`).join(', ')}`);
            }

        } catch (error) {
            logWarn(`Error processing play for ${play.playerName}:`, error.message);
        }
    }

    /**
     * Find player in database by name and game context.
     *
     * nfl_players.team is the player's CURRENT team, which is wrong for historical
     * recalculation (players change teams between seasons). Instead of matching on
     * team, require evidence the player was in THIS game via player_stats.game_id,
     * falling back to a unique exact name match.
     */
    async findPlayer(playerName, team, context = {}) {
        const { week, season, gameId } = context;

        // 1. Exact name match with proof the player was in this game
        if (week && season && gameId) {
            const player = await this.db.get(`
                SELECT p.* FROM nfl_players p
                JOIN player_stats ps ON ps.player_id = p.player_id
                WHERE p.name = ? AND ps.week = ? AND ps.season = ? AND ps.game_id = ?
            `, [playerName, week, season, gameId]);
            if (player) return player;
        }

        // 2. Exact full-name match, only if unambiguous (covers players with no
        //    base stats row that week, e.g. a kick returner with no touches)
        const exactMatches = await this.db.all(
            'SELECT * FROM nfl_players WHERE name = ?',
            [playerName]
        );
        if (exactMatches.length === 1) return exactMatches[0];

        // 3. Normalized fallback: require BOTH first and last name, and require
        //    game evidence. Never match on last name alone.
        const nameParts = playerName.toLowerCase().split(' ');
        if (nameParts.length >= 2 && week && season && gameId) {
            const firstName = nameParts[0];
            const lastName = nameParts[nameParts.length - 1];

            const candidates = await this.db.all(`
                SELECT p.* FROM nfl_players p
                JOIN player_stats ps ON ps.player_id = p.player_id
                WHERE p.name LIKE ? AND ps.week = ? AND ps.season = ? AND ps.game_id = ?
            `, [`${firstName}%${lastName}%`, week, season, gameId]);
            if (candidates.length === 1) return candidates[0];
        }

        return null;
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
    getStatUpdates(playType, currentStats, ownFumble = false) {
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

            case 'offensive_fumble_recovery_td':
                // Offensive fumble-recovery TD ("Touchdown Scored by any player" = 8 pts,
                // see docs/SCORING_SYSTEM.md). Counted in rushing_tds by league decision.
                // Guard: a player who recovers his OWN fumble and scores is already
                // credited a rushing TD in the Tank01 base stats (NFL scoring), so only
                // credit recoveries of a TEAMMATE's fumble. ownFumble comes from the
                // Tank01 boxscore (Defense.fumbles for the recoverer).
                if (!ownFumble) {
                    updates.rushing_tds = (currentStats.rushing_tds || 0) + 1;
                }
                break;

            // Two-point conversions are handled directly from Tank01 stats
            // Skip these to avoid double-counting
            case 'two_point_conversion_pass':
            case 'two_point_conversion_run':
            case 'two_point_conversion_rec':
                // Do nothing - Tank01 provides accurate 2pt data
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

            // Ensure the parser can resolve ambiguous fumble-recovery TDs by position
            if (tank01Service && !scoringPlayParser.playerPositions) {
                try {
                    const players = await tank01Service.getPlayerList();
                    const positionsById = {};
                    for (const p of players) {
                        if (p.playerID && p.pos) {
                            positionsById[p.playerID] = p.pos;
                        }
                    }
                    scoringPlayParser.setPlayerPositions(positionsById);
                } catch (error) {
                    logWarn('Could not load player positions for fumble-recovery resolution:', error.message);
                }
            }

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
                        const boxScorePlayerStats = boxScore.playerStats || null;
                        await this.processIndividualPlayerScoring(parsedPlays, week, season, game.game_id, boxScorePlayerStats);
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