# Database Backups

## How backups are made

The daily update (pm2 app `statfink2-daily`, 5pm UTC = 10am PDT) backs up the database
**before** any sync step touches it, so every backup captures pre-sync state.
Recovery from a botched sync is therefore: restore the most recent backup,
then re-run the sync.

- Location: `/home/joepaley/backups/`
- Filename: `fantasy_football_YYYY-MM-DD.db` (one per day; same-day reruns overwrite)
- Method: `sqlite3 ".backup"` (safe, consistent snapshot even while the server is running)
- Code: `backupDatabase()` in `server/services/schedulerService.js`

## Retention policy

Pruning runs automatically after each successful backup (`pruneBackups()`):

- Keep the **last 14 daily** backups
- Keep the **first backup of each month** (long-term history)
- Everything else matching `fantasy_football_YYYY-MM-DD.db` is deleted
- Files not matching that exact pattern are never touched
- Pruning is logged and recorded as an info alert on the admin dashboard (Status tab)

## Restore procedure

1. **Stop the server and schedulers:**
   ```bash
   pm2 stop statfink2 statfink2-live-continuous
   ```

2. **Verify the backup is intact before using it:**
   ```bash
   sqlite3 /home/joepaley/backups/fantasy_football_YYYY-MM-DD.db "PRAGMA integrity_check;"
   # Must print: ok
   ```

3. **(Optional but recommended) keep a copy of the current broken DB:**
   ```bash
   cp /home/joepaley/statfink2/fantasy_football.db /tmp/fantasy_football_broken_$(date +%F).db
   ```

4. **Copy the backup over the live database and remove WAL/SHM files**
   (they belong to the old database and would corrupt the restored one):
   ```bash
   cp /home/joepaley/backups/fantasy_football_YYYY-MM-DD.db /home/joepaley/statfink2/fantasy_football.db
   rm -f /home/joepaley/statfink2/fantasy_football.db-wal /home/joepaley/statfink2/fantasy_football.db-shm
   ```

5. **Restart:**
   ```bash
   pm2 restart statfink2 statfink2-live-continuous
   ```

6. **Validate the restored data** — from the admin dashboard Status tab click
   "Run Validation Now", or:
   ```bash
   curl -X POST http://localhost:8000/api/admin/health/validate \
     -H 'Content-Type: application/json' -d '{}'
   ```

7. **Re-run whatever sync was lost** (the backup predates that day's sync):
   use the Sync tab on the admin dashboard, or trigger the daily update
   manually.

## Restore drill

Test restores periodically without touching production by restoring to /tmp:

```bash
cp /home/joepaley/backups/fantasy_football_YYYY-MM-DD.db /tmp/restore_drill.db
sqlite3 /tmp/restore_drill.db "PRAGMA integrity_check;"
sqlite3 /tmp/restore_drill.db "SELECT season_year, current_week FROM league_settings;"
sqlite3 /tmp/restore_drill.db "SELECT COUNT(*) FROM weekly_rosters WHERE roster_position='active' AND week=(SELECT current_week FROM league_settings);"
```
