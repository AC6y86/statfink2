/** Read-only alert projection from the authoritative pending-move queue.
 * Stored alerts remain audit history; no roster decisions are made here.
 */
const canonicalId = id => String(id || '').replace(/^retry-\d{8}-(?=[a-f0-9]+$)/, '');
const terminal = status => status === 'approved' || status === 'rejected';

function linkedItems(alert, items) {
    if (alert.source !== 'email-moves') return [];
    const proposals = items.filter(i => i.emailId && i.kind !== 'commissioner_invalidation');
    let emailId = canonicalId(alert.emailId);
    if (emailId) {
        const group = proposals.filter(i => canonicalId(i.emailId) === emailId);
        // Missing members must not make a partly handled email look resolved.
        if (alert.pendingItemIds?.some(id => !group.some(i => i.id === id))) return [];
        return group;
    }
    // Legacy alerts predate explicit source IDs. Require the exact sender
    // prefix, creation within one second, and one unique source email.
    const candidates = proposals.filter(i => {
        const delta = Date.parse(alert.timestamp) - Date.parse(i.createdAt);
        const from = i.email?.from;
        return from && delta >= 0 && delta <= 1000 &&
            (alert.message.startsWith(`Email move from ${from} needs review: `) ||
             alert.message.startsWith(`New pending roster move from ${from}: `));
    });
    const ids = new Set(candidates.map(i => canonicalId(i.emailId)));
    if (ids.size !== 1) return [];
    emailId = [...ids][0];
    return proposals.filter(i => canonicalId(i.emailId) === emailId);
}

function projectEmailMoveAlert(alert, items) {
    if (alert.acknowledged) return alert;
    const linked = linkedItems(alert, items);
    if (!linked.length) return alert;
    const resolved = linked.every(i => terminal(i.status));
    const unresolved = linked.filter(i => !terminal(i.status));
    if (!resolved && unresolved.some(i => !['pending', 'needs_review', 'failed'].includes(i.status))) return alert;
    const review = unresolved.some(i => i.status !== 'pending');
    const states = [...new Set(linked.map(i => i.status))].join('/');
    const summaries = [...new Set((resolved ? linked : unresolved).map(i => i.parse?.summary).filter(Boolean))];
    const label = resolved ? `Roster request resolved (${states})` : review ? 'Roster request needs review' : 'Roster request awaiting approval';
    return {
        ...alert,
        emailId: canonicalId(linked[0].emailId),
        pendingItemIds: linked.map(i => i.id),
        severity: resolved || !review ? 'info' : 'warning',
        message: `${label}: ${summaries.join(' · ')}`,
        details: [...new Set((resolved ? [] : unresolved).flatMap(i => i.parse?.questions_for_commissioner || []))],
        acknowledged: resolved,
        ...(resolved ? { automaticallyResolved: true, acknowledgementReason: 'All linked roster proposals approved or rejected' } : {}),
        originalAlert: { message: alert.message, severity: alert.severity, details: alert.details }
    };
}
module.exports = { projectEmailMoveAlert, linkedItems };
