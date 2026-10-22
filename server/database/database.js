const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const { Validator, ValidationError } = require('./validation');
const { DatabaseError, logError, logInfo } = require('../utils/errorHandler');
const { getTeamAbbreviation } = require('../utils/teamMappings');

// Generous upper bound on an NFL game's length; a week is over once its last game is
const GAME_LENGTH_SECONDS = 5 * 60 * 60;

class DatabaseManager {
    /**
     * @param {object} [options]
     * @param {object} [options.nflEligibilityService] NFL.com IR eligibility
     *   gate (server/services/nflRosterEligibilityService.js). Injected by
     *   app.js; tests inject a fake. See getNflEligibilityService().
     */
    constructor(options = {}) {
        // Distinguish an explicitly injected null (tests/fail-closed callers)
        // from an omitted option (production may lazily construct the gate).
        this.nflEligibilityServiceConfigured = Object.prototype.hasOwnProperty.call(options, 'nflEligibilityService');
        if (this.nflEligibilityServiceConfigured) {
            this.nflEligibilityService = options.nflEligibilityService || null;
        }
        const dbPath = process.env.DATABASE_PATH || './fantasy_football.db';
        const absolutePath = path.resolve(dbPath);
        
        console.log('Database path:', dbPath);
        console.log('Absolute path:', absolutePath);
        console.log('Current working directory:', process.cwd());
        console.log('Database file exists:', fs.existsSync(absolutePath));
        
        // Resolved once pragmas + schema init have finished (or been skipped);
        // close() waits on it so shutdown can't race the init chain.
        this.initComplete = new Promise(resolve => { this._initResolve = resolve; });

        this.db = new sqlite3.Database(absolutePath, (err) => {
            if (err) {
                console.error('Error opening database:', err);
                console.error('Database path was:', absolutePath);
                this._initResolve();
                throw new DatabaseError('Failed to connect to database', 'connect');
            } else {
                console.log('Connected to SQLite database at:', absolutePath);
                // serialize(): the driver defaults to parallel execution, so on
                // a fresh database the WAL pragma could interleave with the
                // multi-statement schema exec and fail with "cannot change into
                // wal mode from within a transaction"
                this.db.serialize(() => {
                    this.db.run('PRAGMA foreign_keys = ON');
                    this.db.run('PRAGMA journal_mode = WAL');
                    this.initializeDatabase();
                });
            }
        });
    }

    initializeDatabase() {
        const schemaPath = path.join(__dirname, 'schema.sql');
        
        console.log('Initializing database with schema from:', schemaPath);
        console.log('NODE_ENV:', process.env.NODE_ENV);
        
        // In production, skip schema initialization to preserve data
        if (process.env.NODE_ENV === 'production') {
            console.log('Production mode: Skipping schema initialization');
            this._initResolve();
            return;
        }

        try {
            const schema = fs.readFileSync(schemaPath, 'utf8');

            this.db.exec(schema, (err) => {
                if (err) {
                    // NB: don't throw here - an exception inside an async
                    // sqlite3 callback is uncatchable and kills the process
                    console.error('Error initializing database:', err);
                } else {
                    console.log('Database initialized successfully');
                }
                this._initResolve();
            });
        } catch (err) {
            console.error('Error reading schema file:', err);
            this._initResolve();
            throw new DatabaseError('Failed to read database schema', 'schema_read');
        }
    }

    // Promise wrapper for database operations
    run(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function(err) {
                if (err) {
                    logError(err, `DatabaseManager.run - SQL: ${sql}`);
                    reject(new DatabaseError(err.message, 'run'));
                } else {
                    resolve({ id: this.lastID, changes: this.changes });
                }
            });
        });
    }

    get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) {
                    logError(err, `DatabaseManager.get - SQL: ${sql}`);
                    reject(new DatabaseError(err.message, 'get'));
                } else {
                    resolve(row);
                }
            });
        });
    }

    all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    logError(err, `DatabaseManager.all - SQL: ${sql}`);
                    reject(new DatabaseError(err.message, 'all'));
                } else {
                    resolve(rows);
                }
            });
        });
    }

    // Transaction support
    beginTransaction() {
        return this.run('BEGIN TRANSACTION');
    }

    commit() {
        return this.run('COMMIT');
    }

    rollback() {
        return this.run('ROLLBACK');
    }

    // Team methods
    async getAllTeams() {
        return this.all('SELECT * FROM teams ORDER BY wins DESC, losses ASC, total_points DESC');
    }

    async getTeam(teamId) {
        return this.get('SELECT * FROM teams WHERE team_id = ?', [teamId]);
    }

    async updateTeamStats(teamId, wins, losses, ties, totalPoints) {
        return this.run(
            'UPDATE teams SET wins = ?, losses = ?, ties = ?, total_points = ? WHERE team_id = ?',
            [wins, losses, ties, totalPoints, teamId]
        );
    }

    // Player methods
    async getAllPlayers() {
        return this.all('SELECT * FROM nfl_players ORDER BY position, name');
    }

    async getPlayersByPosition(position) {
        return this.all('SELECT * FROM nfl_players WHERE position = ? ORDER BY name', [position]);
    }

    async upsertPlayer(playerId, name, position, team, byeWeek, injuryDesignation = null, injuryDescription = null, injuryDate = null, injuryReturnDate = null) {
        const playerData = { player_id: playerId, name, position, team, bye_week: byeWeek };
        Validator.validatePlayer(playerData);
        
        return this.run(`
            INSERT OR REPLACE INTO nfl_players (player_id, name, position, team, bye_week, injury_designation, injury_description, injury_date, injury_return_date, last_updated)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `, [playerId, name, position, team, byeWeek, injuryDesignation, injuryDescription, injuryDate, injuryReturnDate]);
    }

    // Bulk player insert for API updates
    async upsertPlayersBulk(players) {
        try {
            await this.beginTransaction();
            
            for (const player of players) {
                await this.upsertPlayer(
                    player.player_id, 
                    player.name, 
                    player.position, 
                    player.team, 
                    player.bye_week,
                    player.injury_designation,
                    player.injury_description,
                    player.injury_date,
                    player.injury_return_date
                );
            }
            
            await this.commit();
            logInfo(`Bulk upserted ${players.length} players`);
        } catch (error) {
            await this.rollback();
            throw error;
        }
    }

    // Roster methods
    async getTeamRoster(teamId, week = null, season = null) {
        // Get current season and week if not provided
        const { season: leagueSeason, week: leagueWeek } = await this.getCurrentSeasonAndWeek();
        const currentSeason = season || leagueSeason;
        let currentWeek = week;
        
        if (!currentWeek) {
            const latestWeek = await this.get(`
                SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
            `, [currentSeason]);
            currentWeek = latestWeek.week;
        }
        
        const query = `
            SELECT 
                r.weekly_roster_id as roster_id,
                r.team_id,
                r.player_id,
                CASE 
                    WHEN r.roster_position = 'injured_reserve' THEN 'injured_reserve'
                    ELSE 'active'
                END as roster_position,
                r.player_name as name,
                r.player_position as position,
                COALESCE(p.team, r.player_team) as team,
                p.bye_week,
                r.snapshot_date as acquisition_date,
                r.is_scoring,
                r.scoring_slot,
                r.ir_date
            FROM weekly_rosters r
            LEFT JOIN nfl_players p ON r.player_id = p.player_id
            WHERE r.team_id = ? AND r.week = ? AND r.season = ?
            ORDER BY 
                CASE r.player_position 
                    WHEN 'QB' THEN 1 
                    WHEN 'RB' THEN 2 
                    WHEN 'WR' THEN 3 
                    WHEN 'TE' THEN 4 
                    WHEN 'K' THEN 5
                    WHEN 'Defense' THEN 6
                    ELSE 7 
                END,
                r.roster_position DESC,
                r.player_name
        `;
        const roster = await this.all(query, [teamId, currentWeek, currentSeason]);
        
        // Convert team names to abbreviations
        return roster.map(player => ({
            ...player,
            team: getTeamAbbreviation(player.team)
        }));
    }

    async addPlayerToRoster(teamId, playerId, rosterPosition = 'active') {
        // Get current season and latest week
        const { season: currentSeason } = await this.getCurrentSeasonAndWeek();
        const latestWeek = await this.get(`
            SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
        `, [currentSeason]);
        
        // Check if player is already on another team in current week
        const existing = await this.get(`
            SELECT team_id FROM weekly_rosters 
            WHERE player_id = ? AND week = ? AND season = ?
              AND roster_position != 'injured_reserve'
        `, [playerId, latestWeek.week, currentSeason]);
        
        if (existing) {
            throw new DatabaseError(`Player is already on team ${existing.team_id}`, 'roster_constraint');
        }
        
        // Get player info for denormalized data
        const player = await this.get('SELECT * FROM nfl_players WHERE player_id = ?', [playerId]);
        
        if (!player) {
            throw new DatabaseError('Player not found', 'not_found');
        }
        
        return this.run(`
            INSERT INTO weekly_rosters (team_id, player_id, week, season, roster_position,
                                       player_name, player_position, player_team)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [teamId, playerId, latestWeek.week, currentSeason, rosterPosition,
            player.name, player.position, getTeamAbbreviation(player.team)]);
    }

    async removePlayerFromRoster(teamId, playerId) {
        // Get current season and latest week
        const { season: currentSeason } = await this.getCurrentSeasonAndWeek();
        const latestWeek = await this.get(`
            SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
        `, [currentSeason]);
        
        return this.run(`
            DELETE FROM weekly_rosters 
            WHERE team_id = ? AND player_id = ? AND week = ? AND season = ?
        `, [teamId, playerId, latestWeek.week, currentSeason]);
    }

    async updateRosterPosition(teamId, playerId, rosterPosition) {
        // Get current season and latest week
        const { season: currentSeason } = await this.getCurrentSeasonAndWeek();
        const latestWeek = await this.get(`
            SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
        `, [currentSeason]);
        
        // If moving to IR, set the ir_date
        if (rosterPosition === 'injured_reserve') {
            return this.run(`
                UPDATE weekly_rosters 
                SET roster_position = ?, ir_date = CURRENT_TIMESTAMP
                WHERE team_id = ? AND player_id = ? AND week = ? AND season = ?
            `, [rosterPosition, teamId, playerId, latestWeek.week, currentSeason]);
        } else {
            // If moving off IR, clear the ir_date
            return this.run(`
                UPDATE weekly_rosters 
                SET roster_position = ?, ir_date = NULL
                WHERE team_id = ? AND player_id = ? AND week = ? AND season = ?
            `, [rosterPosition, teamId, playerId, latestWeek.week, currentSeason]);
        }
    }

    // Check if a player is available (returns detailed info)
    async isPlayerAvailable(playerId) {
        // Get current season and latest week
        const { season: currentSeason } = await this.getCurrentSeasonAndWeek();
        const latestWeek = await this.get(`
            SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
        `, [currentSeason]);

        // Check if player exists
        const player = await this.get(`
            SELECT player_id, name, position, team FROM nfl_players WHERE player_id = ?
        `, [playerId]);

        if (!player) {
            return {
                available: false,
                reason: 'Player not found in database',
                player: null
            };
        }

        // Check if player is on another team
        const ownership = await this.get(`
            SELECT wr.*, t.team_name, t.owner_name
            FROM weekly_rosters wr
            JOIN teams t ON wr.team_id = t.team_id
            WHERE wr.player_id = ? AND wr.week = ? AND wr.season = ?
              AND wr.roster_position != 'injured_reserve'
        `, [playerId, latestWeek.week, currentSeason]);

        if (ownership) {
            return {
                available: false,
                reason: `Player is already on ${ownership.team_name} (owned by ${ownership.owner_name})`,
                player: player,
                currentTeam: ownership.team_name,
                currentOwner: ownership.owner_name
            };
        }

        return {
            available: true,
            reason: null,
            player: player
        };
    }

    /**
     * Inject the NFL.com eligibility gate used for ordinary IR moves.
     */
    setNflEligibilityService(service) {
        this.nflEligibilityServiceConfigured = true;
        this.nflEligibilityService = service || null;
    }

    /**
     * The NFL.com gate for IR moves. Lazily builds the real service outside
     * tests; under NODE_ENV=test it must be injected, so no test can reach
     * the network by accident (an IR validation without a service fails
     * closed).
     */
    getNflEligibilityService() {
        const explicitlyConfigured = this.nflEligibilityServiceConfigured === true
            || (this.nflEligibilityServiceConfigured === undefined
                && Object.prototype.hasOwnProperty.call(this, 'nflEligibilityService'));
        if (!this.nflEligibilityService && !explicitlyConfigured && process.env.NODE_ENV !== 'test') {
            const NflRosterEligibilityService = require('../services/nflRosterEligibilityService');
            this.nflEligibilityService = new NflRosterEligibilityService();
        }
        return this.nflEligibilityService || null;
    }

    /**
     * Fail-closed NFL.com check for placing dropPlayer on IR (moveType 'ir').
     * Always a fresh fetch - never cached, never Tank01, never
     * nfl_players.injury_designation. Returns structured evidence; on failure
     * the evidence has eligible:false plus the error to report.
     */
    async checkIrEligibility(dropPlayer, season, week) {
        const service = this.getNflEligibilityService();
        const checkedAt = new Date().toISOString();
        if (!service || typeof service.checkIrEligibility !== 'function') {
            const reason = 'Validation failed: fresh NFL.com data unavailable (NFL eligibility service not configured)';
            return { eligible: false, code: 'NFL_UNAVAILABLE', reason, error: reason, checkedAt, source: 'nfl.com', sources: [] };
        }
        try {
            const evidence = await service.checkIrEligibility({
                playerName: dropPlayer.name,
                team: dropPlayer.team,
                season,
                week
            });
            if (!evidence || evidence.eligible !== true) {
                const reason = 'Validation failed: fresh NFL.com data unavailable (eligibility service returned no positive evidence)';
                return { eligible: false, code: 'NFL_UNAVAILABLE', reason, error: reason, checkedAt, source: 'nfl.com', sources: [] };
            }
            return evidence;
        } catch (error) {
            const code = error && (error.code === 'NFL_INELIGIBLE' || error.code === 'NFL_UNAVAILABLE') ? error.code : 'NFL_UNAVAILABLE';
            const message = code === 'NFL_UNAVAILABLE' && !/^Validation failed: fresh NFL\.com data unavailable/.test(error && error.message || '')
                ? `Validation failed: fresh NFL.com data unavailable (${(error && error.message) || 'unknown error'})`
                : error.message;
            const evidence = (error && error.evidence) || {};
            return { ...evidence, eligible: false, code, reason: message, error: message, checkedAt: evidence.checkedAt || checkedAt, source: 'nfl.com', sources: evidence.sources || [] };
        }
    }

    // Read-only dry-run of all pre-transaction roster move checks.
    // Returns { valid, errors, context } - context carries the lookups so
    // executeRosterMove can reuse them without re-querying. Used both by
    // executeRosterMove and by the pending email-move queue to show
    // "would pass / would fail" before the commissioner approves.
    /**
     * Drop lock: a player cannot be dropped (or traded away) once his NFL
     * team's game for the current week has kicked off, judged at the moment
     * the OWNER asked - options.asOf (the email's Date header for email
     * moves); manual moves are judged now. Returns null when the drop is
     * allowed, otherwise the error string. Bye week / no schedule row: allowed.
     */
    async checkDropLock(player, season, week, asOf = null) {
        const parsed = asOf ? Date.parse(asOf) : NaN;
        const atMs = Number.isNaN(parsed) ? Date.now() : parsed;
        const team = getTeamAbbreviation(player.team);
        if (!team) return null;
        const game = await this.get(`
            SELECT game_id, game_date, game_time, game_time_epoch, status FROM nfl_games
            WHERE season = ? AND week = ? AND (home_team = ? OR away_team = ?)
        `, [season, week, team, team]);
        if (!game) return null;
        const kickoffMs = game.game_time_epoch ? Number(game.game_time_epoch) * 1000 : null;
        // No kickoff time on file: only a manual (now) request can be judged by status
        const started = kickoffMs != null
            ? atMs >= kickoffMs
            : (!asOf && Boolean(game.status) && !/^scheduled$/i.test(game.status));
        if (!started) return null;
        const kickoff = kickoffMs != null ? new Date(kickoffMs).toISOString() : `status ${game.status}`;
        return `Cannot drop ${player.name}: ${team} already played this week (${game.game_id} kicked off ${kickoff}; request made ${new Date(atMs).toISOString()})`;
    }

    /**
     * Fail-closed fallback for DELAYED EMAIL APPROVAL ONLY. The queue passes
     * the immutable evidence its enqueue dry-run gathered seconds after the
     * owner asked (options.enqueueEvidence); the admin form never does, so a
     * manual move can never reach this. Returns { accepted: true, evidence }
     * only when every one of these holds, otherwise { accepted: false, reason }:
     *   - the fresh check failed as NFL_UNAVAILABLE (could not be completed:
     *     page identity mismatch, fetch failure...). A definitive
     *     NFL_INELIGIBLE is NFL.com's answer and is never overridden.
     *   - the enqueue evidence is a positive NFL.com verdict (eligible:true
     *     with an OUT_ON_INJURY_REPORT / RESERVE_INJURED code)
     *   - same season, same judged week, same player (name + NFL team, and
     *     player_id when the queue recorded it), and the request's asOf is
     *     exactly the asOf the enqueue evidence was judged at.
     * The accepted evidence keeps the original verdict and records
     * basis:'enqueue' plus the fresh failure it stood in for, so the audit
     * trail shows which NFL.com fetch actually decided the move.
     */
    static acceptEnqueueEvidence(enqueueEvidence, fresh, { season, judgedWeek, asOf, dropPlayer, dropPlayerId }) {
        const reject = reason => ({ accepted: false, reason });
        if (!fresh || fresh.code !== 'NFL_UNAVAILABLE') {
            return reject(`fresh NFL.com check answered ${fresh && fresh.code ? fresh.code : 'without a code'}, which is not NFL_UNAVAILABLE`);
        }
        if (!enqueueEvidence || typeof enqueueEvidence !== 'object') return reject('no enqueue evidence');
        const nfl = enqueueEvidence.nflEligibility;
        const positive = ['OUT_ON_INJURY_REPORT', 'RESERVE_INJURED'];
        if (!nfl || nfl.eligible !== true || !positive.includes(nfl.code)) {
            return reject('enqueue evidence is not a positive NFL.com verdict');
        }
        const requestMs = asOf ? Date.parse(asOf) : NaN;
        const evidenceMs = enqueueEvidence.asOf ? Date.parse(enqueueEvidence.asOf) : NaN;
        if (Number.isNaN(requestMs) || Number.isNaN(evidenceMs) || requestMs !== evidenceMs) {
            return reject(`request asOf ${asOf || 'missing'} does not match enqueue evidence asOf ${enqueueEvidence.asOf || 'missing'}`);
        }
        if (Number(nfl.season) !== Number(season)) {
            return reject(`enqueue evidence is for season ${nfl.season}, judging ${season}`);
        }
        if (!Number.isInteger(Number(nfl.week)) || Number(nfl.week) !== Number(judgedWeek)) {
            return reject(`enqueue evidence is for Week ${nfl.week}, judging Week ${judgedWeek}`);
        }
        if (enqueueEvidence.dropPlayerId != null && String(enqueueEvidence.dropPlayerId) !== String(dropPlayerId)) {
            return reject(`enqueue evidence is for player ${enqueueEvidence.dropPlayerId}, judging ${dropPlayerId}`);
        }
        const norm = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const player = nfl.player || {};
        if (!norm(player.name) || norm(player.name) !== norm(dropPlayer && dropPlayer.name)) {
            return reject(`enqueue evidence names ${player.name || 'nobody'}, judging ${dropPlayer && dropPlayer.name}`);
        }
        const evidenceTeam = getTeamAbbreviation(player.team) || null;
        const playerTeam = getTeamAbbreviation(dropPlayer && dropPlayer.team) || null;
        if (!evidenceTeam || !playerTeam || evidenceTeam !== playerTeam) {
            return reject(`enqueue evidence team ${player.team || 'unknown'} does not match ${dropPlayer && dropPlayer.team ? dropPlayer.team : 'unknown'}`);
        }
        const checkedAt = nfl.checkedAt || enqueueEvidence.checkedAt || null;
        return {
            accepted: true,
            evidence: {
                ...nfl,
                eligible: true,
                basis: 'enqueue',
                legacy: enqueueEvidence.legacy === true,
                reason: `Accepted enqueue-time NFL.com evidence${checkedAt ? ` checked ${checkedAt}` : ''}: ${nfl.reason}. Fresh check at approval: ${fresh.reason || fresh.error}`,
                enqueueCheckedAt: checkedAt,
                freshCheck: { ...fresh }
            }
        };
    }

    /**
     * The NFL week the owner was in when he asked (asOf): the earliest week
     * of the season whose last game had not yet ended at that moment, never
     * later than the roster week the move executes on. A request made in
     * Week 5 and approved in Week 6 is still judged on Week 5 (its injury
     * report, its kickoffs). No asOf (manual move) or no schedule on file:
     * the roster week, i.e. execution-time behaviour.
     */
    async weekInEffectAt(season, asOf, rosterWeek) {
        const atMs = asOf ? Date.parse(asOf) : NaN;
        if (Number.isNaN(atMs)) return rosterWeek;
        const row = await this.get(`
            SELECT week FROM nfl_games
            WHERE season = ? AND game_time_epoch IS NOT NULL
            GROUP BY week
            HAVING MAX(game_time_epoch) + ? > ?
            ORDER BY week LIMIT 1
        `, [season, GAME_LENGTH_SECONDS, Math.floor(atMs / 1000)]);
        const week = row ? Number(row.week) : NaN;
        if (!Number.isFinite(week) || week <= 0) return rosterWeek;
        return Number.isFinite(rosterWeek) ? Math.min(week, rosterWeek) : week;
    }

    async validateRosterMove(teamId, dropPlayerId, addPlayerId, moveType, options = {}) {
        const errors = [];
        const { season: currentSeason } = await this.getCurrentSeasonAndWeek();
        const latestWeek = await this.get(`
            SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
        `, [currentSeason]);
        // Time-dependent rules (drop lock, NFL.com IR gate) are judged in the
        // week the owner asked, not whatever week approval drifted into
        const asOf = options.asOf || null;
        const judgedWeek = await this.weekInEffectAt(currentSeason, asOf, latestWeek && latestWeek.week);

        // Get player info for both players
        const [dropPlayer, addPlayer] = await Promise.all([
            this.get('SELECT * FROM nfl_players WHERE player_id = ?', [dropPlayerId]),
            this.get('SELECT * FROM nfl_players WHERE player_id = ?', [addPlayerId])
        ]);

        const context = {
            currentSeason,
            latestWeek,
            dropPlayer,
            addPlayer,
            playerOnIR: null,
            nflEligibility: null,
            asOf,
            judgedWeek
        };

        if (!dropPlayer || !addPlayer) {
            errors.push('One or both players not found');
            return { valid: false, errors, context };
        }

        // Verify drop player is on the team
        const onRoster = await this.get(`
            SELECT * FROM weekly_rosters
            WHERE team_id = ? AND player_id = ? AND week = ? AND season = ?
        `, [teamId, dropPlayerId, latestWeek.week, currentSeason]);

        if (!onRoster) {
            errors.push('Player to drop is not on this team');
        }

        // Drop lock for every drop type, judged at request time (email Date header / now) in the week in effect then
        const dropLock = await this.checkDropLock(dropPlayer, currentSeason, judgedWeek, asOf);
        context.dropLock = dropLock;
        if (dropLock) errors.push(dropLock);

        // Ordinary IR move: the dropped player must be injury-eligible per
        // fresh NFL.com data (Game Status exactly "Out" on the injury report
        // of the week the owner asked, or current RES/RSR + Reserve/Injured
        // transaction). This is the single gate for both email approval and
        // manual execution; the email parser never decides eligibility.
        if (moveType === 'ir') {
            let evidence = await this.checkIrEligibility(dropPlayer, currentSeason, judgedWeek);
            // Delayed email approval only: when the fresh check could not be
            // completed (never when it said "not hurt"), the immutable
            // enqueue-time NFL.com evidence may stand in, provided it is for
            // this season, this judged week, this player and this asOf.
            if (!evidence.eligible && options.enqueueEvidence) {
                const fallback = DatabaseManager.acceptEnqueueEvidence(options.enqueueEvidence, evidence, {
                    season: currentSeason, judgedWeek, asOf, dropPlayer, dropPlayerId
                });
                if (fallback.accepted) {
                    evidence = fallback.evidence;
                } else {
                    evidence = { ...evidence, enqueueEvidenceRejected: fallback.reason };
                }
            }
            context.nflEligibility = evidence;
            if (!evidence.eligible) {
                errors.push(evidence.error || evidence.reason || 'Validation failed: fresh NFL.com data unavailable (no evidence)');
            }
        }

        // Verify add player is available
        const availability = await this.isPlayerAvailable(addPlayerId);
        if (!availability.available) {
            errors.push(availability.reason || 'Player to add is not available');
        }

        // Check if player is being brought back from IR on this team
        const playerOnIR = await this.get(`
            SELECT * FROM weekly_rosters
            WHERE team_id = ? AND player_id = ? AND week = ? AND season = ?
                AND roster_position = 'injured_reserve'
        `, [teamId, addPlayerId, latestWeek.week, currentSeason]);
        context.playerOnIR = playerOnIR;

        // If move type is 'ir_return', validate player is on IR
        if (moveType === 'ir_return' && !playerOnIR) {
            errors.push('Cannot perform IR return - player is not on this team\'s injured reserve');
        }

        // If bringing back from IR, validate 3-week minimum
        if (playerOnIR) {
            // Find when player was moved to IR (they would be the dropped player)
            const irMove = await this.get(`
                SELECT week FROM roster_moves
                WHERE team_id = ? AND dropped_player_id = ? AND move_type = 'ir'
                    AND season = ?
                ORDER BY week DESC LIMIT 1
            `, [teamId, addPlayerId, currentSeason]);

            if (irMove) {
                const weeksSinceIR = latestWeek.week - irMove.week;
                if (weeksSinceIR < 3) {
                    errors.push(`Player must be on IR for at least 3 weeks before returning (currently ${weeksSinceIR} weeks)`);
                }
            }
        }

        return { valid: errors.length === 0, errors, context };
    }

    /** roster_moves.notes text for a commissioner override: the reason and every check it overrode. */
    static overrideNote(reason, overriddenErrors) {
        const why = String(reason || '').trim() || 'no reason given';
        return `Commissioner override: ${why}. Overrode validation: ${(overriddenErrors || []).join('; ')}`;
    }

    // Execute a paired roster move (drop + add)
    //
    // options.overrideValidation (commissioner override, email queue only):
    // when true, a move the validator refuses is still executed, the refused
    // checks are returned as result.overriddenErrors and written to
    // roster_moves.notes with options.overrideReason. "One or both players
    // not found" can never be overridden (there is nothing to execute), and
    // the 19-active-roster invariant inside the transaction still holds.
    async executeRosterMove(teamId, dropPlayerId, addPlayerId, moveType, options = {}) {
        const validation = await this.validateRosterMove(teamId, dropPlayerId, addPlayerId, moveType, options);
        const canOverride = options.overrideValidation === true &&
            validation.context.dropPlayer && validation.context.addPlayer;
        const overriddenErrors = !validation.valid && canOverride ? validation.errors.slice() : null;
        if (!validation.valid && !overriddenErrors) {
            // The reported error is errors[0]; classify by that same error so
            // the type always describes the message the caller sees (an IR
            // move can fail the roster check *and* the NFL.com gate).
            const nflEligibility = validation.context.nflEligibility || null;
            const nflError = nflEligibility && !nflEligibility.eligible
                ? (nflEligibility.error || nflEligibility.reason)
                : null;
            const errorType = validation.errors[0] === 'One or both players not found' ? 'not_found'
                : (nflError && validation.errors[0] === nflError) ? 'ir_eligibility'
                : 'roster_constraint';
            const error = new DatabaseError(validation.errors[0], errorType);
            error.nflEligibility = nflEligibility;
            throw error;
        }

        const { currentSeason, latestWeek, dropPlayer, addPlayer, playerOnIR, nflEligibility } = validation.context;

        // Start transaction
        await this.run('BEGIN TRANSACTION');

        try {
            // Handle drop player based on move type
            if (moveType === 'ir') {
                // Move player to injured_reserve
                await this.run(`
                    UPDATE weekly_rosters
                    SET roster_position = 'injured_reserve', ir_date = CURRENT_TIMESTAMP
                    WHERE team_id = ? AND player_id = ? AND week = ? AND season = ?
                `, [teamId, dropPlayerId, latestWeek.week, currentSeason]);
            } else if (moveType === 'ir_return') {
                // For IR return, drop player completely (player being brought back is the "add")
                await this.run(`
                    DELETE FROM weekly_rosters
                    WHERE team_id = ? AND player_id = ? AND week = ? AND season = ?
                `, [teamId, dropPlayerId, latestWeek.week, currentSeason]);
            } else {
                // For supplemental moves, remove the player
                await this.run(`
                    DELETE FROM weekly_rosters
                    WHERE team_id = ? AND player_id = ? AND week = ? AND season = ?
                `, [teamId, dropPlayerId, latestWeek.week, currentSeason]);
            }

            // Add the new player (or activate from IR)
            if (playerOnIR) {
                // Player is being brought back from IR - UPDATE their position
                await this.run(`
                    UPDATE weekly_rosters
                    SET roster_position = 'active', ir_date = NULL
                    WHERE team_id = ? AND player_id = ? AND week = ? AND season = ?
                `, [teamId, addPlayerId, latestWeek.week, currentSeason]);
            } else {
                // New player being added - INSERT
                await this.run(`
                    INSERT INTO weekly_rosters (team_id, player_id, week, season, roster_position,
                                               player_name, player_position, player_team)
                    VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
                `, [teamId, addPlayerId, latestWeek.week, currentSeason,
                    addPlayer.name, addPlayer.position, getTeamAbbreviation(addPlayer.team)]);
            }

            // Log the move (an override records what it overrode, for audit)
            await this.run(`
                INSERT INTO roster_moves (team_id, move_type,
                                         dropped_player_id, dropped_player_name, dropped_player_position,
                                         added_player_id, added_player_name, added_player_position,
                                         week, season, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [teamId, moveType,
                dropPlayerId, dropPlayer.name, dropPlayer.position,
                addPlayerId, addPlayer.name, addPlayer.position,
                latestWeek.week, currentSeason,
                overriddenErrors ? DatabaseManager.overrideNote(options.overrideReason, overriddenErrors) : null]);

            // Validate roster count is still 19 (excluding IR players)
            const rosterCount = await this.get(`
                SELECT COUNT(*) as count FROM weekly_rosters
                WHERE team_id = ? AND week = ? AND season = ?
                    AND roster_position != 'injured_reserve'
            `, [teamId, latestWeek.week, currentSeason]);

            if (rosterCount.count !== 19) {
                throw new DatabaseError(
                    `Roster move resulted in invalid active roster size: ${rosterCount.count} (expected 19)`,
                    'roster_constraint'
                );
            }

            // Commit transaction
            await this.run('COMMIT');

            return {
                success: true,
                dropped: dropPlayer,
                added: addPlayer,
                moveType: moveType,
                nflEligibility: nflEligibility || null,
                overriddenErrors
            };
        } catch (error) {
            // Rollback on error
            await this.run('ROLLBACK');
            throw error;
        }
    }

    // Helper function to validate position minimums for a team
    async validateTeamPositionMinimums(teamId, week, season) {
        const ROSTER_CONSTRAINTS = {
            QB: { min: 2 },
            RB: { min: 5 },
            WR_TE_COMBINED: { min: 6 },
            K: { min: 2 },
            DST: { min: 2 }
        };

        // Get roster counts by position (active players only)
        const roster = await this.all(`
            SELECT p.position, COUNT(*) as count
            FROM weekly_rosters r
            JOIN nfl_players p ON r.player_id = p.player_id
            WHERE r.team_id = ?
              AND r.week = ?
              AND r.season = ?
              AND r.roster_position = 'active'
            GROUP BY p.position
        `, [teamId, week, season]);

        const counts = {};
        roster.forEach(row => {
            counts[row.position] = parseInt(row.count);
        });

        // Validate each position minimum
        if ((counts.QB || 0) < ROSTER_CONSTRAINTS.QB.min) {
            return { valid: false, reason: `Team must have at least ${ROSTER_CONSTRAINTS.QB.min} QBs` };
        }
        if ((counts.RB || 0) < ROSTER_CONSTRAINTS.RB.min) {
            return { valid: false, reason: `Team must have at least ${ROSTER_CONSTRAINTS.RB.min} RBs` };
        }
        if ((counts.K || 0) < ROSTER_CONSTRAINTS.K.min) {
            return { valid: false, reason: `Team must have at least ${ROSTER_CONSTRAINTS.K.min} Kickers` };
        }
        if ((counts.DST || 0) < ROSTER_CONSTRAINTS.DST.min) {
            return { valid: false, reason: `Team must have at least ${ROSTER_CONSTRAINTS.DST.min} Defenses` };
        }

        // Check WR+TE combined
        const wrTeCount = (counts.WR || 0) + (counts.TE || 0);
        if (wrTeCount < ROSTER_CONSTRAINTS.WR_TE_COMBINED.min) {
            return { valid: false, reason: `Team must have at least ${ROSTER_CONSTRAINTS.WR_TE_COMBINED.min} WRs and TEs combined` };
        }

        return { valid: true };
    }

    // Execute a trade between two teams
    async executeTrade(team1Id, team1PlayerId, team2Id, team2PlayerId, options = {}) {
        const { season: currentSeason } = await this.getCurrentSeasonAndWeek();
        const latestWeek = await this.get(`
            SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
        `, [currentSeason]);

        // Get player info for both players
        const [player1, player2] = await Promise.all([
            this.get('SELECT * FROM nfl_players WHERE player_id = ?', [team1PlayerId]),
            this.get('SELECT * FROM nfl_players WHERE player_id = ?', [team2PlayerId])
        ]);

        if (!player1 || !player2) {
            throw new DatabaseError('One or both players not found', 'not_found');
        }

        // Verify both players are on their respective teams (and active, not IR)
        const [player1OnTeam, player2OnTeam] = await Promise.all([
            this.get(`
                SELECT * FROM weekly_rosters
                WHERE team_id = ? AND player_id = ? AND week = ? AND season = ?
                    AND roster_position = 'active'
            `, [team1Id, team1PlayerId, latestWeek.week, currentSeason]),
            this.get(`
                SELECT * FROM weekly_rosters
                WHERE team_id = ? AND player_id = ? AND week = ? AND season = ?
                    AND roster_position = 'active'
            `, [team2Id, team2PlayerId, latestWeek.week, currentSeason])
        ]);

        if (!player1OnTeam) {
            throw new DatabaseError(`${player1.name} is not on team ${team1Id}'s active roster`, 'roster_constraint');
        }
        if (!player2OnTeam) {
            throw new DatabaseError(`${player2.name} is not on team ${team2Id}'s active roster`, 'roster_constraint');
        }

        // Neither side may trade away a player whose game has already kicked off (judged at request time).
        // A commissioner override (options.overrideValidation) records the lock instead of refusing.
        const overriddenErrors = [];
        for (const p of [player1, player2]) {
            const lock = await this.checkDropLock(p, currentSeason, latestWeek.week, options.asOf || null);
            if (!lock) continue;
            if (options.overrideValidation === true) overriddenErrors.push(lock);
            else throw new DatabaseError(lock, 'roster_constraint');
        }

        // Generate a unique trade ID
        const tradeId = `trade_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Start transaction
        await this.run('BEGIN TRANSACTION');

        try {
            // Remove player1 from team1
            await this.run(`
                DELETE FROM weekly_rosters
                WHERE team_id = ? AND player_id = ? AND week = ? AND season = ?
            `, [team1Id, team1PlayerId, latestWeek.week, currentSeason]);

            // Remove player2 from team2
            await this.run(`
                DELETE FROM weekly_rosters
                WHERE team_id = ? AND player_id = ? AND week = ? AND season = ?
            `, [team2Id, team2PlayerId, latestWeek.week, currentSeason]);

            // Add player2 to team1
            await this.run(`
                INSERT INTO weekly_rosters (team_id, player_id, week, season, roster_position,
                                           player_name, player_position, player_team)
                VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
            `, [team1Id, team2PlayerId, latestWeek.week, currentSeason,
                player2.name, player2.position, getTeamAbbreviation(player2.team)]);

            // Add player1 to team2
            await this.run(`
                INSERT INTO weekly_rosters (team_id, player_id, week, season, roster_position,
                                           player_name, player_position, player_team)
                VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
            `, [team2Id, team1PlayerId, latestWeek.week, currentSeason,
                player1.name, player1.position, getTeamAbbreviation(player1.team)]);

            // Validate roster counts (both teams should have 19 active players)
            const [team1Count, team2Count] = await Promise.all([
                this.get(`
                    SELECT COUNT(*) as count FROM weekly_rosters
                    WHERE team_id = ? AND week = ? AND season = ?
                        AND roster_position = 'active'
                `, [team1Id, latestWeek.week, currentSeason]),
                this.get(`
                    SELECT COUNT(*) as count FROM weekly_rosters
                    WHERE team_id = ? AND week = ? AND season = ?
                        AND roster_position = 'active'
                `, [team2Id, latestWeek.week, currentSeason])
            ]);

            if (team1Count.count !== 19) {
                throw new DatabaseError(
                    `Trade resulted in invalid roster size for team ${team1Id}: ${team1Count.count} (expected 19)`,
                    'roster_constraint'
                );
            }
            if (team2Count.count !== 19) {
                throw new DatabaseError(
                    `Trade resulted in invalid roster size for team ${team2Id}: ${team2Count.count} (expected 19)`,
                    'roster_constraint'
                );
            }

            // Validate position minimums for both teams
            const [team1Validation, team2Validation] = await Promise.all([
                this.validateTeamPositionMinimums(team1Id, latestWeek.week, currentSeason),
                this.validateTeamPositionMinimums(team2Id, latestWeek.week, currentSeason)
            ]);

            if (!team1Validation.valid) {
                throw new DatabaseError(
                    `Trade violates position minimums for team ${team1Id}: ${team1Validation.reason}`,
                    'roster_constraint'
                );
            }
            if (!team2Validation.valid) {
                throw new DatabaseError(
                    `Trade violates position minimums for team ${team2Id}: ${team2Validation.reason}`,
                    'roster_constraint'
                );
            }

            // Log the trade as a single move entry with both teams
            await this.run(`
                INSERT INTO roster_moves (team_id, move_type,
                                         dropped_player_id, dropped_player_name, dropped_player_position,
                                         added_player_id, added_player_name, added_player_position,
                                         week, season, partner_team_id, trade_id,
                                         notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [team1Id, 'trade',
                team1PlayerId, player1.name, player1.position,
                team2PlayerId, player2.name, player2.position,
                latestWeek.week, currentSeason, team2Id, tradeId,
                `Traded ${player1.name} to team ${team2Id} for ${player2.name}` +
                    (overriddenErrors.length ? `. ${DatabaseManager.overrideNote(options.overrideReason, overriddenErrors)}` : '')]);

            // Commit transaction
            await this.run('COMMIT');

            return {
                success: true,
                tradeId: tradeId,
                team1: {
                    teamId: team1Id,
                    gave: player1,
                    received: player2
                },
                team2: {
                    teamId: team2Id,
                    gave: player2,
                    received: player1
                },
                overriddenErrors: overriddenErrors.length ? overriddenErrors : null
            };
        } catch (error) {
            // Rollback on error
            await this.run('ROLLBACK');
            throw error;
        }
    }

    // Get all available players by position
    async getAvailablePlayersByPosition(position) {
        // Get current season and latest week
        const { season: currentSeason } = await this.getCurrentSeasonAndWeek();
        const latestWeek = await this.get(`
            SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
        `, [currentSeason]);

        return this.all(`
            SELECT p.*
            FROM nfl_players p
            LEFT JOIN weekly_rosters r ON p.player_id = r.player_id 
                AND r.week = ? AND r.season = ?
                AND r.roster_position != 'injured_reserve'
            WHERE p.position = ? AND r.player_id IS NULL
            ORDER BY p.name
        `, [latestWeek.week, currentSeason, position]);
    }

    // Check if team has an injured reserve player
    async hasInjuredReservePlayer(teamId) {
        // Get current season and latest week
        const { season: currentSeason } = await this.getCurrentSeasonAndWeek();
        const latestWeek = await this.get(`
            SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
        `, [currentSeason]);
        
        const result = await this.get(`
            SELECT COUNT(*) as count 
            FROM weekly_rosters 
            WHERE team_id = ? AND roster_position = 'injured_reserve'
              AND week = ? AND season = ?
        `, [teamId, latestWeek.week, currentSeason]);
        return result.count > 0;
    }

    // Get team's injured reserve player
    async getTeamInjuredReservePlayer(teamId) {
        // Get current season and latest week
        const { season: currentSeason } = await this.getCurrentSeasonAndWeek();
        const latestWeek = await this.get(`
            SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
        `, [currentSeason]);
        
        return this.get(`
            SELECT r.*, p.bye_week
            FROM weekly_rosters r
            LEFT JOIN nfl_players p ON r.player_id = p.player_id
            WHERE r.team_id = ? AND r.roster_position = 'injured_reserve'
              AND r.week = ? AND r.season = ?
        `, [teamId, latestWeek.week, currentSeason]);
    }

    // Stats methods
    async getPlayerStats(playerId, week, season) {
        return this.get(`
            SELECT * FROM player_stats 
            WHERE player_id = ? AND week = ? AND season = ?
        `, [playerId, week, season]);
    }

    async getPlayerStatsByWeek(week, season) {
        return this.all(`
            SELECT ps.*, p.name, p.position, p.team
            FROM player_stats ps
            JOIN nfl_players p ON ps.player_id = p.player_id
            WHERE ps.week = ? AND ps.season = ?
            ORDER BY ps.fantasy_points DESC
        `, [week, season]);
    }

    async upsertPlayerStats(stats) {
        const query = `
            INSERT OR REPLACE INTO player_stats 
            (player_id, week, season, game_id, passing_yards, passing_tds, interceptions,
             rushing_yards, rushing_tds, receiving_yards, receiving_tds, receptions,
             fumbles, sacks, def_interceptions, fumbles_recovered, def_touchdowns,
             safeties, points_allowed, yards_allowed, field_goals_made,
             field_goals_attempted, extra_points_made, extra_points_attempted,
             field_goals_0_39, field_goals_40_49, field_goals_50_plus,
             two_point_conversions_pass, two_point_conversions_run, two_point_conversions_rec,
             fantasy_points, last_updated)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `;
        
        return this.run(query, [
            stats.player_id, stats.week, stats.season, stats.game_id || null,
            stats.passing_yards || 0, stats.passing_tds || 0, stats.interceptions || 0,
            stats.rushing_yards || 0, stats.rushing_tds || 0,
            stats.receiving_yards || 0, stats.receiving_tds || 0, stats.receptions || 0,
            stats.fumbles || 0, stats.sacks || 0, stats.def_interceptions || 0,
            stats.fumbles_recovered || 0, stats.def_touchdowns || 0,
            stats.safeties || 0, stats.points_allowed || 0, stats.yards_allowed || 0,
            stats.field_goals_made || 0, stats.field_goals_attempted || 0,
            stats.extra_points_made || 0, stats.extra_points_attempted || 0,
            stats.field_goals_0_39 || 0, stats.field_goals_40_49 || 0,
            stats.field_goals_50_plus || 0, 
            stats.two_point_conversions_pass || 0, stats.two_point_conversions_run || 0,
            stats.two_point_conversions_rec || 0, stats.fantasy_points || 0
        ]);
    }

    // Bulk stats update for API sync
    async upsertPlayerStatsBulk(statsList) {
        try {
            await this.beginTransaction();
            
            for (const stats of statsList) {
                await this.upsertPlayerStats(stats);
            }
            
            await this.commit();
            logInfo(`Bulk upserted ${statsList.length} player stats`);
        } catch (error) {
            await this.rollback();
            throw error;
        }
    }

    // Matchup methods
    async getWeekMatchups(week, season) {
        const query = `
            SELECT 
                m.*,
                t1.team_name as team1_name,
                t1.owner_name as team1_owner,
                t2.team_name as team2_name,
                t2.owner_name as team2_owner
            FROM matchups m
            JOIN teams t1 ON m.team1_id = t1.team_id
            JOIN teams t2 ON m.team2_id = t2.team_id
            WHERE m.week = ? AND m.season = ?
            ORDER BY m.matchup_id
        `;
        return this.all(query, [week, season]);
    }

    async getTeamMatchups(teamId, season) {
        const query = `
            SELECT 
                m.*,
                t1.team_name as team1_name,
                t1.owner_name as team1_owner,
                t2.team_name as team2_name,
                t2.owner_name as team2_owner
            FROM matchups m
            JOIN teams t1 ON m.team1_id = t1.team_id
            JOIN teams t2 ON m.team2_id = t2.team_id
            WHERE (m.team1_id = ? OR m.team2_id = ?) AND m.season = ?
            ORDER BY m.week
        `;
        return this.all(query, [teamId, teamId, season]);
    }

    async createMatchup(week, season, team1Id, team2Id) {
        return this.run(`
            INSERT INTO matchups (week, season, team1_id, team2_id)
            VALUES (?, ?, ?, ?)
        `, [week, season, team1Id, team2Id]);
    }

    async updateMatchupScore(matchupId, team1Points, team2Points) {
        return this.run(`
            UPDATE matchups
            SET team1_scoring_points = ?, team2_scoring_points = ?
            WHERE matchup_id = ?
        `, [team1Points, team2Points, matchupId]);
    }

    // League settings
    async getLeagueSettings() {
        return this.get('SELECT * FROM league_settings WHERE league_id = 1');
    }

    async getCurrentSeasonAndWeek() {
        const settings = await this.getLeagueSettings();
        return {
            season: settings.season_year,
            week: settings.current_week
        };
    }

    async updateCurrentWeek(week) {
        return this.run('UPDATE league_settings SET current_week = ? WHERE league_id = 1', [week]);
    }

    async updateSeasonYear(year) {
        return this.run('UPDATE league_settings SET season_year = ? WHERE league_id = 1', [year]);
    }

    async updateLeagueSettings(settings) {
        const { current_week, season_year, league_name, theme } = settings;
        const updateFields = [];
        const values = [];

        if (current_week !== undefined) {
            updateFields.push('current_week = ?');
            values.push(current_week);
        }
        if (season_year !== undefined) {
            updateFields.push('season_year = ?');
            values.push(season_year);
        }
        if (league_name !== undefined) {
            updateFields.push('league_name = ?');
            values.push(league_name);
        }
        if (theme !== undefined) {
            updateFields.push('theme = ?');
            values.push(theme);
        }

        if (updateFields.length === 0) {
            throw new Error('No valid fields to update');
        }

        values.push(1); // league_id
        return this.run(
            `UPDATE league_settings SET ${updateFields.join(', ')} WHERE league_id = ?`,
            values
        );
    }

    // Scheduler timestamp methods
    async getSchedulerTimestamps() {
        return this.get(`
            SELECT last_daily_update, last_weekly_update, last_live_update 
            FROM league_settings 
            WHERE league_id = 1
        `);
    }

    async updateSchedulerTimestamp(type) {
        const columnMap = {
            'daily': 'last_daily_update',
            'weekly': 'last_weekly_update',
            'live': 'last_live_update'
        };
        
        const column = columnMap[type];
        if (!column) {
            throw new Error(`Invalid timestamp type: ${type}`);
        }
        
        return this.run(
            `UPDATE league_settings SET ${column} = CURRENT_TIMESTAMP WHERE league_id = 1`
        );
    }

    // Calculate team's total points for a week
    async calculateTeamWeeklyPoints(teamId, week, season) {
        const result = await this.get(`
            SELECT SUM(ps.fantasy_points) as total_points
            FROM weekly_rosters r
            JOIN player_stats ps ON r.player_id = ps.player_id
            WHERE r.team_id = ? AND r.roster_position = 'active'
                AND ps.week = ? AND ps.season = ?
                AND r.week = ? AND r.season = ?
        `, [teamId, week, season, week, season]);
        
        return result ? result.total_points || 0 : 0;
    }

    // Get all starters for a team in a specific week
    async getTeamStarters(teamId, week, season) {
        return this.all(`
            SELECT 
                r.*, 
                r.player_name as name, 
                r.player_position as position, 
                COALESCE(p.team, r.player_team) as team,
                ps.fantasy_points,
                ps.passing_yards,
                ps.passing_tds,
                ps.rushing_yards,
                ps.rushing_tds,
                ps.receiving_yards,
                ps.receiving_tds,
                ps.receptions
            FROM weekly_rosters r
            LEFT JOIN nfl_players p ON r.player_id = p.player_id
            LEFT JOIN player_stats ps ON r.player_id = ps.player_id 
                AND ps.week = ? AND ps.season = ?
            WHERE r.team_id = ? AND r.roster_position = 'active'
                AND r.week = ? AND r.season = ?
            ORDER BY 
                CASE r.player_position 
                    WHEN 'QB' THEN 1 
                    WHEN 'RB' THEN 2 
                    WHEN 'WR' THEN 3 
                    WHEN 'TE' THEN 4 
                    WHEN 'K' THEN 5
                    WHEN 'Defense' THEN 6
                    ELSE 7 
                END
        `, [week, season, teamId, week, season]);
    }

    // Get player ownership
    async getPlayerOwnership(playerId) {
        // Get current season and latest week
        const { season: currentSeason } = await this.getCurrentSeasonAndWeek();
        const latestWeek = await this.get(`
            SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
        `, [currentSeason]);
        
        return this.get(`
            SELECT r.*, t.team_name, t.owner_name
            FROM weekly_rosters r
            JOIN teams t ON r.team_id = t.team_id
            WHERE r.player_id = ? AND r.week = ? AND r.season = ?
              AND r.roster_position != 'injured_reserve'
        `, [playerId, latestWeek.week, currentSeason]);
    }

    // Get roster size for a team
    async getTeamRosterSize(teamId) {
        // Get current season and latest week
        const { season: currentSeason } = await this.getCurrentSeasonAndWeek();
        const latestWeek = await this.get(`
            SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
        `, [currentSeason]);
        
        const result = await this.get(`
            SELECT COUNT(*) as roster_size
            FROM weekly_rosters
            WHERE team_id = ? AND week = ? AND season = ?
        `, [teamId, latestWeek.week, currentSeason]);
        
        return result ? result.roster_size : 0;
    }

    // Copy rosters from one week to another
    async copyRostersToNextWeek(fromWeek, toWeek, season) {
        const { logInfo, logWarn, logError } = require('../utils/errorHandler');

        try {
            // Check if target week already has rosters
            const existingRosters = await this.get(`
                SELECT COUNT(*) as count FROM weekly_rosters
                WHERE week = ? AND season = ?
            `, [toWeek, season]);

            if (existingRosters.count > 0) {
                logWarn(`Week ${toWeek} already has ${existingRosters.count} roster entries, skipping copy`);
                return {
                    success: false,
                    message: `Week ${toWeek} already has rosters`,
                    existingCount: existingRosters.count
                };
            }

            // League invariant guard: every team must have exactly 19 active
            // players in the SOURCE week before it is propagated. A past
            // incident (commit f327966) advanced the week with missing rosters;
            // refuse loudly rather than copy a corrupt week forward.
            const badTeams = await this.all(`
                SELECT t.team_id, t.team_name, COUNT(wr.player_id) as active_players
                FROM teams t
                LEFT JOIN weekly_rosters wr ON t.team_id = wr.team_id
                    AND wr.week = ? AND wr.season = ? AND wr.roster_position = 'active'
                GROUP BY t.team_id, t.team_name
                HAVING active_players != 19
            `, [fromWeek, season]);

            if (badTeams.length > 0) {
                const detail = badTeams.map(t => `${t.team_name}: ${t.active_players}`).join(', ');
                const message = `Refusing to copy rosters: week ${fromWeek} violates the 19-active-players-per-team invariant (${detail})`;
                logError(message);
                return { success: false, message, badTeams };
            }

            const sourceCount = await this.get(
                'SELECT COUNT(*) as count FROM weekly_rosters WHERE week = ? AND season = ?',
                [fromWeek, season]);

            // Copy all rosters from previous week to new week
            const result = await this.run(`
                INSERT INTO weekly_rosters (team_id, player_id, week, season, roster_position,
                                          player_name, player_position, player_team, is_scoring,
                                          scoring_slot, ir_date)
                SELECT team_id, player_id, ?, season, roster_position,
                       player_name, player_position, player_team, is_scoring,
                       scoring_slot, ir_date
                FROM weekly_rosters
                WHERE week = ? AND season = ?
            `, [toWeek, fromWeek, season]);

            // Post-copy assertion: the target week must contain exactly what the
            // source week did. On mismatch, remove the partial copy and fail.
            if (result.changes !== sourceCount.count) {
                await this.run('DELETE FROM weekly_rosters WHERE week = ? AND season = ?', [toWeek, season]);
                const message = `Roster copy incomplete (${result.changes}/${sourceCount.count} rows) - target week ${toWeek} rolled back`;
                logError(message);
                return { success: false, message };
            }

            logInfo(`Copied ${result.changes} roster entries from week ${fromWeek} to week ${toWeek}`);

            return {
                success: true,
                message: `Successfully copied rosters from week ${fromWeek} to week ${toWeek}`,
                entriesCopied: result.changes
            };
        } catch (error) {
            logError(`Failed to copy rosters from week ${fromWeek} to week ${toWeek}:`, error);
            return {
                success: false,
                message: error.message,
                error: error
            };
        }
    }


    // Tank01 Cache Management Methods
    
    // Get most accessed cache entries
    async getMostAccessedCacheEntries(limit = 10) {
        return this.all(`
            SELECT cache_key, endpoint, hit_count, is_historical, created_at, last_accessed
            FROM tank01_cache
            ORDER BY hit_count DESC
            LIMIT ?
        `, [limit]);
    }
    
    // Get cache entries by endpoint
    async getCacheEntriesByEndpoint(endpoint) {
        return this.all(`
            SELECT cache_key, params, hit_count, is_historical, created_at, expires_at
            FROM tank01_cache
            WHERE endpoint = ?
            ORDER BY last_accessed DESC
        `, [endpoint]);
    }
    
    // Clean up old cache entries (not historical)
    async cleanupExpiredCache() {
        const result = await this.run(`
            DELETE FROM tank01_cache 
            WHERE is_historical = 0 AND expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP
        `);
        logInfo(`Cleaned up ${result.changes} expired cache entries`);
        return result.changes;
    }
    
    // Get cache storage size estimate
    async getCacheStorageSize() {
        const result = await this.get(`
            SELECT 
                COUNT(*) as total_entries,
                SUM(LENGTH(response_data)) as total_bytes,
                SUM(CASE WHEN is_historical = 1 THEN LENGTH(response_data) ELSE 0 END) as historical_bytes,
                SUM(CASE WHEN is_historical = 0 THEN LENGTH(response_data) ELSE 0 END) as temporary_bytes
            FROM tank01_cache
        `);
        
        return {
            totalEntries: result.total_entries || 0,
            totalSizeMB: (result.total_bytes || 0) / (1024 * 1024),
            historicalSizeMB: (result.historical_bytes || 0) / (1024 * 1024),
            temporarySizeMB: (result.temporary_bytes || 0) / (1024 * 1024)
        };
    }

    // Close database connection
    async close() {
        // Never close mid-initialization - the queued pragma/schema statements
        // would fail against a closed handle
        if (this.initComplete) {
            await this.initComplete;
        }
        return new Promise((resolve, reject) => {
            if (!this.db) {
                resolve();
                return;
            }

            this.db.close((err) => {
                if (err) {
                    logError('Error closing database', err);
                    // Don't reject, just resolve to allow graceful shutdown
                    resolve();
                } else {
                    console.log('Database connection closed');
                    resolve();
                }
            });
        });
    }
}

module.exports = DatabaseManager;
