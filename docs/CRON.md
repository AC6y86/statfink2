# Scheduler Configuration (CRON)

This document describes the automated scheduling implementation for StatFink2's three main scheduled tasks using PM2's built-in cron functionality.

## Current Implementation Status ✅

StatFink2 uses **PM2 cron jobs** for all scheduled tasks. The configuration is active and running in production.

**Server Timezone**: UTC (all cron times are in UTC)

### Active Scheduled Tasks:

1. **Daily Updates** - Runs at 10am UTC (3am PDT)
2. **Live Game Updates** - Runs continuously (every minute, 24/7)
3. **Weekly Updates** - Runs hourly on Tuesday UTC to check for completion

## How It Works

### 1. Daily Update
- **PM2 Process**: `statfink2-daily`
- **Schedule**: `0 17 * * *` (10am UTC = 3am PDT)
- **Script**: `/scripts/daily-update.js`
- **Functions**:
  - Updates NFL game schedule for the current week
  - Backs up database to `/home/joepaley/backups/`
  - Syncs NFL player rosters and injury statuses

### 2. Live Game Updates (Continuous)
- **PM2 Process**: `statfink2-live-continuous`
- **Schedule**: Runs continuously (every minute, 24/7)
- **Script**: `/scripts/live-update-continuous.js`
- **Functions**:
  - Updates live game scores during active games
  - Calculates defensive bonuses when all games complete
  - Automatically detects when games are in progress

### 3. Weekly Update (After all games complete)
- **PM2 Process**: `statfink2-weekly`
- **Schedule**: `0 * * * 2` (Hourly on Tuesday UTC)
- **Script**: `/scripts/weekly-update-check.js`
- **Functions**:
  - Checks if all games are complete
  - Creates weekly standings
  - Advances to next week

## Current PM2 Configuration

The scheduled tasks are configured in `/home/joepaley/statfink2/ecosystem.config.js`. Here's the active configuration:

```javascript
// ecosystem.config.js (ACTIVE)
module.exports = {
  apps: [
    // Main application
    {
      name: 'statfink2',
      script: './server/app.js',
      cwd: '/home/joepaley/statfink2',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
        PORT: process.env.PORT || 8000,
        // ... other env vars
      }
    },
    // Scheduled tasks
    {
      name: 'statfink2-daily',
      script: './scripts/daily-update.js',
      cwd: '/home/joepaley/statfink2',
      cron_restart: '0 17 * * *', // 10am UTC = 3am PDT
      autorestart: false,
      watch: false,
      time: true
    },
    // Continuous live update process - runs every minute 24/7
    {
      name: 'statfink2-live-continuous',
      script: './scripts/live-update-continuous.js',
      cwd: '/home/joepaley/statfink2',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      time: true
    },
    {
      name: 'statfink2-weekly',
      script: './scripts/weekly-update-check.js',
      cwd: '/home/joepaley/statfink2',
      cron_restart: '0 * * * 2', // Hourly on Tuesday UTC (after Monday night games)
      autorestart: false,
      watch: false,
      time: true
    }
  ]
};
```

## Monitoring Commands

### Check Status of All Processes:
```bash
pm2 list
```

### View Logs for Specific Tasks:
```bash
# Main application logs
pm2 logs statfink2

# Daily update logs
pm2 logs statfink2-daily

# Live update logs
pm2 logs statfink2-live-continuous

# Weekly update logs
pm2 logs statfink2-weekly

# All logs
pm2 logs
```

### Monitor Real-time Status:
```bash
pm2 monit
```

### Check Cron Status:
```bash
pm2 describe statfink2-daily    # Shows next execution time
pm2 describe statfink2-weekly   # Shows last run time
```

## Manual Execution

You can manually trigger any scheduled task in two ways:

### Option 1: Direct Script Execution
```bash
# Daily update
node /home/joepaley/statfink2/scripts/daily-update.js

# Live update (continuous process - normally runs automatically)
node /home/joepaley/statfink2/scripts/live-update-continuous.js

# Weekly update check
node /home/joepaley/statfink2/scripts/weekly-update-check.js
```

### Option 2: API Endpoints

```bash
# Daily update
curl -X POST http://localhost:8000/api/admin/scheduler/daily

# Live update  
curl -X POST http://localhost:8000/api/admin/scheduler/live

# Weekly update
curl -X POST http://localhost:8000/api/admin/scheduler/weekly

# Check scheduler status
curl http://localhost:8000/api/admin/scheduler/status
```

## PM2 Management

### Restart a Specific Task:
```bash
pm2 restart statfink2-daily
pm2 restart statfink2-weekly
```

### Stop a Task Temporarily:
```bash
pm2 stop statfink2-live-sunday
```

### Start a Stopped Task:
```bash
pm2 start statfink2-live-sunday
```

### Update Configuration:
After modifying `ecosystem.config.js`:
```bash
pm2 reload ecosystem.config.js --update-env
pm2 save
```

## Timezone Considerations

- **Server runs in UTC timezone**
- All cron times in ecosystem.config.js are in UTC
- Conversions:
  - 10am UTC = 3am PDT (Daily update)
  - Live updates run continuously, no time windows needed
- NFL game times are typically in ET
- The server tracks timestamps to prevent duplicate runs

## Error Handling

The scheduler service includes:
- Prevention of concurrent runs (using in-progress flags)
- Timestamp tracking in the database
- Detailed logging of all operations
- Individual error handling for each sub-task
- Automatic restart on failure (for main app only)

## Database Backups

Daily backups are automatically created at 3am PDT and stored in `/home/joepaley/backups/` with the format:
```
fantasy_football_YYYY-MM-DD.db
```

To set up backup cleanup (optional):
```bash
# Add to PM2 config for weekly cleanup of backups older than 30 days
{
  name: 'statfink2-cleanup',
  script: 'find /home/joepaley/backups -name "fantasy_football_*.db" -mtime +30 -delete',
  cron_restart: '0 0 * * 0', // Weekly on Sunday midnight
  autorestart: false,
  interpreter: 'bash'
}
```

## Troubleshooting

### Common Issues and Solutions:

1. **Cron job not running**: 
   ```bash
   pm2 describe statfink2-daily  # Check next execution time
   pm2 logs statfink2-daily --lines 50  # Check recent logs
   ```

2. **API timeouts**: 
   - Check if main app is running: `pm2 list`
   - Restart if needed: `pm2 restart statfink2`

3. **Duplicate runs**: 
   - The scheduler service prevents this automatically
   - Check logs: `pm2 logs statfink2-weekly`

4. **Missing dependencies**: 
   ```bash
   cd /home/joepaley/statfink2
   npm install
   pm2 restart all
   ```

5. **PM2 not starting on boot**:
   ```bash
   pm2 startup  # Follow the instructions provided
   pm2 save
   ```

## Key Features

- All tasks managed through PM2 (no system cron needed)
- Live game updates run continuously (every minute, 24/7)
- Weekly update checks hourly but only runs when games complete
- All operations logged with timestamps
- State maintained in database to track last run times
- Manual trigger available via scripts or API