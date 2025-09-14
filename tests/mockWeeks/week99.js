/**
 * Mock Week 99: Delta Testing Week with Real Week 1 2025 Data
 * This week uses actual fantasy data for realistic delta testing
 */

const week99Games = [
  {
    game_id: "delta_test_game_1",
    week: 99,
    season: "mock",
    home_team: "KC",
    away_team: "BUF",
    home_score: 14,
    away_score: 10,
    game_date: "2024-12-01T17:00:00Z",
    game_time: "Q2 8:45",
    status: "InProgress",
    quarter: "2nd",
    time_remaining: "8:45",
    venue: "Test Stadium"
  },
  {
    game_id: "delta_test_game_2",
    week: 99,
    season: "mock",
    home_team: "DAL",
    away_team: "PHI",
    home_score: 21,
    away_score: 17,
    game_date: "2024-12-01T20:25:00Z",
    game_time: "Q3 12:00",
    status: "InProgress",
    quarter: "3rd",
    time_remaining: "12:00",
    venue: "Test Field"
  }
];

// Real player stats from Week 1 2025 for delta testing
const week99PlayerStats = [
  // Team 1 Players (Owner 7 from matchup 841)
  {
    player_id: "4431611",
    name: "Caleb Williams",
    team: "CHI",
    position: "QB",
    opp: "@TEN",
    week: 99,
    season: "mock",
    game_id: "delta_test_game_1",
    owner_id: 7,
    matchup_id: 1,
    roster_slot: "QB",
    is_scoring: true,
    game_status: "Q2 8:45",
    game_time: "Q2 8:45",
    game_quarter: "2nd",
    game_time_remaining: "8:45",
    passing_yards: 210,
    passing_tds: 1,
    rushing_yards: 58,
    rushing_tds: 1,
    fantasy_points: 22.0
  },
  {
    player_id: "4430807",
    name: "Bijan Robinson",
    team: "ATL",
    position: "RB",
    opp: "@PIT",
    week: 99,
    season: "mock",
    game_id: "delta_test_game_1",
    owner_id: 7,
    matchup_id: 1,
    roster_slot: "RB",
    is_scoring: true,
    game_status: "Q2 8:45",
    game_time: "Q2 8:45",
    rushing_yards: 24,
    rushing_tds: 0,
    receiving_yards: 100,
    receiving_tds: 1,
    receptions: 6,
    fantasy_points: 17.0
  },
  {
    player_id: "4890973",
    name: "Ashton Jeanty",
    team: "LV",
    position: "RB",
    opp: "@LAC",
    week: 99,
    season: "mock",
    game_id: "delta_test_game_1",
    owner_id: 7,
    matchup_id: 1,
    roster_slot: "RB",
    is_scoring: true,
    game_status: "Q2 8:45",
    game_time: "Q2 8:45",
    rushing_yards: 38,
    rushing_tds: 1,
    receiving_yards: 2,
    receptions: 2,
    fantasy_points: 8.0
  },
  {
    player_id: "4567750",
    name: "Emeka Egbuka",
    team: "TB",
    position: "WR",
    opp: "@WAS",
    week: 99,
    season: "mock",
    game_id: "delta_test_game_1",
    owner_id: 7,
    matchup_id: 1,
    roster_slot: "WR",
    is_scoring: true,
    game_status: "Q2 8:45",
    game_time: "Q2 8:45",
    rushing_yards: 9,
    receiving_yards: 67,
    receiving_tds: 2,
    receptions: 4,
    fantasy_points: 19.0
  },
  {
    player_id: "4635008",
    name: "Keon Coleman",
    team: "BUF",
    position: "WR",
    opp: "KC",
    week: 99,
    season: "mock",
    game_id: "delta_test_game_1",
    owner_id: 7,
    matchup_id: 1,
    roster_slot: "WR",
    is_scoring: true,
    game_status: "Q2 8:45",
    game_time: "Q2 8:45",
    receiving_yards: 112,
    receiving_tds: 1,
    receptions: 8,
    fantasy_points: 17.0
  },
  {
    player_id: "4431459",
    name: "Tyler Warren",
    team: "IND",
    position: "TE",
    opp: "@HOU",
    week: 99,
    season: "mock",
    game_id: "delta_test_game_1",
    owner_id: 7,
    matchup_id: 1,
    roster_slot: "TE",
    is_scoring: true,
    game_status: "Q2 8:45",
    game_time: "Q2 8:45",
    rushing_yards: 3,
    receiving_yards: 76,
    receptions: 7,
    fantasy_points: 6.0
  },
  {
    player_id: "2473037",
    name: "Jason Myers",
    team: "SEA",
    position: "K",
    opp: "@DEN",
    week: 99,
    season: "mock",
    game_id: "delta_test_game_1",
    owner_id: 7,
    matchup_id: 1,
    roster_slot: "K",
    is_scoring: true,
    game_status: "Q2 8:45",
    game_time: "Q2 8:45",
    field_goals_made: 2,
    field_goals_attempted: 2,
    extra_points_made: 1,
    extra_points_attempted: 1,
    fantasy_points: 4.5
  },
  {
    player_id: "DEF_WAS",
    name: "Commanders",
    team: "WAS",
    position: "DST",
    opp: "TB",
    week: 99,
    season: "mock",
    game_id: "delta_test_game_1",
    owner_id: 7,
    matchup_id: 1,
    roster_slot: "DEF",
    is_scoring: true,
    game_status: "Q2 8:45",
    game_time: "Q2 8:45",
    sacks: 2,
    def_interceptions: 0,
    points_allowed: 17,
    yards_allowed: 320,
    fantasy_points: 5.0
  },
  
  // Team 2 Players (Owner 8 from matchup 841)
  {
    player_id: "3917792",
    name: "Daniel Jones",
    team: "IND",
    position: "QB",
    opp: "HOU",
    week: 99,
    season: "mock",
    game_id: "delta_test_game_2",
    owner_id: 8,
    matchup_id: 1,
    roster_slot: "QB",
    is_scoring: true,
    game_status: "Q3 12:00",
    game_time: "Q3 12:00",
    game_quarter: "3rd",
    game_time_remaining: "12:00",
    passing_yards: 272,
    passing_tds: 1,
    rushing_yards: 26,
    rushing_tds: 2,
    fantasy_points: 30.0
  },
  {
    player_id: "4241985",
    name: "J.K. Dobbins",
    team: "DEN",
    position: "RB",
    opp: "SEA",
    week: 99,
    season: "mock",
    game_id: "delta_test_game_2",
    owner_id: 8,
    matchup_id: 1,
    roster_slot: "RB",
    is_scoring: true,
    game_status: "Q3 12:00",
    game_time: "Q3 12:00",
    rushing_yards: 63,
    rushing_tds: 1,
    receiving_yards: 5,
    receptions: 2,
    fantasy_points: 11.0
  },
  {
    player_id: "4362238",
    name: "Chase Brown",
    team: "CIN",
    position: "RB",
    opp: "@NE",
    week: 99,
    season: "mock",
    game_id: "delta_test_game_2",
    owner_id: 8,
    matchup_id: 1,
    roster_slot: "RB",
    is_scoring: true,
    game_status: "Q3 12:00",
    game_time: "Q3 12:00",
    rushing_yards: 43,
    rushing_tds: 1,
    receiving_yards: 8,
    receptions: 2,
    fantasy_points: 8.0
  },
  {
    player_id: "4047650",
    name: "DK Metcalf",
    team: "PIT",
    position: "WR",
    opp: "ATL",
    week: 99,
    season: "mock",
    game_id: "delta_test_game_2",
    owner_id: 8,
    matchup_id: 1,
    roster_slot: "WR",
    is_scoring: true,
    game_status: "Q3 12:00",
    game_time: "Q3 12:00",
    receiving_yards: 83,
    receptions: 4,
    fantasy_points: 6.0
  },
  {
    player_id: "4241372",
    name: "Marquise Brown",
    team: "KC",
    position: "WR",
    opp: "@BUF",
    week: 99,
    season: "mock",
    game_id: "delta_test_game_2",
    owner_id: 8,
    matchup_id: 1,
    roster_slot: "WR",
    is_scoring: true,
    game_status: "Q3 12:00",
    game_time: "Q3 12:00",
    receiving_yards: 99,
    receptions: 10,
    fantasy_points: 6.0
  },
  {
    player_id: "4432665",
    name: "Brock Bowers",
    team: "LV",
    position: "TE",
    opp: "LAC",
    week: 99,
    season: "mock",
    game_id: "delta_test_game_2",
    owner_id: 8,
    matchup_id: 1,
    roster_slot: "TE",
    is_scoring: true,
    game_status: "Q3 12:00",
    game_time: "Q3 12:00",
    receiving_yards: 103,
    receptions: 5,
    fantasy_points: 9.0
  },
  {
    player_id: "17372",
    name: "Chris Boswell",
    team: "PIT",
    position: "K",
    opp: "ATL",
    week: 99,
    season: "mock",
    game_id: "delta_test_game_2",
    owner_id: 8,
    matchup_id: 1,
    roster_slot: "K",
    is_scoring: true,
    game_status: "Q3 12:00",
    game_time: "Q3 12:00",
    field_goals_made: 2,
    field_goals_attempted: 2,
    extra_points_made: 4,
    extra_points_attempted: 4,
    fantasy_points: 6.0
  },
  {
    player_id: "DEF_IND",
    name: "Colts",
    team: "IND",
    position: "DST",
    opp: "HOU",
    week: 99,
    season: "mock",
    game_id: "delta_test_game_2",
    owner_id: 8,
    matchup_id: 1,
    roster_slot: "DEF",
    is_scoring: true,
    game_status: "Q3 12:00",
    game_time: "Q3 12:00",
    sacks: 3,
    def_interceptions: 2,
    points_allowed: 21,
    yards_allowed: 350,
    fantasy_points: 0.0
  }
];

// DST stats for delta testing
const week99DSTStats = [
  {
    team_code: "WAS",
    team_name: "Commanders",
    week: 99,
    season: "mock",
    game_id: "delta_test_game_1",
    game_status: "InProgress",
    sacks: 2,
    def_interceptions: 0,
    fumbles_recovered: 0,
    def_int_return_tds: 0,
    def_fumble_return_tds: 0,
    def_blocked_return_tds: 0,
    safeties: 0,
    points_allowed: 17,
    yards_allowed: 320,
    fantasy_points: 5.0
  },
  {
    team_code: "IND",
    team_name: "Colts",
    week: 99,
    season: "mock",
    game_id: "delta_test_game_2",
    game_status: "InProgress",
    sacks: 3,
    def_interceptions: 2,
    fumbles_recovered: 0,
    def_int_return_tds: 0,
    def_fumble_return_tds: 0,
    def_blocked_return_tds: 0,
    safeties: 0,
    points_allowed: 21,
    yards_allowed: 350,
    fantasy_points: 0.0
  }
];

// Progression states for simulating delta updates
const deltaProgressionStates = [
  {
    time: "0:00",
    description: "Initial state - games in progress with real Week 1 data",
    updates: []
  },
  {
    time: "0:05",
    description: "Caleb Williams throws TD to Keon Coleman",
    updates: [
      {
        player_id: "4431611",
        stats: { passing_yards: 235, passing_tds: 2, fantasy_points: 26.0 }
      },
      {
        player_id: "4635008",
        stats: { receiving_yards: 137, receiving_tds: 2, receptions: 9, fantasy_points: 25.7 }
      }
    ]
  },
  {
    time: "0:10",
    description: "Jason Myers kicks field goal",
    updates: [
      {
        player_id: "2473037",
        stats: { field_goals_made: 3, field_goals_attempted: 3, fantasy_points: 7.5 }
      }
    ]
  },
  {
    time: "0:15",
    description: "J.K. Dobbins rushes for TD",
    updates: [
      {
        player_id: "4241985",
        stats: { rushing_yards: 78, rushing_tds: 2, fantasy_points: 18.8 }
      }
    ]
  },
  {
    time: "0:20",
    description: "Commanders defense gets interception for TD",
    updates: [
      {
        player_id: "DEF_WAS",
        stats: { def_interceptions: 1, def_int_return_tds: 1, fantasy_points: 13.0 }
      }
    ]
  },
  {
    time: "0:25",
    description: "Stat correction - Bijan Robinson TD overturned",
    updates: [
      {
        player_id: "4430807",
        stats: { receiving_tds: 0, fantasy_points: 11.0 }  // -6 points
      }
    ]
  },
  {
    time: "0:35",
    description: "Check expiration - first updates should be gone",
    updates: []
  },
  {
    time: "0:40",
    description: "Daniel Jones scrambles for rushing TD",
    updates: [
      {
        player_id: "3917792",
        stats: { rushing_yards: 42, rushing_tds: 3, fantasy_points: 37.6 }
      }
    ]
  }
];

// Helper function to get current state at a specific time
function getDeltaStateAtTime(secondsElapsed) {
  let currentState = deltaProgressionStates[0];
  
  for (const state of deltaProgressionStates) {
    const [minutes, seconds] = state.time.split(':').map(Number);
    const stateTime = minutes * 60 + seconds;
    
    if (stateTime <= secondsElapsed) {
      currentState = state;
    } else {
      break;
    }
  }
  
  return currentState;
}

// Function to apply updates to player stats
function applyDeltaUpdates(baseStats, updates) {
  const updatedStats = JSON.parse(JSON.stringify(baseStats));
  
  for (const update of updates) {
    const player = updatedStats.find(p => p.player_id === update.player_id);
    if (player) {
      Object.assign(player, update.stats);
    }
  }
  
  return updatedStats;
}

module.exports = {
  metadata: {
    week: 99,
    description: "Delta Testing Week - Real Week 1 2025 data for testing 30-second display",
    scenario: "Games in progress with real player stats and timed updates",
    progressionStates: deltaProgressionStates.length,
    testDuration: "45 seconds total"
  },
  games: week99Games,
  playerStats: week99PlayerStats,
  dstStats: week99DSTStats,
  progressionStates: deltaProgressionStates,
  
  // Helper functions
  getDeltaStateAtTime,
  applyDeltaUpdates,
  
  // Get stats at specific time
  getStatsAtTime: function(secondsElapsed) {
    const state = getDeltaStateAtTime(secondsElapsed);
    const allUpdates = [];
    
    // Collect all updates up to this point
    for (const s of deltaProgressionStates) {
      const [minutes, seconds] = s.time.split(':').map(Number);
      const stateTime = minutes * 60 + seconds;
      
      if (stateTime <= secondsElapsed) {
        allUpdates.push(...s.updates);
      } else {
        break;
      }
    }
    
    return {
      currentState: state,
      playerStats: applyDeltaUpdates(week99PlayerStats, allUpdates),
      games: week99Games,
      dstStats: week99DSTStats
    };
  }
};