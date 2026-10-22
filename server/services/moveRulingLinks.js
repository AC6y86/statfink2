// Join informational rulings to proposals; never approve, reject, or undo.
const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function rulingTargets(note, proposals) {
    if (Array.isArray(note.relatedItemIds) && note.relatedItemIds.length) {
        return proposals.filter(i => note.relatedItemIds.includes(i.id)).map(i => i.id);
    }
    if (!note.threadId || !note.email?.body) return [];
    const body = ` ${normalize(note.email.body)} `;
    const candidates = proposals.filter(i => {
        if (i.threadId !== note.threadId || !i.move?.add_player_name) return false;
        if (!(Date.parse(i.email?.date) <= Date.parse(note.email.date))) return false;
        const owner = normalize(i.email?.from?.split(/[ <]/)[0]);
        const player = normalize(i.move.add_player_name);
        return owner && body.includes(` ${owner} `) && body.includes(` ${player} `);
    });
    return candidates.length === 1 ? [candidates[0].id] : [];
}
function attachRulings(items) {
    const proposals = items.filter(i => i.kind !== 'commissioner_invalidation');
    const notes = items.filter(i => i.kind === 'commissioner_invalidation');
    const linked = notes.map(n => ({...n, relatedItemIds: rulingTargets(n, proposals)}));
    return items.map(i => i.kind === 'commissioner_invalidation'
        ? linked.find(n => n.id === i.id)
        : {...i, commissionerRulings: linked.filter(n => n.relatedItemIds.includes(i.id))});
}
module.exports = { attachRulings, rulingTargets };
