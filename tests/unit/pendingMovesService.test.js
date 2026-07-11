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

function mockDb({ dryRunValid = true, executeThrows = null } = {}) {
    return {
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

        expect(db.executeRosterMove).toHaveBeenCalledWith(5, 'P_DELL', 'P_FLACCO', 'supplemental');
        expect(approved.status).toBe('approved');
        expect(approved.resolvedBy).toBe('joe');
        expect(approved.executionResult.success).toBe(true);
    });

    test('approve with a move-type override executes and records the original type', async () => {
        const db = mockDb();
        const service = new PendingMovesService(db, { queueFile: tmpQueueFile() });
        const [item] = await service.enqueueParsedEmail(EMAIL, PARSED); // parsed as supplemental

        const approved = await service.approveItem(item.id, 'joe', { moveTypeOverride: 'ir' });

        expect(db.executeRosterMove).toHaveBeenCalledWith(5, 'P_DELL', 'P_FLACCO', 'ir');
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
        expect(db.executeTrade).toHaveBeenCalledWith(5, 'P_DELL', 7, 'P_PARTNER');
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
