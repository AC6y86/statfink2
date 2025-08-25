const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

class PM2ConfigUpdater {
    constructor() {
        this.configPath = path.join(__dirname, '../../ecosystem.config.js');
    }

    /**
     * Convert PST time to UTC cron expression
     * @param {string} pstTime - Time in HH:MM format (24-hour)
     * @param {string} dayOfWeek - Day of week (0-6, 0=Sunday)
     * @returns {string} Cron expression in UTC
     */
    convertPSTtoUTCCron(pstTime, dayOfWeek = '*') {
        const [hours, minutes] = pstTime.split(':').map(Number);
        
        // PST is UTC-8 (we'll use standard time, not DST)
        let utcHours = hours + 8;
        let utcDay = dayOfWeek;
        
        // Handle day rollover
        if (utcHours >= 24) {
            utcHours -= 24;
            if (dayOfWeek !== '*') {
                utcDay = ((parseInt(dayOfWeek) + 1) % 7).toString();
            }
        }
        
        return `${minutes} ${utcHours} * * ${utcDay}`;
    }

    /**
     * Convert PST time range to UTC cron expression for hourly runs
     * @param {string} startTime - Start time in HH:MM format
     * @param {string} endTime - End time in HH:MM format
     * @param {string} dayOfWeek - Day of week (0-6, 0=Sunday)
     * @returns {Object} Object with cron expressions for different parts
     */
    convertPSTRangeToUTCCron(startTime, endTime, dayOfWeek) {
        const [startHour] = startTime.split(':').map(Number);
        const [endHour] = endTime.split(':').map(Number);
        
        // Convert to UTC hours
        let utcStartHour = startHour + 8;
        let utcEndHour = endHour + 8;
        
        const crons = [];
        
        // Handle the main day range
        if (utcStartHour < 24 && utcEndHour < 24) {
            // No day rollover
            crons.push({
                expression: `0 ${utcStartHour}-${utcEndHour} * * ${dayOfWeek}`,
                name: 'main'
            });
        } else if (utcStartHour < 24 && utcEndHour >= 24) {
            // End rolls over to next day
            const nextDay = ((parseInt(dayOfWeek) + 1) % 7).toString();
            crons.push({
                expression: `0 ${utcStartHour}-23 * * ${dayOfWeek}`,
                name: 'main'
            });
            crons.push({
                expression: `0 0-${utcEndHour - 24} * * ${nextDay}`,
                name: 'late'
            });
        } else {
            // Both rolled over (shouldn't happen with typical NFL times)
            const nextDay = ((parseInt(dayOfWeek) + 1) % 7).toString();
            crons.push({
                expression: `0 ${utcStartHour - 24}-${utcEndHour - 24} * * ${nextDay}`,
                name: 'main'
            });
        }
        
        return crons;
    }

    /**
     * Update a specific task's schedule in the ecosystem config
     * @param {string} taskName - Name of the task to update
     * @param {Object} scheduleConfig - New schedule configuration
     */
    async updateSchedule(taskName, scheduleConfig) {
        try {
            // Read the current config file as text
            const configContent = await fs.readFile(this.configPath, 'utf8');
            
            let updatedContent = configContent;
            
            switch(taskName) {
                case 'daily':
                    const dailyCron = this.convertPSTtoUTCCron(scheduleConfig.time, '*');
                    updatedContent = this.updateCronInConfig(updatedContent, 'statfink2-daily', dailyCron);
                    break;
                    
                case 'sunday':
                    const sundayCrons = this.convertPSTRangeToUTCCron(
                        scheduleConfig.startTime,
                        scheduleConfig.endTime,
                        '0' // Sunday
                    );
                    
                    // Update main Sunday schedule
                    const mainSunday = sundayCrons.find(c => c.name === 'main');
                    if (mainSunday) {
                        updatedContent = this.updateCronInConfig(updatedContent, 'statfink2-live-sunday', mainSunday.expression);
                    }
                    
                    // Update late Sunday schedule (if needed)
                    const lateSunday = sundayCrons.find(c => c.name === 'late');
                    if (lateSunday) {
                        updatedContent = this.updateCronInConfig(updatedContent, 'statfink2-live-sunday-late', lateSunday.expression);
                    }
                    break;
                    
                case 'monday':
                    const mondayCrons = this.convertPSTRangeToUTCCron(
                        scheduleConfig.startTime,
                        scheduleConfig.endTime,
                        '1' // Monday
                    );
                    
                    const mainMonday = mondayCrons.find(c => c.name === 'main' || c.name === 'late');
                    if (mainMonday) {
                        // Monday night games typically roll over to Tuesday UTC
                        updatedContent = this.updateCronInConfig(updatedContent, 'statfink2-live-monday', mainMonday.expression);
                    }
                    break;
                    
                case 'thursday':
                    const thursdayCrons = this.convertPSTRangeToUTCCron(
                        scheduleConfig.startTime,
                        scheduleConfig.endTime,
                        '4' // Thursday
                    );
                    
                    const mainThursday = thursdayCrons.find(c => c.name === 'main' || c.name === 'late');
                    if (mainThursday) {
                        // Thursday night games typically roll over to Friday UTC
                        updatedContent = this.updateCronInConfig(updatedContent, 'statfink2-live-thursday', mainThursday.expression);
                    }
                    break;
                    
                case 'weekly':
                    // Weekly runs once at specified time on specified day
                    if (scheduleConfig.time) {
                        const weeklyCron = this.convertPSTtoUTCCron(scheduleConfig.time, scheduleConfig.dayOfWeek);
                        updatedContent = this.updateCronInConfig(updatedContent, 'statfink2-weekly', weeklyCron);
                    } else {
                        // Fallback to 3am if no time specified
                        const weeklyCron = this.convertPSTtoUTCCron('03:00', scheduleConfig.dayOfWeek);
                        updatedContent = this.updateCronInConfig(updatedContent, 'statfink2-weekly', weeklyCron);
                    }
                    break;
            }
            
            // Write the updated config back
            await fs.writeFile(this.configPath, updatedContent, 'utf8');
            
            // Reload PM2 configuration
            await this.reloadPM2();
            
            return { success: true, message: `Schedule updated for ${taskName}` };
            
        } catch (error) {
            console.error('Error updating PM2 schedule:', error);
            throw error;
        }
    }

    /**
     * Update a specific cron expression in the config content
     */
    updateCronInConfig(content, taskName, newCron) {
        // Find the task and update its cron_restart value
        const regex = new RegExp(
            `(name:\\s*'${taskName}'[\\s\\S]*?cron_restart:\\s*)'[^']*'`,
            'g'
        );
        
        return content.replace(regex, `$1'${newCron}'`);
    }

    /**
     * Reload PM2 with the updated configuration
     */
    async reloadPM2() {
        try {
            // Stop old cron jobs
            await execAsync('pm2 delete statfink2-daily statfink2-live-sunday statfink2-live-sunday-late statfink2-live-monday statfink2-live-thursday statfink2-weekly 2>/dev/null || true');
            
            // Start with new config
            await execAsync('pm2 start ecosystem.config.js --only "statfink2-daily,statfink2-live-sunday,statfink2-live-sunday-late,statfink2-live-monday,statfink2-live-thursday,statfink2-weekly"');
            
            // Save PM2 state
            await execAsync('pm2 save');
            
            return { success: true };
        } catch (error) {
            console.error('Error reloading PM2:', error);
            throw error;
        }
    }

    /**
     * Get current schedules from ecosystem config
     */
    async getCurrentSchedules() {
        try {
            const configContent = await fs.readFile(this.configPath, 'utf8');
            
            const schedules = {};
            
            // Extract cron expressions for each task
            const tasks = [
                'statfink2-daily',
                'statfink2-live-sunday',
                'statfink2-live-sunday-late',
                'statfink2-live-monday',
                'statfink2-live-thursday',
                'statfink2-weekly'
            ];
            
            for (const task of tasks) {
                const regex = new RegExp(
                    `name:\\s*'${task}'[\\s\\S]*?cron_restart:\\s*'([^']*)'`,
                    'g'
                );
                const match = regex.exec(configContent);
                if (match) {
                    schedules[task] = match[1];
                }
            }
            
            return schedules;
        } catch (error) {
            console.error('Error reading current schedules:', error);
            throw error;
        }
    }
}

module.exports = PM2ConfigUpdater;