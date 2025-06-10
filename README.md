# StatFink Fantasy Football

A single-league fantasy football management application with comprehensive data validation, scoring calculations, and database management.

## Current Status: Database Layer Complete ✅

The project currently has a **complete and tested database layer** with:
- ✅ Full SQLite schema for fantasy football data
- ✅ Comprehensive input validation
- ✅ Fantasy scoring calculations for all positions
- ✅ 40+ unit tests passing
- ✅ Error handling and logging
- ✅ League initialization with 12 teams

**Next Phase**: Express API server implementation

## Features Implemented

- **Database Schema**: Complete SQLite3 database with all fantasy football entities
- **Data Validation**: Comprehensive validation for players, stats, teams, matchups
- **Scoring Engine**: PPR scoring for QB, RB, WR, TE, K, DST positions
- **Error Handling**: Custom error classes and logging utilities
- **Testing**: 40+ unit tests with Jest framework
- **League Management**: 12-team league initialization

## Technology Stack

- **Database**: SQLite3 with sqlite3 npm package
- **Testing**: Jest with comprehensive unit tests
- **Validation**: Custom validation framework
- **Scoring**: Fantasy point calculations for all positions
- **Language**: Node.js with CommonJS modules

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
# Edit .env with your configuration
```

4. Initialize the league database:
```bash
npm run init-league
```

5. Run tests to verify setup:
```bash
npm test tests/unit/
```

## Project Structure

```
statfink2/
├── server/
│   ├── database/         # Database schema, connection, validation
│   ├── services/         # Business logic (scoring, etc.)
│   ├── utils/            # Utilities (error handling, initialization)
│   └── routes/           # API routes (empty - next phase)
├── tests/
│   ├── unit/             # Unit tests (40+ tests)
│   ├── integration/      # Integration tests
│   └── fixtures/         # Test data
├── public/               # Frontend files (planned)
├── DESIGN.md             # Original design document
├── IMPLEMENTATION_STEPS.md  # Implementation guide
└── README.md             # This file
```

## Available Commands

```bash
npm run init-league      # Initialize league with 12 teams
npm test tests/unit/     # Run unit tests (recommended)
npm run test:watch       # Run tests in watch mode
npm run test:coverage    # Run tests with coverage report
```

## Development Status

- ✅ **Phase 1**: Database layer with validation and testing
- 🔄 **Phase 2**: Express API server (next)
- ⏳ **Phase 3**: Frontend interface
- ⏳ **Phase 4**: Tank01 API integration

## Database

The project uses SQLite3 with a comprehensive schema including:
- Teams and rosters
- NFL players (QB, RB, WR, TE, K, DST)
- Player statistics with defensive and kicking stats
- Weekly matchups
- PPR scoring rules

All database operations include validation and error handling.

## Testing

40+ unit tests covering:
- Data validation
- Fantasy scoring calculations
- Error handling
- Database operations

## License

This project is private and proprietary.