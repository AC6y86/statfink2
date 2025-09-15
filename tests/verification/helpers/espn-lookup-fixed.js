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
                // Try to parse as JSON first (new format)
                try {
                    const parsed = JSON.parse(cached.status);
                    this.cache.set(cacheKey, parsed);
                    return parsed;
                } catch (e) {
                    // Fall back to string format (old cached data)
                    this.cache.set(cacheKey, cached.status);
                    return cached.status;
                }
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
     * Returns: object with status and stats
     * status: 'active', 'inactive', 'suspended', 'injured', 'dnp', 'backup', or 'unknown'
     * stats: object with actual game stats if available
     */
    async fetchPlayerStatus(playerId, playerName, week, season) {
        // Check cache first
        const cached = await this.getCachedStatus(playerId, week, season);
        if (cached) {
            logInfo(`Using cached ESPN status for ${playerName}: ${cached}`);
            // For backward compatibility, if cached is a string, return it in object form
            if (typeof cached === 'string') {
                return { status: cached, stats: null };
            }
            return cached;
        }
        
        logInfo(`Fetching ESPN status for ${playerName} (${playerId}) - Week ${week}, Season ${season}`);
        
        let browser = null;
        let page = null;
        let status = 'unknown';
        let playerStats = null;

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
                const result = { status: 'unknown', stats: null };
                await this.cacheStatus(playerId, week, season, JSON.stringify(result));
                return result;
            }

            // Quick check if page loaded successfully
            const pageTitle = await page.title().catch(() => '');
            if (pageTitle.includes('Page not found') || pageTitle.includes('404')) {
                logInfo(`ESPN page not found for player ${playerId}`);
                const result = { status: 'unknown', stats: null };
                await this.cacheStatus(playerId, week, season, JSON.stringify(result));
                return result;
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
                    const result = { status, stats: null };
                    await this.cacheStatus(playerId, week, season, JSON.stringify(result));
                    return result;
                }
            }
            
            // Check for specific week's game in the game log
            const gameData = await page.evaluate((targetWeek) => {
                const rows = document.querySelectorAll('.Table__TR');
                let result = { status: 'dnp', stats: null };

                // Week to month/day mapping for 2025 season
                // ESPN might show dates in different formats
                const week2025Dates = {
                    1: ['9/4', '9/5', '9/6', '9/7', '9/8', 'Sep 4', 'Sep 5', 'Sep 6', 'Sep 7', 'Sep 8'],
                    2: ['9/11', '9/12', '9/13', '9/14', '9/15', 'Sep 11', 'Sep 12', 'Sep 13', 'Sep 14', 'Sep 15'],
                    3: ['9/18', '9/19', '9/20', '9/21', '9/22', 'Sep 18', 'Sep 19', 'Sep 20', 'Sep 21', 'Sep 22'],
                    // Add more weeks as needed
                };

                for (let row of rows) {
                    const text = row.textContent || '';

                    // First check if this row contains a date that matches our target week
                    let isTargetWeek = false;

                    // Check for week-specific dates
                    if (week2025Dates[targetWeek]) {
                        for (const date of week2025Dates[targetWeek]) {
                            if (text.includes(date)) {
                                isTargetWeek = true;
                                break;
                            }
                        }
                    }

                    // Also check for "This Game" but only use it as a fallback
                    // and note that it might be the wrong week
                    const isThisGame = text.includes('This Game');

                    // Only process if we found the target week
                    // Don't use "This Game" as it often shows wrong week
                    if (isTargetWeek) {
                        // Get the cells to extract actual stats
                        const cells = row.querySelectorAll('.Table__TD');
                        if (cells.length > 3) {
                            const stats = {};
                            let hasNonZeroStats = false;

                            // Note which week we found
                            stats.weekFound = targetWeek;

                            // Extract text from all cells for debugging
                            const cellTexts = Array.from(cells).map(c => c.textContent.trim());

                            // Store raw cell texts for debugging
                            stats.rawCells = cellTexts.join(' | ');

                            // Check if this is a date-based row (starts with date like "Sun 9/14")
                            // Format: Date | Opponent | Result | ATT | YDS | AVG | TD | LONG
                            if (cellTexts[0] && (cellTexts[0].includes('/') || cellTexts[0].includes('Sep'))) {
                                // This is a date-based row, stats start at index 3
                                if (cells.length === 8) {
                                    // RB rushing stats only
                                    // Index 0: Date, 1: Opponent, 2: Result, 3: ATT, 4: YDS, 5: AVG, 6: TD, 7: LONG
                                    stats.carries = parseInt(cellTexts[3]) || 0;
                                    stats.rushYards = parseInt(cellTexts[4]) || 0;
                                    stats.rushTD = parseInt(cellTexts[6]) || 0;
                                    // No receiving stats in this format
                                    stats.receptions = 0;
                                    stats.recYards = 0;
                                    stats.recTD = 0;
                                } else if (cells.length >= 10) {
                                    // Full RB stats with rushing and receiving
                                    // Rushing starts at index 3
                                    stats.carries = parseInt(cellTexts[3]) || 0;
                                    stats.rushYards = parseInt(cellTexts[4]) || 0;
                                    stats.rushTD = parseInt(cellTexts[6]) || 0;

                                    // Receiving might start at index 8 or later
                                    if (cellTexts[8] && !isNaN(parseInt(cellTexts[8]))) {
                                        stats.receptions = parseInt(cellTexts[8]) || 0;
                                        stats.recYards = parseInt(cellTexts[9]) || 0;
                                        stats.recTD = parseInt(cellTexts[11]) || 0;
                                    } else {
                                        stats.receptions = 0;
                                        stats.recYards = 0;
                                        stats.recTD = 0;
                                    }
                                }
                            } else if (cells.length >= 10) {
                                // Non-date row format (possibly "This Game" format)
                                // Try to extract stats based on common ESPN table layouts
                                if (cellTexts[1] && cellTexts[1].match(/^\d+$/)) {
                                    // Check if it looks like RB stats (has carries)
                                    const att = parseInt(cellTexts[1]);
                                    if (att > 0 && cellTexts[2] && cellTexts[3]) {
                                        // Rushing stats
                                        stats.carries = att;
                                        stats.rushYards = parseInt(cellTexts[2]) || 0;
                                        stats.rushTD = parseInt(cellTexts[4]) || 0;

                                        // Receiving stats for RBs
                                        if (cellTexts[6] && !isNaN(parseInt(cellTexts[6]))) {
                                            stats.receptions = parseInt(cellTexts[6]) || 0;
                                            stats.recYards = parseInt(cellTexts[7]) || 0;
                                            stats.recTD = parseInt(cellTexts[9]) || 0;
                                        }
                                    }
                                } else if (cellTexts[1] && cellTexts[1].includes('/')) {
                                    // QB stats (C/ATT format)
                                    const [comp, att] = cellTexts[1].split('/').map(n => parseInt(n) || 0);
                                    stats.completions = comp;
                                    stats.attempts = att;
                                    stats.passYards = parseInt(cellTexts[2]) || 0;
                                    stats.passTD = parseInt(cellTexts[3]) || 0;
                                    stats.interceptions = parseInt(cellTexts[4]) || 0;
                                }
                            }

                            // Check if there are non-zero stats
                            for (let i = 3; i < cells.length; i++) {
                                const cellText = cells[i].textContent.trim();
                                if (/^[1-9]\d*/.test(cellText)) {
                                    hasNonZeroStats = true;
                                    break;
                                }
                            }

                            if (hasNonZeroStats) {
                                result.status = 'active';
                                result.stats = stats;
                            } else {
                                // Has row but all zeros - might be backup
                                result.status = 'backup';
                                result.stats = stats;
                            }
                        }
                        return result;
                    }

                    // Check for DNP/Inactive indicators
                    if (text.includes('DNP') || text.includes('Inactive') || text.includes('Did Not Play')) {
                        result.status = 'inactive';
                        return result;
                    }

                    // Check for suspension
                    if (text.includes('SUSP') || text.includes('Suspended')) {
                        result.status = 'suspended';
                        return result;
                    }
                }

                return result;
            }, week).catch((err) => {
                logInfo(`Error checking game status: ${err.message}`);
                return { status: null, stats: null };
            });

            if (gameData && gameData.status) {
                status = gameData.status;
                playerStats = gameData.stats;

                if (status === 'dnp') {
                    // No game data found for the specific week
                    status = 'inactive';
                    logInfo(`No game data found for ${playerName} in week ${week} - marking as inactive`);
                } else {
                    logInfo(`ESPN game status for ${playerName} week ${week}: ${status}`);
                    if (playerStats) {
                        // Log if we found data for the expected week
                        if (playerStats.weekFound === week) {
                            logInfo(`ESPN stats for ${playerName} week ${week}: ${JSON.stringify(playerStats)}`);
                        } else {
                            logInfo(`WARNING: ESPN returned stats but week mismatch for ${playerName}`);
                        }
                    }
                }
            }

            const result = { status, stats: playerStats };
            await this.cacheStatus(playerId, week, season, JSON.stringify(result));
            return result;
            
        } catch (error) {
            logError(`Error fetching ESPN status for ${playerName}`, error);
            return { status: 'unknown', stats: null };
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