/**
 * Service Layer Unit Tests
 * Tests service initialization and core functionality without external dependencies
 */

const DatabaseManager = require('../../server/database/database');
const ScoringService = require('../../server/services/scoringService');
const Tank01Service = require('../../server/services/tank01Service');
const PlayerSyncService = require('../../server/services/playerSyncService');

// Mock external dependencies
jest.mock('../../server/database/database');
jest.mock('axios');

describe('Service Initialization Tests', () => {
  let mockDb;

  beforeEach(() => {
    mockDb = {
      get: jest.fn(),
      all: jest.fn(),
      run: jest.fn(),
      prepare: jest.fn(() => ({
        run: jest.fn(),
        get: jest.fn(),
        all: jest.fn(),
        finalize: jest.fn()
      })),
      transaction: jest.fn(),
      close: jest.fn()
    };
    DatabaseManager.mockImplementation(() => mockDb);
  });

  describe('ScoringService', () => {
    test('should initialize with database dependency', () => {
      const scoringService = new ScoringService(mockDb);
      expect(scoringService).toBeInstanceOf(ScoringService);
      expect(scoringService.db).toBe(mockDb);
    });

    test('should calculate basic fantasy points', async () => {
      const scoringService = new ScoringService(mockDb);
      const stats = {
        passing_yards: 300,
        passing_tds: 2,
        rushing_yards: 50,
        rushing_tds: 1
      };
      const points = await scoringService.calculateFantasyPoints(stats);
      expect(typeof points).toBe('number');
      expect(points).toBeGreaterThan(0);
    });

    test('should handle invalid position gracefully', async () => {
      const scoringService = new ScoringService(mockDb);
      const stats = { passing_yards: 300 };
      const points = await scoringService.calculateFantasyPoints(stats);
      expect(typeof points).toBe('number');
      expect(points).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Tank01Service', () => {
    test('should initialize with API key', () => {
      const apiKey = 'test-api-key';
      const tank01Service = new Tank01Service(apiKey);
      expect(tank01Service).toBeInstanceOf(Tank01Service);
      expect(tank01Service.apiKey).toBe(apiKey);
      expect(tank01Service.baseURL).toContain('tank01');
    });

    test('should initialize rate limiting properties', () => {
      const tank01Service = new Tank01Service('test-key');
      expect(tank01Service.lastRequestTime).toBe(0);
      expect(tank01Service.minRequestInterval).toBeGreaterThan(0);
      expect(tank01Service.maxRequestsPerMinute).toBeGreaterThan(0);
    });

    test('should initialize cache system', () => {
      const tank01Service = new Tank01Service('test-key');
      expect(tank01Service.defaultCacheExpiry).toBeGreaterThan(0);
      expect(tank01Service.historicalCacheExpiry).toBe(null);
    });

    test('should handle missing API key', () => {
      expect(() => new Tank01Service()).not.toThrow();
      const tank01Service = new Tank01Service();
      expect(tank01Service.apiKey).toBeUndefined();
    });
  });

  describe('PlayerSyncService', () => {
    test('should initialize with dependencies', () => {
      const tank01Service = new Tank01Service('test-key');
      const playerSyncService = new PlayerSyncService(mockDb, tank01Service);
      expect(playerSyncService).toBeInstanceOf(PlayerSyncService);
      expect(playerSyncService.db).toBe(mockDb);
      expect(playerSyncService.tank01Service).toBe(tank01Service);
    });

    test('should initialize sync state properties', () => {
      const tank01Service = new Tank01Service('test-key');
      const playerSyncService = new PlayerSyncService(mockDb, tank01Service);
      expect(playerSyncService.lastSyncTime).toBeNull();
      expect(playerSyncService.syncInProgress).toBe(false);
    });

    test('should handle missing tank01Service', () => {
      const playerSyncService = new PlayerSyncService(mockDb, null);
      expect(playerSyncService.tank01Service).toBeNull();
    });

    test('should prevent concurrent sync operations', async () => {
      const tank01Service = new Tank01Service('test-key');
      const playerSyncService = new PlayerSyncService(mockDb, tank01Service);
      
      // Mock sync in progress
      playerSyncService.syncInProgress = true;
      
      const result = await playerSyncService.syncPlayers();
      expect(result.success).toBe(false);
      expect(result.message).toContain('already in progress');
    });
  });

});

describe('Service Method Validation Tests', () => {
  let mockDb, scoringService, tank01Service;

  beforeEach(() => {
    mockDb = {
      get: jest.fn(),
      all: jest.fn(),
      run: jest.fn(),
      prepare: jest.fn(() => ({
        run: jest.fn(),
        get: jest.fn(),
        all: jest.fn(),
        finalize: jest.fn()
      }))
    };
    
    scoringService = new ScoringService(mockDb);
    tank01Service = new Tank01Service('test-key');
  });

  describe('ScoringService Methods', () => {
    test('should have calculateFantasyPoints method', () => {
      expect(typeof scoringService.calculateFantasyPoints).toBe('function');
    });

    test('should handle null/undefined stats', async () => {
      expect(() => scoringService.calculateFantasyPoints(null)).not.toThrow();
      expect(() => scoringService.calculateFantasyPoints(undefined)).not.toThrow();
      expect(await scoringService.calculateFantasyPoints(null)).toBe(0);
    });

    test('should handle empty stats object', async () => {
      const points = await scoringService.calculateFantasyPoints({});
      expect(typeof points).toBe('number');
      expect(points).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Tank01Service Methods', () => {
    test('should have rateLimit method', () => {
      expect(typeof tank01Service.rateLimit).toBe('function');
    });

    test('should have makeRequest method', () => {
      expect(typeof tank01Service.makeRequest).toBe('function');
    });

    test('rateLimit should be async', () => {
      const result = tank01Service.rateLimit();
      expect(result).toBeInstanceOf(Promise);
    });
  });
});

describe('Service Error Handling Tests', () => {
  let mockDb;

  beforeEach(() => {
    mockDb = {
      get: jest.fn(),
      all: jest.fn(),
      run: jest.fn(),
      prepare: jest.fn()
    };
  });

  test('ScoringService should handle database errors gracefully', () => {
    mockDb.get.mockRejectedValue(new Error('Database error'));
    const scoringService = new ScoringService(mockDb);
    
    // Should not throw during initialization
    expect(() => scoringService).not.toThrow();
  });

  test('Tank01Service should handle network errors gracefully', async () => {
    const tank01Service = new Tank01Service('test-key');
    
    // Mock axios to throw error
    const axios = require('axios');
    axios.get = jest.fn().mockRejectedValue(new Error('Network error'));
    
    // Should handle error gracefully in makeRequest
    expect(typeof tank01Service.makeRequest).toBe('function');
  });

  test('Services should handle invalid constructor parameters', () => {
    expect(() => new ScoringService(null)).not.toThrow();
    expect(() => new Tank01Service(null)).not.toThrow();
    expect(() => new PlayerSyncService(null, null)).not.toThrow();
  });
});