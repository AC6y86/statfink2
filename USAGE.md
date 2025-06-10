# StatFink Fantasy Football - Usage Guide

## 🚀 Getting Started

### Prerequisites
- Node.js (v14+ recommended)
- Tank01 API key (optional, for live NFL data)

### Setup & Installation
```bash
# Clone and install
git clone https://github.com/AC6y86/statfink2.git
cd statfink2
npm install

# Configure API key (optional)
cp .env.example .env
# Edit .env and add: TANK01_API_KEY=your_api_key_here

# Initialize league database
npm run init-league

# Start the server
npm start
```

### Access Points
- **Web Dashboard**: http://localhost:3000/dashboard
- **API Base URL**: http://localhost:3000/api
- **Health Check**: http://localhost:3000/health

---

## 🎮 Web Dashboard Commands

### Main Interface
Navigate to `http://localhost:3000/dashboard` for the comprehensive web interface.

#### **Available Tabs:**
- **Overview** - Database statistics and system status
- **Players** - Browse and search all NFL players (1,792+ players)
- **Teams** - View fantasy teams and standings
- **Rosters** - Team roster details with starters/bench/IR
- **Stats** - Database statistics and analytics
- **Admin** - Player sync and roster management

#### **Player Management:**
- **Search Players** - Real-time search by name
- **Filter by Position** - QB, RB, WR, TE, K, DST
- **Filter by Team** - All 32 NFL teams
- **Pagination** - 50 players per page

#### **Roster Management (Admin Tab):**
- **Select Team** - Choose from 12 fantasy teams
- **Add Players** - Add available players to roster
- **Move Players** - Change between starter/bench/injured reserve
- **Remove Players** - Drop players from roster
- **IR Management** - Place one player on injured reserve per team

---

## 🔌 API Endpoints Reference

### Core System Endpoints

#### Health Check
```http
GET /health
```
**Response:** Server health, database status, Tank01 API status
```json
{
  "status": "healthy",
  "timestamp": "2025-06-10T15:30:00.000Z",
  "version": "1.0.0",
  "services": {
    "database": "connected",
    "tank01": "healthy"
  }
}
```

### Player Management

#### Get All Players
```http
GET /api/players
```
**Response:** All NFL players (1,792+ players)
```json
{
  "success": true,
  "data": [
    {
      "player_id": "player123",
      "name": "Josh Allen",
      "position": "QB",
      "team": "BUF",
      "bye_week": 12,
      "last_updated": "2025-06-10T12:00:00.000Z"
    }
  ],
  "count": 1792
}
```

#### Get Players by Position
```http
GET /api/players/position/{position}
```
**Parameters:**
- `position` - QB, RB, WR, TE, K, DST

**Example:**
```http
GET /api/players/position/QB
```

#### Get Available Players (Free Agents)
```http
GET /api/players/available
GET /api/players/available/{position}
```
**Response:** Players not on any fantasy roster

### Team Management

#### Get All Teams
```http
GET /api/teams
```
**Response:** All 12 fantasy teams with standings
```json
{
  "success": true,
  "data": [
    {
      "team_id": 1,
      "team_name": "Team Alpha",
      "owner_name": "Owner 1",
      "wins": 0,
      "losses": 0,
      "ties": 0,
      "total_points": 0.0
    }
  ],
  "count": 12
}
```

#### Get Specific Team
```http
GET /api/teams/{teamId}
```
**Response:** Team details with full roster

#### Get Team Roster
```http
GET /api/teams/{teamId}/roster
```
**Response:** Team roster organized by position
```json
{
  "success": true,
  "data": {
    "roster": [...],
    "groupedByPosition": {...},
    "starters": [...],
    "bench": [...],
    "injuredReserve": [...]
  }
}
```

### Roster Management

#### Add Player to Roster
```http
POST /api/teams/{teamId}/roster/add
```
**Body:**
```json
{
  "playerId": "player123",
  "rosterPosition": "bench"
}
```
**Valid Positions:** `starter`, `bench`, `injured_reserve`

**Response:**
```json
{
  "success": true,
  "message": "Josh Allen added to Team Alpha",
  "data": {
    "team": "Team Alpha",
    "player": {
      "id": "player123",
      "name": "Josh Allen",
      "position": "QB",
      "team": "BUF"
    },
    "rosterPosition": "bench"
  }
}
```

#### Remove Player from Roster
```http
DELETE /api/teams/{teamId}/roster/remove
```
**Body:**
```json
{
  "playerId": "player123"
}
```

#### Move Player Between Positions
```http
PUT /api/teams/{teamId}/roster/move
```
**Body:**
```json
{
  "playerId": "player123",
  "rosterPosition": "starter"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Josh Allen moved to starter",
  "data": {
    "team": "Team Alpha",
    "player": {...},
    "oldPosition": "bench",
    "newPosition": "starter"
  }
}
```

### League Information

#### Get League Settings
```http
GET /api/league
```
**Response:** League configuration and scoring rules

#### Get Weekly Matchups
```http
GET /api/matchups/week/{week}
```
**Parameters:**
- `week` - Week number (1-17)

#### Get Player Rankings
```http
GET /api/stats/rankings/{position}
```
**Parameters:**
- `position` - QB, RB, WR, TE, K, DST

### Admin Operations

#### Get Admin Dashboard
```http
GET /api/admin/dashboard
```
**Response:** Comprehensive admin statistics

#### Check Sync Status
```http
GET /api/admin/sync/status
```
**Response:** Tank01 API sync status and last sync time

#### Trigger Player Sync
```http
POST /api/admin/sync/players
```
**Response:** Sync results with player count and duration

---

## 🎯 Common Usage Scenarios

### Scenario 1: Setting Up Team Rosters

1. **View Available Players:**
   ```bash
   curl http://localhost:3000/api/players/available/QB
   ```

2. **Add Players to Team:**
   ```bash
   curl -X POST http://localhost:3000/api/teams/1/roster/add \
     -H "Content-Type: application/json" \
     -d '{"playerId": "josh_allen", "rosterPosition": "starter"}'
   ```

3. **Set Starting Lineup:**
   ```bash
   curl -X PUT http://localhost:3000/api/teams/1/roster/move \
     -H "Content-Type: application/json" \
     -d '{"playerId": "josh_allen", "rosterPosition": "starter"}'
   ```

### Scenario 2: Managing Injured Reserve

1. **Place Player on IR:**
   ```bash
   curl -X PUT http://localhost:3000/api/teams/1/roster/move \
     -H "Content-Type: application/json" \
     -d '{"playerId": "injured_player", "rosterPosition": "injured_reserve"}'
   ```

2. **View IR Players:**
   ```bash
   curl http://localhost:3000/api/teams/1/roster
   ```

### Scenario 3: Player Research

1. **Search by Position:**
   ```bash
   curl http://localhost:3000/api/players/position/RB
   ```

2. **Check Player Rankings:**
   ```bash
   curl http://localhost:3000/api/stats/rankings/RB
   ```

3. **View Team Standings:**
   ```bash
   curl http://localhost:3000/api/teams
   ```

---

## 🛠 Command Line Operations

### Development Commands
```bash
# Start development server with auto-reload
npm run dev

# Initialize fresh league
npm run init-league

# Run all tests
npm test

# Run fast unit tests
npm run test:fast

# Run integration tests (requires server)
npm run test:integration

# Run tests with coverage
npm run test:coverage

# Guided test runner
node tests/test-runner.js help
```

### Testing Commands
```bash
# Test specific functionality
npm run test:integration -- tests/integration/roster.test.js
npm run test:integration -- tests/integration/dashboard.test.js
npm run test:integration -- tests/integration/tank01.test.js

# Watch mode for development
npm run test:watch
```

### Database Operations
```bash
# Check database status
curl http://localhost:3000/health

# Get player count
curl http://localhost:3000/api/players | jq '.count'

# Get team count  
curl http://localhost:3000/api/teams | jq '.count'

# Sync players from Tank01 API
curl -X POST http://localhost:3000/api/admin/sync/players
```

---

## 🚨 Error Handling

### Common Error Responses

#### 400 Bad Request
```json
{
  "success": false,
  "message": "Invalid roster position. Must be: starter, bench, or injured_reserve",
  "status": 400
}
```

#### 404 Not Found
```json
{
  "success": false,
  "message": "Team not found",
  "status": 404
}
```

#### 500 Server Error
```json
{
  "success": false,
  "message": "Internal server error",
  "status": 500
}
```

### Roster Management Constraints

- **One IR Player Per Team:** Each team can only have one player on injured reserve
- **Player Availability:** Players can only be on one roster at a time
- **Valid Positions:** Only `starter`, `bench`, or `injured_reserve` are allowed
- **Position Validation:** All roster positions are validated before operations

---

## 📊 Response Formats

All API responses follow a consistent format:

### Success Response
```json
{
  "success": true,
  "data": {...},
  "message": "Operation completed successfully"
}
```

### Error Response
```json
{
  "success": false,
  "message": "Error description",
  "status": 400
}
```

### List Response
```json
{
  "success": true,
  "data": [...],
  "count": 42
}
```

---

## 🔒 Security & Deployment

### Network-Only Deployment
- **No Authentication Required:** Designed for trusted network environments
- **Admin Functions:** All admin operations accessible without passwords
- **Local Network:** Recommended for deployment on private networks only

### Production Considerations
- **Environment Variables:** Configure Tank01 API key in `.env` file
- **Database Backup:** Regular SQLite database backups recommended
- **Monitoring:** Use `/health` endpoint for uptime monitoring
- **Logs:** Server logs provide detailed operation information

---

## 🤝 Support & Development

### Getting Help
- **Health Check:** Always start with `GET /health` to verify system status
- **Test Suite:** Run `npm test` to verify all functionality
- **Logs:** Check console output for detailed error information
- **Dashboard:** Use web interface for visual management

### Contributing
- **Test Coverage:** All new features require comprehensive tests
- **API Consistency:** Follow existing response format patterns
- **Validation:** Implement proper input validation for all endpoints
- **Documentation:** Update this file when adding new functionality

### Development Workflow
1. **Start Server:** `npm start`
2. **Run Tests:** `npm run test:fast` for quick feedback
3. **Access Dashboard:** http://localhost:3000/dashboard
4. **Test Changes:** `npm test` before committing
5. **Commit:** Use descriptive commit messages with test status