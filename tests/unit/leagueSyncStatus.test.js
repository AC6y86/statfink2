/**
 * GET /api/league/sync-status must expose last_live_update (newest player_stats
 * write this season) - the public "is the site updating" probe in
 * scripts/lib/siteSanity.js reads it. Fake db, no database access.
 */
const express = require('express');
const request = require('supertest');
const leagueRouter = require('../../server/routes/league');
const { findLiveTimestamp } = require('../../scripts/lib/siteSanity');

function appWith(db) {
    const app = express();
    app.locals.db = db;
    app.use('/api/league', leagueRouter);
    return app;
}

describe('GET /api/league/sync-status', () => {
    test('reports the newest player_stats write as last_live_update', async () => {
        const db = {
            async getLeagueSettings() { return { season_year: 2026 }; },
            async get(sql, params) {
                if (/MAX\(last_updated\)/.test(sql)) { expect(params).toEqual([2026]); return { newest: '2026-09-14 01:16:07' }; }
                return { latest_week: 1, weeks_synced: 1, players_synced: 393, latest_season: 2026 };
            }
        };
        const res = await request(appWith(db)).get('/api/league/sync-status');
        expect(res.status).toBe(200);
        expect(res.body.data.last_live_update).toBe('2026-09-14 01:16:07');
        expect(res.body.data.latest_week).toBe(1);
        // the probe prefers this field over the response-time last_sync_time
        const found = findLiveTimestamp(res.body);
        expect(found.field).toBe('last_live_update');
        expect(found.ts).toBe(Date.parse('2026-09-14T01:16:07Z'));
    });

    test('is null before any stats exist this season', async () => {
        const db = {
            async getLeagueSettings() { return { season_year: 2027 }; },
            async get(sql) { return /MAX\(last_updated\)/.test(sql) ? { newest: null } : { latest_week: 0 }; }
        };
        const res = await request(appWith(db)).get('/api/league/sync-status');
        expect(res.body.data.last_live_update).toBeNull();
    });
});
