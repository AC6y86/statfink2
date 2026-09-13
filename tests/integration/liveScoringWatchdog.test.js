/**
 * HealthCheckService.checkLiveScoring - the read-only signals behind the
 * live-scoring watchdog (GET /api/internal/health/live, polled by
 * scripts/live-watchdog.js). Uses a throwaway temp DB; never touches the
 * real database.
 */

const os = require('os');
const path = require('path');
const { createTempDb, cleanupTempDb } = require('../helpers/tempDb');
const HealthCheckService = require('../../server/services/healthCheckService');

const SEASON = 2026;
const nowSec = () => Math.floor(Date.now() / 1000);
const signal = (result, name) => result.signals.find(s => s.name === name);

describe('HealthCheckService.checkLiveScoring (live watchdog signals)', () => {
    let db;
    let service;

    beforeAll(async () => {
        db = await createTempDb('live-watchdog');
        // Stat rows need no nfl_players parent for these checks
        await db.run('PRAGMA foreign_keys = OFF');
        try {
            await db.run('ALTER TABLE league_settings ADD COLUMN last_live_update DATETIME');
        } catch (_) { /* column already present */ }
        await db.run('INSERT OR REPLACE INTO league_settings (league_id, season_year, current_week) VALUES (1, ?, 1)', [SEASON]);

        service = new HealthCheckService(db, {
            alertsFile: path.join(os.tmpdir(), `live-watchdog-alerts-${process.pid}.json`),
            watchdogDir: false,
            dbPath: db.__tempPath
        });
    });

    afterAll(async () => {
        await cleanupTempDb(db);
    });

    beforeEach(async () => {
        await db.run('DELETE FROM nfl_games');
        await db.run('DELETE FROM player_stats');
        await db.run('UPDATE league_settings SET current_week = 1, season_year = ? WHERE league_id = 1', [SEASON]);
        await setLoopAge(30);
    });

    async function setLoopAge(seconds) {
        await db.run("UPDATE league_settings SET last_live_update = datetime('now', ?) WHERE league_id = 1",
            [`-${seconds} seconds`]);
    }

    async function addGame({ id, week = 1, status = 'Scheduled', kickoffInSec = 0, updatedAgoSec = 30, home = 0, away = 0 }) {
        await db.run(`
            INSERT INTO nfl_games (game_id, week, season, home_team, away_team, home_score, away_score,
                                   status, game_time_epoch, last_updated)
            VALUES (?, ?, ?, 'KC', 'SF', ?, ?, ?, ?, datetime('now', ?))`,
            [id, week, SEASON, home, away, status, nowSec() + kickoffInSec, `-${updatedAgoSec} seconds`]);
    }

    async function addStat(updatedAgoSec, week = 1) {
        await db.run(`
            INSERT INTO player_stats (player_id, week, season, fantasy_points, last_updated)
            VALUES ('P1', ?, ?, 10, datetime('now', ?))`,
            [week, SEASON, `-${updatedAgoSec} seconds`]);
    }

    test('idle when no games are in the live window and the loop is ticking', async () => {
        const r = await service.checkLiveScoring();
        expect(r.status).toBe('idle');
        expect(r.severity).toBe('ok');
        expect(r.expectedGames).toBe(0);
        expect(r.loopAgeSec).toBeLessThan(120);
        expect(r.signals.every(s => s.ok)).toBe(true);
    });

    test('ok when a game is in progress, being rewritten, and stats are flowing', async () => {
        await addGame({ id: 'G1', status: 'Q2 5:00', kickoffInSec: -1800, updatedAgoSec: 30, home: 7, away: 3 });
        await addStat(60);
        const r = await service.checkLiveScoring();
        expect(r.status).toBe('ok');
        expect(r.severity).toBe('ok');
        expect(r.expectedGames).toBe(1);
        expect(r.gamesInProgress).toBe(1);
        expect(r.summary).toContain('stats flowing');
    });

    test('ok for a game that kicks off in 10 minutes (nothing to be fresh yet)', async () => {
        await addGame({ id: 'G1', status: 'Scheduled', kickoffInSec: 600, updatedAgoSec: 4 * 3600 });
        const r = await service.checkLiveScoring();
        expect(r.status).toBe('ok');
        expect(r.expectedGames).toBe(1);
        expect(signal(r, 'game_freshness').ok).toBe(true);
        expect(signal(r, 'game_freshness').detail).toContain('no current-week game has kicked off');
    });

    test('stalled/critical when the loop heartbeat is stale during a live game', async () => {
        await addGame({ id: 'G1', status: 'Q1 10:00', kickoffInSec: -900, updatedAgoSec: 30 });
        await setLoopAge(400);
        const r = await service.checkLiveScoring();
        expect(r.status).toBe('stalled');
        expect(r.severity).toBe('critical');
        const hb = signal(r, 'loop_heartbeat');
        expect(hb.ok).toBe(false);
        expect(hb.severity).toBe('critical');
        expect(hb.detail).toContain('not ticking');
    });

    test('stalled/warning (not critical) when the loop is stale but nothing is live', async () => {
        await setLoopAge(400);
        const r = await service.checkLiveScoring();
        expect(r.status).toBe('stalled');
        expect(r.severity).toBe('warning');
    });

    test('never-recorded heartbeat is reported', async () => {
        await db.run('UPDATE league_settings SET last_live_update = NULL WHERE league_id = 1');
        const r = await service.checkLiveScoring();
        expect(r.loopAgeSec).toBeNull();
        expect(signal(r, 'loop_heartbeat').ok).toBe(false);
        expect(r.summary).toContain('never');
    });

    test('stalled when a game is still Scheduled 0-0 25 minutes after kickoff', async () => {
        await addGame({ id: 'G1', status: 'Scheduled', kickoffInSec: -25 * 60, updatedAgoSec: 30 });
        const r = await service.checkLiveScoring();
        expect(r.status).toBe('stalled');
        expect(r.severity).toBe('critical');
        expect(signal(r, 'game_freshness').detail).toContain('still Scheduled');
    });

    test('a game only 10 minutes past kickoff may still be Scheduled', async () => {
        await addGame({ id: 'G1', status: 'Scheduled', kickoffInSec: -600, updatedAgoSec: 3600 });
        const r = await service.checkLiveScoring();
        expect(r.status).toBe('ok');
        expect(signal(r, 'game_freshness').ok).toBe(true);
    });

    test('stalled when an in-progress game has not been rewritten in 5 minutes', async () => {
        await addGame({ id: 'G1', status: 'Q3 1:00', kickoffInSec: -5400, updatedAgoSec: 600, home: 14, away: 10 });
        await addStat(60);
        const r = await service.checkLiveScoring();
        expect(r.status).toBe('stalled');
        expect(r.severity).toBe('critical');
        expect(signal(r, 'game_freshness').detail).toContain('not updated');
    });

    test('misconfigured when a game kicks off in a week other than current_week', async () => {
        await addGame({ id: 'G2', week: 2, status: 'Scheduled', kickoffInSec: 300 });
        const r = await service.checkLiveScoring();
        expect(r.status).toBe('misconfigured');
        expect(r.severity).toBe('critical');
        expect(signal(r, 'week_match').detail).toContain('ADVANCE THE WEEK');
        expect(r.summary).toContain('current_week is 1');
    });

    test('degraded/warning when game status moves but player_stats do not', async () => {
        await addGame({ id: 'G1', status: 'Q2 8:00', kickoffInSec: -1800, updatedAgoSec: 30, home: 3, away: 0 });
        await addStat(25 * 60);
        const r = await service.checkLiveScoring();
        expect(r.status).toBe('degraded');
        expect(r.severity).toBe('warning');
        const sf = signal(r, 'stats_flow');
        expect(sf.ok).toBe(false);
        expect(sf.detail).toContain('not being written');
    });

    test('stats flow is not judged in the first minutes of a game', async () => {
        await addGame({ id: 'G1', status: 'Q1 12:00', kickoffInSec: -300, updatedAgoSec: 30 });
        const r = await service.checkLiveScoring();
        expect(r.status).toBe('ok');
        expect(signal(r, 'stats_flow').ok).toBe(true);
        expect(signal(r, 'stats_flow').detail).toContain('long enough to judge');
    });

    test('Final/OT games inside the window are not expected activity', async () => {
        await addGame({ id: 'G1', status: 'Final/OT', kickoffInSec: -3600, updatedAgoSec: 1200, home: 27, away: 24 });
        await addGame({ id: 'G2', status: 'Final', kickoffInSec: -3600, updatedAgoSec: 1200, home: 20, away: 17 });
        const r = await service.checkLiveScoring();
        expect(r.status).toBe('idle');
        expect(r.expectedGames).toBe(0);
    });

    test('degraded when the last live update swallowed errors during games', async () => {
        await addGame({ id: 'G1', status: 'Q2 5:00', kickoffInSec: -1800, updatedAgoSec: 30, home: 7, away: 3 });
        await addStat(60);
        const r = await service.checkLiveScoring({ liveErrors: ['Game scores: Tank01 429'] });
        expect(r.status).toBe('degraded');
        expect(r.severity).toBe('warning');
        expect(signal(r, 'live_errors').detail).toContain('Tank01 429');
    });

    test('stale errors while idle do not degrade', async () => {
        const r = await service.checkLiveScoring({ liveErrors: ['Game scores: old'] });
        expect(r.status).toBe('idle');
        expect(r.severity).toBe('ok');
    });

    test('misconfigured when league settings have no current week', async () => {
        await db.run('UPDATE league_settings SET current_week = NULL WHERE league_id = 1');
        const r = await service.checkLiveScoring();
        expect(r.status).toBe('misconfigured');
        expect(r.severity).toBe('critical');
        expect(r.summary).toContain('not set');
    });

    test('every line carries status, severity and a summary', async () => {
        await addGame({ id: 'G1', status: 'Q4 2:00', kickoffInSec: -9000, updatedAgoSec: 30 });
        await setLoopAge(500);
        const r = await service.checkLiveScoring();
        expect(typeof r.status).toBe('string');
        expect(['ok', 'warning', 'critical']).toContain(r.severity);
        expect(r.summary.length).toBeGreaterThan(0);
        expect(r.summary.length).toBeLessThanOrEqual(400);
        for (const s of r.signals) {
            expect(typeof s.name).toBe('string');
            expect(typeof s.ok).toBe('boolean');
            if (!s.ok) expect(['warning', 'critical']).toContain(s.severity);
        }
    });
});
