# StatFink Fantasy Football - Usage Guide

## 🚀 Getting Started

### Prerequisites
- Node.js (v14+ recommended)
- Tank01 API key (optional, for live NFL data)
- SSL certificates (optional, for HTTPS)

### Setup & Installation
```bash
# Clone and install
git clone https://github.com/AC6y86/statfink2.git
cd statfink2
npm install

# Configure environment
cp .env.example .env
```

Edit `.env` and configure:
```bash
# Required
TANK01_API_KEY=your_api_key_here

# Authentication (optional but recommended)
SESSION_SECRET=your-secure-random-string
ADMIN_PASSWORD_HASH=$2b$10$... # Generate with node server/auth/generateHash.js

# HTTPS/SSL Configuration (optional)
# Option 1: Let's Encrypt certificates
SSL_KEY_PATH=/etc/letsencrypt/live/yourdomain.com/privkey.pem
SSL_CERT_PATH=/etc/letsencrypt/live/yourdomain.com/fullchain.pem

# Option 2: Self-signed certificates
USE_SELF_SIGNED_CERT=true

# Additional Options
HTTPS_PORT=8443
NODE_ENV=production
```

### Database Initialization
```bash
# Initialize league database with 12 teams
npm run init-league

# Run database migrations
sqlite3 fantasy_football.db < server/database/migrations/add_nfl_games.sql
sqlite3 fantasy_football.db < server/database/migrations/add_scoring_players_columns.sql
sqlite3 fantasy_football.db < server/database/migrations/create_weekly_standings.sql
sqlite3 fantasy_football.db < server/database/migrations/add_division_to_teams.sql
sqlite3 fantasy_football.db < server/database/migrations/add_injury_columns.sql
```

### Authentication Setup
```bash
# Generate admin password hash
node server/auth/generateHash.js
# Follow prompts to create password hash
# Add the hash to ADMIN_PASSWORD_HASH in .env
```

### Start the Server
```bash
# Production mode (HTTP + HTTPS if configured)
npm start

# Development mode with auto-reload
npm run dev
```

## 📍 Access Points

### Public Routes (No Authentication Required)
- **Statfink Classic UI**: http://localhost:3000/statfink
  - Weekly matchups with live scoring
  - Navigate seasons/weeks: `/statfink/{year}/{week}`
  - Mock testing: `/statfink/mock/{week}`
- **Public Standings**: http://localhost:3000/standings
  - Current standings: `/standings`
  - Historical: `/standings/{season}/{week}`
- **Public Rosters**: http://localhost:3000/rosters
  - Current rosters: `/rosters`
  - Historical: `/rosters/{season}/{week}`
- **2024 Season Archive**: http://localhost:3000/2024-season
- **Mock Week Testing**: http://localhost:3000/mockWeek

### Protected Routes (Authentication Required)
- **Login**: http://localhost:3000/login
- **Main Dashboard**: http://localhost:3000/dashboard
- **Database Browser**: http://localhost:3000/database-browser
- **Roster Management**: http://localhost:3000/roster
- **Admin Controls**: Via dashboard interface

### HTTPS Access (if configured)
- **Secure Access**: https://localhost:8443/
- All routes available via HTTPS with same paths

## 🎮 Web Interface Features

### Main Dashboard (`/dashboard`)
Comprehensive database management interface with:

#### Players Tab
- Browse 1,800+ NFL players
- Real-time search by name
- Filter by position (QB, RB, WR, TE, K, DST)
- Filter by NFL team
- View injury status and return dates
- Pagination (50 players per page)

#### Teams Tab
- View all 12 fantasy teams
- Current standings with W-L-T records
- Total points and division info (Odd/Even)
- Quick roster access links

#### Admin Tab
- Sync players from Tank01 API
- View sync status and statistics
- Trigger stats synchronization
- Database health monitoring
- Injury report summary

### Database Browser (`/database-browser`)
Advanced database exploration tool:

#### Features
- Browse all database tables
- Execute custom SQL queries
- View table schemas and row counts
- Paginated results with search
- Export query results
- Real-time data exploration

#### Available Tables
- `teams` - Fantasy teams
- `nfl_players` - All NFL players with injuries
- `weekly_rosters` - Historical roster data
- `weekly_player_stats` - Player statistics
- `matchups` - Weekly matchups and scores
- `nfl_games` - Real NFL game data
- `weekly_standings` - Historical standings
- And more...

### Roster Management (`/roster`)
Dedicated interface for managing team rosters:

#### Features
- Select any of the 12 teams
- Add/drop players with validation
- Move players to/from injured reserve
- View current roster by position
- Automatic scoring player selection
- PFL roster constraint enforcement
- Real-time injury status display

#### Roster Rules
- Minimum requirements: 2 QB, 5 RB, 6 WR/TE, 2 K, 2 DST
- Unlimited injured reserve slots
- Only top 11 offensive + 2 DST players score
- Active roster limited to 19 players

### Mock Week Testing (`/mockWeek`)
Comprehensive testing interface for simulating live scoring:

#### Features
- Select mock weeks 1-18
- Test live scoring calculations
- Validate scoring player selection
- Simulate different game scenarios
- Useful for integration testing

## 🔌 API Reference

### Authentication

#### Login
```http
POST /login
Content-Type: application/json

{
  "username": "admin",
  "password": "your_password"
}
```

#### Logout
```http
POST /logout
```

#### Check Authentication
```http
GET /api/auth/check

Response:
{
  "authenticated": true,
  "username": "admin"
}
```

### Core Endpoints

#### Health Check
```http
GET /health

Response:
{
  "status": "healthy",
  "timestamp": "2025-06-28T12:00:00.000Z",
  "version": "1.0.0",
  "services": {
    "database": "connected",
    "tank01": "healthy"
  },
  "database": {
    "players": 1824,
    "teams": 12,
    "games": 256
  }
}
```

### Player Management

#### List All Players
```http
GET /api/players
GET /api/players?search=allen&position=QB&team=BUF

Response:
{
  "success": true,
  "data": [{
    "player_id": "00-0034796",
    "name": "Josh Allen",
    "position": "QB",
    "team": "BUF",
    "bye_week": 12,
    "injury_designation": null,
    "injury_description": null,
    "injury_return_date": null
  }],
  "count": 1824
}
```

#### Get Players by Position
```http
GET /api/players/position/{position}

Positions: QB, RB, WR, TE, K, DST
```

#### Get Available Free Agents
```http
GET /api/players/available
GET /api/players/available/{position}
```

#### Get Player Details
```http
GET /api/players/{playerId}

Response includes full player info with current stats
```

### Team Management

#### List All Teams
```http
GET /api/teams

Response:
{
  "success": true,
  "data": [{
    "team_id": 1,
    "team_name": "Team Alpha",
    "owner_name": "Owner 1",
    "division": "Odd",
    "wins": 8,
    "losses": 6,
    "ties": 0,
    "total_points": 1523.45
  }],
  "count": 12
}
```

#### Get Team Details
```http
GET /api/teams/{teamId}
```

#### Get Team Roster
```http
GET /api/teams/{teamId}/roster

Response:
{
  "success": true,
  "data": {
    "roster": [...],
    "active": [...],
    "injuredReserve": [...],
    "scoringPlayers": [...],
    "groupedByPosition": {
      "QB": [...],
      "RB": [...],
      "WR": [...],
      "TE": [...],
      "K": [...],
      "DST": [...]
    }
  }
}
```

### Roster Operations

#### Add Player to Roster
```http
POST /api/teams/{teamId}/roster/add
Content-Type: application/json

{
  "playerId": "00-0034796",
  "rosterPosition": "active"
}

Valid positions: "active", "injured_reserve"
```

#### Remove Player from Roster
```http
DELETE /api/teams/{teamId}/roster/remove
Content-Type: application/json

{
  "playerId": "00-0034796"
}
```

#### Move Player Position
```http
PUT /api/teams/{teamId}/roster/move
Content-Type: application/json

{
  "playerId": "00-0034796",
  "rosterPosition": "injured_reserve"
}
```

### Matchups & Scoring

#### Get Weekly Matchups
```http
GET /api/matchups/week/{week}

Response includes:
- Matchup pairings
- Team scores (total and scoring players only)
- Individual player scores
```

#### Get Player Rankings
```http
GET /api/stats/rankings/{position}

Returns players ranked by fantasy points
```

### NFL Games

#### Get Real NFL Games
```http
GET /api/nfl-games/{week}/{season}
GET /api/nfl-games/current

Response:
{
  "success": true,
  "data": [{
    "game_id": "2024_01_GB_PHI",
    "season": 2024,
    "week": 1,
    "game_date": "2024-09-06",
    "home_team": "PHI",
    "away_team": "GB",
    "home_score": 34,
    "away_score": 29,
    "is_final": true
  }]
}
```

#### Get Mock Games (Testing)
```http
GET /api/nfl-games/mock/{week}/{season}

Returns simulated game data for testing
```

### Standings

#### Get Weekly Standings
```http
GET /api/standings/{season}/{week}
GET /api/standings/current

Response:
{
  "success": true,
  "data": {
    "standings": [{
      "team_id": 1,
      "team_name": "Team Alpha",
      "division": "Odd",
      "wins": 8,
      "losses": 6,
      "weekly_points": 125.50,
      "cumulative_points": 1523.45,
      "rank": 3
    }],
    "weeklyWinner": {
      "team_name": "Team Bravo",
      "points": 145.25
    }
  }
}
```

#### Get Season Weekly Winners
```http
GET /api/standings/weekly-winners/{season}

Returns list of weekly high scorers
```

### Public Roster Data

#### Get All Rosters for Week
```http
GET /api/rosters/{season}/{week}

Returns all team rosters with scoring players marked
```

### Database Browser API

#### List All Tables
```http
GET /api/database/tables

Response:
{
  "success": true,
  "data": [{
    "name": "teams",
    "rowCount": 12,
    "columns": [...]
  }]
}
```

#### Query Table
```http
GET /api/database/table/{tableName}?limit=50&offset=0&search=text
```

#### Execute SQL Query
```http
POST /api/database/query
Content-Type: application/json

{
  "query": "SELECT * FROM teams WHERE wins > 5"
}
```

### Admin Operations (Auth Required)

#### Admin Dashboard Stats
```http
GET /api/admin/dashboard

Response includes:
- Player counts by position
- Injury report
- Tank01 sync status
- Database statistics
```

#### Sync Players from Tank01
```http
POST /api/admin/sync/players

Response:
{
  "success": true,
  "message": "Players synchronized successfully",
  "data": {
    "playersUpdated": 1824,
    "injuriesUpdated": 45,
    "duration": "3.2s"
  }
}
```

#### Sync Weekly Stats
```http
POST /api/admin/sync/stats
Content-Type: application/json

{
  "week": 15,
  "season": 2024
}
```

#### Sync NFL Games
```http
POST /api/admin/sync/games
Content-Type: application/json

{
  "week": 15,
  "season": 2024
}
```

## 🛠 Command Line Utilities

### Season Management
```bash
# Recalculate entire 2024 season
node utils/recalculate2024season.js

# This comprehensive utility:
# 1. Syncs all NFL games for the season
# 2. Syncs player stats for each week
# 3. Calculates fantasy points
# 4. Determines scoring players (top 11 + 2 DST)
# 5. Updates team scores
# 6. Calculates weekly standings
# 7. Maintains data integrity
```

### Database Maintenance
```bash
# Add all NFL team defenses
node server/utils/addTeamDefenses.js

# Remove duplicate players
node server/utils/deduplicatePlayers.js

# Import roster from file
node server/utils/importRoster.js /path/to/roster.txt

# Clean up duplicate teams
node server/utils/cleanupTeams.js

# Generate sitemap
node server/utils/generateSitemap.js
```

### Testing Commands
```bash
# Run all tests
npm test

# Fast unit tests (< 1 second)
npm run test:fast

# Integration tests (requires server)
npm run test:integration

# Browser tests with Puppeteer
npm run test:browser

# Watch mode for development
npm run test:watch

# Coverage report
npm run test:coverage

# Test specific modules
npm run test:integration -- tests/integration/standings.test.js
npm run test:unit -- tests/unit/scoring.test.js
```

## 🔒 Security Configuration

### HTTPS/SSL Setup

#### Option 1: Let's Encrypt (Production)
1. Obtain certificates for your domain
2. Configure in `.env`:
```bash
SSL_KEY_PATH=/etc/letsencrypt/live/yourdomain.com/privkey.pem
SSL_CERT_PATH=/etc/letsencrypt/live/yourdomain.com/fullchain.pem
```

#### Option 2: Self-Signed (Development)
1. Set in `.env`:
```bash
USE_SELF_SIGNED_CERT=true
```
2. Server will generate certificates automatically

### Security Features
- **Session Management**: Secure session cookies with httpOnly and sameSite
- **Password Security**: Bcrypt hashing with configurable salt rounds
- **Rate Limiting**: Protection against brute force attacks on login
- **CSRF Protection**: Token validation on state-changing requests
- **Security Headers**: Helmet.js for XSS and other protections
- **Input Validation**: Comprehensive validation on all inputs

### Production Deployment Checklist
- [ ] Set `NODE_ENV=production`
- [ ] Configure strong `SESSION_SECRET`
- [ ] Enable HTTPS with valid certificates
- [ ] Set up admin authentication
- [ ] Configure firewall rules
- [ ] Set up database backups
- [ ] Monitor with `/health` endpoint
- [ ] Review security headers
- [ ] Test rate limiting
- [ ] Verify CSRF protection

## 📊 Common Usage Patterns

### Initial Setup
1. Initialize league: `npm run init-league`
2. Sync NFL players: `POST /api/admin/sync/players`
3. Import rosters: Use roster management interface
4. Sync current week stats: `POST /api/admin/sync/stats`

### Weekly Operations
1. Sync NFL games: `POST /api/admin/sync/games`
2. Sync player stats: `POST /api/admin/sync/stats`
3. View standings: `/standings`
4. Check matchups: `/statfink`
5. Manage rosters: `/roster`

### Roster Management
1. Check free agents: `GET /api/players/available`
2. Add player: `POST /api/teams/{id}/roster/add`
3. Handle injuries: `PUT /api/teams/{id}/roster/move`
4. Drop player: `DELETE /api/teams/{id}/roster/remove`

### Testing & Development
1. Use mock weeks: `/mockWeek`
2. Test scoring: `/statfink/mock/{week}`
3. Verify calculations: Check database browser
4. Run test suite: `npm test`

## 🚨 Troubleshooting

### Common Issues

#### "Cannot find player" errors
- Run player sync: `POST /api/admin/sync/players`
- Check for duplicates: `node server/utils/deduplicatePlayers.js`

#### Scoring discrepancies
- Verify scoring players: Check `is_scoring` in rosters
- Run recalculation: `node utils/recalculate2024season.js`
- Check scoring rules: See `SCORING_SYSTEM.md`

#### Authentication issues
- Verify `SESSION_SECRET` is set
- Check `ADMIN_PASSWORD_HASH` is correct
- Clear browser cookies and retry

#### HTTPS not working
- Verify certificate paths in `.env`
- Check file permissions on certificates
- Try self-signed mode for testing

### Error Response Format
```json
{
  "success": false,
  "message": "Descriptive error message",
  "status": 400,
  "details": {...}
}
```

## 🤝 Support & Development

### Development Workflow
1. Start dev server: `npm run dev`
2. Make changes
3. Run fast tests: `npm run test:fast`
4. Test in browser
5. Run full tests: `npm test`
6. Commit with descriptive message

### Best Practices
- Always validate input data
- Include comprehensive tests
- Update documentation
- Follow existing code patterns
- Handle errors gracefully
- Log important operations
- Maintain backwards compatibility

### Getting Help
- Check `/health` endpoint first
- Review server logs for errors
- Run test suite to verify setup
- Check database with browser tool
- Verify Tank01 API connectivity