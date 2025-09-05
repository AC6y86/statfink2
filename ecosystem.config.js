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
      cron_restart: '0 11 * * *', // 10am UTC = 3am PDT (Pacific Daylight Time)
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
    {
      name: 'statfink2-weekly',
      script: './scripts/weekly-update-check.js',
      cwd: '/home/joepaley/statfink2',
      cron_restart: '0 10 * * 2', // 10am UTC Tuesday = 3am PDT Tuesday (after Monday night games)
      autorestart: false,
      watch: false,
      time: true
    }
  ]
};