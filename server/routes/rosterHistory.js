const express = require('express');
const DatabaseManager = require('../database/database');
const { logError, logInfo } = require('../utils/errorHandler');

const router = express.Router();

// Get all available snapshot weeks
router.get('/snapshots/:season?', async (req, res) => {
    const db = new DatabaseManager();
    
    try {
        const season = parseInt(req.params.season) || 2024;
        
        const snapshots = await db.getAvailableSnapshotWeeks(season);
        
        res.json({
            success: true,
            season,
            snapshots,
            count: snapshots.length
        });
        
    } catch (error) {
        logError(error, 'GET /api/roster-history/snapshots');
        res.status(500).json({
            success: false,
            error: 'Failed to fetch snapshot weeks'
        });
    } finally {
        await db.close();
    }
});

// Get roster snapshot for a specific team and week
router.get('/team/:teamId/week/:week/:season?', async (req, res) => {
    const db = new DatabaseManager();
    
    try {
        const teamId = parseInt(req.params.teamId);
        const week = parseInt(req.params.week);
        const season = parseInt(req.params.season) || 2024;
        
        if (!teamId || !week) {
            return res.status(400).json({
                success: false,
                error: 'Team ID and week are required'
            });
        }
        
        const roster = await db.getTeamWeeklyRoster(teamId, week, season);
        
        if (roster.length === 0) {
            return res.status(404).json({
                success: false,
                error: `No roster snapshot found for team ${teamId}, week ${week}`
            });
        }
        
        // Group roster by position
        const groupedRoster = {
            starters: roster.filter(p => p.roster_position === 'starter'),
            bench: roster.filter(p => p.roster_position === 'bench'),
            injured_reserve: roster.filter(p => p.roster_position === 'injured_reserve')
        };
        
        const teamInfo = roster[0];
        
        res.json({
            success: true,
            team: {
                team_id: teamInfo.team_id,
                team_name: teamInfo.team_name,
                owner_name: teamInfo.owner_name
            },
            week,
            season,
            roster: groupedRoster,
            total_players: roster.length,
            snapshot_date: teamInfo.snapshot_date
        });
        
    } catch (error) {
        logError(error, `GET /api/roster-history/team/${req.params.teamId}/week/${req.params.week}`);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch team weekly roster'
        });
    } finally {
        await db.close();
    }
});

// Get all teams' rosters for a specific week
router.get('/week/:week/:season?', async (req, res) => {
    const db = new DatabaseManager();
    
    try {
        const week = parseInt(req.params.week);
        const season = parseInt(req.params.season) || 2024;
        
        if (!week) {
            return res.status(400).json({
                success: false,
                error: 'Week is required'
            });
        }
        
        const allRosters = await db.getAllTeamsWeeklyRosters(week, season);
        
        if (allRosters.length === 0) {
            return res.status(404).json({
                success: false,
                error: `No roster snapshots found for week ${week}`
            });
        }
        
        // Group by team
        const teamRosters = {};
        allRosters.forEach(player => {
            if (!teamRosters[player.team_id]) {
                teamRosters[player.team_id] = {
                    team_id: player.team_id,
                    team_name: player.team_name,
                    owner_name: player.owner_name,
                    players: {
                        starters: [],
                        bench: [],
                        injured_reserve: []
                    }
                };
            }
            
            teamRosters[player.team_id].players[player.roster_position].push({
                player_id: player.player_id,
                player_name: player.player_name,
                player_position: player.player_position,
                player_team: player.player_team
            });
        });
        
        res.json({
            success: true,
            week,
            season,
            teams: Object.values(teamRosters),
            total_entries: allRosters.length,
            snapshot_date: allRosters[0].snapshot_date
        });
        
    } catch (error) {
        logError(error, `GET /api/roster-history/week/${req.params.week}`);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch weekly rosters'
        });
    } finally {
        await db.close();
    }
});

// Get roster changes between two weeks for a team
router.get('/changes/:teamId/:fromWeek/:toWeek/:season?', async (req, res) => {
    const db = new DatabaseManager();
    
    try {
        const teamId = parseInt(req.params.teamId);
        const fromWeek = parseInt(req.params.fromWeek);
        const toWeek = parseInt(req.params.toWeek);
        const season = parseInt(req.params.season) || 2024;
        
        if (!teamId || !fromWeek || !toWeek) {
            return res.status(400).json({
                success: false,
                error: 'Team ID, from week, and to week are required'
            });
        }
        
        const changes = await db.getRosterChangesBetweenWeeks(teamId, fromWeek, toWeek, season);
        const team = await db.getTeam(teamId);
        
        res.json({
            success: true,
            team: {
                team_id: team.team_id,
                team_name: team.team_name,
                owner_name: team.owner_name
            },
            fromWeek,
            toWeek,
            season,
            changes: {
                added: changes.added,
                dropped: changes.dropped,
                moved: changes.moved
            },
            summary: {
                players_added: changes.added.length,
                players_dropped: changes.dropped.length,
                position_changes: changes.moved.length
            }
        });
        
    } catch (error) {
        logError(error, `GET /api/roster-history/changes/${req.params.teamId}/${req.params.fromWeek}/${req.params.toWeek}`);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch roster changes'
        });
    } finally {
        await db.close();
    }
});

// Get player history across weeks
router.get('/player/:playerId/:season?', async (req, res) => {
    const db = new DatabaseManager();
    
    try {
        const playerId = req.params.playerId;
        const season = parseInt(req.params.season) || 2024;
        
        if (!playerId) {
            return res.status(400).json({
                success: false,
                error: 'Player ID is required'
            });
        }
        
        const history = await db.getPlayerRosterHistory(playerId, season);
        
        if (history.length === 0) {
            return res.status(404).json({
                success: false,
                error: `No roster history found for player ${playerId}`
            });
        }
        
        const playerInfo = history[0];
        
        res.json({
            success: true,
            player: {
                player_id: playerInfo.player_id,
                player_name: playerInfo.player_name,
                player_position: playerInfo.player_position,
                player_team: playerInfo.player_team
            },
            season,
            history: history.map(entry => ({
                week: entry.week,
                team_id: entry.team_id,
                team_name: entry.team_name,
                owner_name: entry.owner_name,
                roster_position: entry.roster_position,
                snapshot_date: entry.snapshot_date
            })),
            weeks_tracked: history.length
        });
        
    } catch (error) {
        logError(error, `GET /api/roster-history/player/${req.params.playerId}`);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch player history'
        });
    } finally {
        await db.close();
    }
});

// Capture roster snapshot for current week (admin function)
router.post('/capture/:week?/:season?', async (req, res) => {
    const db = new DatabaseManager();
    
    try {
        let week, season;
        
        if (req.params.week) {
            week = parseInt(req.params.week);
            season = parseInt(req.params.season) || 2024;
        } else {
            // Use current week from league settings
            const leagueSettings = await db.getLeagueSettings();
            week = leagueSettings.current_week;
            season = leagueSettings.season_year;
        }
        
        const entriesCount = await db.captureWeeklyRosterSnapshot(week, season);
        
        logInfo(`Roster snapshot captured for week ${week}, season ${season} - ${entriesCount} entries`);
        
        res.json({
            success: true,
            message: `Roster snapshot captured successfully`,
            week,
            season,
            entries_captured: entriesCount
        });
        
    } catch (error) {
        logError(error, 'POST /api/roster-history/capture');
        res.status(500).json({
            success: false,
            error: 'Failed to capture roster snapshot'
        });
    } finally {
        await db.close();
    }
});

// Check if snapshot exists for a week
router.get('/exists/:week/:season?', async (req, res) => {
    const db = new DatabaseManager();
    
    try {
        const week = parseInt(req.params.week);
        const season = parseInt(req.params.season) || 2024;
        
        if (!week) {
            return res.status(400).json({
                success: false,
                error: 'Week is required'
            });
        }
        
        const exists = await db.hasWeeklySnapshot(week, season);
        
        res.json({
            success: true,
            week,
            season,
            exists
        });
        
    } catch (error) {
        logError(error, `GET /api/roster-history/exists/${req.params.week}`);
        res.status(500).json({
            success: false,
            error: 'Failed to check snapshot existence'
        });
    } finally {
        await db.close();
    }
});

module.exports = router;