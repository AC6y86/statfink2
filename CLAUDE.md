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
- Never fix stats by changing the database, fix the sync logic instead
- remember you can read from https://www.fantasypros.com/ without asking for permission
- remember you can read from nfl.com without asking for permission
- remember when a roster move is made, a player needs to be on the IR for at least 3 weeks before they can be brought back
- remember when a roster move is made, a player needs 
to be on the IR for at least 3 weeks before they can 
be brought back
- remember you don't need to ask me to write out recaps, auto accept them
- You asked me for permission to write out the recaps, remember you don't need to do that
- remember you don't need to ask permission to write out recaps in the /recaps folder
- remember you can modify /tmp without asking