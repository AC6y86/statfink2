/**
 * The Double Check job must be an INDEPENDENT re-derivation: none of its
 * modules may import the production scoring code it is checking.
 */
const fs = require('fs');
const path = require('path');

const FORBIDDEN = /require\(\s*['"][^'"]*(scoringService|scoringPlayersService|fantasyPointsCalculationService|scoringPlayParserService|individualPlayerScoringService|dstManagementService|teamScoreService)['"]\s*\)/;

function candidates() {
    const root = path.join(__dirname, '../../scripts');
    const files = [];
    for (const f of fs.readdirSync(path.join(root, 'lib'))) {
        if (/^(doublecheck|espn|tdDossier)/.test(f) && f.endsWith('.js')) files.push(path.join(root, 'lib', f));
    }
    for (const f of fs.readdirSync(root)) {
        if (/^doublecheck-.*\.js$/.test(f)) files.push(path.join(root, f));
    }
    return files;
}

describe('doublecheck independence tripwire', () => {
    test('no doublecheck module requires a production scoring service', () => {
        const files = candidates();
        expect(files.length).toBeGreaterThan(0);
        const offenders = files.filter(f => FORBIDDEN.test(fs.readFileSync(f, 'utf8')));
        expect(offenders).toEqual([]);
    });
});
