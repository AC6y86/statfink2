# StatFink Fantasy Football

A comprehensive Personal Football League (PFL) management system with automated player data synchronization, advanced roster management, and web-based interfaces.

## Current Status: Complete Fantasy Football System ✅

The project has a **complete full-stack fantasy football application** with:
- ✅ Express API server with all fantasy football endpoints
- ✅ Tank01 NFL API integration with 1,800+ players synchronized
- ✅ Weekly player statistics synchronization from Tank01 API
- ✅ All 32 NFL team defenses automatically managed
- ✅ Web dashboard with comprehensive roster management
- ✅ PFL-specific roster constraints and validation
- ✅ Unlimited injured reserve management
- ✅ Player deduplication and data integrity
- ✅ Complete SQLite schema with defensive and kicking stats
- ✅ Automatic fantasy point calculations for weekly stats
- ✅ 98+ unit and integration tests passing
- ✅ Comprehensive error handling and logging
- ✅ Network-only deployment (no authentication required)

**Current Phase**: Complete NFL data integration with live statistics

## Features Implemented

### Core Infrastructure ✅
- **Express API Server**: Complete REST API with all fantasy football endpoints
- **Database Schema**: SQLite3 with defensive stats, kicking stats, and PPR scoring
- **Tank01 Integration**: Live NFL player data sync with 1,792+ players
- **Stats Sync Service**: Weekly player statistics synchronization from Tank01 API
- **Web Dashboard**: Comprehensive database viewing and management interface
- **Player Sync Service**: Automated NFL player data synchronization
- **Testing Suite**: 98+ unit and integration tests with Jest

### Fantasy Football Features ✅
- **Data Validation**: Input validation for all entities (players, stats, teams, matchups)
- **Scoring Engine**: PPR scoring calculations for all positions including DST
- **Error Handling**: Custom error classes with Express middleware
- **League Management**: 12-team league with complete roster support
- **PFL Roster Constraints**: Minimum requirements (2 QB, 5 RB, 6 WR/TE, 2 K, 2 DST)
- **Unlimited Injured Reserve**: Teams can have multiple players on IR
- **All NFL Defenses**: 32 team defenses with preservation during API syncs
- **Player Deduplication**: Automatic cleanup of duplicate player entries
- **Admin Controls**: Network-accessible admin interface (no password required)
- **Real-time Data**: Live player statistics and team information

## Technology Stack

- **Backend**: Node.js with Express 4.x server
- **Database**: SQLite3 with comprehensive fantasy football schema
- **External API**: Tank01 NFL API for live player data
- **Frontend**: Pure JavaScript web dashboard (no frameworks)
- **Testing**: Jest with 98+ unit and integration tests
- **Validation**: Custom validation framework with error handling
- **Deployment**: Network-only (no authentication required)

## Setup and Development

1. Clone the repository:
```bash
git clone https://github.com/AC6y86/statfink2.git
cd statfink2
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
cp .env.example .env
# Add your Tank01 API key to .env:
# TANK01_API_KEY=your_api_key_here
```

4. Initialize the league database:
```bash
npm run init-league
```

5. Start the server:
```bash
npm start
```

6. Access the web interfaces:
```
http://localhost:3000/dashboard    # Main dashboard
http://localhost:3000/roster       # Roster management
```

7. Run tests to verify setup:
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
│   ├── database/         # Database schema, connection, validation
│   ├── services/         # Tank01 API, player sync, scoring
│   ├── routes/           # Complete API routes (6 modules)
│   ├── utils/            # Error handling, initialization, backup
│   └── app.js            # Express server with graceful shutdown
├── tests/
│   ├── unit/             # Unit tests (40 tests - no dependencies)
│   ├── integration/      # Integration tests (58+ tests - require server)
│   ├── fixtures/         # Test data and sample objects
│   ├── test-runner.js    # Guided test runner script
│   └── README.md         # Comprehensive test documentation
├── public/
│   ├── dashboard.html    # Main web dashboard interface
│   └── roster.html       # Dedicated roster management interface
├── data/                 # SQLite database and backups
├── DESIGN.md             # Original design document
├── IMPLEMENTATION_STEPS.md  # Implementation guide
└── README.md             # This file
```

## Available Commands

```bash
# Server
npm start                # Start the Express server
npm run dev              # Start with auto-reload (development)

# Database
npm run init-league      # Initialize league with 12 teams

# Testing (98+ total tests)
npm run test:fast        # Unit tests only, silent (< 1 second)
npm run test:unit        # Unit tests with output (~1 second)
npm run test:integration # Integration tests (requires server, ~30 seconds)
npm test                 # Run all tests (~45 seconds)
npm run test:watch       # Run tests in watch mode
npm run test:coverage    # Run tests with coverage report

# Test runner with server checking
node tests/test-runner.js [unit|integration|fast|all|help]
```

## Development Status

- ✅ **Phase 1**: Database layer with validation and testing
- ✅ **Phase 2**: Express API server with all endpoints
- ✅ **Phase 3**: Tank01 NFL API integration with player sync
- ✅ **Phase 4**: Web dashboard interface
- ✅ **Phase 5**: Complete roster management system
- ✅ **Phase 6**: PFL roster constraints and validation
- ✅ **Phase 7**: Tank01 stats sync and fantasy scoring system
- ⏳ **Phase 8**: Automated matchups and real-time features

## API Endpoints

### Core Endpoints
- `GET /health` - Server health check with service status
- `GET /dashboard` - Main web dashboard interface
- `GET /roster` - Dedicated roster management interface
- `GET /api/players` - List all NFL players with filtering
- `GET /api/teams` - Fantasy teams with standings
- `GET /api/league` - League settings and configuration

### Fantasy Football Features
- `GET /api/players/position/:position` - Players by position
- `GET /api/players/available/:position?` - Available free agents
- `GET /api/teams/:id/roster` - Team roster with starters/bench/injured_reserve
- `POST /api/teams/:id/roster/add` - Add player to roster (starter/bench/injured_reserve)
- `PUT /api/teams/:id/roster/move` - Move player between positions
- `DELETE /api/teams/:id/roster/remove` - Remove player from roster
- `GET /api/matchups/week/:week` - Weekly matchups and scores
- `GET /api/stats/rankings/:position` - Player rankings by position

### Admin Features (Network Only)
- `GET /api/admin/dashboard` - Admin overview with statistics
- `GET /api/admin/sync/status` - Tank01 sync status
- `POST /api/admin/sync/players` - Trigger player synchronization
- `GET /api/admin/sync/stats/status` - Stats sync status
- `POST /api/admin/sync/stats` - Weekly stats synchronization from Tank01

## Testing

98+ comprehensive tests covering:

### Unit Tests (40 tests - no dependencies)
- Data validation for all entities
- Fantasy scoring calculations (PPR, DST, kicking)
- Error handling and custom error classes
- Business logic and utility functions

### Integration Tests (58+ tests - require server)
- Database operations with real connections
- API endpoint responses and data consistency
- Tank01 API integration and player synchronization
- Web dashboard functionality and performance
- Admin interface without authentication

### Test Features
- **Fast Development**: Unit tests run in < 1 second
- **Server Detection**: Integration tests skip gracefully when server not running
- **Parallel Execution**: Optimized for CI/CD with Jest maxWorkers
- **Comprehensive Coverage**: All major functionality tested

### Running Tests
```bash
# Development workflow
npm run test:fast           # Quick feedback during coding

# Before committing
npm start &                  # Start server in background
npm run test:integration     # Verify all integrations work
npm test                     # Full validation
```

## License

This project is private and proprietary.