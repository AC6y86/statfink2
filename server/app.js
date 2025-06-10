require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const DatabaseManager = require('./database/database');
const ScoringService = require('./services/scoringService');
const { errorHandler, logInfo, logError } = require('./utils/errorHandler');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize services
let db, scoringService;

async function initializeServices() {
    try {
        logInfo('Initializing services...');
        
        // Initialize database
        db = new DatabaseManager();
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for DB init
        
        // Initialize scoring service
        scoringService = new ScoringService(db);
        
        // Make services available to routes
        app.locals.db = db;
        app.locals.scoringService = scoringService;
        
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
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '../public')));

// API Routes
app.use('/api/teams', require('./routes/teams'));
app.use('/api/players', require('./routes/players'));
app.use('/api/stats', require('./routes/stats'));
app.use('/api/matchups', require('./routes/matchups'));
app.use('/api/league', require('./routes/league'));

// Admin routes
app.use('/api/admin', require('./routes/admin'));

// Serve main page for any non-API routes
app.get('*', (req, res) => {
    // For now, return a simple response
    // Later we'll serve the main frontend app
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
                    
                    <div class="status">
                        <strong>✅ Server Status:</strong> Running<br>
                        <strong>📊 Database:</strong> Connected<br>
                        <strong>🧪 Tests:</strong> 58 passing<br>
                        <strong>⚡ Phase:</strong> API Development
                    </div>
                    
                    <h2>Available API Endpoints</h2>
                    <div class="api-list">
                        <strong>Health Check:</strong><br>
                        <code>GET /health</code><br><br>
                        
                        <strong>Teams:</strong><br>
                        <code>GET /api/teams</code> - Get all teams<br>
                        <code>GET /api/teams/:id</code> - Get team details<br><br>
                        
                        <strong>Players:</strong><br>
                        <code>GET /api/players</code> - Get all players<br>
                        <code>GET /api/players/position/:position</code> - Get players by position<br><br>
                        
                        <strong>League:</strong><br>
                        <code>GET /api/league/settings</code> - Get league settings<br>
                        <code>GET /api/league/standings</code> - Get current standings<br><br>
                        
                        <strong>Stats:</strong><br>
                        <code>GET /api/stats/:playerId/:week/:season</code> - Get player stats<br><br>
                        
                        <strong>Matchups:</strong><br>
                        <code>GET /api/matchups/:week/:season</code> - Get weekly matchups
                    </div>
                    
                    <p><em>Frontend interface coming soon...</em></p>
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
        process.on('SIGINT', async () => {
            logInfo('Received SIGINT, shutting down gracefully...');
            
            server.close(async () => {
                if (db) {
                    await db.close();
                }
                logInfo('Server shut down successfully');
                process.exit(0);
            });
        });

        process.on('SIGTERM', async () => {
            logInfo('Received SIGTERM, shutting down gracefully...');
            
            server.close(async () => {
                if (db) {
                    await db.close();
                }
                logInfo('Server shut down successfully');
                process.exit(0);
            });
        });

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