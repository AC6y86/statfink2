const { 
  DatabaseError, 
  APIError, 
  ValidationError,
  errorHandler,
  asyncHandler,
  logError 
} = require('../../server/utils/errorHandler');

// Mock console methods
const originalConsoleError = console.error;
const originalConsoleLog = console.log;

describe('Error Handler', () => {
  beforeEach(() => {
    // Mock console methods
    console.error = jest.fn();
    console.log = jest.fn();
  });

  afterEach(() => {
    // Restore console methods
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
  });

  describe('Custom Error Classes', () => {
    test('should create DatabaseError with query details', () => {
      const query = 'SELECT * FROM teams';
      const params = [1, 2];
      const error = new DatabaseError('Database connection failed', query, params);

      expect(error.name).toBe('DatabaseError');
      expect(error.message).toBe('Database connection failed');
      expect(error.query).toBe(query);
      expect(error.params).toEqual(params);
    });

    test('should create APIError with status code', () => {
      const error = new APIError('Not found', 404);

      expect(error.name).toBe('APIError');
      expect(error.message).toBe('Not found');
      expect(error.statusCode).toBe(404);
    });

    test('should create ValidationError', () => {
      const error = new ValidationError('Invalid input', 'player_id');

      expect(error.name).toBe('ValidationError');
      expect(error.message).toBe('Invalid input');
      expect(error.field).toBe('player_id');
    });
  });

  describe('Error Handler Middleware', () => {
    let req, res, next;

    beforeEach(() => {
      req = { url: '/test', method: 'GET', body: {} };
      res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      next = jest.fn();
    });

    test('should handle ValidationError', () => {
      const error = new ValidationError('Invalid data', 'email');

      errorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Validation Error',
        message: 'Invalid data',
        field: 'email'
      });
    });

    test('should handle DatabaseError', () => {
      const error = new DatabaseError('Connection failed');

      errorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Database Error',
        message: 'A database error occurred'
      });
    });

    test('should handle APIError', () => {
      const error = new APIError('Not found', 404);

      errorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        error: 'API Error',
        message: 'Not found'
      });
    });

    test('should handle generic errors', () => {
      const error = new Error('Generic error');

      errorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Internal Server Error',
        message: 'An unexpected error occurred'
      });
    });
  });

  describe('Async Handler', () => {
    test('should catch async errors', async () => {
      const asyncFunction = async (req, res, next) => {
        throw new Error('Async error');
      };

      const wrappedFunction = asyncHandler(asyncFunction);
      const next = jest.fn();

      await wrappedFunction({}, {}, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe('Async error');
    });

    test('should pass through successful async functions', async () => {
      const asyncFunction = async (req, res, next) => {
        res.json({ success: true });
      };

      const wrappedFunction = asyncHandler(asyncFunction);
      const res = { json: jest.fn() };
      const next = jest.fn();

      await wrappedFunction({}, res, next);

      expect(res.json).toHaveBeenCalledWith({ success: true });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('Logging Functions', () => {
    test('should log errors with context', () => {
      const error = new Error('Test error');
      const context = { userId: 123 };

      logError('Something went wrong', error, context);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringMatching(/ERROR: Something went wrong/),
        expect.objectContaining({
          error: 'Test error',
          stack: expect.any(String),
          userId: 123
        })
      );
    });

    test('should log without error object', () => {
      logError('Simple error message');

      expect(console.error).toHaveBeenCalledWith(
        expect.stringMatching(/ERROR: Simple error message/),
        expect.objectContaining({
          error: null,
          stack: null
        })
      );
    });
  });
});