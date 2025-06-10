# StatFink Fantasy Football

A single-league fantasy football management application with a read-only public interface and admin roster management capabilities.

## Features

- **Live Score Updates**: Real-time player statistics and fantasy scoring
- **Roster Management**: Admin interface for managing team rosters
- **Automated Updates**: Scheduled stats synchronization during games
- **PPR Scoring**: Full point-per-reception scoring system
- **Public Interface**: Read-only access to standings, matchups, and team details
- **Tank01 API Integration**: Professional NFL statistics and player data

## Technology Stack

- **Backend**: Node.js with Express.js
- **Database**: SQLite3 with better-sqlite3
- **API**: Tank01 NFL API via RapidAPI
- **Frontend**: HTML/CSS/JavaScript
- **Scheduler**: node-cron for automated updates

## Quick Start

1. Clone the repository:
```bash
git clone https://github.com/yourusername/statfink2.git
cd statfink2
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
cp .env.example .env
# Edit .env with your API key and settings
```

4. Initialize the database:
```bash
npm run init-league
```

5. Start the development server:
```bash
npm run dev
```

6. Access the application at `http://localhost:3000`

## Configuration

Create a `.env` file with the following variables:

```
RAPIDAPI_KEY=your_tank01_api_key
PORT=3000
ADMIN_PASSWORD=your_admin_password
```

## Project Structure

```
statfink2/
├── server/           # Backend server code
├── public/           # Frontend static files
├── DESIGN.md         # Original design document
├── IMPLEMENTATION_STEPS.md  # Implementation guide
└── README.md         # This file
```

## Development

See [IMPLEMENTATION_STEPS.md](IMPLEMENTATION_STEPS.md) for detailed development guidelines.

## License

This project is private and proprietary.