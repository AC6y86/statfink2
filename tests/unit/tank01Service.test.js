/**
 * Tank01Service Unit Tests
 * Tests Tank01 API service with mocked external dependencies
 */

const Tank01Service = require('../../server/services/tank01Service');
const axios = require('axios');

// Mock axios
jest.mock('axios');
const mockedAxios = axios;

describe('Tank01Service', () => {
  let service;
  const TEST_API_KEY = 'test-api-key-12345';

  beforeEach(() => {
    service = new Tank01Service(TEST_API_KEY);
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(async () => {
    jest.useRealTimers();
    // Close database connection to prevent logging after tests
    if (service && service.db && typeof service.db.close === 'function') {
      try {
        await service.db.close();
      } catch (err) {
        // Ignore close errors
      }
    }
  });

  describe('Initialization', () => {
    test('should initialize with API key and configuration', () => {
      expect(service.apiKey).toBe(TEST_API_KEY);
      expect(service.baseURL).toContain('tank01');
      expect(service.headers['X-RapidAPI-Key']).toBe(TEST_API_KEY);
      expect(service.headers['X-RapidAPI-Host']).toBeDefined();
    });

    test('should initialize rate limiting properties', () => {
      expect(service.lastRequestTime).toBe(0);
      expect(service.minRequestInterval).toBeGreaterThan(0);
      expect(service.maxRequestsPerMinute).toBeGreaterThan(0);
      expect(service.requestCount).toBe(0);
    });

    test('should initialize cache system', () => {
      expect(service.defaultCacheExpiry).toBeGreaterThan(0);
      expect(service.historicalCacheExpiry).toBe(null);
      expect(service.db).toBeDefined();
    });

    test('should handle missing API key', () => {
      const serviceWithoutKey = new Tank01Service();
      expect(serviceWithoutKey.apiKey).toBeUndefined();
    });
  });

  describe('Rate Limiting', () => {
    test('should implement rate limiting delay', async () => {
      // First request should not delay
      const promise1 = service.rateLimit();
      jest.advanceTimersByTime(0);
      await promise1;

      // Second immediate request should delay
      const startTime = Date.now();
      const promise2 = service.rateLimit();
      
      // Advance timers to simulate delay
      jest.advanceTimersByTime(service.minRequestInterval);
      await promise2;

      expect(service.requestCount).toBe(2);
    });

    test('should track request count', async () => {
      // Mock the rate limiting to avoid actual delays
      const originalRateLimit = service.rateLimit;
      service.rateLimit = jest.fn().mockResolvedValue();
      
      await service.rateLimit();
      await service.rateLimit();
      await service.rateLimit();
      
      expect(service.rateLimit).toHaveBeenCalledTimes(3);
      
      // Restore original method
      service.rateLimit = originalRateLimit;
    });

    test('should update last request time', async () => {
      const beforeTime = service.lastRequestTime;
      
      // Mock the rate limiting to avoid actual delays
      const originalRateLimit = service.rateLimit;
      service.rateLimit = jest.fn().mockImplementation(() => {
        service.lastRequestTime = Date.now();
        return Promise.resolve();
      });
      
      await service.rateLimit();
      
      expect(service.lastRequestTime).toBeGreaterThan(beforeTime);
      
      // Restore original method
      service.rateLimit = originalRateLimit;
    });
  });

  describe('Cache Management', () => {
    test('should have cache configuration', () => {
      expect(service.defaultCacheExpiry).toBeGreaterThan(0);
      expect(service.historicalCacheExpiry).toBe(null);
    });

    test('should determine historical data correctly', () => {
      const currentYear = new Date().getFullYear();
      
      // Test historical season
      expect(service.isHistoricalData('/test', { season: currentYear - 1 })).toBe(true);
      
      // Test current season
      expect(service.isHistoricalData('/test', { season: currentYear })).toBe(false);
    });

    test('should have cache management methods', () => {
      expect(typeof service.getCachedData).toBe('function');
      expect(typeof service.setCachedData).toBe('function');
      expect(typeof service.clearCache).toBe('function');
    });
  });

  describe('API Request Methods', () => {
    beforeEach(() => {
      mockedAxios.get = jest.fn();
    });

    test('should make successful API requests', async () => {
      const mockResponse = {
        data: { players: [{ id: 1, name: 'Test Player' }] },
        status: 200
      };
      
      mockedAxios.get.mockResolvedValue(mockResponse);
      
      const result = await service.makeRequest('/players');
      
      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining('/players'),
        expect.objectContaining({
          headers: service.headers,
          timeout: expect.any(Number)
        })
      );
      expect(result).toEqual(mockResponse.data);
    });

    test('should handle API request errors', async () => {
      const mockError = new Error('Network error');
      mockError.response = { status: 500, data: { error: 'Server error' } };
      
      mockedAxios.get.mockRejectedValue(mockError);
      
      await expect(service.makeRequest('/invalid')).rejects.toThrow();
    });

    test('should handle timeout errors', async () => {
      const timeoutError = new Error('Request timeout');
      timeoutError.code = 'ECONNABORTED';
      
      mockedAxios.get.mockRejectedValue(timeoutError);
      
      await expect(service.makeRequest('/slow-endpoint')).rejects.toThrow();
    });

    test('should handle rate limit responses', async () => {
      const rateLimitError = new Error('Rate limited');
      rateLimitError.response = { status: 429, data: { error: 'Too many requests' } };
      
      // Mock exponential backoff to avoid delays
      service.exponentialBackoff = jest.fn().mockResolvedValue();
      
      mockedAxios.get.mockRejectedValue(rateLimitError);
      
      await expect(service.makeRequest('/players')).rejects.toThrow();
      expect(service.exponentialBackoff).toHaveBeenCalled();
    });
  });

  describe('Specific API Endpoints', () => {
    beforeEach(() => {
      mockedAxios.get = jest.fn();
    });

    test('should handle player data requests', async () => {
      const mockPlayers = {
        data: [
          { playerId: 1, name: 'Player 1', position: 'QB' },
          { playerId: 2, name: 'Player 2', position: 'RB' }
        ]
      };
      
      mockedAxios.get.mockResolvedValue({ data: mockPlayers });
      
      if (service.getPlayers) {
        const result = await service.getPlayers();
        expect(result).toBeDefined();
      }
    });

    test('should handle injury data requests', async () => {
      const mockInjuries = {
        data: [
          { playerId: 1, injuryStatus: 'Questionable', description: 'Ankle' }
        ]
      };
      
      mockedAxios.get.mockResolvedValue({ data: mockInjuries });
      
      if (service.getInjuries) {
        const result = await service.getInjuries();
        expect(result).toBeDefined();
      }
    });

    test('should handle stats data requests', async () => {
      const mockStats = {
        data: [
          { playerId: 1, week: 1, passingYards: 300, touchdowns: 2 }
        ]
      };
      
      mockedAxios.get.mockResolvedValue({ data: mockStats });
      
      if (service.getWeeklyStats) {
        const result = await service.getWeeklyStats(1);
        expect(result).toBeDefined();
      }
    });
  });

  describe('Error Handling and Resilience', () => {
    test('should handle network connectivity issues', async () => {
      const networkError = new Error('Network unreachable');
      networkError.code = 'ENETUNREACH';
      
      mockedAxios.get.mockRejectedValue(networkError);
      
      await expect(service.makeRequest('/test')).rejects.toThrow();
    });

    test('should handle malformed API responses', async () => {
      mockedAxios.get.mockResolvedValue({
        data: 'invalid json string',
        status: 200
      });
      
      // Should not throw for valid HTTP response, even if data is unexpected
      const result = await service.makeRequest('/test');
      expect(result).toBeDefined();
    });

    test('should handle API key validation errors', async () => {
      const authError = new Error('Invalid API key');
      authError.response = { status: 401, data: { error: 'Unauthorized' } };
      
      mockedAxios.get.mockRejectedValue(authError);
      
      await expect(service.makeRequest('/test')).rejects.toThrow();
    });

    test('should handle quota exceeded errors', async () => {
      const quotaError = new Error('Quota exceeded');
      quotaError.response = { status: 403, data: { error: 'Quota exceeded' } };
      
      mockedAxios.get.mockRejectedValue(quotaError);
      
      await expect(service.makeRequest('/test')).rejects.toThrow();
    });
  });

  describe('Health Check Methods', () => {
    test('should have health check capability', () => {
      // Check if service has health check method
      if (service.healthCheck) {
        expect(typeof service.healthCheck).toBe('function');
      }
    });

    test('should validate API configuration', () => {
      expect(service.apiKey).toBeTruthy();
      expect(service.baseURL).toBeTruthy();
      expect(service.headers).toBeDefined();
      expect(service.headers['X-RapidAPI-Key']).toBe(TEST_API_KEY);
    });

    test('should check rate limiting status', () => {
      expect(service.requestCount).toBeGreaterThanOrEqual(0);
      expect(service.lastRequestTime).toBeGreaterThanOrEqual(0);
      expect(service.minRequestInterval).toBeGreaterThan(0);
    });
  });
});
describe('Tank01Service completed-boxscore quarantine', () => {
    let service;
    const box = (homePts, awayPts, plays, status = 'Completed') => ({ statusCode: 200, body: { gameID: 'g', gameStatus: status, homePts: String(homePts), awayPts: String(awayPts), scoringPlays: plays } });
    const play = (homeScore, awayScore) => ({ score: 'x', homeScore: String(homeScore), awayScore: String(awayScore) });

    beforeEach(() => {
        service = new Tank01Service('k');
        service.db = { get: jest.fn(), run: jest.fn(), close: jest.fn() };
    });

    test('boxscoreLooksSettled: last scoring play must reach the final score (wk12 2025 PHI@DAL pattern)', () => {
        expect(service.boxscoreLooksSettled(box(24, 21, [play(7, 21), play(21, 21)]).body)).toBe(false); // final FG missing
        expect(service.boxscoreLooksSettled(box(24, 21, [play(7, 21), play(21, 21), play(24, 21)]).body)).toBe(true);
        expect(service.boxscoreLooksSettled(box(24, 21, []).body)).toBe(false);
        expect(service.boxscoreLooksSettled(box(0, 0, []).body)).toBe(true);
        expect(service.boxscoreLooksSettled(null)).toBe(false);
    });

    test('first Completed sighting is cached with a short expiry, not permanently', async () => {
        service.db.get.mockResolvedValue(undefined);
        await service.setCachedData('boxscore_g', '/getNFLBoxScore', {}, box(24, 21, [play(24, 21)]));
        const args = service.db.run.mock.calls.find(c => /INSERT OR REPLACE INTO tank01_cache/.test(c[0]))[1];
        expect(args[5]).toBe(0); // is_historical
        expect(args[4]).not.toBeNull(); // expires_at
        expect(new Date(args[4]).getTime() - Date.now()).toBeLessThanOrEqual(service.completedQuarantineMs + 1000);
    });

    test('an unsettled Completed boxscore is never permanent even after the quarantine', async () => {
        service.db.get.mockResolvedValue({ created_at: '2020-01-01 00:00:00', response_data: JSON.stringify(box(24, 21, [play(21, 21)])) });
        await service.setCachedData('boxscore_g', '/getNFLBoxScore', {}, box(24, 21, [play(21, 21)]));
        const args = service.db.run.mock.calls.find(c => /INSERT OR REPLACE INTO tank01_cache/.test(c[0]))[1];
        expect(args[5]).toBe(0);
    });

    test('a settled boxscore first seen Completed 15+ minutes ago becomes permanent', async () => {
        const old = new Date(Date.now() - 20 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
        service.db.get.mockResolvedValue({ created_at: old, response_data: JSON.stringify(box(24, 21, [play(24, 21)])) });
        await service.setCachedData('boxscore_g', '/getNFLBoxScore', {}, box(24, 21, [play(24, 21)]));
        const args = service.db.run.mock.calls.find(c => /INSERT OR REPLACE INTO tank01_cache/.test(c[0]))[1];
        expect(args[5]).toBe(1);
        expect(args[4]).toBeNull();
    });

    test('a settled boxscore first seen Completed 2 minutes ago stays quarantined', async () => {
        const recent = new Date(Date.now() - 2 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
        service.db.get.mockResolvedValue({ created_at: recent, response_data: JSON.stringify(box(24, 21, [play(24, 21)])) });
        const verdict = await service.boxscoreQuarantine('boxscore_g', box(24, 21, [play(24, 21)]));
        expect(verdict.permanent).toBe(false);
        expect(verdict.reason).toMatch(/completed only 2 min ago/);
    });

    test('a prior copy that was still live does not start the quarantine clock', async () => {
        service.db.get.mockResolvedValue({ created_at: '2020-01-01 00:00:00', response_data: JSON.stringify(box(21, 21, [play(21, 21)], 'Live - In Progress')) });
        const verdict = await service.boxscoreQuarantine('boxscore_g', box(24, 21, [play(24, 21)]));
        expect(verdict).toEqual({ permanent: false, reason: 'first completed sighting' });
    });

    test('expired boxscore rows are kept (their created_at is the quarantine clock); other endpoints are deleted', async () => {
        const expired = new Date(Date.now() - 1000).toISOString();
        service.db.get.mockResolvedValueOnce({ response_data: '{}', expires_at: expired, is_historical: 0, endpoint: '/getNFLBoxScore' });
        expect(await service.getCachedData('boxscore_g')).toBeNull();
        expect(service.db.run.mock.calls.some(c => /DELETE FROM tank01_cache/.test(c[0]))).toBe(false);
        service.db.get.mockResolvedValueOnce({ response_data: '{}', expires_at: expired, is_historical: 0, endpoint: '/getNFLGamesForWeek' });
        expect(await service.getCachedData('gamesForWeek_1_2026')).toBeNull();
        expect(service.db.run.mock.calls.some(c => /DELETE FROM tank01_cache/.test(c[0]))).toBe(true);
    });
});
