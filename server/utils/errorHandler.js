// Error handling utilities

class DatabaseError extends Error {
    constructor(message, query = null, params = null) {
        super(message);
        this.name = 'DatabaseError';
        this.query = query;
        this.params = params;
    }
}

class APIError extends Error {
    constructor(message, statusCode = 500) {
        super(message);
        this.name = 'APIError';
        this.statusCode = statusCode;
    }
}

// Logging utilities
function logError(message, error = null, context = {}) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ERROR: ${message}`, {
        error: error ? error.message : null,
        stack: error ? error.stack : null,
        ...context
    });
}

function logInfo(message, context = {}) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] INFO: ${message}`, context);
}

function logWarn(message, context = {}) {
    const timestamp = new Date().toISOString();
    console.warn(`[${timestamp}] WARN: ${message}`, context);
}

// Express error handling middleware
function errorHandler(err, req, res, next) {
    logError('Express error handler', err, {
        url: req.url,
        method: req.method,
        body: req.body
    });

    if (err.name === 'ValidationError') {
        return res.status(400).json({
            error: 'Validation Error',
            message: err.message,
            field: err.field
        });
    }

    if (err.name === 'DatabaseError') {
        return res.status(500).json({
            error: 'Database Error',
            message: 'A database error occurred'
        });
    }

    if (err.name === 'APIError') {
        return res.status(err.statusCode).json({
            error: 'API Error',
            message: err.message
        });
    }

    // Default error
    res.status(500).json({
        error: 'Internal Server Error',
        message: 'An unexpected error occurred'
    });
}

// Async route wrapper to catch errors
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

module.exports = {
    DatabaseError,
    APIError,
    ValidationError: require('./validation').ValidationError,
    logError,
    logInfo,
    logWarn,
    errorHandler,
    asyncHandler
};