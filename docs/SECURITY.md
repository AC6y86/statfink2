# Security Configuration Guide

## Overview

This document outlines the security features and configuration options for the StatFink Fantasy Football platform. The system implements defense-in-depth with multiple security layers.

## Security Features

### 1. HTTPS/SSL Encryption

#### Let's Encrypt (Production)
```bash
# Install certbot
sudo apt-get update
sudo apt-get install certbot

# Generate certificates
sudo certbot certonly --standalone -d yourdomain.com

# Copy certificates to StatFink
sudo cp /etc/letsencrypt/live/yourdomain.com/fullchain.pem /path/to/statfink2/certs/
sudo cp /etc/letsencrypt/live/yourdomain.com/privkey.pem /path/to/statfink2/certs/
sudo chown youruser:youruser /path/to/statfink2/certs/*
sudo chmod 600 /path/to/statfink2/certs/privkey.pem
```

#### Self-Signed Certificates (Development)
```bash
# Generate self-signed certificate
openssl req -x509 -newkey rsa:4096 \
  -keyout certs/key.pem \
  -out certs/cert.pem \
  -days 365 -nodes \
  -subj "/C=US/ST=State/L=City/O=Organization/CN=localhost"
```

#### Environment Configuration
```bash
# .env
HTTPS_PORT=8443
SSL_CERT=./certs/fullchain.pem  # or ./certs/cert.pem for self-signed
SSL_KEY=./certs/privkey.pem      # or ./certs/key.pem for self-signed
```

### 2. Authentication System

Implemented in `server/auth/auth.js`. Session-based auth protects administrative functions while public viewing interfaces stay open to all league members.

#### Password Security
- **Bcrypt**: Industry-standard password hashing with **12 salt rounds** (`server/auth/generateHash.js`)
- **No database storage**: There is a single `admin` account; its hash lives in the `ADMIN_PASSWORD_HASH` environment variable, not in a users table
- **No Password Recovery**: Admin must reset manually by generating a new hash

#### Setup: Generate the Admin Password
```bash
node server/auth/generateHash.js
# Enter the password you want to hash: [your-secure-password]
# Hash: $2b$12$...

# Add the output to your .env file:
ADMIN_PASSWORD_HASH="$2b$12$..."
SESSION_SECRET=your-strong-random-session-secret
```

#### Login Flow
1. User visits `GET /login` (self-contained HTML form; username is hardcoded to `admin`)
2. Form posts to `POST /login` with the CSRF token; the request passes through the login rate limiter
3. Password is compared against `ADMIN_PASSWORD_HASH` with bcrypt
4. On success the session ID is regenerated, `userId`/`username` are stored in the session, and the user is redirected to the originally requested page (fallback: `https://peninsulafootball.com/admin/dashboard`)
5. On failure the user is redirected back to `/login?error=1`

Logout is `GET /logout` — destroys the session and redirects to `/login?logout=1`.

#### Protected Routes (require login)
- `/helm` — admin dashboard
- `/admin` — admin pages (including `/admin/database-browser`)
- `/api/admin/*` — all admin API endpoints
- `/2024-season` — archived season pages

#### Public Routes (no login)
- `/statfink` — live matchup viewer
- `/standings`, `/rosters` — public league pages
- `/api/players`, `/api/teams`, etc. — read-only API data

#### Localhost Bypass for API Routes
`requireAuth` (`server/auth/auth.js:38-63`) allows requests to `/api/*` paths from localhost (`127.0.0.1`, `::1`) **without authentication**. This is why local scripts and cron jobs can call `/api/admin/*` endpoints unauthenticated. Remote requests always require a valid session.

#### Session Management
```javascript
// Session configuration (server/auth/auth.js)
{
  secret: process.env.SESSION_SECRET,  // random fallback generated at boot
  name: 'sessionId',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,        // production / HTTPS only
    httpOnly: true,      // No JS access
    maxAge: 7200000,     // 2 hours
    sameSite: 'lax'      // CSRF protection
  }
}
```
- Sessions expire after 2 hours
- Session IDs are regenerated on login and every 5 minutes thereafter
- In production, sessions persist to a SQLite store at `data/sessions.db`

#### Troubleshooting
- **"Too many login attempts"** — wait out the 15-minute rate-limit window (or restart the server in development)
- **"Session expired. Please try again."** — the CSRF token was stale; the login page reloads with a fresh one
- **Session expired after inactivity** — sessions time out after 2 hours; log in again

### 3. Security Headers (Helmet.js)

**Production only** — in development (`NODE_ENV !== 'production'`), Helmet is disabled entirely and CSP-related headers are stripped to avoid local development issues (`server/auth/auth.js:83-95`).

Automatically configured headers in production:
- **Content-Security-Policy**: Prevents XSS attacks
- **X-DNS-Prefetch-Control**: Controls DNS prefetching
- **X-Frame-Options**: Prevents clickjacking
- **X-Content-Type-Options**: Prevents MIME sniffing
- **Strict-Transport-Security**: Forces HTTPS
- **X-Download-Options**: Prevents IE downloads
- **X-XSS-Protection**: Legacy XSS protection

Custom CSP configuration:
```javascript
// For development with self-signed certs
helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    scriptSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:", "https:"],
    connectSrc: ["'self'", "wss:", "https:"]
  }
})
```

### 4. Rate Limiting

#### Login Protection
```javascript
// server/auth/auth.js
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 10,                    // 10 attempts
  message: 'Too many login attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true  // counter resets on successful login
});
```

#### API Rate Limiting (Optional)
```javascript
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,   // 1 minute
  max: 100,                   // 100 requests
  message: 'Too many API requests'
});
```

### 5. CSRF Protection

Enabled on all state-changing operations:
```javascript
const csrfProtection = csrf({ 
  cookie: false  // Use session instead
});

// Applied to forms
app.use(csrfProtection);
```

### 6. Input Validation

#### Database Queries
- **Parameterized Queries**: All SQL uses placeholders
- **Input Sanitization**: Custom validation layer
- **Type Checking**: Strict type validation

Example:
```javascript
// Safe query with validation
const player = await db.get(
  'SELECT * FROM players WHERE player_id = ?',
  [validatePlayerId(req.params.playerId)]
);
```

#### Request Validation
```javascript
// Validation middleware
function validateRequest(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
}
```

### 7. Error Handling

#### Safe Error Messages
```javascript
// Production error handler
app.use((err, req, res, next) => {
  logError(err);
  
  // Don't leak error details
  const message = process.env.NODE_ENV === 'production'
    ? 'Internal Server Error'
    : err.message;
    
  res.status(err.status || 500).json({ error: message });
});
```

### 8. Secure File Storage

#### Database Security
```bash
# Secure database file permissions
chmod 600 fantasy_football.db
chmod 700 data/

# Backup encryption (optional)
openssl enc -aes-256-cbc -salt -in fantasy_football.db -out backup.db.enc
```

#### Session Store
```bash
# Secure session database
chmod 600 data/sessions.db
```

## Deployment Security Checklist

### Pre-Deployment
- [ ] Generate strong SESSION_SECRET (64+ characters)
- [ ] Configure HTTPS certificates
- [ ] Set NODE_ENV=production
- [ ] Review and update CORS origins
- [ ] Disable debug logging
- [ ] Create admin user with strong password
- [ ] Test rate limiting
- [ ] Verify CSRF protection

### Network Security
- [ ] Configure firewall rules
- [ ] Restrict database access
- [ ] Use reverse proxy (nginx/Apache)
- [ ] Enable DDoS protection
- [ ] Monitor failed login attempts
- [ ] Set up intrusion detection

### Application Security
- [ ] Keep dependencies updated
- [ ] Regular security audits (`npm audit`)
- [ ] Monitor error logs
- [ ] Implement backup strategy
- [ ] Test disaster recovery
- [ ] Document security procedures

## Environment Variables

### Required for Production
```bash
# .env.production
NODE_ENV=production
SESSION_SECRET=<64+ character random string>
ADMIN_PASSWORD_HASH=<bcrypt hash from generateHash.js>
TANK01_API_KEY=<your-api-key>
PORT=3000
HTTPS_PORT=8443
SSL_CERT=./certs/fullchain.pem
SSL_KEY=./certs/privkey.pem
```

Rate limiting (10 attempts / 15 min), session timeout (2 hours), and bcrypt rounds (12) are hardcoded in `server/auth/auth.js` and `server/auth/generateHash.js` — they are not configurable via environment variables.

## Common Security Scenarios

### 1. Brute Force Attack Prevention
```javascript
// Implement account lockout
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_TIME = 30 * 60 * 1000; // 30 minutes

// Track failed attempts in database
async function handleFailedLogin(username) {
  await db.run(`
    INSERT INTO failed_logins (username, attempt_time)
    VALUES (?, datetime('now'))
  `, [username]);
}
```

### 2. Session Hijacking Prevention
```javascript
// Regenerate session ID on login
req.session.regenerate((err) => {
  req.session.userId = user.id;
  req.session.regenerated = Date.now();
});

// Periodic session regeneration
if (Date.now() - req.session.regenerated > 300000) {
  req.session.regenerate(() => {
    req.session.regenerated = Date.now();
  });
}
```

### 3. SQL Injection Prevention
```javascript
// Never do this
const query = `SELECT * FROM users WHERE id = ${userId}`;

// Always use parameterized queries
const query = 'SELECT * FROM users WHERE id = ?';
db.get(query, [userId]);
```

### 4. XSS Prevention
```javascript
// Sanitize user input before display
const sanitizeHtml = require('sanitize-html');
const clean = sanitizeHtml(userInput, {
  allowedTags: [],
  allowedAttributes: {}
});
```

## Monitoring and Logging

### Security Event Logging
```javascript
// Log security events
function logSecurityEvent(event, details) {
  const entry = {
    timestamp: new Date().toISOString(),
    event,
    ...details
  };
  
  // Log to file and/or external service
  fs.appendFileSync('security.log', JSON.stringify(entry) + '\n');
}

// Usage
logSecurityEvent('failed_login', { username, ip: req.ip });
logSecurityEvent('rate_limit_exceeded', { ip: req.ip });
logSecurityEvent('csrf_token_mismatch', { url: req.url });
```

### Monitoring Alerts
Set up alerts for:
- Multiple failed login attempts
- Rate limit violations
- Database query errors
- Unexpected 500 errors
- Certificate expiration

## Incident Response

### Security Incident Checklist
1. **Identify** the security incident
2. **Contain** the threat (block IPs, disable accounts)
3. **Investigate** logs and audit trails
4. **Remediate** vulnerabilities
5. **Document** incident and response
6. **Review** and update security measures

### Emergency Procedures
```bash
# Block IP address
iptables -A INPUT -s malicious.ip.address -j DROP

# Rotate the admin password (generate a new hash, update .env, restart)
node server/auth/generateHash.js
pm2 restart statfink2

# Force all users to re-authenticate
sqlite3 data/sessions.db "DELETE FROM sessions"

# Emergency shutdown
pm2 stop statfink2
```

## Security Best Practices

### For Developers
- Never commit secrets to version control
- Use environment variables for sensitive data
- Keep dependencies updated
- Run security audits regularly
- Test security features
- Document security procedures

### For Administrators
- Use strong, unique passwords
- Enable 2FA where possible
- Monitor logs regularly
- Keep backups secure and encrypted
- Test restore procedures
- Stay informed about security updates

### For Users
- Use strong passwords
- Don't share login credentials
- Report suspicious activity
- Log out when finished
- Use HTTPS URLs only

## Compliance Considerations

### Data Protection
- Minimal data collection
- Secure data storage
- Encrypted backups
- Data retention policies
- User data export options

### Privacy
- No tracking cookies
- No third-party analytics
- Clear privacy policy
- User consent for data collection
- Right to deletion

## Conclusion

Security is an ongoing process, not a one-time configuration. Regular updates, monitoring, and testing are essential to maintain a secure StatFink deployment. Always follow the principle of least privilege and defense in depth.