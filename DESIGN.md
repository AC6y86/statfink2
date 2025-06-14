# DESIGN.md

# StatFink Fantasy Football Management System Design

> **Implementation Status**: This document reflects the **actual implemented system** as of 2024. StatFink is a single-league fantasy football management application with both internal admin tools and public viewing capabilities.

## Technology Stack
- **Backend**: Node.js with Express.js
- **Database**: SQLite3 with direct sqlite3 npm package
- **API Integration**: Tank01 NFL API via RapidAPI for live player data and statistics
- **Frontend**: Vanilla HTML/CSS/JavaScript with modern ES6+ features
- **Testing**: Jest with comprehensive unit and integration test suites
- **Server**: Express server with health monitoring and graceful shutdown
- **Architecture**: Single-league system with admin dashboard and public viewing interface

## Database Schema

**Note**: The current implementation uses a simplified single-league approach without user authentication.

### League Configuration
```sql
CREATE TABLE league_settings (
    league_id INTEGER PRIMARY KEY DEFAULT 1,
    league_name VARCHAR(100) NOT NULL DEFAULT 'StatFink Fantasy League',
    max_teams INTEGER DEFAULT 12,
    roster_size INTEGER DEFAULT 16,
    starting_lineup_size INTEGER DEFAULT 9,
    scoring_type VARCHAR(20) DEFAULT 'ppr',
    season_year INTEGER DEFAULT 2024,
    current_week INTEGER DEFAULT 1
);
```

### Teams
```sql
CREATE TABLE teams (
    team_id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_name VARCHAR(100) NOT NULL,
    owner_name VARCHAR(100) NOT NULL,
    total_points REAL DEFAULT 0,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    ties INTEGER DEFAULT 0
);
```

### NFL Players
```sql
CREATE TABLE nfl_players (
    player_id VARCHAR(50) PRIMARY KEY, -- Tank01 API player ID
    name VARCHAR(100) NOT NULL,
    position VARCHAR(10) NOT NULL,
    team VARCHAR(10) NOT NULL,
    bye_week INTEGER,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Fantasy Rosters
```sql
CREATE TABLE fantasy_rosters (
    roster_id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    player_id VARCHAR(50) NOT NULL,
    roster_position VARCHAR(20) DEFAULT 'starter', -- 'starter', 'injured_reserve'
    acquisition_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (team_id) REFERENCES teams(team_id),
    FOREIGN KEY (player_id) REFERENCES nfl_players(player_id),
    UNIQUE(team_id, player_id)
);
```

### Player Stats
```sql
CREATE TABLE player_stats (
    stat_id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id VARCHAR(50),
    week INTEGER,
    season INTEGER,
    -- Offensive stats
    passing_yards INTEGER DEFAULT 0,
    passing_tds INTEGER DEFAULT 0,
    interceptions INTEGER DEFAULT 0,
    rushing_yards INTEGER DEFAULT 0,
    rushing_tds INTEGER DEFAULT 0,
    receiving_yards INTEGER DEFAULT 0,
    receiving_tds INTEGER DEFAULT 0,
    receptions INTEGER DEFAULT 0,
    fumbles INTEGER DEFAULT 0,
    -- Defensive stats (for DST)
    sacks INTEGER DEFAULT 0,
    def_interceptions INTEGER DEFAULT 0,
    fumbles_recovered INTEGER DEFAULT 0,
    def_touchdowns INTEGER DEFAULT 0,
    safeties INTEGER DEFAULT 0,
    points_allowed INTEGER DEFAULT 0,
    yards_allowed INTEGER DEFAULT 0,
    -- Kicking stats
    field_goals_made INTEGER DEFAULT 0,
    field_goals_attempted INTEGER DEFAULT 0,
    extra_points_made INTEGER DEFAULT 0,
    extra_points_attempted INTEGER DEFAULT 0,
    field_goals_0_39 INTEGER DEFAULT 0,
    field_goals_40_49 INTEGER DEFAULT 0,
    field_goals_50_plus INTEGER DEFAULT 0,
    -- Calculated
    fantasy_points REAL DEFAULT 0,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (player_id) REFERENCES nfl_players(player_id)
);
```

### Weekly Matchups
```sql
CREATE TABLE matchups (
    matchup_id INTEGER PRIMARY KEY AUTOINCREMENT,
    week INTEGER NOT NULL,
    season INTEGER NOT NULL,
    team1_id INTEGER NOT NULL,
    team2_id INTEGER NOT NULL,
    team1_points REAL DEFAULT 0,
    team2_points REAL DEFAULT 0,
    is_complete BOOLEAN DEFAULT 0,
    FOREIGN KEY (team1_id) REFERENCES teams(team_id),
    FOREIGN KEY (team2_id) REFERENCES teams(team_id)
);
```

### Weekly Roster Snapshots
```sql
CREATE TABLE weekly_rosters (
    weekly_roster_id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    player_id VARCHAR(50) NOT NULL,
    week INTEGER NOT NULL,
    season INTEGER NOT NULL,
    roster_position VARCHAR(20) NOT NULL, -- 'starter', 'bench', 'injured_reserve'
    player_name VARCHAR(100) NOT NULL, -- Denormalized for historical accuracy
    player_position VARCHAR(10) NOT NULL,
    player_team VARCHAR(10) NOT NULL,
    snapshot_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (team_id) REFERENCES teams(team_id),
    FOREIGN KEY (player_id) REFERENCES nfl_players(player_id),
    UNIQUE(team_id, player_id, week, season)
);
```

### Scoring Rules (PPR by Default)
```sql
CREATE TABLE scoring_rules (
    rule_id INTEGER PRIMARY KEY AUTOINCREMENT,
    stat_type VARCHAR(50) NOT NULL UNIQUE,
    points_per_unit REAL NOT NULL
);
```

## Application Architecture

### Actual Directory Structure
```
statfink2/
├── server/                        # Backend Node.js application
│   ├── app.js                     # Main Express server with routing
│   ├── database/
│   │   ├── database.js            # SQLite connection & database manager
│   │   ├── schema.sql             # Complete database schema
│   │   ├── validation.js          # Data validation utilities
│   │   └── migrations/            # Database migration scripts
│   ├── routes/                    # API route handlers
│   │   ├── admin.js              # Admin sync and management endpoints
│   │   ├── databaseBrowser.js    # Database browser API
│   │   ├── league.js             # League settings and info
│   │   ├── matchups.js           # Weekly matchup data
│   │   ├── players.js            # NFL player information
│   │   ├── rosterHistory.js      # Historical roster snapshots
│   │   ├── stats.js              # Player statistics
│   │   └── teams.js              # Team and roster management
│   ├── services/                  # Business logic services
│   │   ├── playerSyncService.js  # NFL player synchronization
│   │   ├── scoringService.js     # Fantasy point calculations
│   │   ├── statsSyncService.js   # Player stats synchronization
│   │   └── tank01Service.js      # Tank01 API integration
│   └── utils/                     # Utility functions
│       ├── errorHandler.js       # Error handling and logging
│       ├── importWeeklyRosters.js # Roster import utilities
│       ├── initializeLeague.js   # League setup script
│       ├── recalculateFantasyPoints.js # Point recalculation
│       ├── rosterSnapshot.js     # Weekly roster snapshots
│       └── validation.js         # Input validation
├── helm/                          # Frontend web interface
│   ├── dashboard.html            # Internal admin dashboard
│   ├── roster.html               # Roster management interface
│   ├── statfink.html             # Public live matchup viewer
│   ├── 2024-season.html          # Season navigation page
│   ├── database-browser.html     # Database browser interface
│   ├── statfink-styles.css       # Shared styling
│   └── [image assets]            # Logos and backgrounds
├── tests/                         # Comprehensive test suite
│   ├── unit/                     # Unit tests (40 tests)
│   ├── integration/              # Integration tests (75+ tests)
│   ├── fixtures/                 # Test data
│   └── [test utilities]
├── unused/                        # Legacy scripts and utilities
├── coverage/                      # Test coverage reports
├── fantasy_football.db           # SQLite database file
└── package.json                  # Dependencies and scripts
```

### Component Overview

#### Internal Dashboard Components (`/helm/`)
These are administrative tools for league management:

1. **Database Dashboard** (`dashboard.html`)
   - Player database browser with search and filtering
   - Team and roster overview
   - League settings management
   - Admin controls for player/stats synchronization
   - System health monitoring
   - Database browser with custom SQL query capability

2. **Roster Management** (`roster.html`)
   - Add/remove players from team rosters
   - Move players between active and injured reserve
   - Visual roster display with player details
   - Available player selection grouped by position

3. **Database Browser** (`database-browser.html`)
   - Direct database table exploration
   - Custom SQL query execution
   - Table schema viewing
   - Data export capabilities

#### Public Viewing Interface (`/helm/statfink.html`)
This is the main interface for league members to view scores:

- **Live Matchup Viewer**: Real-time fantasy football scores
- **Team Roster Display**: View all team rosters with player stats
- **Week Navigation**: Browse different weeks of the season
- **Player Performance**: Detailed statistics and fantasy points
- **Responsive Design**: Works on desktop and mobile devices

**URL Routes for Public Access:**
- `/statfink` - Redirects to current week
- `/statfink/2024/12` - View specific year/week
- `/statfink/mock` - Testing interface

#### Backend Services Architecture

1. **Tank01Service** (`server/services/tank01Service.js`)
   - NFL API integration with caching
   - Player data synchronization
   - Statistics fetching and transformation
   - Health monitoring and rate limiting

2. **ScoringService** (`server/services/scoringService.js`)
   - Fantasy point calculations for all positions
   - Configurable scoring rules (PPR by default)
   - Real-time score updates

3. **PlayerSyncService** (`server/services/playerSyncService.js`)
   - Automated NFL player roster updates
   - Position and team changes tracking
   - Injury status monitoring

4. **StatsSyncService** (`server/services/statsSyncService.js`)
   - Weekly player statistics synchronization
   - Fantasy point calculation and storage
   - Batch processing for performance

## Key Features and Implementation

### 1. Live Score Tracking
- **Real-time Updates**: Tank01 API integration for live NFL statistics
- **Fantasy Point Calculation**: Configurable PPR scoring system
- **Weekly Snapshots**: Historical roster tracking for accurate scoring
- **Matchup Display**: Side-by-side team comparison with live scores

### 2. Roster Management
- **Admin Interface**: Add/remove players, manage injured reserve
- **Position Validation**: Enforce roster construction rules
- **Historical Tracking**: Weekly roster snapshots for record keeping
- **Availability Tracking**: Players grouped by availability status

### 3. League Administration
- **Settings Management**: Configure current week, season year, scoring rules
- **Data Synchronization**: Automated player and statistics updates
- **Database Management**: Direct database access and query capabilities
- **Health Monitoring**: System status and API connectivity tracking

### 4. Public Viewing Experience
- **Statfink Interface**: Clean, responsive matchup viewer
- **Week Navigation**: Easy browsing of different weeks
- **Team Details**: Complete roster and player performance display
- **Mobile Responsive**: Optimized for all device sizes

## Testing Framework

### Test Suite Overview
StatFink includes a comprehensive testing framework with **115+ tests** across unit and integration categories:

#### Unit Tests (40 tests)
- **Validation Tests** (16): Data validation rules and input sanitization
- **Scoring Service Tests** (12): Fantasy point calculations for all positions
- **Error Handler Tests** (12): Custom error classes and middleware
- **Speed**: Very fast (< 1 second)
- **Dependencies**: None (completely isolated)

#### Integration Tests (75+ tests)
- **Database Tests** (18): CRUD operations, transactions, constraints
- **Tank01 API Tests** (8 groups): Health checks, player sync, data transformation
- **Dashboard Tests** (14 groups): Web interface, API integration, admin functions
- **Roster Management Tests** (17): Player add/drop, position changes, validation
- **Speed**: Moderate (2-30 seconds depending on server state)
- **Dependencies**: Running StatFink server

### Test Configuration
```javascript
// jest.config.js
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverageFrom: ['server/**/*.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  maxWorkers: 2,
  projects: [
    {
      displayName: 'unit',
      testMatch: ['<rootDir>/tests/unit/**/*.test.js'],
      testTimeout: 5000
    },
    {
      displayName: 'integration', 
      testMatch: ['<rootDir>/tests/integration/**/*.test.js'],
      testTimeout: 15000
    }
  ]
};
```

### Available Test Commands
```bash
# Fast unit tests (recommended for development)
npm run test:fast        # Silent, fastest (<1 second)
npm run test:unit        # With output (~1 second)

# Integration tests (require running server)
npm run test:integration # Server-dependent tests (~30 seconds)

# All tests
npm test                 # Complete test suite

# Other options
npm run test:watch       # Watch mode for development
npm run test:coverage    # Generate coverage report
```

## API Endpoints

### Public Endpoints
- `GET /health` - System health check
- `GET /statfink` - Redirect to current week matchups
- `GET /statfink/:year/:week` - View specific week matchups
- `GET /dashboard` - Admin dashboard interface
- `GET /roster` - Roster management interface

### Team Management
- `GET /api/teams` - Get all teams
- `GET /api/teams/:id` - Get team details
- `GET /api/teams/:id/roster` - Get team roster
- `POST /api/teams/:id/roster/add` - Add player to roster
- `PUT /api/teams/:id/roster/move` - Move player position
- `DELETE /api/teams/:id/roster/remove` - Remove player from roster

### Player Data
- `GET /api/players` - Get all NFL players
- `GET /api/players/available` - Get unrostered players
- `GET /api/players/position/:position` - Get players by position

### Statistics and Scoring
- `GET /api/stats/:playerId/:week/:season` - Get player stats
- `POST /api/admin/sync/stats` - Sync weekly statistics
- `GET /api/admin/sync/status` - Check sync status

### League Management
- `GET /api/league/settings` - Get league settings
- `PUT /api/league/settings` - Update league settings
- `GET /api/league/standings` - Get current standings

### Matchups
- `GET /api/matchups/:week/:season` - Get weekly matchups

### Admin Tools
- `POST /api/admin/sync/players` - Sync NFL players
- `GET /api/admin/dashboard` - Admin dashboard data
- `GET /api/database/tables` - Database table information
- `POST /api/database/query` - Execute custom SQL queries

## Environment Setup

### Installation
```bash
git clone <repository-url>
cd statfink2
npm install
```

### Dependencies
```json
{
  "dependencies": {
    "axios": "^1.9.0",
    "cors": "^2.8.5", 
    "dotenv": "^16.5.0",
    "express": "^4.21.2",
    "node-cron": "^4.1.0",
    "sqlite3": "^5.1.7"
  },
  "devDependencies": {
    "jest": "^30.0.0",
    "nodemon": "^3.1.10",
    "supertest": "^7.1.1"
  }
}
```

### Environment Variables
Create `.env` file:
```
TANK01_API_KEY=your_tank01_api_key
PORT=3000
NODE_ENV=development
```

### Running the Application
```bash
# Development with auto-restart
npm run dev

# Production
npm start

# Initialize league (first time setup)
npm run init-league

# Run tests
npm test
npm run test:unit
npm run test:integration
```

### Database Initialization
The database schema is automatically created on first run. For manual initialization:
```bash
node server/utils/initializeLeague.js
```

## System Architecture Summary

StatFink is a **single-league fantasy football management system** designed for simplicity and efficiency:

- **Single Database**: SQLite3 for easy deployment and maintenance
- **No Authentication**: Simplified access model for trusted league environments  
- **Real-time Data**: Tank01 API integration for live NFL statistics
- **Dual Interface**: Admin tools for management, public interface for viewing
- **Comprehensive Testing**: 115+ tests ensuring reliability
- **Performance Optimized**: Efficient database queries with proper indexing
- **Mobile Responsive**: Works seamlessly across all device types

The system is production-ready and optimized for leagues that want a powerful, easy-to-maintain fantasy football tracking solution without the complexity of multi-league or user authentication systems.