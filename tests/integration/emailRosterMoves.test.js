/**
 * Integration tests for the email roster-move HTTP surface:
 *   POST /api/internal/roster-email          (poller ingest: token, dedup, routing)
 *   GET  /api/admin/pending-moves            (queue listing)
 *   POST /api/admin/pending-moves/:id/approve   (also retries a failed item)
 *   POST /api/admin/pending-moves/:id/override  (commissioner override of an invalid item)
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

function mockDb({ dryRunValid = true, executeThrows = null, answers = null } = {}) {
    let validateCall = 0;
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
        validateRosterMove: jest.fn(async () => {
            const answer = answers ? answers[Math.min(validateCall++, answers.length - 1)] : null;
            const valid = answer ? answer.valid : dryRunValid;
            return {
                valid,
                errors: answer ? (answer.errors || []) : (valid ? [] : ['Player to add is not available']),
                context: { nflEligibility: (answer && answer.nflEligibility) || null }
            };
        }),
        executeRosterMove: jest.fn(async (teamId, drop, add, type, options = {}) => {
            if (executeThrows) {
                // Like the real one: a commissioner override executes a refused move and reports what it overrode
                if (!options.overrideValidation) throw new Error(executeThrows);
                return { success: true, dropped: { name: 'Tank Dell' }, added: { name: 'Joe Flacco' }, overriddenErrors: [executeThrows] };
            }
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
            'info', 'email-moves', expect.stringContaining('chris@example.com'), null,
            { emailId: 'e1', pendingItemIds: [res.body.items[0].id] }
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
            'warning', 'email-moves', expect.stringContaining('needs review'), ['Which Brown?'],
            { emailId: 'e8', pendingItemIds: [res.body.items[0].id] }
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
        expect(db.executeRosterMove).toHaveBeenCalledWith(1, 'P_DELL', 'P_FLACCO', 'supplemental', { asOf: expect.any(String) });
    });

    test('approve with a moveType override executes as the corrected type', async () => {
        const { app, db, itemId } = await appWithQueuedMove();

        const res = await request(app)
            .post(`/api/admin/pending-moves/${itemId}/approve`)
            .send({ moveType: 'ir' });

        expect(res.body.success).toBe(true);
        expect(res.body.data.move.move_type).toBe('ir');
        expect(res.body.data.move.original_move_type).toBe('supplemental');
        expect(db.executeRosterMove).toHaveBeenCalledWith(1, 'P_DELL', 'P_FLACCO', 'ir', { asOf: expect.any(String) });
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

    test('recheck re-runs validation against NFL.com without executing, and promotes when it passes', async () => {
        const NFL_OUT = {
            eligible: true, code: 'OUT_ON_INJURY_REPORT', source: 'nfl.com',
            reason: 'NFL.com Week 18 injury report lists Tank Dell (HOU) with Game Status "Out"',
            observedStatus: 'Game Status: Out', checkedAt: '2026-09-25T12:00:00.000Z',
            sources: ['https://www.nfl.com/injuries/league/2025/reg18']
        };
        const { app, db, itemId } = await appWithQueuedMove({
            db: mockDb({ answers: [
                { valid: false, errors: ['IR move not allowed: NFL.com does not list Tank Dell (HOU) as Out or on Reserve/Injured'], nflEligibility: { eligible: false, code: 'NFL_INELIGIBLE' } },
                { valid: true, nflEligibility: NFL_OUT }
            ] })
        });

        const before = await request(app).get('/api/admin/pending-moves');
        expect(before.body.data.items[0].status).toBe('needs_review');

        const res = await request(app).post(`/api/admin/pending-moves/${itemId}/recheck`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.status).toBe('pending');
        expect(res.body.data.validation.nflEligibility).toMatchObject({ eligible: true, code: 'OUT_ON_INJURY_REPORT' });
        expect(res.body.message).toContain('Game Status "Out"');
        expect(db.executeRosterMove).not.toHaveBeenCalled();
        expect(db.validateRosterMove).toHaveBeenCalledTimes(2);
    });

    test('a recheck that still fails answers success:false and leaves the item in needs_review', async () => {
        const { app, db, itemId } = await appWithQueuedMove({
            db: mockDb({ answers: [{ valid: false, errors: ['Validation failed: fresh NFL.com data unavailable (HTTP 503 for https://www.nfl.com/injuries/league/2025/reg18)'], nflEligibility: { eligible: false, code: 'NFL_UNAVAILABLE' } }] })
        });

        const res = await request(app).post(`/api/admin/pending-moves/${itemId}/recheck`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(false);
        expect(res.body.data.status).toBe('needs_review');
        expect(res.body.message).toContain('fresh NFL.com data unavailable');
        expect(db.executeRosterMove).not.toHaveBeenCalled();
    });

    test('recheck of a resolved item errors instead of silently reopening it', async () => {
        const { app, db, itemId } = await appWithQueuedMove();
        await request(app).post(`/api/admin/pending-moves/${itemId}/reject`).send({ reason: 'no' });

        const res = await request(app).post(`/api/admin/pending-moves/${itemId}/recheck`);

        expect(res.status).toBe(500);
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

describe('failed executions stay on the list and can be retried', () => {
    async function appWithFailedMove(message = "Player is already on Matt's Team (owned by Matt)") {
        const built = buildApp({ backendResponses: [CANNED_RESPONSES.simpleSupplemental], db: mockDb({ executeThrows: message }) });
        const res = await ingest(built.app, EMAILS.simpleSupplemental);
        const itemId = res.body.items[0].id;
        const failed = await request(built.app).post(`/api/admin/pending-moves/${itemId}/approve`);
        expect(failed.body.data.status).toBe('failed');
        return { ...built, itemId };
    }

    test('the failed item is still listed, counted as waiting, and carries the execution error', async () => {
        const { app, itemId } = await appWithFailedMove();

        const list = await request(app).get('/api/admin/pending-moves');
        const item = list.body.data.items.find(i => i.id === itemId);
        expect(item.status).toBe('failed');
        expect(item.executionResult).toMatchObject({ success: false, message: "Player is already on Matt's Team (owned by Matt)", mode: 'approve' });
        expect(item.resolvedAt).toBeNull();
        expect(list.body.data.pendingCount).toBe(1);
        const failedOnly = await request(app).get('/api/admin/pending-moves?status=failed');
        expect(failedOnly.body.data.items).toHaveLength(1);
    });

    test('approve again retries through the validator; it succeeds once the cause is gone', async () => {
        const { app, db, itemId } = await appWithFailedMove();

        const still = await request(app).post(`/api/admin/pending-moves/${itemId}/approve`);
        expect(still.status).toBe(200);
        expect(still.body.success).toBe(false);
        expect(still.body.data.status).toBe('failed');
        expect(still.body.data.executionAttempts.map(a => a.mode)).toEqual(['approve', 'retry']);

        db.executeRosterMove.mockImplementation(async () => ({ success: true, dropped: { name: 'Tank Dell' }, added: { name: 'Joe Flacco' } }));
        const ok = await request(app).post(`/api/admin/pending-moves/${itemId}/approve`);
        expect(ok.body.success).toBe(true);
        expect(ok.body.data.status).toBe('approved');
        const list = await request(app).get('/api/admin/pending-moves');
        expect(list.body.data.pendingCount).toBe(0);
    });

    test('reject dismisses a failed item and keeps the failure on record', async () => {
        const { app, itemId } = await appWithFailedMove();

        const res = await request(app).post(`/api/admin/pending-moves/${itemId}/reject`).send({ reason: 'handled by hand' });
        expect(res.body.data.status).toBe('rejected');
        expect(res.body.data.executionResult).toEqual({ success: false, message: 'handled by hand', lastFailure: "Player is already on Matt's Team (owned by Matt)" });
    });
});

describe('POST /api/admin/pending-moves/:id/override (commissioner override)', () => {
    test('executes an invalid (needs_review) move with the override flag and records the reason', async () => {
        const { app, db } = buildApp({ backendResponses: [CANNED_RESPONSES.simpleSupplemental], db: mockDb({ dryRunValid: false, executeThrows: 'Player to add is not available' }) });
        const ingested = await ingest(app, EMAILS.simpleSupplemental);
        const itemId = ingested.body.items[0].id;
        expect(ingested.body.items[0].status).toBe('needs_review');

        const res = await request(app).post(`/api/admin/pending-moves/${itemId}/override`).send({ reason: 'Commissioner ruling: add was agreed before the drop' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.status).toBe('approved');
        expect(res.body.data.override).toMatchObject({ reason: 'Commissioner ruling: add was agreed before the drop', by: 'commissioner', overriddenErrors: ['Player to add is not available'] });
        expect(res.body.message).toContain('Override executed');
        expect(res.body.message).toContain('overrode: Player to add is not available');
        expect(db.executeRosterMove).toHaveBeenCalledWith(1, 'P_DELL', 'P_FLACCO', 'supplemental',
            { asOf: expect.any(String), overrideValidation: true, overrideReason: 'Commissioner ruling: add was agreed before the drop' });
    });

    test('overrides a move that failed at execution', async () => {
        const { app, db } = buildApp({ backendResponses: [CANNED_RESPONSES.simpleSupplemental], db: mockDb({ executeThrows: "Player is already on Matt's Team (owned by Matt)" }) });
        const ingested = await ingest(app, EMAILS.simpleSupplemental);
        const itemId = ingested.body.items[0].id;
        await request(app).post(`/api/admin/pending-moves/${itemId}/approve`);

        const res = await request(app).post(`/api/admin/pending-moves/${itemId}/override`).send({ reason: 'ruling', moveType: 'ir' });
        expect(res.body.success).toBe(true);
        expect(res.body.data.status).toBe('approved');
        expect(res.body.data.move.move_type).toBe('ir');
        expect(res.body.data.executionAttempts.map(a => a.mode)).toEqual(['approve', 'override']);
        expect(db.executeRosterMove).toHaveBeenLastCalledWith(1, 'P_DELL', 'P_FLACCO', 'ir', expect.objectContaining({ overrideValidation: true, overrideReason: 'ruling' }));
    });

    test('is explicit and narrow: 400 without a reason, 400 for a move that is not invalid, nothing executes', async () => {
        const { app, db } = buildApp({ backendResponses: [CANNED_RESPONSES.simpleSupplemental] });
        const ingested = await ingest(app, EMAILS.simpleSupplemental);
        const itemId = ingested.body.items[0].id;
        expect(ingested.body.items[0].status).toBe('pending');

        const noReason = await request(app).post(`/api/admin/pending-moves/${itemId}/override`).send({});
        expect(noReason.status).toBe(400);
        expect(noReason.body.message).toMatch(/requires a reason/);

        const notInvalid = await request(app).post(`/api/admin/pending-moves/${itemId}/override`).send({ reason: 'why' });
        expect(notInvalid.status).toBe(400);
        expect(notInvalid.body.message).toMatch(/not deemed invalid/);

        const missing = await request(app).post('/api/admin/pending-moves/pm-nope/override').send({ reason: 'why' });
        expect(missing.status).toBe(400);
        expect(db.executeRosterMove).not.toHaveBeenCalled();

        // the ordinary approve path is untouched
        const ok = await request(app).post(`/api/admin/pending-moves/${itemId}/approve`);
        expect(ok.body.data.status).toBe('approved');
        expect(ok.body.data.override).toBeUndefined();
    });
});

describe('unknown-sender recovery', () => {
    test('retries original ID after mapping repair, queues once, preserves approval gate', async () => {
        const { app, backend, db } = buildApp({ backendResponses: [CANNED_RESPONSES.simpleSupplemental] });
        const owners = app.locals.emailMoveParsingService.ownersFile;
        const originalOwners = fs.readFileSync(owners, 'utf8');
        fs.writeFileSync(owners, '{}');
        expect((await ingest(app, EMAILS.simpleSupplemental)).body.reason).toBe('unknown_sender');
        let recovery = await request(app).get('/api/internal/roster-email/retryable').set('X-Internal-Token', INTERNAL_TOKEN);
        expect(recovery.body.emails).toEqual([]); // still unmapped, do not reparse every poll
        fs.writeFileSync(owners, originalOwners);
        recovery = await request(app).get('/api/internal/roster-email/retryable').set('X-Internal-Token', INTERNAL_TOKEN);
        expect(recovery.body.emails).toEqual([{ emailId: EMAILS.simpleSupplemental.gmailMessageId }]);
        expect((await ingest(app, EMAILS.simpleSupplemental)).body.queued).toBe(true);
        expect((await ingest(app, EMAILS.simpleSupplemental)).body.reason).toBe('duplicate');
        expect(backend.calls).toHaveLength(1);
        expect(db.executeRosterMove).not.toHaveBeenCalled();
        expect(db.executeTrade).not.toHaveBeenCalled();
    });

    test('legacy unknown sender metadata is learned once without executing or parsing', async () => {
        const { app, backend } = buildApp();
        await app.locals.pendingMovesService.markEmailProcessed(EMAILS.unknownSender.gmailMessageId, 'unknown_sender');
        const requestRecovery = () => request(app).get('/api/internal/roster-email/retryable').set('X-Internal-Token', INTERNAL_TOKEN);
        expect((await requestRecovery()).body.emails).toHaveLength(1);
        await ingest(app, EMAILS.unknownSender);
        expect((await requestRecovery()).body.emails).toHaveLength(0);
        expect(backend.calls).toHaveLength(0);
    });

    test('retryable listing retains internal-route authentication', async () => {
        const { app } = buildApp();
        expect((await request(app).get('/api/internal/roster-email/retryable')).status).toBe(403);
    });
});


describe('move-specific commissioner ruling association', () => {
    test('link endpoint attaches a source-preserving note to a resolved move without execution', async () => {
        const { app, db } = buildApp();
        const move = { id: 'm1', status: 'rejected', emailId: 'source-move', parse: { summary: 'A rejected request' } };
        const note = { id: 'n1', kind: 'commissioner_invalidation', status: 'notice', rulingQuote: 'Not eligible', source: { kind: 'user_report' } };
        await app.locals.pendingMovesService.saveQueue({ items: [move, note], processedEmails: [] });
        const res = await request(app).post('/api/admin/pending-moves/n1/link-ruling').send({ moveId: 'm1' });
        expect(res.status).toBe(200);
        expect(res.body.data.relatedItemIds).toEqual(['m1']);
        const listing = await request(app).get('/api/admin/pending-moves?status=rejected');
        expect(listing.body.data.items[0].commissionerRulings[0].rulingQuote).toBe('Not eligible');
        expect(listing.body.data.items[0].status).toBe('rejected');
        expect(db.executeRosterMove).not.toHaveBeenCalled();
        expect(db.executeTrade).not.toHaveBeenCalled();
        expect((await request(app).post('/api/admin/pending-moves/n1/link-ruling').send({})).status).toBe(400);
    });
});
