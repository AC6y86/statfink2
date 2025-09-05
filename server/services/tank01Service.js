const axios = require('axios');
const { logError, logInfo, logWarn } = require('../utils/errorHandler');
const DatabaseManager = require('../database/database');

class Tank01Service {
    constructor(apiKey, db = null) {
        this.apiKey = apiKey;
        this.baseURL = 'https://tank01-nfl-live-in-game-real-time-statistics-nfl.p.rapidapi.com';
        this.headers = {
            'X-RapidAPI-Key': apiKey,
            'X-RapidAPI-Host': 'tank01-nfl-live-in-game-real-time-statistics-nfl.p.rapidapi.com'
        };
        
        // Database connection for persistent cache
        this.db = db || new DatabaseManager();
        
        // Rate limiting
        this.lastRequestTime = 0;
        this.minRequestInterval = 1; // disable for now
        this.requestCount = 0;
        this.maxRequestsPerMinute = 600; // Conservative limit
        
        // Daily counter tracking
        this.dailyStats = {
            date: new Date().toDateString(),
            requests: 0,
            lastReset: new Date().toISOString()
        };
        this.loadDailyStats();
        
        // Cache settings
        this.defaultCacheExpiry = 5 * 60 * 1000; // 5 minutes for general data
        this.liveCacheExpiry = 30 * 1000; // 30 seconds for live games
        this.scheduledCacheExpiry = 30 * 60 * 1000; // 30 minutes for scheduled games
        this.historicalCacheExpiry = null; // Never expire historical data
        this.currentSeasonYear = new Date().getFullYear();
    }

    // Load daily stats from database
    async loadDailyStats() {
        try {
            const today = new Date().toDateString();
            const stats = await this.db.get(`
                SELECT date, requests, last_reset 
                FROM tank01_daily_stats 
                WHERE date = ?
            `, [today]);
            
            if (stats) {
                this.dailyStats = {
                    date: stats.date,
                    requests: stats.requests,
                    lastReset: stats.last_reset
                };
                logInfo(`Loaded daily stats: ${stats.requests} requests for ${stats.date}`);
            } else {
                // Only reset if this is genuinely a new day, not a missing record
                logInfo(`No daily stats found for ${today}, keeping current values`);
                // Keep the default values from constructor instead of resetting
            }
        } catch (error) {
            logError('Error loading daily stats', error);
            // Create table if it doesn't exist
            await this.db.run(`
                CREATE TABLE IF NOT EXISTS tank01_daily_stats (
                    date TEXT PRIMARY KEY,
                    requests INTEGER DEFAULT 0,
                    last_reset TEXT
                )
            `);
            // Don't automatically reset, keep constructor defaults
            logInfo('Created tank01_daily_stats table, keeping current values');
        }
    }
    
    // Reset daily stats
    async resetDailyStats() {
        const today = new Date().toDateString();
        const now = new Date().toISOString();
        
        this.dailyStats = {
            date: today,
            requests: 0,
            lastReset: now
        };
        
        await this.db.run(`
            INSERT OR REPLACE INTO tank01_daily_stats (date, requests, last_reset)
            VALUES (?, 0, ?)
        `, [today, now]);
        
        logInfo('Daily stats reset for', today);
    }
    
    // Update daily counter
    async updateDailyCounter() {
        const today = new Date().toDateString();
        
        // Check if we need to reset for a new day
        if (this.dailyStats.date !== today) {
            await this.resetDailyStats();
        }
        
        this.dailyStats.requests++;
        
        // Update database - use INSERT OR REPLACE to handle missing records
        await this.db.run(`
            INSERT OR REPLACE INTO tank01_daily_stats (date, requests, last_reset)
            VALUES (?, ?, ?)
        `, [today, this.dailyStats.requests, this.dailyStats.lastReset]);
    }

    // Rate limiting helper
    async rateLimit() {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        
        if (timeSinceLastRequest < this.minRequestInterval) {
            const waitTime = this.minRequestInterval - timeSinceLastRequest;
            logInfo(`Rate limiting: waiting ${waitTime}ms`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        
        this.lastRequestTime = Date.now();
        this.requestCount++;
        
        // Update daily counter
        await this.updateDailyCounter();
    }

    // Determine if data should be permanently cached (historical data)
    isHistoricalData(endpoint, params, data) {
        // Box scores from completed games
        if (endpoint === '/getNFLBoxScore' && data?.body?.gameStatus) {
            const status = data.body.gameStatus.toLowerCase();
            return ['final', 'completed', 'final ot'].includes(status);
        }
        
        // Games from past seasons
        if (params.season && parseInt(params.season) < this.currentSeasonYear) {
            return true;
        }
        
        // Player stats from past weeks
        if (endpoint.includes('Stats') && params.week && params.season) {
            const season = parseInt(params.season);
            const week = parseInt(params.week);
            const currentDate = new Date();
            const currentWeek = Math.ceil((currentDate - new Date(currentDate.getFullYear(), 8, 1)) / (7 * 24 * 60 * 60 * 1000));
            
            if (season < this.currentSeasonYear || (season === this.currentSeasonYear && week < currentWeek - 1)) {
                return true;
            }
        }
        
        return false;
    }

    // Determine appropriate cache duration based on game status
    getCacheDuration(endpoint, params, data) {
        // For box scores, check game status
        if (endpoint === '/getNFLBoxScore' && data?.body?.gameStatus) {
            const status = data.body.gameStatus.toLowerCase();
            
            // Live games - very short cache (check for various live status formats)
            if (status.includes('live') || status.includes('progress') || status.includes('halftime')) {
                return this.liveCacheExpiry;
            }
            
            // Completed games - never expire
            if (['final', 'completed', 'final ot'].includes(status)) {
                return this.historicalCacheExpiry;
            }
            
            // Scheduled games - moderate cache
            if (['scheduled', 'postponed'].includes(status)) {
                return this.scheduledCacheExpiry;
            }
        }
        
        // For live scores endpoint - no cache
        if (endpoint === '/getNFLScores') {
            return 0; // No caching
        }
        
        // Default cache duration
        return this.defaultCacheExpiry;
    }

    // Get cache from SQLite
    async getCachedData(cacheKey) {
        try {
            const cached = await this.db.get(`
                SELECT response_data, expires_at, is_historical 
                FROM tank01_cache 
                WHERE cache_key = ?
            `, [cacheKey]);
            
            if (!cached) {
                return null;
            }
            
            // Update hit count and last accessed
            await this.db.run(`
                UPDATE tank01_cache 
                SET hit_count = hit_count + 1, last_accessed = CURRENT_TIMESTAMP 
                WHERE cache_key = ?
            `, [cacheKey]);
            
            // Check if expired (historical data never expires)
            if (!cached.is_historical && cached.expires_at) {
                const expiresAt = new Date(cached.expires_at).getTime();
                if (Date.now() > expiresAt) {
                    await this.db.run('DELETE FROM tank01_cache WHERE cache_key = ?', [cacheKey]);
                    return null;
                }
            }
            
            logInfo(`Persistent cache hit for ${cacheKey}`);
            return JSON.parse(cached.response_data);
        } catch (error) {
            logError('Error reading from cache', error);
            return null;
        }
    }

    // Save to SQLite cache
    async setCachedData(cacheKey, endpoint, params, data) {
        try {
            // Determine if historical based on actual data
            const isHistorical = this.isHistoricalData(endpoint, params, data);
            
            // Get appropriate cache duration
            const cacheDuration = this.getCacheDuration(endpoint, params, data);
            
            // Skip caching if duration is 0
            if (cacheDuration === 0) {
                logInfo(`Skipping cache for ${cacheKey} (no-cache endpoint)`);
                return;
            }
            
            const expiresAt = isHistorical ? null : 
                new Date(Date.now() + cacheDuration).toISOString();
            
            await this.db.run(`
                INSERT OR REPLACE INTO tank01_cache 
                (cache_key, endpoint, params, response_data, expires_at, is_historical) 
                VALUES (?, ?, ?, ?, ?, ?)
            `, [
                cacheKey,
                endpoint,
                JSON.stringify(params),
                JSON.stringify(data),
                expiresAt,
                isHistorical ? 1 : 0
            ]);
            
            logInfo(`Cached data for ${cacheKey} (historical: ${isHistorical}, duration: ${cacheDuration}ms)`);
        } catch (error) {
            logError('Error saving to cache', error);
        }
    }

    // Generic request method with error handling and caching
    async makeRequest(endpoint, params = {}, cacheKey = null) {
        try {
            // Check cache first
            if (cacheKey) {
                const cachedData = await this.getCachedData(cacheKey);
                if (cachedData) {
                    return cachedData;
                }
            }

            await this.rateLimit();

            logInfo(`Making Tank01 API request to ${endpoint}`, { params });

            const response = await axios.get(`${this.baseURL}${endpoint}`, {
                headers: this.headers,
                params,
                timeout: 30000 // 30 second timeout
            });

            // Cache successful responses
            if (cacheKey && response.data) {
                await this.setCachedData(cacheKey, endpoint, params, response.data);
            }

            logInfo(`Tank01 API request successful`, { 
                endpoint, 
                status: response.status,
                cached: !!cacheKey 
            });

            return response.data;

        } catch (error) {
            if (error.response) {
                // API returned an error response
                logError(`Tank01 API error: ${error.response.status}`, error, {
                    endpoint,
                    params,
                    status: error.response.status,
                    statusText: error.response.statusText,
                    data: error.response.data
                });
                
                if (error.response.status === 429) {
                    logWarn('Rate limit exceeded, implementing exponential backoff');
                    await this.exponentialBackoff();
                }
                
                throw new Error(`Tank01 API error: ${error.response.status} - ${error.response.statusText}`);
            } else if (error.request) {
                // Network error
                logError('Tank01 API network error', error);
                throw new Error('Tank01 API network error - please check your connection');
            } else {
                // Other error
                logError('Tank01 API unexpected error', error);
                throw new Error(`Tank01 API error: ${error.message}`);
            }
        }
    }

    // Exponential backoff for rate limiting
    async exponentialBackoff() {
        const backoffTime = Math.min(1000 * Math.pow(2, this.requestCount % 5), 30000);
        logInfo(`Backing off for ${backoffTime}ms`);
        await new Promise(resolve => setTimeout(resolve, backoffTime));
    }

    // Get all NFL players
    async getPlayerList() {
        try {
            const cacheKey = 'playerList';
            const data = await this.makeRequest('/getNFLPlayerList', {}, cacheKey);
            
            if (!data || !data.body) {
                throw new Error('Invalid player list response from Tank01 API');
            }

            return data.body;
        } catch (error) {
            logError('Failed to fetch player list', error);
            throw error;
        }
    }

    // Get player stats for a specific week
    async getPlayerStats(week, season) {
        try {
            logInfo(`Fetching player stats from Tank01 API for week ${week}, season ${season}`);
            
            // First, get the games for this week to find game IDs
            const gamesData = await this.getNFLGamesForWeek(week, season);
            
            if (!gamesData || typeof gamesData !== 'object') {
                logWarn(`No games data received for week ${week}, season ${season}`);
                return {};
            }
            
            // Tank01 returns games as numbered properties (0, 1, 2, etc.) not as games array
            const allValues = Object.values(gamesData);
            logInfo(`Tank01 games debug:`, {
                totalValues: allValues.length,
                sampleValue: allValues[0] ? Object.keys(allValues[0]).slice(0, 5) : 'no values',
                hasGameID: allValues.some(game => game && game.gameID) ? 'yes' : 'no'
            });
            
            const games = allValues.filter(game => game && typeof game === 'object' && game.gameID);
            
            if (games.length === 0) {
                logWarn(`No games with gameID found for week ${week}, season ${season}`);
                // Log first few values to understand structure
                allValues.slice(0, 2).forEach((value, index) => {
                    logInfo(`Sample game ${index}:`, {
                        type: typeof value,
                        keys: value && typeof value === 'object' ? Object.keys(value).slice(0, 10) : 'not object'
                    });
                });
                return {};
            }
            
            logInfo(`Found ${games.length} games for week ${week}`);
            
            // Get boxscore for each game and combine the results
            const allGameStats = {};
            
            for (const game of games) {
                if (!game.gameID) {
                    logWarn(`Game missing gameID:`, game);
                    continue;
                }
                
                try {
                    logInfo(`Fetching boxscore for game ${game.gameID}`);
                    const boxScoreData = await this.getNFLBoxScore(game.gameID);
                    
                    if (boxScoreData && !boxScoreData.error) {
                        allGameStats[game.gameID] = boxScoreData;
                        logInfo(`Successfully fetched boxscore for game ${game.gameID}`);
                    } else {
                        logWarn(`Error or no data for game ${game.gameID}:`, boxScoreData?.error || 'No data');
                    }
                } catch (gameError) {
                    logWarn(`Failed to fetch boxscore for game ${game.gameID}: ${gameError.message}`);
                }
            }
            
            logInfo(`Successfully fetched boxscores for ${Object.keys(allGameStats).length} games`);
            return allGameStats;
            
        } catch (error) {
            logError(`Failed to fetch player stats for week ${week}, season ${season}`, error);
            throw error;
        }
    }

    // Get NFL games for a specific week (correct Tank01 endpoint)
    async getNFLGamesForWeek(week, season) {
        try {
            const cacheKey = `gamesForWeek_${week}_${season}`;
            const data = await this.makeRequest('/getNFLGamesForWeek', {
                week: week.toString(),
                seasonType: 'reg',
                season: season.toString()
            }, cacheKey);

            if (!data || !data.body) {
                throw new Error('Invalid games response from Tank01 API');
            }

            // Debug: Log the structure of the games response
            logInfo(`Tank01 games response structure:`, {
                dataType: typeof data.body,
                topLevelKeys: data.body ? Object.keys(data.body).slice(0, 10) : 'none',
                hasGames: data.body && data.body.games ? `${data.body.games.length} games` : 'no games property'
            });

            return data.body;
        } catch (error) {
            logError(`Failed to fetch games for week ${week}, season ${season}`, error);
            throw error;
        }
    }

    // Get NFL box score for a specific game (correct Tank01 endpoint)
    async getNFLBoxScore(gameID) {
        try {
            const cacheKey = `boxscore_${gameID}`;
            const data = await this.makeRequest('/getNFLBoxScore', {
                gameID: gameID,
                playByPlay: 'true',
                fantasyPoints: 'true',
                twoPointConversions: '2',
                passYards: '.04',
                passAttempts: '0',
                passTD: '4',
                passCompletions: '0',
                passInterceptions: '-2',
                pointsPerReception: '.5',
                carries: '.2',
                rushYards: '.1',
                rushTD: '6',
                fumbles: '-2',
                receivingYards: '.1',
                receivingTD: '6',
                targets: '0',
                defTD: '6',
                fgMade: '3',
                fgMissed: '-3',
                xpMade: '1',
                xpMissed: '-1',
                idpTotalTackles: '0',
                idpSoloTackles: '0',
                idpTFL: '0',
                idpQbHits: '0',
                idpInt: '0',
                idpSacks: '0',
                idpPassDeflections: '0',
                idpFumblesRecovered: '0'
            }, cacheKey);

            if (!data || !data.body) {
                throw new Error('Invalid box score response from Tank01 API');
            }

            return data.body;
        } catch (error) {
            logError(`Failed to fetch box score for game ${gameID}`, error);
            throw error;
        }
    }

    // Get NFL schedule for a specific week (legacy method, now using getNFLGamesForWeek)
    async getNFLSchedule(week, season) {
        logWarn('getNFLSchedule is deprecated, use getNFLGamesForWeek instead');
        return this.getNFLGamesForWeek(week, season);
    }

    // Get team roster
    async getTeamRoster(teamAbv) {
        try {
            const cacheKey = `roster_${teamAbv}`;
            const data = await this.makeRequest('/getNFLTeamRoster', {
                teamAbv: teamAbv.toUpperCase()
            }, cacheKey);

            if (!data || !data.body) {
                throw new Error('Invalid team roster response from Tank01 API');
            }

            return data.body;
        } catch (error) {
            logError(`Failed to fetch roster for team ${teamAbv}`, error);
            throw error;
        }
    }

    // Get live scores
    async getLiveScores() {
        try {
            // Don't cache live scores as they change frequently
            const data = await this.makeRequest('/getNFLScores');

            if (!data || !data.body) {
                throw new Error('Invalid live scores response from Tank01 API');
            }

            return data.body;
        } catch (error) {
            logError('Failed to fetch live scores', error);
            throw error;
        }
    }

    // Get current NFL week (using a working endpoint)
    async getCurrentWeek() {
        try {
            const cacheKey = 'currentWeek';
            // Use getNFLTeams as a test endpoint since getCurrentWeek doesn't exist
            const data = await this.makeRequest('/getNFLTeams', {}, cacheKey);

            if (!data || !data.body) {
                throw new Error('Invalid current week response from Tank01 API');
            }

            // Return a mock current week for now since this is just for health check
            return { currentWeek: 1, season: 2024 };
        } catch (error) {
            logError('Failed to fetch current week', error);
            throw error;
        }
    }

    // Get team stats
    async getTeamStats(teamAbv, season) {
        try {
            const cacheKey = `teamStats_${teamAbv}_${season}`;
            const data = await this.makeRequest('/getNFLTeamStats', {
                teamAbv: teamAbv.toUpperCase(),
                season: season.toString()
            }, cacheKey);

            if (!data || !data.body) {
                throw new Error('Invalid team stats response from Tank01 API');
            }

            return data.body;
        } catch (error) {
            logError(`Failed to fetch team stats for ${teamAbv}, season ${season}`, error);
            throw error;
        }
    }

    // Get player info
    async getPlayerInfo(playerId) {
        try {
            const cacheKey = `playerInfo_${playerId}`;
            const data = await this.makeRequest('/getNFLPlayerInfo', {
                playerID: playerId
            }, cacheKey);

            if (!data || !data.body) {
                throw new Error('Invalid player info response from Tank01 API');
            }

            return data.body;
        } catch (error) {
            logError(`Failed to fetch player info for ${playerId}`, error);
            throw error;
        }
    }

    // Get standings
    async getStandings(season) {
        try {
            const cacheKey = `standings_${season}`;
            const data = await this.makeRequest('/getNFLStandings', {
                season: season.toString()
            }, cacheKey);

            if (!data || !data.body) {
                throw new Error('Invalid standings response from Tank01 API');
            }

            return data.body;
        } catch (error) {
            logError(`Failed to fetch standings for season ${season}`, error);
            throw error;
        }
    }

    // Utility methods
    async clearCache(onlyExpired = false) {
        try {
            if (onlyExpired) {
                await this.db.run(`
                    DELETE FROM tank01_cache 
                    WHERE is_historical = 0 AND expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP
                `);
                logInfo('Expired cache entries cleared');
            } else {
                await this.db.run('DELETE FROM tank01_cache WHERE is_historical = 0');
                logInfo('Non-historical cache cleared');
            }
        } catch (error) {
            logError('Error clearing cache', error);
        }
    }

    async getCacheStats() {
        try {
            const stats = await this.db.get(`
                SELECT 
                    COUNT(*) as total_entries,
                    SUM(CASE WHEN is_historical = 1 THEN 1 ELSE 0 END) as historical_entries,
                    SUM(CASE WHEN is_historical = 0 THEN 1 ELSE 0 END) as temporary_entries,
                    SUM(hit_count) as total_hits,
                    AVG(hit_count) as avg_hits_per_entry
                FROM tank01_cache
            `);
            
            return {
                totalEntries: stats.total_entries || 0,
                historicalEntries: stats.historical_entries || 0,
                temporaryEntries: stats.temporary_entries || 0,
                totalHits: stats.total_hits || 0,
                avgHitsPerEntry: stats.avg_hits_per_entry || 0
            };
        } catch (error) {
            logError('Error getting cache stats', error);
            return {
                totalEntries: 0,
                historicalEntries: 0,
                temporaryEntries: 0,
                totalHits: 0,
                avgHitsPerEntry: 0
            };
        }
    }
    
    // Get daily stats
    async getDailyStats() {
        await this.loadDailyStats(); // Ensure we have the latest
        return {
            ...this.dailyStats,
            totalRequests: this.requestCount
        };
    }

    getRequestCount() {
        return this.requestCount;
    }

    resetRequestCount() {
        this.requestCount = 0;
        logInfo('Tank01 service request count reset');
    }

    // Health check
    async healthCheck() {
        try {
            const startTime = Date.now();
            await this.getCurrentWeek();
            const responseTime = Date.now() - startTime;
            const cacheStats = await this.getCacheStats();
            const dailyStats = await this.getDailyStats();
            
            return {
                status: 'healthy',
                responseTime: `${responseTime}ms`,
                requestCount: this.requestCount,
                dailyRequests: dailyStats.requests,
                dailyStatsDate: dailyStats.date,
                cacheStats: cacheStats,
                cacheSize: cacheStats.totalEntries
            };
        } catch (error) {
            const cacheStats = await this.getCacheStats();
            return {
                status: 'unhealthy',
                error: error.message,
                requestCount: this.requestCount,
                dailyRequests: this.dailyStats.requests,
                cacheStats: cacheStats,
                cacheSize: cacheStats.totalEntries
            };
        }
    }
}

module.exports = Tank01Service;