const { logInfo, logError, logWarn } = require('../utils/errorHandler');
const { createDefensePreservationHook } = require('../utils/nfl/teamDefenses');

class PlayerSyncService {
    constructor(db, tank01Service) {
        this.db = db;
        this.tank01Service = tank01Service;
        this.lastSyncTime = null;
        this.syncInProgress = false;
        this.defenseHook = createDefensePreservationHook();
    }

    // Main sync function
    async syncPlayers() {
        if (this.syncInProgress) {
            logWarn('Player sync already in progress, skipping');
            return { success: false, message: 'Sync already in progress' };
        }

        if (!this.tank01Service) {
            logError('Tank01 service not available for player sync');
            return { success: false, message: 'Tank01 service not configured' };
        }

        this.syncInProgress = true;
        const startTime = Date.now();
        
        try {
            logInfo('Starting player synchronization from Tank01 API');
            
            // Preserve defenses before sync
            const preserved = await this.defenseHook.beforeSync(this.db);
            
            // Get player list from Tank01 API
            const apiData = await this.tank01Service.getPlayerList();
            
            if (!apiData || !Array.isArray(apiData)) {
                throw new Error('Invalid player data received from Tank01 API');
            }

            // Transform API data to our database format
            const players = this.transformPlayerData(apiData);
            
            logInfo(`Transforming ${players.length} players from Tank01 API`);

            // Bulk insert/update players
            await this.db.upsertPlayersBulk(players);
            
            // Restore defenses after sync
            await this.defenseHook.afterSync(this.db, preserved);

            // Update sync metadata
            this.lastSyncTime = new Date();
            const duration = Date.now() - startTime;

            logInfo(`Player sync completed successfully`, {
                players_synced: players.length,
                duration: `${duration}ms`,
                last_sync: this.lastSyncTime.toISOString()
            });

            return {
                success: true,
                players_synced: players.length,
                duration,
                last_sync: this.lastSyncTime
            };

        } catch (error) {
            logError('Player sync failed', error);
            return {
                success: false,
                error: error.message,
                duration: Date.now() - startTime
            };
        } finally {
            this.syncInProgress = false;
        }
    }

    // Transform Tank01 API player data to our database format
    transformPlayerData(apiPlayers) {
        const players = [];
        
        for (const player of apiPlayers) {
            try {
                // Handle different possible API response formats
                const playerData = {
                    player_id: this.extractPlayerId(player),
                    name: this.extractPlayerName(player),
                    position: this.normalizePosition(this.extractPosition(player)),
                    team: this.normalizeTeam(this.extractTeam(player)),
                    bye_week: this.extractByeWeek(player),
                    injury_designation: this.extractInjuryDesignation(player),
                    injury_description: this.extractInjuryDescription(player),
                    injury_date: this.extractInjuryDate(player),
                    injury_return_date: this.extractInjuryReturnDate(player)
                };

                // Skip players with missing critical data
                if (!playerData.player_id || !playerData.name || !playerData.position) {
                    logWarn(`Skipping player with incomplete data`, playerData);
                    continue;
                }

                players.push(playerData);
            } catch (error) {
                logWarn(`Error processing player data`, { player, error: error.message });
            }
        }

        return players;
    }

    // Extract player ID from API response
    extractPlayerId(player) {
        return player.playerID || player.player_id || player.id || null;
    }

    // Extract player name from API response
    extractPlayerName(player) {
        const name = player.longName || player.name || player.fullName || 
                     player.displayName || `${player.firstName || ''} ${player.lastName || ''}`.trim();
        return name || null;
    }

    // Extract position from API response
    extractPosition(player) {
        return player.pos || player.position || player.primaryPosition || null;
    }

    // Extract team from API response
    extractTeam(player) {
        return player.team || player.teamAbv || player.teamAbbreviation || null;
    }

    // Extract bye week from API response
    extractByeWeek(player) {
        const bye = player.byeWeek || player.bye_week || player.bye;
        return bye ? parseInt(bye) : null;
    }

    // Extract injury designation from API response
    extractInjuryDesignation(player) {
        if (player.injury && player.injury.designation) {
            return player.injury.designation || null;
        }
        return null;
    }

    // Extract injury description from API response
    extractInjuryDescription(player) {
        if (player.injury && player.injury.description) {
            return player.injury.description || null;
        }
        return null;
    }

    // Extract injury date from API response
    extractInjuryDate(player) {
        if (player.injury && player.injury.injDate) {
            return player.injury.injDate || null;
        }
        return null;
    }

    // Extract injury return date from API response
    extractInjuryReturnDate(player) {
        if (player.injury && player.injury.injReturnDate) {
            return player.injury.injReturnDate || null;
        }
        return null;
    }

    // Normalize position names to our standard format
    normalizePosition(position) {
        if (!position) return null;

        const pos = position.toUpperCase();
        
        // Handle common variations and filter to fantasy-relevant positions only
        const positionMap = {
            'QB': 'QB',
            'QUARTERBACK': 'QB',
            'RB': 'RB',
            'RUNNINGBACK': 'RB',
            'RUNNING_BACK': 'RB',
            'WR': 'WR',
            'WIDERECEIVER': 'WR',
            'WIDE_RECEIVER': 'WR',
            'TE': 'TE',
            'TIGHTEND': 'TE',
            'TIGHT_END': 'TE',
            'K': 'K',
            'KICKER': 'K',
            'PK': 'K',
            'DST': 'DST',
            'DEF': 'DST',
            'DEFENSE': 'DST',
            'D/ST': 'DST'
        };

        // Only return fantasy-relevant positions, filter out others
        return positionMap[pos] || null;
    }

    // Normalize team abbreviations
    normalizeTeam(team) {
        if (!team) return null;

        const teamAbv = team.toUpperCase();
        
        // Handle common team abbreviation variations
        const teamMap = {
            'ARI': 'ARI', 'ARIZONA': 'ARI',
            'ATL': 'ATL', 'ATLANTA': 'ATL',
            'BAL': 'BAL', 'BALTIMORE': 'BAL',
            'BUF': 'BUF', 'BUFFALO': 'BUF',
            'CAR': 'CAR', 'CAROLINA': 'CAR',
            'CHI': 'CHI', 'CHICAGO': 'CHI',
            'CIN': 'CIN', 'CINCINNATI': 'CIN',
            'CLE': 'CLE', 'CLEVELAND': 'CLE',
            'DAL': 'DAL', 'DALLAS': 'DAL',
            'DEN': 'DEN', 'DENVER': 'DEN',
            'DET': 'DET', 'DETROIT': 'DET',
            'GB': 'GB', 'GREEN BAY': 'GB', 'GNB': 'GB',
            'HOU': 'HOU', 'HOUSTON': 'HOU',
            'IND': 'IND', 'INDIANAPOLIS': 'IND',
            'JAX': 'JAX', 'JACKSONVILLE': 'JAX', 'JAC': 'JAX',
            'KC': 'KC', 'KANSAS CITY': 'KC', 'KAN': 'KC',
            'LV': 'LV', 'LAS VEGAS': 'LV', 'RAIDERS': 'LV',
            'LAC': 'LAC', 'LA CHARGERS': 'LAC', 'CHARGERS': 'LAC',
            'LAR': 'LAR', 'LA RAMS': 'LAR', 'RAMS': 'LAR',
            'MIA': 'MIA', 'MIAMI': 'MIA',
            'MIN': 'MIN', 'MINNESOTA': 'MIN',
            'NE': 'NE', 'NEW ENGLAND': 'NE', 'PATRIOTS': 'NE',
            'NO': 'NO', 'NEW ORLEANS': 'NO', 'SAINTS': 'NO',
            'NYG': 'NYG', 'NY GIANTS': 'NYG', 'GIANTS': 'NYG',
            'NYJ': 'NYJ', 'NY JETS': 'NYJ', 'JETS': 'NYJ',
            'PHI': 'PHI', 'PHILADELPHIA': 'PHI',
            'PIT': 'PIT', 'PITTSBURGH': 'PIT',
            'SF': 'SF', 'SAN FRANCISCO': 'SF', '49ERS': 'SF',
            'SEA': 'SEA', 'SEATTLE': 'SEA',
            'TB': 'TB', 'TAMPA BAY': 'TB', 'BUCCANEERS': 'TB',
            'TEN': 'TEN', 'TENNESSEE': 'TEN',
            'WAS': 'WAS', 'WASHINGTON': 'WAS', 'COMMANDERS': 'WAS'
        };

        return teamMap[teamAbv] || teamAbv;
    }

    // Sync player stats for a specific week
    async syncPlayerStats(week, season) {
        if (!this.tank01Service) {
            logError('Tank01 service not available for stats sync');
            return { success: false, message: 'Tank01 service not configured' };
        }

        const startTime = Date.now();
        
        try {
            logInfo(`Starting player stats sync for week ${week}, season ${season}`);
            
            // Get stats from Tank01 API
            const apiStats = await this.tank01Service.getPlayerStats(week, season);
            
            if (!apiStats || !Array.isArray(apiStats)) {
                throw new Error('Invalid stats data received from Tank01 API');
            }

            // Transform and bulk insert stats
            const stats = this.transformStatsData(apiStats, week, season);
            await this.db.upsertPlayerStatsBulk(stats);

            const duration = Date.now() - startTime;
            logInfo(`Stats sync completed for week ${week}`, {
                stats_synced: stats.length,
                duration: `${duration}ms`
            });

            return {
                success: true,
                stats_synced: stats.length,
                week,
                season,
                duration
            };

        } catch (error) {
            logError(`Stats sync failed for week ${week}, season ${season}`, error);
            return {
                success: false,
                error: error.message,
                week,
                season,
                duration: Date.now() - startTime
            };
        }
    }

    // Transform Tank01 API stats data to our database format
    transformStatsData(apiStats, week, season) {
        const stats = [];
        
        for (const playerStats of apiStats) {
            try {
                const statData = {
                    player_id: this.extractPlayerId(playerStats),
                    week: parseInt(week),
                    season: parseInt(season),
                    
                    // Passing stats
                    passing_yards: parseInt(playerStats.passingYards || 0),
                    passing_tds: parseInt(playerStats.passingTDs || 0),
                    interceptions: parseInt(playerStats.interceptions || 0),
                    
                    // Rushing stats
                    rushing_yards: parseInt(playerStats.rushingYards || 0),
                    rushing_tds: parseInt(playerStats.rushingTDs || 0),
                    
                    // Receiving stats
                    receiving_yards: parseInt(playerStats.receivingYards || 0),
                    receiving_tds: parseInt(playerStats.receivingTDs || 0),
                    receptions: parseInt(playerStats.receptions || 0),
                    
                    // Miscellaneous stats
                    fumbles: parseInt(playerStats.fumbles || 0),
                    
                    // Defensive stats
                    sacks: parseInt(playerStats.sacks || 0),
                    def_interceptions: parseInt(playerStats.defInterceptions || 0),
                    fumbles_recovered: parseInt(playerStats.fumblesRecovered || 0),
                    def_touchdowns: parseInt(playerStats.defTouchdowns || 0),
                    safeties: parseInt(playerStats.safeties || 0),
                    points_allowed: parseInt(playerStats.pointsAllowed || 0),
                    yards_allowed: parseInt(playerStats.yardsAllowed || 0),
                    
                    // Kicking stats
                    field_goals_made: parseInt(playerStats.fieldGoalsMade || 0),
                    field_goals_attempted: parseInt(playerStats.fieldGoalsAttempted || 0),
                    extra_points_made: parseInt(playerStats.extraPointsMade || 0),
                    extra_points_attempted: parseInt(playerStats.extraPointsAttempted || 0),
                    field_goals_0_39: parseInt(playerStats.fieldGoals0_39 || 0),
                    field_goals_40_49: parseInt(playerStats.fieldGoals40_49 || 0),
                    field_goals_50_plus: parseInt(playerStats.fieldGoals50Plus || 0),
                    
                    fantasy_points: parseFloat(playerStats.fantasyPoints || 0)
                };

                if (statData.player_id) {
                    stats.push(statData);
                }
            } catch (error) {
                logWarn(`Error processing player stats`, { playerStats, error: error.message });
            }
        }

        return stats;
    }

    // Get sync status
    getSyncStatus() {
        return {
            last_sync: this.lastSyncTime,
            sync_in_progress: this.syncInProgress,
            tank01_available: !!this.tank01Service
        };
    }

    // Manual trigger for testing
    async forceSyncPlayers() {
        logInfo('Force sync triggered manually');
        return await this.syncPlayers();
    }
}

module.exports = PlayerSyncService;