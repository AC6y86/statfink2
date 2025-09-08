const puppeteer = require('puppeteer');
const { logError, logInfo } = require('../../../server/utils/errorHandler');

class ESPNLookupSimple {
    constructor(db) {
        this.db = db;
        this.cache = new Map();
    }
    
    /**
     * Check if we have a cached status for this player/week
     */
    async getCachedStatus(playerId, week, season) {
        const cacheKey = `${playerId}_${week}_${season}`;
        
        // Check memory cache first
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }
        
        // Check database cache
        try {
            const cached = await this.db.get(`
                SELECT status, checked_at 
                FROM espn_player_status 
                WHERE player_id = ? AND week = ? AND season = ?
                AND datetime(checked_at) > datetime('now', '-7 days')
            `, [playerId, week, season]);
            
            if (cached) {
                this.cache.set(cacheKey, cached.status);
                return cached.status;
            }
        } catch (error) {
            // Table might not exist yet, that's ok
        }
        
        return null;
    }
    
    /**
     * Save status to cache
     */
    async cacheStatus(playerId, week, season, status) {
        const cacheKey = `${playerId}_${week}_${season}`;
        this.cache.set(cacheKey, status);
        
        // Try to save to database
        try {
            // Create table if it doesn't exist
            await this.db.run(`
                CREATE TABLE IF NOT EXISTS espn_player_status (
                    player_id TEXT,
                    week INTEGER,
                    season INTEGER,
                    status TEXT,
                    checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (player_id, week, season)
                )
            `);
            
            await this.db.run(`
                INSERT OR REPLACE INTO espn_player_status 
                (player_id, week, season, status, checked_at)
                VALUES (?, ?, ?, ?, datetime('now'))
            `, [playerId, week, season, status]);
        } catch (error) {
            logError('Error caching ESPN status', error);
        }
    }
    
    /**
     * Fetch player status from ESPN - simplified version
     * Returns: 'active', 'inactive', 'suspended', 'injured', 'dnp', 'backup', or 'unknown'
     */
    async fetchPlayerStatus(playerId, playerName, week, season) {
        // Check cache first
        const cached = await this.getCachedStatus(playerId, week, season);
        if (cached) {
            logInfo(`Using cached ESPN status for ${playerName}: ${cached}`);
            return cached;
        }
        
        // For now, return unknown to avoid browser issues during testing
        // In production, this would do the actual ESPN lookup
        logInfo(`ESPN lookup disabled for testing - returning unknown for ${playerName}`);
        const status = 'unknown';
        await this.cacheStatus(playerId, week, season, status);
        return status;
    }
    
    async closeBrowser() {
        // No browser to close in simplified version
    }
}

module.exports = ESPNLookupSimple;