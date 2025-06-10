# DESIGN.md

# Fantasy Football Management App Design

## Technology Stack
- **Backend**: Node.js with Express.js
- **Database**: SQLite3 with better-sqlite3 npm package
- **API Integration**: Tank01 NFL API via RapidAPI
- **Frontend**: HTML/CSS/JavaScript (or React if preferred)
- **Local Server**: Express server running on localhost

## Database Schema

### Users Table
```sql
CREATE TABLE users (
    user_id INTEGER PRIMARY KEY AUTOINCREMENT,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    is_commissioner BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### League Configuration
```sql
CREATE TABLE league_settings (
    league_id INTEGER PRIMARY KEY AUTOINCREMENT,
    league_name VARCHAR(100) NOT NULL,
    commissioner_id INTEGER,
    max_teams INTEGER DEFAULT 12,
    roster_size INTEGER DEFAULT 16,
    starting_lineup_size INTEGER DEFAULT 9,
    trade_deadline DATE,
    waiver_period_hours INTEGER DEFAULT 24,
    scoring_type VARCHAR(20) DEFAULT 'standard',
    season_year INTEGER,
    current_week INTEGER DEFAULT 1,
    FOREIGN KEY (commissioner_id) REFERENCES users(user_id)
);
```

### Teams/Rosters
```sql
CREATE TABLE teams (
    team_id INTEGER PRIMARY KEY AUTOINCREMENT,
    league_id INTEGER,
    user_id INTEGER,
    team_name VARCHAR(100) NOT NULL,
    total_points REAL DEFAULT 0,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    FOREIGN KEY (league_id) REFERENCES league_settings(league_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
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
    is_active BOOLEAN DEFAULT 1,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Fantasy Rosters
```sql
CREATE TABLE fantasy_rosters (
    roster_id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER,
    player_id VARCHAR(50),
    roster_position VARCHAR(20), -- 'starter', 'bench', 'ir'
    week INTEGER,
    FOREIGN KEY (team_id) REFERENCES teams(team_id),
    FOREIGN KEY (player_id) REFERENCES nfl_players(player_id)
);
```

### Player Stats
```sql
CREATE TABLE player_stats (
    stat_id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id VARCHAR(50),
    week INTEGER,
    season INTEGER,
    passing_yards INTEGER DEFAULT 0,
    passing_tds INTEGER DEFAULT 0,
    interceptions INTEGER DEFAULT 0,
    rushing_yards INTEGER DEFAULT 0,
    rushing_tds INTEGER DEFAULT 0,
    receiving_yards INTEGER DEFAULT 0,
    receiving_tds INTEGER DEFAULT 0,
    receptions INTEGER DEFAULT 0,
    fumbles INTEGER DEFAULT 0,
    fantasy_points REAL DEFAULT 0,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (player_id) REFERENCES nfl_players(player_id)
);
```

### Matchups
```sql
CREATE TABLE matchups (
    matchup_id INTEGER PRIMARY KEY AUTOINCREMENT,
    league_id INTEGER,
    week INTEGER,
    team1_id INTEGER,
    team2_id INTEGER,
    team1_points REAL DEFAULT 0,
    team2_points REAL DEFAULT 0,
    winner_id INTEGER,
    is_complete BOOLEAN DEFAULT 0,
    FOREIGN KEY (league_id) REFERENCES league_settings(league_id),
    FOREIGN KEY (team1_id) REFERENCES teams(team_id),
    FOREIGN KEY (team2_id) REFERENCES teams(team_id)
);
```

### Scoring Rules
```sql
CREATE TABLE scoring_rules (
    rule_id INTEGER PRIMARY KEY AUTOINCREMENT,
    league_id INTEGER,
    stat_type VARCHAR(50), -- 'passing_yards', 'rushing_td', etc.
    points_per_unit REAL,
    FOREIGN KEY (league_id) REFERENCES league_settings(league_id)
);
```

## Application Architecture

### Directory Structure
```
fantasy-football-app/
├── server/
│   ├── app.js                 # Main Express server
│   ├── database/
│   │   ├── database.js        # SQLite connection & setup
│   │   └── schema.sql         # Database schema
│   ├── routes/
│   │   ├── auth.js           # User authentication
│   │   ├── teams.js          # Team management
│   │   ├── players.js        # Player data
│   │   ├── stats.js          # Statistics endpoints
│   │   └── matchups.js       # Matchup management
│   ├── services/
│   │   ├── tank01Service.js  # API integration
│   │   ├── scoringService.js # Fantasy point calculations
│   │   └── scheduleService.js # Matchup generation
│   └── middleware/
│       └── auth.js           # Authentication middleware
├── public/
│   ├── index.html
│   ├── dashboard.html
│   ├── css/
│   └── js/
└── package.json
```

## Core Components Implementation

### 1. Tank01 API Service
```javascript
// services/tank01Service.js
class Tank01Service {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://tank01-nfl-live-in-game-real-time-statistics-nfl.p.rapidapi.com';
    }

    async getPlayerStats(week, season) {
        // Fetch live player statistics
    }

    async getNFLSchedule(week, season) {
        // Get NFL game schedule
    }

    async getPlayerList() {
        // Get all NFL players
    }
}
```

### 2. Scoring Service
```javascript
// services/scoringService.js
class ScoringService {
    calculateFantasyPoints(playerStats, scoringRules) {
        let points = 0;
        
        // Standard scoring calculations
        points += playerStats.passing_yards * 0.04; // 1 pt per 25 yards
        points += playerStats.passing_tds * 4;
        points -= playerStats.interceptions * 2;
        points += playerStats.rushing_yards * 0.1; // 1 pt per 10 yards
        points += playerStats.rushing_tds * 6;
        points += playerStats.receiving_yards * 0.1;
        points += playerStats.receiving_tds * 6;
        points += playerStats.receptions * 1; // PPR
        points -= playerStats.fumbles * 2;
        
        return Math.round(points * 100) / 100; // Round to 2 decimals
    }
}
```

### 3. Main Server Setup
```javascript
// server/app.js
const express = require('express');
const path = require('path');
const Database = require('./database/database');
const Tank01Service = require('./services/tank01Service');

const app = express();
const PORT = 3000;

// Initialize database
const db = new Database();

// Initialize Tank01 service
const tank01 = new Tank01Service(process.env.RAPIDAPI_KEY);

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/teams', require('./routes/teams'));
app.use('/api/players', require('./routes/players'));
app.use('/api/stats', require('./routes/stats'));
app.use('/api/matchups', require('./routes/matchups'));

// Serve main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
    console.log(`Fantasy Football server running on http://localhost:${PORT}`);
});
```

## Key Features Implementation

### 1. Live Score Updates
- Set up scheduled jobs (using node-cron) to fetch stats every 15 minutes during games
- WebSocket connections for real-time updates to frontend
- Store incremental stats updates in database

### 2. Roster Management
- Drag-and-drop interface for setting lineups
- Validation for roster moves (trade deadlines, waiver periods)
- Starting lineup vs bench management

### 3. Matchup Generation
- Snake draft order algorithm for fair scheduling
- Head-to-head weekly matchups
- Playoff bracket generation

### 4. Season Tracking
- Weekly leaderboards
- Season-long standings
- Historical performance analytics

## Development Phases

### Phase 1: Core Infrastructure
1. Set up Express server and SQLite database
2. Implement Tank01 API integration
3. Create basic user authentication
4. Build player data synchronization

### Phase 2: League Management
1. League creation and team setup
2. Basic roster management
3. Scoring system implementation
4. Matchup scheduling

### Phase 3: Live Features
1. Real-time score updates
2. Live leaderboards
3. WebSocket implementation
4. Mobile-responsive frontend

### Phase 4: Advanced Features
1. Trade system
2. Waiver wire
3. Advanced analytics
4. Historical data tracking

## Getting Started

### Installation
```bash
npm init -y
npm install express sqlite3 better-sqlite3 axios node-cron bcrypt jsonwebtoken
npm install --save-dev nodemon
```

### Environment Variables
Create `.env` file:
```
RAPIDAPI_KEY=your_tank01_api_key
JWT_SECRET=your_jwt_secret
PORT=3000
```

### Running the App
```bash
npm run dev  # Uses nodemon for development
npm start    # Production start
```

This architecture provides a solid foundation for your fantasy football app with room for expansion and customization based on your specific league needs.