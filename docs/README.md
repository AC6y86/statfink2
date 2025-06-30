# StatFink Fantasy Football

A comprehensive Personal Football League (PFL) management system with automated player data synchronization, advanced roster management, real-time scoring, and secure web-based interfaces.

## Current Status: Production-Ready Fantasy Football Platform ✅

The project is a **complete full-stack fantasy football application** with enterprise-grade features:

### Core Features
- ✅ Express API server with comprehensive fantasy football endpoints
- ✅ Tank01 NFL API integration with 1,800+ players synchronized
- ✅ Weekly player statistics synchronization from Tank01 API
- ✅ Complete 2024 season roster data (Weeks 1-17) imported from Excel
- ✅ All 32 NFL team defenses automatically managed
- ✅ Web dashboard with comprehensive roster and database management
- ✅ Database browser with full table exploration and SQL queries
- ✅ Weekly roster history tracking and snapshot functionality
- ✅ PFL-specific roster constraints and validation
- ✅ Unlimited injured reserve management
- ✅ Player deduplication and data integrity
- ✅ Complete SQLite schema with defensive and kicking stats
- ✅ Automatic fantasy point calculations for weekly stats
- ✅ 115+ unit and integration tests passing
- ✅ Comprehensive error handling and logging

### Advanced Features
- ✅ **HTTPS/SSL Support**: Automatic HTTPS with Let's Encrypt and self-signed certificates
- ✅ **Authentication System**: Session-based auth with bcrypt, rate limiting, and CSRF protection
- ✅ **Public Pages**: Unauthenticated access to standings and rosters for league viewing
- ✅ **Mock Week Testing**: Comprehensive testing framework for live scoring simulation
- ✅ **Injury Tracking**: Real-time injury designation, description, and return date tracking
- ✅ **Division Support**: Odd/Even team divisions for playoff calculations
- ✅ **Scoring Players System**: Only top 11 offensive + 2 DST players count for scoring
- ✅ **Season Recalculation**: Utility to recalculate entire 2024 season stats
- ✅ **Real-time Game Tracking**: Live NFL game scores and updates
- ✅ **Weekly Standings**: Historical standings by week with cumulative points

**Current Phase**: Production deployment with security, authentication, and advanced scoring features

## Features Implemented

### Core Infrastructure ✅
- **Express API Server**: Complete REST API with all fantasy football endpoints
- **Database Schema**: SQLite3 with comprehensive fantasy football schema
- **Tank01 Integration**: Live NFL player data sync with 1,792+ players
- **Web Dashboard**: Comprehensive database viewing and management interface
- **Database Browser**: Full table exploration with search, filtering, and SQL queries
- **Testing Suite**: 115+ unit and integration tests with Jest and Puppeteer

### Security & Authentication ✅
- **HTTPS/SSL**: Automatic certificate management with Let's Encrypt
- **Session Management**: Secure session-based authentication
- **Password Security**: Bcrypt hashing with configurable rounds
- **Rate Limiting**: Protection against brute force attacks
- **CSRF Protection**: Token-based request validation
- **Helmet.js**: Security headers and XSS protection

### Service Architecture ✅
- **Player Sync Service**: Automated NFL player data synchronization
- **Stats Sync Service**: Weekly player statistics from Tank01 API
- **Roster History Service**: Weekly roster snapshots and historical tracking
- **NFL Games Service**: Real-time game tracking and scoring updates
- **Standings Service**: Weekly standings calculation with rankings
- **Scoring Players Service**: Determines which players score each week
- **Season Recalculation Orchestrator**: Complete season stat refresh
- **Individual Player Scoring Service**: Player-level scoring calculations
- **Game Score Service**: Game-level scoring aggregation
- **Team Score Service**: Team scoring with position limits
- **Data Cleanup Service**: Database integrity maintenance
- **Mock Data Service**: Comprehensive mock week testing data

### Fantasy Football Features ✅
- **PFL Scoring System**: PFL-specific scoring rules (no PPR)
- **Scoring Players Logic**: Top 11 offensive + 2 DST players per team
- **League Management**: 12-team league with division support
- **PFL Roster Constraints**: Min requirements (2 QB, 5 RB, 6 WR/TE, 2 K, 2 DST)
- **Unlimited Injured Reserve**: Flexible IR management
- **Injury Tracking**: Real-time injury updates from Tank01
- **Division-based Playoffs**: Odd/Even team divisions
- **Weekly Matchups**: Automated matchup generation and scoring
- **Historical Data**: Complete 2024 season with authentic UI

## Technology Stack

- **Backend**: Node.js with Express 4.x
- **Database**: SQLite3 with migrations support
- **External API**: Tank01 NFL API for live data
- **Frontend**: Vanilla JavaScript with responsive design
- **Security**: Helmet.js, express-session, bcrypt, express-rate-limit, csurf
- **HTTPS**: Let's Encrypt (production) and self-signed (development)
- **Testing**: Jest (unit/integration) + Puppeteer (browser tests)
- **Validation**: Custom validation framework
- **Authentication**: Session-based with secure cookies
- **Logging**: Structured logging with timestamps

## Setup and Development

### 1. Clone the repository:
```bash
git clone https://github.com/AC6y86/statfink2.git
cd statfink2
```

### 2. Install dependencies:
```bash
npm install
```

### 3. Set up environment variables:
```bash
cp .env.example .env
```

Edit `.env` and configure:
```bash
# Required
TANK01_API_KEY=your_api_key_here

# Optional - Authentication
SESSION_SECRET=your-session-secret-here
ADMIN_PASSWORD_HASH=$2b$10$... # Generate with node server/auth/generateHash.js

# Optional - HTTPS
SSL_KEY_PATH=/path/to/privkey.pem
SSL_CERT_PATH=/path/to/fullchain.pem
USE_SELF_SIGNED_CERT=false
```

### 4. Initialize the league database:
```bash
npm run init-league
```

### 5. Start the server:
```bash
npm start
```

### 6. Access the web interfaces:

**HTTP Access** (default):
```
http://localhost:8000/dashboard         # Main dashboard (requires auth)
http://localhost:8000/database-browser  # Database browser (requires auth)
http://localhost:8000/statfink          # Authentic Statfink UI
http://localhost:8000/2024-season       # 2024 season overview
http://localhost:8000/roster            # Roster management (requires auth)
http://localhost:8000/standings         # Public standings view
http://localhost:8000/rosters           # Public rosters view
http://localhost:8000/login            # Authentication login
http://localhost:8000/mockWeek         # Mock week testing interface
```

**HTTPS Access** (if configured):
```
https://localhost:8443/                 # All routes available via HTTPS
```

### 7. Run tests to verify setup:
```bash
# Fast unit tests (recommended for development)
npm run test:fast

# Full test suite (requires running server)
npm test
```

## Project Structure

```
statfink2/
├── server/
│   ├── auth/             # Authentication system
│   │   ├── authMiddleware.js     # Session and CSRF middleware
│   │   ├── generateHash.js       # Password hash generator
│   │   └── sessionConfig.js      # Session configuration
│   ├── database/         # Database layer
│   │   ├── schema.sql            # Complete database schema
│   │   ├── connection.js         # SQLite connection management
│   │   ├── validation.js         # Input validation
│   │   └── migrations/           # Database migrations
│   ├── services/         # Business logic (16 services)
│   │   ├── playerSyncService.js  # NFL player synchronization
│   │   ├── statsSyncService.js   # Weekly stats sync
│   │   ├── nflGamesService.js    # Game tracking
│   │   ├── standingsService.js   # Standings calculation
│   │   ├── scoringPlayersService.js  # Scoring player selection
│   │   └── ...                   # Other services
│   ├── routes/           # API endpoints (10 modules)
│   │   ├── auth.js               # Authentication routes
│   │   ├── players.js            # Player endpoints
│   │   ├── teams.js              # Team management
│   │   ├── standings.js          # Standings endpoints
│   │   └── ...                   # Other routes
│   ├── utils/            # Utilities
│   │   ├── errorHandler.js       # Error handling middleware
│   │   ├── initializeLeague.js   # League setup
│   │   └── rosterImport.js       # Excel import
│   └── app.js            # Express server with HTTPS
├── tests/
│   ├── unit/             # Unit tests (40+)
│   ├── integration/      # Integration tests (75+)
│   ├── browser/          # Puppeteer tests
│   ├── mockWeeks/        # Mock week test data
│   ├── fixtures/         # Test fixtures
│   ├── test-runner.js    # Test execution helper
│   └── README.md         # Test documentation
├── helm/                 # Protected web interfaces
│   ├── dashboard.html    # Main dashboard
│   ├── database-browser.html  # Database explorer
│   ├── roster.html       # Roster management
│   └── ...              # Other admin pages
├── public/               # Public web interfaces
│   ├── standings.html    # Public standings
│   ├── rosters.html      # Public rosters
│   ├── statfink.html     # Classic UI
│   ├── mock-weeks-index.html  # Mock testing
│   └── ...              # Other public pages
├── certs/                # SSL certificates
├── utils/                # Utility scripts
│   ├── recalculate2024season.js  # Season recalculation
│   └── ...              # Other utilities
├── data/                 # SQLite database files
├── docs/                 # Documentation
│   ├── README.md         # This file
│   ├── USAGE.md          # User guide
│   ├── DESIGN.md         # Architecture docs
│   └── SCORING_SYSTEM.md # Scoring rules
├── CLAUDE.md             # AI assistant instructions
└── package.json          # Dependencies and scripts
```

## Available Commands

### Server Management
```bash
npm start                # Start server (HTTP + HTTPS if configured)
npm run dev              # Development mode with auto-reload
npm run init-league      # Initialize 12-team league
```

### Testing (115+ tests)
```bash
npm run test:fast        # Unit tests only (< 1 second)
npm run test:unit        # Unit tests with output
npm run test:integration # Integration tests (requires server)
npm run test:browser     # Puppeteer browser tests
npm test                 # Full test suite
npm run test:watch       # Watch mode for development
npm run test:coverage    # Coverage report
```

### Utilities
```bash
# Season recalculation
node utils/recalculate2024season.js

# Generate password hash for authentication
node server/auth/generateHash.js

# Test runner with server detection
node tests/test-runner.js [unit|integration|fast|all|help]
```

## API Reference

### Authentication Endpoints
- `GET /login` - Login page
- `POST /login` - Authenticate user
- `POST /logout` - Logout user  
- `GET /api/auth/check` - Check authentication status

### Core API Endpoints
- `GET /health` - Server health with service status
- `GET /api/players` - List all NFL players
- `GET /api/teams` - Fantasy teams with standings
- `GET /api/league` - League settings

### Player Management
- `GET /api/players/position/:position` - Players by position
- `GET /api/players/available/:position?` - Available free agents
- `GET /api/players/:id` - Player details with stats

### Team Management
- `GET /api/teams/:id/roster` - Team roster details
- `POST /api/teams/:id/roster/add` - Add player to roster
- `PUT /api/teams/:id/roster/move` - Move player status
- `DELETE /api/teams/:id/roster/remove` - Remove player

### Game & Scoring
- `GET /api/matchups/week/:week` - Weekly matchups
- `GET /api/nfl-games/:week/:season` - NFL games
- `GET /api/nfl-games/mock/:week/:season` - Mock games
- `GET /api/standings/:season/:week` - Weekly standings
- `GET /api/standings/weekly-winners/:season` - Season winners

### Public Endpoints
- `GET /api/rosters/:season/:week` - Public roster data
- `GET /api/standings/current` - Current standings

### Admin Features (Auth Required)
- `GET /api/admin/dashboard` - Admin statistics
- `POST /api/admin/sync/players` - Sync NFL players
- `POST /api/admin/sync/stats` - Sync player stats
- `GET /api/database/tables` - Database schema
- `POST /api/database/query` - Execute SQL queries

## Security Configuration

### HTTPS/SSL Setup

**Option 1: Let's Encrypt (Production)**
```bash
# Set in .env:
SSL_KEY_PATH=/etc/letsencrypt/live/yourdomain.com/privkey.pem
SSL_CERT_PATH=/etc/letsencrypt/live/yourdomain.com/fullchain.pem
```

**Option 2: Self-Signed (Development)**
```bash
# Set in .env:
USE_SELF_SIGNED_CERT=true
```

### Authentication Setup
```bash
# Generate admin password hash
node server/auth/generateHash.js

# Add to .env:
SESSION_SECRET=your-secure-random-string
ADMIN_PASSWORD_HASH=$2b$10$...generated-hash...
```

### Security Features
- Session-based authentication with secure cookies
- Bcrypt password hashing (configurable rounds)
- Rate limiting on authentication endpoints
- CSRF protection on state-changing operations
- Security headers via Helmet.js
- XSS protection and content security policies

## Development Status

### Completed Phases ✅
- **Phase 1**: Database layer with validation
- **Phase 2**: Express API server
- **Phase 3**: Tank01 API integration
- **Phase 4**: Web dashboard interface
- **Phase 5**: Roster management system
- **Phase 6**: PFL constraints and validation
- **Phase 7**: Stats sync and scoring
- **Phase 8**: 2024 season import
- **Phase 9**: Database browser
- **Phase 10**: Authentication & security
- **Phase 11**: Public viewing pages
- **Phase 12**: Mock week testing
- **Phase 13**: Real-time game tracking
- **Phase 14**: Season recalculation

### Future Enhancements 🚀
- Automated playoff bracket generation
- Draft management system
- Trade processing and validation
- Mobile-responsive design improvements
- WebSocket support for live updates
- Email notifications for league events

## Contributing

This is a private project. For bug reports or feature requests, please contact the maintainers.

## License

This project is private and proprietary.