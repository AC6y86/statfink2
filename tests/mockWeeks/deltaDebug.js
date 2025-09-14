/**
 * Delta Debug Utilities
 * Tools for debugging and analyzing the 30-second delta display feature
 */

const { getDeltaTracker, resetDeltaTracker } = require('./deltaTracker');
const fs = require('fs');
const path = require('path');

class DeltaDebugger {
  constructor() {
    this.tracker = getDeltaTracker();
    this.logFile = path.join(__dirname, '../../logs/delta-debug.log');
    this.snapshotDir = path.join(__dirname, '../../logs/delta-snapshots');
    
    // Ensure directories exist
    this.ensureDirectories();
  }

  ensureDirectories() {
    const logsDir = path.dirname(this.logFile);
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    if (!fs.existsSync(this.snapshotDir)) {
      fs.mkdirSync(this.snapshotDir, { recursive: true });
    }
  }

  /**
   * Log a debug message with timestamp
   */
  log(message, data = null) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      message,
      data,
      activeDeltas: this.tracker.getActiveDeltas().length,
      runtime: (Date.now() - this.tracker.startTime) / 1000
    };
    
    // Console output
    console.log(`[Delta Debug ${timestamp}] ${message}`);
    if (data) {
      console.log(JSON.stringify(data, null, 2));
    }
    
    // File output
    const logLine = JSON.stringify(logEntry) + '\n';
    fs.appendFileSync(this.logFile, logLine);
  }

  /**
   * Take a snapshot of current delta state
   */
  takeSnapshot(label = 'manual') {
    const snapshot = {
      label,
      timestamp: new Date().toISOString(),
      state: this.tracker.exportState(),
      activeDeltas: this.tracker.getActiveDeltas(),
      stats: this.tracker.getStats(),
      timeline: this.tracker.getDeltaTimeline()
    };
    
    const filename = `snapshot-${label}-${Date.now()}.json`;
    const filepath = path.join(this.snapshotDir, filename);
    
    fs.writeFileSync(filepath, JSON.stringify(snapshot, null, 2));
    this.log(`Snapshot saved: ${filename}`);
    
    return filepath;
  }

  /**
   * Load and replay a snapshot
   */
  loadSnapshot(filename) {
    const filepath = path.join(this.snapshotDir, filename);
    
    if (!fs.existsSync(filepath)) {
      throw new Error(`Snapshot not found: ${filename}`);
    }
    
    const snapshot = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    this.tracker.importState(snapshot.state);
    
    this.log(`Snapshot loaded: ${filename}`, {
      label: snapshot.label,
      originalTime: snapshot.timestamp,
      activeDeltasCount: snapshot.activeDeltas.length
    });
    
    return snapshot;
  }

  /**
   * Monitor delta changes in real-time
   */
  startMonitoring(interval = 1000) {
    this.log('Starting delta monitoring...');
    
    let previousCount = 0;
    let previousDeltas = new Map();
    
    this.monitorInterval = setInterval(() => {
      const activeDeltas = this.tracker.getActiveDeltas();
      const currentCount = activeDeltas.length;
      
      // Check for new deltas
      activeDeltas.forEach(delta => {
        const key = delta.playerId || `${delta.matchupId}_${delta.team}`;
        if (!previousDeltas.has(key)) {
          this.log('New delta created', {
            type: delta.type,
            id: key,
            value: delta.pointsDelta || delta.scoreDelta,
            remainingTime: delta.remainingTime
          });
        }
      });
      
      // Check for expired deltas
      previousDeltas.forEach((delta, key) => {
        const stillActive = activeDeltas.some(d => 
          (d.playerId || `${d.matchupId}_${d.team}`) === key
        );
        if (!stillActive) {
          this.log('Delta expired', {
            type: delta.type,
            id: key,
            lifetime: 30 // Assuming 30-second lifetime
          });
        }
      });
      
      // Update tracking
      previousDeltas.clear();
      activeDeltas.forEach(delta => {
        const key = delta.playerId || `${delta.matchupId}_${delta.team}`;
        previousDeltas.set(key, delta);
      });
      
      // Log if count changed
      if (currentCount !== previousCount) {
        this.log(`Active delta count changed: ${previousCount} -> ${currentCount}`);
        previousCount = currentCount;
      }
    }, interval);
  }

  /**
   * Stop monitoring
   */
  stopMonitoring() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.log('Monitoring stopped');
    }
  }

  /**
   * Analyze delta patterns
   */
  analyzeDeltaPatterns() {
    const timeline = this.tracker.getDeltaTimeline();
    const stats = this.tracker.getStats();
    
    // Group deltas by type
    const byType = {
      player: timeline.filter(d => d.type === 'player'),
      team: timeline.filter(d => d.type === 'team')
    };
    
    // Calculate timing patterns
    const timingPatterns = timeline.map((delta, index) => {
      const next = timeline[index + 1];
      return {
        delta,
        timeToNext: next ? next.setTime - delta.setTime : null
      };
    });
    
    // Find rapid updates (within 5 seconds)
    const rapidUpdates = timingPatterns.filter(p => 
      p.timeToNext && p.timeToNext < 5000
    );
    
    // Find stat types that change most frequently
    const statFrequency = {};
    timeline.forEach(delta => {
      if (delta.changedStats) {
        delta.changedStats.forEach(stat => {
          statFrequency[stat] = (statFrequency[stat] || 0) + 1;
        });
      }
    });
    
    const analysis = {
      totalDeltas: timeline.length,
      byType,
      averageLifetime: stats.avgLifetimeSeconds,
      rapidUpdates: rapidUpdates.length,
      rapidUpdatePercentage: (rapidUpdates.length / timeline.length * 100).toFixed(1),
      mostFrequentStats: Object.entries(statFrequency)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5),
      runtime: stats.runningTimeSeconds
    };
    
    this.log('Delta pattern analysis', analysis);
    return analysis;
  }

  /**
   * Test delta expiration accuracy
   */
  async testExpirationAccuracy() {
    this.log('Testing delta expiration accuracy...');
    
    // Reset tracker
    resetDeltaTracker();
    const tracker = getDeltaTracker();
    
    // Create a test delta
    tracker.setPlayerBaseline('test_player', { fantasy_points: 10 });
    const delta = tracker.updatePlayerStats('test_player', { fantasy_points: 15 }, 'Test Player');
    
    const createdAt = Date.now();
    const results = [];
    
    // Check at specific intervals
    const checkPoints = [0, 10000, 20000, 29000, 29500, 29900, 30000, 30100, 30500, 31000];
    
    for (const delay of checkPoints) {
      await new Promise(resolve => setTimeout(resolve, delay - (results.length > 0 ? checkPoints[results.length - 1] : 0)));
      
      const elapsed = Date.now() - createdAt;
      const activeDeltas = tracker.getActiveDeltas();
      const isActive = activeDeltas.some(d => d.playerId === 'test_player');
      
      results.push({
        elapsed: elapsed / 1000,
        expected: elapsed < 30000,
        actual: isActive,
        correct: (elapsed < 30000) === isActive
      });
      
      this.log(`Expiration check at ${(elapsed/1000).toFixed(1)}s`, {
        expected: elapsed < 30000 ? 'active' : 'expired',
        actual: isActive ? 'active' : 'expired',
        correct: (elapsed < 30000) === isActive
      });
    }
    
    const accuracy = results.filter(r => r.correct).length / results.length * 100;
    
    this.log('Expiration accuracy test complete', {
      accuracy: `${accuracy.toFixed(1)}%`,
      results
    });
    
    return { accuracy, results };
  }

  /**
   * Generate performance report
   */
  generatePerformanceReport() {
    const stats = this.tracker.getStats();
    const activeDeltas = this.tracker.getActiveDeltas();
    const timeline = this.tracker.getDeltaTimeline();
    
    // Memory usage estimate
    const memoryUsage = {
      activeDeltas: JSON.stringify(activeDeltas).length,
      timeline: JSON.stringify(timeline).length,
      total: JSON.stringify(this.tracker.exportState()).length
    };
    
    // Processing time estimates
    const processingTimes = [];
    const startTime = Date.now();
    
    // Test cleanup performance
    for (let i = 0; i < 100; i++) {
      const cleanupStart = Date.now();
      this.tracker.cleanupExpired();
      processingTimes.push(Date.now() - cleanupStart);
    }
    
    const avgProcessingTime = processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length;
    
    const report = {
      timestamp: new Date().toISOString(),
      runtime: `${stats.runningTimeSeconds.toFixed(1)}s`,
      performance: {
        activeDeltaCount: activeDeltas.length,
        totalDeltasCreated: stats.totalCreated,
        avgLifetime: `${stats.avgLifetimeSeconds.toFixed(1)}s`,
        memoryUsage: {
          activeDeltas: `${(memoryUsage.activeDeltas / 1024).toFixed(2)} KB`,
          timeline: `${(memoryUsage.timeline / 1024).toFixed(2)} KB`,
          total: `${(memoryUsage.total / 1024).toFixed(2)} KB`
        },
        cleanupPerformance: {
          avgTime: `${avgProcessingTime.toFixed(3)}ms`,
          maxTime: `${Math.max(...processingTimes).toFixed(3)}ms`,
          minTime: `${Math.min(...processingTimes).toFixed(3)}ms`
        }
      }
    };
    
    this.log('Performance report generated', report);
    
    // Save to file
    const reportFile = path.join(this.snapshotDir, `performance-${Date.now()}.json`);
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    
    return report;
  }

  /**
   * Clear all debug data
   */
  clearDebugData() {
    // Clear log file
    if (fs.existsSync(this.logFile)) {
      fs.writeFileSync(this.logFile, '');
    }
    
    // Clear snapshots
    const snapshots = fs.readdirSync(this.snapshotDir);
    snapshots.forEach(file => {
      fs.unlinkSync(path.join(this.snapshotDir, file));
    });
    
    this.log('Debug data cleared');
  }

  /**
   * Get recent log entries
   */
  getRecentLogs(count = 50) {
    if (!fs.existsSync(this.logFile)) {
      return [];
    }
    
    const logs = fs.readFileSync(this.logFile, 'utf8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
    
    return logs.slice(-count);
  }

  /**
   * List available snapshots
   */
  listSnapshots() {
    const snapshots = fs.readdirSync(this.snapshotDir)
      .filter(file => file.endsWith('.json'))
      .map(file => {
        const filepath = path.join(this.snapshotDir, file);
        const stats = fs.statSync(filepath);
        const content = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        
        return {
          filename: file,
          label: content.label,
          timestamp: content.timestamp,
          size: `${(stats.size / 1024).toFixed(2)} KB`,
          activeDeltaCount: content.activeDeltas?.length || 0
        };
      })
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    return snapshots;
  }
}

// Create singleton instance
let debuggerInstance = null;

function getDeltaDebugger() {
  if (!debuggerInstance) {
    debuggerInstance = new DeltaDebugger();
  }
  return debuggerInstance;
}

// Console helper functions for manual testing
const debug = {
  log: (message, data) => getDeltaDebugger().log(message, data),
  snapshot: (label) => getDeltaDebugger().takeSnapshot(label),
  monitor: () => getDeltaDebugger().startMonitoring(),
  stopMonitor: () => getDeltaDebugger().stopMonitoring(),
  analyze: () => getDeltaDebugger().analyzeDeltaPatterns(),
  testExpiration: () => getDeltaDebugger().testExpirationAccuracy(),
  performance: () => getDeltaDebugger().generatePerformanceReport(),
  recent: (count) => getDeltaDebugger().getRecentLogs(count),
  snapshots: () => getDeltaDebugger().listSnapshots(),
  clear: () => getDeltaDebugger().clearDebugData()
};

module.exports = {
  DeltaDebugger,
  getDeltaDebugger,
  debug
};