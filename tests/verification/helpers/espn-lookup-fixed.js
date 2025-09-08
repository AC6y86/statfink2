const puppeteer = require('puppeteer');
const { logError, logInfo } = require('../../../server/utils/errorHandler');

class ESPNLookup {
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
     * Fetch player status from ESPN
     * Returns: 'active', 'inactive', 'suspended', 'injured', 'dnp', 'backup', or 'unknown'
     */
    async fetchPlayerStatus(playerId, playerName, week, season) {
        // Check cache first
        const cached = await this.getCachedStatus(playerId, week, season);
        if (cached) {
            logInfo(`Using cached ESPN status for ${playerName}: ${cached}`);
            return cached;
        }
        
        logInfo(`Fetching ESPN status for ${playerName} (${playerId}) - Week ${week}, Season ${season}`);
        
        let browser = null;
        let page = null;
        let status = 'unknown';
        
        try {
            // Launch browser with proper settings
            browser = await puppeteer.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage'
                ]
            });
            
            page = await browser.newPage();
            
            // Set timeout and viewport
            page.setDefaultTimeout(10000);
            await page.setViewport({ width: 1280, height: 800 });
            
            const espnUrl = `https://www.espn.com/nfl/player/_/id/${playerId}`;
            
            // Navigate to player page with error handling
            try {
                await page.goto(espnUrl, { 
                    waitUntil: 'domcontentloaded',
                    timeout: 10000 
                });
            } catch (navError) {
                logError(`Navigation error for ${playerName}`, navError);
                status = 'unknown';
                await this.cacheStatus(playerId, week, season, status);
                return status;
            }
            
            // Quick check if page loaded successfully
            const pageTitle = await page.title().catch(() => '');
            if (pageTitle.includes('Page not found') || pageTitle.includes('404')) {
                logInfo(`ESPN page not found for player ${playerId}`);
                status = 'unknown';
                await this.cacheStatus(playerId, week, season, status);
                return status;
            }
            
            // Try to get player name to verify
            const espnPlayerName = await page.$eval('.PlayerHeader__Name', el => el.textContent.trim())
                .catch(() => null);
            
            if (espnPlayerName) {
                logInfo(`Found ESPN player: ${espnPlayerName}`);
            }
            
            // Check for injury/suspension status in header (quick check)
            const headerStatus = await page.$eval('.PlayerHeader__Status', el => el.textContent.trim())
                .catch(() => null);
            
            if (headerStatus) {
                const statusLower = headerStatus.toLowerCase();
                if (statusLower.includes('suspended')) {
                    status = 'suspended';
                } else if (statusLower.includes('injured reserve') || statusLower.includes('ir')) {
                    status = 'injured';
                } else if (statusLower.includes('out')) {
                    status = 'inactive';
                }
                
                if (status !== 'unknown') {
                    await this.cacheStatus(playerId, week, season, status);
                    return status;
                }
            }
            
            // Check for "This Game" row which indicates player participated
            const gameStatus = await page.evaluate(() => {
                const rows = document.querySelectorAll('.Table__TR');
                
                for (let row of rows) {
                    const text = row.textContent || '';
                    
                    // Check for "This Game" which ESPN shows for current week stats
                    if (text.includes('This Game')) {
                        // Get the cells to see if there are actual stats
                        const cells = row.querySelectorAll('.Table__TD');
                        if (cells.length > 3) {
                            // Check if there are non-zero stats
                            for (let cell of cells) {
                                const cellText = cell.textContent.trim();
                                // If we find numbers greater than 0, player was active
                                if (/^[1-9]\d*/.test(cellText)) {
                                    return 'active';
                                }
                            }
                            // Has "This Game" row but all zeros - might be backup
                            return 'backup';
                        }
                    }
                    
                    // Check for DNP/Inactive indicators
                    if (text.includes('DNP') || text.includes('Inactive') || text.includes('Did Not Play')) {
                        return 'inactive';
                    }
                    
                    // Check for suspension
                    if (text.includes('SUSP') || text.includes('Suspended')) {
                        return 'suspended';
                    }
                }
                
                // No "This Game" row found - player likely didn't play
                return 'dnp';
            }).catch((err) => {
                logInfo(`Error checking game status: ${err.message}`);
                return null;
            });
            
            if (gameStatus && gameStatus !== 'dnp') {
                status = gameStatus;
                logInfo(`ESPN game status for ${playerName}: ${status}`);
            } else if (gameStatus === 'dnp') {
                // No "This Game" row means player didn't play
                status = 'inactive';
                logInfo(`No 'This Game' data for ${playerName} - marking as inactive`);
            }
            
            await this.cacheStatus(playerId, week, season, status);
            return status;
            
        } catch (error) {
            logError(`Error fetching ESPN status for ${playerName}`, error);
            return 'unknown';
        } finally {
            // Clean up resources
            if (page) {
                await page.close().catch(() => {});
            }
            if (browser) {
                await browser.close().catch(() => {});
            }
        }
    }
    
    async closeBrowser() {
        // No persistent browser to close
    }
}

module.exports = ESPNLookup;