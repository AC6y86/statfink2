console.log('Starting app.js from:', __dirname);
console.log('Process CWD:', process.cwd());
console.log('NODE_ENV:', process.env.NODE_ENV);

require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const https = require('https');
const http = require('http');
const fs = require('fs');
const cookieParser = require('cookie-parser');

console.log('About to load DatabaseManager...');

const DatabaseManager = require('./database/database');
const ScoringService = require('./services/scoringService');
const Tank01Service = require('./services/tank01Service');
const NFLGamesService = require('./services/nflGamesService');
const PlayerSyncService = require('./services/playerSyncService');
const StandingsService = require('./services/standingsService');
const SchedulerService = require('./services/schedulerService');
const TeamScoreService = require('./services/teamScoreService');
const ScoringPlayersService = require('./services/scoringPlayersService');
const WeeklyReportService = require('./services/weeklyReportService');
const DSTManagementService = require('./services/dstManagementService');
const FantasyPointsCalculationService = require('./services/fantasyPointsCalculationService');
const TestRunnerService = require('./services/testRunnerService');
const HealthCheckService = require('./services/healthCheckService');
const EmailMoveParsingService = require('./services/emailMoveParsingService');
const PendingMovesService = require('./services/pendingMovesService');
const NflRosterEligibilityService = require('./services/nflRosterEligibilityService');
const { JobStatusService } = require('./services/jobStatusService');
const { errorHandler, logInfo, logError } = require('./utils/errorHandler');

const app = express();
const PORT = process.env.PORT || 8000;
const HTTPS_PORT = process.env.HTTPS_PORT || 8443;
// Loopback-only listener that `tailscale serve` proxies to; requests on it
// skip the admin password (server/auth/trust.js).
const TAILSCALE_PORT = parseInt(process.env.TAILSCALE_PORT || '8001', 10);

// Trust only loopback proxies (nginx, tailscale serve). With `true`, req.ip was
// the LEFTMOST X-Forwarded-For entry - client-controlled - and it gated admin
// auth. req.ip is now the real peer and is used only for rate limiting/logs.
app.set('trust proxy', 'loopback');

// Import authentication
const { setupAuth, requireAuth } = require('./auth/auth');

// Initialize services
let db, scoringService, tank01Service, nflGamesService, playerSyncService, standingsService, schedulerService, teamScoreService, scoringPlayersService, weeklyReportService, dstManagementService, fantasyPointsCalculationService, healthCheckService, emailMoveParsingService, pendingMovesService, jobStatusService;

async function initializeServices() {
    try {
        logInfo('Initializing services...');
        
        // Initialize database
        db = new DatabaseManager({ nflEligibilityService: new NflRosterEligibilityService() });
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for DB init
        
        // Initialize Tank01 API service with database connection
        const apiKey = process.env.TANK01_API_KEY;
        if (apiKey) {
            tank01Service = new Tank01Service(apiKey, db);
            logInfo('Tank01 API service initialized with persistent cache');
        } else {
            logError('Tank01 API key not found in environment variables');
        }
        
        // Initialize scoring service first (without nflGamesService)
        scoringService = new ScoringService(db);
        
        // Initialize DST Management service
        dstManagementService = new DSTManagementService(db, tank01Service);
        logInfo('DST Management service initialized');
        
        // Initialize NFL Games service with scoring service and DST management service
        nflGamesService = new NFLGamesService(db, tank01Service, scoringService, dstManagementService);
        logInfo('NFL Games service initialized');
        
        // Set the circular reference
        scoringService.setNFLGamesService(nflGamesService);
        
        // Initialize player sync service
        playerSyncService = new PlayerSyncService(db, tank01Service);
        logInfo('Player sync service initialized');
        
        // Initialize standings service
        standingsService = new StandingsService(db);
        logInfo('Standings service initialized');
        
        // Initialize team score service
        teamScoreService = new TeamScoreService(db);
        logInfo('Team score service initialized');
        
        // Initialize scoring players service
        scoringPlayersService = new ScoringPlayersService(db);
        logInfo('Scoring players service initialized');
        
        // Initialize weekly report service
        weeklyReportService = new WeeklyReportService(db);
        logInfo('Weekly report service initialized');
        
        // Initialize fantasy points calculation service
        fantasyPointsCalculationService = new FantasyPointsCalculationService(db, scoringService);
        logInfo('Fantasy points calculation service initialized');
        
        
        // Initialize health check service (alerts + data validation)
        healthCheckService = new HealthCheckService(db, {
            teamScoreService,
            testRunnerService: new TestRunnerService(db)
        });
        logInfo('Health check service initialized');

        // Verification status aggregator (/admin/status, /api/admin/status)
        jobStatusService = new JobStatusService({ db, healthCheckService });
        logInfo('Job status service initialized');

        // Initialize email-driven roster move services
        emailMoveParsingService = new EmailMoveParsingService(db);
        pendingMovesService = new PendingMovesService(db);
        logInfo('Email move services initialized');

        // Initialize scheduler service
        schedulerService = new SchedulerService(db, nflGamesService, playerSyncService, scoringService, standingsService, teamScoreService, scoringPlayersService, weeklyReportService, fantasyPointsCalculationService, healthCheckService);
        logInfo('Scheduler service initialized');
        
        
        // Make services available to routes
        app.locals.db = db;
        app.locals.scoringService = scoringService;
        app.locals.tank01Service = tank01Service;
        app.locals.nflGamesService = nflGamesService;
        app.locals.playerSyncService = playerSyncService;
        app.locals.standingsService = standingsService;
        app.locals.teamScoreService = teamScoreService;
        app.locals.scoringPlayersService = scoringPlayersService;
        app.locals.weeklyReportService = weeklyReportService;
        app.locals.schedulerService = schedulerService;
        app.locals.dstManagementService = dstManagementService;
        app.locals.fantasyPointsCalculationService = fantasyPointsCalculationService;
        app.locals.healthCheckService = healthCheckService;
        app.locals.jobStatusService = jobStatusService;
        app.locals.emailMoveParsingService = emailMoveParsingService;
        app.locals.pendingMovesService = pendingMovesService;
        
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
        : ['http://localhost:8000', 'http://127.0.0.1:8000', 'https://localhost:8443', 'https://127.0.0.1:8443', 'https://192.168.1.50:8443'],
    credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());


// Serve static files BEFORE setting security headers
app.use(express.static(path.join(__dirname, '../public')));
// helm/ assets (statfink-styles.css, theme-loader.js, logos) are public, but
// its HTML pages (dashboard, mobile, database-browser, ...) are served only
// through their auth-guarded routes below - never as bare static files.
const helmStatic = express.static(path.join(__dirname, '../helm'), { index: false, redirect: false });
app.use((req, res, next) => (/\.html?$/i.test(req.path) ? next() : helmStatic(req, res, next)));

// Serve Let's Encrypt challenge files
app.use('/.well-known/acme-challenge', express.static(path.join(__dirname, '../.well-known/acme-challenge')));

// Reachability probe for the tailnet host: the public login page fetches
// https://<TAILSCALE_HOSTNAME>/tailnet-ping (mode: no-cors, 1.5 s timeout)
// and, if anything answers, sends the browser to the password-free tailnet
// URL. Only a tailnet device can reach that host, so answering is the signal;
// the body carries nothing.
app.get('/tailnet-ping', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(204).end();
});

// Setup authentication (includes security headers)
setupAuth(app);

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

// Redirect /draft to Google Sheets
app.get('/draft', (req, res) => {
    res.redirect(301, 'https://docs.google.com/spreadsheets/d/1KnT8u76sPBYVCU1KsbCar3ea2zoX82KGLzt-5PY3kio/edit?gid=0#gid=0');
});

// Redirect /board to Google Apps Script board view
app.get('/board', (req, res) => {
    res.redirect(301, 'https://script.google.com/macros/s/AKfycbwa1ro-cTgDPeNCSZa5rqUy5gMHJMp0aD5UCQcYJ4GLk_Ucpfypx90BeLsNbGbczKaCFA/exec?view=board');
});

// Redirect /cards to Google Apps Script cards view
app.get('/cards', (req, res) => {
    res.redirect(301, 'https://script.google.com/macros/s/AKfycbx0mhtv3PX5HF_RRzRl7t2rzUNV4KOgrJamPXFGvCItu7h4HIl3ov9hEMg4aHl5Nj7Xgg/exec?view=cards');
});

// Redirect /c to cards view (shortcut)
app.get('/c', (req, res) => {
    res.redirect(301, 'https://script.google.com/macros/s/AKfycbx0mhtv3PX5HF_RRzRl7t2rzUNV4KOgrJamPXFGvCItu7h4HIl3ov9hEMg4aHl5Nj7Xgg/exec?view=cards');
});

// Roster moves page
app.get('/moves', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/moves.html'));
});

// Admin routes (before static middleware)
app.get('/helm', (req, res) => {
    res.redirect('/admin');
});

app.get('/admin', (req, res) => {
    res.redirect('/admin/thisweek');
});

// The admin app (helm/admin/): one responsive page, areas routed by path.
// /admin/dashboard keeps working (legacy #hash tabs are mapped client-side);
// the old single-file dashboard stays reachable at /admin/legacy.
const adminApp = (req, res) => res.sendFile(path.join(__dirname, '../helm/admin/index.html'));
app.get('/admin/dashboard', adminApp);
app.get('/admin/:area(thisweek|status|moves|data|recaps|settings)', adminApp);
app.use('/admin/assets', express.static(path.join(__dirname, '../helm/admin'), { index: false }));
app.get('/admin/legacy', (req, res) => {
    res.sendFile(path.join(__dirname, '../helm/dashboard.html'));
});
// The former phone-only portal: the app itself is phone-sized now
app.get('/admin/m', (req, res) => {
    res.redirect('/admin/thisweek');
});

// Old per-tab links → the areas that absorbed them
app.get('/admin/sync', (req, res) => {
    res.redirect('/admin/data');
});

app.get('/admin/players', (req, res) => {
    res.redirect('/admin/moves?tab=players');
});

app.get('/admin/rosters', (req, res) => {
    res.redirect('/admin/moves');
});

app.get('/admin/database', (req, res) => {
    res.redirect('/admin/data?tab=database');
});

app.get('/admin/roster', (req, res) => {
    res.redirect('/admin/moves');
});

// Redirect root to /statfink
app.get('/', (req, res) => {
    res.redirect('/statfink');
});

// Statfink matchup viewer routes
// Redirect /statfink to current year/week
app.get('/statfink', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const settings = await db.getLeagueSettings();
        // Follow the active league week (temporary Week 3 pin removed at Joe's request).
        const displayWeek = settings.current_week;
        res.set('Cache-Control', 'no-store');
        res.redirect(`/statfink/${settings.season_year}/${displayWeek}`);
    } catch (error) {
        logError('Failed to get league settings for statfink redirect', error);
        // Fallback to default if settings can't be retrieved
        res.redirect('/statfink/2024/1');
    }
});

// New /mocks routes
app.get('/mocks', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/mocks/index.html'));
});

app.get('/mocks/delta-test', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/mocks/delta-test.html'));
});

// Legacy mock routes - redirect to new location
app.get('/statfink/mock', (req, res) => {
    res.redirect('/mocks');
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
app.get('/admin/database-browser', (req, res) => {
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

// Public rosters routes
app.get('/rosters', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const settings = await db.getLeagueSettings();
        res.redirect(`/rosters/${settings.season_year}/${settings.current_week}`);
    } catch (error) {
        logError('Failed to get league settings for rosters redirect', error);
        // Fallback to 2024 week 1 if settings can't be retrieved
        res.redirect('/rosters/2024/1');
    }
});

app.get('/rosters/:season/:week', (req, res) => {
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
    
    res.sendFile(path.join(__dirname, '../public/rosters.html'));
});

// API Routes
app.use('/api/teams', require('./routes/teams'));
app.use('/api/players', require('./routes/players'));
app.use('/api/stats', require('./routes/stats'));
app.use('/api/matchups', require('./routes/matchups'));
app.use('/api/league', require('./routes/league'));
app.use('/api/nfl-games', require('./routes/nflGames'));
app.use('/api/database', requireAuth, require('./routes/databaseBrowser')); // raw SELECT on the league DB: admin only
app.use('/api/standings', require('./routes/standings'));
app.use('/api/rosters', require('./routes/rosters'));
app.use('/api/roster-moves', require('./routes/rosterMoves'));
app.use('/api/payouts', require('./routes/payouts'));

// Admin routes
app.use('/api/admin', require('./routes/admin'));

// Internal routes (localhost-only, for cron jobs)
app.use('/api/internal', require('./routes/internal'));

// Public payouts route
app.get('/payouts', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/payouts.html'));
});

// Redirect any unrecognized routes to /statfink
app.get('*', (req, res) => {
    // If this is an API route, return JSON error instead of HTML
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({
            error: 'Not Found',
            message: `API endpoint ${req.path} not found`
        });
    }
    
    // Redirect all other unrecognized routes to /statfink
    res.redirect('/statfink');
    return; // Don't send HTML below
    
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
                        <a href="/admin/dashboard">📊 View Database Dashboard</a>
                    </div>
                    
                    <div class="dashboard-link" style="background: linear-gradient(135deg, #4169e1 0%, #1e3a8a 100%);">
                        <a href="/statfink">🏈 View Live Matchups (Statfink)</a>
                    </div>
                    
                    <div class="dashboard-link" style="background: linear-gradient(135deg, #ff8c00 0%, #ff4500 100%);">
                        <a href="/mocks">🧪 Mock Matchups (Testing)</a>
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
                    
                    <p><strong>New:</strong> <a href="/admin/dashboard">Database Dashboard</a> - View and manage all database contents</p>
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
        
        // Start HTTP server
        const httpServer = http.createServer(app);
        httpServer.listen(PORT, () => {
            logInfo(`StatFink Fantasy Football HTTP server running on http://localhost:${PORT}`);
        });

        // Tailscale admin listener: loopback-only, reached via
        // `tailscale serve --bg http://127.0.0.1:${TAILSCALE_PORT}` at
        // https://<node>.<tailnet>.ts.net. Every request on it is stamped so
        // requireAuth/requireAdmin let it through without a password.
        const tailscaleServer = http.createServer((req, res) => {
            req.trustedListener = 'tailscale';
            app(req, res);
        });
        tailscaleServer.listen(TAILSCALE_PORT, '127.0.0.1', () => {
            logInfo(`Tailscale admin listener on http://127.0.0.1:${TAILSCALE_PORT} (password-free via tailscale serve)`);
        });
        
        // Start HTTPS server if certificates exist
        let httpsServer = null;
        let certPath = process.env.SSL_CERT || './certs/fullchain.pem';
        let keyPath = process.env.SSL_KEY || './certs/privkey.pem';
        
        // Try Let's Encrypt certs first, fall back to self-signed
        let certExists = false;
        try {
            fs.accessSync(certPath, fs.constants.R_OK);
            fs.accessSync(keyPath, fs.constants.R_OK);
            certExists = true;
        } catch {
            // Fall back to self-signed certs
            const selfSignedCert = './certs/cert.pem';
            const selfSignedKey = './certs/key.pem';
            if (fs.existsSync(selfSignedCert) && fs.existsSync(selfSignedKey)) {
                certPath = selfSignedCert;
                keyPath = selfSignedKey;
                certExists = true;
            }
        }
        
        if (certExists) {
            const httpsOptions = {
                cert: fs.readFileSync(certPath),
                key: fs.readFileSync(keyPath)
            };
            
            httpsServer = https.createServer(httpsOptions, app);
            httpsServer.listen(HTTPS_PORT, () => {
                logInfo(`StatFink Fantasy Football HTTPS server running on https://localhost:${HTTPS_PORT}`);
                if (certPath.includes('letsencrypt')) {
                    logInfo('Using Let\'s Encrypt certificate - no browser warnings!');
                } else {
                    logInfo('Note: Using self-signed certificate. Browser will show security warning.');
                }
            });
        } else {
            logInfo('SSL certificates not found. HTTPS server not started.');
            logInfo(`To enable HTTPS, place cert.pem and key.pem in ./certs/ or set SSL_CERT and SSL_KEY env vars`);
        }
        
        logInfo('Available endpoints:', {
            health: '/health',
            teams: '/api/teams',
            players: '/api/players',
            league: '/api/league',
            frontend: '/'
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
            
            const closeServers = (callback) => {
            let closed = 0;
            const servers = [httpServer, httpsServer].filter(Boolean);
            const total = servers.length;
            
            servers.forEach(server => {
                server.close(() => {
                    closed++;
                    if (closed === total) {
                        callback();
                    }
                });
            });
        };
        
        closeServers(async () => {
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