const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

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
        DATABASE_PATH: process.env.DATABASE_PATH || './fantasy_football.db',
        TANK01_API_KEY: process.env.TANK01_API_KEY,
        SESSION_SECRET: process.env.SESSION_SECRET,
        ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH
      }
    },
    // Scheduled tasks (times in UTC, server timezone)
    {
      name: 'statfink2-daily',
      script: './scripts/daily-update.js',
      cwd: '/home/joepaley/statfink2',
      // 13:00 UTC = 6am PDT / 9am EDT: before every kickoff window (Sunday
      // 17:00 UTC games, international ~13:30 UTC) so the heavy player/roster
      // sync and backup never contend with live scoring
      cron_restart: '0 13 * * *',
      autorestart: false,
      watch: false,
      time: true
    },
    // Continuous live update process - runs every minute 24/7
    // Replaces all the time-windowed live update processes
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
    // Live-scoring watchdog - observes only. Every 2 min asks the server
    // GET /api/internal/health/live (is anything supposed to be live, and is
    // data moving?) and appends one JSON line to logs/watchdog/live-*.jsonl.
    // Never alerts or emails itself; the notifier below reads the log.
    {
      name: 'statfink2-watchdog',
      script: './scripts/live-watchdog.js',
      cwd: '/home/joepaley/statfink2',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      time: true
    },
    // Watchdog notifier - reads the watchdog log from a saved cursor every 5
    // min, opens/closes incidents (2 consecutive bad checks), posts dashboard
    // alerts, emails joe.paley@gmail.com for critical incidents (hourly
    // reminders + recovery). A 15-min silent log means the watchdog is dead.
    {
      name: 'statfink2-watchdog-notifier',
      script: './scripts/watchdog-notifier.js',
      cwd: '/home/joepaley/statfink2',
      cron_restart: '*/5 * * * *',
      autorestart: false,
      watch: false,
      time: true
    },
    // Gmail poller for email-driven roster moves - forwards new emails to the
    // server, which parses them and queues moves for commissioner approval
    {
      name: 'statfink2-email-poller',
      script: './scripts/roster-email-poller.js',
      cwd: '/home/joepaley/statfink2',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      time: true
    },
    // Nightly regression tests - emails joe.paley@gmail.com ONLY on failure
    {
      name: 'statfink2-nightly-tests',
      script: './scripts/nightly-test-run.js',
      cwd: '/home/joepaley/statfink2',
      cron_restart: '0 12 * * *', // 12pm UTC = 4-5am PT; ~3min outage never overlaps a game window
      autorestart: false,
      watch: false,
      time: true
    },
    // Weekly validation of the just-completed week - full health checks + deep
    // ESPN verification suite; ALWAYS emails joe.paley@gmail.com a summary and
    // writes logs/weekly-validation-latest.json for the admin dashboard.
    // Must finish before statfink2-nightly-tests (12pm UTC) stops the server.
    {
      name: 'statfink2-weekly-validate',
      script: './scripts/weekly-validate.js',
      cwd: '/home/joepaley/statfink2',
      cron_restart: '0 10 * * 2', // 10am UTC Tuesday = 2-3am PT, after Monday night finals
      autorestart: false,
      watch: false,
      time: true
    },
    // Weekly recap generation - 30 min after weekly-validate so its report is
    // fresh. Drives the /recap pipeline headlessly (claude -p --auto): 10
    // styles unused so far this season, fact-checked, written to recaps/{season}/ and
    // logs/weekly-recaps-latest.json for the admin Recaps tab. Reads the DB
    // read-only; emails joe.paley@gmail.com ONLY on failure; skips cleanly
    // off-season or when the week is already generated. Never commits to git.
    {
      name: 'statfink2-weekly-recaps',
      script: './scripts/weekly-recap-run.js',
      cwd: '/home/joepaley/statfink2',
      cron_restart: '30 10 * * 2', // 10:30am UTC Tuesday; worst case ~30min, done before nightly-tests at 12:00
      autorestart: false,
      watch: false,
      time: true
    },
    {
      name: 'statfink2-weekly',
      script: './scripts/weekly-update-check.js',
      cwd: '/home/joepaley/statfink2',
      // cron_restart: '0 11 * * 2', // 10am UTC Tuesday = 3am PDT Tuesday (after Monday night games) - TEMPORARILY DISABLED
      autorestart: false,
      watch: false,
      time: true
    }
  ]
};