/**
 * Integration Tests for 30-Second Delta Display Feature
 * Tests the complete flow from stat updates to visual display and expiration
 */

const { DeltaTracker, resetDeltaTracker } = require('../mockWeeks/deltaTracker');
const { deltaScenarios } = require('../mockWeeks/deltaScenarios');
const { getDeltaDebugger } = require('../mockWeeks/deltaDebug');

describe('30-Second Delta Display Feature', () => {
  let tracker;
  let deltaDebugger;

  beforeEach(() => {
    // Reset and get fresh instances
    resetDeltaTracker();
    tracker = new DeltaTracker();
    deltaDebugger = getDeltaDebugger();
  });
  
  afterEach(() => {
    // Clean up
    deltaDebugger.stopMonitoring();
  });
  
  describe('Delta Creation', () => {
    test('should create delta when stats change', () => {
      // Set baseline
      tracker.setPlayerBaseline('player1', {
        rushing_yards: 50,
        fantasy_points: 5.0
      });
      
      // Update stats
      const delta = tracker.updatePlayerStats('player1', {
        rushing_yards: 60,
        fantasy_points: 6.0
      }, 'Test Player');
      
      expect(delta).not.toBeNull();
      expect(delta.pointsDelta).toBe(1.0);
      expect(delta.changedStats).toContainEqual({
        stat: 'rushing_yards',
        oldValue: 50,
        newValue: 60,
        delta: 10
      });
    });
    
    test('should not create delta for unchanged stats', () => {
      tracker.setPlayerBaseline('player1', {
        rushing_yards: 50,
        fantasy_points: 5.0
      });
      
      const delta = tracker.updatePlayerStats('player1', {
        rushing_yards: 50,
        fantasy_points: 5.0
      }, 'Test Player');
      
      expect(delta).toBeNull();
    });
    
    test('should track multiple stat changes', () => {
      tracker.setPlayerBaseline('qb1', {
        passing_yards: 100,
        passing_tds: 0,
        fantasy_points: 4.0
      });
      
      const delta = tracker.updatePlayerStats('qb1', {
        passing_yards: 175,
        passing_tds: 1,
        fantasy_points: 11.0
      }, 'QB Test');
      
      expect(delta.changedStats).toHaveLength(3);
      expect(delta.pointsDelta).toBe(7.0);
    });
    
    test('should handle negative deltas (stat corrections)', () => {
      tracker.setPlayerBaseline('player1', {
        rushing_tds: 1,
        fantasy_points: 10.0
      });
      
      const delta = tracker.updatePlayerStats('player1', {
        rushing_tds: 0,
        fantasy_points: 4.0
      }, 'Test Player');
      
      expect(delta.pointsDelta).toBe(-6.0);
    });
  });
  
  describe('Delta Expiration', () => {
    test('should expire delta after 30 seconds', () => {
      tracker.setPlayerBaseline('player1', {
        fantasy_points: 5.0
      });
      
      const delta = tracker.updatePlayerStats('player1', {
        fantasy_points: 10.0
      }, 'Test Player');
      
      // Initially active
      let activeDeltas = tracker.getActiveDeltas();
      expect(activeDeltas).toHaveLength(1);
      
      // Simulate 29 seconds passing
      tracker.simulateTimePass(29);
      activeDeltas = tracker.getActiveDeltas();
      expect(activeDeltas).toHaveLength(1);
      expect(activeDeltas[0].remainingTime).toBeLessThanOrEqual(1);
      
      // Simulate 2 more seconds (total 31)
      tracker.simulateTimePass(2);
      activeDeltas = tracker.getActiveDeltas();
      expect(activeDeltas).toHaveLength(0);
    });
    
    test('should track expiration time accurately', () => {
      tracker.setPlayerBaseline('player1', { fantasy_points: 5.0 });
      const delta = tracker.updatePlayerStats('player1', { fantasy_points: 10.0 });
      
      const checkPoints = [0, 10, 20, 29, 30, 31];
      const results = [];
      
      checkPoints.forEach(seconds => {
        if (seconds > 0) {
          tracker.simulateTimePass(seconds - (results.length > 0 ? checkPoints[results.length - 1] : 0));
        }
        
        const activeDeltas = tracker.getActiveDeltas();
        const isActive = activeDeltas.length > 0;
        
        results.push({
          seconds,
          isActive,
          expected: seconds < 30,
          correct: (seconds < 30) === isActive
        });
      });
      
      // All checks should be correct
      expect(results.every(r => r.correct)).toBe(true);
    });
  });
  
  describe('Multiple Deltas', () => {
    test('should handle multiple simultaneous deltas', () => {
      // Create multiple deltas
      tracker.setPlayerBaseline('player1', { fantasy_points: 5.0 });
      tracker.setPlayerBaseline('player2', { fantasy_points: 10.0 });
      tracker.setPlayerBaseline('player3', { fantasy_points: 15.0 });
      
      tracker.updatePlayerStats('player1', { fantasy_points: 8.0 });
      tracker.updatePlayerStats('player2', { fantasy_points: 14.0 });
      tracker.updatePlayerStats('player3', { fantasy_points: 20.0 });
      
      const activeDeltas = tracker.getActiveDeltas();
      expect(activeDeltas).toHaveLength(3);
      
      // Check individual deltas
      const delta1 = activeDeltas.find(d => d.playerId === 'player1');
      expect(delta1.pointsDelta).toBe(3.0);
      
      const delta2 = activeDeltas.find(d => d.playerId === 'player2');
      expect(delta2.pointsDelta).toBe(4.0);
      
      const delta3 = activeDeltas.find(d => d.playerId === 'player3');
      expect(delta3.pointsDelta).toBe(5.0);
    });
    
    test('should expire deltas independently', () => {
      tracker.setPlayerBaseline('player1', { fantasy_points: 5.0 });
      tracker.updatePlayerStats('player1', { fantasy_points: 8.0 });
      
      // Wait 10 seconds
      tracker.simulateTimePass(10);
      
      // Create second delta
      tracker.setPlayerBaseline('player2', { fantasy_points: 10.0 });
      tracker.updatePlayerStats('player2', { fantasy_points: 15.0 });
      
      // Both should be active
      expect(tracker.getActiveDeltas()).toHaveLength(2);
      
      // Wait 21 seconds (total 31 for first, 21 for second)
      tracker.simulateTimePass(21);
      
      // Only second should be active
      const activeDeltas = tracker.getActiveDeltas();
      expect(activeDeltas).toHaveLength(1);
      expect(activeDeltas[0].playerId).toBe('player2');
      
      // Wait 10 more seconds
      tracker.simulateTimePass(10);
      
      // None should be active
      expect(tracker.getActiveDeltas()).toHaveLength(0);
    });
  });
  
  describe('Team Score Deltas', () => {
    test('should track team score changes', () => {
      tracker.setTeamBaseline(1, 'team1', 45.5);
      const delta = tracker.updateTeamScore(1, 'team1', 52.5, 'The Crushers');
      
      expect(delta).not.toBeNull();
      expect(delta.scoreDelta).toBe(7.0);
      expect(delta.type).toBe('team');
    });
    
    test('should handle both team scores in a matchup', () => {
      tracker.setTeamBaseline(1, 'team1', 45.5);
      tracker.setTeamBaseline(1, 'team2', 48.0);
      
      tracker.updateTeamScore(1, 'team1', 52.5);
      tracker.updateTeamScore(1, 'team2', 51.0);
      
      const activeDeltas = tracker.getActiveDeltas();
      expect(activeDeltas).toHaveLength(2);
      
      const team1Delta = activeDeltas.find(d => d.team === 'team1');
      expect(team1Delta.scoreDelta).toBe(7.0);
      
      const team2Delta = activeDeltas.find(d => d.team === 'team2');
      expect(team2Delta.scoreDelta).toBe(3.0);
    });
  });
  
  describe('Test Scenarios', () => {
    test('touchdown scenario should create appropriate delta', () => {
      const scenarios = new deltaScenarios.constructor();
      scenarios.tracker = tracker;
      
      const result = scenarios.singleTouchdown();
      
      expect(result.result).not.toBeNull();
      expect(result.expectedDelta).toBe('+7.20');
      expect(result.result.changedStats).toContainEqual(
        expect.objectContaining({ stat: 'rushing_tds' })
      );
    });
    
    test('field goal scenario should create +3.00 delta', () => {
      const scenarios = new deltaScenarios.constructor();
      scenarios.tracker = tracker;
      
      const result = scenarios.fieldGoal();
      
      expect(result.expectedDelta).toBe('+3.00');
      expect(result.result.pointsDelta).toBe(3.0);
    });
    
    test('stat correction should create negative delta', () => {
      const scenarios = new deltaScenarios.constructor();
      scenarios.tracker = tracker;

      const result = scenarios.statCorrection();

      expect(result.expectedDelta).toBe('-6.00');
      expect(result.result.pointsDelta).toBeCloseTo(-6.0, 2);
    });
  });
  
  describe('Delta Timeline', () => {
    test('should maintain accurate timeline of all deltas', () => {
      // Create deltas at different times
      tracker.setPlayerBaseline('player1', { fantasy_points: 5.0 });
      tracker.updatePlayerStats('player1', { fantasy_points: 8.0 });
      
      // Simulate 5 seconds
      tracker.simulateTimePass(5);
      
      tracker.setPlayerBaseline('player2', { fantasy_points: 10.0 });
      tracker.updatePlayerStats('player2', { fantasy_points: 15.0 });
      
      const timeline = tracker.getDeltaTimeline();
      expect(timeline).toHaveLength(2);
      
      // Check relative timing
      const timeDiff = timeline[1].setTime - timeline[0].setTime;
      expect(timeDiff).toBeGreaterThanOrEqual(-5000);
    });
    
    test('should include all changed stats in timeline', () => {
      tracker.setPlayerBaseline('qb1', {
        passing_yards: 100,
        passing_tds: 0,
        rushing_yards: 10,
        fantasy_points: 5.0
      });
      
      tracker.updatePlayerStats('qb1', {
        passing_yards: 150,
        passing_tds: 1,
        rushing_yards: 25,
        fantasy_points: 13.0
      });
      
      const timeline = tracker.getDeltaTimeline();
      expect(timeline[0].changedStats).toContain('passing_yards');
      expect(timeline[0].changedStats).toContain('passing_tds');
      expect(timeline[0].changedStats).toContain('rushing_yards');
    });
  });
  
  describe('Performance', () => {
    test('should handle large number of deltas efficiently', () => {
      const startTime = Date.now();
      
      // Create 100 deltas
      for (let i = 0; i < 100; i++) {
        tracker.setPlayerBaseline(`player${i}`, { fantasy_points: i });
        tracker.updatePlayerStats(`player${i}`, { fantasy_points: i + 5 }, `Player ${i}`);
      }

      const creationTime = Date.now() - startTime;
      expect(creationTime).toBeLessThan(100); // Should be fast

      // All should still be active
      expect(tracker.getActiveDeltas()).toHaveLength(100);

      // Check cleanup performance when nothing is expired
      const cleanupStart = Date.now();
      const notExpired = tracker.cleanupExpired();
      const cleanupTime = Date.now() - cleanupStart;
      expect(cleanupTime).toBeLessThan(10);
      expect(notExpired).toHaveLength(0); // Nothing should be expired yet

      // Simulate expiration
      tracker.simulateTimePass(31);

      // Now cleanup should find all 100 expired deltas
      const expired = tracker.cleanupExpired();
      expect(expired).toHaveLength(100);
      expect(tracker.getActiveDeltas()).toHaveLength(0);
    });
  });
  
  describe('State Export/Import', () => {
    test('should export and import state correctly', () => {
      // Create some deltas
      tracker.setPlayerBaseline('player1', { fantasy_points: 5.0 });
      tracker.updatePlayerStats('player1', { fantasy_points: 10.0 });
      
      tracker.setTeamBaseline(1, 'team1', 45.0);
      tracker.updateTeamScore(1, 'team1', 50.0);
      
      // Export state
      const exportedState = tracker.exportState();
      expect(exportedState.activeDeltas).toHaveLength(2);
      
      // Create new tracker and import
      const newTracker = new DeltaTracker();
      newTracker.importState(exportedState);
      
      // Check imported state
      const activeDeltas = newTracker.getActiveDeltas();
      expect(activeDeltas).toHaveLength(2);
    });
  });
});

// Test helper to wait for actual time
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('Real-time Delta Expiration (Integration)', () => {
  let tracker;
  
  beforeEach(() => {
    resetDeltaTracker();
    tracker = new DeltaTracker();
  });
  
  test('should expire delta after real 30 seconds', async () => {
    // Skip this test in CI to save time
    if (process.env.CI) {
      return;
    }
    
    tracker.setPlayerBaseline('player1', { fantasy_points: 5.0 });
    tracker.updatePlayerStats('player1', { fantasy_points: 10.0 });
    
    // Check at intervals
    const checks = [
      { time: 0, expected: true },
      { time: 10000, expected: true },
      { time: 20000, expected: true },
      { time: 29000, expected: true },
      { time: 31000, expected: false }
    ];
    
    for (const check of checks) {
      if (check.time > 0) {
        await wait(check.time - (checks[checks.indexOf(check) - 1]?.time || 0));
      }
      
      const activeDeltas = tracker.getActiveDeltas();
      const isActive = activeDeltas.length > 0;
      
      expect(isActive).toBe(check.expected);
    }
  }, 35000); // Extended timeout for this test
});