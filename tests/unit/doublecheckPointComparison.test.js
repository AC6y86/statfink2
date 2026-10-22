const { applyDossierTotals } = require('../../scripts/lib/doublecheckPointComparison');

describe('auditor individual touchdown totals', () => {
    const lateral = { plays: [{ awardClass: 'AMBIGUOUS' }] };
    test('retains official Purdy and Samuel totals when the ledger omits their lateral TD', () => {
        expect(applyDossierTotals({ passing_tds: 4 }, { passing_tds: 3 }, { dossier: lateral })).toEqual({ passing_tds: 4 });
        expect(applyDossierTotals({ receiving_tds: 1, receiving_yards: 80 }, { receiving_tds: 0 }, { dossier: lateral }))
            .toEqual({ receiving_tds: 1, receiving_yards: 80 });
    });
    test('uses ESPN rather than the stored scorer even when the ledger is ambiguous', () => {
        expect(applyDossierTotals({ passing_tds: 2 }, { passing_tds: 3 }, { dossier: lateral })).toEqual({ passing_tds: 2 });
    });
    test('complete ledger still applies PFL offensive recovery awards', () => {
        expect(applyDossierTotals({ rushing_tds: 0, rushing_yards: 7 }, { rushing_tds: 1 },
            { dossier: { plays: [{ awardClass: 'OFF_RECOVERY', votesAgree: true }] } })).toEqual({ rushing_tds: 1, rushing_yards: 7 });
    });
    test('DST touchdown credit still comes from the dossier', () => {
        expect(applyDossierTotals({ def_int_return_tds: 0 }, { def_int_return_tds: 1 }, { isDst: true, dossier: lateral }))
            .toEqual({ def_int_return_tds: 1 });
    });
    test('failed or missing dossier cannot zero individual boxscore TDs', () => {
        expect(applyDossierTotals({ receiving_tds: 1 }, { receiving_tds: 0 })).toEqual({ receiving_tds: 1 });
        expect(applyDossierTotals({ receiving_tds: 1 }, { receiving_tds: 0 }, { dossier: { error: 'unavailable' } }))
            .toEqual({ receiving_tds: 1 });
    });
});
