// Database backup and restore utilities

const fs = require('fs');
const path = require('path');
const { logError, logInfo } = require('./errorHandler');

class BackupManager {
    constructor(db, backupDir = './backups') {
        this.db = db;
        this.backupDir = backupDir;
        
        // Ensure backup directory exists
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }
    }
    
    // Create a full database backup
    async createBackup(description = '') {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFilename = `fantasy_backup_${timestamp}.sql`;
        const backupPath = path.join(this.backupDir, backupFilename);
        
        try {
            const backup = this.generateBackupSQL(description);
            fs.writeFileSync(backupPath, backup, 'utf8');
            
            logInfo(`Database backup created: ${backupFilename}`, { size: backup.length });
            
            return {
                success: true,
                filename: backupFilename,
                path: backupPath,
                size: backup.length
            };
        } catch (error) {
            logError(error, 'BackupManager.createBackup');
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    // Generate SQL backup content
    generateBackupSQL(description) {
        const timestamp = new Date().toISOString();
        let sql = `-- Fantasy Football Database Backup\n`;
        sql += `-- Created: ${timestamp}\n`;
        sql += `-- Description: ${description}\n\n`;
        
        // Backup league settings
        sql += `-- League Settings\n`;
        const leagueSettings = this.db.getLeagueSettings();
        if (leagueSettings) {
            sql += `INSERT OR REPLACE INTO league_settings (league_id, league_name, max_teams, roster_size, starting_lineup_size, scoring_type, season_year, current_week) VALUES `;
            sql += `(${leagueSettings.league_id}, '${this.escapeSQL(leagueSettings.league_name)}', ${leagueSettings.max_teams}, ${leagueSettings.roster_size}, ${leagueSettings.starting_lineup_size}, '${leagueSettings.scoring_type}', ${leagueSettings.season_year}, ${leagueSettings.current_week});\n\n`;
        }
        
        // Backup teams
        sql += `-- Teams\n`;
        const teams = this.db.getAllTeams();
        if (teams.length > 0) {
            sql += `INSERT OR REPLACE INTO teams (team_id, team_name, owner_name, total_points, wins, losses, ties) VALUES\n`;
            const teamValues = teams.map(team => 
                `(${team.team_id}, '${this.escapeSQL(team.team_name)}', '${this.escapeSQL(team.owner_name)}', ${team.total_points}, ${team.wins}, ${team.losses}, ${team.ties})`
            );
            sql += teamValues.join(',\n') + ';\n\n';
        }
        
        // Backup players
        sql += `-- NFL Players\n`;
        const players = this.db.getAllPlayers();
        if (players.length > 0) {
            sql += `INSERT OR REPLACE INTO nfl_players (player_id, name, position, team, bye_week, is_active, last_updated) VALUES\n`;
            const playerValues = players.map(player => 
                `('${this.escapeSQL(player.player_id)}', '${this.escapeSQL(player.name)}', '${player.position}', '${player.team}', ${player.bye_week || 'NULL'}, ${player.is_active ? 1 : 0}, '${player.last_updated}')`
            );
            sql += playerValues.join(',\n') + ';\n\n';
        }
        
        // Backup rosters
        sql += `-- Fantasy Rosters\n`;
        const allRosters = [];
        teams.forEach(team => {
            const roster = this.db.getTeamRoster(team.team_id);
            allRosters.push(...roster);
        });
        
        if (allRosters.length > 0) {
            sql += `INSERT OR REPLACE INTO fantasy_rosters (roster_id, team_id, player_id, roster_position, acquisition_date) VALUES\n`;
            const rosterValues = allRosters.map(roster => 
                `(${roster.roster_id}, ${roster.team_id}, '${this.escapeSQL(roster.player_id)}', '${roster.roster_position}', '${roster.acquisition_date}')`
            );
            sql += rosterValues.join(',\n') + ';\n\n';
        }
        
        // Backup scoring rules
        sql += `-- Scoring Rules\n`;
        const scoringRules = this.db.getScoringRules();
        if (scoringRules.length > 0) {
            sql += `INSERT OR REPLACE INTO scoring_rules (rule_id, stat_type, points_per_unit) VALUES\n`;
            const ruleValues = scoringRules.map(rule => 
                `(${rule.rule_id}, '${rule.stat_type}', ${rule.points_per_unit})`
            );
            sql += ruleValues.join(',\n') + ';\n\n';
        }
        
        return sql;
    }
    
    // List available backups
    listBackups() {
        try {
            const files = fs.readdirSync(this.backupDir)
                .filter(file => file.endsWith('.sql'))
                .map(file => {
                    const filePath = path.join(this.backupDir, file);
                    const stats = fs.statSync(filePath);
                    return {
                        filename: file,
                        path: filePath,
                        size: stats.size,
                        created: stats.mtime
                    };
                })
                .sort((a, b) => b.created - a.created);
            
            return files;
        } catch (error) {
            logError(error, 'BackupManager.listBackups');
            return [];
        }
    }
    
    // Delete old backups (keep only the most recent N)
    cleanupOldBackups(keepCount = 10) {
        try {
            const backups = this.listBackups();
            
            if (backups.length <= keepCount) {
                return { deleted: 0, kept: backups.length };
            }
            
            const toDelete = backups.slice(keepCount);
            let deletedCount = 0;
            
            toDelete.forEach(backup => {
                try {
                    fs.unlinkSync(backup.path);
                    deletedCount++;
                    logInfo(`Deleted old backup: ${backup.filename}`);
                } catch (error) {
                    logError(error, `BackupManager.cleanupOldBackups - deleting ${backup.filename}`);
                }
            });
            
            return {
                deleted: deletedCount,
                kept: backups.length - deletedCount
            };
        } catch (error) {
            logError(error, 'BackupManager.cleanupOldBackups');
            return { deleted: 0, kept: 0 };
        }
    }
    
    // Export current data as JSON (lighter alternative to SQL backup)
    async exportDataAsJSON() {
        try {
            const data = {
                timestamp: new Date().toISOString(),
                league_settings: await this.db.getLeagueSettings(),
                teams: await this.db.getAllTeams(),
                players: await this.db.getAllPlayers(),
                scoring_rules: await this.db.getScoringRules(),
                rosters: {}
            };
            
            // Get rosters for each team
            if (data.teams && Array.isArray(data.teams)) {
                for (const team of data.teams) {
                    data.rosters[team.team_id] = await this.db.getTeamRoster(team.team_id);
                }
            }
            
            return data;
        } catch (error) {
            logError(error, 'BackupManager.exportDataAsJSON');
            throw error;
        }
    }
    
    // Save JSON export to file
    async saveJSONExport(filename) {
        try {
            const data = await this.exportDataAsJSON();
            const filePath = path.join(this.backupDir, filename);
            
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
            
            logInfo(`JSON export saved: ${filename}`);
            return {
                success: true,
                filename: filename,
                path: filePath,
                size: fs.statSync(filePath).size
            };
        } catch (error) {
            logError(error, 'BackupManager.saveJSONExport');
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    // Escape SQL strings to prevent injection
    escapeSQL(str) {
        if (typeof str !== 'string') return str;
        return str.replace(/'/g, "''");
    }
    
    // Schedule automatic backups
    scheduleAutoBackup(intervalHours = 24) {
        const intervalMs = intervalHours * 60 * 60 * 1000;
        
        const doBackup = () => {
            this.createBackup('Automatic backup')
                .then(result => {
                    if (result.success) {
                        logInfo(`Automatic backup completed: ${result.filename}`);
                        // Clean up old backups
                        this.cleanupOldBackups(5);
                    } else {
                        logError(new Error(result.error), 'Automatic backup failed');
                    }
                })
                .catch(error => {
                    logError(error, 'Automatic backup error');
                });
        };
        
        // Run initial backup
        doBackup();
        
        // Schedule recurring backups
        const intervalId = setInterval(doBackup, intervalMs);
        
        logInfo(`Automatic backups scheduled every ${intervalHours} hours`);
        
        return intervalId;
    }
}

module.exports = BackupManager;