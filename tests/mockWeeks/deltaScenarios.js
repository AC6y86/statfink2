/**
 * Delta Test Scenarios
 * Predefined scenarios for testing the 30-second delta display feature
 */

const { getDeltaTracker } = require('./deltaTracker');

class DeltaScenarios {
  constructor() {
    this.tracker = getDeltaTracker();
  }

  /**
   * Scenario 1: Single Touchdown
   * A running back scores a touchdown (6 points + stats update)
   */
  singleTouchdown(playerId = 'player_123', playerName = 'Derrick Henry') {
    // Initial stats
    this.tracker.setPlayerBaseline(playerId, {
      rushing_yards: 45,
      rushing_tds: 0,
      receptions: 1,
      receiving_yards: 8,
      fantasy_points: 5.3
    });

    // After touchdown
    const result = this.tracker.updatePlayerStats(playerId, {
      rushing_yards: 52,  // +7 yard TD run
      rushing_tds: 1,     // +1 TD
      receptions: 1,
      receiving_yards: 8,
      fantasy_points: 12.5 // +7.2 points (6 for TD + 0.7 for yards)
    }, playerName);

    return {
      scenario: 'Single Touchdown',
      description: `${playerName} scores a 7-yard rushing touchdown`,
      expectedDelta: '+7.20',
      expectedBoldStats: ['rushing_yards', 'rushing_tds', 'fantasy_points'],
      result
    };
  }

  /**
   * Scenario 2: Field Goal
   * Kicker makes a field goal
   */
  fieldGoal(playerId = 'kicker_456', playerName = 'Justin Tucker') {
    this.tracker.setPlayerBaseline(playerId, {
      field_goals_made: 1,
      field_goals_attempted: 1,
      extra_points_made: 2,
      extra_points_attempted: 2,
      fantasy_points: 5.0
    });

    const result = this.tracker.updatePlayerStats(playerId, {
      field_goals_made: 2,      // +1 FG
      field_goals_attempted: 2, // +1 attempt
      extra_points_made: 2,
      extra_points_attempted: 2,
      fantasy_points: 8.0       // +3 points for FG
    }, playerName);

    return {
      scenario: 'Field Goal',
      description: `${playerName} makes a 35-yard field goal`,
      expectedDelta: '+3.00',
      expectedBoldStats: ['field_goals_made', 'field_goals_attempted', 'fantasy_points'],
      result
    };
  }

  /**
   * Scenario 3: Multiple Simultaneous Updates
   * Team scores TD, multiple players get points
   */
  teamScores(matchupId = 1) {
    const updates = [];

    // QB throws TD
    this.tracker.setPlayerBaseline('qb_1', {
      passing_yards: 125,
      passing_tds: 0,
      fantasy_points: 5.0
    });
    updates.push(this.tracker.updatePlayerStats('qb_1', {
      passing_yards: 140,
      passing_tds: 1,
      fantasy_points: 10.6  // +5.6 (4 for TD + 0.6 for yards)
    }, 'Patrick Mahomes'));

    // WR catches TD
    this.tracker.setPlayerBaseline('wr_1', {
      receptions: 3,
      receiving_yards: 42,
      receiving_tds: 0,
      fantasy_points: 4.2
    });
    updates.push(this.tracker.updatePlayerStats('wr_1', {
      receptions: 4,
      receiving_yards: 57,
      receiving_tds: 1,
      fantasy_points: 11.7  // +7.5 (6 for TD + 1.5 for yards)
    }, 'Tyreek Hill'));

    // Team score updates
    this.tracker.setTeamBaseline(matchupId, 'team1', 45.5);
    updates.push(this.tracker.updateTeamScore(matchupId, 'team1', 58.6, 'The Crushers'));

    return {
      scenario: 'Team Scores Touchdown',
      description: 'QB throws 15-yard TD pass to WR',
      expectedDeltas: {
        qb: '+5.60',
        wr: '+7.50',
        team: '+13.10'
      },
      updates
    };
  }

  /**
   * Scenario 4: Stat Correction (Negative Delta)
   */
  statCorrection(playerId = 'rb_789', playerName = 'Christian McCaffrey') {
    this.tracker.setPlayerBaseline(playerId, {
      rushing_yards: 89,
      rushing_tds: 1,
      receptions: 5,
      receiving_yards: 45,
      fantasy_points: 19.4
    });

    // Stat correction - TD was actually incomplete
    const result = this.tracker.updatePlayerStats(playerId, {
      rushing_yards: 89,
      rushing_tds: 0,      // TD removed
      receptions: 5,
      receiving_yards: 45,
      fantasy_points: 13.4  // -6 points
    }, playerName);

    return {
      scenario: 'Stat Correction',
      description: `${playerName} TD overturned on review`,
      expectedDelta: '-6.00',
      expectedBoldStats: ['rushing_tds', 'fantasy_points'],
      result
    };
  }

  /**
   * Scenario 5: Rapid Sequential Updates
   * Multiple updates within a few seconds
   */
  async rapidUpdates(playerId = 'wr_555', playerName = 'Justin Jefferson') {
    const updates = [];

    // First catch
    this.tracker.setPlayerBaseline(playerId, {
      receptions: 2,
      receiving_yards: 28,
      fantasy_points: 2.8
    });

    updates.push({
      time: 0,
      update: this.tracker.updatePlayerStats(playerId, {
        receptions: 3,
        receiving_yards: 40,
        fantasy_points: 4.0
      }, playerName)
    });

    // Wait 2 seconds
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Second catch
    updates.push({
      time: 2,
      update: this.tracker.updatePlayerStats(playerId, {
        receptions: 4,
        receiving_yards: 65,
        fantasy_points: 6.5
      }, playerName)
    });

    // Wait 3 seconds
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Third catch
    updates.push({
      time: 5,
      update: this.tracker.updatePlayerStats(playerId, {
        receptions: 5,
        receiving_yards: 88,
        fantasy_points: 8.8
      }, playerName)
    });

    return {
      scenario: 'Rapid Sequential Updates',
      description: `${playerName} catches 3 passes in quick succession`,
      updates,
      totalDelta: '+6.00',
      timeline: 'Updates at 0s, 2s, 5s'
    };
  }

  /**
   * Scenario 6: Defense/Special Teams Score
   */
  defenseScores(playerId = 'dst_999', teamName = 'Ravens DEF') {
    this.tracker.setPlayerBaseline(playerId, {
      sacks: 2,
      def_interceptions: 0,
      fumbles_recovered: 1,
      def_int_return_tds: 0,
      points_allowed: 14,
      yards_allowed: 285,
      fantasy_points: 7.0
    });

    // Defensive TD
    const result = this.tracker.updatePlayerStats(playerId, {
      sacks: 2,
      def_interceptions: 1,     // +1 INT
      fumbles_recovered: 1,
      def_int_return_tds: 1,    // +1 INT return TD
      points_allowed: 14,
      yards_allowed: 285,
      fantasy_points: 15.0      // +8 (2 for INT + 6 for TD)
    }, teamName);

    return {
      scenario: 'Defensive Touchdown',
      description: `${teamName} returns interception for touchdown`,
      expectedDelta: '+8.00',
      expectedBoldStats: ['def_interceptions', 'def_int_return_tds', 'fantasy_points'],
      result
    };
  }

  /**
   * Scenario 7: Test 30-Second Expiration
   * Create a delta and verify it expires after exactly 30 seconds
   */
  async testExpiration() {
    const playerId = 'test_expiration';
    
    // Set baseline
    this.tracker.setPlayerBaseline(playerId, {
      rushing_yards: 50,
      fantasy_points: 5.0
    });

    // Create delta
    const delta = this.tracker.updatePlayerStats(playerId, {
      rushing_yards: 60,
      fantasy_points: 6.0
    }, 'Test Player');

    const timeline = [];
    
    // Check at various intervals
    const checkPoints = [0, 10, 20, 29, 30, 31];
    
    for (const seconds of checkPoints) {
      if (seconds > 0) {
        await new Promise(resolve => setTimeout(resolve, seconds * 1000 - timeline[timeline.length - 1].time));
      }
      
      const activeDeltas = this.tracker.getActiveDeltas();
      const isVisible = activeDeltas.some(d => d.playerId === playerId);
      
      timeline.push({
        time: seconds * 1000,
        seconds: seconds,
        isVisible,
        remainingTime: isVisible ? activeDeltas.find(d => d.playerId === playerId).remainingTime : 0,
        expected: seconds < 30
      });
    }

    return {
      scenario: 'Test 30-Second Expiration',
      description: 'Verify delta disappears after exactly 30 seconds',
      delta,
      timeline
    };
  }

  /**
   * Scenario 8: Big Play - Multiple Stats Change
   */
  bigPlay(playerId = 'qb_777', playerName = 'Josh Allen') {
    this.tracker.setPlayerBaseline(playerId, {
      completions: 12,
      passing_attempts: 18,
      passing_yards: 145,
      passing_tds: 1,
      rushing_yards: 22,
      rushing_tds: 0,
      fantasy_points: 11.0
    });

    // 75-yard TD pass
    const result = this.tracker.updatePlayerStats(playerId, {
      completions: 13,
      passing_attempts: 19,
      passing_yards: 220,  // +75 yards
      passing_tds: 2,       // +1 TD
      rushing_yards: 22,
      rushing_tds: 0,
      fantasy_points: 18.0  // +7 (4 for TD + 3 for yards)
    }, playerName);

    return {
      scenario: 'Big Play',
      description: `${playerName} throws 75-yard touchdown pass`,
      expectedDelta: '+7.00',
      expectedBoldStats: ['completions', 'passing_attempts', 'passing_yards', 'passing_tds', 'fantasy_points'],
      result
    };
  }

  /**
   * Run all scenarios in sequence
   */
  async runAllScenarios() {
    const results = [];

    console.log('Running Delta Test Scenarios...\n');

    // Scenario 1: Single Touchdown
    results.push(this.singleTouchdown());
    console.log('✓ Scenario 1: Single Touchdown');
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Scenario 2: Field Goal
    results.push(this.fieldGoal());
    console.log('✓ Scenario 2: Field Goal');
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Scenario 3: Team Scores
    results.push(this.teamScores());
    console.log('✓ Scenario 3: Team Scores');
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Scenario 4: Stat Correction
    results.push(this.statCorrection());
    console.log('✓ Scenario 4: Stat Correction');
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Scenario 5: Rapid Updates
    console.log('  Running Scenario 5: Rapid Updates (8 seconds)...');
    results.push(await this.rapidUpdates());
    console.log('✓ Scenario 5: Rapid Updates');

    // Scenario 6: Defense Scores
    results.push(this.defenseScores());
    console.log('✓ Scenario 6: Defense Scores');
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Scenario 7: Big Play
    results.push(this.bigPlay());
    console.log('✓ Scenario 7: Big Play');

    // Get final stats
    const stats = this.tracker.getStats();
    const activeDeltas = this.tracker.getActiveDeltas();

    console.log('\n=== Test Summary ===');
    console.log(`Total Scenarios Run: ${results.length}`);
    console.log(`Active Deltas: ${activeDeltas.length}`);
    console.log(`Total Deltas Created: ${stats.totalCreated}`);
    console.log(`Running Time: ${stats.runningTimeSeconds.toFixed(1)} seconds`);

    return {
      scenarios: results,
      stats,
      activeDeltas,
      timeline: this.tracker.getDeltaTimeline()
    };
  }

  /**
   * Create a custom scenario with specific parameters
   */
  customScenario(config) {
    const { playerId, playerName, beforeStats, afterStats, description } = config;
    
    this.tracker.setPlayerBaseline(playerId, beforeStats);
    const result = this.tracker.updatePlayerStats(playerId, afterStats, playerName);
    
    const delta = (afterStats.fantasy_points || 0) - (beforeStats.fantasy_points || 0);
    const changedStats = Object.keys(afterStats).filter(stat => 
      beforeStats[stat] !== afterStats[stat]
    );

    return {
      scenario: 'Custom Scenario',
      description: description || 'Custom stat update',
      expectedDelta: delta > 0 ? `+${delta.toFixed(2)}` : delta.toFixed(2),
      expectedBoldStats: changedStats,
      result
    };
  }
}

// Export singleton instance
const deltaScenarios = new DeltaScenarios();

module.exports = {
  DeltaScenarios,
  deltaScenarios,
  
  // Convenience exports for direct scenario access
  runSingleTouchdown: () => deltaScenarios.singleTouchdown(),
  runFieldGoal: () => deltaScenarios.fieldGoal(),
  runTeamScores: () => deltaScenarios.teamScores(),
  runStatCorrection: () => deltaScenarios.statCorrection(),
  runRapidUpdates: () => deltaScenarios.rapidUpdates(),
  runDefenseScores: () => deltaScenarios.defenseScores(),
  runBigPlay: () => deltaScenarios.bigPlay(),
  runAllScenarios: () => deltaScenarios.runAllScenarios(),
  runCustomScenario: (config) => deltaScenarios.customScenario(config)
};