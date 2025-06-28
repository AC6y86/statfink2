# StatFink Fantasy Football System Design

> **Implementation Status**: This document reflects the **actual implemented system** as of 2024. StatFink is a production-ready, single-league fantasy football management application with enterprise-grade features including authentication, HTTPS support, real-time scoring, and comprehensive testing.

## Technology Stack

### Core Technologies
- **Backend**: Node.js with Express.js 4.x
- **Database**: SQLite3 with migrations support
- **API Integration**: Tank01 NFL API via RapidAPI for live data
- **Frontend**: Vanilla HTML/CSS/JavaScript with modern ES6+ features
- **Testing**: Jest (115+ tests) with Puppeteer for browser testing
- **Security**: Helmet.js, bcrypt, express-session, express-rate-limit, csurf
- **HTTPS**: Let's Encrypt and self-signed certificate support

### Architecture Overview
- **Single-league system** with multi-division support
- **Session-based authentication** with secure password hashing
- **Real-time scoring** with automated player selection
- **Public and protected interfaces** for different user types
- **Comprehensive API** with RESTful endpoints
- **Microservices pattern** for business logic separation

## Database Schema

### Enhanced Database Design
The system uses SQLite3 with a comprehensive schema supporting all fantasy football operations.

#### Core Tables

##### Teams
```sql
CREATE TABLE teams (
    team_id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_name VARCHAR(100) NOT NULL,
    owner_name VARCHAR(100) NOT NULL,
    division VARCHAR(10) DEFAULT 'Odd', -- 'Odd' or 'Even'
    total_points REAL DEFAULT 0,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    ties INTEGER DEFAULT 0
);
```

##### NFL Players
```sql
CREATE TABLE nfl_players (
    player_id VARCHAR(50) PRIMARY KEY, -- Tank01 API player ID
    name VARCHAR(100) NOT NULL,
    position VARCHAR(10) NOT NULL,
    team VARCHAR(10) NOT NULL,
    bye_week INTEGER,
    injury_designation VARCHAR(50), -- 'Questionable', 'Doubtful', 'Out', 'IR'
    injury_description TEXT,
    injury_return_date DATE,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

##### Fantasy Rosters
```sql
CREATE TABLE fantasy_rosters (
    roster_id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    player_id VARCHAR(50) NOT NULL,
    roster_position VARCHAR(20) DEFAULT 'active', -- 'active', 'injured_reserve'
    acquisition_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (team_id) REFERENCES teams(team_id),
    FOREIGN KEY (player_id) REFERENCES nfl_players(player_id),
    UNIQUE(team_id, player_id)
);
```

#### Game and Scoring Tables

##### NFL Games
```sql
CREATE TABLE nfl_games (
    game_id VARCHAR(50) PRIMARY KEY,
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    game_date DATE,
    game_time TIME,
    home_team VARCHAR(10) NOT NULL,
    away_team VARCHAR(10) NOT NULL,
    home_score INTEGER DEFAULT 0,
    away_score INTEGER DEFAULT 0,
    quarter VARCHAR(10),
    time_remaining VARCHAR(10),
    possession VARCHAR(10),
    red_zone BOOLEAN DEFAULT 0,
    is_final BOOLEAN DEFAULT 0,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

##### Weekly Rosters (with Scoring Players)
```sql
CREATE TABLE weekly_rosters (
    weekly_roster_id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    player_id VARCHAR(50) NOT NULL,
    week INTEGER NOT NULL,
    season INTEGER NOT NULL,
    roster_position VARCHAR(20) NOT NULL,
    is_scoring BOOLEAN DEFAULT 0, -- Marks if player counts for scoring
    scoring_slot INTEGER, -- Position in scoring lineup (1-13)
    player_name VARCHAR(100) NOT NULL,
    player_position VARCHAR(10) NOT NULL,
    player_team VARCHAR(10) NOT NULL,
    fantasy_points REAL DEFAULT 0,
    snapshot_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (team_id) REFERENCES teams(team_id),
    FOREIGN KEY (player_id) REFERENCES nfl_players(player_id),
    UNIQUE(team_id, player_id, week, season)
);
```

##### Matchups (Enhanced)
```sql
CREATE TABLE matchups (
    matchup_id INTEGER PRIMARY KEY AUTOINCREMENT,
    week INTEGER NOT NULL,
    season INTEGER NOT NULL,
    team1_id INTEGER NOT NULL,
    team2_id INTEGER NOT NULL,
    team1_points REAL DEFAULT 0,
    team2_points REAL DEFAULT 0,
    team1_scoring_points REAL DEFAULT 0, -- Points from scoring players only
    team2_scoring_points REAL DEFAULT 0,
    is_complete BOOLEAN DEFAULT 0,
    winner_id INTEGER,
    FOREIGN KEY (team1_id) REFERENCES teams(team_id),
    FOREIGN KEY (team2_id) REFERENCES teams(team_id)
);
```

##### Weekly Standings
```sql
CREATE TABLE weekly_standings (
    standing_id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    week INTEGER NOT NULL,
    season INTEGER NOT NULL,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    ties INTEGER DEFAULT 0,
    weekly_points REAL DEFAULT 0,
    cumulative_points REAL DEFAULT 0,
    weekly_rank INTEGER,
    overall_rank INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (team_id) REFERENCES teams(team_id),
    UNIQUE(team_id, week, season)
);
```

#### Player Statistics Tables

##### Weekly Player Stats
```sql
CREATE TABLE weekly_player_stats (
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
    two_point_conversions INTEGER DEFAULT 0,
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
    ppr_points REAL DEFAULT 0,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (player_id) REFERENCES nfl_players(player_id),
    UNIQUE(player_id, week, season)
);
```

##### Scoring Rules
```sql
CREATE TABLE scoring_rules (
    rule_id INTEGER PRIMARY KEY AUTOINCREMENT,
    scoring_system VARCHAR(20) NOT NULL, -- 'PPR' or 'PFL'
    stat_type VARCHAR(50) NOT NULL,
    points_per_unit REAL NOT NULL,
    UNIQUE(scoring_system, stat_type)
);
```

## Application Architecture

### Directory Structure
```
statfink2/
├── server/
│   ├── app.js                     # Express server with HTTPS support
│   ├── auth/                      # Authentication system
│   │   ├── authMiddleware.js     # Session and CSRF middleware
│   │   ├── sessionConfig.js      # Session configuration
│   │   └── generateHash.js       # Password hash utility
│   ├── database/
│   │   ├── connection.js         # SQLite connection manager
│   │   ├── schema.sql            # Complete database schema
│   │   ├── validation.js         # Input validation rules
│   │   └── migrations/           # Database migrations
│   ├── routes/                   # API endpoints (10 modules)
│   │   ├── auth.js              # Authentication routes
│   │   ├── admin.js             # Admin operations
│   │   ├── database.js          # Database browser API
│   │   ├── league.js            # League management
│   │   ├── matchups.js          # Matchup data
│   │   ├── nflGames.js          # NFL game tracking
│   │   ├── players.js           # Player management
│   │   ├── rosters.js           # Public roster viewing
│   │   ├── standings.js         # Standings calculations
│   │   └── teams.js             # Team management
│   ├── services/                # Business logic (16 services)
│   │   ├── playerSyncService.js          # NFL player sync
│   │   ├── statsSyncService.js           # Stats synchronization
│   │   ├── scoringService.js             # Fantasy scoring
│   │   ├── nflGamesService.js            # Game tracking
│   │   ├── standingsService.js           # Standings calculation
│   │   ├── scoringPlayersService.js      # Scoring player selection
│   │   ├── rosterHistoryService.js       # Roster snapshots
│   │   ├── seasonRecalculationOrchestrator.js  # Season recalc
│   │   ├── individualPlayerScoringService.js   # Player scoring
│   │   ├── gameScoreService.js           # Game-level scoring
│   │   ├── teamScoreService.js           # Team scoring
│   │   ├── dataCleanupService.js         # Data integrity
│   │   ├── mockDataService.js            # Mock testing data
│   │   ├── injuryTrackingService.js      # Injury updates
│   │   ├── tank01Service.js              # Tank01 API client
│   │   └── validationService.js          # Data validation
│   └── utils/                   # Utilities
│       ├── errorHandler.js      # Error handling
│       ├── logger.js            # Logging service
│       └── helpers.js           # Helper functions
├── helm/                        # Protected web interfaces
│   ├── dashboard.html          # Admin dashboard
│   ├── database-browser.html   # Database explorer
│   └── roster.html             # Roster management
├── public/                     # Public web interfaces
│   ├── standings.html          # Public standings
│   ├── rosters.html            # Public rosters
│   ├── statfink.html           # Classic matchup viewer
│   ├── login.html              # Authentication
│   └── mock-weeks-index.html   # Mock testing
├── tests/                      # Test suite (115+ tests)
│   ├── unit/                   # Unit tests
│   ├── integration/            # Integration tests
│   ├── browser/                # Puppeteer tests
│   └── mockWeeks/              # Mock test data
├── utils/                      # Command-line utilities
│   └── recalculate2024season.js  # Season recalculation
├── certs/                      # SSL certificates
└── data/                       # SQLite database files
```

## Service Architecture

### Core Services

#### 1. Authentication Service
- **Session Management**: Secure cookie-based sessions
- **Password Security**: Bcrypt hashing with salt rounds
- **Rate Limiting**: Brute force protection
- **CSRF Protection**: Token validation
- **Middleware Chain**: Layered security checks

#### 2. Player Sync Service
```javascript
// Responsibilities:
- Sync NFL players from Tank01 API
- Update injury statuses
- Track player team changes
- Maintain data integrity
- Handle API rate limits
```

#### 3. Scoring Players Service
```javascript
// Core Logic:
- Select top 11 offensive players by projected points
- Select top 2 DST units
- Mark players as scoring/non-scoring
- Update weekly roster records
- Handle position limits (max 4 RB, etc.)
```

#### 4. Standings Service
```javascript
// Features:
- Calculate weekly standings
- Track cumulative points
- Determine weekly winners
- Support division standings
- Historical standings by week
```

#### 5. NFL Games Service
```javascript
// Capabilities:
- Track real NFL game scores
- Support mock game data
- Update game status in real-time
- Calculate game impacts on fantasy
```

#### 6. Season Recalculation Orchestrator
```javascript
// Process:
1. Sync all NFL games for season
2. Sync player stats for each week
3. Calculate fantasy points
4. Determine scoring players
5. Update team scores
6. Calculate standings
7. Maintain data consistency
```

### Data Flow Architecture

```
Tank01 API → Player/Stats Sync → Database
                                    ↓
                            Scoring Calculation
                                    ↓
                            Scoring Players Selection
                                    ↓
                            Team Score Aggregation
                                    ↓
                            Standings Calculation
                                    ↓
                            Web Interface Display
```

## Security Architecture

### Authentication Flow
```
1. User Login → Password Verification (bcrypt)
2. Session Creation → Secure Cookie Set
3. Request → Session Validation → CSRF Check
4. Protected Resource Access
```

### Security Layers
1. **HTTPS/SSL**: Encrypted communication
2. **Helmet.js**: Security headers (XSS, etc.)
3. **Session Security**: httpOnly, sameSite cookies
4. **Rate Limiting**: Login attempt throttling
5. **Input Validation**: Comprehensive sanitization
6. **SQL Injection Prevention**: Parameterized queries

## API Design

### RESTful Principles
- Resource-based URLs
- HTTP methods for actions
- Consistent response format
- Proper status codes
- HATEOAS where applicable

### Response Format
```json
{
  "success": true,
  "data": {...},
  "message": "Operation completed",
  "meta": {
    "timestamp": "2024-12-28T12:00:00Z",
    "version": "1.0.0"
  }
}
```

### Error Format
```json
{
  "success": false,
  "error": {
    "code": "PLAYER_NOT_FOUND",
    "message": "Player with ID 123 not found",
    "status": 404,
    "details": {...}
  }
}
```

## Testing Strategy

### Test Categories

#### Unit Tests (40+ tests)
- **Validation**: Input sanitization and rules
- **Scoring**: Fantasy point calculations
- **Utilities**: Helper functions
- **Error Handling**: Custom error classes
- **No Dependencies**: Pure functions only

#### Integration Tests (75+ tests)
- **Database**: CRUD operations, constraints
- **API Endpoints**: Full request/response cycle
- **Services**: Business logic with dependencies
- **Tank01 Integration**: API mocking
- **Authentication**: Session management

#### Browser Tests (Puppeteer)
- **UI Interactions**: Form submissions
- **Navigation**: Page routing
- **Data Display**: Dynamic content
- **Responsive Design**: Mobile testing

### Test Configuration
```javascript
// Parallel test execution
projects: [
  { displayName: 'unit', testTimeout: 5000 },
  { displayName: 'integration', testTimeout: 15000 }
]

// Coverage targets
coverageThreshold: {
  global: {
    branches: 80,
    functions: 80,
    lines: 80,
    statements: 80
  }
}
```

## Performance Optimizations

### Database
- **Indexes**: On foreign keys and frequently queried columns
- **Query Optimization**: Efficient joins and aggregations
- **Connection Pooling**: Reuse database connections
- **Batch Operations**: Bulk inserts/updates

### API
- **Response Caching**: Tank01 API responses cached
- **Pagination**: Large result sets paginated
- **Lazy Loading**: Load data as needed
- **Compression**: Gzip response compression

### Frontend
- **Minification**: CSS/JS minified in production
- **Asset Caching**: Browser caching headers
- **Responsive Images**: Optimized for device size
- **Code Splitting**: Load features on demand

## Deployment Architecture

### Development
```
- Local SQLite database
- Self-signed SSL certificates
- Mock data for testing
- Hot reload with nodemon
```

### Production
```
- Let's Encrypt SSL certificates
- PM2 process management
- Database backups
- Health monitoring
- Log aggregation
```

### Environment Configuration
```bash
# Production settings
NODE_ENV=production
SESSION_SECRET=strong-random-string
ADMIN_PASSWORD_HASH=bcrypt-hash
SSL_CERT_PATH=/path/to/cert
SSL_KEY_PATH=/path/to/key
TANK01_API_KEY=api-key
```

## Future Architecture Considerations

### Potential Enhancements
1. **WebSocket Support**: Real-time score updates
2. **Redis Sessions**: Scalable session storage
3. **PostgreSQL Migration**: For larger scale
4. **API Gateway**: Rate limiting and caching
5. **Microservices**: Service separation
6. **Container Orchestration**: Kubernetes deployment

### Scalability Path
```
Current: Single Server + SQLite
    ↓
Phase 1: Load Balancer + PostgreSQL
    ↓
Phase 2: Microservices + Redis
    ↓
Phase 3: Kubernetes + Cloud Native
```

## System Architecture Summary

StatFink is a **production-ready fantasy football platform** with:

- **Enterprise Security**: Authentication, HTTPS, CSRF protection
- **Real-time Data**: Live NFL statistics and scoring
- **Automated Intelligence**: Smart scoring player selection
- **Comprehensive Testing**: 115+ tests ensuring reliability
- **Performance Optimized**: Efficient queries and caching
- **User-Friendly**: Public and admin interfaces
- **Maintainable**: Clean architecture and documentation
- **Scalable Design**: Clear path for growth

The system demonstrates modern web application best practices while maintaining simplicity for single-league deployments.