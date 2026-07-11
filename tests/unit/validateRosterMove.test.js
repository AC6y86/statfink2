/**
 * Tests for db.validateRosterMove() - the read-only dry-run of roster move
 * checks (drop on roster, add available, IR-return validity, 3-week IR
 * minimum). Mocked db internals; never touches the real database.
 */
const DatabaseManager = require('../../server/database/database');

const WEEK = 18;
const SEASON = 2025;

/**
 * Build a DatabaseManager whose get/all are stubbed by SQL pattern matching.
 * overrides lets each test tweak individual lookups.
 */
function mockedDb(overrides = {}) {
    const db = Object.create(DatabaseManager.prototype);

    const defaults = {
        // Players exist
        dropPlayer: { player_id: 'DROP1', name: 'Drop Guy', position: 'RB' },
        addPlayer: { player_id: 'ADD1', name: 'Add Guy', position: 'RB' },
        // Drop player is on the roster
        onRoster: { team_id: 1, player_id: 'DROP1', roster_position: 'active' },
        // Add player is a free agent
        addOwnership: null,
        // Add player not on this team's IR
        playerOnIR: null,
        // No prior IR move
        irMove: null,
        ...overrides
    };

    db.getCurrentSeasonAndWeek = async () => ({ season: SEASON, week: WEEK });
    db.isPlayerAvailable = async () => defaults.addOwnership
        ? { available: false, reason: defaults.addOwnership }
        : { available: true, reason: null };

    db.get = async (sql, params) => {
        if (sql.includes('MAX(week)')) return { week: WEEK };
        if (sql.includes('FROM nfl_players')) {
            return params[0] === 'DROP1' ? defaults.dropPlayer
                : params[0] === 'ADD1' ? defaults.addPlayer
                : null;
        }
        if (sql.includes("roster_position = 'injured_reserve'")) return defaults.playerOnIR;
        if (sql.includes('FROM weekly_rosters')) return defaults.onRoster;
        if (sql.includes('FROM roster_moves')) return defaults.irMove;
        return null;
    };

    return db;
}

describe('db.validateRosterMove', () => {
    test('valid supplemental move passes', async () => {
        const db = mockedDb();
        const result = await db.validateRosterMove(1, 'DROP1', 'ADD1', 'supplemental');
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
        expect(result.context.dropPlayer.name).toBe('Drop Guy');
    });

    test('fails when a player does not exist', async () => {
        const db = mockedDb({ addPlayer: null });
        const result = await db.validateRosterMove(1, 'DROP1', 'ADD1', 'supplemental');
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('One or both players not found');
    });

    test('fails when drop player is not on the team', async () => {
        const db = mockedDb({ onRoster: null });
        const result = await db.validateRosterMove(1, 'DROP1', 'ADD1', 'supplemental');
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Player to drop is not on this team');
    });

    test('fails when add player is rostered elsewhere', async () => {
        const db = mockedDb({ addOwnership: "Player is already on Chris's Team (owned by Chris)" });
        const result = await db.validateRosterMove(1, 'DROP1', 'ADD1', 'supplemental');
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('already on'))).toBe(true);
    });

    test('ir_return fails when the player is not on this team IR', async () => {
        const db = mockedDb({ playerOnIR: null });
        const result = await db.validateRosterMove(1, 'DROP1', 'ADD1', 'ir_return');
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('injured reserve'))).toBe(true);
    });

    test('ir_return fails before 3 weeks on IR', async () => {
        const db = mockedDb({
            playerOnIR: { player_id: 'ADD1', roster_position: 'injured_reserve' },
            irMove: { week: WEEK - 1 } // on IR for 1 week
        });
        const result = await db.validateRosterMove(1, 'DROP1', 'ADD1', 'ir_return');
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('at least 3 weeks'))).toBe(true);
    });

    test('ir_return passes after 3+ weeks on IR', async () => {
        const db = mockedDb({
            playerOnIR: { player_id: 'ADD1', roster_position: 'injured_reserve' },
            irMove: { week: WEEK - 3 }
        });
        const result = await db.validateRosterMove(1, 'DROP1', 'ADD1', 'ir_return');
        expect(result.valid).toBe(true);
        expect(result.context.playerOnIR).not.toBeNull();
    });

    test('collects multiple errors instead of stopping at the first', async () => {
        const db = mockedDb({
            onRoster: null,
            addOwnership: "Player is already on Dan's Team (owned by Dan)"
        });
        const result = await db.validateRosterMove(1, 'DROP1', 'ADD1', 'supplemental');
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBe(2);
    });
});
