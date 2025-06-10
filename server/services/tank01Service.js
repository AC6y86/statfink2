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
            const cacheKey = `playerStats_${week}_${season}`;
            const data = await this.makeRequest('/getNFLBoxScore', {
                week: week.toString(),
                season: season.toString(),
                gameID: 'all'
            }, cacheKey);

            if (!data || !data.body) {
                throw new Error('Invalid player stats response from Tank01 API');
            }

            return data.body;
        } catch (error) {
            logError(`Failed to fetch player stats for week ${week}, season ${season}`, error);
            throw error;
        }
    }

    // Get NFL schedule for a specific week
    async getNFLSchedule(week, season) {
        try {
            const cacheKey = `schedule_${week}_${season}`;
            const data = await this.makeRequest('/getNFLSchedule', {
                week: week.toString(),
                season: season.toString()
            }, cacheKey);

            if (!data || !data.body) {
                throw new Error('Invalid schedule response from Tank01 API');
            }

            return data.body;
        } catch (error) {
            logError(`Failed to fetch schedule for week ${week}, season ${season}`, error);
            throw error;
        }
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