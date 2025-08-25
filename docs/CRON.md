# Scheduler Configuration (CRON)

This document describes the automated scheduling implementation for StatFink2's three main scheduled tasks using PM2's built-in cron functionality.

## Current Implementation Status ✅

StatFink2 uses **PM2 cron jobs** for all scheduled tasks. The configuration is active and running in production.

**Server Timezone**: UTC (all cron times are in UTC)

### Active Scheduled Tasks:

1. **Daily Updates** - Runs at 11am UTC (6am EST / 3am PST)
2. **Live Game Updates** - Runs hourly during NFL game times
3. **Weekly Updates** - Runs hourly on Tuesday UTC to check for completion

## How It Works

### 1. Daily Update
- **PM2 Process**: `statfink2-daily`
- **Schedule**: `0 11 * * *` (11am UTC = 6am EST = 3am PST)
- **Script**: `/scripts/daily-update.js`
- **Functions**:
  - Updates NFL game schedule for the current week
  - Backs up database to `/home/joepaley/backups/`
  - Syncs NFL player rosters and injury statuses

### 2. Live Game Updates (Hourly during games)
- **PM2 Processes & Times**: 
  - `statfink2-live-sunday` - 6pm-11pm UTC Sunday (1pm-6pm EST / 10am-3pm PST)
  - `statfink2-live-sunday-late` - 12am-4am UTC Monday (7pm-11pm EST Sun / 4pm-8pm PST Sun)
  - `statfink2-live-monday` - 1am-4am UTC Tuesday (8pm-11pm EST Mon / 5pm-8pm PST Mon)
  - `statfink2-live-thursday` - 1am-4am UTC Friday (8pm-11pm EST Thu / 5pm-8pm PST Thu)
- **Scripts**: `/scripts/live-update.js`
- **Functions**:
  - Updates live game scores
  - Calculates defensive bonuses when all games complete

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
      cron_restart: '0 11 * * *', // 11am UTC = 6am EST = 3am PST
      autorestart: false,
      watch: false,
      time: true
    },
    {
      name: 'statfink2-live-sunday',
      script: './scripts/live-update.js',
      cwd: '/home/joepaley/statfink2',
      cron_restart: '0 18-23 * * 0', // 6pm-11pm UTC Sunday = 1pm-6pm EST = 10am-3pm PST
      autorestart: false,
      watch: false,
      time: true
    },
    {
      name: 'statfink2-live-sunday-late',
      script: './scripts/live-update.js',
      cwd: '/home/joepaley/statfink2',
      cron_restart: '0 0-4 * * 1', // 12am-4am UTC Monday = 7pm-11pm EST Sunday = 4pm-8pm PST Sunday
      autorestart: false,
      watch: false,
      time: true
    },
    {
      name: 'statfink2-live-monday',
      script: './scripts/live-update.js',
      cwd: '/home/joepaley/statfink2',
      cron_restart: '0 1-4 * * 2', // 1am-4am UTC Tuesday = 8pm-11pm EST Monday = 5pm-8pm PST Monday
      autorestart: false,
      watch: false,
      time: true
    },
    {
      name: 'statfink2-live-thursday',
      script: './scripts/live-update.js',
      cwd: '/home/joepaley/statfink2',
      cron_restart: '0 1-4 * * 5', // 1am-4am UTC Friday = 8pm-11pm EST Thursday = 5pm-8pm PST Thursday
      autorestart: false,
      watch: false,
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
pm2 logs statfink2-live-sunday
pm2 logs statfink2-live-monday
pm2 logs statfink2-live-thursday

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

# Live update
node /home/joepaley/statfink2/scripts/live-update.js

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
  - 11am UTC = 6am EST = 3am PST (Daily update)
  - 6pm UTC = 1pm EST = 10am PST (Sunday games start)
  - 4am UTC = 11pm EST = 8pm PST (Games end)
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

Daily backups are automatically created at 6am EST and stored in `/home/joepaley/backups/` with the format:
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

- ✅ All tasks managed through PM2 (no system cron needed)
- ✅ Live game updates only run during game times
- ✅ Weekly update checks hourly but only runs when games complete
- ✅ All operations logged with timestamps
- ✅ State maintained in database to track last run times
- ✅ Manual trigger available via scripts or API