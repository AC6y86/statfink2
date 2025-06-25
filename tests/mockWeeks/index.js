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

module.exports = {
  // Main functions
  getMockWeek,
  getAllMockWeeks,
  
  // Specific data getters
  getMockGames,
  getMockPlayerStats,
  getMockDSTStats,
  getMockMetadata,
  
  // Loader utilities
  MockWeekLoader,
  createMockWeekLoader,
  loadMockWeek,
  
  // Constants
  MOCK_SEASON: "mock"
};