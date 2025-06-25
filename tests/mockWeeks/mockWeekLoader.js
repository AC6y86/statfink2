/**
 * Mock Week Loader Utility
 * Provides functions to load and set up mock week data for testing
 */

const path = require('path');
const fs = require('fs');

class MockWeekLoader {
  constructor(db) {
    this.db = db;
    this.mockSeason = "mock";
  }

  /**
   * Get mock week data by week number
   * @param {number} weekNumber - The week number (1-10+)
   * @returns {Object} Mock week data including games, stats, and metadata
   */
  getMockWeek(weekNumber) {
    try {
      const weekFile = path.join(__dirname, `week${weekNumber}.js`);
      if (!fs.existsSync(weekFile)) {
        throw new Error(`Mock week ${weekNumber} not found`);
      }
      return require(weekFile);
    } catch (error) {
      console.error(`Error loading mock week ${weekNumber}:`, error);
      throw error;
    }
  }

  /**
   * Load mock week data into the database
   * @param {number} weekNumber - The week number to load
   * @param {boolean} clearExisting - Whether to clear existing data for this week
   */
  async loadMockWeek(weekNumber, clearExisting = true) {
    const weekData = this.getMockWeek(weekNumber);
    
    if (clearExisting) {
      await this.clearWeekData(weekNumber);
    }

    // Load games
    await this.loadGames(weekData.games);
    
    // Load player stats
    if (weekData.playerStats && weekData.playerStats.length > 0) {
      await this.loadPlayerStats(weekData.playerStats);
    }
    
    // Load DST stats
    if (weekData.dstStats && weekData.dstStats.length > 0) {
      await this.loadDSTStats(weekData.dstStats);
    }

    return weekData.metadata;
  }

  /**
   * Clear all data for a specific mock week
   */
  async clearWeekData(weekNumber) {
    await this.db.run(`
      DELETE FROM nfl_games 
      WHERE week = ? AND season = ?
    `, [weekNumber, this.mockSeason]);

    await this.db.run(`
      DELETE FROM player_stats 
      WHERE week = ? AND season = ?
    `, [weekNumber, this.mockSeason]);

    // Clear DST stats if they're stored separately
    await this.db.run(`
      DELETE FROM dst_scoring 
      WHERE week = ? AND season = ?
    `, [weekNumber, this.mockSeason]).catch(() => {
      // Table might not exist, that's okay
    });
  }

  /**
   * Load games into the database
   */
  async loadGames(games) {
    const stmt = await this.db.prepare(`
      INSERT OR REPLACE INTO nfl_games (
        game_id, week, season, home_team, away_team,
        home_score, away_score, game_date, game_time,
        status, quarter, time_remaining, venue
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const game of games) {
      await stmt.run(
        game.game_id,
        game.week,
        game.season,
        game.home_team,
        game.away_team,
        game.home_score,
        game.away_score,
        game.game_date,
        game.game_time,
        game.status,
        game.quarter,
        game.time_remaining,
        game.venue
      );
    }

    await stmt.finalize();
  }

  /**
   * Load player stats into the database
   */
  async loadPlayerStats(playerStats) {
    const stmt = await this.db.prepare(`
      INSERT OR REPLACE INTO player_stats (
        player_id, week, season,
        passing_yards, passing_tds, interceptions,
        rushing_yards, rushing_tds,
        receiving_yards, receiving_tds, receptions,
        fumbles, sacks, def_interceptions, fumbles_recovered,
        def_touchdowns, safeties, points_allowed, yards_allowed,
        field_goals_made, field_goals_attempted,
        extra_points_made, extra_points_attempted,
        field_goals_0_39, field_goals_40_49, field_goals_50_plus,
        fantasy_points
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);

    for (const stat of playerStats) {
      await stmt.run(
        stat.player_id,
        stat.week,
        stat.season,
        stat.passing_yards || 0,
        stat.passing_tds || 0,
        stat.interceptions || 0,
        stat.rushing_yards || 0,
        stat.rushing_tds || 0,
        stat.receiving_yards || 0,
        stat.receiving_tds || 0,
        stat.receptions || 0,
        stat.fumbles || 0,
        stat.sacks || 0,
        stat.def_interceptions || 0,
        stat.fumbles_recovered || 0,
        stat.def_touchdowns || 0,
        stat.safeties || 0,
        stat.points_allowed || 0,
        stat.yards_allowed || 0,
        stat.field_goals_made || 0,
        stat.field_goals_attempted || 0,
        stat.extra_points_made || 0,
        stat.extra_points_attempted || 0,
        stat.field_goals_0_39 || 0,
        stat.field_goals_40_49 || 0,
        stat.field_goals_50_plus || 0,
        stat.fantasy_points || 0
      );
    }

    await stmt.finalize();
  }

  /**
   * Load DST stats into the database
   */
  async loadDSTStats(dstStats) {
    // DST stats might be stored in the player_stats table with team defense IDs
    // or in a separate table. We'll handle both cases.
    
    // First try to insert as player stats (common approach)
    for (const dst of dstStats) {
      const playerId = `${dst.team_code}_DST`;
      await this.db.run(`
        INSERT OR REPLACE INTO player_stats (
          player_id, week, season,
          sacks, def_interceptions, fumbles_recovered,
          def_touchdowns, safeties, points_allowed, yards_allowed,
          fantasy_points
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        playerId,
        dst.week,
        dst.season,
        dst.sacks || 0,
        dst.interceptions || 0,
        dst.fumbles_recovered || 0,
        dst.defensive_tds || 0,
        dst.safeties || 0,
        dst.points_allowed || 0,
        dst.yards_allowed || 0,
        dst.fantasy_points || 0
      ]);
    }
  }

  /**
   * Set up a complete mock season with sample teams and rosters
   */
  async setupMockSeason() {
    // This would create the 12 teams and their rosters
    // Implementation depends on the specific team/roster structure
    console.log('Mock season setup would be implemented here');
  }

  /**
   * Get all available mock weeks
   */
  getAvailableWeeks() {
    const weeks = [];
    for (let i = 1; i <= 20; i++) {
      const weekFile = path.join(__dirname, `week${i}.js`);
      if (fs.existsSync(weekFile)) {
        weeks.push(i);
      }
    }
    return weeks;
  }

  /**
   * Simulate time progression within a week
   * Useful for testing live scoring scenarios
   */
  async simulateTimeProgression(weekNumber, targetTime) {
    const weekData = this.getMockWeek(weekNumber);
    // This would update game states based on the target time
    // For now, it's a placeholder
    console.log(`Simulating time progression to ${targetTime} for week ${weekNumber}`);
  }
}

// Factory function to create a mock week loader
function createMockWeekLoader(db) {
  return new MockWeekLoader(db);
}

// Standalone function for easy imports in tests
async function loadMockWeek(db, weekNumber, clearExisting = true) {
  const loader = new MockWeekLoader(db);
  return await loader.loadMockWeek(weekNumber, clearExisting);
}

module.exports = {
  MockWeekLoader,
  createMockWeekLoader,
  loadMockWeek
};