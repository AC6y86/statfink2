/**
 * Tests for PendingMovesService - the email-move approval queue.
 * Tmp queue files + mocked db; never touches the real database.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const PendingMovesService = require('../../server/services/pendingMovesService');

function tmpQueueFile() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pending-moves-')), 'queue.json');
}

/**
 * validateRosterMove stub. `answers` lets a test change the verdict between
 * calls (intake vs recheck); `nflEligibility` is the structured NFL.com
 * evidence the real validator puts on context for ordinary IR moves.
 */
function mockDb({ dryRunValid = true, executeThrows = null, answers = null, nflEligibility = null, executeResult = null } = {}) {
    let call = 0;
    return {
        validateRosterMove: jest.fn(async () => {
            const answer = answers ? answers[Math.min(call++, answers.length - 1)] : null;
            const valid = answer ? answer.valid : dryRunValid;
            return {
                valid,
                errors: answer ? (answer.errors || []) : (valid ? [] : ['Player to add is not available']),
                context: { nflEligibility: (answer && answer.nflEligibility) || nflEligibility }
            };
        }),
        executeRosterMove: jest.fn(async () => {
            if (executeThrows) throw new Error(executeThrows);
            return { success: true, dropped: { name: 'Tank Dell' }, added: { name: 'Joe Flacco' }, ...(executeResult || {}) };
        }),
        executeTrade: jest.fn(async () => ({ success: true }))
    };
}

const EMAIL = {
    gmailMessageId: 'gmail-msg-1',
    threadId: 'thread-1',
    from: 'owner@example.com',
    subject: 'roster move',
    date: '2026-06-12',
    body: "I'll drop Tank Dell and pick up Joe Flacco."
};

const PARSED = {
    status: 'parsed',
    sender_team_id: 5,
    summary: 'Drop Tank Dell, add Joe Flacco (supplemental)',
    questions_for_commissioner: [],
    moves: [{
        move_type: 'supplemental',
        team_id: 5,
        drop_player_id: 'P_DELL', drop_player_name: 'Tank Dell', drop_quote: "I'll drop Tank Dell",
        add_player_id: 'P_FLACCO', add_player_name: 'Joe Flacco', add_quote: 'pick up Joe Flacco',
        partner_team_id: null, partner_player_id: null, partner_player_name: null,
        confidence: 'high', notes: ''
    }]
};

const IR_MOVE = {
    ...PARSED,
    summary: 'Drop Tank Dell to IR, add Joe Flacco',
    moves: [{ ...PARSED.moves[0], move_type: 'ir' }]
};

const NFL_OUT = {
    eligible: true, code: 'OUT_ON_INJURY_REPORT', source: 'nfl.com',
    reason: 'NFL.com Week 18 injury report lists Tank Dell (HOU) with Game Status "Out"',
    observedStatus: 'Game Status: Out', checkedAt: '2026-09-25T12:00:00.000Z',
    sources: ['https://www.nfl.com/injuries/league/2025/reg18']
};
const NFL_NOT_OUT = {
    eligible: false, code: 'NFL_INELIGIBLE', source: 'nfl.com',
    reason: 'IR move not allowed: NFL.com does not list Tank Dell (HOU) as Out or on Reserve/Injured',
    error: 'IR move not allowed: NFL.com does not list Tank Dell (HOU) as Out or on Reserve/Injured',
    observedStatus: 'injury report: not listed; Houston Texans roster: Status "ACT"',
    checkedAt: '2026-09-25T12:00:00.000Z',
    sources: ['https://www.nfl.com/injuries/league/2025/reg18', 'https://www.nfl.com/teams/houston-texans/roster']
};

describe('PendingMovesService', () => {
    test('enqueues a cleanly parsed move as pending with dry-run result', async () => {
        const service = new PendingMovesService(mockDb(), { queueFile: tmpQueueFile() });
        const items = await service.enqueueParsedEmail(EMAIL, PARSED);

        expect(items.length).toBe(1);
        expect(items[0].status).toBe('pending');
        expect(items[0].validation.valid).toBe(true);
        expect(items[0].move.drop_quote).toBe("I'll drop Tank Dell");
        expect(items[0].emailId).toBe('gmail-msg-1');
    });

    test('failed dry-run demotes to needs_review', async () => {
        const service = new PendingMovesService(mockDb({ dryRunValid: false }), { queueFile: tmpQueueFile() });
        const items = await service.enqueueParsedEmail(EMAIL, PARSED);

        expect(items[0].status).toBe('needs_review');
        expect(items[0].validation.errors).toContain('Player to add is not available');
    });

    test('low confidence and ambiguous status demote to needs_review', async () => {
        const service = new PendingMovesService(mockDb(), { queueFile: tmpQueueFile() });

        const lowConf = await service.enqueueParsedEmail(
            { ...EMAIL, gmailMessageId: 'g2' },
            { ...PARSED, moves: [{ ...PARSED.moves[0], confidence: 'low' }] }
        );
        expect(lowConf[0].status).toBe('needs_review');

        const ambiguous = await service.enqueueParsedEmail(
            { ...EMAIL, gmailMessageId: 'g3' },
            { ...PARSED, status: 'ambiguous', questions_for_commissioner: ['Which Brown?'] }
        );
        expect(ambiguous[0].status).toBe('needs_review');
    });

    test('ambiguous email with no extractable moves still surfaces one item', async () => {
        const service = new PendingMovesService(mockDb(), { queueFile: tmpQueueFile() });
        const items = await service.enqueueParsedEmail(EMAIL, {
            status: 'ambiguous', sender_team_id: 5, summary: 'Unclear request',
            questions_for_commissioner: ['Did he mean to drop or trade?'], moves: []
        });

        expect(items.length).toBe(1);
        expect(items[0].status).toBe('needs_review');
        expect(items[0].move).toBeNull();
    });

    test('two-move email yields two individually approvable items', async () => {
        const service = new PendingMovesService(mockDb(), { queueFile: tmpQueueFile() });
        const items = await service.enqueueParsedEmail(EMAIL, {
            ...PARSED,
            moves: [PARSED.moves[0], { ...PARSED.moves[0], drop_player_id: 'P_MONT', add_player_id: 'P_CART' }]
        });

        expect(items.length).toBe(2);
        expect(items[0].emailId).toBe(items[1].emailId);
        expect(items[0].id).not.toBe(items[1].id);
    });

    test('dedup: hasProcessedEmail true for queued and for marked non-moves', async () => {
        const service = new PendingMovesService(mockDb(), { queueFile: tmpQueueFile() });

        expect(await service.hasProcessedEmail('gmail-msg-1')).toBe(false);
        await service.enqueueParsedEmail(EMAIL, PARSED);
        expect(await service.hasProcessedEmail('gmail-msg-1')).toBe(true);

        await service.markEmailProcessed('banter-msg', 'not_a_roster_move');
        expect(await service.hasProcessedEmail('banter-msg')).toBe(true);
        expect(await service.hasProcessedEmail('never-seen')).toBe(false);
    });

    test('approve executes the move and marks approved', async () => {
        const db = mockDb();
        const service = new PendingMovesService(db, { queueFile: tmpQueueFile() });
        const [item] = await service.enqueueParsedEmail(EMAIL, PARSED);

        const approved = await service.approveItem(item.id, 'joe');

        expect(db.executeRosterMove).toHaveBeenCalledWith(5, 'P_DELL', 'P_FLACCO', 'supplemental', { asOf: '2026-06-12T00:00:00.000Z' }); // judged at the email's Date, not approval time
        expect(approved.status).toBe('approved');
        expect(approved.resolvedBy).toBe('joe');
        expect(approved.executionResult.success).toBe(true);
    });

    test('approve re-validates at the asOf the enqueue dry-run stored, never at approval time', async () => {
        const db = mockDb();
        const service = new PendingMovesService(db, { queueFile: tmpQueueFile() });
        const askedEmail = { ...EMAIL, date: 'Sat, 10 Oct 2026 18:25:17 +0000' }; // pm-1791656805523-1
        const [item] = await service.enqueueParsedEmail(askedEmail, IR_MOVE);
        expect(item.validation.asOf).toBe('2026-10-10T18:25:17.000Z');
        expect(db.validateRosterMove).toHaveBeenCalledWith(5, 'P_DELL', 'P_FLACCO', 'ir', { asOf: '2026-10-10T18:25:17.000Z' });

        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-16T15:00:00Z'));
        try { await service.approveItem(item.id, 'joe'); } finally { nowSpy.mockRestore(); }

        expect(db.executeRosterMove).toHaveBeenCalledWith(5, 'P_DELL', 'P_FLACCO', 'ir', { asOf: '2026-10-10T18:25:17.000Z' });
    });

    test('approve with a move-type override executes and records the original type', async () => {
        const db = mockDb();
        const service = new PendingMovesService(db, { queueFile: tmpQueueFile() });
        const [item] = await service.enqueueParsedEmail(EMAIL, PARSED); // parsed as supplemental

        const approved = await service.approveItem(item.id, 'joe', { moveTypeOverride: 'ir' });

        expect(db.executeRosterMove).toHaveBeenCalledWith(5, 'P_DELL', 'P_FLACCO', 'ir', { asOf: expect.any(String) });
        expect(approved.status).toBe('approved');
        expect(approved.move.move_type).toBe('ir');
        expect(approved.move.original_move_type).toBe('supplemental');
    });

    test('move-type override rejects trades and unknown types', async () => {
        const service = new PendingMovesService(mockDb(), { queueFile: tmpQueueFile() });

        const [move] = await service.enqueueParsedEmail(EMAIL, PARSED);
        await expect(service.approveItem(move.id, 'joe', { moveTypeOverride: 'trade' }))
            .rejects.toThrow('Cannot override');

        const [trade] = await service.enqueueParsedEmail(
            { ...EMAIL, gmailMessageId: 'g-trade' },
            { ...PARSED, moves: [{ ...PARSED.moves[0], move_type: 'trade', partner_team_id: 7, partner_player_id: 'P_X' }] }
        );
        await expect(service.approveItem(trade.id, 'joe', { moveTypeOverride: 'ir' }))
            .rejects.toThrow('Cannot override');
    });

    test('approve marks failed when execution throws (e.g. approve-time re-validation)', async () => {
        const service = new PendingMovesService(
            mockDb({ executeThrows: 'Player to add is not available' }),
            { queueFile: tmpQueueFile() }
        );
        const [item] = await service.enqueueParsedEmail(EMAIL, PARSED);

        const result = await service.approveItem(item.id);

        expect(result.status).toBe('failed');
        expect(result.executionResult.message).toContain('not available');
    });

    test('reject marks rejected; resolved items cannot be re-resolved', async () => {
        const service = new PendingMovesService(mockDb(), { queueFile: tmpQueueFile() });
        const [item] = await service.enqueueParsedEmail(EMAIL, PARSED);

        const rejected = await service.rejectItem(item.id, 'owner retracted');
        expect(rejected.status).toBe('rejected');

        await expect(service.approveItem(item.id)).rejects.toThrow('already rejected');
        await expect(service.rejectItem(item.id)).rejects.toThrow('already rejected');
    });

    test('trade approval routes to executeTrade', async () => {
        const db = mockDb();
        const service = new PendingMovesService(db, { queueFile: tmpQueueFile() });
        const [item] = await service.enqueueParsedEmail(EMAIL, {
            ...PARSED,
            moves: [{
                ...PARSED.moves[0],
                move_type: 'trade',
                partner_team_id: 7, partner_player_id: 'P_PARTNER', partner_player_name: 'Partner Guy'
            }]
        });

        await service.approveItem(item.id);
        expect(db.executeTrade).toHaveBeenCalledWith(5, 'P_DELL', 7, 'P_PARTNER', { asOf: expect.any(String) });
    });

    test('getItems filters by status, newest first; getPendingCount counts open items', async () => {
        const service = new PendingMovesService(mockDb(), { queueFile: tmpQueueFile() });
        const [a] = await service.enqueueParsedEmail({ ...EMAIL, gmailMessageId: 'g1' }, PARSED);
        await service.enqueueParsedEmail({ ...EMAIL, gmailMessageId: 'g2' }, PARSED);
        await service.rejectItem(a.id);

        expect((await service.getItems({ status: 'pending' })).length).toBe(1);
        expect((await service.getItems()).length).toBe(2);
        expect(await service.getPendingCount()).toBe(1);
    });
});

describe('PendingMovesService - NFL.com evidence and recheck', () => {
    test('intake keeps the IR evidence on the item and routes an ineligible move to needs_review', async () => {
        const db = mockDb({ answers: [{ valid: false, errors: [NFL_NOT_OUT.error], nflEligibility: NFL_NOT_OUT }] });
        const service = new PendingMovesService(db, { queueFile: tmpQueueFile() });

        const [item] = await service.enqueueParsedEmail(EMAIL, IR_MOVE);

        expect(db.validateRosterMove).toHaveBeenCalledWith(5, 'P_DELL', 'P_FLACCO', 'ir', { asOf: expect.any(String) });
        expect(item.status).toBe('needs_review');
        expect(item.validation.nflEligibility).toEqual(NFL_NOT_OUT);
        expect(item.validation.errors[0]).toMatch(/^IR move not allowed/);
    });

    test('an eligible IR move is enqueued as pending with its evidence', async () => {
        const db = mockDb({ answers: [{ valid: true, nflEligibility: NFL_OUT }] });
        const service = new PendingMovesService(db, { queueFile: tmpQueueFile() });

        const [item] = await service.enqueueParsedEmail(EMAIL, IR_MOVE);

        expect(item.status).toBe('pending');
        expect(item.validation.nflEligibility).toMatchObject({ eligible: true, code: 'OUT_ON_INJURY_REPORT' });
    });

    test('recheck promotes needs_review -> pending once NFL.com shows the player out', async () => {
        const db = mockDb({ answers: [
            { valid: false, errors: [NFL_NOT_OUT.error], nflEligibility: NFL_NOT_OUT },
            { valid: true, nflEligibility: NFL_OUT }
        ] });
        const service = new PendingMovesService(db, { queueFile: tmpQueueFile() });
        const [item] = await service.enqueueParsedEmail(EMAIL, IR_MOVE);
        expect(item.status).toBe('needs_review');

        const rechecked = await service.revalidateItem(item.id, 'joe');

        expect(db.validateRosterMove).toHaveBeenCalledTimes(2);
        expect(db.executeRosterMove).not.toHaveBeenCalled();
        expect(rechecked.status).toBe('pending');
        expect(rechecked.validation.nflEligibility).toMatchObject({ eligible: true });
        expect(rechecked.validation.recheckedBy).toBe('joe');
        expect(rechecked.validation.recheckCount).toBe(1);
        expect(rechecked.lastRecheckAt).toBe(rechecked.validation.checkedAt);
        // persisted, not just returned
        expect((await service.getItem(item.id)).status).toBe('pending');
    });

    test('recheck demotes pending -> needs_review when NFL.com no longer supports the move', async () => {
        const db = mockDb({ answers: [
            { valid: true, nflEligibility: NFL_OUT },
            { valid: false, errors: [NFL_NOT_OUT.error], nflEligibility: NFL_NOT_OUT }
        ] });
        const service = new PendingMovesService(db, { queueFile: tmpQueueFile() });
        const [item] = await service.enqueueParsedEmail(EMAIL, IR_MOVE);

        const rechecked = await service.revalidateItem(item.id);

        expect(rechecked.status).toBe('needs_review');
        expect(rechecked.validation.valid).toBe(false);
        expect(rechecked.validation.nflEligibility.code).toBe('NFL_INELIGIBLE');
    });

    test('recheck never promotes a low-confidence or ambiguous item even when validation passes', async () => {
        const service = new PendingMovesService(mockDb(), { queueFile: tmpQueueFile() });
        const [lowConf] = await service.enqueueParsedEmail(EMAIL, { ...IR_MOVE, moves: [{ ...IR_MOVE.moves[0], confidence: 'low' }] });
        const [ambiguous] = await service.enqueueParsedEmail(
            { ...EMAIL, gmailMessageId: 'g-amb' },
            { ...IR_MOVE, status: 'ambiguous', questions_for_commissioner: ['Which Dell?'] }
        );

        expect((await service.revalidateItem(lowConf.id)).status).toBe('needs_review');
        expect((await service.revalidateItem(ambiguous.id)).status).toBe('needs_review');
    });

    test('a medium-confidence clean parse is promotable', async () => {
        const db = mockDb({ answers: [
            { valid: false, errors: ['Player to add is not available'] },
            { valid: true, nflEligibility: NFL_OUT }
        ] });
        const service = new PendingMovesService(db, { queueFile: tmpQueueFile() });
        const [item] = await service.enqueueParsedEmail(EMAIL, { ...IR_MOVE, moves: [{ ...IR_MOVE.moves[0], confidence: 'medium' }] });

        expect((await service.revalidateItem(item.id)).status).toBe('pending');
    });

    test('recheck refuses resolved items, trades and unextractable emails', async () => {
        const service = new PendingMovesService(mockDb(), { queueFile: tmpQueueFile() });

        const [resolved] = await service.enqueueParsedEmail(EMAIL, PARSED);
        await service.rejectItem(resolved.id);
        await expect(service.revalidateItem(resolved.id)).rejects.toThrow('already rejected');

        const [trade] = await service.enqueueParsedEmail(
            { ...EMAIL, gmailMessageId: 'g-trade-2' },
            { ...PARSED, moves: [{ ...PARSED.moves[0], move_type: 'trade', partner_team_id: 7, partner_player_id: 'P_X' }] }
        );
        await expect(service.revalidateItem(trade.id)).rejects.toThrow('trades are validated at approval');

        const [ambiguous] = await service.enqueueParsedEmail({ ...EMAIL, gmailMessageId: 'g-none' }, {
            status: 'ambiguous', sender_team_id: 5, summary: 'Unclear', questions_for_commissioner: ['?'], moves: []
        });
        await expect(service.revalidateItem(ambiguous.id)).rejects.toThrow('no executable move');

        await expect(service.revalidateItem('pm-does-not-exist')).rejects.toThrow('not found');
    });

    test('approval re-checks NFL.com through executeRosterMove and keeps the fresh evidence', async () => {
        const db = mockDb({ answers: [{ valid: true, nflEligibility: NFL_OUT }], executeResult: { nflEligibility: NFL_OUT } });
        const service = new PendingMovesService(db, { queueFile: tmpQueueFile() });
        const [item] = await service.enqueueParsedEmail(EMAIL, IR_MOVE);

        const approved = await service.approveItem(item.id, 'joe');

        expect(db.executeRosterMove).toHaveBeenCalledWith(5, 'P_DELL', 'P_FLACCO', 'ir', { asOf: expect.any(String), enqueueEvidence: item.enqueueEvidence });
        expect(approved.executionResult.nflEligibility).toMatchObject({ eligible: true, code: 'OUT_ON_INJURY_REPORT' });
        expect(approved.executionResult.evidenceBasis).toBeUndefined(); // fresh fetch decided it
    });

    test('an approval blocked by NFL.com fails with the evidence attached and is not executed again', async () => {
        const db = mockDb({ answers: [{ valid: true, nflEligibility: NFL_OUT }] });
        db.executeRosterMove = jest.fn(async () => {
            const error = new Error(NFL_NOT_OUT.error);
            error.nflEligibility = NFL_NOT_OUT;
            throw error;
        });
        const service = new PendingMovesService(db, { queueFile: tmpQueueFile() });
        const [item] = await service.enqueueParsedEmail(EMAIL, IR_MOVE);

        const failed = await service.approveItem(item.id, 'joe');

        expect(failed.status).toBe('failed');
        expect(failed.executionResult.nflEligibility).toEqual(NFL_NOT_OUT);
        // A retry is an explicit act and goes through the validator again: still refused, still failed, both attempts on record
        const retried = await service.approveItem(item.id, 'joe');
        expect(retried.status).toBe('failed');
        expect(db.executeRosterMove).toHaveBeenCalledTimes(2);
        expect(retried.executionAttempts.map(a => a.mode)).toEqual(['approve', 'retry']);
    });
});

describe('PendingMovesService - failed executions stay open (retry / recheck / dismiss)', () => {
    async function failedItem(dbOpts = { executeThrows: "Player is already on Matt's Team (owned by Matt)" }) {
        const db = mockDb(dbOpts);
        const service = new PendingMovesService(db, { queueFile: tmpQueueFile() });
        const [item] = await service.enqueueParsedEmail(EMAIL, PARSED);
        const failed = await service.approveItem(item.id, 'joe');
        return { db, service, failed };
    }

    test('a failed approval is not resolved: it keeps its error, is listed and counted as waiting', async () => {
        const { service, failed } = await failedItem();

        expect(failed.status).toBe('failed');
        expect(failed.executionResult).toMatchObject({ success: false, message: "Player is already on Matt's Team (owned by Matt)", mode: 'approve', by: 'joe' });
        expect(failed.resolvedAt).toBeNull();
        expect(failed.lastAttemptAt).toEqual(expect.any(String));
        expect(failed.executionAttempts).toHaveLength(1);
        expect((await service.getItems()).map(i => i.status)).toEqual(['failed']);
        expect(await service.getPendingCount()).toBe(1);
    });

    test('retrying a failed item executes again; success resolves it and the history keeps both attempts', async () => {
        const { db, service, failed } = await failedItem();
        db.executeRosterMove = jest.fn(async () => ({ success: true, dropped: { name: 'Tank Dell' }, added: { name: 'Joe Flacco' } }));

        const approved = await service.approveItem(failed.id, 'joe');

        expect(approved.status).toBe('approved');
        expect(approved.executionResult.success).toBe(true);
        expect(approved.resolvedAt).toEqual(expect.any(String));
        expect(approved.executionAttempts.map(a => [a.mode, a.success])).toEqual([['approve', false], ['retry', true]]);
        expect(await service.getPendingCount()).toBe(0);
        await expect(service.approveItem(failed.id)).rejects.toThrow('already approved');
    });

    test('a failed item can be rechecked (re-routed on the fresh verdict) and rejected (dismissed, failure kept)', async () => {
        const { service, failed } = await failedItem();

        const rechecked = await service.revalidateItem(failed.id, 'joe');
        expect(rechecked.status).toBe('pending');
        expect(rechecked.executionResult.success).toBe(false); // the failure stays for reference

        const { service: other, failed: f2 } = await failedItem();
        const dismissed = await other.rejectItem(f2.id, 'owner withdrew');
        expect(dismissed.status).toBe('rejected');
        expect(dismissed.executionResult).toEqual({ success: false, message: 'owner withdrew', lastFailure: "Player is already on Matt's Team (owned by Matt)" });
        expect(await other.getPendingCount()).toBe(0);
    });

    test('a legacy failed item (resolvedAt set by the old code) is still open and retryable', async () => {
        const db = mockDb();
        const service = new PendingMovesService(db, { queueFile: tmpQueueFile() });
        const [item] = await service.enqueueParsedEmail(EMAIL, PARSED);
        const queue = await service.loadQueue();
        Object.assign(queue.items[0], { status: 'failed', executionResult: { success: false, message: 'old error' }, resolvedAt: '2026-10-18T14:48:49.845Z', resolvedBy: 'commissioner' });
        await service.saveQueue(queue);

        expect(await service.getPendingCount()).toBe(1);
        const approved = await service.approveItem(item.id, 'joe');
        expect(approved.status).toBe('approved');
        expect(approved.executionAttempts).toEqual([expect.objectContaining({ mode: 'retry', success: true })]);
    });
});

describe('PendingMovesService - commissioner override', () => {
    const REFUSED = ['Player to add is not available'];
    function overridableDb() {
        // Dry-run refuses; executeRosterMove honours overrideValidation like the real one
        const db = mockDb({ dryRunValid: false });
        db.executeRosterMove = jest.fn(async (teamId, drop, add, type, options) => {
            if (!options.overrideValidation) throw new Error(REFUSED[0]);
            return { success: true, dropped: { name: 'Tank Dell' }, added: { name: 'Joe Flacco' }, overriddenErrors: REFUSED };
        });
        return db;
    }

    test('overrides one invalid (needs_review) move: executes with the flag, records reason, who, when and what was overrode', async () => {
        const db = overridableDb();
        const service = new PendingMovesService(db, { queueFile: tmpQueueFile() });
        const [item] = await service.enqueueParsedEmail(EMAIL, PARSED);
        expect(item.status).toBe('needs_review');

        const done = await service.overrideItem(item.id, 'joe', { reason: 'Commissioner ruling: McKee was released before the email' });

        expect(db.executeRosterMove).toHaveBeenCalledWith(5, 'P_DELL', 'P_FLACCO', 'supplemental', {
            asOf: expect.any(String), overrideValidation: true, overrideReason: 'Commissioner ruling: McKee was released before the email'
        });
        expect(done.status).toBe('approved');
        expect(done.resolvedBy).toBe('joe');
        expect(done.override).toEqual({ reason: 'Commissioner ruling: McKee was released before the email', by: 'joe', at: expect.any(String), overriddenErrors: REFUSED });
        expect(done.executionResult).toMatchObject({ success: true, override: true, overriddenErrors: REFUSED });
        expect(done.executionAttempts).toEqual([expect.objectContaining({ mode: 'override', success: true, overrideReason: 'Commissioner ruling: McKee was released before the email', overriddenErrors: REFUSED })]);
    });

    test('overrides a move that failed at execution, and a failed override stays failed with the error', async () => {
        const db = overridableDb();
        const service = new PendingMovesService(db, { queueFile: tmpQueueFile() });
        const [item] = await service.enqueueParsedEmail(EMAIL, PARSED);
        const failed = await service.approveItem(item.id, 'joe');
        expect(failed.status).toBe('failed');

        db.executeRosterMove.mockImplementationOnce(async () => { throw new Error('Roster move resulted in invalid active roster size: 20 (expected 19)'); });
        const stillFailed = await service.overrideItem(item.id, 'joe', { reason: 'ruling' });
        expect(stillFailed.status).toBe('failed');
        expect(stillFailed.executionResult).toMatchObject({ success: false, override: true, mode: 'override', message: expect.stringContaining('roster size: 20') });
        expect(stillFailed.override).toBeUndefined();

        const done = await service.overrideItem(item.id, 'joe', { reason: 'ruling' });
        expect(done.status).toBe('approved');
        expect(done.executionAttempts.map(a => a.mode)).toEqual(['approve', 'override', 'override']);
    });

    test('override is explicit and narrow: needs a reason, only for invalid moves, only for the selected item, never twice', async () => {
        const db = overridableDb();
        const service = new PendingMovesService(db, { queueFile: tmpQueueFile() });
        const [invalid] = await service.enqueueParsedEmail(EMAIL, PARSED);
        db.validateRosterMove.mockResolvedValueOnce({ valid: true, errors: [], context: {} });
        const [valid] = await service.enqueueParsedEmail({ ...EMAIL, gmailMessageId: 'g-valid' }, PARSED);
        expect(valid.status).toBe('pending');

        await expect(service.overrideItem(invalid.id, 'joe', {})).rejects.toThrow('requires a reason');
        await expect(service.overrideItem(invalid.id, 'joe', { reason: '   ' })).rejects.toThrow('requires a reason');
        await expect(service.overrideItem(valid.id, 'joe', { reason: 'why' })).rejects.toThrow('not deemed invalid');
        expect(db.executeRosterMove).not.toHaveBeenCalled();

        await service.overrideItem(invalid.id, 'joe', { reason: 'why' });
        expect(db.executeRosterMove).toHaveBeenCalledTimes(1);
        const untouched = (await service.getItems()).find(i => i.id === valid.id);
        expect(untouched.status).toBe('pending');
        expect(untouched).not.toHaveProperty('override');
        expect(untouched).not.toHaveProperty('executionAttempts');
        await expect(service.overrideItem(invalid.id, 'joe', { reason: 'again' })).rejects.toThrow('already approved');
    });

    test('override of a trade passes the flag to executeTrade; a move-type correction is applied first', async () => {
        const db = overridableDb();
        db.executeTrade = jest.fn(async () => ({ success: true, overriddenErrors: ['Cannot drop X: KC already played this week'] }));
        const service = new PendingMovesService(db, { queueFile: tmpQueueFile() });
        const [trade] = await service.enqueueParsedEmail({ ...EMAIL, gmailMessageId: 'g-trade' }, {
            ...PARSED, moves: [{ ...PARSED.moves[0], move_type: 'trade', partner_team_id: 7, partner_player_id: 'P_P', partner_player_name: 'Partner' }]
        });
        const failedTrade = await service.approveItem(trade.id, 'joe'); // mock executeTrade succeeds -> approved; force failed state instead
        expect(failedTrade.status).toBe('approved');
        const queue = await service.loadQueue();
        Object.assign(queue.items.find(i => i.id === trade.id), { status: 'failed', executionResult: { success: false, message: 'Cannot drop X' } });
        await service.saveQueue(queue);

        const done = await service.overrideItem(trade.id, 'joe', { reason: 'both owners agreed' });
        expect(db.executeTrade).toHaveBeenLastCalledWith(5, 'P_DELL', 7, 'P_P', { asOf: expect.any(String), overrideValidation: true, overrideReason: 'both owners agreed' });
        expect(done.override.overriddenErrors).toEqual(['Cannot drop X: KC already played this week']);

        const [sup] = await service.enqueueParsedEmail({ ...EMAIL, gmailMessageId: 'g-sup' }, PARSED);
        const asIr = await service.overrideItem(sup.id, 'joe', { reason: 'it is an IR move', moveTypeOverride: 'ir' });
        expect(asIr.move.move_type).toBe('ir');
        expect(asIr.move.original_move_type).toBe('supplemental');
        expect(db.executeRosterMove).toHaveBeenLastCalledWith(5, 'P_DELL', 'P_FLACCO', 'ir', expect.objectContaining({ overrideValidation: true }));
    });
});

describe('recovering skipped emails and ordered compound requests', () => {
    test('unknown sender may retry, but queued/rejected legacy replays remain deduplicated', async () => {
        const service = new PendingMovesService(mockDb(), { queueFile: tmpQueueFile() });
        const original = '1a0ca4547f71236b';
        await service.markEmailProcessed(original, 'unknown_sender', { from: 'dan@example.com' });
        expect(await service.hasProcessedEmail(original)).toBe(true);
        expect(await service.hasProcessedEmail(original, { retryUnknownSender: true })).toBe(false);
        const [item] = await service.enqueueParsedEmail({ ...EMAIL, gmailMessageId: 'retry-20260924-' + original }, PARSED);
        await service.rejectItem(item.id);
        expect(await service.hasProcessedEmail(original, { retryUnknownSender: true })).toBe(true);
        expect(await service.getRetryableUnknownEmails()).toEqual([]);
    });

    test('recovered non-move leaves the retry list permanently', async () => {
        const service = new PendingMovesService(mockDb(), { queueFile: tmpQueueFile() });
        await service.markEmailProcessed('m1', 'unknown_sender');
        await service.markEmailProcessed('m1', 'not_a_roster_move', { from: 'dan@example.com' });
        expect(await service.getRetryableUnknownEmails()).toEqual([]);
        expect(await service.hasProcessedEmail('m1', { retryUnknownSender: true })).toBe(true);
    });

    test('trade then IR remains two items; second cannot run before approved trade', async () => {
        const db = mockDb();
        const service = new PendingMovesService(db, { queueFile: tmpQueueFile() });
        const trade = { ...PARSED.moves[0], move_type: 'trade', team_id: 3,
            drop_player_id: 'ROBINSON', drop_player_name: "Wan'Dale Robinson",
            add_player_id: 'STRIBLING', add_player_name: "De'Zhaun Stribling",
            partner_team_id: 2, partner_player_id: 'STRIBLING', partner_player_name: "De'Zhaun Stribling" };
        const ir = { ...PARSED.moves[0], move_type: 'ir', team_id: 3,
            drop_player_id: 'STRIBLING', drop_player_name: "De'Zhaun Stribling",
            add_player_id: 'PENIX', add_player_name: 'Michael Penix Jr.' };
        const items = await service.enqueueParsedEmail(EMAIL, { ...PARSED, moves: [trade, ir] });
        expect(items).toHaveLength(2);
        expect(items[0].status).toBe('pending');
        expect(items[1].status).toBe('needs_review');
        expect(items[1].dependsOnItemId).toBe(items[0].id);
        await expect(service.approveItem(items[1].id)).rejects.toThrow('preceding trade');
        expect(db.executeTrade).not.toHaveBeenCalled();
        expect(db.executeRosterMove).not.toHaveBeenCalled();
        expect((await service.revalidateItem(items[1].id)).status).toBe('needs_review');
        await service.approveItem(items[0].id);
        expect((await service.revalidateItem(items[1].id)).status).toBe('pending');
        await service.approveItem(items[1].id);
        expect(db.executeTrade).toHaveBeenCalledTimes(1);
        expect(db.executeRosterMove).toHaveBeenCalledWith(3, 'STRIBLING', 'PENIX', 'ir', expect.any(Object));
    });
});


describe('commissioner invalidation notes', () => {
    const email = { ...EMAIL, gmailMessageId: 'ruling-1', from: 'Dan Ochse <wdochse@gmail.com>', body: 'That move is invalid; Robinson is already owned.' };
    const parse = { status: 'move_invalidation', summary: 'Robinson move invalid', invalidation_quote: email.body, moves: [] };
    test('visible and deduplicated, with no roster writes or approval action', async () => {
        const db = mockDb();
        const svc = new PendingMovesService(db, { queueFile: tmpQueueFile() });
        const [item] = await svc.enqueueParsedEmail(email, parse);
        expect(item.kind).toBe('commissioner_invalidation');
        expect(item.status).toBe('notice');
        expect(await svc.getPendingCount()).toBe(0);
        expect(await svc.hasProcessedEmail(email.gmailMessageId)).toBe(true);
        await svc.enqueueParsedEmail(email, parse);
        expect((await svc.getItems()).length).toBe(1);
        await expect(svc.approveItem(item.id)).rejects.toThrow('already notice');
        expect(db.validateRosterMove).not.toHaveBeenCalled();
        expect(db.executeRosterMove).not.toHaveBeenCalled();
    });
    test('does not change an existing proposal or approved roster history', async () => {
        const svc = new PendingMovesService(mockDb(), { queueFile: tmpQueueFile() });
        const [proposal] = await svc.enqueueParsedEmail(EMAIL, PARSED);
        await svc.enqueueParsedEmail(email, parse);
        expect(await svc.getItem(proposal.id)).toEqual(proposal);
    });
    test('rejects wrong sender and missing source quote', async () => {
        const svc = new PendingMovesService(mockDb(), { queueFile: tmpQueueFile() });
        await expect(svc.enqueueParsedEmail({ ...email, from: 'joe.paley@gmail.com' }, parse)).rejects.toThrow('Invalid commissioner note');
        await expect(svc.enqueueParsedEmail(email, { ...parse, invalidation_quote: 'invented' })).rejects.toThrow('Invalid commissioner note');
    });
});

/**
 * Enqueue-time evidence (pm-1791656805523-1, second failure 2026-10-16): the
 * intake dry-run on Sat 2026-10-10 saw Adonai Mitchell Out on the Week 5
 * report; by approval NFL.com served the Week 6 page at the Week 5 URL
 * (NFL_UNAVAILABLE). The intake verdict is preserved separately from
 * validation so rechecks cannot overwrite it, and approval hands it to the
 * validator, which alone decides whether it may stand in.
 */
describe('PendingMovesService - immutable enqueue-time NFL.com evidence', () => {
    const ASKED_EMAIL = { ...EMAIL, date: 'Sat, 10 Oct 2026 18:25:17 +0000' };
    const ASOF = '2026-10-10T18:25:17.000Z';
    const MITCHELL_MOVE = {
        ...IR_MOVE,
        summary: 'Drop Adonai Mitchell to IR, add Joe Flacco',
        moves: [{ ...IR_MOVE.moves[0], drop_player_id: 'P_MITCHELL', drop_player_name: 'Adonai Mitchell', drop_quote: 'put Mitchell on IR' }]
    };
    const WEEK5_OUT = {
        eligible: true, code: 'OUT_ON_INJURY_REPORT', source: 'nfl.com',
        reason: 'NFL.com Week 5 injury report lists Adonai Mitchell (NYJ) with Game Status "Out"',
        observedStatus: 'Game Status: Out', player: { name: 'Adonai Mitchell', team: 'NYJ' }, season: 2026, week: 5,
        checkedAt: '2026-10-10T18:25:21.000Z', sources: ['https://www.nfl.com/injuries/league/2026/reg5']
    };
    const PAGE_GONE = {
        eligible: false, code: 'NFL_UNAVAILABLE', source: 'nfl.com', season: 2026, week: 5,
        reason: 'Validation failed: fresh NFL.com data unavailable (injury report page identity mismatch: expected /injuries/league/2026/reg5, got title "Week 6 Injury Report | NFL.com", selected Week 6)',
        error: 'Validation failed: fresh NFL.com data unavailable (injury report page identity mismatch: expected /injuries/league/2026/reg5, got title "Week 6 Injury Report | NFL.com", selected Week 6)',
        checkedAt: '2026-10-16T15:00:04.000Z', sources: ['https://www.nfl.com/injuries/league/2026/reg5']
    };
    const ACCEPTED = { ...WEEK5_OUT, basis: 'enqueue', legacy: false, enqueueCheckedAt: WEEK5_OUT.checkedAt, freshCheck: PAGE_GONE };

    test('intake stores a passing IR verdict as enqueueEvidence, separate from validation', async () => {
        const db = mockDb({ answers: [{ valid: true, nflEligibility: WEEK5_OUT }] });
        const service = new PendingMovesService(db, { queueFile: tmpQueueFile() });
        const [item] = await service.enqueueParsedEmail(ASKED_EMAIL, MITCHELL_MOVE);

        expect(item.status).toBe('pending');
        expect(item.enqueueEvidence).toEqual({
            asOf: ASOF, checkedAt: item.validation.checkedAt, dropPlayerId: 'P_MITCHELL', teamId: 5, moveType: 'ir', nflEligibility: WEEK5_OUT
        });
        expect(item.enqueueEvidence.nflEligibility).not.toBe(item.validation.nflEligibility); // a copy, not a reference
        expect((await service.getItem(item.id)).enqueueEvidence).toEqual(item.enqueueEvidence); // persisted
    });

    test('no enqueueEvidence for supplemental moves or for an IR intake that did not pass', async () => {
        const service = new PendingMovesService(mockDb({ answers: [{ valid: true, nflEligibility: WEEK5_OUT }] }), { queueFile: tmpQueueFile() });
        const [supplemental] = await service.enqueueParsedEmail(ASKED_EMAIL, PARSED);
        expect(supplemental.enqueueEvidence).toBeNull();

        const failed = new PendingMovesService(mockDb({ answers: [{ valid: false, errors: [NFL_NOT_OUT.error], nflEligibility: NFL_NOT_OUT }] }), { queueFile: tmpQueueFile() });
        const [refused] = await failed.enqueueParsedEmail(ASKED_EMAIL, MITCHELL_MOVE);
        expect(refused.enqueueEvidence).toBeNull();

        const unavailable = new PendingMovesService(mockDb({ answers: [{ valid: false, errors: [PAGE_GONE.error], nflEligibility: PAGE_GONE }] }), { queueFile: tmpQueueFile() });
        const [noData] = await unavailable.enqueueParsedEmail(ASKED_EMAIL, MITCHELL_MOVE);
        expect(noData.enqueueEvidence).toBeNull();
    });

    test('a later recheck overwrites validation but never enqueueEvidence', async () => {
        const db = mockDb({ answers: [
            { valid: true, nflEligibility: WEEK5_OUT },
            { valid: false, errors: [PAGE_GONE.error], nflEligibility: PAGE_GONE }
        ] });
        const service = new PendingMovesService(db, { queueFile: tmpQueueFile() });
        const [item] = await service.enqueueParsedEmail(ASKED_EMAIL, MITCHELL_MOVE);
        const original = JSON.parse(JSON.stringify(item.enqueueEvidence));

        const rechecked = await service.revalidateItem(item.id, 'joe');

        expect(rechecked.status).toBe('needs_review');
        expect(rechecked.validation.nflEligibility).toEqual(PAGE_GONE);
        expect(rechecked.validation.recheckCount).toBe(1);
        expect(rechecked.enqueueEvidence).toEqual(original);
        expect((await service.getItem(item.id)).enqueueEvidence).toEqual(original);
    });

    test('approval hands the enqueue evidence to the validator and records when it decided the move', async () => {
        const db = mockDb({ answers: [{ valid: true, nflEligibility: WEEK5_OUT }], executeResult: { nflEligibility: ACCEPTED } });
        const service = new PendingMovesService(db, { queueFile: tmpQueueFile() });
        const [item] = await service.enqueueParsedEmail(ASKED_EMAIL, MITCHELL_MOVE);

        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-16T15:00:00Z'));
        let approved;
        try { approved = await service.approveItem(item.id, 'joe'); } finally { nowSpy.mockRestore(); }

        expect(db.executeRosterMove).toHaveBeenCalledWith(5, 'P_MITCHELL', 'P_FLACCO', 'ir', { asOf: ASOF, enqueueEvidence: item.enqueueEvidence });
        expect(approved.status).toBe('approved');
        expect(approved.executionResult.evidenceBasis).toBe('enqueue');
        expect(approved.executionResult.nflEligibility).toEqual(ACCEPTED);
    });

    test('the validator, not the queue, has the last word: a refusal at approval still fails the item', async () => {
        const db = mockDb({ answers: [{ valid: true, nflEligibility: WEEK5_OUT }] });
        db.executeRosterMove = jest.fn(async () => {
            const error = new Error(NFL_NOT_OUT.error);
            error.nflEligibility = { ...NFL_NOT_OUT, enqueueEvidenceRejected: 'fresh NFL.com check answered NFL_INELIGIBLE, which is not NFL_UNAVAILABLE' };
            throw error;
        });
        const service = new PendingMovesService(db, { queueFile: tmpQueueFile() });
        const [item] = await service.enqueueParsedEmail(ASKED_EMAIL, MITCHELL_MOVE);

        const failed = await service.approveItem(item.id, 'joe');

        expect(db.executeRosterMove).toHaveBeenCalledWith(5, 'P_MITCHELL', 'P_FLACCO', 'ir', { asOf: ASOF, enqueueEvidence: item.enqueueEvidence });
        expect(failed.status).toBe('failed');
        expect(failed.executionResult.evidenceBasis).toBeUndefined();
        expect(failed.executionResult.nflEligibility.code).toBe('NFL_INELIGIBLE');
        expect(failed.enqueueEvidence).toEqual(item.enqueueEvidence); // still there for the audit trail
    });

    test('a move-type override to ir gets no evidence (there was no IR intake verdict to preserve)', async () => {
        const db = mockDb({ answers: [{ valid: true, nflEligibility: WEEK5_OUT }] });
        const service = new PendingMovesService(db, { queueFile: tmpQueueFile() });
        const [item] = await service.enqueueParsedEmail(ASKED_EMAIL, PARSED); // supplemental at intake

        await service.approveItem(item.id, 'joe', { moveTypeOverride: 'ir' });

        expect(db.executeRosterMove).toHaveBeenCalledWith(5, 'P_DELL', 'P_FLACCO', 'ir', { asOf: ASOF });
    });

    describe('legacy items queued before enqueueEvidence existed', () => {
        /** Write a queue file by hand: the item shape as it was stored before this field. */
        async function legacyQueue(validationPatch = {}, itemPatch = {}) {
            const queueFile = tmpQueueFile();
            const item = {
                id: 'pm-1791656805523-1', emailId: 'gmail-legacy', threadId: 't',
                email: { from: 'owner@example.com', subject: 'IR', date: 'Sat, 10 Oct 2026 18:25:17 +0000', body: 'put Mitchell on IR, add Flacco' },
                parse: { status: 'parsed', summary: 'Mitchell to IR', questions_for_commissioner: [] },
                move: MITCHELL_MOVE.moves[0],
                validation: { valid: true, errors: [], checkedAt: '2026-10-10T18:25:21.000Z', asOf: ASOF, nflEligibility: WEEK5_OUT, ...validationPatch },
                status: 'pending', createdAt: '2026-10-10T18:25:20.000Z', resolvedAt: null, resolvedBy: null, executionResult: null,
                ...itemPatch
            };
            fs.mkdirSync(path.dirname(queueFile), { recursive: true });
            fs.writeFileSync(queueFile, JSON.stringify({ items: [item], processedEmails: [] }, null, 2));
            return { queueFile, item };
        }

        test('an unrechecked legacy item offers its original validation as legacy evidence', async () => {
            const { queueFile, item } = await legacyQueue();
            const db = mockDb({ executeResult: { nflEligibility: { ...ACCEPTED, legacy: true } } });
            const service = new PendingMovesService(db, { queueFile });

            const approved = await service.approveItem(item.id, 'joe');

            expect(db.executeRosterMove).toHaveBeenCalledWith(5, 'P_MITCHELL', 'P_FLACCO', 'ir', {
                asOf: ASOF,
                enqueueEvidence: { asOf: ASOF, checkedAt: '2026-10-10T18:25:21.000Z', dropPlayerId: 'P_MITCHELL', teamId: 5, moveType: 'ir', nflEligibility: WEEK5_OUT, legacy: true }
            });
            expect(approved.executionResult.evidenceBasis).toBe('enqueue_legacy');
        });

        test('a legacy supplemental item overridden to ir at approval offers nothing: no IR intake verdict exists', async () => {
            const { queueFile, item } = await legacyQueue({}, { move: { ...MITCHELL_MOVE.moves[0], move_type: 'supplemental' } });
            const db = mockDb();
            const service = new PendingMovesService(db, { queueFile });

            await service.approveItem(item.id, 'joe', { moveTypeOverride: 'ir' });

            expect(db.executeRosterMove).toHaveBeenCalledWith(5, 'P_MITCHELL', 'P_FLACCO', 'ir', { asOf: ASOF });
        });

        test('a legacy item that was already rechecked has lost its original verdict: no evidence', async () => {
            const { queueFile, item } = await legacyQueue({ recheckCount: 1, recheckedBy: 'commissioner' });
            const db = mockDb();
            const service = new PendingMovesService(db, { queueFile });

            await service.approveItem(item.id, 'joe');

            expect(db.executeRosterMove).toHaveBeenCalledWith(5, 'P_MITCHELL', 'P_FLACCO', 'ir', { asOf: ASOF });
        });

        test('a legacy item whose original validation failed, or lacks asOf, offers nothing', async () => {
            for (const patch of [{ valid: false, errors: [NFL_NOT_OUT.error], nflEligibility: NFL_NOT_OUT }, { asOf: undefined }]) {
                const { queueFile, item } = await legacyQueue(patch);
                const db = mockDb();
                await new PendingMovesService(db, { queueFile }).approveItem(item.id, 'joe');
                expect(db.executeRosterMove).toHaveBeenCalledWith(5, 'P_MITCHELL', 'P_FLACCO', 'ir', { asOf: ASOF });
            }
        });

        test('the first recheck of a legacy item preserves its original verdict before overwriting validation', async () => {
            const { queueFile, item } = await legacyQueue();
            const db = mockDb({ answers: [{ valid: false, errors: [PAGE_GONE.error], nflEligibility: PAGE_GONE }] });
            const service = new PendingMovesService(db, { queueFile });

            const rechecked = await service.revalidateItem(item.id, 'joe');

            expect(rechecked.validation.nflEligibility).toEqual(PAGE_GONE);
            expect(rechecked.enqueueEvidence).toEqual({ asOf: ASOF, checkedAt: '2026-10-10T18:25:21.000Z', dropPlayerId: 'P_MITCHELL', teamId: 5, moveType: 'ir', nflEligibility: WEEK5_OUT, legacy: true });

            // ...and a second recheck cannot replace it with the recheck's verdict
            await service.revalidateItem(item.id, 'joe');
            expect((await service.getItem(item.id)).enqueueEvidence.nflEligibility).toEqual(WEEK5_OUT);
            // approval now offers the preserved copy
            await service.approveItem(item.id, 'joe');
            expect(db.executeRosterMove).toHaveBeenCalledWith(5, 'P_MITCHELL', 'P_FLACCO', 'ir', expect.objectContaining({ enqueueEvidence: expect.objectContaining({ legacy: true, nflEligibility: WEEK5_OUT }) }));
        });

        test('a rechecked new-format item whose intake failed never gains evidence from the recheck', async () => {
            const db = mockDb({ answers: [
                { valid: false, errors: [PAGE_GONE.error], nflEligibility: PAGE_GONE },
                { valid: true, nflEligibility: WEEK5_OUT }
            ] });
            const service = new PendingMovesService(db, { queueFile: tmpQueueFile() });
            const [item] = await service.enqueueParsedEmail(ASKED_EMAIL, MITCHELL_MOVE);
            expect(item.enqueueEvidence).toBeNull();

            const rechecked = await service.revalidateItem(item.id, 'joe');
            expect(rechecked.status).toBe('pending');
            expect(rechecked.enqueueEvidence).toBeNull();

            await service.approveItem(item.id, 'joe');
            expect(db.executeRosterMove).toHaveBeenCalledWith(5, 'P_MITCHELL', 'P_FLACCO', 'ir', { asOf: ASOF });
        });
    });
});
