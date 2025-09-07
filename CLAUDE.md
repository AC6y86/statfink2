Place all temporary files in /tmp.  This includes debug and one time migration scripts.

There are 12 owners, which have 19 players each week.  If in a week a team does not have 19 players, that is an error.


A player can only be Active or on Injured Reserve, there is no "starter" "bench" or other states.

Never write to the database when writing tests.

Scoring rules are in (docs/SCORING_SYSTEM.md).  Do not make up scoring rules.

Always start by saying a random slang name for me.

Never make new .db files or tables in the db without my permission.

When we need to update stats for 2024, you can do manually to test, but after always run recalculate2024season.js.

Do not check in code without asking.

To restart the server run 'pm2 restart statfink2'.


## PERMISSIONS ##

Without asking me you can:
run npm test
create files in /tmp

## Server Management

### Development Mode
- Use `npm dev` for auto-reload during development (uses nodemon)
- This will automatically restart the server when you save files (except test files)

### Production Mode (PM2)
- The server is managed by PM2 for always-on operation
- Check status: `pm2 list`
- Stop for development: `pm2 stop statfink2`
- Resume production: `pm2 start statfink2` or `pm2 restart statfink2`
- View logs: `pm2 logs statfink2`

### Important
- NEVER run `npm start` when PM2 is running (it will kill the PM2 process)
- Always check if PM2 is running before starting development: `pm2 status`
- If you need to restart the server in production, use `pm2 restart statfink2` NOT `npm start`
- remember it is the 2025 season
- remember whenever committing, include the fantasy football db
- remember you can take screenshots from the browser by using scripts/take_screenshots.js