const fs = require('fs').promises;
const path = require('path');
const { logInfo, logError } = require('../utils/errorHandler');

/**
 * Pending email-move queue (email-driven roster moves pipeline).
 *
 * Parsed moves from owner emails wait here until the commissioner approves or
 * rejects them on the roster page. Stored as a JSON file (no DB table), one
 * queue item per proposed move; an email proposing two moves yields two
 * individually-approvable items sharing the same emailId.
 *
 * Item statuses:
 *   pending      - parsed cleanly, dry-run stored, awaiting approve/reject
 *   needs_review - ambiguous parse / low confidence / failed dry-run; no
 *                  one-click approve, commissioner handles manually
 *   approved     - executed successfully via executeRosterMove/executeTrade
 *   rejected     - commissioner rejected
 *   failed       - approve was attempted but execution threw
 */
class PendingMovesService {
    constructor(db, { queueFile = null } = {}) {
        this.db = db;
        this.queueFile = queueFile || path.join(__dirname, '../../roster_moves/pending_moves.json');
        this.seq = 0;
    }

    async loadQueue() {
        try {
            const raw = await fs.readFile(this.queueFile, 'utf8');
            const data = JSON.parse(raw);
            return {
                items: Array.isArray(data.items) ? data.items : [],
                processedEmails: Array.isArray(data.processedEmails) ? data.processedEmails : []
            };
        } catch (error) {
            return { items: [], processedEmails: [] };
        }
    }

    async saveQueue(queue) {
        await fs.mkdir(path.dirname(this.queueFile), { recursive: true });
        await fs.writeFile(this.queueFile, JSON.stringify(queue, null, 2));
    }

    /**
     * Has this Gmail message already been handled (queued, or recorded as a
     * non-move)? Used for server-side dedup - the poller may re-send.
     */
    async hasProcessedEmail(gmailMessageId) {
        const queue = await this.loadQueue();
        return queue.processedEmails.some(p => p.emailId === gmailMessageId) ||
            queue.items.some(i => i.emailId === gmailMessageId);
    }

    /**
     * Record an email that produced no queue items (not_a_roster_move,
     * unknown sender) so it is never re-parsed.
     */
    async markEmailProcessed(gmailMessageId, reason) {
        const queue = await this.loadQueue();
        if (!queue.processedEmails.some(p => p.emailId === gmailMessageId)) {
            queue.processedEmails.push({
                emailId: gmailMessageId,
                reason,
                processedAt: new Date().toISOString()
            });
            // Keep the side-list bounded
            queue.processedEmails = queue.processedEmails.slice(-500);
            await this.saveQueue(queue);
        }
    }

    /**
     * Enqueue the moves parsed from one email. parse is the full parser
     * result; each move becomes one item. Runs the validation dry-run for
     * each move (read-only). Returns the created items.
     */
    async enqueueParsedEmail(email, parse) {
        const queue = await this.loadQueue();
        const items = [];

        for (const move of parse.moves || []) {
            let validation = { valid: false, errors: ['Dry-run not executed'], checkedAt: null };
            if (move.move_type !== 'trade' && move.team_id && move.drop_player_id && move.add_player_id) {
                try {
                    const result = await this.db.validateRosterMove(
                        move.team_id, move.drop_player_id, move.add_player_id, move.move_type
                    );
                    validation = {
                        valid: result.valid,
                        errors: result.errors,
                        checkedAt: new Date().toISOString()
                    };
                } catch (error) {
                    validation = { valid: false, errors: [error.message], checkedAt: new Date().toISOString() };
                }
            } else if (move.move_type === 'trade') {
                // Trades have no single dry-run helper; checked at approve time by executeTrade
                validation = { valid: true, errors: [], checkedAt: new Date().toISOString(), note: 'Trade validated at approval' };
            }

            const needsReview =
                parse.status !== 'parsed' ||
                move.confidence === 'low' ||
                !validation.valid;

            items.push({
                id: `pm-${Date.now()}-${++this.seq}`,
                emailId: email.gmailMessageId,
                threadId: email.threadId || null,
                email: {
                    from: email.from,
                    subject: email.subject,
                    date: email.date,
                    body: email.body
                },
                parse: {
                    status: parse.status,
                    summary: parse.summary,
                    questions_for_commissioner: parse.questions_for_commissioner || []
                },
                move,
                validation,
                status: needsReview ? 'needs_review' : 'pending',
                createdAt: new Date().toISOString(),
                resolvedAt: null,
                resolvedBy: null,
                executionResult: null
            });
        }

        // An ambiguous email with no extractable moves still gets one
        // needs_review item so it surfaces to the commissioner
        if (items.length === 0 && parse.status === 'ambiguous') {
            items.push({
                id: `pm-${Date.now()}-${++this.seq}`,
                emailId: email.gmailMessageId,
                threadId: email.threadId || null,
                email: {
                    from: email.from,
                    subject: email.subject,
                    date: email.date,
                    body: email.body
                },
                parse: {
                    status: parse.status,
                    summary: parse.summary,
                    questions_for_commissioner: parse.questions_for_commissioner || []
                },
                move: null,
                validation: { valid: false, errors: ['No move could be extracted'], checkedAt: new Date().toISOString() },
                status: 'needs_review',
                createdAt: new Date().toISOString(),
                resolvedAt: null,
                resolvedBy: null,
                executionResult: null
            });
        }

        queue.items.push(...items);
        await this.saveQueue(queue);

        logInfo(`Enqueued ${items.length} pending move(s) from email ${email.gmailMessageId}`, {
            from: email.from,
            statuses: items.map(i => i.status)
        });

        return items;
    }

    async getItems({ status = null } = {}) {
        const queue = await this.loadQueue();
        const items = status ? queue.items.filter(i => i.status === status) : queue.items;
        return items.slice().reverse(); // newest first
    }

    async getItem(id) {
        const queue = await this.loadQueue();
        return queue.items.find(i => i.id === id) || null;
    }

    /**
     * Approve a pending item: re-run the dry-run (state may have changed
     * since enqueue), then execute the move. Returns the updated item.
     * moveTypeOverride lets the commissioner correct a misclassified type
     * (ir/supplemental/ir_return only - trades cannot be converted).
     */
    async approveItem(id, resolvedBy = 'commissioner', { moveTypeOverride = null } = {}) {
        const queue = await this.loadQueue();
        const item = queue.items.find(i => i.id === id);
        if (!item) throw new Error(`Pending move ${id} not found`);
        if (item.status !== 'pending' && item.status !== 'needs_review') {
            throw new Error(`Pending move ${id} is already ${item.status}`);
        }
        if (!item.move) {
            throw new Error(`Pending move ${id} has no executable move (ambiguous email)`);
        }

        const move = item.move;
        if (moveTypeOverride && moveTypeOverride !== move.move_type) {
            const convertible = ['ir', 'supplemental', 'ir_return'];
            if (!convertible.includes(moveTypeOverride) || !convertible.includes(move.move_type)) {
                throw new Error(`Cannot override move type ${move.move_type} -> ${moveTypeOverride}`);
            }
            move.original_move_type = move.move_type;
            move.move_type = moveTypeOverride;
        }
        try {
            let result;
            if (move.move_type === 'trade') {
                result = await this.db.executeTrade(
                    move.team_id, move.drop_player_id,
                    move.partner_team_id, move.partner_player_id
                );
            } else {
                // Approve-time re-validation: executeRosterMove runs
                // validateRosterMove internally and throws on failure
                result = await this.db.executeRosterMove(
                    move.team_id, move.drop_player_id, move.add_player_id, move.move_type
                );
            }
            item.status = 'approved';
            item.executionResult = { success: true, message: `${result.dropped?.name || ''} -> ${result.added?.name || ''}`.trim() };
        } catch (error) {
            item.status = 'failed';
            item.executionResult = { success: false, message: error.message };
            logError(`Pending move ${id} failed on approval`, error);
        }

        item.resolvedAt = new Date().toISOString();
        item.resolvedBy = resolvedBy;
        await this.saveQueue(queue);
        return item;
    }

    async rejectItem(id, reason = null, resolvedBy = 'commissioner') {
        const queue = await this.loadQueue();
        const item = queue.items.find(i => i.id === id);
        if (!item) throw new Error(`Pending move ${id} not found`);
        if (item.status !== 'pending' && item.status !== 'needs_review') {
            throw new Error(`Pending move ${id} is already ${item.status}`);
        }

        item.status = 'rejected';
        item.executionResult = reason ? { success: false, message: reason } : null;
        item.resolvedAt = new Date().toISOString();
        item.resolvedBy = resolvedBy;
        await this.saveQueue(queue);
        return item;
    }

    async getPendingCount() {
        const queue = await this.loadQueue();
        return queue.items.filter(i => i.status === 'pending' || i.status === 'needs_review').length;
    }
}

module.exports = PendingMovesService;
