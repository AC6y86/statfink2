/**
 * Tests for db.validateRosterMove() - the read-only dry-run of roster move
 * checks (drop on roster, add available, IR-return validity, 3-week IR
 * minimum) and the central NFL.com IR eligibility gate it applies to
 * moveType 'ir'. Mocked db internals and an injected eligibility service;
 * never touches the real database and never reaches the network.
 */
const DatabaseManager = require('../../server/database/database');
const { NflEligibilityError } = require('../../server/services/nflRosterEligibilityService');

/** Eligibility service stub: records its calls, answers however the test says. */
function eligibilityService(answer) {
    const calls = [];
    return {
        calls,
        async checkIrEligibility(params) {
            calls.push(params);
            if (typeof answer === 'function') return answer(params);
            return answer;
        }
    };
}

const ELIGIBLE = {
    eligible: true,
    code: 'OUT_ON_INJURY_REPORT',
    reason: 'NFL.com Week 18 injury report lists Drop Guy (KC) with Game Status "Out"',
    observedStatus: 'Game Status: Out',
    source: 'nfl.com',
    sources: ['https://www.nfl.com/injuries/league/2025/reg18'],
    checkedAt: '2026-09-25T12:00:00.000Z'
};

const passing = () => eligibilityService(ELIGIBLE);
const ineligible = () => eligibilityService(() => {
    throw new NflEligibilityError(
        'NFL_INELIGIBLE',
        'IR move not allowed: NFL.com does not list Drop Guy (KC) as Out or on Reserve/Injured (observed injury report: Game Status: "Questionable"; Kansas City Chiefs roster: Status "ACT")',
        { eligible: false, code: 'NFL_INELIGIBLE', observedStatus: 'Game Status: "Questionable"', sources: ['https://www.nfl.com/injuries/league/2025/reg18'] }
    );
});
const unavailable = () => eligibilityService(() => {
    throw new NflEligibilityError(
        'NFL_UNAVAILABLE',
        'Validation failed: fresh NFL.com data unavailable (timeout after 12000ms fetching https://www.nfl.com/injuries/league/2025/reg18)'
    );
});

const WEEK = 18;
const SEASON = 2025;

/**
 * Build a DatabaseManager whose get/all are stubbed by SQL pattern matching.
 * overrides lets each test tweak individual lookups.
 */
function mockedDb(overrides = {}) {
    const db = Object.create(DatabaseManager.prototype);
    // Every test injects its own gate, so nothing here can hit nfl.com. A
    // test that wants the "not configured" path passes null explicitly.
    db.nflEligibilityService = overrides.nflEligibilityService === undefined
        ? passing()
        : overrides.nflEligibilityService;

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
        // Drop player's NFL game this week (null = bye / no schedule row)
        game: null,
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
        if (sql.includes('GROUP BY week')) return defaults.weekAt === undefined ? null : defaults.weekAt; // weekInEffectAt; null = judge on the roster week
        if (sql.includes('FROM nfl_games')) return defaults.game;
        return null;
    };

    return db;
}

describe('db.validateRosterMove drop lock (no drops once the player\'s game has kicked off, judged at request time)', () => {
    const KICKOFF = Date.parse('2026-01-04T18:00:00Z'); // 1:00p ET Sunday
    const game = { game_id: '20260104_KC@DEN', game_date: '20260104', game_time: '1:00p', game_time_epoch: KICKOFF / 1000, status: 'Final' };
    const withTeam = extra => mockedDb({ dropPlayer: { player_id: 'DROP1', name: 'Drop Guy', position: 'RB', team: 'KC' }, game, ...extra });

    test('email sent before kickoff is allowed even though the game has since been played', async () => {
        const result = await withTeam().validateRosterMove(1, 'DROP1', 'ADD1', 'supplemental', { asOf: '2026-01-04T15:30:00Z' });
        expect(result.valid).toBe(true);
        expect(result.context.dropLock).toBeNull();
    });

    test('email sent after kickoff is refused, naming the game, kickoff and request time', async () => {
        const result = await withTeam().validateRosterMove(1, 'DROP1', 'ADD1', 'supplemental', { asOf: 'Sun, 04 Jan 2026 14:05:00 -0500' });
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Cannot drop Drop Guy: KC already played this week (20260104_KC@DEN kicked off 2026-01-04T18:00:00.000Z; request made 2026-01-04T19:05:00.000Z)');
    });

    test('exactly at kickoff counts as started; applies to IR moves too', async () => {
        const result = await withTeam().validateRosterMove(1, 'DROP1', 'ADD1', 'ir', { asOf: '2026-01-04T18:00:00Z' });
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.startsWith('Cannot drop Drop Guy'))).toBe(true);
    });

    test('a manual move (no asOf) is judged now: refused after kickoff, allowed before', async () => {
        const nowSpy = jest.spyOn(Date, 'now');
        try {
            nowSpy.mockReturnValue(KICKOFF + 3600 * 1000);
            expect((await withTeam().validateRosterMove(1, 'DROP1', 'ADD1', 'supplemental')).valid).toBe(false);
            nowSpy.mockReturnValue(KICKOFF - 3600 * 1000);
            expect((await withTeam().validateRosterMove(1, 'DROP1', 'ADD1', 'supplemental')).valid).toBe(true);
        } finally { nowSpy.mockRestore(); }
    });

    test('no kickoff time on file: an email move is never blocked on guesswork, a manual move goes by the game status', async () => {
        const noEpoch = { ...game, game_time_epoch: null, status: 'Final' };
        expect((await withTeam({ game: noEpoch }).validateRosterMove(1, 'DROP1', 'ADD1', 'supplemental', { asOf: '2026-01-05T12:00:00Z' })).valid).toBe(true);
        expect((await withTeam({ game: noEpoch }).validateRosterMove(1, 'DROP1', 'ADD1', 'supplemental')).valid).toBe(false);
        expect((await withTeam({ game: { ...noEpoch, status: 'Scheduled' } }).validateRosterMove(1, 'DROP1', 'ADD1', 'supplemental')).valid).toBe(true);
    });

    test('bye week (no schedule row) or unparseable request time never locks', async () => {
        expect((await withTeam({ game: null }).validateRosterMove(1, 'DROP1', 'ADD1', 'supplemental', { asOf: '2026-01-05T12:00:00Z' })).valid).toBe(true);
        // garbage asOf falls back to now (before kickoff here)
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(KICKOFF - 1000);
        try { expect((await withTeam().validateRosterMove(1, 'DROP1', 'ADD1', 'supplemental', { asOf: 'not a date' })).valid).toBe(true); }
        finally { nowSpy.mockRestore(); }
    });

    test('a trade is refused before any write when either player\'s game has kicked off', async () => {
        const db = withTeam({ addPlayer: { player_id: 'ADD1', name: 'Add Guy', position: 'RB', team: 'DEN' } });
        db.run = jest.fn(async () => ({}));
        await expect(db.executeTrade(1, 'DROP1', 2, 'ADD1', { asOf: '2026-01-04T20:00:00Z' })).rejects.toThrow(/already played this week/);
        expect(db.run).not.toHaveBeenCalled();
        const before = await withTeam({ addPlayer: { player_id: 'ADD1', name: 'Add Guy', position: 'RB', team: 'DEN' } });
        before.run = jest.fn(async () => ({}));
        before.getTeam = async id => ({ team_id: id });
        // before kickoff the lock passes; the trade then proceeds into its transaction
        await before.executeTrade(1, 'DROP1', 2, 'ADD1', { asOf: '2026-01-04T12:00:00Z' }).catch(() => {});
        expect(before.run).toHaveBeenCalled();
    });
});

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

describe('db.validateRosterMove - NFL.com IR eligibility gate', () => {
    test('ir passes and records the evidence when NFL.com says the player is out', async () => {
        const gate = passing();
        const db = mockedDb({ nflEligibilityService: gate, dropPlayer: { player_id: 'DROP1', name: 'Drop Guy', position: 'RB', team: 'KC' } });

        const result = await db.validateRosterMove(1, 'DROP1', 'ADD1', 'ir');

        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
        expect(result.context.nflEligibility).toMatchObject({ eligible: true, code: 'OUT_ON_INJURY_REPORT' });
        expect(gate.calls).toEqual([{ playerName: 'Drop Guy', team: 'KC', season: SEASON, week: WEEK }]);
    });

    test('ir fails with the definitive NFL.com reason when the player is not out', async () => {
        const db = mockedDb({ nflEligibilityService: ineligible() });

        const result = await db.validateRosterMove(1, 'DROP1', 'ADD1', 'ir');

        expect(result.valid).toBe(false);
        expect(result.errors[0]).toMatch(/^IR move not allowed: NFL\.com does not list/);
        expect(result.context.nflEligibility).toMatchObject({ eligible: false, code: 'NFL_INELIGIBLE' });
        expect(result.context.nflEligibility.observedStatus).toContain('Questionable');
    });

    test('ir fails closed, distinctly, when NFL.com data is unavailable', async () => {
        const db = mockedDb({ nflEligibilityService: unavailable() });

        const result = await db.validateRosterMove(1, 'DROP1', 'ADD1', 'ir');

        expect(result.valid).toBe(false);
        expect(result.errors[0]).toMatch(/^Validation failed: fresh NFL\.com data unavailable \(timeout after 12000ms/);
        expect(result.context.nflEligibility).toMatchObject({ eligible: false, code: 'NFL_UNAVAILABLE' });
    });

    test('ir fails closed when no eligibility service is configured', async () => {
        const db = mockedDb({ nflEligibilityService: null });

        const result = await db.validateRosterMove(1, 'DROP1', 'ADD1', 'ir');

        expect(result.valid).toBe(false);
        expect(result.errors[0]).toBe('Validation failed: fresh NFL.com data unavailable (NFL eligibility service not configured)');
        expect(result.context.nflEligibility.eligible).toBe(false);
    });

    test('an unexpected throw from the gate still fails closed as unavailable', async () => {
        const db = mockedDb({ nflEligibilityService: eligibilityService(() => { throw new Error('socket hang up'); }) });

        const result = await db.validateRosterMove(1, 'DROP1', 'ADD1', 'ir');

        expect(result.valid).toBe(false);
        expect(result.errors[0]).toBe('Validation failed: fresh NFL.com data unavailable (socket hang up)');
        expect(result.context.nflEligibility.code).toBe('NFL_UNAVAILABLE');
    });

    test('a gate that answers without positive evidence fails closed', async () => {
        const db = mockedDb({ nflEligibilityService: eligibilityService({ eligible: 'yes' }) });

        const result = await db.validateRosterMove(1, 'DROP1', 'ADD1', 'ir');

        expect(result.valid).toBe(false);
        expect(result.context.nflEligibility.code).toBe('NFL_UNAVAILABLE');
    });

    test('the gate applies to ordinary IR moves only - supplemental, ir_return and trade never consult NFL.com', async () => {
        for (const moveType of ['supplemental', 'ir_return', 'trade']) {
            const gate = eligibilityService(() => { throw new Error('the gate must not run for ' + moveType); });
            const db = mockedDb({
                nflEligibilityService: gate,
                playerOnIR: { player_id: 'ADD1', roster_position: 'injured_reserve' },
                irMove: { week: WEEK - 3 }
            });

            const result = await db.validateRosterMove(1, 'DROP1', 'ADD1', moveType);

            expect(gate.calls).toEqual([]);
            expect(result.context.nflEligibility).toBeNull();
            expect(result.valid).toBe(true);
        }
    });

    test('an IR move blocked by NFL.com is not executed, and the thrown error carries the evidence', async () => {
        const db = mockedDb({ nflEligibilityService: ineligible() });
        db.run = jest.fn(async () => { throw new Error('executeRosterMove must not write'); });

        // DatabaseError's second argument is the error type by convention
        // throughout this file (it lands on .query).
        await expect(db.executeRosterMove(1, 'DROP1', 'ADD1', 'ir')).rejects.toMatchObject({
            query: 'ir_eligibility',
            nflEligibility: { eligible: false, code: 'NFL_INELIGIBLE' }
        });
        expect(db.run).not.toHaveBeenCalled();
    });

    test('an IR move that fails a roster check reports that error, not an eligibility one', async () => {
        const db = mockedDb({ onRoster: null, nflEligibilityService: passing() });
        db.run = jest.fn(async () => { throw new Error('executeRosterMove must not write'); });

        await expect(db.executeRosterMove(1, 'DROP1', 'ADD1', 'ir')).rejects.toMatchObject({
            message: 'Player to drop is not on this team',
            query: 'roster_constraint'
        });
        expect(db.run).not.toHaveBeenCalled();
    });
});

/**
 * Regression for pending move pm-1791656805523-1 (2026): Adonai Mitchell was
 * mailed to IR on Sat 2026-10-10 (Week 5, listed Out on the Week 5 report) and
 * approved on Fri 2026-10-16 (Week 6, by then Active). Approval re-validated
 * against the roster week (6) and refused him. Time-dependent rules are judged
 * in the week in effect when the owner asked. The schedule lives in a real
 * in-memory sqlite table so the week resolution SQL itself is under test.
 */
describe('db.validateRosterMove judges the drop lock and the NFL.com IR gate in the week the owner asked', () => {
    const sqlite3 = require('sqlite3');
    const ROSTER_WEEK = 6;
    const ASKED = '2026-10-10T18:25:17Z';          // email Date header, Week 5
    const APPROVED_MS = Date.parse('2026-10-16T15:00:00Z'); // commissioner approval, Week 6
    const kickoff = iso => Math.floor(Date.parse(iso) / 1000);
    const SCHEDULE = [
        ['20261004_IND@LAR', 4, 'LAR', 'IND', kickoff('2026-10-04T17:00:00Z')],
        ['20261008_SF@LAR', 5, 'LAR', 'SF', kickoff('2026-10-09T00:15:00Z')],
        ['20261011_IND@ARI', 5, 'ARI', 'IND', kickoff('2026-10-11T17:00:00Z')],
        ['20261012_BUF@ATL', 5, 'ATL', 'BUF', kickoff('2026-10-13T00:15:00Z')],
        ['20261011_DAL@NYJ', 5, 'NYJ', 'DAL', kickoff('2026-10-11T17:00:00Z')],
        ['20261015_PHI@NYG', 6, 'NYG', 'PHI', kickoff('2026-10-16T00:15:00Z')],
        ['20261018_NYJ@NE', 6, 'NE', 'NYJ', kickoff('2026-10-18T17:00:00Z')],
        ['20261018_LAC@IND', 6, 'IND', 'LAC', kickoff('2026-10-18T17:00:00Z')],
        ['20261019_DET@TB', 6, 'TB', 'DET', kickoff('2026-10-20T00:15:00Z')]
    ];
    let mem;

    beforeAll(async () => {
        mem = new sqlite3.Database(':memory:');
        const run = (sql, params = []) => new Promise((res, rej) => mem.run(sql, params, e => (e ? rej(e) : res())));
        await run(`CREATE TABLE nfl_games (game_id TEXT PRIMARY KEY, week INTEGER, season INTEGER, home_team TEXT, away_team TEXT,
                   game_date TEXT, game_time TEXT, game_time_epoch INTEGER, status TEXT)`);
        for (const [id, week, home, away, epoch] of SCHEDULE) {
            await run('INSERT INTO nfl_games VALUES (?, ?, 2026, ?, ?, NULL, NULL, ?, ?)', [id, week, home, away, epoch, epoch * 1000 < APPROVED_MS ? 'Final' : 'Scheduled']);
        }
    });
    afterAll(() => new Promise(res => mem.close(res)));

    /** The gate as NFL.com answered it: Out on the Week 5 report, Active (not listed) on Week 6. */
    const nflByWeek = () => eligibilityService(({ week }) => {
        if (week === 5) return { ...ELIGIBLE, reason: 'NFL.com Week 5 injury report lists Adonai Mitchell (IND) with Game Status "Out"', sources: ['https://www.nfl.com/injuries/league/2026/reg5'] };
        throw new NflEligibilityError('NFL_INELIGIBLE',
            `IR move not allowed: NFL.com does not list Adonai Mitchell (IND) as Out or on Reserve/Injured (observed Week ${week} injury report: not listed; Indianapolis Colts roster: Status "ACT")`,
            { eligible: false, code: 'NFL_INELIGIBLE' });
    });

    function week6Db(extra = {}) {
        const db = mockedDb({
            dropPlayer: { player_id: 'DROP1', name: 'Adonai Mitchell', position: 'WR', team: 'IND' },
            nflEligibilityService: nflByWeek(),
            ...extra
        });
        db.getCurrentSeasonAndWeek = async () => ({ season: 2026, week: ROSTER_WEEK });
        const stubbedGet = db.get;
        db.get = (sql, params) => {
            if (sql.includes('MAX(week)')) return Promise.resolve({ week: ROSTER_WEEK });
            if (sql.includes('FROM nfl_games')) {
                return new Promise((res, rej) => mem.get(sql, params, (e, row) => (e ? rej(e) : res(row))));
            }
            return stubbedGet(sql, params);
        };
        return db;
    }

    test('pm-1791656805523-1: an IR move mailed in Week 5 is still judged on the Week 5 report when approved in Week 6', async () => {
        const db = week6Db();
        const result = await db.validateRosterMove(1, 'DROP1', 'ADD1', 'ir', { asOf: ASKED });
        expect(result.errors).toEqual([]);
        expect(result.valid).toBe(true);
        expect(result.context.judgedWeek).toBe(5);
        expect(db.nflEligibilityService.calls).toEqual([{ playerName: 'Adonai Mitchell', team: 'IND', season: 2026, week: 5 }]);
        expect(result.context.nflEligibility.sources).toEqual(['https://www.nfl.com/injuries/league/2026/reg5']);
    });

    test('executeRosterMove (the approve path) accepts the same stale item instead of throwing ir_eligibility', async () => {
        const db = week6Db();
        db.run = jest.fn(async () => ({}));
        db.executeRosterMove = DatabaseManager.prototype.executeRosterMove;
        await db.executeRosterMove(1, 'DROP1', 'ADD1', 'ir', { asOf: ASKED }).catch(() => {});
        expect(db.run).toHaveBeenCalledWith('BEGIN TRANSACTION'); // validation passed; the write began
    });

    test('a manual move with no requestedAt keeps execution-time behaviour: Week 6, refused as Active', async () => {
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(APPROVED_MS);
        try {
            const db = week6Db();
            const result = await db.validateRosterMove(1, 'DROP1', 'ADD1', 'ir');
            expect(result.valid).toBe(false);
            expect(result.context.judgedWeek).toBe(6);
            expect(db.nflEligibilityService.calls[0].week).toBe(6);
            expect(result.errors[0]).toMatch(/NFL.com does not list Adonai Mitchell .*Week 6/);
        } finally { nowSpy.mockRestore(); }
    });

    test('a manual move that explicitly provides requestedAt is judged like the email', async () => {
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(APPROVED_MS);
        try {
            const result = await week6Db().validateRosterMove(1, 'DROP1', 'ADD1', 'ir', { asOf: ASKED });
            expect(result.valid).toBe(true);
            expect(result.context.judgedWeek).toBe(5);
        } finally { nowSpy.mockRestore(); }
    });

    test('the drop lock follows the judged week: asked after IND\'s Week 5 kickoff is refused even though Week 6 has not kicked off', async () => {
        const after = await week6Db().validateRosterMove(1, 'DROP1', 'ADD1', 'supplemental', { asOf: '2026-10-11T20:00:00Z' });
        expect(after.valid).toBe(false);
        expect(after.errors).toEqual(['Cannot drop Adonai Mitchell: IND already played this week (20261011_IND@ARI kicked off 2026-10-11T17:00:00.000Z; request made 2026-10-11T20:00:00.000Z)']);
        const before = await week6Db().validateRosterMove(1, 'DROP1', 'ADD1', 'supplemental', { asOf: ASKED });
        expect(before.valid).toBe(true);
    });

    test('weekInEffectAt: week of the request, capped at the roster week; no asOf or no schedule means the roster week', async () => {
        const db = week6Db();
        expect(await db.weekInEffectAt(2026, ASKED, 6)).toBe(5);
        expect(await db.weekInEffectAt(2026, '2026-10-13T00:30:00Z', 6)).toBe(5);  // MNF Week 5 still in progress
        expect(await db.weekInEffectAt(2026, '2026-10-13T12:00:00Z', 6)).toBe(6);  // Tuesday: Week 6 has begun
        expect(await db.weekInEffectAt(2026, '2026-10-13T12:00:00Z', 5)).toBe(5);  // ...but never past the roster week
        expect(await db.weekInEffectAt(2026, '2026-10-16T15:00:00Z', 6)).toBe(6);
        expect(await db.weekInEffectAt(2026, '2026-08-01T00:00:00Z', 6)).toBe(4);  // earliest week on file
        expect(await db.weekInEffectAt(2026, '2026-11-01T00:00:00Z', 6)).toBe(6);  // after every game on file
        expect(await db.weekInEffectAt(2026, null, 6)).toBe(6);
        expect(await db.weekInEffectAt(2026, 'not a date', 6)).toBe(6);
        expect(await db.weekInEffectAt(2027, ASKED, 1)).toBe(1);                   // no schedule for that season
    });

    /**
     * Second failure, found after the week-in-effect fix shipped (2026-10-16):
     * the validator now correctly asks NFL.com for /injuries/league/2026/reg5,
     * but NFL.com serves the Week 6 page at that URL once Week 6 is current;
     * the page-identity check rightly reports NFL_UNAVAILABLE. The queue's
     * intake dry-run from Sat 2026-10-10 is preserved evidence: eligible,
     * Out on the real Week 5 report, checked seconds after the email arrived.
     * Delayed approval may stand on it - narrowly, and only then.
     */
    describe('enqueue-time evidence fallback (delayed email approval, NFL_UNAVAILABLE only)', () => {
        const MITCHELL = { player_id: 'DROP1', name: 'Adonai Mitchell', position: 'WR', team: 'NYJ' };
        const ENQUEUE_EVIDENCE = {
            asOf: '2026-10-10T18:25:17.000Z',
            checkedAt: '2026-10-10T18:25:21.000Z',
            dropPlayerId: 'DROP1',
            teamId: 1,
            moveType: 'ir',
            nflEligibility: {
                eligible: true,
                code: 'OUT_ON_INJURY_REPORT',
                reason: 'NFL.com Week 5 injury report lists Adonai Mitchell (NYJ) with Game Status "Out"',
                observedStatus: 'Game Status: Out',
                injuryReport: { listed: true, gameStatus: 'Out', practiceStatus: 'Did Not Participate In Practice', injuries: 'Hamstring' },
                player: { name: 'Adonai Mitchell', team: 'NYJ' },
                season: 2026,
                week: 5,
                checkedAt: '2026-10-10T18:25:21.000Z',
                sources: ['https://www.nfl.com/injuries/league/2026/reg5'],
                source: 'nfl.com'
            }
        };
        const PAGE_MISMATCH = 'Validation failed: fresh NFL.com data unavailable (injury report page identity mismatch: expected /injuries/league/2026/reg5, got title "Week 6 Injury Report | NFL.com", selected Week 6)';
        const ACTIVE = 'IR move not allowed: NFL.com does not list Adonai Mitchell (NYJ) as Out or on Reserve/Injured (observed Week 5 injury report: not listed; New York Jets roster: Status "ACT")';

        /** NFL.com as it answers today: the Week 5 URL serves the Week 6 page. */
        const historicalPageGone = () => eligibilityService(({ week, season }) => {
            throw new NflEligibilityError('NFL_UNAVAILABLE', PAGE_MISMATCH,
                { eligible: false, code: 'NFL_UNAVAILABLE', season, week, sources: ['https://www.nfl.com/injuries/league/2026/reg5'] });
        });
        /** NFL.com answering definitively: he is Active. */
        const definitelyActive = () => eligibilityService(({ week, season }) => {
            throw new NflEligibilityError('NFL_INELIGIBLE', ACTIVE,
                { eligible: false, code: 'NFL_INELIGIBLE', season, week, observedStatus: 'not listed; Status "ACT"', sources: ['https://www.nfl.com/injuries/league/2026/reg5', 'https://www.nfl.com/teams/new-york-jets/roster'] });
        });
        const fallbackDb = (service = historicalPageGone(), extra = {}) =>
            week6Db({ dropPlayer: MITCHELL, nflEligibilityService: service, ...extra });
        const withEvidence = (patch = {}) => ({ ...ENQUEUE_EVIDENCE, ...patch, nflEligibility: { ...ENQUEUE_EVIDENCE.nflEligibility, ...(patch.nflEligibility || {}) } });

        test('allowed: Week 5 page unavailable at approval, intake evidence matches season/week/player/asOf', async () => {
            const db = fallbackDb();
            const result = await db.validateRosterMove(1, 'DROP1', 'ADD1', 'ir', { asOf: ASKED, enqueueEvidence: ENQUEUE_EVIDENCE });
            expect(result.errors).toEqual([]);
            expect(result.valid).toBe(true);
            expect(result.context.judgedWeek).toBe(5);
            // the fresh fetch still happened, for the judged week
            expect(db.nflEligibilityService.calls).toEqual([{ playerName: 'Adonai Mitchell', team: 'NYJ', season: 2026, week: 5 }]);
            const nfl = result.context.nflEligibility;
            expect(nfl).toMatchObject({ eligible: true, code: 'OUT_ON_INJURY_REPORT', basis: 'enqueue', legacy: false, week: 5, season: 2026, enqueueCheckedAt: '2026-10-10T18:25:21.000Z' });
            expect(nfl.freshCheck).toMatchObject({ eligible: false, code: 'NFL_UNAVAILABLE', reason: PAGE_MISMATCH });
            expect(nfl.reason).toContain('Accepted enqueue-time NFL.com evidence checked 2026-10-10T18:25:21.000Z');
            expect(nfl.reason).toContain(PAGE_MISMATCH);
            expect(nfl.sources).toEqual(['https://www.nfl.com/injuries/league/2026/reg5']);
        });

        test('executeRosterMove (the approve path) proceeds on the accepted evidence and returns it', async () => {
            const db = fallbackDb();
            db.run = jest.fn(async () => ({}));
            const stubbedGet = db.get;
            db.get = (sql, params) => sql.includes('COUNT(*)') ? Promise.resolve({ count: 19 }) : stubbedGet(sql, params);
            const result = await db.executeRosterMove(1, 'DROP1', 'ADD1', 'ir', { asOf: ASKED, enqueueEvidence: ENQUEUE_EVIDENCE });
            expect(db.run).toHaveBeenCalledWith('BEGIN TRANSACTION');
            expect(db.run).toHaveBeenCalledWith('COMMIT');
            expect(result.nflEligibility).toMatchObject({ basis: 'enqueue', code: 'OUT_ON_INJURY_REPORT', eligible: true });
            expect(result.nflEligibility.freshCheck.code).toBe('NFL_UNAVAILABLE');
        });

        test('executeRosterMove refuses (ir_eligibility) with evidence attached when NFL.com says Active', async () => {
            const db = fallbackDb(definitelyActive());
            db.run = jest.fn(async () => { throw new Error('executeRosterMove must not write'); });
            await expect(db.executeRosterMove(1, 'DROP1', 'ADD1', 'ir', { asOf: ASKED, enqueueEvidence: ENQUEUE_EVIDENCE })).rejects.toMatchObject({
                query: 'ir_eligibility',
                nflEligibility: { eligible: false, code: 'NFL_INELIGIBLE' }
            });
            expect(db.run).not.toHaveBeenCalled();
        });

        test('refused on a definitive NFL_INELIGIBLE: NFL.com answered, older evidence never overrides it', async () => {
            const db = fallbackDb(definitelyActive());
            const result = await db.validateRosterMove(1, 'DROP1', 'ADD1', 'ir', { asOf: ASKED, enqueueEvidence: ENQUEUE_EVIDENCE });
            expect(result.valid).toBe(false);
            expect(result.errors).toEqual([ACTIVE]);
            expect(result.context.nflEligibility).toMatchObject({ eligible: false, code: 'NFL_INELIGIBLE' });
            expect(result.context.nflEligibility.enqueueEvidenceRejected).toMatch(/NFL_INELIGIBLE/);
            expect(result.context.nflEligibility.basis).toBeUndefined();
        });

        test('refused when the evidence is for a different week than the one judged', async () => {
            const result = await fallbackDb().validateRosterMove(1, 'DROP1', 'ADD1', 'ir',
                { asOf: ASKED, enqueueEvidence: withEvidence({ nflEligibility: { week: 4, reason: 'NFL.com Week 4 injury report lists Adonai Mitchell (NYJ) with Game Status "Out"' } }) });
            expect(result.valid).toBe(false);
            expect(result.errors).toEqual([PAGE_MISMATCH]);
            expect(result.context.nflEligibility).toMatchObject({ code: 'NFL_UNAVAILABLE', enqueueEvidenceRejected: 'enqueue evidence is for Week 4, judging Week 5' });
        });

        test('refused when the request asOf drifts into Week 6 even though the evidence itself is Week 5', async () => {
            const week6Asked = '2026-10-14T12:00:00Z';
            const result = await fallbackDb().validateRosterMove(1, 'DROP1', 'ADD1', 'ir',
                { asOf: week6Asked, enqueueEvidence: withEvidence({ asOf: week6Asked }) });
            expect(result.valid).toBe(false);
            expect(result.context.judgedWeek).toBe(6);
            expect(result.context.nflEligibility.enqueueEvidenceRejected).toBe('enqueue evidence is for Week 5, judging Week 6');
        });

        test('refused when the request asOf is not exactly the asOf the evidence was judged at', async () => {
            const oneSecondLater = '2026-10-10T18:25:18Z';
            const result = await fallbackDb().validateRosterMove(1, 'DROP1', 'ADD1', 'ir', { asOf: oneSecondLater, enqueueEvidence: ENQUEUE_EVIDENCE });
            expect(result.valid).toBe(false);
            expect(result.errors).toEqual([PAGE_MISMATCH]);
            expect(result.context.nflEligibility.enqueueEvidenceRejected).toMatch(/^request asOf 2026-10-10T18:25:18Z does not match enqueue evidence asOf 2026-10-10T18:25:17.000Z$/);
        });

        test('refused when the evidence names a different player, team or player_id', async () => {
            const cases = [
                [withEvidence({ nflEligibility: { player: { name: 'Garrett Wilson', team: 'NYJ' } } }), /names Garrett Wilson, judging Adonai Mitchell/],
                [withEvidence({ nflEligibility: { player: { name: 'Adonai Mitchell', team: 'IND' } } }), /team IND does not match NYJ/],
                [withEvidence({ dropPlayerId: 'OTHER' }), /for player OTHER, judging DROP1/]
            ];
            for (const [evidence, reason] of cases) {
                const result = await fallbackDb().validateRosterMove(1, 'DROP1', 'ADD1', 'ir', { asOf: ASKED, enqueueEvidence: evidence });
                expect(result.valid).toBe(false);
                expect(result.errors).toEqual([PAGE_MISMATCH]);
                expect(result.context.nflEligibility.enqueueEvidenceRejected).toMatch(reason);
            }
        });

        test('refused when the evidence is not a positive NFL.com verdict, or for another season', async () => {
            const cases = [
                [withEvidence({ nflEligibility: { eligible: false, code: 'NFL_INELIGIBLE' } }), 'enqueue evidence is not a positive NFL.com verdict'],
                [withEvidence({ nflEligibility: { code: 'SOMETHING_ELSE' } }), 'enqueue evidence is not a positive NFL.com verdict'],
                [withEvidence({ nflEligibility: { season: 2025 } }), 'enqueue evidence is for season 2025, judging 2026'],
                [{ nflEligibility: null }, 'enqueue evidence is not a positive NFL.com verdict']
            ];
            for (const [evidence, reason] of cases) {
                const result = await fallbackDb().validateRosterMove(1, 'DROP1', 'ADD1', 'ir', { asOf: ASKED, enqueueEvidence: evidence });
                expect(result.valid).toBe(false);
                expect(result.context.nflEligibility.enqueueEvidenceRejected).toBe(reason);
            }
        });

        test('a manual move (no asOf) never gets the fallback, even if evidence were passed', async () => {
            const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(APPROVED_MS);
            try {
                const result = await fallbackDb().validateRosterMove(1, 'DROP1', 'ADD1', 'ir', { enqueueEvidence: ENQUEUE_EVIDENCE });
                expect(result.valid).toBe(false);
                expect(result.context.judgedWeek).toBe(6);
                expect(result.context.nflEligibility.enqueueEvidenceRejected).toMatch(/^request asOf missing does not match/);
            } finally { nowSpy.mockRestore(); }
        });

        test('without evidence the historical-page failure still fails closed exactly as before', async () => {
            const result = await fallbackDb().validateRosterMove(1, 'DROP1', 'ADD1', 'ir', { asOf: ASKED });
            expect(result.valid).toBe(false);
            expect(result.errors).toEqual([PAGE_MISMATCH]);
            expect(result.context.nflEligibility).toMatchObject({ eligible: false, code: 'NFL_UNAVAILABLE' });
            expect(result.context.nflEligibility.enqueueEvidenceRejected).toBeUndefined();
        });

        test('a fresh positive verdict is used as-is; the evidence is never consulted', async () => {
            const fresh = { ...ELIGIBLE, reason: 'NFL.com Week 5 injury report lists Adonai Mitchell (NYJ) with Game Status "Out"', season: 2026, week: 5 };
            const result = await fallbackDb(eligibilityService(fresh)).validateRosterMove(1, 'DROP1', 'ADD1', 'ir',
                { asOf: ASKED, enqueueEvidence: withEvidence({ nflEligibility: { week: 4 } }) });
            expect(result.valid).toBe(true);
            expect(result.context.nflEligibility).toEqual(fresh);
        });
    });
});

/**
 * Commissioner override (options.overrideValidation): executeRosterMove /
 * executeTrade carry out a move the validator refuses, return exactly which
 * checks were set aside and write them to roster_moves.notes. Missing
 * players and the 19-active invariant are never overridden.
 */
describe('db.executeRosterMove commissioner override', () => {
    function writable(db, { count = 19 } = {}) {
        db.run = jest.fn(async () => ({}));
        const stubbedGet = db.get;
        db.get = (sql, params) => sql.includes('COUNT(*)') ? Promise.resolve({ count }) : stubbedGet(sql, params);
        return db;
    }
    const rosterMovesInsert = db => db.run.mock.calls.find(([sql]) => /INSERT INTO roster_moves/.test(sql));

    test('without the flag a refused move still throws before any write', async () => {
        const db = writable(mockedDb({ onRoster: null }));
        await expect(db.executeRosterMove(1, 'DROP1', 'ADD1', 'supplemental', { asOf: null }))
            .rejects.toMatchObject({ message: 'Player to drop is not on this team', query: 'roster_constraint' });
        expect(db.run).not.toHaveBeenCalled();
    });

    test('with the flag the refused move executes, reports the overridden checks and notes the reason', async () => {
        const db = writable(mockedDb({ onRoster: null }));
        const result = await db.executeRosterMove(1, 'DROP1', 'ADD1', 'supplemental', {
            asOf: null, overrideValidation: true, overrideReason: 'owner traded him Saturday, roster not yet synced'
        });
        expect(result.success).toBe(true);
        expect(result.overriddenErrors).toEqual(['Player to drop is not on this team']);
        expect(db.run).toHaveBeenCalledWith('BEGIN TRANSACTION');
        expect(db.run).toHaveBeenCalledWith('COMMIT');
        const [, params] = rosterMovesInsert(db);
        expect(params[params.length - 1]).toBe(
            'Commissioner override: owner traded him Saturday, roster not yet synced. Overrode validation: Player to drop is not on this team');
    });

    test('a move the validator accepts records no override even when the flag is set', async () => {
        const db = writable(mockedDb());
        const result = await db.executeRosterMove(1, 'DROP1', 'ADD1', 'supplemental', { overrideValidation: true, overrideReason: 'x' });
        expect(result.overriddenErrors).toBeNull();
        const [, params] = rosterMovesInsert(db);
        expect(params[params.length - 1]).toBeNull();
    });

    test('the IR gate can be overridden; the NFL.com evidence is still returned for the audit trail', async () => {
        const db = writable(mockedDb({ nflEligibilityService: ineligible() }));
        const result = await db.executeRosterMove(1, 'DROP1', 'ADD1', 'ir', { overrideValidation: true, overrideReason: 'commissioner ruling' });
        expect(result.overriddenErrors).toHaveLength(1);
        expect(result.overriddenErrors[0]).toMatch(/IR move not allowed/);
        expect(result.nflEligibility).toMatchObject({ eligible: false, code: 'NFL_INELIGIBLE' });
    });

    test('a missing player can never be overridden: nothing to execute', async () => {
        const db = writable(mockedDb({ addPlayer: null }));
        await expect(db.executeRosterMove(1, 'DROP1', 'ADD1', 'supplemental', { overrideValidation: true, overrideReason: 'x' }))
            .rejects.toMatchObject({ message: 'One or both players not found', query: 'not_found' });
        expect(db.run).not.toHaveBeenCalled();
    });

    test('the 19-active invariant still holds inside the transaction: the override rolls back', async () => {
        const db = writable(mockedDb({ onRoster: null }), { count: 20 });
        await expect(db.executeRosterMove(1, 'DROP1', 'ADD1', 'supplemental', { overrideValidation: true, overrideReason: 'x' }))
            .rejects.toThrow(/invalid active roster size: 20/);
        expect(db.run).toHaveBeenCalledWith('ROLLBACK');
        expect(db.run).not.toHaveBeenCalledWith('COMMIT');
    });

    test('a trade past the drop lock executes under override and notes the lock it overrode', async () => {
        const KICKOFF = Date.parse('2026-01-04T18:00:00Z');
        const game = { game_id: '20260104_KC@DEN', game_date: '20260104', game_time: '1:00p', game_time_epoch: KICKOFF / 1000, status: 'Final' };
        const db = mockedDb({
            dropPlayer: { player_id: 'DROP1', name: 'Drop Guy', position: 'RB', team: 'KC' },
            addPlayer: { player_id: 'ADD1', name: 'Add Guy', position: 'RB', team: 'DEN' },
            game
        });
        db.run = jest.fn(async () => ({}));
        const stubbedGet = db.get;
        db.get = (sql, params) => sql.includes('COUNT(*)') ? Promise.resolve({ count: 19 }) : stubbedGet(sql, params);
        db.all = async () => [{ position: 'QB', count: 2 }, { position: 'RB', count: 5 }, { position: 'WR', count: 6 }, { position: 'K', count: 2 }, { position: 'DST', count: 2 }];
        const late = { asOf: '2026-01-04T20:00:00Z' };

        await expect(db.executeTrade(1, 'DROP1', 2, 'ADD1', late)).rejects.toThrow(/already played this week/);
        expect(db.run).not.toHaveBeenCalled();

        const result = await db.executeTrade(1, 'DROP1', 2, 'ADD1', { ...late, overrideValidation: true, overrideReason: 'both owners agreed before kickoff' });
        expect(result.success).toBe(true);
        expect(result.overriddenErrors).toHaveLength(2); // both players' games had kicked off
        expect(db.run).toHaveBeenCalledWith('COMMIT');
        const [, params] = db.run.mock.calls.find(([sql]) => /INSERT INTO roster_moves/.test(sql));
        expect(params[params.length - 1]).toMatch(/Commissioner override: both owners agreed before kickoff\. Overrode validation: Cannot drop Drop Guy/);
    });
});
