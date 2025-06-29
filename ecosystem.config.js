const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

module.exports = {
  apps: [{
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
  }]
};