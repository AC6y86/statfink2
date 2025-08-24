# Scheduler Configuration (CRON)

This document describes how to set up automated scheduling for the StatFink2 application's three main scheduled tasks:

1. **Daily Updates** - Run at 6am EST daily
2. **Live Game Updates** - Run every hour during game times
3. **Weekly Updates** - Run after all games complete

## Overview

The application has three main scheduled functions that need to run automatically:

### 1. Daily Update (6am EST)
- Updates NFL game schedule for the current week
- Backs up the database to `/home/joepaley/backups/`
- Syncs NFL player rosters and injury statuses

### 2. Live Game Updates (Hourly during games)
- Updates live game scores
- Calculates defensive bonuses when all games complete
- Should run frequently during game windows:
  - Sunday: 1pm - 11pm EST
  - Monday: 8pm - 11pm EST  
  - Thursday: 8pm - 11pm EST

### 3. Weekly Update (After all games complete)
- Creates weekly standings
- Advances to the next week
- Should only run when all games for the week are marked complete

## Implementation Options

### Option 1: PM2 Cron (Recommended)

PM2 provides built-in cron functionality. Create a PM2 ecosystem file:

```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'statfink2',
    script: './server.js',
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    }
  }],
  
  // Cron jobs
  cron: [{
    name: 'statfink2-daily',
    script: './scripts/daily-update.js',
    cron_restart: '0 6 * * *',  // 6am daily
    timezone: 'America/New_York',
    autorestart: false
  }, {
    name: 'statfink2-live',
    script: './scripts/live-update.js',
    cron_restart: '0 13-23 * * 0',  // Sunday 1pm-11pm hourly
    timezone: 'America/New_York',
    autorestart: false
  }, {
    name: 'statfink2-live-monday',
    script: './scripts/live-update.js',
    cron_restart: '0 20-23 * * 1',  // Monday 8pm-11pm hourly
    timezone: 'America/New_York',
    autorestart: false
  }, {
    name: 'statfink2-live-thursday',
    script: './scripts/live-update.js',
    cron_restart: '0 20-23 * * 4',  // Thursday 8pm-11pm hourly
    timezone: 'America/New_York',
    autorestart: false
  }]
};
```

### Option 2: System Cron

Add to your system crontab (`crontab -e`):

```bash
# StatFink2 Scheduled Tasks
# All times in EST (adjust for your timezone)

# Daily update at 6am EST
0 6 * * * cd /home/joepaley/statfink2 && /usr/bin/node scripts/daily-update.js >> /home/joepaley/statfink2/logs/cron.log 2>&1

# Live updates during game times (hourly)
# Sunday 1pm-11pm EST
0 13-23 * * 0 cd /home/joepaley/statfink2 && /usr/bin/node scripts/live-update.js >> /home/joepaley/statfink2/logs/cron.log 2>&1

# Monday Night Football 8pm-11pm EST  
0 20-23 * * 1 cd /home/joepaley/statfink2 && /usr/bin/node scripts/live-update.js >> /home/joepaley/statfink2/logs/cron.log 2>&1

# Thursday Night Football 8pm-11pm EST
0 20-23 * * 4 cd /home/joepaley/statfink2 && /usr/bin/node scripts/live-update.js >> /home/joepaley/statfink2/logs/cron.log 2>&1

# Weekly update check (runs hourly on Tuesday to catch completed Monday night games)
0 * * * 2 cd /home/joepaley/statfink2 && /usr/bin/node scripts/weekly-update-check.js >> /home/joepaley/statfink2/logs/cron.log 2>&1
```

## Required Script Files

Create these wrapper scripts in the `/scripts` directory:

### scripts/daily-update.js
```javascript
#!/usr/bin/env node
const axios = require('axios');

async function runDailyUpdate() {
    try {
        console.log(`[${new Date().toISOString()}] Starting daily update...`);
        
        const response = await axios.post('http://localhost:3000/api/admin/scheduler/daily', {}, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 300000 // 5 minute timeout
        });
        
        console.log(`[${new Date().toISOString()}] Daily update completed:`, response.data);
        process.exit(0);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Daily update failed:`, error.message);
        process.exit(1);
    }
}

runDailyUpdate();
```

### scripts/live-update.js
```javascript
#!/usr/bin/env node
const axios = require('axios');

async function runLiveUpdate() {
    try {
        console.log(`[${new Date().toISOString()}] Starting live game update...`);
        
        const response = await axios.post('http://localhost:3000/api/admin/scheduler/live', {}, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 60000 // 1 minute timeout
        });
        
        console.log(`[${new Date().toISOString()}] Live update completed:`, response.data);
        process.exit(0);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Live update failed:`, error.message);
        process.exit(1);
    }
}

runLiveUpdate();
```

### scripts/weekly-update-check.js
```javascript
#!/usr/bin/env node
const axios = require('axios');

async function checkAndRunWeeklyUpdate() {
    try {
        console.log(`[${new Date().toISOString()}] Checking if weekly update needed...`);
        
        // First check the scheduler status
        const statusResponse = await axios.get('http://localhost:3000/api/admin/scheduler/status');
        const status = statusResponse.data.data;
        
        // Check if we've already run the weekly update recently (within 24 hours)
        if (status.lastWeeklyUpdate) {
            const lastRun = new Date(status.lastWeeklyUpdate);
            const hoursSinceLastRun = (Date.now() - lastRun.getTime()) / (1000 * 60 * 60);
            
            if (hoursSinceLastRun < 24) {
                console.log(`[${new Date().toISOString()}] Weekly update already ran ${hoursSinceLastRun.toFixed(1)} hours ago`);
                process.exit(0);
            }
        }
        
        // Try to run the weekly update
        const response = await axios.post('http://localhost:3000/api/admin/scheduler/weekly', {}, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 300000 // 5 minute timeout
        });
        
        if (response.data.success) {
            console.log(`[${new Date().toISOString()}] Weekly update completed:`, response.data);
        } else {
            console.log(`[${new Date().toISOString()}] Weekly update not ready:`, response.data.message);
        }
        
        process.exit(0);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Weekly update check failed:`, error.message);
        process.exit(1);
    }
}

checkAndRunWeeklyUpdate();
```

## Setup Instructions

### 1. Create the scripts directory and files:
```bash
mkdir -p /home/joepaley/statfink2/scripts
mkdir -p /home/joepaley/statfink2/logs
```

### 2. Make scripts executable:
```bash
chmod +x /home/joepaley/statfink2/scripts/*.js
```

### 3. For PM2 setup:
```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # Follow the instructions to enable PM2 on system startup
```

### 4. For system cron setup:
```bash
crontab -e
# Paste the cron entries from above
```

## Monitoring

### Check cron logs:
```bash
tail -f /home/joepaley/statfink2/logs/cron.log
```

### Check PM2 logs:
```bash
pm2 logs statfink2-daily
pm2 logs statfink2-live
```

### View scheduler status via API:
```bash
curl http://localhost:3000/api/admin/scheduler/status
```

## Manual Execution

You can manually trigger any scheduled task:

```bash
# Daily update
curl -X POST http://localhost:3000/api/admin/scheduler/daily

# Live update  
curl -X POST http://localhost:3000/api/admin/scheduler/live

# Weekly update
curl -X POST http://localhost:3000/api/admin/scheduler/weekly
```

## Timezone Considerations

- All cron times should be in EST/EDT (America/New_York)
- The server tracks timestamps in the database to prevent duplicate runs
- Game times are based on NFL schedule which is typically in ET

## Error Handling

The scheduler service includes:
- Prevention of concurrent runs (using in-progress flags)
- Timestamp tracking in the database
- Detailed logging of all operations
- Individual error handling for each sub-task

## Database Backups

Daily backups are stored in `/home/joepaley/backups/` with the format:
```
fantasy_football_YYYY-MM-DD.db
```

Consider setting up a separate cron job to clean up old backups:
```bash
# Delete backups older than 30 days (run weekly)
0 0 * * 0 find /home/joepaley/backups -name "fantasy_football_*.db" -mtime +30 -delete
```

## Troubleshooting

1. **Scripts not running**: Check file permissions and paths
2. **API timeouts**: Increase timeout values in scripts
3. **Duplicate runs**: The scheduler service prevents this automatically
4. **Missing dependencies**: Run `npm install` in the project directory

## Additional Notes

- The live update runs hourly but will intelligently skip when no games are active
- The weekly update will only proceed when all games are marked complete
- All operations are logged with timestamps for debugging
- The scheduler maintains state in the database to track last run times