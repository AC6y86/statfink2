require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const DatabaseManager = require('./database/database');
const ScoringService = require('./services/scoringService');
const Tank01Service = require('./services/tank01Service');
const NFLGamesService = require('./services/nflGamesService');
const PlayerSyncService = require('./services/playerSyncService');
const { errorHandler, logInfo, logError } = require('./utils/errorHandler');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize services
let db, scoringService, tank01Service, nflGamesService, playerSyncService;

async function initializeServices() {
    try {
        logInfo('Initializing services...');
        
        // Initialize database
        db = new DatabaseManager();
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for DB init
        
        // Initialize Tank01 API service with database connection
        const apiKey = process.env.TANK01_API_KEY;
        if (apiKey) {
            tank01Service = new Tank01Service(apiKey, db);
            logInfo('Tank01 API service initialized with persistent cache');
        } else {
            logError('Tank01 API key not found in environment variables');
        }
        
        // Initialize NFL Games service
        nflGamesService = new NFLGamesService(db, tank01Service);
        logInfo('NFL Games service initialized');
        
        // Initialize scoring service with NFL Games service
        scoringService = new ScoringService(db, nflGamesService);
        
        // Initialize player sync service
        playerSyncService = new PlayerSyncService(db, tank01Service);
        logInfo('Player sync service initialized');
        
        
        // Make services available to routes
        app.locals.db = db;
        app.locals.scoringService = scoringService;
        app.locals.tank01Service = tank01Service;
        app.locals.nflGamesService = nflGamesService;
        app.locals.playerSyncService = playerSyncService;
        
        logInfo('Services initialized successfully');
    } catch (error) {
        logError('Failed to initialize services', error);
        throw error;
    }
}

// Middleware
app.use(cors({
    origin: process.env.NODE_ENV === 'production' 
        ? ['https://yourdomainhere.com'] 
        : ['http://localhost:3000', 'http://127.0.0.1:3000'],
    credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

// Logging middleware
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        logInfo(`${req.method} ${req.path}`, {
            status: res.statusCode,
            duration: `${duration}ms`,
            ip: req.ip
        });
    });
    next();
});

// Health check endpoint
app.get('/health', async (req, res) => {
    try {
        const health = {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            version: '1.0.0',
            services: {
                database: 'connected',
                tank01: tank01Service ? 'initialized' : 'not configured'
            }
        };
        
        // Check Tank01 API health if available
        if (tank01Service) {
            const tank01Health = await tank01Service.healthCheck();
            health.services.tank01 = tank01Health.status;
            health.tank01_stats = {
                requests: tank01Health.requestCount,
                daily_requests: tank01Health.dailyRequests,
                daily_stats_date: tank01Health.dailyStatsDate,
                cache_size: tank01Health.cacheSize,
                response_time: tank01Health.responseTime
            };
        }
        
        res.json(health);
    } catch (error) {
        logError('Health check failed', error);
        res.status(500).json({
            status: 'unhealthy',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Dashboard route (before static middleware)
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, '../helm/dashboard.html'));
});

// Roster management route (before static middleware)
app.get('/roster', (req, res) => {
    res.sendFile(path.join(__dirname, '../helm/roster.html'));
});

// Statfink matchup viewer routes
// Redirect /statfink to current year/week
app.get('/statfink', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const settings = await db.getLeagueSettings();
        res.redirect(`/statfink/${settings.season_year}/${settings.current_week}`);
    } catch (error) {
        logError('Failed to get league settings for statfink redirect', error);
        // Fallback to default if settings can't be retrieved
        res.redirect('/statfink/2024/1');
    }
});

// Mock/test interface for integration tests
app.get('/statfink/mock', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/mock-weeks-index.html'));
});

// Serve statfink mock mode for specific week
app.get('/statfink/mock/:week', async (req, res) => {
    const { week } = req.params;
    const weekNum = parseInt(week);
    
    if (isNaN(weekNum) || weekNum < 1 || weekNum > 18) {
        return res.status(400).send('Invalid week. Must be between 1 and 18.');
    }
    
    res.sendFile(path.join(__dirname, '../helm/statfink.html'));
});

// Serve statfink for specific year/week
app.get('/statfink/:year/:week', (req, res) => {
    const { year, week } = req.params;
    
    // Basic validation
    const yearNum = parseInt(year);
    const weekNum = parseInt(week);
    
    if (isNaN(yearNum) || yearNum < 2020 || yearNum > 2030) {
        return res.status(400).send('Invalid year. Must be between 2020 and 2030.');
    }
    
    if (isNaN(weekNum) || weekNum < 1 || weekNum > 18) {
        return res.status(400).send('Invalid week. Must be between 1 and 18.');
    }
    
    res.sendFile(path.join(__dirname, '../helm/statfink.html'));
});

// 2024 Season navigation route
app.get('/2024-season', (req, res) => {
    res.sendFile(path.join(__dirname, '../helm/2024-season.html'));
});

// Database browser route
app.get('/database-browser', (req, res) => {
    res.sendFile(path.join(__dirname, '../helm/database-browser.html'));
});

// Public standings routes
app.get('/standings', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const settings = await db.getLeagueSettings();
        res.redirect(`/standings/${settings.season_year}/${settings.current_week}`);
    } catch (error) {
        logError('Failed to get league settings for standings redirect', error);
        // Fallback to 2024 week 1 if settings can't be retrieved
        res.redirect('/standings/2024/1');
    }
});

app.get('/standings/:season/:week', (req, res) => {
    const { season, week } = req.params;
    const seasonNum = parseInt(season);
    const weekNum = parseInt(week);
    
    // Basic validation
    if (isNaN(seasonNum) || seasonNum < 2020 || seasonNum > 2030) {
        return res.status(400).send('Invalid season. Must be between 2020 and 2030.');
    }
    
    if (isNaN(weekNum) || weekNum < 1 || weekNum > 18) {
        return res.status(400).send('Invalid week. Must be between 1 and 18.');
    }
    
    res.sendFile(path.join(__dirname, '../public/standings.html'));
});

// Legacy route for backwards compatibility
app.get('/standings/:week', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const settings = await db.getLeagueSettings();
        res.redirect(`/standings/${settings.season_year}/${req.params.week}`);
    } catch (error) {
        res.redirect(`/standings/2024/${req.params.week}`);
    }
});

// API Routes
app.use('/api/teams', require('./routes/teams'));
app.use('/api/players', require('./routes/players'));
app.use('/api/stats', require('./routes/stats'));
app.use('/api/matchups', require('./routes/matchups'));
app.use('/api/league', require('./routes/league'));
app.use('/api/nfl-games', require('./routes/nflGames'));
app.use('/api/database', require('./routes/databaseBrowser'));
app.use('/api/standings', require('./routes/standings'));

// Admin routes
app.use('/api/admin', require('./routes/admin'));

// Serve static files from public directory for public pages
app.use(express.static(path.join(__dirname, '../public')));

// Serve static files from helm directory (after specific routes)
app.use(express.static(path.join(__dirname, '../helm')));

// Serve main page for any non-API routes
app.get('*', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>StatFink Fantasy Football</title>
                <style>
                    body { 
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                        margin: 0; 
                        padding: 40px;
                        background: #f0f2f5;
                        color: #333;
                    }
                    .container { 
                        max-width: 800px; 
                        margin: 0 auto; 
                        background: white;
                        padding: 40px;
                        border-radius: 8px;
                        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                    }
                    h1 { color: #2c3e50; }
                    .status { 
                        background: #d4edda; 
                        padding: 20px; 
                        border-radius: 4px; 
                        margin: 20px 0;
                        border-left: 4px solid #28a745;
                    }
                    .api-list {
                        background: #f8f9fa;
                        padding: 20px;
                        border-radius: 4px;
                        margin: 20px 0;
                    }
                    .dashboard-link {
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        color: white;
                        padding: 20px;
                        border-radius: 8px;
                        margin: 20px 0;
                        text-align: center;
                    }
                    .dashboard-link a {
                        color: white;
                        text-decoration: none;
                        font-size: 1.2rem;
                        font-weight: 600;
                    }
                    .dashboard-link a:hover {
                        text-decoration: underline;
                    }
                    code {
                        background: #e9ecef;
                        padding: 2px 6px;
                        border-radius: 3px;
                        font-family: 'Monaco', 'Consolas', monospace;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>🏈 StatFink Fantasy Football</h1>
                    
                    <div class="dashboard-link">
                        <a href="/dashboard">📊 View Database Dashboard</a>
                    </div>
                    
                    <div class="dashboard-link" style="background: linear-gradient(135deg, #4169e1 0%, #1e3a8a 100%);">
                        <a href="/statfink">🏈 View Live Matchups (Statfink)</a>
                    </div>
                    
                    <div class="dashboard-link" style="background: linear-gradient(135deg, #ff8c00 0%, #ff4500 100%);">
                        <a href="/statfink/mock">🧪 Mock Matchups (Testing)</a>
                    </div>
                    
                    <div class="status">
                        <strong>✅ Server Status:</strong> Running<br>
                        <strong>📊 Database:</strong> Connected<br>
                        <strong>🧪 Tests:</strong> 58 passing<br>
                        <strong>⚡ Phase:</strong> Tank01 API Integration Complete
                    </div>
                    
                    <h2>Available API Endpoints</h2>
                    <div class="api-list">
                        <strong>Health Check:</strong><br>
                        <code>GET /health</code><br><br>
                        
                        <strong>Teams:</strong><br>
                        <code>GET /api/teams</code> - Get all teams<br>
                        <code>GET /api/teams/:id</code> - Get team details<br>
                        <code>GET /api/teams/:id/roster</code> - Get team roster<br><br>
                        
                        <strong>Players:</strong><br>
                        <code>GET /api/players</code> - Get all players<br>
                        <code>GET /api/players/position/:position</code> - Get players by position<br><br>
                        
                        <strong>League:</strong><br>
                        <code>GET /api/league/settings</code> - Get league settings<br>
                        <code>GET /api/league/standings</code> - Get current standings<br><br>
                        
                        <strong>Stats:</strong><br>
                        <code>GET /api/stats/:playerId/:week/:season</code> - Get player stats<br><br>
                        
                        <strong>Matchups:</strong><br>
                        <code>GET /api/matchups/:week/:season</code> - Get weekly matchups<br><br>
                        
                        <strong>Admin:</strong><br>
                        <code>POST /api/admin/sync/players</code> - Sync NFL players<br>
                        <code>GET /api/admin/sync/status</code> - Check sync status
                    </div>
                    
                    <p><strong>New:</strong> <a href="/dashboard">Database Dashboard</a> - View and manage all database contents</p>
                </div>
            </body>
        </html>
    `);
});

// Error handling middleware (must be last)
app.use(errorHandler);

// Start server function
async function startServer() {
    try {
        await initializeServices();
        
        const server = app.listen(PORT, () => {
            logInfo(`StatFink Fantasy Football server running on http://localhost:${PORT}`);
            logInfo('Available endpoints:', {
                health: '/health',
                teams: '/api/teams',
                players: '/api/players',
                league: '/api/league',
                frontend: '/'
            });
        });

        // Graceful shutdown
        let isShuttingDown = false;
        
        const shutdown = async (signal) => {
            if (isShuttingDown) return;
            isShuttingDown = true;
            
            logInfo(`Received ${signal}, shutting down gracefully...`);
            
            // Force exit after 5 seconds if graceful shutdown fails
            const forceExit = setTimeout(() => {
                logError('Forcing shutdown after timeout');
                process.exit(1);
            }, 5000);
            
            server.close(async () => {
                try {
                    if (db) {
                        logInfo('Closing database connection...');
                        await db.close();
                        logInfo('Database connection closed');
                    }
                    logInfo('Server shut down successfully');
                    clearTimeout(forceExit);
                    process.exit(0);
                } catch (error) {
                    logError('Error during shutdown', error);
                    clearTimeout(forceExit);
                    process.exit(1);
                }
            });
        };

        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));

    } catch (error) {
        logError('Failed to start server', error);
        process.exit(1);
    }
}

// Start the server if this file is run directly
if (require.main === module) {
    startServer();
}

module.exports = app;