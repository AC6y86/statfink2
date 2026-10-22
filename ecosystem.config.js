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
        ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH,
        // loopback-only Tailscale listener (server/auth/trust.js); see docs/CRON.md "Admin access paths"
        TAILSCALE_PORT: process.env.TAILSCALE_PORT || 8001,
        TAILSCALE_ADMIN_LOGINS: process.env.TAILSCALE_ADMIN_LOGINS,
        TAILSCALE_HOSTNAME: process.env.TAILSCALE_HOSTNAME
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
    // alerts, emails joe.paley@gmail.com for critical incidents - the ONLY emailer (hourly
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
    // Live play review (docs/DOUBLECHECK.md "Live play review"): every 5 min
    // DURING game windows only (exits in <1 s otherwise), builds the touchdown
    // dossier for in-progress / just-final games and asks the local Qwen
    // (QWEN_BASE_URL in .env) for an independent vote on every defensive TD and
    // safety; disagreements become questions for the 06:00 Double Check / Opus.
    // When the watchdog escalates it also writes a plain-English diagnosis
    // (logs/live-review/diagnosis.json) for /admin/status and the critical
    // email. Read-only; never emails itself; Qwen unreachable = info only.
    {
      name: 'statfink2-live-review',
      script: './scripts/live-review.js',
      cwd: '/home/joepaley/statfink2',
      cron_restart: '*/5 * * * *',
      autorestart: false,
      watch: false,
      time: true
    },
    // Log sentinel: every 10 min scans the pm2 logs with a byte cursor, groups
    // errors by fingerprint and turns /admin/status yellow ONLY for an error shape
    // never seen before (or a known one spiking). Known noise is listed in
    // server/config/knownLogNoise.json or acknowledged from the page. Never emails.
    {
      name: 'statfink2-log-sentinel',
      script: './scripts/log-sentinel.js',
      args: '--once',
      cwd: '/home/joepaley/statfink2',
      cron_restart: '*/10 * * * *',
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
    // Nightly regression tests - never emails; failures show on /admin/status
    {
      name: 'statfink2-nightly-tests',
      script: './scripts/nightly-test-run.js',
      cwd: '/home/joepaley/statfink2',
      cron_restart: '0 12 * * *', // 12pm UTC = 4-5am PT; ~3min outage never overlaps a game window
      autorestart: false,
      watch: false,
      time: true
    },
    // Daily Double Check (docs/DOUBLECHECK.md): audits the most recent week
    // with a Final game against ESPN + the scoring rubric (every player, lineup,
    // matchup, touchdown and safety), read-only, ~25 s. 06:00 UTC = after any
    // Thu/Sun/Mon night finals and before nightly-tests stops the server at
    // 12:00. Skips the audit when nothing changed (still refreshes its status);
    // never emails; open questions go to Claude (doublecheck-reconcile.js) and
    // the verdicts show on /admin/status. Writes logs/doublecheck-latest.json.
    {
      name: 'statfink2-doublecheck-daily',
      script: './scripts/doublecheck-daily.js',
      cwd: '/home/joepaley/statfink2',
      cron_restart: '0 6 * * *',
      autorestart: false,
      watch: false,
      time: true
    },
    // Recap themes (since 2026-09-15; replaces the Tuesday recap cron): every 30 min,
    // exits at once unless the week's games are all Final and no themes exist yet;
    // then headless claude proposes 10 fresh themes -> recaps/{season}/data/weekNN-themes.json.
    // Recaps themselves are generated only from /admin Recaps (Generate button).
    {
      name: 'statfink2-recap-setup',
      script: './scripts/recap-setup.js',
      cwd: '/home/joepaley/statfink2',
      cron_restart: '*/30 * * * *',
      autorestart: false,
      watch: false,
      time: true
    },
    // Weekly advance (automatic since 2026-09-15): standings -> advance current_week ->
    // copy rosters, Wednesday 15:00 UTC (8am PDT) so the league has all of Tuesday to
    // review the completed week, with a Thursday 15:00 UTC retry (~9 h before kickoff).
    // Only runs on a PASS validation of the current week; WARN/FAIL/missing holds it
    // (warning on /admin/status), and logs/HOLD-ADVANCE (weekly-advance.js --hold) blocks it.
    {
      name: 'statfink2-weekly-advance',
      script: './scripts/weekly-advance.js',
      cwd: '/home/joepaley/statfink2',
      cron_restart: '0 15 * * 3,4',
      autorestart: false,
      watch: false,
      time: true
    },
   ]
};