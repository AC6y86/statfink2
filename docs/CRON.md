# Scheduler Configuration (CRON)

This document describes the automated scheduling implementation for StatFink2's scheduled tasks using PM2's built-in cron functionality.

## Current Implementation Status ✅

StatFink2 uses **PM2 cron jobs** for all scheduled tasks. The configuration is active and running in production.

**Server Timezone**: UTC (all cron times are in UTC)

### Active Scheduled Tasks:

1. **Daily Updates** - Runs at 5pm UTC (10am PDT / 9am PST)
2. **Live Game Updates** - Runs continuously (every minute, 24/7)
3. **Email Roster-Move Poller** - Runs continuously (polls Gmail every 2 minutes)
4. **Nightly Regression Tests** - Runs at 12pm UTC (5am PDT / 4am PST)
5. **Weekly Updates** - ⚠️ Currently DISABLED (cron commented out in `ecosystem.config.js`); run manually

## How It Works

### 1. Daily Update
- **PM2 Process**: `statfink2-daily`
- **Schedule**: `0 17 * * *` (5pm UTC = 10am PDT / 9am PST)
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

### 3. Email Roster-Move Poller (Continuous)
- **PM2 Process**: `statfink2-email-poller`
- **Schedule**: Runs continuously (polls Gmail every 2 minutes)
- **Script**: `/scripts/roster-email-poller.js`
- **Functions**:
  - Forwards new roster-move emails to the server, which parses them and
    queues moves for commissioner approval
  - See `docs/EMAIL_ROSTER_MOVES.md` for the full system

### 4. Nightly Regression Tests
- **PM2 Process**: `statfink2-nightly-tests`
- **Schedule**: `0 12 * * *` (12pm UTC = 5am PDT / 4am PST)
- **Script**: `/scripts/nightly-test-run.js`
- **Functions**:
  - Stops the DB-writing services, runs the fast suite plus the 2024+2025
    scoring regression suites, restarts the services
  - Emails joe.paley@gmail.com (from peninsula.football.mailer@gmail.com)
    ONLY if a suite fails; green runs are silent
  - Requires the Gmail token to have the gmail.send scope
    (`node roster_moves/authSetup.js` re-authorizes if missing)

### 5. Weekly Update (After all games complete) — ⚠️ DISABLED
- **PM2 Process**: `statfink2-weekly`
- **Schedule**: None — the `cron_restart` is commented out in `ecosystem.config.js`
  ("TEMPORARILY DISABLED"; the last configured value was `0 11 * * 2`, 11am UTC Tuesday)
- **Script**: `/scripts/weekly-update-check.js`
- **Functions** (when run manually):
  - Checks if all games are complete
  - Creates weekly standings
  - Advances to next week
- **To run manually**: `node scripts/weekly-update-check.js` or
  `curl -X POST http://localhost:8000/api/admin/scheduler/weekly`

## Current PM2 Configuration

The scheduled tasks are configured in `/home/joepaley/statfink2/ecosystem.config.js` (the file itself is the source of truth). Six PM2 apps are defined:

| Process | Type | Schedule (UTC) |
|---------|------|----------------|
| `statfink2` | Main server, always on | — |
| `statfink2-daily` | Cron | `0 17 * * *` (5pm UTC = 10am PDT) |
| `statfink2-live-continuous` | Always on | every minute, 24/7 |
| `statfink2-email-poller` | Always on | polls Gmail every 2 minutes |
| `statfink2-nightly-tests` | Cron | `0 12 * * *` (12pm UTC = 5am PDT) |
| `statfink2-weekly` | Cron — **disabled** | `cron_restart` commented out |

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

# Email poller logs
pm2 logs statfink2-email-poller

# Nightly test logs
pm2 logs statfink2-nightly-tests

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
pm2 stop statfink2-live-continuous
```

### Start a Stopped Task:
```bash
pm2 start statfink2-live-continuous
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
- Conversions (PDT = UTC−7, PST = UTC−8):
  - Daily update: 5pm UTC = 10am PDT / 9am PST
  - Nightly tests: 12pm UTC = 5am PDT / 4am PST
  - Live updates run continuously, no time windows needed
- NFL game times are typically in ET
- The server tracks timestamps to prevent duplicate runs

⚠️ Note: some inline comments in `ecosystem.config.js` still say "10am UTC = 3am PDT" — the cron expression has been moved several times without updating the comments. The expressions above are what actually runs.

## Error Handling

The scheduler service includes:
- Prevention of concurrent runs (using in-progress flags)
- Timestamp tracking in the database
- Detailed logging of all operations
- Individual error handling for each sub-task
- Automatic restart on failure (for main app only)

## Database Backups

Daily backups are created as part of the daily update (5pm UTC = 10am PDT) and stored in `/home/joepaley/backups/` with the format:
```
fantasy_football_YYYY-MM-DD.db
```

Pruning is automated — after each backup, the retention policy keeps the last 14 daily backups plus the first backup of each month. See `docs/BACKUPS.md` for details and restore procedures.

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