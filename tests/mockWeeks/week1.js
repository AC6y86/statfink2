/**
 * Mock Week 1: Pre-Game State (No Games Started)
 * Scenario: Thursday 7:00 PM ET - All games scheduled, none started
 * - All games have status: "Scheduled"
 * - All scores are 0-0
 * - No player stats recorded yet
 * 
 * Tests:
 * - Roster validation before games start
 * - Projected points display
 * - Game schedule rendering
 */

const week1Games = [
  // Thursday Night Football
  {
    game_id: "mock_2024_01_KC_BAL",
    week: 1,
    season: "mock",
    home_team: "BAL",
    away_team: "KC",
    home_score: 0,
    away_score: 0,
    game_date: "2024-09-05T20:20:00Z", // Thursday 8:20 PM ET
    game_time: "8:20 PM ET",
    status: "Scheduled",
    quarter: null,
    time_remaining: null,
    venue: "M&T Bank Stadium"
  },
  
  // Sunday 1:00 PM ET Games
  {
    game_id: "mock_2024_01_BUF_MIA",
    week: 1,
    season: "mock",
    home_team: "MIA",
    away_team: "BUF",
    home_score: 0,
    away_score: 0,
    game_date: "2024-09-08T17:00:00Z", // Sunday 1:00 PM ET
    game_time: "1:00 PM ET",
    status: "Scheduled",
    quarter: null,
    time_remaining: null,
    venue: "Hard Rock Stadium"
  },
  {
    game_id: "mock_2024_01_NYJ_NE",
    week: 1,
    season: "mock",
    home_team: "NE",
    away_team: "NYJ",
    home_score: 0,
    away_score: 0,
    game_date: "2024-09-08T17:00:00Z",
    game_time: "1:00 PM ET",
    status: "Scheduled",
    quarter: null,
    time_remaining: null,
    venue: "Gillette Stadium"
  },
  {
    game_id: "mock_2024_01_CIN_CLE",
    week: 1,
    season: "mock",
    home_team: "CLE",
    away_team: "CIN",
    home_score: 0,
    away_score: 0,
    game_date: "2024-09-08T17:00:00Z",
    game_time: "1:00 PM ET",
    status: "Scheduled",
    quarter: null,
    time_remaining: null,
    venue: "Cleveland Browns Stadium"
  },
  {
    game_id: "mock_2024_01_PIT_ATL",
    week: 1,
    season: "mock",
    home_team: "ATL",
    away_team: "PIT",
    home_score: 0,
    away_score: 0,
    game_date: "2024-09-08T17:00:00Z",
    game_time: "1:00 PM ET",
    status: "Scheduled",
    quarter: null,
    time_remaining: null,
    venue: "Mercedes-Benz Stadium"
  },
  {
    game_id: "mock_2024_01_HOU_IND",
    week: 1,
    season: "mock",
    home_team: "IND",
    away_team: "HOU",
    home_score: 0,
    away_score: 0,
    game_date: "2024-09-08T17:00:00Z",
    game_time: "1:00 PM ET",
    status: "Scheduled",
    quarter: null,
    time_remaining: null,
    venue: "Lucas Oil Stadium"
  },
  {
    game_id: "mock_2024_01_TEN_CHI",
    week: 1,
    season: "mock",
    home_team: "CHI",
    away_team: "TEN",
    home_score: 0,
    away_score: 0,
    game_date: "2024-09-08T17:00:00Z",
    game_time: "1:00 PM ET",
    status: "Scheduled",
    quarter: null,
    time_remaining: null,
    venue: "Soldier Field"
  },
  {
    game_id: "mock_2024_01_JAX_CAR",
    week: 1,
    season: "mock",
    home_team: "CAR",
    away_team: "JAX",
    home_score: 0,
    away_score: 0,
    game_date: "2024-09-08T17:00:00Z",
    game_time: "1:00 PM ET",
    status: "Scheduled",
    quarter: null,
    time_remaining: null,
    venue: "Bank of America Stadium"
  },
  {
    game_id: "mock_2024_01_NO_TB",
    week: 1,
    season: "mock",
    home_team: "TB",
    away_team: "NO",
    home_score: 0,
    away_score: 0,
    game_date: "2024-09-08T17:00:00Z",
    game_time: "1:00 PM ET",
    status: "Scheduled",
    quarter: null,
    time_remaining: null,
    venue: "Raymond James Stadium"
  },
  
  // Sunday 4:00 PM ET Games
  {
    game_id: "mock_2024_01_DEN_SEA",
    week: 1,
    season: "mock",
    home_team: "SEA",
    away_team: "DEN",
    home_score: 0,
    away_score: 0,
    game_date: "2024-09-08T20:05:00Z", // Sunday 4:05 PM ET
    game_time: "4:05 PM ET",
    status: "Scheduled",
    quarter: null,
    time_remaining: null,
    venue: "Lumen Field"
  },
  {
    game_id: "mock_2024_01_ARI_SF",
    week: 1,
    season: "mock",
    home_team: "SF",
    away_team: "ARI",
    home_score: 0,
    away_score: 0,
    game_date: "2024-09-08T20:25:00Z", // Sunday 4:25 PM ET
    game_time: "4:25 PM ET",
    status: "Scheduled",
    quarter: null,
    time_remaining: null,
    venue: "Levi's Stadium"
  },
  {
    game_id: "mock_2024_01_LV_LAC",
    week: 1,
    season: "mock",
    home_team: "LAC",
    away_team: "LV",
    home_score: 0,
    away_score: 0,
    game_date: "2024-09-08T20:25:00Z",
    game_time: "4:25 PM ET",
    status: "Scheduled",
    quarter: null,
    time_remaining: null,
    venue: "SoFi Stadium"
  },
  {
    game_id: "mock_2024_01_DAL_GB",
    week: 1,
    season: "mock",
    home_team: "GB",
    away_team: "DAL",
    home_score: 0,
    away_score: 0,
    game_date: "2024-09-08T20:25:00Z",
    game_time: "4:25 PM ET",
    status: "Scheduled",
    quarter: null,
    time_remaining: null,
    venue: "Lambeau Field"
  },
  {
    game_id: "mock_2024_01_WAS_PHI",
    week: 1,
    season: "mock",
    home_team: "PHI",
    away_team: "WAS",
    home_score: 0,
    away_score: 0,
    game_date: "2024-09-08T20:25:00Z",
    game_time: "4:25 PM ET",
    status: "Scheduled",
    quarter: null,
    time_remaining: null,
    venue: "Lincoln Financial Field"
  },
  
  // Sunday Night Football
  {
    game_id: "mock_2024_01_MIN_NYG",
    week: 1,
    season: "mock",
    home_team: "NYG",
    away_team: "MIN",
    home_score: 0,
    away_score: 0,
    game_date: "2024-09-09T00:20:00Z", // Sunday 8:20 PM ET
    game_time: "8:20 PM ET",
    status: "Scheduled",
    quarter: null,
    time_remaining: null,
    venue: "MetLife Stadium"
  },
  
  // Monday Night Football
  {
    game_id: "mock_2024_01_LAR_DET",
    week: 1,
    season: "mock",
    home_team: "DET",
    away_team: "LAR",
    home_score: 0,
    away_score: 0,
    game_date: "2024-09-10T00:15:00Z", // Monday 8:15 PM ET
    game_time: "8:15 PM ET",
    status: "Scheduled",
    quarter: null,
    time_remaining: null,
    venue: "Ford Field"
  }
];

// Empty player stats for Week 1 (no games started)
const week1PlayerStats = [];

// Empty DST stats for Week 1 (no games started)
const week1DSTStats = [];

// Test scenario metadata
const week1Metadata = {
  week: 1,
  season: "mock",
  scenario: "Pre-Game State",
  currentTime: "2024-09-05T23:00:00Z", // Thursday 7:00 PM ET
  description: "All games scheduled, none started. Used for testing roster validation, projections, and pre-game displays.",
  expectedBehaviors: [
    "All player scores should be 0",
    "Rosters should be valid (19 players per team)",
    "No scoring players should be marked with asterisks",
    "Projected points should display instead of actual points",
    "Game schedule should show all games as upcoming"
  ]
};

module.exports = {
  games: week1Games,
  playerStats: week1PlayerStats,
  dstStats: week1DSTStats,
  metadata: week1Metadata
};