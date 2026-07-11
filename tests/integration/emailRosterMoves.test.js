/**
 * Integration tests for the email roster-move HTTP surface:
 *   POST /api/internal/roster-email          (poller ingest: token, dedup, routing)
 *   GET  /api/admin/pending-moves            (queue listing)
 *   POST /api/admin/pending-moves/:id/approve
 *   POST /api/admin/pending-moves/:id/reject
 *
 * Mounts the real routers on a minimal express app with the real services
 * behind them - only the db and the Claude backend are fakes, and the queue
 * lives in a tmp file. No real database, no claude subprocess.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');

const internalRouter = require('../../server/routes/internal');
const adminRouter = require('../../server/routes/admin');
const { errorHandler } = require('../../server/utils/errorHandler');
const EmailMoveParsingService = require('../../server/services/emailMoveParsingService');
const PendingMovesService = require('../../server/services/pendingMovesService');
const { OWNERS, EMAILS, CANNED_RESPONSES } = require('../fixtures/rosterMoveEmails');

const INTERNAL_TOKEN = 'statfink-internal-cron';

const PLAYERS = [
    { player_id: 'P_DELL', name: 'Tank Dell', position: 'WR', team: 'HOU' },
    { player_id: 'P_FLACCO', name: 'Joe Flacco', position: 'QB', team: 'CLE' }
];

function mockDb({ dryRunValid = true, executeThrows = null } = {}) {
    return {
        async get(sql, params) {
            if (sql.includes('league_settings')) return { current_week: 18, season_year: 2025 };
            if (sql.includes('FROM nfl_players WHERE player_id')) {
                return PLAYERS.find(p => p.player_id === params[0]) || null;
            }
            return null;
        },
        async all(sql) {
            if (sql.includes("roster_position = 'active'")) {
                return [{ player_id: 'P_DELL', player_name: 'Tank Dell', player_position: 'WR', player_team: 'HOU' }];
            }
            if (sql.includes('injured_reserve')) return [];
            if (sql.includes('FROM nfl_players')) return PLAYERS;
            if (sql.includes('FROM teams')) return [{ team_id: 1, team_name: "Chris's Team", owner_name: 'Chris' }];
            return [];
        },
        validateRosterMove: jest.fn(async () => ({
            valid: dryRunValid,
            errors: dryRunValid ? [] : ['Player to add is not available'],
            context: {}
        })),
        executeRosterMove: jest.fn(async () => {
            if (executeThrows) throw new Error(executeThrows);
            return { success: true, dropped: { name: 'Tank Dell' }, added: { name: 'Joe Flacco' } };
        }),
        executeTrade: jest.fn(async () => ({ success: true }))
    };
}

/**
 * Build a test app: real routers + real services, fake db/backend/queue.
 * backendResponses: what the fake Claude returns, in order (last one repeats).
 */
function buildApp({ backendResponses = [], db = mockDb() } = {}) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'email-moves-int-'));
    const ownersFile = path.join(tmp, 'owners.json');
    fs.writeFileSync(ownersFile, JSON.stringify(OWNERS));

    const responses = [...backendResponses];
    const backend = {
        calls: [],
        async run(prompt) {
            this.calls.push(prompt);
            const next = responses.length > 1 ? responses.shift() : responses[0];
            if (next === undefined) throw new Error('fake backend has no response configured');
            return typeof next === 'string' ? next : JSON.stringify(next);
        }
    };

    const app = express();
    app.use(express.json());
    app.use('/api/internal', internalRouter);
    app.use('/api/admin', adminRouter);
    app.use(errorHandler);

    app.locals.db = db;
    app.locals.emailMoveParsingService = new EmailMoveParsingService(db, { parserBackend: backend, ownersFile });
    app.locals.pendingMovesService = new PendingMovesService(db, { queueFile: path.join(tmp, 'queue.json') });
    app.locals.healthCheckService = { recordAlert: jest.fn(async () => ({})) };

    return { app, backend, db };
}

function ingest(app, email) {
    return request(app)
        .post('/api/internal/roster-email')
        .set('X-Internal-Token', INTERNAL_TOKEN)
        .send(email);
}

beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    console.log.mockRestore();
});

describe('POST /api/internal/roster-email', () => {
    test('rejects requests without the internal token', async () => {
        const { app } = buildApp();
        const res = await request(app).post('/api/internal/roster-email').send(EMAILS.simpleSupplemental);
        expect(res.status).toBe(403);
    });

    test('rejects emails missing required fields', async () => {
        const { app } = buildApp();
        const res = await ingest(app, { from: 'chris@example.com' });
        expect(res.status).toBe(400);
    });

    test('queues a cleanly parsed move and records an info alert', async () => {
        const { app } = buildApp({ backendResponses: [CANNED_RESPONSES.simpleSupplemental] });

        const res = await ingest(app, EMAILS.simpleSupplemental);

        expect(res.status).toBe(200);
        expect(res.body.queued).toBe(true);
        expect(res.body.items).toHaveLength(1);
        expect(res.body.items[0].status).toBe('pending');
        expect(app.locals.healthCheckService.recordAlert).toHaveBeenCalledWith(
            'info', 'email-moves', expect.stringContaining('chris@example.com'), null
        );
    });

    test('dedups a re-sent message id without re-parsing', async () => {
        const { app, backend } = buildApp({ backendResponses: [CANNED_RESPONSES.simpleSupplemental] });

        await ingest(app, EMAILS.simpleSupplemental);
        const res = await ingest(app, EMAILS.simpleSupplemental);

        expect(res.body).toEqual({ success: true, queued: false, reason: 'duplicate' });
        expect(backend.calls).toHaveLength(1); // second request never reached Claude
    });

    test('banter is recorded as processed and never re-parsed', async () => {
        const { app, backend } = buildApp({ backendResponses: [CANNED_RESPONSES.banter] });

        const first = await ingest(app, EMAILS.banter);
        expect(first.body.queued).toBe(false);
        expect(first.body.reason).toBe('not_a_roster_move');

        const second = await ingest(app, EMAILS.banter);
        expect(second.body.reason).toBe('duplicate');
        expect(backend.calls).toHaveLength(1);
    });

    test('unknown senders are ignored without calling Claude', async () => {
        const { app, backend } = buildApp();

        const res = await ingest(app, EMAILS.unknownSender);

        expect(res.body.queued).toBe(false);
        expect(res.body.reason).toBe('unknown_sender');
        expect(backend.calls).toHaveLength(0);
    });

    test('ambiguous email queues a needs_review item and a warning alert', async () => {
        const { app } = buildApp({
            backendResponses: [{
                status: 'ambiguous', sender_team_id: 1,
                summary: 'Cannot tell which Brown', questions_for_commissioner: ['Which Brown?'], moves: []
            }]
        });

        const res = await ingest(app, EMAILS.nickname);

        expect(res.body.queued).toBe(true);
        expect(res.body.items[0].status).toBe('needs_review');
        expect(app.locals.healthCheckService.recordAlert).toHaveBeenCalledWith(
            'warning', 'email-moves', expect.stringContaining('needs review'), ['Which Brown?']
        );
    });
});

describe('admin pending-moves endpoints', () => {
    async function appWithQueuedMove(opts = {}) {
        const built = buildApp({ backendResponses: [CANNED_RESPONSES.simpleSupplemental], ...opts });
        const res = await ingest(built.app, EMAILS.simpleSupplemental);
        return { ...built, itemId: res.body.items[0].id };
    }

    test('lists items with pendingCount, filters by status', async () => {
        const { app } = await appWithQueuedMove();

        const all = await request(app).get('/api/admin/pending-moves');
        expect(all.status).toBe(200);
        expect(all.body.data.items).toHaveLength(1);
        expect(all.body.data.pendingCount).toBe(1);
        expect(all.body.data.items[0].email.from).toBe('chris@example.com');

        const none = await request(app).get('/api/admin/pending-moves?status=approved');
        expect(none.body.data.items).toHaveLength(0);
    });

    test('approve executes the move and returns the executed item', async () => {
        const { app, db, itemId } = await appWithQueuedMove();

        const res = await request(app).post(`/api/admin/pending-moves/${itemId}/approve`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.status).toBe('approved');
        expect(res.body.message).toContain('Tank Dell -> Joe Flacco');
        expect(db.executeRosterMove).toHaveBeenCalledWith(1, 'P_DELL', 'P_FLACCO', 'supplemental');
    });

    test('approve with a moveType override executes as the corrected type', async () => {
        const { app, db, itemId } = await appWithQueuedMove();

        const res = await request(app)
            .post(`/api/admin/pending-moves/${itemId}/approve`)
            .send({ moveType: 'ir' });

        expect(res.body.success).toBe(true);
        expect(res.body.data.move.move_type).toBe('ir');
        expect(res.body.data.move.original_move_type).toBe('supplemental');
        expect(db.executeRosterMove).toHaveBeenCalledWith(1, 'P_DELL', 'P_FLACCO', 'ir');
    });

    test('approve reports failure when execution throws (roster changed since enqueue)', async () => {
        const { app, itemId } = await appWithQueuedMove({
            db: mockDb({ executeThrows: 'Player to add is not available' })
        });

        const res = await request(app).post(`/api/admin/pending-moves/${itemId}/approve`);

        expect(res.body.success).toBe(false);
        expect(res.body.data.status).toBe('failed');
        expect(res.body.message).toContain('not available');
    });

    test('reject records the reason and the item stays unexecuted', async () => {
        const { app, db, itemId } = await appWithQueuedMove();

        const res = await request(app)
            .post(`/api/admin/pending-moves/${itemId}/reject`)
            .send({ reason: 'owner retracted' });

        expect(res.body.data.status).toBe('rejected');
        expect(res.body.data.executionResult.message).toBe('owner retracted');
        expect(db.executeRosterMove).not.toHaveBeenCalled();
    });

    test('resolving an already-resolved item errors instead of double-executing', async () => {
        const { app, db, itemId } = await appWithQueuedMove();

        await request(app).post(`/api/admin/pending-moves/${itemId}/approve`);
        const again = await request(app).post(`/api/admin/pending-moves/${itemId}/approve`);

        expect(again.status).toBe(500);
        expect(db.executeRosterMove).toHaveBeenCalledTimes(1);
    });
});
