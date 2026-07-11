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
