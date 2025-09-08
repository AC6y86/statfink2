const puppeteer = require('puppeteer');
const { logError, logInfo } = require('../../../server/utils/errorHandler');

class ESPNLookup {
    constructor(db) {
        this.db = db;
        this.cache = new Map();
        this.browser = null;
    }
    
    async initBrowser() {
        try {
            // Always create a new browser instance for each lookup to avoid connection issues
            if (this.browser) {
                await this.browser.close().catch(() => {});
            }
            this.browser = await puppeteer.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
            });
            return this.browser;
        } catch (error) {
            logError('Failed to launch browser', error);
            return null;
        }
    }
    
    async closeBrowser() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
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
        
        try {
            browser = await this.initBrowser();
            if (!browser) {
                logError('Could not launch browser');
                return 'unknown';
            }
            
            page = await browser.newPage();
            
            // Set a reasonable viewport
            await page.setViewport({ width: 1280, height: 800 });
            
            const espnUrl = `https://www.espn.com/nfl/player/_/id/${playerId}`;
            
            // Navigate to player page
            await page.goto(espnUrl, { 
                waitUntil: 'networkidle2', 
                timeout: 30000 
            });
            
            // Check if page loaded successfully
            const pageTitle = await page.title();
            if (pageTitle.includes('Page not found') || pageTitle.includes('404')) {
                logInfo(`ESPN page not found for player ${playerId}`);
                await page.close();
                const status = 'unknown';
                await this.cacheStatus(playerId, week, season, status);
                return status;
            }
            
            // Get player name from page to verify we have the right player
            const espnPlayerName = await page.$eval('.PlayerHeader__Name', el => el.textContent.trim())
                .catch(() => null);
            
            if (espnPlayerName) {
                logInfo(`ESPN player name: ${espnPlayerName}`);
            }
            
            // Check for injury/suspension status in header
            const headerStatus = await page.$eval('.PlayerHeader__Status', el => el.textContent.trim())
                .catch(() => null);
            
            if (headerStatus) {
                logInfo(`ESPN header status: ${headerStatus}`);
                if (headerStatus.toLowerCase().includes('suspended')) {
                    await page.close();
                    const status = 'suspended';
                    await this.cacheStatus(playerId, week, season, status);
                    return status;
                }
                if (headerStatus.toLowerCase().includes('injured reserve') || 
                    headerStatus.toLowerCase().includes('ir')) {
                    await page.close();
                    const status = 'injured';
                    await this.cacheStatus(playerId, week, season, status);
                    return status;
                }
            }
            
            // Try to find game log for the specific week
            // Look for game log table
            const hasGameLog = await page.$('.Table__Scroller').catch(() => false);
            
            if (hasGameLog) {
                // Get all game log rows
                const gameLogData = await page.$$eval('.Table__TR', rows => {
                    return rows.map(row => {
                        const cells = row.querySelectorAll('.Table__TD');
                        return Array.from(cells).map(cell => cell.textContent.trim());
                    });
                }).catch(() => []);
                
                // Look for indicators of not playing
                const inactiveIndicators = ['DNP', 'Did Not Play', 'Inactive', '--', 'N/A'];
                const suspendedIndicators = ['SUSP', 'Suspended'];
                
                for (const row of gameLogData) {
                    const rowText = row.join(' ');
                    
                    // Check for suspended
                    for (const indicator of suspendedIndicators) {
                        if (rowText.includes(indicator)) {
                            await page.close();
                            const status = 'suspended';
                            await this.cacheStatus(playerId, week, season, status);
                            return status;
                        }
                    }
                    
                    // Check for inactive/DNP
                    for (const indicator of inactiveIndicators) {
                        if (rowText.includes(indicator)) {
                            await page.close();
                            const status = 'inactive';
                            await this.cacheStatus(playerId, week, season, status);
                            return status;
                        }
                    }
                    
                    // If we see stats (passing yards, rushing yards, etc), player was active
                    // Look for typical stat patterns (numbers followed by yards/TDs)
                    if (/\d+\s*(yds|yards|TD|rec|att|com)/i.test(rowText)) {
                        // Player has stats, so they played
                        await page.close();
                        const status = 'active';
                        await this.cacheStatus(playerId, week, season, status);
                        return status;
                    }
                }
            }
            
            // Check recent news section for injury/inactive reports
            const newsSection = await page.$$eval('.News__Item', items => {
                return items.map(item => item.textContent.toLowerCase()).join(' ');
            }).catch(() => '');
            
            if (newsSection.includes('inactive') || newsSection.includes('did not play')) {
                await page.close();
                const status = 'inactive';
                await this.cacheStatus(playerId, week, season, status);
                return status;
            }
            
            if (newsSection.includes('suspended')) {
                await page.close();
                const status = 'suspended';
                await this.cacheStatus(playerId, week, season, status);
                return status;
            }
            
            await page.close();
            
            // If we can't determine status, mark as unknown
            const status = 'unknown';
            await this.cacheStatus(playerId, week, season, status);
            return status;
            
        } catch (error) {
            logError(`Error fetching ESPN status for ${playerName}`, error);
            return 'unknown';
        } finally {
            // Always clean up resources
            if (page) {
                await page.close().catch(() => {});
            }
            if (browser) {
                await browser.close().catch(() => {});
            }
            this.browser = null;
        }
    }
    
    /**
     * Batch check multiple players
     */
    async checkMultiplePlayers(players, week, season) {
        const results = [];
        
        try {
            await this.initBrowser();
            
            for (const player of players) {
                const status = await this.fetchPlayerStatus(
                    player.player_id,
                    player.player_name,
                    week,
                    season
                );
                
                results.push({
                    ...player,
                    espn_status: status
                });
                
                // Small delay between requests to be respectful
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
        } finally {
            await this.closeBrowser();
        }
        
        return results;
    }
}

module.exports = ESPNLookup;