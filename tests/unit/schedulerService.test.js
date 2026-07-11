/**
 * Tests for SchedulerService weekly update - regression coverage for the
 * week-4-no-rosters incident (commit f327966) class of failures.
 * Fully mocked DB; never touches the real database.
 */
const SchedulerService = require('../../server/services/schedulerService');

function buildMocks({ currentWeek = 5, seasonYear = 2025, gamesComplete = true } = {}) {
    const state = {
        runCalls: [],
        rosterCopyCalls: [],
        settings: { current_week: currentWeek, season_year: seasonYear }
    };

    const db = {
        async getSchedulerTimestamps() { return {}; },
        async updateSchedulerTimestamp() { return {}; },
        async get(sql) {
            if (sql.includes('league_settings')) return state.settings;
            return null;
        },
        async all() { return []; },
        async run(sql, params) {
            state.runCalls.push({ sql, params });
            if (sql.includes('UPDATE league_settings SET current_week')) {
                state.settings = { ...state.settings, current_week: params[0] };
            }
            return {};
        },
        async copyRostersToNextWeek(fromWeek, toWeek, season) {
            state.rosterCopyCalls.push({ fromWeek, toWeek, season });
            return { success: true, entriesCopied: 228 };
        }
    };

    const nflGamesService = {
        async areAllWeekGamesComplete() {
            return gamesComplete
                ? { isComplete: true, completedGames: 16, totalGames: 16 }
                : { isComplete: false, completedGames: 10, totalGames: 16 };
        }
    };

    const standingsService = {
        async calculateWeeklyStandings() { return { success: true }; }
    };

    const scheduler = new SchedulerService(
        db, nflGamesService, null, null, standingsService, null, null, null, null
    );

    return { scheduler, db, state, standingsService };
}

describe('SchedulerService.performWeeklyUpdate', () => {
    test('does NOT advance the week when games are incomplete', async () => {
        const { scheduler, state } = buildMocks({ gamesComplete: false });

        const result = await scheduler.performWeeklyUpdate();

        expect(result.success).toBe(false);
        expect(result.message).toContain('Not all games complete');
        // No week advance and no roster copy happened
        const advances = state.runCalls.filter(c => c.sql.includes('UPDATE league_settings'));
        expect(advances.length).toBe(0);
        expect(state.rosterCopyCalls.length).toBe(0);
    });

    test('advances the week and copies rosters when all games are complete', async () => {
        const { scheduler, state } = buildMocks({ currentWeek: 5, gamesComplete: true });

        const result = await scheduler.performWeeklyUpdate();

        expect(result.success).toBe(true);
        expect(result.results.standings).toBe(true);
        expect(result.results.weekAdvance).toBe(true);
        expect(result.results.rosterCopy).toBe(true);
        // Rosters copied from the completed week into the new week
        expect(state.rosterCopyCalls).toEqual([{ fromWeek: 5, toWeek: 6, season: 2025 }]);
    });

    test('never advances beyond week 18', async () => {
        const { scheduler, state } = buildMocks({ currentWeek: 18, gamesComplete: true });

        const result = await scheduler.performWeeklyUpdate();

        expect(result.results.weekAdvance).toBe(false);
        expect(result.results.errors.some(e => e.includes('beyond week 18'))).toBe(true);
        expect(state.rosterCopyCalls.length).toBe(0);
    });

    test('aggregates errors into results.errors instead of dying silently', async () => {
        const { scheduler, standingsService } = buildMocks({ gamesComplete: true });
        standingsService.calculateWeeklyStandings = async () => {
            throw new Error('standings exploded');
        };

        const result = await scheduler.performWeeklyUpdate();

        expect(result.results.errors.some(e => e.includes('standings exploded'))).toBe(true);
        // Week advance still proceeds independently of the standings failure
        expect(result.results.weekAdvance).toBe(true);
    });

    test('roster copy failure is captured in results.errors (week-4-no-rosters regression)', async () => {
        const { scheduler, db } = buildMocks({ gamesComplete: true });
        db.copyRostersToNextWeek = async () => {
            throw new Error('no rosters copied');
        };

        const result = await scheduler.performWeeklyUpdate();

        expect(result.results.rosterCopy).toBe(false);
        expect(result.results.errors.some(e => e.includes('no rosters copied'))).toBe(true);
    });

    test('records alerts for errors via healthCheckService when wired', async () => {
        const { scheduler, standingsService } = buildMocks({ gamesComplete: true });
        const alerts = [];
        scheduler.healthCheckService = {
            async recordAlert(severity, source, message) { alerts.push({ severity, source, message }); },
            async runValidation() { return { overallStatus: 'passed', summary: {} }; }
        };
        standingsService.calculateWeeklyStandings = async () => {
            throw new Error('standings exploded');
        };

        await scheduler.performWeeklyUpdate();

        expect(alerts.some(a => a.severity === 'critical' && a.message.includes('standings exploded'))).toBe(true);
    });
});

describe('SchedulerService.pruneBackups', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');

    let dir;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-test-'));
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function touch(name) {
        fs.writeFileSync(path.join(dir, name), 'x');
    }

    test('keeps last 14 dailies plus first backup of each month, prunes the rest', async () => {
        for (const m of ['03', '04', '05']) {
            for (let d = 1; d <= 28; d += 3) {
                touch(`fantasy_football_2026-${m}-${String(d).padStart(2, '0')}.db`);
            }
        }

        const scheduler = Object.create(SchedulerService.prototype);
        const result = await scheduler.pruneBackups(dir);

        const remaining = fs.readdirSync(dir);
        // 14 newest + month-firsts for the 2 earlier months
        expect(remaining.length).toBe(16);
        expect(remaining).toContain('fantasy_football_2026-03-01.db');
        expect(remaining).toContain('fantasy_football_2026-04-01.db');
        expect(remaining).toContain('fantasy_football_2026-05-28.db');
        expect(remaining).not.toContain('fantasy_football_2026-03-04.db');
        expect(result.pruned.length).toBe(14);
    });

    test('never touches files that do not match the backup filename pattern', async () => {
        touch('fantasy_football_2026-01-01.db');
        touch('fantasy_football.db-wal');
        touch('manual_backup.db');
        touch('fantasy_football_2026-01-02.db.bak');
        touch('notes.txt');

        const scheduler = Object.create(SchedulerService.prototype);
        await scheduler.pruneBackups(dir);

        const remaining = fs.readdirSync(dir).sort();
        expect(remaining).toEqual([
            'fantasy_football.db-wal',
            'fantasy_football_2026-01-01.db',
            'fantasy_football_2026-01-02.db.bak',
            'manual_backup.db',
            'notes.txt'
        ]);
    });

    test('dry-run reports but does not delete', async () => {
        for (let d = 1; d <= 28; d++) {
            touch(`fantasy_football_2026-05-${String(d).padStart(2, '0')}.db`);
        }

        const scheduler = Object.create(SchedulerService.prototype);
        const result = await scheduler.pruneBackups(dir, { dryRun: true });

        expect(result.dryRun).toBe(true);
        expect(result.pruned.length).toBeGreaterThan(0);
        expect(fs.readdirSync(dir).length).toBe(28); // nothing deleted
    });
});
