const axios = require('axios');
const { logError, logInfo } = require('../../../server/utils/errorHandler');

class StatsFetcher {
    constructor(db) {
        this.db = db;
        this.tank01ApiKey = process.env.TANK01_API_KEY;
        this.baseURL = 'https://tank01-nfl-live-in-game-real-time-statistics-nfl.p.rapidapi.com';
        this.headers = {
            'X-RapidAPI-Key': this.tank01ApiKey,
            'X-RapidAPI-Host': 'tank01-nfl-live-in-game-real-time-statistics-nfl.p.rapidapi.com'
        };
    }
    
    /**
     * Get cached stats from Tank01 cache table
     */
    async getCachedStats(playerId, week, season) {
        try {
            const cached = await this.db.get(`
                SELECT 
                    cache_key as player_id,
                    cache_key as player_name,
                    response_data as data,
                    created_at as last_updated
                FROM tank01_cache
                WHERE cache_key LIKE ?
                AND response_data LIKE ?
                ORDER BY created_at DESC
                LIMIT 1
            `, [`%${playerId}%`, `%"week":${week}%"season":${season}%`]);
            
            if (cached && cached.data) {
                try {
                    const data = JSON.parse(cached.data);
                    return this.extractStatsFromTank01Response(data);
                } catch (e) {
                    logError('Error parsing cached Tank01 data', e);
                    return null;
                }
            }
            
            return null;
        } catch (error) {
            logError('Error fetching cached stats', error);
            return null;
        }
    }
    
    /**
     * Fetch fresh stats from Tank01 API
     */
    async fetchFreshStats(playerId, week, season) {
        if (!this.tank01ApiKey) {
            logInfo('Tank01 API key not configured, skipping fresh fetch');
            return null;
        }
        
        try {
            const response = await axios.get(
                `${this.baseURL}/getNFLPlayerInfo`,
                {
                    headers: this.headers,
                    params: {
                        playerID: playerId,
                        season: season,
                        week: week
                    },
                    timeout: 5000
                }
            );
            
            if (response.data && response.data.body) {
                // Cache the response
                await this.cacheStats(playerId, response.data.body, week, season);
                return this.extractStatsFromTank01Response(response.data.body);
            }
            
            return null;
        } catch (error) {
            if (error.response?.status === 404) {
                logInfo(`Player ${playerId} not found in Tank01 for week ${week}, season ${season}`);
            } else {
                logError('Error fetching fresh stats from Tank01', error);
            }
            return null;
        }
    }
    
    /**
     * Cache stats in database
     */
    async cacheStats(playerId, data, week, season) {
        try {
            const playerName = data.player?.displayName || data.playerName || 'Unknown';
            
            await this.db.run(`
                INSERT OR REPLACE INTO tank01_cache (
                    player_id,
                    player_name,
                    endpoint,
                    data,
                    last_updated
                ) VALUES (?, ?, ?, ?, datetime('now'))
            `, [
                playerId,
                playerName,
                `getNFLPlayerInfo_w${week}_s${season}`,
                JSON.stringify(data)
            ]);
        } catch (error) {
            logError('Error caching stats', error);
        }
    }
    
    /**
     * Extract relevant stats from Tank01 API response
     */
    extractStatsFromTank01Response(data) {
        if (!data || !data.stats) return null;
        
        const stats = data.stats;
        const extracted = {
            player_id: data.playerID || data.player_id,
            player_name: data.player?.displayName || data.playerName,
            passing_yards: 0,
            passing_tds: 0,
            interceptions: 0,
            rushing_yards: 0,
            rushing_tds: 0,
            receiving_yards: 0,
            receiving_tds: 0,
            receptions: 0,
            fumbles: 0,
            two_point_conversions: 0,
            return_tds: 0,
            // Kicker stats
            field_goals_made: 0,
            field_goals_attempted: 0,
            extra_points_made: 0,
            extra_points_attempted: 0,
            field_goals_0_39: 0,
            field_goals_40_49: 0,
            field_goals_50_plus: 0,
            // DST stats
            sacks: 0,
            def_interceptions: 0,
            fumbles_recovered: 0,
            def_touchdowns: 0,
            safeties: 0,
            points_allowed: 0,
            yards_allowed: 0
        };
        
        // Parse passing stats
        if (stats.passing) {
            extracted.passing_yards = parseInt(stats.passing.passYds) || 0;
            extracted.passing_tds = parseInt(stats.passing.passTD) || 0;
            extracted.interceptions = parseInt(stats.passing.int) || 0;
        }
        
        // Parse rushing stats
        if (stats.rushing) {
            extracted.rushing_yards = parseInt(stats.rushing.rushYds) || 0;
            extracted.rushing_tds = parseInt(stats.rushing.rushTD) || 0;
        }
        
        // Parse receiving stats
        if (stats.receiving) {
            extracted.receiving_yards = parseInt(stats.receiving.recYds) || 0;
            extracted.receiving_tds = parseInt(stats.receiving.recTD) || 0;
            extracted.receptions = parseInt(stats.receiving.receptions) || 0;
        }
        
        // Parse fumbles
        if (stats.fumbles) {
            extracted.fumbles = parseInt(stats.fumbles.fumLost) || 0;
        }
        
        // Parse kicker stats
        if (stats.kicking) {
            extracted.field_goals_made = parseInt(stats.kicking.fgMade) || 0;
            extracted.field_goals_attempted = parseInt(stats.kicking.fgAtt) || 0;
            extracted.extra_points_made = parseInt(stats.kicking.xpMade) || 0;
            extracted.extra_points_attempted = parseInt(stats.kicking.xpAtt) || 0;
            
            // Parse field goal ranges
            if (stats.kicking.fgMade_0_39) extracted.field_goals_0_39 = parseInt(stats.kicking.fgMade_0_39) || 0;
            if (stats.kicking.fgMade_40_49) extracted.field_goals_40_49 = parseInt(stats.kicking.fgMade_40_49) || 0;
            if (stats.kicking.fgMade_50) extracted.field_goals_50_plus = parseInt(stats.kicking.fgMade_50) || 0;
        }
        
        // Parse defensive stats
        if (stats.defense) {
            extracted.sacks = parseFloat(stats.defense.sacks) || 0;
            extracted.def_interceptions = parseInt(stats.defense.defInts) || 0;
            extracted.fumbles_recovered = parseInt(stats.defense.fumRec) || 0;
            extracted.def_touchdowns = parseInt(stats.defense.defTD) || 0;
            extracted.safeties = parseInt(stats.defense.safeties) || 0;
            extracted.points_allowed = parseInt(stats.defense.ptsAllowed) || 0;
            extracted.yards_allowed = parseInt(stats.defense.ydsAllowed) || 0;
        }
        
        return extracted;
    }
    
    /**
     * Get stats from any available source
     */
    async getStats(playerId, week, season) {
        // First try cache
        let stats = await this.getCachedStats(playerId, week, season);
        
        // If not in cache and we have API key, fetch fresh
        if (!stats && this.tank01ApiKey) {
            stats = await this.fetchFreshStats(playerId, week, season);
        }
        
        return stats;
    }
    
    /**
     * Compare two stat objects and return differences
     */
    compareStats(stats1, stats2, threshold = 0) {
        const differences = {};
        const statKeys = [
            'passing_yards', 'passing_tds', 'interceptions',
            'rushing_yards', 'rushing_tds',
            'receiving_yards', 'receiving_tds', 'receptions',
            'fumbles', 'field_goals_made', 'extra_points_made',
            'sacks', 'def_interceptions', 'def_touchdowns'
        ];
        
        for (const key of statKeys) {
            const val1 = stats1[key] || 0;
            const val2 = stats2[key] || 0;
            const diff = Math.abs(val1 - val2);
            
            if (diff > threshold) {
                differences[key] = {
                    value1: val1,
                    value2: val2,
                    difference: diff
                };
            }
        }
        
        return Object.keys(differences).length > 0 ? differences : null;
    }
    
    /**
     * Validate player exists in multiple data sources
     */
    async validatePlayerExists(playerId, playerName) {
        const results = {
            nfl_players: false,
            player_stats: false,
            tank01_cache: false,
            weekly_rosters: false
        };
        
        // Check nfl_players table
        const nflPlayer = await this.db.get(`
            SELECT player_id FROM nfl_players 
            WHERE player_id = ? OR LOWER(name) = LOWER(?)
        `, [playerId, playerName]);
        results.nfl_players = !!nflPlayer;
        
        // Check player_stats table
        const playerStat = await this.db.get(`
            SELECT player_id FROM player_stats 
            WHERE player_id = ? OR LOWER(player_name) = LOWER(?)
            LIMIT 1
        `, [playerId, playerName]);
        results.player_stats = !!playerStat;
        
        // Check tank01_cache table
        const tank01Cache = await this.db.get(`
            SELECT player_id FROM tank01_cache 
            WHERE player_id = ? OR LOWER(player_name) = LOWER(?)
            LIMIT 1
        `, [playerId, playerName]);
        results.tank01_cache = !!tank01Cache;
        
        // Check weekly_rosters table
        const weeklyRoster = await this.db.get(`
            SELECT player_id FROM weekly_rosters 
            WHERE player_id = ? OR LOWER(player_name) = LOWER(?)
            LIMIT 1
        `, [playerId, playerName]);
        results.weekly_rosters = !!weeklyRoster;
        
        return results;
    }
    
    /**
     * Check if a player should have stats for a given week
     * Returns: 'active', 'suspended', 'inactive', 'injured', or 'unknown'
     */
    async checkPlayerGameStatus(playerId, playerName, week, season) {
        // First check if we have cached status info
        try {
            // Check for known suspensions (could be in a database table in the future)
            const knownSuspensions = {
                '4428331': { start: 1, end: 6, season: 2025 } // Rashee Rice
            };
            
            // Check for known inactives (could be in a database table in the future)
            const knownInactives = {
                '4685279': { weeks: [1], season: 2025 } // Jaydon Blue - inactive Week 1
            };
            
            if (knownSuspensions[playerId]) {
                const suspension = knownSuspensions[playerId];
                if (suspension.season === season && week >= suspension.start && week <= suspension.end) {
                    logInfo(`Player ${playerName} (${playerId}) is suspended for week ${week}`);
                    return 'suspended';
                }
            }
            
            if (knownInactives[playerId]) {
                const inactive = knownInactives[playerId];
                if (inactive.season === season && inactive.weeks.includes(week)) {
                    logInfo(`Player ${playerName} (${playerId}) was inactive for week ${week}`);
                    return 'inactive';
                }
            }
            
            // Check if player has 0 stats but game was played
            const stats = await this.db.get(`
                SELECT fantasy_points, raw_stats 
                FROM player_stats 
                WHERE player_id = ? 
                AND week = ? 
                AND season = ?
            `, [playerId, week, season]);
            
            // If we have stats entry with 0 points, check raw_stats for inactive notation
            if (stats && stats.fantasy_points === 0) {
                if (stats.raw_stats && stats.raw_stats.includes('inactive')) {
                    return 'inactive';
                }
            }
            
            // Default to unknown if we can't determine
            return 'unknown';
            
        } catch (error) {
            logError('Error checking player game status', error);
            return 'unknown';
        }
    }
}

module.exports = StatsFetcher;