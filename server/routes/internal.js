const express = require('express');
const { asyncHandler, APIError, logInfo, logWarn } = require('../utils/errorHandler');
const router = express.Router();

// Middleware to ensure requests only come from localhost
const localhostOnly = (req, res, next) => {
    const clientIp = req.ip || req.connection.remoteAddress;
    
    // Handle IPv6 and IPv4 localhost addresses
    const isLocalhost = clientIp === '127.0.0.1' || 
                       clientIp === '::1' || 
                       clientIp === '::ffff:127.0.0.1';
    
    if (!isLocalhost) {
        logWarn('Rejected internal API request from non-localhost', { 
            clientIp,
            url: req.originalUrl,
            headers: req.headers 
        });
        return res.status(403).json({ 
            success: false, 
            message: 'Forbidden: Internal API only accessible from localhost' 
        });
    }
    
    // Add additional security header check
    const internalToken = req.headers['x-internal-token'];
    if (internalToken !== 'statfink-internal-cron') {
        logWarn('Internal API request missing valid token', { 
            clientIp,
            url: req.originalUrl 
        });
        return res.status(403).json({ 
            success: false, 
            message: 'Forbidden: Invalid internal token' 
        });
    }
    
    next();
};

// Apply localhost-only middleware to all routes
router.use(localhostOnly);

// Daily update endpoint (for cron job)
router.post('/scheduler/daily', asyncHandler(async (req, res) => {
    const schedulerService = req.app.locals.schedulerService;
    
    if (!schedulerService) {
        throw new APIError('Scheduler service not available', 500);
    }
    
    logInfo('Internal daily update triggered');
    const result = await schedulerService.performDailyUpdate();
    
    if (result.success) {
        res.json({
            success: true,
            message: result.message,
            data: result
        });
    } else {
        res.status(500).json({
            success: false,
            message: result.message,
            data: result
        });
    }
}));

// Weekly update endpoint (for cron job)
router.post('/scheduler/weekly', asyncHandler(async (req, res) => {
    const schedulerService = req.app.locals.schedulerService;
    
    if (!schedulerService) {
        throw new APIError('Scheduler service not available', 500);
    }
    
    logInfo('Internal weekly update triggered');
    const result = await schedulerService.performWeeklyUpdate();
    
    if (result.success) {
        res.json({
            success: true,
            message: result.message,
            data: result
        });
    } else {
        // Weekly updates might not be ready (wrong day), that's ok
        res.json({
            success: false,
            message: result.message,
            data: result
        });
    }
}));

// Live update endpoint (for cron job)
router.post('/scheduler/live', asyncHandler(async (req, res) => {
    const schedulerService = req.app.locals.schedulerService;
    
    if (!schedulerService) {
        throw new APIError('Scheduler service not available', 500);
    }
    
    logInfo('Internal live update triggered');
    const result = await schedulerService.performLiveGameUpdate();
    
    if (result.success) {
        res.json({
            success: true,
            message: result.message,
            data: result
        });
    } else {
        res.status(500).json({
            success: false,
            message: result.message,
            data: result
        });
    }
}));

// Status endpoint (for monitoring)
router.get('/scheduler/status', asyncHandler(async (req, res) => {
    const schedulerService = req.app.locals.schedulerService;
    
    if (!schedulerService) {
        throw new APIError('Scheduler service not available', 500);
    }
    
    const status = schedulerService.getStatus();
    res.json({
        success: true,
        data: status
    });
}));

module.exports = router;