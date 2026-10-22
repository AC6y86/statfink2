/**
 * Admin Moves UI (helm/admin/js/areas/moves.js): a move the validator refuses
 * offers a clearly labelled commissioner override (reason required), a valid
 * move does not; a failed execution stays listed with its error and retry /
 * override / dismiss actions. Rendered in a vm sandbox, no browser.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../../helm/admin/js/areas/moves.js'), 'utf8');

function context() {
    const ctx = {
        esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        pill: (kind, label) => `<span class="pill ${kind}">${label}</span>`,
        ago: () => 'recently',
        TYPE_LABELS: { ir: 'IR move', supplemental: 'Supplemental', ir_return: 'IR return', trade: 'Trade' }
    };
    vm.createContext(ctx);
    vm.runInContext(source.slice(source.indexOf('export function renderCommissionerNote'), source.indexOf('async function renderMoves()')).replace('export function', 'function'), ctx);
    vm.runInContext(source.slice(source.indexOf('export function describeMove'), source.indexOf('export async function approvePending')).replaceAll('export function', 'function').replace('export const', 'const'), ctx);
    return ctx;
}
const teamCtx = { teamName: () => 'Sean' };
const move = { team_id: 10, move_type: 'supplemental', drop_player_name: 'Mostert', add_player_name: 'Ekeler' };

test('an invalid move offers an explicit override with a required reason; a valid move does not', () => {
    const ctx = context();
    const invalid = ctx.renderPendingItem({ id: 'm1', status: 'needs_review', move, validation: { valid: false, errors: ['Player to add is not available'] }, parse: { questions_for_commissioner: [] } }, teamCtx);
    expect(invalid).toContain('data-action="override"');
    expect(invalid).toContain('Override validation');
    expect(invalid).toContain('id="override-reason-m1"');
    expect(invalid).toContain('Reason (required)');
    expect(invalid).toContain('data-action="override-confirm"');
    expect(invalid).toContain('even though validation says: Player to add is not available');
    expect(invalid).not.toContain('data-action="approve"'); // needs_review keeps no one-click approve

    const valid = ctx.renderPendingItem({ id: 'm2', status: 'pending', move, validation: { valid: true, errors: [] }, parse: { questions_for_commissioner: [] } }, teamCtx);
    expect(valid).toContain('data-action="approve"');
    expect(valid).not.toContain('data-action="override"');
    expect(valid).not.toContain('override-confirm');
});

test('a failed execution stays listed with its error and retry / override / dismiss actions', () => {
    const html = context().renderPendingItem({
        id: 'm3', status: 'failed', move, validation: { valid: true, errors: [] }, parse: { questions_for_commissioner: [] },
        executionResult: { success: false, message: "Player is already on <Matt's> Team", attemptedAt: '2026-10-18T14:48:49.845Z', mode: 'approve' },
        executionAttempts: [{ mode: 'approve', success: false }, { mode: 'retry', success: false }]
    }, teamCtx);
    expect(html).toContain('execution failed');
    expect(html).toContain('Execution failed');
    expect(html).toContain('Player is already on &lt;Matt&#039;s&gt; Team'.replace('&#039;', "'"));
    expect(html).toContain('2 attempts');
    expect(html).toContain('Retry approve');
    expect(html).toContain('data-action="approve"');
    expect(html).toContain('data-action="override"');
    expect(html).toContain('Reject (dismiss)');
    expect(html).toContain('data-action="recheck"');
});

test('an approved-by-override move shows who, why and what was overrode, with no further actions', () => {
    const html = context().renderPendingItem({
        id: 'm4', status: 'approved', move, parse: { questions_for_commissioner: [] },
        executionResult: { success: true, message: 'Mostert -> Ekeler', override: true },
        override: { reason: 'Commissioner ruling', by: 'commissioner', at: '2026-10-18T15:00:00.000Z', overriddenErrors: ['Player to add is not available'] }
    }, teamCtx);
    expect(html).toContain('Executed by commissioner override');
    expect(html).toContain('Reason: Commissioner ruling');
    expect(html).toContain('Overrode: Player to add is not available');
    expect(html).toContain('>override<');
    expect(html).not.toContain('data-action="approve"');
    expect(html).not.toContain('data-action="override"');
});

test('the Moves page keeps failed items in the waiting list and counts them', async () => {
    const ctx = context(), body = { innerHTML: '' };
    Object.assign(ctx, {
        root: { querySelector: () => body }, ctxRef: teamCtx,
        getData: async () => ({ items: [
            { id: 'f1', status: 'failed', move, validation: { valid: true }, executionResult: { success: false, message: 'Roster changed' } },
            { id: 'p1', status: 'pending', move, validation: { valid: true } },
            { id: 'a1', status: 'approved', move }
        ] }),
        card: ({ title, meta, rows }) => `<section><h2>${title}</h2><i>${meta || ''}</i>${rows}</section>`, renderForm: async () => {}
    });
    vm.runInContext(source.slice(source.indexOf('async function renderMoves()'), source.indexOf('\nfunction opt(')), ctx);
    await ctx.renderMoves();
    expect(body.innerHTML).toContain('2 waiting · 1 failed');
    expect(body.innerHTML).toContain('id="pm-f1"');
    expect(body.innerHTML).toContain('Roster changed');
    expect(body.innerHTML).toContain('id="pm-p1"');
    expect(body.innerHTML).not.toContain('id="pm-a1"');
});
