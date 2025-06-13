// Test fixtures for fantasy football app

const samplePlayers = [
  {
    player_id: 'KC_QB1',
    name: 'Patrick Mahomes',
    position: 'QB',
    team: 'KC',
    bye_week: 10
  },
  {
    player_id: 'DAL_RB1',
    name: 'Ezekiel Elliott',
    position: 'RB',
    team: 'DAL',
    bye_week: 7
  },
  {
    player_id: 'LAR_WR1',
    name: 'Cooper Kupp',
    position: 'WR',
    team: 'LAR',
    bye_week: 5
  },
  {
    player_id: 'KC_TE1',
    name: 'Travis Kelce',
    position: 'TE',
    team: 'KC',
    bye_week: 10
  },
  {
    player_id: 'BAL_K1',
    name: 'Justin Tucker',
    position: 'K',
    team: 'BAL',
    bye_week: 14
  },
  {
    player_id: 'SF_DST',
    name: 'San Francisco Defense',
    position: 'Defense',
    team: 'SF',
    bye_week: 9
  }
];

const sampleStats = [
  {
    player_id: 'KC_QB1',
    week: 1,
    season: 2024,
    passing_yards: 325,
    passing_tds: 3,
    interceptions: 1,
    rushing_yards: 15,
    rushing_tds: 0,
    fantasy_points: 0 // Will be calculated
  },
  {
    player_id: 'DAL_RB1',
    week: 1,
    season: 2024,
    rushing_yards: 120,
    rushing_tds: 2,
    receiving_yards: 25,
    receiving_tds: 0,
    receptions: 3,
    fumbles: 1,
    fantasy_points: 0
  },
  {
    player_id: 'SF_DST',
    week: 1,
    season: 2024,
    sacks: 3,
    def_interceptions: 2,
    fumbles_recovered: 1,
    def_touchdowns: 1,
    safeties: 0,
    points_allowed: 14,
    fantasy_points: 0
  }
];

const sampleTeams = [
  { team_name: 'Test Team Alpha', owner_name: 'Test Owner 1' },
  { team_name: 'Test Team Beta', owner_name: 'Test Owner 2' },
  { team_name: 'Test Team Gamma', owner_name: 'Test Owner 3' },
  { team_name: 'Test Team Delta', owner_name: 'Test Owner 4' }
];

const invalidPlayers = [
  {
    player_id: '',
    name: 'Invalid Player',
    position: 'QB',
    team: 'KC'
  },
  {
    player_id: 'TEST1',
    name: '',
    position: 'QB',
    team: 'KC'
  },
  {
    player_id: 'TEST2',
    name: 'Invalid Position',
    position: 'INVALID',
    team: 'KC'
  },
  {
    player_id: 'TEST3',
    name: 'Invalid Bye Week',
    position: 'QB',
    team: 'KC',
    bye_week: 25
  }
];

const invalidStats = [
  {
    player_id: '',
    week: 1,
    season: 2024
  },
  {
    player_id: 'TEST1',
    week: 25,
    season: 2024
  },
  {
    player_id: 'TEST2',
    week: 1,
    season: 1990
  },
  {
    player_id: 'TEST3',
    week: 1,
    season: 2024,
    passing_yards: -100
  }
];

module.exports = {
  samplePlayers,
  sampleStats,
  sampleTeams,
  invalidPlayers,
  invalidStats
};