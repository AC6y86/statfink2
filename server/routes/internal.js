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

// Ingest a roster-move email from the Gmail poller: dedup -> parse with
// Claude -> enqueue pending moves for commissioner approval
router.post('/roster-email', asyncHandler(async (req, res) => {
    const parsingService = req.app.locals.emailMoveParsingService;
    const pendingMovesService = req.app.locals.pendingMovesService;
    const healthCheckService = req.app.locals.healthCheckService;

    if (!parsingService || !pendingMovesService) {
        throw new APIError('Email move services not available', 500);
    }

    const email = req.body || {};
    if (!email.gmailMessageId || !email.from || typeof email.body !== 'string') {
        throw new APIError('gmailMessageId, from and body are required', 400);
    }

    // Server-side dedup - the poller may re-send already-handled messages
    if (await pendingMovesService.hasProcessedEmail(email.gmailMessageId)) {
        return res.json({ success: true, queued: false, reason: 'duplicate' });
    }

    const parse = await parsingService.parseEmail(email);

    if (parse.status === 'unknown_sender') {
        logInfo(`Roster email from unknown sender ignored: ${email.from}`);
        await pendingMovesService.markEmailProcessed(email.gmailMessageId, 'unknown_sender');
        return res.json({ success: true, queued: false, reason: 'unknown_sender' });
    }

    if (parse.status === 'not_a_roster_move') {
        await pendingMovesService.markEmailProcessed(email.gmailMessageId, 'not_a_roster_move');
        return res.json({ success: true, queued: false, reason: 'not_a_roster_move', summary: parse.summary });
    }

    const items = await pendingMovesService.enqueueParsedEmail(email, parse);

    if (healthCheckService) {
        const needsReview = items.some(i => i.status === 'needs_review');
        await healthCheckService.recordAlert(
            needsReview ? 'warning' : 'info',
            'email-moves',
            needsReview
                ? `Email move from ${email.from} needs review: ${parse.summary}`
                : `New pending roster move from ${email.from}: ${parse.summary}`,
            (parse.questions_for_commissioner || []).length ? parse.questions_for_commissioner : null
        );
    }

    res.json({
        success: true,
        queued: true,
        items: items.map(i => ({ id: i.id, status: i.status })),
        status: parse.status,
        summary: parse.summary
    });
}));

// Record a health alert (for cron/continuous scripts running outside the server process)
router.post('/health/alert', asyncHandler(async (req, res) => {
    const healthCheckService = req.app.locals.healthCheckService;

    if (!healthCheckService) {
        throw new APIError('Health check service not available', 500);
    }

    const { severity = 'warning', source = 'internal', message } = req.body || {};
    if (!message) {
        throw new APIError('Alert message is required', 400);
    }

    const alert = await healthCheckService.recordAlert(severity, source, message);
    res.json({ success: true, data: alert });
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