const fs = require('fs').promises;
const path = require('path');
const { attachRulings } = require('./moveRulingLinks');
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
 *   failed       - approve was attempted but execution threw. Still OPEN:
 *                  it stays on the list with its error until the
 *                  commissioner retries (approve), rechecks, overrides or
 *                  rejects it. Every attempt is appended to executionAttempts.
 *
 * Commissioner override (overrideItem): executes one specific move the
 * validator refuses. Requires a reason; only offered for a move deemed
 * invalid (failed dry-run or failed execution); recorded on the item
 * (item.override) and in roster_moves.notes.
 */
class PendingMovesService {
    /** Statuses that still wait on the commissioner. */
    static get OPEN_STATUSES() { return ['pending', 'needs_review', 'failed']; }

    static isOpen(item) {
        return Boolean(item) && PendingMovesService.OPEN_STATUSES.includes(item.status);
    }

    /**
     * "Deemed invalid": the latest verdict on the move is a refusal, either
     * the dry-run (validation.valid !== true) or a failed execution. Only
     * such items may be overridden; a move the validator accepts is approved
     * normally.
     */
    static isInvalid(item) {
        if (!item || !item.move) return false;
        if (item.status === 'failed') return true;
        return !(item.validation && item.validation.valid === true);
    }

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
    static canonicalEmailId(id) {
        // Prior manual recoveries used retry-YYYYMMDD-<Gmail ID>. They are
        // the same source email, including when already approved/rejected.
        return String(id).replace(/^retry-\d{8}-(?=[a-f0-9]+$)/, '');
    }

    async hasProcessedEmail(gmailMessageId, { retryUnknownSender = false } = {}) {
        const queue = await this.loadQueue();
        const key = PendingMovesService.canonicalEmailId(gmailMessageId);
        const matches = row => PendingMovesService.canonicalEmailId(row.emailId) === key;
        return queue.items.some(matches) || queue.processedEmails.some(p =>
            matches(p) && !(retryUnknownSender && p.reason === 'unknown_sender'));
    }

    async getRetryableUnknownEmails() {
        const queue = await this.loadQueue();
        const handled = new Set(queue.items.map(i => PendingMovesService.canonicalEmailId(i.emailId)));
        return queue.processedEmails.filter(p => p.reason === 'unknown_sender' &&
            !handled.has(PendingMovesService.canonicalEmailId(p.emailId)));
    }

    /**
     * Record an email that produced no queue items (not_a_roster_move,
     * unknown sender). Only identity skips are eligible for later recovery.
     */
    async markEmailProcessed(gmailMessageId, reason, { from = null } = {}) {
        const queue = await this.loadQueue();
        const existing = queue.processedEmails.find(p => p.emailId === gmailMessageId);
        if (existing && existing.reason === 'unknown_sender') {
            // An owner-map repair may resolve a previously skipped message.
            existing.reason = reason;
            if (from) existing.from = from;
            await this.saveQueue(queue);
        } else if (!existing) {
            queue.processedEmails.push({
                emailId: gmailMessageId,
                reason,
                ...(from ? { from } : {}),
                processedAt: new Date().toISOString()
            });
            // Keep the side-list bounded
            queue.processedEmails = queue.processedEmails.slice(-500);
            await this.saveQueue(queue);
        }
    }

    /**
     * Read-only dry-run of one parsed move through the central validator
     * (db.validateRosterMove). For ordinary IR moves the validator performs
     * a fresh NFL.com eligibility fetch; its structured evidence is kept on
     * the item (validation.nflEligibility) for audit. Never executes.
     */
    /** When the owner asked: the email's Date header, else the fallback (when we received it). */
    static requestedAt(email, fallback = null) {
        const t = email && email.date ? Date.parse(email.date) : NaN;
        return Number.isNaN(t) ? fallback : new Date(t).toISOString();
    }

    /**
     * When the owner asked, for a queued item: the asOf the enqueue dry-run
     * was judged at (validation.asOf), else the email's Date header, else
     * when we received it. Approval re-validates at this same moment.
     */
    static itemRequestedAt(item) {
        const stored = item && item.validation && item.validation.asOf;
        const t = stored ? Date.parse(stored) : NaN;
        return Number.isNaN(t)
            ? PendingMovesService.requestedAt(item && item.email, (item && item.createdAt) || null)
            : new Date(t).toISOString();
    }

    /**
     * Immutable enqueue-time NFL.com evidence for an ordinary IR move: the
     * positive verdict the intake dry-run fetched seconds after the owner
     * asked, judged at validation.asOf. Stored on item.enqueueEvidence,
     * separately from item.validation, so later rechecks (which overwrite
     * validation) can never touch it. Null unless the intake dry-run passed
     * with eligible NFL.com evidence.
     */
    static enqueueEvidenceFrom(move, validation) {
        if (!move || move.move_type !== 'ir' || !validation || validation.valid !== true) return null;
        const nfl = validation.nflEligibility;
        if (!nfl || nfl.eligible !== true || !validation.asOf) return null;
        return {
            asOf: validation.asOf,
            checkedAt: validation.checkedAt || nfl.checkedAt || null,
            dropPlayerId: move.drop_player_id,
            teamId: move.team_id,
            moveType: 'ir',
            nflEligibility: JSON.parse(JSON.stringify(nfl))
        };
    }

    /**
     * Items queued before enqueueEvidence existed: their validation IS the
     * intake dry-run as long as it has never been rechecked (no recheckCount),
     * so it may serve as legacy evidence. Anything rechecked without the
     * field has lost its original and gets no fallback.
     */
    static legacyEnqueueEvidence(item) {
        // Only items with no field at all; a stored null means "intake did not pass"
        if (!item || item.enqueueEvidence !== undefined || !item.validation || !item.move) return null;
        if (item.validation.recheckCount || item.validation.recheckedBy) return null;
        // Judge the move as it was at intake: an approval-time type override
        // (supplemental -> ir) has no IR intake verdict behind it
        const intakeMove = { ...item.move, move_type: item.move.original_move_type || item.move.move_type };
        const evidence = PendingMovesService.enqueueEvidenceFrom(intakeMove, item.validation);
        return evidence ? { ...evidence, legacy: true } : null;
    }

    /** The evidence approval may offer the validator: the preserved field, else the legacy original. */
    static enqueueEvidenceOf(item) {
        if (!item) return null;
        if (item.enqueueEvidence && typeof item.enqueueEvidence === 'object') return item.enqueueEvidence;
        return PendingMovesService.legacyEnqueueEvidence(item);
    }

    async dryRunMove(move, { asOf = null } = {}) {
        const checkedAt = new Date().toISOString();
        if (!move) return { valid: false, errors: ['No move could be extracted'], checkedAt };
        if (move.move_type === 'trade') {
            // Trades have no single dry-run helper; checked at approve time by executeTrade
            return { valid: true, errors: [], checkedAt, note: 'Trade validated at approval' };
        }
        if (!(move.team_id && move.drop_player_id && move.add_player_id)) {
            return { valid: false, errors: ['Dry-run not executed'], checkedAt: null };
        }
        try {
            const result = await this.db.validateRosterMove(
                move.team_id, move.drop_player_id, move.add_player_id, move.move_type, { asOf }
            );
            const validation = { valid: result.valid, errors: result.errors, checkedAt, asOf };
            const evidence = result.context && result.context.nflEligibility;
            if (evidence) validation.nflEligibility = evidence;
            return validation;
        } catch (error) {
            return { valid: false, errors: [error.message], checkedAt };
        }
    }

    /**
     * needs_review unless the parse was clean, confidence is high/medium and
     * every validation check passed.
     */
    static routeStatus(parseStatus, move, validation) {
        const clean = parseStatus === 'parsed' &&
            move && (move.confidence === 'high' || move.confidence === 'medium') &&
            validation && validation.valid === true;
        return clean ? 'pending' : 'needs_review';
    }

    /**
     * Enqueue the moves parsed from one email. parse is the full parser
     * result; each move becomes one item. Runs the validation dry-run for
     * each move (read-only). Returns the created items.
     */
    async enqueueParsedEmail(email, parse) {
        const queue = await this.loadQueue();
        const items = [];

        if (parse.status === 'move_invalidation') {
            const address = String(email.from || '').match(/[\w.+-]+@[\w.-]+/)?.[0]?.toLowerCase();
            if (address !== 'wdochse@gmail.com' || !parse.invalidation_quote?.trim() ||
                !email.body.includes(parse.invalidation_quote.trim()) || (parse.moves || []).length) {
                throw new Error('Invalid commissioner note');
            }
            const existing = queue.items.find(i => PendingMovesService.canonicalEmailId(i.emailId) ===
                PendingMovesService.canonicalEmailId(email.gmailMessageId));
            if (existing) return [existing];
            const notice = {
                id: `pm-${Date.now()}-${++this.seq}`, kind: 'commissioner_invalidation',
                emailId: email.gmailMessageId, threadId: email.threadId || null,
                email: { from: email.from, subject: email.subject, date: email.date, body: email.body },
                parse: { status: parse.status, summary: parse.summary, questions_for_commissioner: [] },
                rulingQuote: parse.invalidation_quote.trim(),
                move: null, validation: null, status: 'notice',
                createdAt: new Date().toISOString(), resolvedAt: null, resolvedBy: null,
                executionResult: null
            };
            queue.items.push(notice);
            await this.saveQueue(queue);
            return [notice];
        }
        const asOf = PendingMovesService.requestedAt(email, new Date().toISOString());
        for (const move of parse.moves || []) {
            // A received trade player may be the outgoing player in the next
            // action. Preserve both proposals, but never approve out of order.
            const predecessor = items.slice().reverse().find(i =>
                i.move?.move_type === 'trade' && i.move.team_id === move.team_id &&
                i.move.partner_player_id === move.drop_player_id);
            const validation = predecessor
                ? { valid: false, errors: ['Waiting for preceding trade approval'], checkedAt: new Date().toISOString(), asOf }
                : await this.dryRunMove(move, { asOf });
            const needsReview = PendingMovesService.routeStatus(parse.status, move, validation) !== 'pending';

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
                ...(predecessor ? { dependsOnItemId: predecessor.id } : {}),
                validation,
                // Immutable copy of a passing intake verdict; rechecks never overwrite it
                enqueueEvidence: PendingMovesService.enqueueEvidenceFrom(move, validation),
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
        // Retain the original Gmail ID on every proposal. A recovered email
        // is no longer an ignored sender, and queued items own its dedup.
        if (items.length) queue.processedEmails = queue.processedEmails.filter(p =>
            !(p.emailId === email.gmailMessageId && p.reason === 'unknown_sender'));
        await this.saveQueue(queue);

        logInfo(`Enqueued ${items.length} pending move(s) from email ${email.gmailMessageId}`, {
            from: email.from,
            statuses: items.map(i => i.status)
        });

        return items;
    }

    async getItems({ status = null } = {}) {
        const queue = await this.loadQueue();
        const linked = attachRulings(queue.items);
        const items = status ? linked.filter(i => i.status === status) : linked;
        return items.slice().reverse(); // newest first
    }

    async linkRuling(noteId, moveId) {
        const queue = await this.loadQueue();
        const note = queue.items.find(i => i.id === noteId && i.kind === 'commissioner_invalidation');
        const move = queue.items.find(i => i.id === moveId && i.kind !== 'commissioner_invalidation');
        if (!note || !move) throw new Error('Ruling or target move not found');
        note.relatedItemIds = [move.id];
        note.linkedBy = 'commissioner';
        note.linkedAt = new Date().toISOString();
        await this.saveQueue(queue);
        return note;
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
     * A failed item may be approved again (retry); it goes through the
     * validator exactly like a first attempt.
     * options.override ({ reason }) is the commissioner override - use
     * overrideItem(), which checks the preconditions.
     */
    async approveItem(id, resolvedBy = 'commissioner', { moveTypeOverride = null, override = null } = {}) {
        const queue = await this.loadQueue();
        const item = queue.items.find(i => i.id === id);
        if (!item) throw new Error(`Pending move ${id} not found`);
        if (!PendingMovesService.isOpen(item)) {
            throw new Error(`Pending move ${id} is already ${item.status}`);
        }
        if (!item.move) {
            throw new Error(`Pending move ${id} has no executable move (ambiguous email)`);
        }
        if (override) {
            const reason = typeof override.reason === 'string' ? override.reason.trim() : '';
            if (!reason) throw new Error('Commissioner override requires a reason');
            if (!PendingMovesService.isInvalid(item)) {
                throw new Error(`Pending move ${id} is not deemed invalid; approve it normally`);
            }
            override = { reason };
        }

        if (item.dependsOnItemId && !queue.items.some(i =>
            i.id === item.dependsOnItemId && i.status === 'approved')) {
            throw new Error('Waiting for preceding trade approval');
        }
        const move = item.move;
        if (moveTypeOverride && moveTypeOverride !== move.move_type) {
            const convertible = ['ir', 'supplemental', 'ir_return'];
            if (!convertible.includes(moveTypeOverride) || !convertible.includes(move.move_type)) {
                throw new Error(`Cannot override move type ${move.move_type} -> ${moveTypeOverride}`);
            }
            // The parsed type survives a retry that overrides again
            move.original_move_type = move.original_move_type || move.move_type;
            move.move_type = moveTypeOverride;
        }
        const mode = override ? 'override' : item.status === 'failed' ? 'retry' : 'approve';
        const attemptedAt = new Date().toISOString();
        // Rules that depend on time (drop lock, IR eligibility week) are judged when the owner asked, not when approved
        const asOf = PendingMovesService.itemRequestedAt(item);
        // Delayed approval of an IR move: the validator still fetches NFL.com
        // fresh; only if that fetch cannot be completed (NFL_UNAVAILABLE, e.g.
        // the historical week's injury page no longer served) may it fall back
        // to the immutable enqueue-time evidence, and only when season, judged
        // week, player and asOf all match. Email items only - the admin form
        // never passes this.
        const enqueueEvidence = move.move_type === 'ir'
            ? PendingMovesService.enqueueEvidenceOf(item)
            : null;
        const executeOptions = enqueueEvidence ? { asOf, enqueueEvidence } : { asOf };
        if (override) {
            executeOptions.overrideValidation = true;
            executeOptions.overrideReason = override.reason;
        }
        try {
            let result;
            if (move.move_type === 'trade') {
                result = await this.db.executeTrade(
                    move.team_id, move.drop_player_id,
                    move.partner_team_id, move.partner_player_id,
                    override ? { asOf, overrideValidation: true, overrideReason: override.reason } : { asOf }
                );
            } else {
                // Approve-time re-validation: executeRosterMove runs
                // validateRosterMove internally and throws on failure
                result = await this.db.executeRosterMove(
                    move.team_id, move.drop_player_id, move.add_player_id, move.move_type, executeOptions
                );
            }
            item.status = 'approved';
            item.executionResult = { success: true, message: `${result.dropped?.name || ''} -> ${result.added?.name || ''}`.trim() };
            // Approve-time NFL.com evidence (fresh fetch inside executeRosterMove,
            // or the enqueue-time evidence it accepted: basis 'enqueue')
            if (result.nflEligibility) {
                item.executionResult.nflEligibility = result.nflEligibility;
                if (result.nflEligibility.basis === 'enqueue') {
                    item.executionResult.evidenceBasis = enqueueEvidence && enqueueEvidence.legacy ? 'enqueue_legacy' : 'enqueue';
                    logInfo(`Pending move ${id} approved on enqueue-time NFL.com evidence (fresh check unavailable)`, {
                        enqueueCheckedAt: result.nflEligibility.enqueueCheckedAt,
                        fresh: result.nflEligibility.freshCheck && result.nflEligibility.freshCheck.reason
                    });
                }
            }
            if (override) {
                // Audit record: who, when, why, and exactly which checks were set aside
                const overriddenErrors = Array.isArray(result.overriddenErrors) ? result.overriddenErrors : [];
                item.override = { reason: override.reason, by: resolvedBy, at: attemptedAt, overriddenErrors };
                item.executionResult.override = true;
                item.executionResult.overriddenErrors = overriddenErrors;
                logInfo(`Pending move ${id} executed by commissioner override`, {
                    by: resolvedBy, reason: override.reason, overriddenErrors
                });
            }
            item.resolvedAt = attemptedAt;
            item.resolvedBy = resolvedBy;
        } catch (error) {
            // Not resolved: the item stays on the list with its error so the
            // commissioner can retry, recheck, override or reject it.
            item.status = 'failed';
            item.executionResult = { success: false, message: error.message, attemptedAt, by: resolvedBy, mode };
            if (error.nflEligibility) item.executionResult.nflEligibility = error.nflEligibility;
            if (override) item.executionResult.override = true;
            item.resolvedAt = null;
            item.resolvedBy = null;
            logError(`Pending move ${id} failed on ${mode}`, error);
        }

        item.lastAttemptAt = attemptedAt;
        item.lastAttemptBy = resolvedBy;
        item.executionAttempts = [...(Array.isArray(item.executionAttempts) ? item.executionAttempts : []), {
            at: attemptedAt, by: resolvedBy, mode, moveType: move.move_type,
            success: item.status === 'approved', message: item.executionResult.message,
            ...(override ? { overrideReason: override.reason, overriddenErrors: item.override ? item.override.overriddenErrors : null } : {})
        }];
        await this.saveQueue(queue);
        return item;
    }

    /**
     * Commissioner override: deliberately execute ONE move the validator
     * refuses (failed dry-run or failed execution). Explicit (own endpoint,
     * required reason), auditable (item.override, executionAttempts,
     * roster_moves.notes) and scoped to the selected item only; every other
     * item keeps the normal approve path. The move still cannot execute if a
     * player does not exist or the roster would not end at 19 active.
     */
    async overrideItem(id, resolvedBy = 'commissioner', { reason = null, moveTypeOverride = null } = {}) {
        return this.approveItem(id, resolvedBy, { moveTypeOverride, override: { reason } });
    }

    /**
     * Re-run the read-only dry-run for an unresolved non-trade item (fresh
     * NFL.com fetch for IR moves) and store the new evidence. Promotes
     * needs_review -> pending only when the parse was clean with high/medium
     * confidence and every validation check passes; a failed recheck leaves
     * (or puts) the item in needs_review. A failed item is re-routed the
     * same way; its failed executionResult stays for reference. Never
     * executes the move.
     */
    async revalidateItem(id, checkedBy = 'commissioner') {
        const queue = await this.loadQueue();
        const item = queue.items.find(i => i.id === id);
        if (!item) throw new Error(`Pending move ${id} not found`);
        if (!PendingMovesService.isOpen(item)) {
            throw new Error(`Pending move ${id} is already ${item.status}`);
        }
        if (!item.move) {
            throw new Error(`Pending move ${id} has no executable move (ambiguous email)`);
        }
        if (item.move.move_type === 'trade') {
            throw new Error(`Pending move ${id} is a trade; trades are validated at approval`);
        }

        const previousStatus = item.status;
        const waiting = item.dependsOnItemId && !queue.items.some(i =>
            i.id === item.dependsOnItemId && i.status === 'approved');
        const validation = waiting
            ? { valid: false, errors: ['Waiting for preceding trade approval'], checkedAt: new Date().toISOString() }
            : await this.dryRunMove(item.move, { asOf: PendingMovesService.itemRequestedAt(item) });
        validation.recheckedBy = checkedBy;
        validation.recheckCount = ((item.validation && item.validation.recheckCount) || 0) + 1;
        // A pre-field item's original verdict would be lost by this overwrite: preserve it first
        const legacy = PendingMovesService.legacyEnqueueEvidence(item);
        if (legacy && item.enqueueEvidence === undefined) item.enqueueEvidence = legacy;
        item.validation = validation;
        item.status = PendingMovesService.routeStatus(item.parse && item.parse.status, item.move, validation);
        item.lastRecheckAt = validation.checkedAt;
        await this.saveQueue(queue);

        logInfo(`Rechecked pending move ${id}: ${previousStatus} -> ${item.status}`, {
            valid: validation.valid,
            errors: validation.errors,
            nfl: validation.nflEligibility ? validation.nflEligibility.code : null
        });
        return item;
    }

    /** Reject (or, for a failed item, dismiss) an open item. The failure it may have had stays in executionAttempts. */
    async rejectItem(id, reason = null, resolvedBy = 'commissioner') {
        const queue = await this.loadQueue();
        const item = queue.items.find(i => i.id === id);
        if (!item) throw new Error(`Pending move ${id} not found`);
        if (!PendingMovesService.isOpen(item)) {
            throw new Error(`Pending move ${id} is already ${item.status}`);
        }

        const lastFailure = item.status === 'failed' && item.executionResult && item.executionResult.success === false
            ? item.executionResult.message : null;
        item.status = 'rejected';
        item.executionResult = reason ? { success: false, message: reason } : null;
        if (lastFailure) item.executionResult = { ...(item.executionResult || { success: false, message: 'Dismissed after failed execution' }), lastFailure };
        item.resolvedAt = new Date().toISOString();
        item.resolvedBy = resolvedBy;
        await this.saveQueue(queue);
        return item;
    }

    /** Items still waiting on the commissioner: pending, needs_review and failed. */
    async getPendingCount() {
        const queue = await this.loadQueue();
        return queue.items.filter(PendingMovesService.isOpen).length;
    }
}

module.exports = PendingMovesService;
