const crypto = require('crypto');

class TrafficTracker {
    constructor(db) {
        this.db = db;
        this.sessionMap = new Map(); // In-memory session tracking
    }

    // Hash IP address for privacy
    hashIP(ip) {
        return crypto.createHash('sha256').update(ip || 'unknown').digest('hex');
    }

    // Get or create session ID
    getSessionId(req) {
        // Try to get session from cookie first
        let sessionId = req.cookies?.sessionId;
        
        if (!sessionId) {
            // Create new session using crypto
            sessionId = crypto.randomBytes(16).toString('hex');
            // Store it (will be set as cookie in middleware)
            req.newSessionId = sessionId;
        }
        
        return sessionId;
    }

    // Track page visit
    async trackVisit(req) {
        try {
            const path = req.path;
            const ipHash = this.hashIP(req.ip);
            const userAgent = req.get('user-agent') || 'unknown';
            const referer = req.get('referer') || null;
            const sessionId = this.getSessionId(req);
            const isAdminPage = path.startsWith('/admin');

            // Insert traffic record
            await this.db.run(`
                INSERT INTO page_traffic (path, ip_hash, user_agent, referer, session_id, is_admin_page)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [path, ipHash, userAgent, referer, sessionId, isAdminPage ? 1 : 0]);

            // Update daily summary
            const today = new Date().toISOString().split('T')[0];
            
            // Check if this is a unique visitor for today
            const existingVisit = await this.db.get(`
                SELECT COUNT(*) as count FROM page_traffic 
                WHERE path = ? AND session_id = ? AND DATE(timestamp) = ?
            `, [path, sessionId, today]);

            if (existingVisit.count === 1) { // First visit today (we just inserted it)
                // Update or insert summary
                await this.db.run(`
                    INSERT INTO traffic_summary (date, path, total_visits, unique_visitors)
                    VALUES (?, ?, 1, 1)
                    ON CONFLICT(date, path) DO UPDATE SET 
                        total_visits = total_visits + 1,
                        unique_visitors = unique_visitors + 1
                `, [today, path]);
            } else {
                // Just increment total visits
                await this.db.run(`
                    INSERT INTO traffic_summary (date, path, total_visits, unique_visitors)
                    VALUES (?, ?, 1, 0)
                    ON CONFLICT(date, path) DO UPDATE SET 
                        total_visits = total_visits + 1
                `, [today, path]);
            }
        } catch (error) {
            console.error('Error tracking visit:', error);
            // Don't throw - we don't want tracking errors to break the site
        }
    }

    // Middleware function
    middleware() {
        return async (req, res, next) => {
            // Skip tracking for:
            // 1. Static assets (js, css, images, fonts, etc.)
            // 2. ALL API calls (including traffic stats endpoints)
            // 3. Specific internal endpoints
            if (req.path.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/i) ||
                req.path.startsWith('/api/') ||
                req.path.startsWith('/scheduler/') ||
                req.path === '/health' ||
                req.path === '/sync-status' ||
                req.path === '/settings' ||
                req.path.startsWith('/game/')) {
                return next();
            }

            // Track the visit asynchronously
            this.trackVisit(req);

            // Set session cookie if new
            if (req.newSessionId) {
                res.cookie('sessionId', req.newSessionId, {
                    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
                    httpOnly: true,
                    sameSite: 'lax'
                });
            }

            next();
        };
    }

    // Get traffic statistics
    async getStats(days = 30) {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);
        const cutoffDateStr = cutoffDate.toISOString().split('T')[0];

        // Get overall stats
        const overallStats = await this.db.get(`
            SELECT 
                COUNT(*) as total_visits,
                COUNT(DISTINCT session_id) as unique_visitors,
                COUNT(DISTINCT path) as unique_pages
            FROM page_traffic
            WHERE DATE(timestamp) >= ?
        `, [cutoffDateStr]);

        // Get today's stats
        const today = new Date().toISOString().split('T')[0];
        const todayStats = await this.db.get(`
            SELECT 
                COUNT(*) as visits_today,
                COUNT(DISTINCT session_id) as visitors_today
            FROM page_traffic
            WHERE DATE(timestamp) = ?
        `, [today]);

        // Get popular pages
        const popularPages = await this.db.all(`
            SELECT 
                path,
                COUNT(*) as visits,
                COUNT(DISTINCT session_id) as unique_visitors
            FROM page_traffic
            WHERE DATE(timestamp) >= ?
            GROUP BY path
            ORDER BY visits DESC
            LIMIT 10
        `, [cutoffDateStr]);

        // Get recent activity (last 20 visits)
        const recentActivity = await this.db.all(`
            SELECT 
                path,
                timestamp,
                referer,
                user_agent
            FROM page_traffic
            ORDER BY timestamp DESC
            LIMIT 20
        `);

        // Get hourly distribution for today
        const hourlyStats = await this.db.all(`
            SELECT 
                strftime('%H', timestamp) as hour,
                COUNT(*) as visits
            FROM page_traffic
            WHERE DATE(timestamp) = ?
            GROUP BY hour
            ORDER BY hour
        `, [today]);

        return {
            overall: overallStats,
            today: todayStats,
            popularPages,
            recentActivity,
            hourlyStats,
            period: `Last ${days} days`
        };
    }

    // Get real-time visitor count (visitors in last 5 minutes)
    async getRealTimeCount() {
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        
        const result = await this.db.get(`
            SELECT COUNT(DISTINCT session_id) as active_visitors
            FROM page_traffic
            WHERE timestamp >= ?
        `, [fiveMinutesAgo]);

        return result.active_visitors;
    }

    // Clean up old data (keep last 90 days)
    async cleanup() {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - 90);
        const cutoffDateStr = cutoffDate.toISOString();

        await this.db.run(`
            DELETE FROM page_traffic
            WHERE timestamp < ?
        `, [cutoffDateStr]);

        await this.db.run(`
            DELETE FROM traffic_summary
            WHERE date < ?
        `, [cutoffDateStr.split('T')[0]]);
    }
}

module.exports = TrafficTracker;