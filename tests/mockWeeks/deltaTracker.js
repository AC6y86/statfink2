/**
 * Delta Tracking Module for Mock Testing
 * Monitors and tracks all stat changes with precise timing for testing the 30-second delta display feature
 */

class DeltaTracker {
  constructor() {
    this.deltaHistory = [];
    this.activeDeltas = new Map();
    this.playerBaselines = new Map();
    this.teamBaselines = new Map();
    this.startTime = Date.now();
    this.deltaExpirationTime = 30000; // 30 seconds in milliseconds
    this.timeOffset = 0; // For simulating time passing in tests
  }

  /**
   * Reset all tracking data
   */
  reset() {
    this.deltaHistory = [];
    this.activeDeltas.clear();
    this.playerBaselines.clear();
    this.teamBaselines.clear();
    this.startTime = Date.now();
    this.timeOffset = 0;
  }

  /**
   * Get current time (with test offset if applicable)
   */
  getNow() {
    return Date.now() + this.timeOffset;
  }

  /**
   * Set baseline stats for a player
   */
  setPlayerBaseline(playerId, stats) {
    this.playerBaselines.set(playerId, {
      stats: JSON.parse(JSON.stringify(stats)),
      timestamp: this.getNow()
    });
  }

  /**
   * Set baseline score for a team
   */
  setTeamBaseline(matchupId, team, score) {
    const key = `${matchupId}_${team}`;
    this.teamBaselines.set(key, {
      score: score,
      timestamp: this.getNow()
    });
  }

  /**
   * Update player stats and calculate delta
   */
  updatePlayerStats(playerId, newStats, playerName = null) {
    const baseline = this.playerBaselines.get(playerId);
    if (!baseline) {
      // First time seeing this player, set baseline
      this.setPlayerBaseline(playerId, newStats);
      return null;
    }

    const changedStats = [];
    const oldFantasyPoints = baseline.stats.fantasy_points || 0;
    const newFantasyPoints = newStats.fantasy_points || 0;
    const pointsDelta = newFantasyPoints - oldFantasyPoints;

    // Check each stat for changes
    Object.keys(newStats).forEach(stat => {
      const oldValue = baseline.stats[stat];
      const newValue = newStats[stat];
      
      if (oldValue !== newValue) {
        changedStats.push({
          stat: stat,
          oldValue: oldValue,
          newValue: newValue,
          delta: newValue - (oldValue || 0)
        });
      }
    });

    if (changedStats.length > 0 || Math.abs(pointsDelta) > 0.01) {
      const now = this.getNow();
      const deltaEntry = {
        type: 'player',
        playerId: playerId,
        playerName: playerName,
        timestamp: now,
        expiresAt: now + this.deltaExpirationTime,
        pointsDelta: pointsDelta,
        changedStats: changedStats,
        oldStats: baseline.stats,
        newStats: newStats
      };

      // Store in active deltas
      this.activeDeltas.set(`player_${playerId}`, deltaEntry);
      
      // Add to history
      this.deltaHistory.push(deltaEntry);

      // Update baseline for next comparison
      this.setPlayerBaseline(playerId, newStats);

      return deltaEntry;
    }

    return null;
  }

  /**
   * Update team score and calculate delta
   */
  updateTeamScore(matchupId, team, newScore, teamName = null) {
    const key = `${matchupId}_${team}`;
    const baseline = this.teamBaselines.get(key);
    
    if (!baseline) {
      // First time seeing this team, set baseline
      this.setTeamBaseline(matchupId, team, newScore);
      return null;
    }

    const scoreDelta = newScore - baseline.score;
    
    if (Math.abs(scoreDelta) > 0.01) {
      const now = this.getNow();
      const deltaEntry = {
        type: 'team',
        matchupId: matchupId,
        team: team,
        teamName: teamName,
        timestamp: now,
        expiresAt: now + this.deltaExpirationTime,
        scoreDelta: scoreDelta,
        oldScore: baseline.score,
        newScore: newScore
      };

      // Store in active deltas
      this.activeDeltas.set(key, deltaEntry);
      
      // Add to history
      this.deltaHistory.push(deltaEntry);

      // Update baseline
      this.setTeamBaseline(matchupId, team, newScore);

      return deltaEntry;
    }

    return null;
  }

  /**
   * Get all currently active deltas (not expired)
   */
  getActiveDeltas() {
    const now = this.getNow();
    const active = [];

    this.activeDeltas.forEach((delta, key) => {
      if (delta.expiresAt > now) {
        active.push({
          ...delta,
          remainingTime: Math.ceil((delta.expiresAt - now) / 1000) // seconds remaining
        });
      }
      // Don't remove expired deltas here - let cleanupExpired handle that
    });

    return active;
  }

  /**
   * Get deltas that should be visible at a specific time
   */
  getDeltasAtTime(timestamp) {
    return this.deltaHistory.filter(delta => 
      delta.timestamp <= timestamp && delta.expiresAt > timestamp
    );
  }

  /**
   * Clean up expired deltas
   */
  cleanupExpired() {
    const now = this.getNow();
    const expired = [];

    this.activeDeltas.forEach((delta, key) => {
      if (delta.expiresAt <= now) {
        expired.push(delta);
        this.activeDeltas.delete(key);
      }
    });

    return expired;
  }

  /**
   * Get delta timeline for visualization
   */
  getDeltaTimeline() {
    return this.deltaHistory.map(delta => ({
      type: delta.type,
      id: delta.playerId || `${delta.matchupId}_${delta.team}`,
      name: delta.playerName || delta.teamName,
      setTime: delta.timestamp - this.startTime,
      expireTime: delta.expiresAt - this.startTime,
      value: delta.pointsDelta || delta.scoreDelta,
      changedStats: delta.changedStats?.map(s => s.stat)
    }));
  }

  /**
   * Export current state for debugging
   */
  exportState() {
    const now = this.getNow();
    return {
      startTime: this.startTime,
      currentTime: now,
      elapsed: now - this.startTime,
      activeDeltas: Array.from(this.activeDeltas.entries()),
      playerBaselines: Array.from(this.playerBaselines.entries()),
      teamBaselines: Array.from(this.teamBaselines.entries()),
      historyCount: this.deltaHistory.length,
      timeline: this.getDeltaTimeline()
    };
  }

  /**
   * Import state for reproduction
   */
  importState(state) {
    this.startTime = state.startTime;
    this.activeDeltas = new Map(state.activeDeltas);
    this.playerBaselines = new Map(state.playerBaselines);
    this.teamBaselines = new Map(state.teamBaselines);
    // Reconstruct history from timeline if needed
  }

  /**
   * Simulate time passing (for testing)
   */
  simulateTimePass(seconds) {
    const milliseconds = seconds * 1000;

    // Move time forward by adjusting the offset
    this.timeOffset += milliseconds;

    // Don't automatically cleanup - let the test decide when to cleanup
    // This allows tests to check the state before and after cleanup
  }

  /**
   * Get statistics about delta activity
   */
  getStats() {
    const now = this.getNow();
    const activeCount = this.getActiveDeltas().length;
    const totalCreated = this.deltaHistory.length;
    const expiredCount = totalCreated - activeCount;

    // Calculate average delta lifetime
    const completedDeltas = this.deltaHistory.filter(d => d.expiresAt <= now);
    const avgLifetime = completedDeltas.length > 0
      ? completedDeltas.reduce((sum, d) => sum + (d.expiresAt - d.timestamp), 0) / completedDeltas.length / 1000
      : 0;

    return {
      activeCount,
      totalCreated,
      expiredCount,
      avgLifetimeSeconds: avgLifetime,
      runningTimeSeconds: (now - this.startTime) / 1000
    };
  }
}

// Singleton instance for testing
let globalDeltaTracker = null;

/**
 * Get or create the global delta tracker instance
 */
function getDeltaTracker() {
  if (!globalDeltaTracker) {
    globalDeltaTracker = new DeltaTracker();
  }
  return globalDeltaTracker;
}

/**
 * Reset the global delta tracker
 */
function resetDeltaTracker() {
  if (globalDeltaTracker) {
    globalDeltaTracker.reset();
  } else {
    globalDeltaTracker = new DeltaTracker();
  }
  return globalDeltaTracker;
}

module.exports = {
  DeltaTracker,
  getDeltaTracker,
  resetDeltaTracker
};