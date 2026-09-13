/**
 * Annual PFL draft-slot assignments and the canonical regular-season schedule.
 *
 * team_id is a permanent owner identity. Draft slot and division change every
 * season, so matchup generation must translate the slot schedule through an
 * explicitly reviewed annual owner order instead of treating team_id as a slot.
 */

const REGULAR_SEASON_SLOT_MATCHUPS = Object.freeze({
    1: [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11, 12]],
    2: [[1, 4], [3, 6], [5, 8], [7, 10], [9, 12], [11, 2]],
    3: [[1, 6], [3, 8], [5, 10], [7, 12], [9, 2], [11, 4]],
    4: [[1, 8], [3, 10], [5, 12], [7, 2], [9, 4], [11, 6]],
    5: [[1, 10], [3, 12], [5, 2], [7, 4], [9, 6], [11, 8]],
    6: [[1, 12], [3, 2], [5, 4], [7, 6], [9, 8], [11, 10]],
    7: [[1, 3], [2, 4], [5, 11], [6, 8], [7, 9], [10, 12]],
    8: [[1, 5], [2, 12], [7, 11], [8, 4], [9, 3], [10, 6]],
    9: [[1, 9], [2, 6], [3, 11], [4, 12], [5, 7], [8, 10]],
    10: [[1, 7], [2, 8], [3, 5], [4, 10], [6, 12], [9, 11]],
    11: [[1, 11], [2, 10], [3, 7], [4, 6], [5, 9], [8, 12]],
    12: [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11, 12]]
});

const SEASON_DRAFT_ORDERS = Object.freeze({
    // Official order from Dan's August 31, 2026 email. The database uses
    // "Matt" for Matty, so the stable owner identity is recorded that way.
    2026: Object.freeze([
        'Aaron', 'Sean', 'Mitch', 'Bruce', 'Mike', 'Matt',
        'Joe', 'Dan', 'Eli', 'Chris', 'Cal', 'Pete'
    ])
});

function getDraftOrder(season) {
    const draftOrder = SEASON_DRAFT_ORDERS[Number(season)];
    if (!draftOrder) {
        throw new Error(
            `No reviewed draft order configured for season ${season}; ` +
            'refusing to infer annual slots from permanent team IDs'
        );
    }
    return draftOrder;
}

function divisionForSlot(slot) {
    if (!Number.isInteger(slot) || slot < 1 || slot > 12) {
        throw new Error(`Invalid draft slot: ${slot}`);
    }
    return slot % 2 === 1 ? 'Odd' : 'Even';
}

function resolveSeasonAssignments(season, teams) {
    const draftOrder = getDraftOrder(season);
    const byOwner = new Map();

    for (const team of teams) {
        const owner = String(team.owner_name || '').trim().toLowerCase();
        if (!owner) throw new Error(`Team ${team.team_id} has no owner name`);
        if (byOwner.has(owner)) throw new Error(`Duplicate owner name in teams: ${team.owner_name}`);
        byOwner.set(owner, team);
    }

    const assignments = draftOrder.map((ownerName, index) => {
        const team = byOwner.get(ownerName.toLowerCase());
        if (!team) throw new Error(`Configured owner not found in teams: ${ownerName}`);

        const draftSlot = index + 1;
        return {
            season: Number(season),
            draftSlot,
            teamId: team.team_id,
            ownerName: team.owner_name,
            division: divisionForSlot(draftSlot)
        };
    });

    if (assignments.length !== 12 || new Set(assignments.map(a => a.teamId)).size !== 12) {
        throw new Error(`Season ${season} must resolve to 12 unique teams`);
    }

    return assignments;
}

function buildRegularSeasonMatchups(season, teams) {
    const assignments = resolveSeasonAssignments(season, teams);
    const bySlot = new Map(assignments.map(assignment => [assignment.draftSlot, assignment]));

    const weeks = Object.fromEntries(
        Object.entries(REGULAR_SEASON_SLOT_MATCHUPS).map(([week, pairs]) => [
            Number(week),
            pairs.map(([team1Slot, team2Slot]) => ({
                week: Number(week),
                team1Slot,
                team2Slot,
                team1Id: bySlot.get(team1Slot).teamId,
                team2Id: bySlot.get(team2Slot).teamId,
                team1Owner: bySlot.get(team1Slot).ownerName,
                team2Owner: bySlot.get(team2Slot).ownerName
            }))
        ])
    );

    return { season: Number(season), assignments, weeks };
}

module.exports = {
    REGULAR_SEASON_SLOT_MATCHUPS,
    SEASON_DRAFT_ORDERS,
    buildRegularSeasonMatchups,
    divisionForSlot,
    getDraftOrder,
    resolveSeasonAssignments
};
