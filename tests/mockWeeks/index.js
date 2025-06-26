/**
 * Mock Weeks Testing Framework
 * Main entry point for mock week data and utilities
 */

const { MockWeekLoader, createMockWeekLoader, loadMockWeek } = require('./mockWeekLoader');

// Export individual week data getters
function getMockWeek(weekNumber) {
  try {
    return require(`./week${weekNumber}.js`);
  } catch (error) {
    throw new Error(`Mock week ${weekNumber} not found: ${error.message}`);
  }
}

// Export all available mock weeks
function getAllMockWeeks() {
  const weeks = {};
  const fs = require('fs');
  const path = require('path');
  
  // Get all week files
  const files = fs.readdirSync(__dirname);
  const weekFiles = files.filter(f => f.match(/^week\d+\.js$/));
  
  weekFiles.forEach(file => {
    const weekNumber = parseInt(file.match(/week(\d+)\.js$/)[1]);
    weeks[weekNumber] = require(`./${file}`);
  });
  
  return weeks;
}

// Helper to get just the games for a week
function getMockGames(weekNumber) {
  const weekData = getMockWeek(weekNumber);
  return weekData.games;
}

// Helper to get just the player stats for a week
function getMockPlayerStats(weekNumber) {
  const weekData = getMockWeek(weekNumber);
  return weekData.playerStats;
}

// Helper to get just the DST stats for a week
function getMockDSTStats(weekNumber) {
  const weekData = getMockWeek(weekNumber);
  return weekData.dstStats;
}

// Helper to get just the metadata for a week
function getMockMetadata(weekNumber) {
  const weekData = getMockWeek(weekNumber);
  return weekData.metadata;
}

// Game progression utilities for simulating live updates
let gameProgressionState = {};

// Initialize or reset game progression state for a week
function initializeGameProgression(weekNumber) {
  const weekData = getMockWeek(weekNumber);
  gameProgressionState[weekNumber] = {
    games: JSON.parse(JSON.stringify(weekData.games)), // Deep copy
    playerStats: JSON.parse(JSON.stringify(weekData.playerStats)),
    dstStats: JSON.parse(JSON.stringify(weekData.dstStats)),
    lastUpdate: new Date().toISOString(),
    updateCount: 0
  };
  return gameProgressionState[weekNumber];
}

// Simulate game progression (advance time, update scores)
function simulateGameProgression(weekNumber) {
  if (!gameProgressionState[weekNumber]) {
    initializeGameProgression(weekNumber);
  }
  
  const state = gameProgressionState[weekNumber];
  state.updateCount++;
  state.lastUpdate = new Date().toISOString();
  
  // Progress each in-progress game
  state.games.forEach(game => {
    if (game.status === 'InProgress') {
      progressSingleGame(game, state);
    }
  });
  
  return state;
}

// Progress a single game
function progressSingleGame(game, state) {
  // Parse current time
  const [minutes, seconds] = game.time_remaining.split(':').map(Number);
  let totalSeconds = minutes * 60 + seconds;
  
  // Advance time by ~2 minutes
  totalSeconds = Math.max(0, totalSeconds - 120);
  
  // Update time remaining
  const newMinutes = Math.floor(totalSeconds / 60);
  const newSeconds = totalSeconds % 60;
  game.time_remaining = `${newMinutes}:${newSeconds.toString().padStart(2, '0')}`;
  
  // Update game_time display format
  if (game.status === 'InProgress') {
    const quarterAbbr = {
      '1st': '1Q',
      '2nd': '2Q',
      '3rd': '3Q',
      '4th': '4Q'
    };
    game.game_time = `${quarterAbbr[game.quarter] || game.quarter} ${game.time_remaining}`;
  }
  
  // Chance to score based on remaining time
  const scoreChance = Math.random();
  if (scoreChance > 0.7) {
    // 30% chance to score on each update
    const scoringTeam = Math.random() > 0.5 ? 'home' : 'away';
    const points = Math.random() > 0.8 ? 7 : 3; // 80% FG, 20% TD
    
    if (scoringTeam === 'home') {
      game.home_score += points;
    } else {
      game.away_score += points;
    }
  }
  
  // Check if quarter should advance
  if (totalSeconds === 0) {
    switch(game.quarter) {
      case '1st':
        game.quarter = '2nd';
        game.time_remaining = '15:00';
        game.game_time = '2Q 15:00';
        break;
      case '2nd':
        game.quarter = 'Halftime';
        game.time_remaining = '0:00';
        game.status = 'Halftime';
        game.game_time = 'Halftime';
        break;
      case 'Halftime':
        game.quarter = '3rd';
        game.time_remaining = '15:00';
        game.status = 'InProgress';
        game.game_time = '3Q 15:00';
        break;
      case '3rd':
        game.quarter = '4th';
        game.time_remaining = '15:00';
        game.game_time = '4Q 15:00';
        break;
      case '4th':
        game.quarter = 'Final';
        game.time_remaining = '0:00';
        game.status = 'Final';
        game.game_time = null;
        break;
    }
  }
  
  // Update related player stats (simplified)
  updatePlayerStatsForGame(game, state);
}

// Update player stats based on game progression
function updatePlayerStatsForGame(game, state) {
  // Find players in this game and update their stats slightly
  state.playerStats.forEach(player => {
    if (player.game_id === game.game_id && player.game_status === 'InProgress') {
      // Small stat increments based on position
      switch(player.position) {
        case 'QB':
          player.passing_yards += Math.floor(Math.random() * 20);
          if (Math.random() > 0.95) player.passing_tds += 1;
          break;
        case 'RB':
          player.rushing_yards += Math.floor(Math.random() * 10);
          player.receiving_yards += Math.floor(Math.random() * 5);
          if (Math.random() > 0.97) player.rushing_tds += 1;
          break;
        case 'WR':
        case 'TE':
          player.receiving_yards += Math.floor(Math.random() * 15);
          player.receptions += Math.random() > 0.7 ? 1 : 0;
          if (Math.random() > 0.97) player.receiving_tds += 1;
          break;
        case 'K':
          if (Math.random() > 0.9) {
            player.field_goals_made += 1;
          }
          break;
      }
      
      // Update game status on player
      player.game_quarter = game.quarter;
      player.game_time_remaining = game.time_remaining;
      if (game.status === 'Final') {
        player.game_status = 'Final';
      }
    }
  });
  
  // Update DST stats
  state.dstStats.forEach(dst => {
    if (dst.game_id === game.game_id && game.status === 'InProgress') {
      // Update points allowed based on score changes
      const gameTeams = game.game_id.split('_').slice(-2);
      if (dst.team_code === game.home_team) {
        dst.points_allowed = game.away_score;
        dst.yards_allowed += Math.floor(Math.random() * 30);
      } else if (dst.team_code === game.away_team) {
        dst.points_allowed = game.home_score;
        dst.yards_allowed += Math.floor(Math.random() * 30);
      }
    }
  });
}

// Get current progression state for a week
function getProgressionState(weekNumber) {
  return gameProgressionState[weekNumber] || null;
}

// Reset progression state for a week (useful for tests)
function resetProgressionState(weekNumber) {
  if (gameProgressionState[weekNumber]) {
    delete gameProgressionState[weekNumber];
  }
}

// Reset all progression states
function resetAllProgressionStates() {
  gameProgressionState = {};
}

// Check if any games are in progress for a week
function hasInProgressGames(weekNumber) {
  const state = gameProgressionState[weekNumber];
  if (!state) {
    const weekData = getMockWeek(weekNumber);
    return weekData.games.some(g => g.status === 'InProgress' || g.status === 'Halftime');
  }
  return state.games.some(g => g.status === 'InProgress' || g.status === 'Halftime');
}

module.exports = {
  // Main functions
  getMockWeek,
  getAllMockWeeks,
  
  // Specific data getters
  getMockGames,
  getMockPlayerStats,
  getMockDSTStats,
  getMockMetadata,
  
  // Game progression functions
  initializeGameProgression,
  simulateGameProgression,
  getProgressionState,
  resetProgressionState,
  resetAllProgressionStates,
  hasInProgressGames,
  
  // Loader utilities
  MockWeekLoader,
  createMockWeekLoader,
  loadMockWeek,
  
  // Constants
  MOCK_SEASON: "mock"
};