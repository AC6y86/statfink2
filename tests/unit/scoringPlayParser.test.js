/**
 * Regression tests for ScoringPlayParserService - historically the #1 bug
 * source (blocked returns, fumble recovery categorization, laterals).
 *
 * Fixtures in tests/fixtures/boxscores/ are real Tank01 boxscore responses
 * extracted read-only from the tank01_cache table, including the known bug
 * games from docs/DEFENSIVE_SCORING.md.
 */
const fs = require('fs');
const path = require('path');
const ScoringPlayParserService = require('../../server/services/scoringPlayParserService');

const FIXTURE_DIR = path.join(__dirname, '../fixtures/boxscores');

function loadBoxscore(name) {
    return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8'));
}

describe('ScoringPlayParserService', () => {
    let parser;

    beforeEach(() => {
        parser = new ScoringPlayParserService();
    });

    describe('known bug games from docs/DEFENSIVE_SCORING.md', () => {
        test('CHI week 1 2024: blocked punt return + INT return are both defensive TDs', () => {
            const boxscore = loadBoxscore('boxscore_20240908_TEN@CHI');
            const plays = parser.parseScoringPlays(boxscore, 'CHI', 'TEN');

            const blockedPunt = plays.find(p => p.originalText.includes('Jonathan Owens'));
            expect(blockedPunt).toBeDefined();
            expect(blockedPunt.playType).toBe('defensive_blocked_return_td');
            expect(blockedPunt.scoringTeam).toBe('CHI');

            const intReturn = plays.find(p => p.originalText.includes('Tyrique Stevenson'));
            expect(intReturn).toBeDefined();
            expect(intReturn.playType).toBe('defensive_int_return_td');
            expect(intReturn.scoringTeam).toBe('CHI');

            // Doc check: CHI defense week 1 should get 2 defensive TDs (16 points)
            const breakdown = parser.getDefensiveTouchdownBreakdown(plays, 'CHI');
            expect(breakdown.def_blocked_return_tds).toBe(1);
            expect(breakdown.def_int_return_tds).toBe(1);
        });

        test('NYG week 6 2024: blocked FG return is a defensive TD, 102yd fumble return is a defensive TD', () => {
            const boxscore = loadBoxscore('boxscore_20241006_NYG@SEA');
            const plays = parser.parseScoringPlays(boxscore, 'SEA', 'NYG');

            const blockedFG = plays.find(p => p.originalText.includes('Bryce Ford-Wheaton'));
            expect(blockedFG).toBeDefined();
            expect(blockedFG.playType).toBe('defensive_blocked_return_td');
            expect(blockedFG.scoringTeam).toBe('NYG');

            const fumbleReturn = plays.find(p => p.originalText.includes('Rayshawn Jenkins'));
            expect(fumbleReturn).toBeDefined();
            expect(fumbleReturn.playType).toBe('defensive_fumble_return_td');
            expect(fumbleReturn.scoringTeam).toBe('SEA');
        });

        test('SEA week 12 2024: Coby Bryant interception return is a defensive TD', () => {
            const boxscore = loadBoxscore('boxscore_20241124_ARI@SEA');
            const plays = parser.parseScoringPlays(boxscore, 'SEA', 'ARI');

            const pickSix = plays.find(p => p.originalText.includes('Coby Bryant'));
            expect(pickSix).toBeDefined();
            expect(pickSix.playType).toBe('defensive_int_return_td');
            expect(pickSix.scoringTeam).toBe('SEA');
        });

        test('TB week 17 2024: J.J. Russell blocked punt return is a defensive TD', () => {
            const boxscore = loadBoxscore('boxscore_20241229_CAR@TB');
            const plays = parser.parseScoringPlays(boxscore, 'TB', 'CAR');

            const blockedPunt = plays.find(p => p.originalText.includes('J.J. Russell'));
            expect(blockedPunt).toBeDefined();
            expect(blockedPunt.playType).toBe('defensive_blocked_return_td');
            expect(blockedPunt.scoringTeam).toBe('TB');

            const breakdown = parser.getDefensiveTouchdownBreakdown(plays, 'TB');
            expect(breakdown.def_blocked_return_tds).toBe(1);
        });
    });

    describe('offensive fumble recoveries are NOT defensive TDs', () => {
        // Per docs/SCORING_SYSTEM.md "Defensive Touchdowns — Exact Award Logic":
        // a team recovering its OWN side's fumble is an offensive TD credited to
        // the recovering player (8 pts), never a Team Defense TD.
        test('ARI week 2 2024: Trey McBride 0 Yd Fumble Recovery is offensive (no defensive TD)', () => {
            const boxscore = loadBoxscore('boxscore_20240915_LAR@ARI');
            const plays = parser.parseScoringPlays(boxscore, 'ARI', 'LAR');

            const mcbride = plays.find(p => p.originalText.includes('Trey McBride'));
            expect(mcbride).toBeDefined();
            expect(mcbride.playType).toBe('offensive_fumble_recovery_td');
            expect(mcbride.playerName).toBe('Trey McBride');
            // Must not be categorized as any defensive type
            expect(parser.isDefensivePlayType(mcbride.playType)).toBe(false);

            const breakdown = parser.getDefensiveTouchdownBreakdown(plays, 'ARI');
            expect(breakdown.def_fumble_return_tds).toBe(0);
        });

        test('short-yardage fumble recovery without defensive indicators is an offensive recovery TD', () => {
            expect(parser.categorizePlayType(
                'tank bigsby 3 yd fumble recovery (kicker kick)',
                'Tank Bigsby 3 Yd Fumble Recovery (Kicker Kick)'
            )).toBe('offensive_fumble_recovery_td');
        });

        test('end-zone fumble recovery without defensive indicators is an offensive recovery TD', () => {
            const text = 'KhaDarel Hodge Fumble Recovery in End Zone (Younghoe Koo Kick)';
            expect(parser.categorizePlayType(text.toLowerCase(), text))
                .toBe('offensive_fumble_recovery_td');
            // e.g. Patrick Ricard BUF@BAL week 4 2024 — same shape, no player hardcoding
            const ricard = 'Patrick Ricard Fumble Recovery in End Zone (Justin Tucker Kick)';
            expect(parser.categorizePlayType(ricard.toLowerCase(), ricard))
                .toBe('offensive_fumble_recovery_td');
        });

        test('sack-strip fumble recovery ("by X for Y loss") IS a defensive TD', () => {
            const text = 'Zaven Collins 3 Yd Fumble Recovery by Josh Sweat For 3 Yd Loss';
            expect(parser.categorizePlayType(text.toLowerCase(), text))
                .toBe('defensive_fumble_return_td');
        });

        test('muffed punt recovered by coverage team IS a defensive TD (special-teams takeaway)', () => {
            const text = 'John Smith Recovered Muffed Punt in End Zone (Kicker Kick)';
            expect(parser.categorizePlayType(text.toLowerCase(), text))
                .toBe('defensive_fumble_return_td');
        });

        test('end-zone recovery by a DEFENSIVE player resolves to a defensive TD (Taron Johnson BUF wk 16 2024)', () => {
            // Same text shape as an offensive recovery — position data decides
            parser.setPlayerPositions({ '3121003': 'CB', '3917232': 'K' });
            const play = {
                score: 'Taron Johnson fumble recovery in end zone (Tyler Bass Kick)',
                playerIDs: ['3121003', '3917232'],
                team: 'BUF'
            };
            const parsed = parser.parseIndividualPlay(play, 'BUF', 'NE');
            expect(parsed.playType).toBe('defensive_fumble_return_td');
            parser.setPlayerPositions(null);
        });

        test('end-zone recovery by an OFFENSIVE player stays an offensive recovery TD even with positions loaded', () => {
            parser.setPlayerPositions({ '3047876': 'WR', '3049899': 'K' });
            const play = {
                score: 'KhaDarel Hodge Fumble Recovery in End Zone (Younghoe Koo Kick)',
                playerIDs: ['3047876', '3049899'],
                team: 'ATL'
            };
            const parsed = parser.parseIndividualPlay(play, 'ATL', 'NO');
            expect(parsed.playType).toBe('offensive_fumble_recovery_td');
            parser.setPlayerPositions(null);
        });
    });

    describe('player name extraction handles hyphens and mixed caps', () => {
        test('hyphenated names are captured in full', () => {
            expect(parser.extractPlayerName('Ihmir Smith-Marsette 100 Yd Kickoff Return (Graham Gano Kick)'))
                .toBe('Ihmir Smith-Marsette');
            expect(parser.extractPlayerName('JuJu Smith-Schuster 12 Yd pass from Patrick Mahomes'))
                .toBe('JuJu Smith-Schuster');
        });

        test('apostrophes and initials are captured', () => {
            expect(parser.extractPlayerName("Ja'Marr Chase 70 Yd pass from Joe Burrow"))
                .toBe("Ja'Marr Chase");
            expect(parser.extractPlayerName('J.J. Russell 23 Yd Return of Blocked Punt (Chase McLaughlin Kick)'))
                .toBe('J.J. Russell');
        });

        test('compound play prose is stripped — only the scorer remains (HOU wk 15 2025)', () => {
            expect(parser.extractPlayerName(
                'C.J. Stroud Aborted Snap C.J. Stroud Fumble Woody Marks 1 Yd Fumble Recovery (Chad Ryland Kick)'
            )).toBe('Woody Marks');
        });
    });

    describe('laterals and special teams', () => {
        test('BUF week 13 2024: lateral touchdown is skipped (no individual fantasy points)', () => {
            const boxscore = loadBoxscore('boxscore_20241201_SF@BUF');
            const plays = parser.parseScoringPlays(boxscore, 'BUF', 'SF');

            const lateral = plays.find(p => p.originalText.toLowerCase().includes('lateral'));
            expect(lateral).toBeDefined();
            // categorized as null: no TD type credited, so no fantasy points awarded
            expect(lateral.playType).toBeNull();
            expect(parser.isDefensivePlayType(lateral.playType)).toBe(false);
        });

        test('regular punt return is special teams, not defensive', () => {
            const text = 'Marcus Jones 84 Yd Punt Return (Kicker Kick)';
            expect(parser.categorizePlayType(text.toLowerCase(), text))
                .toBe('special_teams_punt_return_td');
        });

        test('regular kick return is special teams, not defensive', () => {
            const text = 'KaVontae Turpin 99 Yd Kickoff Return (Kicker Kick)';
            expect(parser.categorizePlayType(text.toLowerCase(), text))
                .toBe('special_teams_kick_return_td');
        });
    });

    describe('non-defensive plays never leak into defensive breakdowns', () => {
        test('field goals, runs and passes produce zero defensive TDs', () => {
            const boxscore = loadBoxscore('boxscore_20241229_CAR@TB');
            const plays = parser.parseScoringPlays(boxscore, 'TB', 'CAR');

            // CAR only had passing TDs in this game
            const breakdown = parser.getDefensiveTouchdownBreakdown(plays, 'CAR');
            expect(breakdown.def_int_return_tds).toBe(0);
            expect(breakdown.def_fumble_return_tds).toBe(0);
            expect(breakdown.def_blocked_return_tds).toBe(0);
            expect(breakdown.safeties).toBe(0);
        });
    });

    describe('malformed boxscores', () => {
        test('boxscore with no scoring play fields yields zero plays (detected by health check 6)', () => {
            const plays = parser.parseScoringPlays({ gameID: 'x', somethingElse: true }, 'CHI', 'TEN');
            expect(plays).toEqual([]);
        });

        test('scoringPlays with garbage entries does not crash and skips unparseable plays', () => {
            const boxscore = {
                scoringPlays: [
                    null,
                    {},
                    { score: 12345 },
                    { score: 'Jonathan Owens 21 Yd Return of Blocked Punt (Kick)' , team: 'CHI' }
                ]
            };
            const plays = parser.parseScoringPlays(boxscore, 'CHI', 'TEN');
            expect(plays.length).toBe(1);
            expect(plays[0].playType).toBe('defensive_blocked_return_td');
        });

        test('extractScoringPlays returns [] for non-array scoring fields', () => {
            expect(parser.extractScoringPlays({ scoringPlays: 'not-an-array' })).toEqual([]);
            expect(parser.extractScoringPlays({})).toEqual([]);
        });
    });
});

describe('2026 rule fixes are season-gated (server/config/scoringRulesets.js)', () => {
    const { rulesFor } = require('../../server/config/scoringRulesets');
    let parser;
    const R2026 = rulesFor(2026);
    const R2025 = rulesFor(2025);
    const cat = (text, rules) => parser.categorizePlayType(text.toLowerCase(), text, rules);

    beforeEach(() => { parser = new ScoringPlayParserService(); });

    // Real Tank01 texts that the legacy rule (needs the word "return") dropped as 'other'
    const DAVIS = 'Blocked Kick Recovered by Jordan Davis (PHI) Joshua Karty Missed 44 Yd FG Blocked ';
    const KNEELAND = 'Blocked punt recovered by Marshawn Kneeland in end zone (Brandon Aubrey kick)';
    const OLADEJO = 'Rigoberto Sanchez Punt Blocked by Julius Chestnut returned 14 yards for a Touchdown by Oluwafemi Oladejo';
    const HOLANI = 'George Holani Recovered Kickoff in End Zone for a Touchdown (Jason Myers Kick)';

    test('PHI wk3 2025: blocked FG "Recovered by" is a defensive TD from 2026, legacy stays other', () => {
        expect(cat(DAVIS, R2026)).toBe('defensive_blocked_return_td');
        expect(cat(DAVIS, R2025)).toBe('other');
        expect(cat(DAVIS, {})).toBe('other');
    });

    test('DAL wk9 2025: blocked punt recovered in end zone is a defensive TD from 2026, legacy stays other', () => {
        expect(cat(KNEELAND, R2026)).toBe('defensive_blocked_return_td');
        expect(cat(KNEELAND, R2025)).toBe('other');
    });

    test('TEN wk6 2026: punt-block touchdown wording credits DEF_TEN, never an individual return TD', () => {
        const equivalentWithoutReturn = 'Rigoberto Sanchez Punt Blocked by Julius Chestnut for a Touchdown by Oluwafemi Oladejo';
        for (const text of [OLADEJO, equivalentWithoutReturn]) {
            const box = { scoringPlays: [{ score: text, team: 'TEN', scoreType: 'TD' }] };
            const plays = parser.parseScoringPlays(box, 'IND', 'TEN', { season: 2026 });
            expect(plays[0].playType).toBe('defensive_blocked_return_td');
            expect(parser.getDefensiveTouchdownBreakdown(plays, 'TEN').def_blocked_return_tds).toBe(1);
            expect(parser.getSpecialTeamsTouchdowns(plays)).toEqual([]);
        }
    });

    test('TEN wk6 2026 production record: "Punt Blk\'d Kick Blocked by" with scoreType TD is a DEF_TEN blocked-kick TD', () => {
        // Exact Tank01 scoring record: no "return", "recover" or "touchdown" word anywhere.
        const PRODUCTION = "Rigoberto Sanchez Punt Blk'd Kick Blocked by Julius Chestnut (Joey Slye Kick)";
        const box = { scoringPlays: [{ score: PRODUCTION, team: 'TEN', scoreType: 'TD' }] };
        const plays = parser.parseScoringPlays(box, 'IND', 'TEN', { season: 2026 });
        expect(plays).toHaveLength(1);
        expect(plays[0].playType).toBe('defensive_blocked_return_td');
        expect(plays[0].scoringTeam).toBe('TEN');
        expect(parser.getDefensiveTouchdownBreakdown(plays, 'TEN').def_blocked_return_tds).toBe(1);
        expect(parser.getDefensiveTouchdownBreakdown(plays, 'IND').def_blocked_return_tds).toBe(0);
        expect(parser.getSpecialTeamsTouchdowns(plays)).toEqual([]);

        // Blessed seasons and a forgotten season argument keep the legacy reading.
        for (const season of [2025, 2024, undefined]) {
            const legacy = parser.parseScoringPlays(box, 'IND', 'TEN', { season });
            expect(legacy[0].playType).toBe('other');
            expect(parser.getDefensiveTouchdownBreakdown(legacy, 'TEN').def_blocked_return_tds).toBe(0);
        }
    });

    test('a bare blocked-kick phrase without TD evidence stays other under 2026 rules (scoreType TD is the evidence)', () => {
        const BARE = "Rigoberto Sanchez Punt Blk'd Kick Blocked by Julius Chestnut (Joey Slye Kick)";
        expect(cat(BARE, R2026)).toBe('other');
        expect(parser.categorizePlayType(BARE.toLowerCase(), BARE, R2026, { scoreType: 'FG' })).toBe('other');
        expect(parser.categorizePlayType(BARE.toLowerCase(), BARE, R2026, { scoreType: 'TD' })).toBe('defensive_blocked_return_td');
        for (const record of [{ score: BARE, team: 'TEN' }, { score: BARE, team: 'TEN', scoreType: 'FG' }]) {
            const plays = parser.parseScoringPlays({ scoringPlays: [record] }, 'IND', 'TEN', { season: 2026 });
            expect(plays[0].playType).toBe('other');
            expect(parser.getDefensiveTouchdownBreakdown(plays, 'TEN').def_blocked_return_tds).toBe(0);
        }
    });

    test('scoreType TD never turns an offensive TD with an unparenthesized blocked try into a blocked-kick TD', () => {
        for (const t of ['Saquon Barkley 2 Yd Rush Jake Elliott Kick Blocked',
            'A.J. Brown 19 Yd pass from Jalen Hurts Jake Elliott Kick Blocked',
            'Jalen Hurts 1 Yd Run Jake Elliott Kick Blocked']) {
            const plays = parser.parseScoringPlays({ scoringPlays: [{ score: t, team: 'PHI', scoreType: 'TD' }] }, 'PHI', 'CAR', { season: 2026 });
            expect(plays[0].playType).not.toBe('defensive_blocked_return_td');
            expect(parser.getDefensiveTouchdownBreakdown(plays, 'PHI').def_blocked_return_tds).toBe(0);
        }
    });

    test('extractScoreType normalizes the Tank01 label and tolerates plays without one', () => {
        expect(parser.extractScoreType({ scoreType: 'TD' })).toBe('TD');
        expect(parser.extractScoreType({ scoreType: ' td ' })).toBe('TD');
        expect(parser.extractScoreType({ scoreType: '' })).toBeNull();
        expect(parser.extractScoreType({})).toBeNull();
        expect(parser.extractScoreType('plain string play')).toBeNull();
        expect(parser.extractScoreType(null)).toBeNull();
    });

    test('TEN wk6 2026 wording is season-gated: legacy rules leave the no-"return" variant as other', () => {
        const equivalentWithoutReturn = 'Rigoberto Sanchez Punt Blocked by Julius Chestnut for a Touchdown by Oluwafemi Oladejo';
        expect(cat(equivalentWithoutReturn, R2025)).toBe('other');
        expect(cat(equivalentWithoutReturn, {})).toBe('other');
        // "returned" already satisfied the legacy rule, so blessed seasons are unchanged either way
        expect(cat(OLADEJO, R2025)).toBe('defensive_blocked_return_td');
    });

    test('blocked-kick touchdown wording reads the main play only, never the try-for-point parenthetical', () => {
        for (const t of ['Saquon Barkley 2 Yd Rush for a Touchdown (Jake Elliott Kick Blocked)',
            'A.J. Brown 19 Yd pass from Jalen Hurts for a Touchdown (Jake Elliott PAT Blocked)']) {
            expect(cat(t, R2026)).not.toBe('defensive_blocked_return_td');
            const plays = parser.parseScoringPlays({ scoringPlays: [{ score: t, team: 'PHI', scoreType: 'TD' }] }, 'PHI', 'CAR', { season: 2026 });
            expect(parser.getDefensiveTouchdownBreakdown(plays, 'PHI').def_blocked_return_tds).toBe(0);
        }
    });

    test('a blocked punt that ends in a safety stays a safety under 2026 rules (2 pts, no blocked-return TD)', () => {
        const t = 'Rigoberto Sanchez Punt Blocked by Julius Chestnut recovered in end zone for a Safety';
        expect(cat(t, R2026)).toBe('safety');
        const plays = parser.parseScoringPlays({ scoringPlays: [{ score: t, team: 'TEN', scoreType: 'SF' }] }, 'IND', 'TEN', { season: 2026 });
        const b = parser.getDefensiveTouchdownBreakdown(plays, 'TEN');
        expect(b.safeties).toBe(1);
        expect(b.def_blocked_return_tds).toBe(0);
    });

    test('ordinary punt and kickoff returns stay 20-point special-teams returns under 2026 rules', () => {
        const pr = 'Marcus Jones 87 Yd Punt Return (Andy Borregales Kick)';
        const kr = 'Antonio Gibson 90 Yd Kickoff Return (Andy Borregales Kick)';
        expect(cat(pr, R2026)).toBe('special_teams_punt_return_td');
        expect(cat(kr, R2026)).toBe('special_teams_kick_return_td');
        const box = { scoringPlays: [{ score: pr, team: 'NE', scoreType: 'TD' }, { score: kr, team: 'NE', scoreType: 'TD' }] };
        const plays = parser.parseScoringPlays(box, 'NE', 'CAR', { season: 2026 });
        expect(parser.getDefensiveTouchdownBreakdown(plays, 'NE').def_blocked_return_tds).toBe(0);
        expect(parser.getSpecialTeamsTouchdowns(plays).map(p => p.playType))
            .toEqual(['special_teams_punt_return_td', 'special_teams_kick_return_td']);
    });

    test('SEA wk2 2025: kickoff recovered by the kicking team is a special-teams takeaway from 2026', () => {
        expect(cat(HOLANI, R2026)).toBe('defensive_fumble_return_td');
        expect(cat(HOLANI, R2025)).toBe('other');
    });

    test('blocked-kick rule still never fires on a blocked PAT after a normal TD', () => {
        for (const t of ['Kyren Williams 8 Yd pass from Matthew Stafford (Joshua Karty PAT blocked)', 'Cam Skattebo 13 Yd Rush (Jamie Gillan PAT blocked)']) {
            expect(cat(t, R2026)).not.toBe('defensive_blocked_return_td');
        }
    });

    test('legacy "Return of Blocked Punt" phrasing works under both rule sets', () => {
        const t = 'Jonathan Owens 21 Yd Return of Blocked Punt';
        expect(cat(t, R2026)).toBe('defensive_blocked_return_td');
        expect(cat(t, R2025)).toBe('defensive_blocked_return_td');
    });

    test('parseScoringPlays passes the season through; omitting it means legacy rules', () => {
        const box = { scoringPlays: [{ score: KNEELAND, team: 'DAL', scoreType: 'TD' }] };
        expect(parser.parseScoringPlays(box, 'DAL', 'ARI', { season: 2026 })[0].playType).toBe('defensive_blocked_return_td');
        expect(parser.parseScoringPlays(box, 'DAL', 'ARI', { season: 2025 })[0].playType).toBe('other');
        expect(parser.parseScoringPlays(box, 'DAL', 'ARI')[0].playType).toBe('other');
    });

    test('DEF breakdown gains the blocked-kick TD only under 2026 rules', () => {
        const box = { scoringPlays: [{ score: DAVIS, team: 'PHI', scoreType: 'TD' }] };
        const b2026 = parser.getDefensiveTouchdownBreakdown(parser.parseScoringPlays(box, 'PHI', 'LAR', { season: 2026 }), 'PHI');
        const b2025 = parser.getDefensiveTouchdownBreakdown(parser.parseScoringPlays(box, 'PHI', 'LAR', { season: 2025 }), 'PHI');
        expect(b2026.def_blocked_return_tds).toBe(1);
        expect(b2025.def_blocked_return_tds).toBe(0);
    });

    describe('extractTwoPointConversion', () => {
        test('Tank01 truncated text (WAS wk2 2025) still yields passer and receiver', () => {
            const t = 'Deebo Samuel 10 Yd pass from Jayden Daniels Deebo Samuel 10 Yd pass from Jayden Daniels (Jayden Daniels Pass to Luke McCaffrey for Two-Point Conversio';
            expect(parser.extractTwoPointConversion(t)).toEqual({ passer: 'Jayden Daniels', receiver: 'Luke McCaffrey' });
        });
        test('full ESPN/Tank01 wording, pass and run', () => {
            expect(parser.extractTwoPointConversion('Aaron Jones Sr. 27 Yd pass from J.J. McCarthy (J.J. McCarthy Pass to Adam Thielen for Two-Point Conversion)'))
                .toEqual({ passer: 'J.J. McCarthy', receiver: 'Adam Thielen' });
            expect(parser.extractTwoPointConversion('Drake Maye 1 Yd Rush (Rhamondre Stevenson Run for Two-Point Conversion)'))
                .toEqual({ rusher: 'Rhamondre Stevenson' });
        });
        test('failed attempts, kicks and plain TDs yield null', () => {
            for (const t of ['Justin Jefferson 13 Yd pass from J.J. McCarthy (Two-Point Pass Conversion Failed)',
                'Woody Marks 4 Yd pass from C.J. Stroud (Ka\'imi Fairbairn Kick)',
                'Jahmyr Gibbs 5 Yd Rush (Two-Point Run Conversion Failed)',
                'Eddy Pineiro 37 Yd Field Goal', '', null]) {
                expect(parser.extractTwoPointConversion(t)).toBeNull();
            }
        });
        test('parsed plays carry twoPoint regardless of season (data only)', () => {
            const box = { scoringPlays: [{ score: 'Drake Maye 1 Yd Rush (Rhamondre Stevenson Run for Two-Point Conversion)', team: 'NE', scoreType: 'TD' }] };
            expect(parser.parseScoringPlays(box, 'NE', 'MIA', { season: 2025 })[0].twoPoint).toEqual({ rusher: 'Rhamondre Stevenson' });
        });
    });
});

describe('scoring team stays the RAW Tank01 code (regression: WAS defensive TDs dropped 2026-09-13)', () => {
    // Keep source evidence unchanged, but accept both raw boxscore codes
    // and canonical database codes at the defensive-credit boundary.
    test('a Tank01 play tagged WSH credits the WSH defense when the boxscore says WSH', () => {
        const parser = new ScoringPlayParserService();
        const box = { scoringPlays: [{ score: 'Bobby Wagner 5 Yd Interception Return (Austin Seibert Kick)', team: 'WSH', scoreType: 'TD', playerIDs: [] }] };
        const plays = parser.parseScoringPlays(box, 'WSH', 'CAR', { season: 2024 });
        expect(plays[0].scoringTeam).toBe('WSH');
        expect(parser.getDefensiveTouchdownBreakdown(plays, 'WSH').def_int_return_tds).toBe(1);
        expect(parser.getDefensiveTouchdownBreakdown(plays, 'WAS').def_int_return_tds).toBe(1);
    });
});
