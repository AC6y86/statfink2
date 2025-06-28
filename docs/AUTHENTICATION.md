# Authentication System Documentation

## Overview

StatFink implements a session-based authentication system to protect administrative functions while keeping public viewing interfaces accessible to all league members. The system uses industry-standard security practices including bcrypt password hashing, CSRF protection, and rate limiting.

## Security Features

### Password Security
- **Bcrypt Hashing**: All passwords are hashed using bcrypt with a salt factor of 10
- **No Plain Text**: Passwords are never stored in plain text
- **Hash Generation Utility**: `node server/auth/generateHash.js` for creating admin passwords

### Session Management
- **Express Sessions**: Secure session management with configurable options
- **Session Store**: SQLite-based session store in production
- **Cookie Security**:
  - `httpOnly`: Prevents JavaScript access to cookies
  - `secure`: HTTPS-only in production
  - `sameSite`: CSRF protection
  - 2-hour session timeout

### Rate Limiting
- **Login Protection**: Maximum 5 login attempts per 15 minutes per IP
- **Automatic Blocking**: Temporarily blocks IPs after failed attempts
- **Skip Successful**: Counter resets on successful login

### CSRF Protection
- **Token Validation**: All POST requests require valid CSRF tokens
- **Automatic Generation**: Tokens generated per session
- **Form Integration**: Hidden fields added to all forms

### Security Headers (Helmet.js)
- **Content Security Policy**: Prevents XSS attacks
- **X-Frame-Options**: Prevents clickjacking
- **X-Content-Type-Options**: Prevents MIME sniffing
- **Strict-Transport-Security**: Forces HTTPS

## Authentication Flow

### Login Process
1. User visits `/login`
2. Enters username and password
3. System validates credentials against hashed password
4. On success:
   - Creates session
   - Regenerates session ID
   - Redirects to requested page or dashboard
5. On failure:
   - Increments rate limit counter
   - Shows error message

### Protected Routes
Routes requiring authentication:
- `/dashboard` - Admin dashboard
- `/roster` - Roster management
- `/database-browser` - Database browser
- `/api/admin/*` - All admin API endpoints

### Public Routes
No authentication required:
- `/statfink` - Live matchup viewer
- `/standings` - League standings
- `/rosters` - Public roster viewer
- `/api/players` - Player data (read-only)
- `/api/teams` - Team data (read-only)

## Setup Instructions

### 1. Generate Admin Password Hash
```bash
node server/auth/generateHash.js
# Enter username: admin
# Enter password: [your-secure-password]
# Hash: $2b$10$... (copy this hash)
```

### 2. Add User to Database
```sql
-- Create users table if not exists
CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY AUTOINCREMENT,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(100) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Insert admin user with generated hash
INSERT INTO users (username, password_hash) 
VALUES ('admin', '$2b$10$...[your-generated-hash]');
```

### 3. Configure Environment
```bash
# .env file
SESSION_SECRET=your-strong-random-session-secret
NODE_ENV=production  # Enables secure cookies
HTTPS_PORT=8443      # For HTTPS
```

### 4. SSL/HTTPS Configuration
For production, use HTTPS to protect session cookies:
```bash
# Let's Encrypt (recommended)
cp /etc/letsencrypt/live/yourdomain/fullchain.pem ./certs/
cp /etc/letsencrypt/live/yourdomain/privkey.pem ./certs/

# Or self-signed for development
openssl req -x509 -newkey rsa:4096 -keyout ./certs/key.pem -out ./certs/cert.pem -days 365 -nodes
```

## API Authentication

### Check Authentication Status
```http
GET /api/auth/check
```
Response:
```json
{
  "authenticated": true,
  "username": "admin"
}
```

### Login Endpoint
```http
POST /login
Content-Type: application/x-www-form-urlencoded

username=admin&password=your-password&_csrf=token
```

### Logout Endpoint
```http
POST /logout
```

## Middleware Implementation

### requireAuth Middleware
```javascript
function requireAuth(req, res, next) {
    if (!req.session.userId) {
        req.session.returnTo = req.originalUrl;
        return res.redirect('/login');
    }
    // Session regeneration for security
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
```

## Security Best Practices

### Development
- Use self-signed certificates for HTTPS testing
- Keep session secrets in .env file
- Test rate limiting with multiple login attempts
- Verify CSRF tokens are working

### Production
- **Always use HTTPS** with valid certificates
- Generate strong session secrets (64+ characters)
- Monitor failed login attempts
- Regular security updates for dependencies
- Consider adding 2FA for additional security

### Session Security
- Sessions expire after 2 hours of inactivity
- Session IDs regenerated on login
- Old sessions cleared on logout
- Session store persisted to disk

## Troubleshooting

### Common Issues

#### "Too many login attempts"
- Wait 15 minutes or restart server in development
- Check rate limiting configuration

#### "Invalid CSRF token"
- Ensure forms include `_csrf` field
- Check session configuration
- Verify cookies are enabled

#### "Session expired"
- Sessions timeout after 2 hours
- Login again to continue
- Consider extending timeout if needed

#### HTTPS redirect issues
- Ensure `NODE_ENV=production` for secure cookies
- Verify SSL certificates are properly configured
- Check CORS settings for HTTPS URLs

## Disabling Authentication (Development Only)

To disable authentication for development:

1. Comment out `requireAuth` middleware in routes
2. Set `NODE_ENV=development`
3. Access admin interfaces directly

**WARNING**: Never disable authentication in production environments.