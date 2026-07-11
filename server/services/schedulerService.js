const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { logInfo, logError, logWarn } = require('../utils/errorHandler');

class SchedulerService {
    constructor(db, nflGamesService, playerSyncService, scoringService, standingsService, teamScoreService, scoringPlayersService, weeklyReportService, fantasyPointsCalculationService, healthCheckService = null) {
        this.db = db;
        this.nflGamesService = nflGamesService;
        this.playerSyncService = playerSyncService;
        this.scoringService = scoringService;
        this.standingsService = standingsService;
        this.teamScoreService = teamScoreService;
        this.scoringPlayersService = scoringPlayersService;
        this.weeklyReportService = weeklyReportService;
        this.fantasyPointsCalculationService = fantasyPointsCalculationService;
        this.healthCheckService = healthCheckService;
        
        // Track last run times
        this.lastDailyUpdate = null;
        this.lastWeeklyUpdate = null;
        this.lastLiveUpdate = null;
        
        // Track if operations are in progress
        this.dailyUpdateInProgress = false;
        this.weeklyUpdateInProgress = false;
        this.liveUpdateInProgress = false;
        
        // Real-time scoring properties
        this.realTimeInterval = null;
        this.realTimeIntervalMinutes = 5;
        this.realTimeEnabled = false;
        
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
            weeklyReport: false,
            errors: []
        };

        try {
            logInfo('Starting daily update operations');

            // 1. Backup database FIRST, before any sync mutates the DB - every
            // backup then captures pre-sync state, so recovery from a botched
            // sync is "restore backup + re-run sync"
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

            // 2. Update game schedule
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

            // 4. Generate weekly report
            try {
                const currentSettings = await this.getCurrentSettings();
                if (currentSettings.current_week && currentSettings.season_year) {
                    const reportResult = await this.weeklyReportService.generateWeeklyReport(
                        currentSettings.current_week,
                        currentSettings.season_year
                    );
                    results.weeklyReport = reportResult.success;
                    if (!reportResult.success) {
                        results.errors.push(`Weekly report: ${reportResult.message}`);
                    } else {
                        logInfo(`Weekly report saved to ${reportResult.filepath}`);
                    }
                } else {
                    results.errors.push('Weekly report: Week/season not set');
                }
            } catch (error) {
                logError('Failed to generate weekly report', error);
                results.errors.push(`Weekly report: ${error.message}`);
            }

            this.lastDailyUpdate = new Date();
            await this.db.updateSchedulerTimestamp('daily');

            // 5. Health checks + alerting: any collected errors become alerts,
            // then run the light validation suite (roster invariant, stats
            // completeness, freshness)
            if (this.healthCheckService) {
                try {
                    for (const errMsg of results.errors) {
                        await this.healthCheckService.recordAlert('critical', 'daily-update', errMsg);
                    }
                    const settings = await this.getCurrentSettings();
                    if (settings.current_week && settings.season_year) {
                        results.validation = await this.healthCheckService.runValidation(
                            settings.current_week,
                            settings.season_year,
                            { mode: 'light' }
                        );
                    }
                } catch (error) {
                    logError('Post-daily-update health checks failed', error);
                }
            }

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
            rosterCopy: false,
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
                } else {
                    // 2a. Copy rosters from completed week to new week
                    try {
                        const rosterCopyResult = await this.db.copyRostersToNextWeek(
                            currentSettings.current_week,
                            advanceResult.newWeek,
                            currentSettings.season_year
                        );
                        results.rosterCopy = rosterCopyResult.success;
                        if (!rosterCopyResult.success) {
                            results.errors.push(`Roster copy: ${rosterCopyResult.message}`);
                        } else {
                            logInfo(`Successfully copied ${rosterCopyResult.entriesCopied} roster entries to week ${advanceResult.newWeek}`);
                        }
                    } catch (error) {
                        logError('Failed to copy rosters to new week', error);
                        results.errors.push(`Roster copy: ${error.message}`);
                        results.rosterCopy = false;
                    }
                }
            } catch (error) {
                logError('Failed to advance week', error);
                results.errors.push(`Week advance: ${error.message}`);
            }

            this.lastWeeklyUpdate = new Date();
            await this.db.updateSchedulerTimestamp('weekly');

            // 3. Health checks + alerting: full validation of the week that was
            // just completed (currentSettings.current_week is the pre-advance week)
            if (this.healthCheckService) {
                try {
                    for (const errMsg of results.errors) {
                        await this.healthCheckService.recordAlert('critical', 'weekly-update', errMsg);
                    }
                    results.validation = await this.healthCheckService.runValidation(
                        currentSettings.current_week,
                        currentSettings.season_year,
                        { mode: 'full' }
                    );
                } catch (error) {
                    logError('Post-weekly-update health checks failed', error);
                }
            }

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

            // 1b. Calculate scoring players (determines which 13 players count for each team)
            try {
                if (this.scoringPlayersService) {
                    const scoringPlayersResult = await this.scoringPlayersService.calculateScoringPlayers(
                        currentSettings.current_week,
                        currentSettings.season_year
                    );
                    results.scoringPlayersUpdated = scoringPlayersResult.success;
                    if (scoringPlayersResult.success) {
                        logInfo(`Calculated scoring players: ${scoringPlayersResult.playersMarked} players marked as scoring`);
                    }
                }
            } catch (error) {
                logError('Failed to calculate scoring players', error);
                results.errors.push(`Scoring players: ${error.message}`);
            }

            // 1c. Recalculate team scores for matchups (based on scoring players)
            try {
                if (this.teamScoreService) {
                    const teamScoresResult = await this.teamScoreService.recalculateTeamScores(
                        currentSettings.current_week,
                        currentSettings.season_year
                    );
                    results.teamScoresUpdated = teamScoresResult.success;
                    if (teamScoresResult.success) {
                        logInfo(`Updated team scores for ${teamScoresResult.teamsUpdated} teams`);
                    }
                }
            } catch (error) {
                logError('Failed to update team scores', error);
                results.errors.push(`Team scores: ${error.message}`);
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
                    } else {
                        // Recalculate DST fantasy points to include the bonuses
                        if (this.fantasyPointsCalculationService) {
                            try {
                                const dstResult = await this.fantasyPointsCalculationService.calculateEndOfWeekDSTBonuses(
                                    currentSettings.season_year
                                );
                                results.dstFantasyPoints = dstResult.success;
                                if (!dstResult.success) {
                                    results.errors.push(`DST fantasy points: Failed to update`);
                                } else {
                                    logInfo(`Updated DST fantasy points with bonuses: ${dstResult.updated} DST teams`);
                                    
                                    // Recalculate scoring players now that DST have their bonuses
                                    if (this.scoringPlayersService) {
                                        try {
                                            const scoringPlayersResult = await this.scoringPlayersService.calculateScoringPlayers(
                                                currentSettings.current_week,
                                                currentSettings.season_year
                                            );
                                            results.scoringPlayersUpdated = scoringPlayersResult.success;
                                            if (scoringPlayersResult.success) {
                                                logInfo(`Recalculated scoring players after DST bonuses: ${scoringPlayersResult.playersMarked} players marked as scoring`);
                                            }
                                        } catch (error) {
                                            logError('Failed to recalculate scoring players after DST bonuses', error);
                                            results.errors.push(`Scoring players (DST): ${error.message}`);
                                        }
                                    }
                                    
                                    // Recalculate team scores again after DST bonuses are applied
                                    if (this.teamScoreService) {
                                        try {
                                            const finalScoresResult = await this.teamScoreService.recalculateTeamScores(
                                                currentSettings.current_week,
                                                currentSettings.season_year
                                            );
                                            results.finalTeamScores = finalScoresResult.success;
                                            if (finalScoresResult.success) {
                                                logInfo(`Final team scores updated after DST bonuses: ${finalScoresResult.teamsUpdated} teams`);
                                            }
                                        } catch (error) {
                                            logError('Failed to update final team scores after DST bonuses', error);
                                            results.errors.push(`Final team scores: ${error.message}`);
                                        }
                                    }
                                }
                            } catch (error) {
                                logError('Failed to calculate DST fantasy points', error);
                                results.errors.push(`DST fantasy points: ${error.message}`);
                            }
                        }
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

            // Prune old backups so the directory doesn't grow unbounded
            try {
                const pruneResult = await this.pruneBackups(backupDir);
                if (pruneResult.pruned.length > 0 && this.healthCheckService) {
                    await this.healthCheckService.recordAlert('info', 'backup',
                        `Pruned ${pruneResult.pruned.length} old backup(s), keeping ${pruneResult.kept.length}`,
                        pruneResult.pruned);
                }
            } catch (error) {
                logError('Backup pruning failed (backup itself succeeded)', error);
            }

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
     * Prune old backups: keep the last 14 daily backups plus the first backup
     * of each month. Only touches files named fantasy_football_YYYY-MM-DD.db.
     */
    async pruneBackups(backupDir, { dryRun = false } = {}) {
        const BACKUP_PATTERN = /^fantasy_football_(\d{4}-\d{2}-\d{2})\.db$/;
        const KEEP_DAILY = 14;

        const files = await fs.readdir(backupDir);
        const backups = files
            .map(f => {
                const match = f.match(BACKUP_PATTERN);
                return match ? { file: f, date: match[1] } : null;
            })
            .filter(Boolean)
            .sort((a, b) => a.date.localeCompare(b.date));

        const keep = new Set();

        // Last 14 dailies
        for (const b of backups.slice(-KEEP_DAILY)) {
            keep.add(b.file);
        }

        // First backup of each month (backups are date-sorted ascending)
        const seenMonths = new Set();
        for (const b of backups) {
            const month = b.date.slice(0, 7); // YYYY-MM
            if (!seenMonths.has(month)) {
                seenMonths.add(month);
                keep.add(b.file);
            }
        }

        const toPrune = backups.filter(b => !keep.has(b.file)).map(b => b.file);

        if (!dryRun) {
            for (const file of toPrune) {
                await fs.unlink(path.join(backupDir, file));
            }
        }

        if (toPrune.length > 0) {
            logInfo(`${dryRun ? '[dry-run] Would prune' : 'Pruned'} ${toPrune.length} old backup(s)`, {
                pruned: toPrune,
                kept: keep.size
            });
        }

        return {
            pruned: toPrune,
            kept: [...keep].sort(),
            dryRun
        };
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
     * Enable real-time scoring with specified interval
     * @param {number} intervalMinutes - Interval in minutes between updates
     */
    enableRealTimeScoring(intervalMinutes = 5) {
        // Clear existing interval if any
        if (this.realTimeInterval) {
            clearInterval(this.realTimeInterval);
        }
        
        this.realTimeIntervalMinutes = intervalMinutes;
        this.realTimeEnabled = true;
        
        logInfo(`Enabling real-time scoring with ${intervalMinutes} minute interval`);
        
        // Set up the interval
        this.realTimeInterval = setInterval(async () => {
            logInfo('Real-time scoring interval triggered');
            try {
                await this.performLiveGameUpdate();
            } catch (error) {
                logError('Real-time scoring update failed', error);
            }
        }, intervalMinutes * 60 * 1000);
        
        // Run immediately
        this.performLiveGameUpdate().catch(error => {
            logError('Initial real-time scoring update failed', error);
        });
    }
    
    /**
     * Disable real-time scoring
     */
    disableRealTimeScoring() {
        if (this.realTimeInterval) {
            clearInterval(this.realTimeInterval);
            this.realTimeInterval = null;
        }
        
        this.realTimeEnabled = false;
        logInfo('Real-time scoring disabled');
    }
    
    /**
     * Get real-time scoring status
     */
    getRealTimeStatus() {
        // Check if cron job ran recently (within 45 seconds)
        const cronIsActive = this.lastLiveUpdate && 
            (Date.now() - this.lastLiveUpdate.getTime() < 45000);
        
        return {
            enabled: this.realTimeEnabled || cronIsActive,
            interval: cronIsActive ? 1 : this.realTimeIntervalMinutes,
            nextUpdate: this.realTimeInterval ? 
                new Date(Date.now() + (this.realTimeIntervalMinutes * 60 * 1000)) : null,
            source: cronIsActive ? 'scheduled' : 
                (this.realTimeEnabled ? 'manual' : 'disabled'),
            lastUpdate: this.lastLiveUpdate
        };
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