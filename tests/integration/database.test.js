const DatabaseManager = require('../../server/database/database');
const { samplePlayers, sampleStats, sampleTeams } = require('../fixtures/sampleData');

describe('Database Integration', () => {
  let db;

  beforeAll(async () => {
    db = new DatabaseManager();
    // Wait for database to initialize
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Initialize test data
    try {
      // Add league settings
      await db.run(`
        INSERT OR IGNORE INTO league_settings 
        (league_id, league_name, max_teams, season_year, current_week)
        VALUES (1, 'StatFink Fantasy League', 12, 2024, 1)
      `);
      
      // Add test teams
      const testTeams = [
        { name: 'Test Team Alpha', owner: 'Test Owner 1' },
        { name: 'Test Team Beta', owner: 'Test Owner 2' },
        { name: 'Test Team Gamma', owner: 'Test Owner 3' },
        { name: 'Test Team Delta', owner: 'Test Owner 4' }
      ];
      
      for (const team of testTeams) {
        await db.run(
          'INSERT OR IGNORE INTO teams (team_name, owner_name) VALUES (?, ?)',
          [team.name, team.owner]
        );
      }
    } catch (error) {
      console.warn('Test data initialization failed:', error.message);
    }
  });

  afterAll(async () => {
    await db.close();
  });

  describe('League Settings', () => {
    test('should have default league settings', async () => {
      const settings = await db.getLeagueSettings();
      expect(settings).toBeDefined();
      expect(settings.league_name).toBe('StatFink Fantasy League');
      expect(settings.season_year).toBe(2024);
      expect(settings.current_week).toBe(1);
    });

    test('should update current week', async () => {
      await db.updateCurrentWeek(5);
      const settings = await db.getLeagueSettings();
      expect(settings.current_week).toBe(5);
      
      // Reset for other tests
      await db.updateCurrentWeek(1);
    });
  });

  describe('Team Operations', () => {
    test('should retrieve all teams', async () => {
      const teams = await db.getAllTeams();
      expect(teams).toBeDefined();
      expect(teams.length).toBeGreaterThan(0);
      expect(teams[0]).toHaveProperty('team_name');
      expect(teams[0]).toHaveProperty('owner_name');
    });

    test('should get specific team', async () => {
      const teams = await db.getAllTeams();
      const firstTeam = teams[0];
      
      const team = await db.getTeam(firstTeam.team_id);
      expect(team).toBeDefined();
      expect(team.team_id).toBe(firstTeam.team_id);
      expect(team.team_name).toBe(firstTeam.team_name);
    });

    test('should update team stats', async () => {
      const teams = await db.getAllTeams();
      const testTeam = teams[0];
      
      await db.updateTeamStats(testTeam.team_id, 5, 3, 1, 125.5);
      
      const updatedTeam = await db.getTeam(testTeam.team_id);
      expect(updatedTeam.wins).toBe(5);
      expect(updatedTeam.losses).toBe(3);
      expect(updatedTeam.ties).toBe(1);
      expect(updatedTeam.total_points).toBe(125.5);
    });
  });

  describe('Player Operations', () => {
    test('should insert and retrieve players', async () => {
      const testPlayer = samplePlayers[0];
      
      await db.upsertPlayer(
        testPlayer.player_id,
        testPlayer.name,
        testPlayer.position,
        testPlayer.team,
        testPlayer.bye_week
      );

      const players = await db.getPlayersByPosition('QB');
      const insertedPlayer = players.find(p => p.player_id === testPlayer.player_id);
      
      expect(insertedPlayer).toBeDefined();
      expect(insertedPlayer.name).toBe(testPlayer.name);
      expect(insertedPlayer.position).toBe(testPlayer.position);
      expect(insertedPlayer.team).toBe(testPlayer.team);
    });

    test('should get all active players', async () => {
      const players = await db.getAllPlayers();
      expect(players).toBeDefined();
      expect(Array.isArray(players)).toBe(true);
      
      // Check player structure
      if (players.length > 0) {
        const player = players[0];
        expect(player.player_id).toBeDefined();
        expect(player.name).toBeDefined();
        expect(player.position).toBeDefined();
        expect(player.team).toBeDefined();
      }
    });

    test('should filter players by position', async () => {
      // Insert sample players
      for (const player of samplePlayers) {
        await db.upsertPlayer(
          player.player_id,
          player.name,
          player.position,
          player.team,
          player.bye_week
        );
      }

      const qbs = await db.getPlayersByPosition('QB');
      const rbs = await db.getPlayersByPosition('RB');
      const wrs = await db.getPlayersByPosition('WR');

      expect(qbs.every(p => p.position === 'QB')).toBe(true);
      expect(rbs.every(p => p.position === 'RB')).toBe(true);
      expect(wrs.every(p => p.position === 'WR')).toBe(true);
    });
  });

  describe('Roster Operations', () => {
    let testTeamId;
    let testPlayerId;

    beforeAll(async () => {
      const teams = await db.getAllTeams();
      testTeamId = teams[0].team_id;
      testPlayerId = samplePlayers[0].player_id;
    });

    test('should add player to roster', async () => {
      // First remove the player if they're already on a roster
      try {
        await db.removePlayerFromRoster(testTeamId, testPlayerId);
      } catch (error) {
        // Player wasn't on roster, that's fine
      }
      
      await db.addPlayerToRoster(testTeamId, testPlayerId, 'starter');
      
      const roster = await db.getTeamRoster(testTeamId);
      const addedPlayer = roster.find(p => p.player_id === testPlayerId);
      
      expect(addedPlayer).toBeDefined();
      expect(addedPlayer.roster_position).toBe('starter');
    });

    test('should update roster position', async () => {
      await db.updateRosterPosition(testTeamId, testPlayerId, 'bench');
      
      const roster = await db.getTeamRoster(testTeamId);
      const updatedPlayer = roster.find(p => p.player_id === testPlayerId);
      
      expect(updatedPlayer.roster_position).toBe('bench');
    });

    test('should remove player from roster', async () => {
      await db.removePlayerFromRoster(testTeamId, testPlayerId);
      
      const roster = await db.getTeamRoster(testTeamId);
      const removedPlayer = roster.find(p => p.player_id === testPlayerId);
      
      expect(removedPlayer).toBeUndefined();
    });

    test('should get team roster with player details', async () => {
      // Add a player back for testing
      await db.addPlayerToRoster(testTeamId, testPlayerId, 'starter');
      
      const roster = await db.getTeamRoster(testTeamId);
      
      expect(roster).toBeDefined();
      expect(Array.isArray(roster)).toBe(true);
      
      if (roster.length > 0) {
        const player = roster[0];
        expect(player).toHaveProperty('name');
        expect(player).toHaveProperty('position');
        expect(player).toHaveProperty('team');
        expect(player).toHaveProperty('roster_position');
      }
    });
  });

  describe('Stats Operations', () => {
    let testPlayerId;

    beforeAll(async () => {
      testPlayerId = samplePlayers[0].player_id;
    });

    test('should insert and retrieve player stats', async () => {
      const testStats = {
        player_id: testPlayerId,
        week: 1,
        season: 2024,
        passing_yards: 300,
        passing_tds: 3,
        interceptions: 1,
        fantasy_points: 20.5
      };

      await db.upsertPlayerStats(testStats);
      
      const retrievedStats = await db.getPlayerStats(testPlayerId, 1, 2024);
      
      expect(retrievedStats).toBeDefined();
      expect(retrievedStats.player_id).toBe(testPlayerId);
      expect(retrievedStats.passing_yards).toBe(300);
      expect(retrievedStats.passing_tds).toBe(3);
      expect(retrievedStats.fantasy_points).toBe(20.5);
    });

    test('should update existing stats', async () => {
      const updatedStats = {
        player_id: testPlayerId,
        week: 1,
        season: 2024,
        passing_yards: 350,
        passing_tds: 4,
        interceptions: 0,
        fantasy_points: 25.0
      };

      await db.upsertPlayerStats(updatedStats);
      
      const retrievedStats = await db.getPlayerStats(testPlayerId, 1, 2024);
      
      expect(retrievedStats.passing_yards).toBe(350);
      expect(retrievedStats.passing_tds).toBe(4);
      expect(retrievedStats.fantasy_points).toBe(25.0);
    });
  });

  describe('Matchup Operations', () => {
    let team1Id, team2Id;

    beforeAll(async () => {
      const teams = await db.getAllTeams();
      team1Id = teams[0].team_id;
      team2Id = teams[1].team_id;
    });

    test('should create matchup', async () => {
      await db.createMatchup(1, 2024, team1Id, team2Id);
      
      const matchups = await db.getWeekMatchups(1, 2024);
      const createdMatchup = matchups.find(m => 
        m.team1_id === team1Id && m.team2_id === team2Id
      );
      
      expect(createdMatchup).toBeDefined();
      expect(createdMatchup.week).toBe(1);
      expect(createdMatchup.season).toBe(2024);
    });

    test('should update matchup scores', async () => {
      const matchups = await db.getWeekMatchups(1, 2024);
      const matchup = matchups[0];
      
      await db.updateMatchupScore(matchup.matchup_id, 125.5, 118.2);
      
      const updatedMatchups = await db.getWeekMatchups(1, 2024);
      const updatedMatchup = updatedMatchups.find(m => m.matchup_id === matchup.matchup_id);
      
      expect(updatedMatchup.team1_points).toBe(125.5);
      expect(updatedMatchup.team2_points).toBe(118.2);
    });

    test('should get week matchups with team details', async () => {
      const matchups = await db.getWeekMatchups(1, 2024);
      
      expect(matchups).toBeDefined();
      expect(Array.isArray(matchups)).toBe(true);
      
      if (matchups.length > 0) {
        const matchup = matchups[0];
        expect(matchup).toHaveProperty('team1_name');
        expect(matchup).toHaveProperty('team1_owner');
        expect(matchup).toHaveProperty('team2_name');
        expect(matchup).toHaveProperty('team2_owner');
      }
    });
  });

  describe('Scoring Rules', () => {
    test('should have default scoring rules', async () => {
      const rules = await db.getScoringRules();
      
      expect(rules).toBeDefined();
      expect(rules.length).toBeGreaterThan(0);
      
      // Check for key scoring rules
      const passingYards = rules.find(r => r.stat_type === 'passing_yards');
      const receptions = rules.find(r => r.stat_type === 'receptions');
      
      expect(passingYards).toBeDefined();
      expect(passingYards.points_per_unit).toBe(0.04);
      expect(receptions).toBeDefined();
      expect(receptions.points_per_unit).toBe(1); // PPR
    });
  });
});