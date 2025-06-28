const session = require('express-session');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const csrf = require('csurf');
const crypto = require('crypto');

const sessionConfig = {
    secret: process.env.SESSION_SECRET || crypto.randomBytes(64).toString('hex'),
    name: 'sessionId',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production' || process.env.HTTPS_PORT, // Enable for HTTPS
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 2,
        sameSite: 'lax' // Changed from 'strict' to allow redirects
    }
};

if (process.env.NODE_ENV === 'production') {
    const SQLiteStore = require('connect-sqlite3')(session);
    sessionConfig.store = new SQLiteStore({
        db: 'sessions.db',
        dir: './data'
    });
}

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'Too many login attempts, please try again later',
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true
});

function requireAuth(req, res, next) {
    if (!req.session.userId) {
        req.session.returnTo = req.originalUrl;
        return res.redirect('/login');
    }
    
    if (!req.session.regenerated || Date.now() - req.session.regenerated > 300000) {
        req.session.regenerate((err) => {
            if (err) return next(err);
            req.session.regenerated = Date.now();
            next();
        });
    } else {
        next();
    }
}

function setupAuth(app) {
    // In development, disable ALL helmet middleware to avoid CSP issues
    if (process.env.NODE_ENV !== 'production') {
        console.log('Running in development mode - security headers disabled');
        // Don't use helmet at all in development
        // Also explicitly remove any problematic headers
        app.use((req, res, next) => {
            res.removeHeader('Cross-Origin-Opener-Policy');
            res.removeHeader('Cross-Origin-Embedder-Policy');
            res.removeHeader('Origin-Agent-Cluster');
            res.removeHeader('Content-Security-Policy');
            res.removeHeader('X-Content-Security-Policy');
            res.removeHeader('X-WebKit-CSP');
            next();
        });
    } else {
        // Production settings
        console.log('Running in production mode - security headers enabled');
        app.use(helmet({
            contentSecurityPolicy: {
                directives: {
                    defaultSrc: ["'self'"],
                    styleSrc: ["'self'", "'unsafe-inline'"],
                    scriptSrc: ["'self'"],
                    imgSrc: ["'self'", "data:", "https:"],
                    formAction: ["'self'"],
                },
            },
        }));
    }
    
    app.use(session(sessionConfig));
    
    const csrfProtection = csrf();
    
    app.get('/login', csrfProtection, (req, res) => {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Login - StatFink</title>
                <style>
                    body { font-family: Arial, sans-serif; background: #f0f2f5; margin: 0; padding: 0; }
                    .login-container { max-width: 400px; margin: 100px auto; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
                    h1 { color: #2c3e50; text-align: center; }
                    input { width: 100%; padding: 10px; margin: 10px 0; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box; }
                    button { width: 100%; padding: 12px; background: #667eea; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 16px; }
                    button:hover { background: #764ba2; }
                    .error { color: #e74c3c; text-align: center; margin: 10px 0; }
                    .info { color: #3498db; text-align: center; margin: 10px 0; }
                </style>
            </head>
            <body>
                <div class="login-container">
                    <h1>🏈 StatFink Login</h1>
                    ${req.query.error ? '<p class="error">Invalid username or password</p>' : ''}
                    ${req.query.logout ? '<p class="info">You have been logged out</p>' : ''}
                    <form method="POST" action="/login">
                        <input type="hidden" name="_csrf" value="${req.csrfToken()}">
                        <input type="text" name="username" placeholder="Username" required autocomplete="username">
                        <input type="password" name="password" placeholder="Password" required autocomplete="current-password">
                        <button type="submit">Login</button>
                    </form>
                </div>
            </body>
            </html>
        `);
    });
    
    app.post('/login', loginLimiter, csrfProtection, async (req, res) => {
        const { username, password } = req.body;
        
        try {
            const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;
            
            if (username !== 'admin' || !adminPasswordHash) {
                return res.redirect('/login?error=1');
            }
            
            const isValid = await bcrypt.compare(password, adminPasswordHash);
            if (!isValid) {
                return res.redirect('/login?error=1');
            }
            
            req.session.regenerate((err) => {
                if (err) throw err;
                
                req.session.userId = 1;
                req.session.username = username;
                req.session.regenerated = Date.now();
                
                const returnTo = req.session.returnTo || '/helm';
                delete req.session.returnTo;
                res.redirect(returnTo);
            });
            
        } catch (error) {
            console.error('Login error:', error);
            res.redirect('/login?error=1');
        }
    });
    
    app.get('/logout', (req, res) => {
        req.session.destroy((err) => {
            res.redirect('/login?logout=1');
        });
    });
    
    app.use('/helm', requireAuth);
    app.use('/dashboard', requireAuth);
    app.use('/database-browser', requireAuth);
    app.use('/api/admin', requireAuth);
    app.use('/2024-season', requireAuth);
}

module.exports = { setupAuth, requireAuth };