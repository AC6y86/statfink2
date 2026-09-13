const fs = require('fs');
const path = require('path');
const {
    REGULAR_SEASON_SLOT_MATCHUPS,
    buildRegularSeasonMatchups,
    divisionForSlot,
    getDraftOrder
} = require('../../server/config/seasonMatchups');

const TEAMS = [
    [1, 'Chris'], [2, 'Mitch'], [3, 'Dan'], [4, 'Pete'],
    [5, 'Joe'], [6, 'Aaron'], [7, 'Cal'], [8, 'Bruce'],
    [9, 'Mike'], [10, 'Sean'], [11, 'Eli'], [12, 'Matt']
].map(([team_id, owner_name]) => ({ team_id, owner_name }));

function normalized(pair) {
    return [...pair].sort((a, b) => a - b).join('-');
}

function scheduleFromMarkdown() {
    const markdown = fs.readFileSync(path.join(__dirname, '../../docs/MATCHUPS.md'), 'utf8');
    const result = {};
    for (const match of markdown.matchAll(/^Week (\d+): (.+)$/gm)) {
        const week = Number(match[1]);
        if (week > 12) continue;
        result[week] = match[2].split(', ').map(pair => pair.split(' vs ').map(Number));
    }
    return result;
}

describe('season-specific draft order and matchup translation', () => {
    test('2026 Week 1 resolves to the official owner matchups', () => {
        const schedule = buildRegularSeasonMatchups(2026, TEAMS);
        const names = schedule.weeks[1].map(m => `${m.team1Owner} vs ${m.team2Owner}`);
        expect(names).toEqual([
            'Aaron vs Sean',
            'Mitch vs Bruce',
            'Mike vs Matt',
            'Joe vs Dan',
            'Eli vs Chris',
            'Cal vs Pete'
        ]);
    });

    test('all 72 Week 1-12 slot matchups exactly match docs/MATCHUPS.md', () => {
        expect(REGULAR_SEASON_SLOT_MATCHUPS).toEqual(scheduleFromMarkdown());
        expect(Object.values(REGULAR_SEASON_SLOT_MATCHUPS).flat()).toHaveLength(72);
    });

    test('every team appears once per week and Weeks 1-11 are a full round robin', () => {
        const opponents = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, new Set()]));

        for (let week = 1; week <= 12; week += 1) {
            const slots = REGULAR_SEASON_SLOT_MATCHUPS[week].flat();
            expect(slots.sort((a, b) => a - b)).toEqual(
                Array.from({ length: 12 }, (_, i) => i + 1)
            );

            if (week <= 11) {
                for (const [one, two] of REGULAR_SEASON_SLOT_MATCHUPS[week]) {
                    opponents[one].add(two);
                    opponents[two].add(one);
                }
            }
        }

        for (let slot = 1; slot <= 12; slot += 1) {
            expect(opponents[slot].size).toBe(11);
            expect(opponents[slot].has(slot)).toBe(false);
        }
        expect(REGULAR_SEASON_SLOT_MATCHUPS[12].map(normalized).sort()).toEqual(
            REGULAR_SEASON_SLOT_MATCHUPS[1].map(normalized).sort()
        );
    });

    test('division follows annual draft-slot parity, not permanent team_id', () => {
        const schedule = buildRegularSeasonMatchups(2026, TEAMS);
        expect(schedule.assignments.map(a => [a.ownerName, a.division])).toEqual([
            ['Aaron', 'Odd'], ['Sean', 'Even'], ['Mitch', 'Odd'], ['Bruce', 'Even'],
            ['Mike', 'Odd'], ['Matt', 'Even'], ['Joe', 'Odd'], ['Dan', 'Even'],
            ['Eli', 'Odd'], ['Chris', 'Even'], ['Cal', 'Odd'], ['Pete', 'Even']
        ]);
        expect(divisionForSlot(1)).toBe('Odd');
        expect(divisionForSlot(12)).toBe('Even');
    });

    test('future rollover fails closed without a reviewed draft order', () => {
        expect(() => getDraftOrder(2027)).toThrow(/No reviewed draft order configured/);
        expect(() => buildRegularSeasonMatchups(2027, TEAMS)).toThrow(
            /refusing to infer annual slots from permanent team IDs/
        );
    });
});
