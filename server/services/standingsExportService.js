const { logInfo, logError } = require('../utils/errorHandler');

class StandingsExportService {
    constructor(db) {
        this.db = db;
    }

    /**
     * Collect all data needed for weekly standings export
     */
    async getWeeklyExportData(week, season) {
        try {
            logInfo(`Collecting export data for Week ${week}, Season ${season}`);
            
            // Get standings data
            const standings = await this.getStandingsWithDetails(week, season);
            
            // Get matchup results
            const matchups = await this.getMatchupResults(week, season);
            
            // Get detailed team data with rosters
            const teams = await this.getDetailedTeamData(week, season, matchups);
            
            return {
                week,
                season,
                standings,
                matchups,
                teams
            };
        } catch (error) {
            logError('Error collecting export data:', error);
            throw error;
        }
    }

    /**
     * Get standings with weekly and cumulative points
     */
    async getStandingsWithDetails(week, season) {
        const standings = await this.db.all(`
            SELECT 
                ws.team_id,
                t.team_name,
                t.owner_name,
                ws.wins,
                ws.losses,
                ws.ties,
                ws.points_for_week as weeklyPoints,
                ws.cumulative_points as cumulativePoints,
                ws.weekly_rank
            FROM weekly_standings ws
            JOIN teams t ON ws.team_id = t.team_id
            WHERE ws.week = ? AND ws.season = ?
            ORDER BY ws.wins DESC, ws.cumulative_points DESC
        `, [week, season]);
        
        // Add matchup results for each team
        const matchups = await this.getMatchupResults(week, season);
        
        for (const team of standings) {
            const matchup = matchups.find(m => 
                m.team1_id === team.team_id || m.team2_id === team.team_id
            );
            
            if (matchup) {
                const isTeam1 = matchup.team1_id === team.team_id;
                const teamPoints = isTeam1 ? matchup.team1_points : matchup.team2_points;
                const oppPoints = isTeam1 ? matchup.team2_points : matchup.team1_points;
                const oppName = isTeam1 ? matchup.team2_name : matchup.team1_name;
                
                team.opponent = oppName;
                team.weekResult = teamPoints > oppPoints ? 'W' : teamPoints < oppPoints ? 'L' : 'T';
            }
        }
        
        return standings;
    }

    /**
     * Get matchup results for the week
     */
    async getMatchupResults(week, season) {
        const matchups = await this.db.all(`
            SELECT 
                m.team1_id,
                m.team2_id,
                t1.team_name as team1_name,
                t2.team_name as team2_name,
                COALESCE(m.team1_scoring_points, m.team1_points) as team1_points,
                COALESCE(m.team2_scoring_points, m.team2_points) as team2_points,
                m.is_complete
            FROM matchups m
            JOIN teams t1 ON m.team1_id = t1.team_id
            JOIN teams t2 ON m.team2_id = t2.team_id
            WHERE m.week = ? AND m.season = ?
        `, [week, season]);
        
        return matchups;
    }

    /**
     * Get detailed team data including rosters and player stats
     */
    async getDetailedTeamData(week, season, matchups) {
        const teams = await this.db.all(`
            SELECT 
                t.team_id,
                t.team_name,
                t.owner_name,
                ws.wins,
                ws.losses,
                ws.ties,
                ws.points_for_week as weeklyPoints,
                ws.cumulative_points as cumulativePoints
            FROM teams t
            LEFT JOIN weekly_standings ws ON t.team_id = ws.team_id 
                AND ws.week = ? AND ws.season = ?
            ORDER BY t.team_name
        `, [week, season]);
        
        // For each team, get roster with player stats
        for (const team of teams) {
            // Get matchup info
            const matchup = matchups.find(m => 
                m.team1_id === team.team_id || m.team2_id === team.team_id
            );
            
            if (matchup) {
                const isTeam1 = matchup.team1_id === team.team_id;
                team.opponent = isTeam1 ? matchup.team2_name : matchup.team1_name;
                const teamPoints = isTeam1 ? matchup.team1_points : matchup.team2_points;
                const oppPoints = isTeam1 ? matchup.team2_points : matchup.team1_points;
                team.weekResult = teamPoints > oppPoints ? 'W' : teamPoints < oppPoints ? 'L' : 'T';
            }
            
            // Get roster with player stats
            const roster = await this.db.all(`
                SELECT 
                    wr.player_id,
                    wr.player_name as name,
                    wr.player_position as position,
                    wr.player_team as team,
                    CASE 
                        WHEN wr.roster_position = 'injured_reserve' THEN 'IR'
                        ELSE 'Active'
                    END as status,
                    wr.is_scoring as isScoring,
                    COALESCE(ps.fantasy_points, 0) as fantasyPoints,
                    ps.passing_yards,
                    ps.passing_tds,
                    ps.rushing_yards,
                    ps.rushing_tds,
                    ps.receptions,
                    ps.receiving_yards,
                    ps.receiving_tds,
                    ps.field_goals_made,
                    ps.extra_points_made,
                    ps.def_touchdowns,
                    ps.safeties,
                    ps.points_allowed,
                    ps.yards_allowed,
                    ps.def_points_bonus,
                    ps.def_yards_bonus,
                    ps.def_int_return_tds,
                    ps.def_fumble_return_tds,
                    ps.def_blocked_return_tds,
                    ps.kick_return_tds,
                    ps.punt_return_tds
                FROM weekly_rosters wr
                LEFT JOIN player_stats ps ON wr.player_id = ps.player_id 
                    AND ps.week = wr.week AND ps.season = wr.season
                WHERE wr.team_id = ? AND wr.week = ? AND wr.season = ?
                ORDER BY 
                    wr.is_scoring DESC,
                    CASE wr.player_position 
                        WHEN 'QB' THEN 1 
                        WHEN 'RB' THEN 2 
                        WHEN 'WR' THEN 3 
                        WHEN 'TE' THEN 4 
                        WHEN 'K' THEN 5
                        WHEN 'DST' THEN 6
                        WHEN 'Defense' THEN 6
                        ELSE 7 
                    END,
                    wr.player_name
            `, [team.team_id, week, season]);
            
            // Format roster data
            team.roster = roster.map(player => ({
                player_id: player.player_id,
                name: player.name,
                position: player.position === 'DST' ? 'Defense' : player.position,
                team: player.team,
                status: player.status,
                isScoring: player.isScoring === 1,
                fantasyPoints: player.fantasyPoints || 0,
                stats: this.extractPlayerStats(player)
            }));
            
            // Verify roster has 19 players
            if (team.roster.length !== 19) {
                logError(`Warning: Team ${team.team_name} has ${team.roster.length} players instead of 19`);
            }
        }
        
        return teams;
    }

    /**
     * Extract relevant stats for a player based on position
     */
    extractPlayerStats(player) {
        const stats = {};
        
        // Common stats
        if (player.passing_yards > 0) stats.passing_yards = player.passing_yards;
        if (player.passing_tds > 0) stats.passing_tds = player.passing_tds;
        if (player.rushing_yards > 0) stats.rushing_yards = player.rushing_yards;
        if (player.rushing_tds > 0) stats.rushing_tds = player.rushing_tds;
        if (player.receptions > 0) stats.receptions = player.receptions;
        if (player.receiving_yards > 0) stats.receiving_yards = player.receiving_yards;
        if (player.receiving_tds > 0) stats.receiving_tds = player.receiving_tds;
        
        // Kicker stats
        if (player.position === 'K') {
            if (player.field_goals_made > 0) stats.field_goals_made = player.field_goals_made;
            if (player.extra_points_made > 0) stats.extra_points_made = player.extra_points_made;
        }
        
        // Defense stats
        if (player.position === 'DST' || player.position === 'Defense') {
            if (player.def_int_return_tds > 0) stats.def_int_return_tds = player.def_int_return_tds;
            if (player.def_fumble_return_tds > 0) stats.def_fumble_return_tds = player.def_fumble_return_tds;
            if (player.def_blocked_return_tds > 0) stats.def_blocked_return_tds = player.def_blocked_return_tds;
            if (player.safeties > 0) stats.safeties = player.safeties;
            if (player.points_allowed !== null) stats.points_allowed = player.points_allowed;
            if (player.yards_allowed !== null) stats.yards_allowed = player.yards_allowed;
            if (player.def_points_bonus > 0) stats.def_points_bonus = player.def_points_bonus;
            if (player.def_yards_bonus > 0) stats.def_yards_bonus = player.def_yards_bonus;
        }
        
        // Return TDs
        if (player.kick_return_tds > 0) stats.kick_return_tds = player.kick_return_tds;
        if (player.punt_return_tds > 0) stats.punt_return_tds = player.punt_return_tds;
        
        return stats;
    }

    /**
     * Get all rostered players in grid format for Week X Stats tab
     */
    async getRosteredPlayersGrid(week, season) {
        try {
            // Get all teams for column headers
            const teams = await this.db.all(`
                SELECT team_id, owner_name 
                FROM teams 
                ORDER BY team_id
            `);
            
            // Get all rostered players with their stats and ownership
            const players = await this.db.all(`
                SELECT 
                    wr.player_id,
                    wr.player_name as name,
                    wr.player_position as position,
                    wr.player_team as nfl_team,
                    wr.team_id,
                    t.owner_name,
                    wr.is_scoring as isScoring,
                    COALESCE(ps.fantasy_points, 0) as fantasyPoints
                FROM weekly_rosters wr
                JOIN teams t ON wr.team_id = t.team_id
                LEFT JOIN player_stats ps ON wr.player_id = ps.player_id 
                    AND ps.week = wr.week AND ps.season = wr.season
                WHERE wr.week = ? AND wr.season = ?
                ORDER BY 
                    CASE wr.player_position 
                        WHEN 'QB' THEN 1 
                        WHEN 'RB' THEN 2 
                        WHEN 'WR' THEN 3 
                        WHEN 'TE' THEN 4 
                        WHEN 'K' THEN 5
                        WHEN 'DST' THEN 6
                        WHEN 'Defense' THEN 6
                        ELSE 7 
                    END,
                    ps.fantasy_points DESC NULLS LAST,
                    wr.player_name
            `, [week, season]);
            
            // Group players by unique player_id (in case of trades, keep highest scoring)
            const playerMap = new Map();
            players.forEach(player => {
                const key = player.player_id;
                if (!playerMap.has(key) || player.fantasyPoints > playerMap.get(key).fantasyPoints) {
                    playerMap.set(key, player);
                }
            });
            
            // Convert back to array and sort
            const uniquePlayers = Array.from(playerMap.values());
            
            // Group by position
            const positionGroups = {
                'QB': [],
                'RB': [],
                'WR': [],
                'TE': [],
                'K': [],
                'DST': []
            };
            
            uniquePlayers.forEach(player => {
                let pos = player.position;
                if (pos === 'Defense') pos = 'DST';
                if (positionGroups[pos]) {
                    positionGroups[pos].push(player);
                } else {
                    // Handle any unexpected positions
                    if (!positionGroups['Other']) positionGroups['Other'] = [];
                    positionGroups['Other'].push(player);
                }
            });
            
            // Sort each position group by fantasy points descending
            Object.keys(positionGroups).forEach(pos => {
                positionGroups[pos].sort((a, b) => b.fantasyPoints - a.fantasyPoints);
            });
            
            return {
                teams: teams.map(t => t.owner_name),
                positionGroups,
                playerCount: uniquePlayers.length
            };
            
        } catch (error) {
            logError('Error getting rostered players grid:', error);
            throw error;
        }
    }

    /**
     * Get all completed weeks for a season
     */
    async getCompletedWeeks(season) {
        const weeks = await this.db.all(`
            SELECT DISTINCT week 
            FROM weekly_standings 
            WHERE season = ?
            ORDER BY week
        `, [season]);
        
        return weeks.map(w => w.week);
    }
}

module.exports = StandingsExportService;