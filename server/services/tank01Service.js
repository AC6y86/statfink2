const axios = require('axios');
const { logError, logInfo, logWarn } = require('../utils/errorHandler');

class Tank01Service {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseURL = 'https://tank01-nfl-live-in-game-real-time-statistics-nfl.p.rapidapi.com';
        this.headers = {
            'X-RapidAPI-Key': apiKey,
            'X-RapidAPI-Host': 'tank01-nfl-live-in-game-real-time-statistics-nfl.p.rapidapi.com'
        };
        
        // Rate limiting
        this.lastRequestTime = 0;
        this.minRequestInterval = 1000; // 1 second between requests
        this.requestCount = 0;
        this.maxRequestsPerMinute = 50; // Conservative limit
        
        // Cache for frequently accessed data
        this.cache = new Map();
        this.cacheExpiry = 5 * 60 * 1000; // 5 minutes
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
    }

    // Generic request method with error handling and caching
    async makeRequest(endpoint, params = {}, cacheKey = null) {
        try {
            // Check cache first
            if (cacheKey && this.cache.has(cacheKey)) {
                const cached = this.cache.get(cacheKey);
                if (Date.now() - cached.timestamp < this.cacheExpiry) {
                    logInfo(`Cache hit for ${cacheKey}`);
                    return cached.data;
                } else {
                    this.cache.delete(cacheKey);
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
                this.cache.set(cacheKey, {
                    data: response.data,
                    timestamp: Date.now()
                });
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
            return { currentWeek: 1, season: 2025 };
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
    clearCache() {
        this.cache.clear();
        logInfo('Tank01 service cache cleared');
    }

    getCacheSize() {
        return this.cache.size;
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
            
            return {
                status: 'healthy',
                responseTime: `${responseTime}ms`,
                requestCount: this.requestCount,
                cacheSize: this.cache.size
            };
        } catch (error) {
            return {
                status: 'unhealthy',
                error: error.message,
                requestCount: this.requestCount,
                cacheSize: this.cache.size
            };
        }
    }
}

module.exports = Tank01Service;