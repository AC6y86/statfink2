# Season Restart Guide

**Last verified:** January 2026 (2025 season)

This guide will help you restart the PFL StatFink site after the 9-month off-season. Follow the checklists and commands below to get everything running again.

---

## Quick Start Checklist

Run through these items in order when starting a new season:

- [ ] 1. Verify server and services are running
- [ ] 2. Check SSL certificate status
- [ ] 3. Verify Tank01 API key is active
- [ ] 4. Update season year in database
- [ ] 5. Sync NFL players for new season
- [ ] 6. Build rosters for each team (19 players per team)
- [ ] 7. Verify everything works

---

## 1. Server Status Check

### Check PM2 Processes
```bash
pm2 status
```

You should see these processes:
- `statfink2` - Main web server (should be "online")
- `statfink2-daily` - Daily sync job
- `statfink2-live-continuous` - Live game updates
- `statfink2-weekly` - Weekly advancement

### Start/Restart Server
```bash
# If PM2 processes aren't running:
cd /home/joepaley/statfink2
pm2 start ecosystem.config.js

# If already running but need restart:
pm2 restart all

# Save PM2 config so it survives reboot:
pm2 save
```

### Health Check
```bash
curl http://localhost:8000/health
```
Should return `{"status":"healthy",...}`

---

## 2. SSL Certificate Check

**Domain:** `peninsulafootball.com`

### Check Certificate Expiration
```bash
sudo certbot certificates
```

Look for the expiration date. Let's Encrypt certs last 90 days but auto-renew.

### Force Renewal (if expired or expiring soon)
```bash
sudo certbot renew
```

### Nginx Configuration
SSL certs are stored at:
- Certificate: `/etc/letsencrypt/live/peninsulafootball.com/fullchain.pem`
- Private key: `/etc/letsencrypt/live/peninsulafootball.com/privkey.pem`

Nginx config is at: `/etc/nginx/sites-available/statfink2`

### Restart Nginx After Cert Changes
```bash
sudo nginx -t          # Test config
sudo systemctl reload nginx
```

---

## 3. Credentials Reference

### Tank01 NFL API Key
- **Location:** `.env` file in project root
- **Variable:** `TANK01_API_KEY`
- **Starts with:** `280034...`
- **Renewal URL:** https://rapidapi.com/tank01/api/tank01-nfl-live-in-game-real-time-statistics-nfl
- **Check usage:** Log into RapidAPI dashboard

To test the API key is working:
```bash
curl http://localhost:8000/health
```
Look for `"tank01": "healthy"` in the response.

### Other .env Variables
| Variable | Purpose | Notes |
|----------|---------|-------|
| `DATABASE_PATH` | SQLite database location | `./fantasy_football.db` |
| `PORT` | HTTP server port | `8000` |
| `SESSION_SECRET` | Session encryption | 64-char hex string, don't change |
| `ADMIN_PASSWORD_HASH` | Admin login | Regenerate if you forgot password |

### Regenerate Admin Password (if needed)
```bash
cd /home/joepaley/statfink2
node server/auth/generateHash.js
# Follow prompts, then update ADMIN_PASSWORD_HASH in .env
pm2 restart statfink2
```

---

## 4. New Season Setup

### Update Season Year
```bash
sqlite3 /home/joepaley/statfink2/fantasy_football.db
```

```sql
-- Check current settings
SELECT * FROM league_settings;

-- Update for new season (replace 2026 with actual year)
UPDATE league_settings SET season_year = 2026, current_week = 1 WHERE league_id = 1;

-- Verify
SELECT season_year, current_week FROM league_settings;
.quit
```

### Sync NFL Players
Via admin dashboard:
1. Go to https://peninsulafootball.com/admin
2. Login
3. Click "Sync Players"

Or via API:
```bash
curl -X POST http://localhost:8000/api/admin/sync/players
```

This will pull ~1800+ NFL players with current team/position data.

### Build Rosters
Use the roster management interface at https://peninsulafootball.com/roster

Each team needs exactly **19 players**:
- Minimum: 2 QB, 5 RB, 6 WR/TE, 2 K, 2 DEF

---

## 5. Verification Checklist

After setup, verify everything works:

### Web Access
- [ ] https://peninsulafootball.com loads (no cert errors)
- [ ] https://peninsulafootball.com/statfink shows matchup page
- [ ] https://peninsulafootball.com/standings shows standings
- [ ] https://peninsulafootball.com/admin login works

### API Health
```bash
# Full health check
curl http://localhost:8000/health | jq

# Expected: status=healthy, tank01=healthy, database connected
```

### Database Integrity
```bash
sqlite3 /home/joepaley/statfink2/fantasy_football.db "SELECT COUNT(*) FROM nfl_players"
# Should return 1800+

sqlite3 /home/joepaley/statfink2/fantasy_football.db "SELECT COUNT(*) FROM teams"
# Should return 12
```

### PM2 Logs (check for errors)
```bash
pm2 logs statfink2 --lines 50
```

---

## 6. Scheduled Tasks

The following tasks run automatically via PM2:

| Task | Schedule | What it does |
|------|----------|--------------|
| `statfink2-daily` | 3am PST daily | Syncs NFL schedule, backs up DB, updates injuries |
| `statfink2-live-continuous` | Every minute | Updates live game scores during games |
| `statfink2-weekly` | Tuesdays | Creates standings, advances week when games complete |

### Check Next Run Time
```bash
pm2 describe statfink2-daily
```

### Manual Triggers
```bash
# Daily sync
node /home/joepaley/statfink2/scripts/daily-update.js

# Live update
node /home/joepaley/statfink2/scripts/live-update-continuous.js

# Weekly check
node /home/joepaley/statfink2/scripts/weekly-update-check.js
```

---

## 7. Troubleshooting

### Server Won't Start
```bash
# Check for port conflicts
ss -tlnp | grep 8000

# Check PM2 logs
pm2 logs statfink2 --err --lines 100

# Try starting directly to see errors
cd /home/joepaley/statfink2
node server/app.js
```

### Database Issues
```bash
# Test database connection
sqlite3 /home/joepaley/statfink2/fantasy_football.db ".tables"

# Check database integrity
sqlite3 /home/joepaley/statfink2/fantasy_football.db "PRAGMA integrity_check"
```

### SSL/HTTPS Issues
```bash
# Test nginx config
sudo nginx -t

# Check nginx error log
sudo tail -50 /var/log/nginx/error.log

# Check certificate status
sudo certbot certificates
```

### Tank01 API Not Working
1. Check API key in `.env`
2. Log into RapidAPI dashboard to check subscription status
3. Check for rate limiting (usage limits)

### PM2 Not Starting on Boot
```bash
pm2 startup
# Follow the instructions it prints
pm2 save
```

---

## 8. Useful Commands Reference

### Server Management
```bash
pm2 status                    # Check all processes
pm2 restart statfink2         # Restart main server
pm2 restart all               # Restart everything
pm2 logs statfink2            # View server logs
pm2 logs                      # View all logs
```

### Database Access
```bash
# Open database browser
https://peninsulafootball.com/database-browser

# Or via command line
sqlite3 /home/joepaley/statfink2/fantasy_football.db
```

### Season Recalculation
If you need to recalculate all stats for a season:
```bash
cd /home/joepaley/statfink2
node utils/recalculate2024season.js
```
(Update the year in the script name as needed)

### Backups
Daily backups are stored in: `/home/joepaley/backups/`
Format: `fantasy_football_YYYY-MM-DD.db`

---

## 9. Key Files Reference

| File | Purpose |
|------|---------|
| `/home/joepaley/statfink2/.env` | Environment variables (API keys, secrets) |
| `/home/joepaley/statfink2/ecosystem.config.js` | PM2 configuration |
| `/home/joepaley/statfink2/fantasy_football.db` | SQLite database |
| `/home/joepaley/statfink2/server/app.js` | Main server entry point |
| `/etc/nginx/sites-available/statfink2` | Nginx config |
| `/etc/letsencrypt/live/peninsulafootball.com/` | SSL certificates |

---

## 10. Contact & Support

- **Project repo:** `/home/joepaley/statfink2`
- **Other docs:** See `docs/` folder for detailed documentation on specific features
- **CLAUDE.md:** Contains project-specific AI assistant instructions

Happy new season!
