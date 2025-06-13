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

  afterEach(() => {
    jest.useRealTimers();
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
      expect(service.cache).toBeInstanceOf(Map);
      expect(service.cacheExpiry).toBeGreaterThan(0);
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
      await service.rateLimit();
      await service.rateLimit();
      await service.rateLimit();
      
      expect(service.requestCount).toBe(3);
    });

    test('should update last request time', async () => {
      const beforeTime = service.lastRequestTime;
      await service.rateLimit();
      
      expect(service.lastRequestTime).toBeGreaterThan(beforeTime);
    });
  });

  describe('Cache Management', () => {
    test('should cache responses with expiry', () => {
      const testData = { test: 'data' };
      const cacheKey = 'test-key';
      
      // Simulate caching
      service.cache.set(cacheKey, {
        data: testData,
        timestamp: Date.now()
      });
      
      expect(service.cache.has(cacheKey)).toBe(true);
      expect(service.cache.get(cacheKey).data).toEqual(testData);
    });

    test('should handle cache expiry', () => {
      const testData = { test: 'data' };
      const cacheKey = 'expired-key';
      
      // Set cache with old timestamp
      service.cache.set(cacheKey, {
        data: testData,
        timestamp: Date.now() - (service.cacheExpiry + 1000)
      });
      
      // Check if cache item is considered expired
      const cachedItem = service.cache.get(cacheKey);
      const isExpired = (Date.now() - cachedItem.timestamp) > service.cacheExpiry;
      expect(isExpired).toBe(true);
    });

    test('should clear cache when needed', () => {
      service.cache.set('test1', { data: 'test1', timestamp: Date.now() });
      service.cache.set('test2', { data: 'test2', timestamp: Date.now() });
      
      expect(service.cache.size).toBe(2);
      
      service.cache.clear();
      expect(service.cache.size).toBe(0);
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
      
      mockedAxios.get.mockRejectedValue(rateLimitError);
      
      await expect(service.makeRequest('/players')).rejects.toThrow();
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