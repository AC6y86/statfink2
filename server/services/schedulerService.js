const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { logInfo, logError, logWarn } = require('../utils/errorHandler');

class SchedulerService {
    constructor(db, nflGamesService, playerSyncService, scoringService, standingsService) {
        this.db = db;
        this.nflGamesService = nflGamesService;
        this.playerSyncService = playerSyncService;
        this.scoringService = scoringService;
        this.standingsService = standingsService;
        
        // Track last run times
        this.lastDailyUpdate = null;
        this.lastWeeklyUpdate = null;
        this.lastLiveUpdate = null;
        
        // Track if operations are in progress
        this.dailyUpdateInProgress = false;
        this.weeklyUpdateInProgress = false;
        this.liveUpdateInProgress = false;
        
        // Load timestamps from database on initialization
        this.loadTimestampsFromDB();
    }
    
    async loadTimestampsFromDB() {
        try {
            const timestamps = await this.db.getSchedulerTimestamps();
            if (timestamps) {
                this.lastDailyUpdate = timestamps.last_daily_update ? new Date(timestamps.last_daily_update) : null;
                this.lastWeeklyUpdate = timestamps.last_weekly_update ? new Date(timestamps.last_weekly_update) : null;
                this.lastLiveUpdate = timestamps.last_live_update ? new Date(timestamps.last_live_update) : null;
                logInfo('Loaded scheduler timestamps from database', {
                    lastDailyUpdate: this.lastDailyUpdate,
                    lastWeeklyUpdate: this.lastWeeklyUpdate,
                    lastLiveUpdate: this.lastLiveUpdate
                });
            }
        } catch (error) {
            logWarn('Could not load scheduler timestamps from database', error);
        }
    }

    /**
     * Perform daily update operations (6am tasks)
     * - Update game schedule
     * - Backup database
     * - Update NFL rosters/injuries
     */
    async performDailyUpdate() {
        if (this.dailyUpdateInProgress) {
            logWarn('Daily update already in progress');
            return { success: false, message: 'Daily update already in progress' };
        }

        this.dailyUpdateInProgress = true;
        const startTime = Date.now();
        const results = {
            gameSchedule: false,
            backup: false,
            rosters: false,
            errors: []
        };

        try {
            logInfo('Starting daily update operations');

            // 1. Update game schedule
            try {
                const currentSettings = await this.getCurrentSettings();
                if (currentSettings.current_week && currentSettings.season_year) {
                    const gamesResult = await this.nflGamesService.syncWeekGames(
                        currentSettings.current_week, 
                        currentSettings.season_year
                    );
                    results.gameSchedule = gamesResult.success;
                    if (!gamesResult.success) {
                        results.errors.push(`Game schedule: ${gamesResult.message}`);
                    }
                } else {
                    results.errors.push('Game schedule: Week/season not set');
                }
            } catch (error) {
                logError('Failed to update game schedule', error);
                results.errors.push(`Game schedule: ${error.message}`);
            }

            // 2. Backup database
            try {
                const backupResult = await this.backupDatabase();
                results.backup = backupResult.success;
                if (!backupResult.success) {
                    results.errors.push(`Backup: ${backupResult.message}`);
                }
            } catch (error) {
                logError('Failed to backup database', error);
                results.errors.push(`Backup: ${error.message}`);
            }

            // 3. Update NFL rosters/injuries
            try {
                const rostersResult = await this.playerSyncService.syncPlayers();
                results.rosters = rostersResult.success;
                if (!rostersResult.success) {
                    results.errors.push(`Rosters: ${rostersResult.error}`);
                }
            } catch (error) {
                logError('Failed to update rosters', error);
                results.errors.push(`Rosters: ${error.message}`);
            }

            this.lastDailyUpdate = new Date();
            await this.db.updateSchedulerTimestamp('daily');
            const duration = Date.now() - startTime;

            logInfo('Daily update completed', {
                duration: `${duration}ms`,
                results,
                timestamp: this.lastDailyUpdate
            });

            return {
                success: true,
                message: 'Daily update completed',
                duration,
                results,
                timestamp: this.lastDailyUpdate
            };

        } catch (error) {
            logError('Daily update failed', error);
            return {
                success: false,
                message: error.message,
                results,
                duration: Date.now() - startTime
            };
        } finally {
            this.dailyUpdateInProgress = false;
        }
    }

    /**
     * Perform weekly update operations (when games end)
     * - Create standings
     * - Advance week number
     */
    async performWeeklyUpdate() {
        if (this.weeklyUpdateInProgress) {
            logWarn('Weekly update already in progress');
            return { success: false, message: 'Weekly update already in progress' };
        }

        this.weeklyUpdateInProgress = true;
        const startTime = Date.now();
        const results = {
            standings: false,
            weekAdvance: false,
            errors: []
        };

        try {
            logInfo('Starting weekly update operations');

            const currentSettings = await this.getCurrentSettings();
            if (!currentSettings.current_week || !currentSettings.season_year) {
                return {
                    success: false,
                    message: 'Current week/season not set',
                    results
                };
            }

            // Check if all games are complete
            const gamesComplete = await this.nflGamesService.areAllWeekGamesComplete(
                currentSettings.current_week,
                currentSettings.season_year
            );

            if (!gamesComplete.isComplete) {
                return {
                    success: false,
                    message: `Not all games complete (${gamesComplete.completedGames}/${gamesComplete.totalGames})`,
                    results,
                    gamesStatus: gamesComplete
                };
            }

            // 1. Create standings
            try {
                const standingsResult = await this.standingsService.calculateWeeklyStandings(
                    currentSettings.current_week,
                    currentSettings.season_year
                );
                results.standings = standingsResult.success;
                if (!standingsResult.success) {
                    results.errors.push(`Standings: ${standingsResult.message}`);
                }
            } catch (error) {
                logError('Failed to create standings', error);
                results.errors.push(`Standings: ${error.message}`);
            }

            // 2. Advance week
            try {
                const advanceResult = await this.advanceWeek();
                results.weekAdvance = advanceResult.success;
                if (!advanceResult.success) {
                    results.errors.push(`Week advance: ${advanceResult.message}`);
                }
            } catch (error) {
                logError('Failed to advance week', error);
                results.errors.push(`Week advance: ${error.message}`);
            }

            this.lastWeeklyUpdate = new Date();
            await this.db.updateSchedulerTimestamp('weekly');
            const duration = Date.now() - startTime;

            logInfo('Weekly update completed', {
                duration: `${duration}ms`,
                results,
                timestamp: this.lastWeeklyUpdate
            });

            return {
                success: true,
                message: 'Weekly update completed',
                duration,
                results,
                timestamp: this.lastWeeklyUpdate
            };

        } catch (error) {
            logError('Weekly update failed', error);
            return {
                success: false,
                message: error.message,
                results,
                duration: Date.now() - startTime
            };
        } finally {
            this.weeklyUpdateInProgress = false;
        }
    }

    /**
     * Perform live game update operations (every minute during games)
     * - Update game scores
     * - Calculate defensive bonuses if all games complete
     */
    async performLiveGameUpdate() {
        if (this.liveUpdateInProgress) {
            logWarn('Live update already in progress');
            return { success: false, message: 'Live update already in progress' };
        }

        this.liveUpdateInProgress = true;
        const startTime = Date.now();
        const results = {
            gameScores: false,
            defensiveBonuses: false,
            gamesInProgress: 0,
            errors: []
        };

        try {
            logInfo('Starting live game update operations');

            const currentSettings = await this.getCurrentSettings();
            if (!currentSettings.current_week || !currentSettings.season_year) {
                return {
                    success: false,
                    message: 'Current week/season not set',
                    results
                };
            }

            // 1. Update game scores
            try {
                const scoresResult = await this.nflGamesService.updateLiveScores(
                    currentSettings.current_week,
                    currentSettings.season_year
                );
                results.gameScores = scoresResult.success;
                results.gamesInProgress = scoresResult.liveGames || 0;
                if (!scoresResult.success) {
                    results.errors.push(`Game scores: ${scoresResult.message}`);
                }
            } catch (error) {
                logError('Failed to update game scores', error);
                results.errors.push(`Game scores: ${error.message}`);
            }

            // 2. Check if all games are complete and calculate defensive bonuses
            try {
                const gamesComplete = await this.nflGamesService.areAllWeekGamesComplete(
                    currentSettings.current_week,
                    currentSettings.season_year
                );

                if (gamesComplete.isComplete) {
                    const bonusResult = await this.scoringService.calculateDefensiveBonuses(
                        currentSettings.current_week,
                        currentSettings.season_year
                    );
                    results.defensiveBonuses = bonusResult.success;
                    if (!bonusResult.success) {
                        results.errors.push(`Defensive bonuses: ${bonusResult.message}`);
                    }
                }
            } catch (error) {
                logError('Failed to calculate defensive bonuses', error);
                results.errors.push(`Defensive bonuses: ${error.message}`);
            }

            this.lastLiveUpdate = new Date();
            await this.db.updateSchedulerTimestamp('live');
            const duration = Date.now() - startTime;

            logInfo('Live game update completed', {
                duration: `${duration}ms`,
                results,
                timestamp: this.lastLiveUpdate
            });

            return {
                success: true,
                message: 'Live game update completed',
                duration,
                results,
                timestamp: this.lastLiveUpdate
            };

        } catch (error) {
            logError('Live game update failed', error);
            return {
                success: false,
                message: error.message,
                results,
                duration: Date.now() - startTime
            };
        } finally {
            this.liveUpdateInProgress = false;
        }
    }

    /**
     * Backup the database file using SQLite3's .backup command
     */
    async backupDatabase() {
        try {
            const sourcePath = path.join(__dirname, '../../fantasy_football.db');
            const backupDir = '/home/joepaley/backups';
            
            // Ensure backup directory exists
            await fs.mkdir(backupDir, { recursive: true });
            
            // Create backup filename with date
            const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
            const backupPath = path.join(backupDir, `fantasy_football_${date}.db`);
            
            // Use SQLite3's .backup command for a safe, consistent backup
            const command = `sqlite3 "${sourcePath}" ".backup '${backupPath}'"`;
            
            const { stdout, stderr } = await execAsync(command);
            
            if (stderr) {
                throw new Error(`SQLite backup error: ${stderr}`);
            }
            
            logInfo(`Database backed up to ${backupPath}`);
            
            return {
                success: true,
                message: `Database backed up to ${backupPath}`,
                backupPath
            };
        } catch (error) {
            logError('Database backup failed', error);
            return {
                success: false,
                message: error.message
            };
        }
    }

    /**
     * Advance the week number (never advance season)
     */
    async advanceWeek() {
        try {
            const currentSettings = await this.getCurrentSettings();
            
            if (!currentSettings.current_week) {
                return {
                    success: false,
                    message: 'Current week not set'
                };
            }

            const newWeek = currentSettings.current_week + 1;
            
            // Don't advance beyond week 18
            if (newWeek > 18) {
                return {
                    success: false,
                    message: 'Cannot advance beyond week 18'
                };
            }

            // Update the week in league_settings
            await this.db.run(
                'UPDATE league_settings SET current_week = ? WHERE league_id = 1',
                [newWeek]
            );

            logInfo(`Advanced to week ${newWeek}`);

            return {
                success: true,
                message: `Advanced to week ${newWeek}`,
                previousWeek: currentSettings.current_week,
                newWeek
            };
        } catch (error) {
            logError('Failed to advance week', error);
            return {
                success: false,
                message: error.message
            };
        }
    }

    /**
     * Get current league settings
     */
    async getCurrentSettings() {
        try {
            const settings = await this.db.get(
                'SELECT current_week, season_year FROM league_settings WHERE league_id = 1'
            );
            return settings || {};
        } catch (error) {
            logError('Failed to get current settings', error);
            return {};
        }
    }

    /**
     * Get scheduler status
     */
    getStatus() {
        return {
            lastDailyUpdate: this.lastDailyUpdate,
            lastWeeklyUpdate: this.lastWeeklyUpdate,
            lastLiveUpdate: this.lastLiveUpdate,
            dailyUpdateInProgress: this.dailyUpdateInProgress,
            weeklyUpdateInProgress: this.weeklyUpdateInProgress,
            liveUpdateInProgress: this.liveUpdateInProgress
        };
    }
}

module.exports = SchedulerService;