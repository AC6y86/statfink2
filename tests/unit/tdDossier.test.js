/**
 * TD dossier (scripts/lib/tdDossier.js) — deterministic award-class rule
 * against real, trimmed fixtures plus synthetic edge cases.
 *
 * Fixtures: tests/fixtures/doublecheck/td/<Tank01 gameID>.json, one per game:
 *   { gameId, season, week, espnEventId, homeTeam, awayTeam, tank01Body, espnSummary,
 *     playerPositions, nflPlayers, dbRows }
 *
 * Extraction (all READ-ONLY; no DB writes, no server):
 *   Tank01 boxscore:  sqlite3 -readonly -noheader fantasy_football.db \
 *       "select response_data from tank01_cache where cache_key='boxscore_<gameID>'"
 *     -> keep body.{gameID,gameStatus,home,away,homePts,awayPts,teamIDHome,teamIDAway,scoringPlays,DST}
 *        plus body.playerStats[<id>] ONLY for ids referenced in scoringPlays[].playerIDs,
 *        each trimmed to {playerID,longName,team,teamAbv,Defense,Rushing}.
 *   Player positions:  sqlite3 -readonly -noheader fantasy_football.db \
 *       "select response_data from tank01_cache where cache_key='playerList'"
 *     -> body[] filtered to the same ids: { <playerID>: {name: longName, pos, team} }.
 *   nfl_players:  sqlite3 -readonly -json fantasy_football.db \
 *       "select player_id,name,position,team from nfl_players where player_id in (<ids>)"
 *     -> { <player_id>: {name, position, team} }  (defensive players are absent by design).
 *   Live DB rows:  sqlite3 -readonly -json fantasy_football.db \
 *       "select player_id,week,season,game_id,passing_tds,rushing_tds,receiving_tds,kick_return_tds,
 *               punt_return_tds,def_int_return_tds,def_fumble_return_tds,def_blocked_return_tds,safeties,
 *               two_point_conversions_pass,two_point_conversions_run,two_point_conversions_rec,fantasy_points
 *        from player_stats where game_id='<gameID>' and (player_id in (<ids>) or player_id in ('DEF_<home>','DEF_<away>'))"
 *   ESPN summary:  curl -s 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=<eventId>'
 *     (sleep 2 s between calls; event ids from
 *      https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=<season>&seasontype=2&week=<week>)
 *     -> keep header.competitions[0].{status.type,competitors[{id,homeAway,team.abbreviation,score}]},
 *        scoringPlays[{id,type.text,text,awayScore,homeScore,period.number,clock.displayValue,team.abbreviation,scoringType.name}],
 *        drives.previous[] restricted to drives containing a scoringPlay, each as
 *        {team.abbreviation,result,plays[{id,type.text,text,scoringPlay,isTurnover,period.number,clock.displayValue,start.team,end.team,awayScore,homeScore}]}.
 *
 * Games / ESPN event ids:
 *   20251214_ARI@HOU / 401772903  (2025 wk15) Woody Marks aborted-snap recovery  -> OFF_RECOVERY
 *   20250914_NE@MIA  / 401772728  (2025 wk2)  Gibson 90 KR, M. Washington 74 PR  -> RETURN_20_KICK / RETURN_20_PUNT, Stevenson 2-pt run
 *   20250908_MIN@CHI / 401772810  (2025 wk1)  Nahshon Wright 74 INT TD           -> DEF_8_INT; McCarthy->Thielen 2-pt pass; failed 2-pt
 *   20250928_CAR@NE  / 401772847  (2025 wk4)  Marcus Jones 87 PR (CB)            -> RETURN_20_PUNT + non-draftable exemption
 *   20240908_TEN@CHI / 401671719  (2024 wk1)  Jonathan Owens blocked-punt return -> DEF_8_BLOCKED; Stevenson INT TD + Williams->Swift 2-pt
 *   20251005_TEN@ARI / 401772747  (2025 wk5)  Tyler Lockett end-zone recovery    -> OFF_RECOVERY
 *   20251019_NE@TEN  / 401772755  (2025 wk7)  Chaisson sack-fumble TD            -> DEF_8_FUMBLE
 */

const fs = require('fs');
const path = require('path');
const {
    buildGameDossier, classifyPlay, matchPlays, extractTwoPoint, dbCreditFor, renderGameMarkdown,
    normClock, periodNumber, LEGEND
} = require('../../scripts/lib/tdDossier');

const FIXTURE_DIR = path.join(__dirname, '../fixtures/doublecheck/td');

function loadFixture(gameId) {
    return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${gameId}.json`), 'utf8'));
}

function clone(o) {
    return JSON.parse(JSON.stringify(o));
}

function findPlay(dossier, re) {
    const p = dossier.plays.find(x => x.tank01 && re.test(x.tank01.text));
    if (!p) throw new Error(`no play matching ${re}`);
    return p;
}

function credits(play) {
    return play.expectedCredits.map(c => `${c.player_id}.${c.column}+${c.delta}`).sort();
}

describe('tdDossier fixtures are small and self-contained', () => {
    test('every fixture is < 200 KB', () => {
        for (const f of fs.readdirSync(FIXTURE_DIR)) {
            expect(fs.statSync(path.join(FIXTURE_DIR, f)).size).toBeLessThan(200 * 1024);
        }
    });
});

describe('case 1: 2025 wk15 ARI@HOU — Woody Marks aborted-snap recovery', () => {
    const fx = loadFixture('20251214_ARI@HOU');
    const d = buildGameDossier(fx);

    test('Marks recovery is OFF_RECOVERY (+rushing_tds Marks, DEF_HOU 0) despite ESPN "Fumble Return Touchdown"', () => {
        const p = findPlay(d, /Woody Marks 1 Yd Fumble Recovery/);
        expect(p.kind).toBe('TD');
        expect(p.period).toBe('Q1');
        expect(p.clock).toBe('6:12');
        expect(p.scoringTeam).toBe('HOU');
        expect(p.espn.typeText).toBe('Fumble Return Touchdown');
        expect(p.espn.drive.isTurnover).toBe(false);
        expect(p.espn.drive.team).toBe('HOU');
        expect(p.espn.drive.startTeam).toBe('HOU');
        expect(p.espn.drive.endTeam).toBe('HOU');
        expect(p.awardClass).toBe('OFF_RECOVERY');
        expect(credits(p)).toEqual(['4429059.rushing_tds+1']);
        expect(p.expectedCredits[0].note).toMatch(/teammate's fumble \(C\.J\. Stroud\)/);
        expect(p.reasons.some(r => /ESPN label advisory only/.test(r))).toBe(true);
        expect(p.dbCredit.DEF_HOU.def_fumble_return_tds).toBe(0);
        expect(p.dbCredit['4429059'].rushing_tds).toBe(1);
        expect(p.agreement).toBe(true);
    });

    test('failed 2-pt pass gives no conversion credit', () => {
        const p = findPlay(d, /Michael Wilson 11 Yd pass/);
        expect(p.awardClass).toBe('OFF_PASS');
        expect(p.twoPoint).toEqual({ pass: null, run: null, rec: null });
        expect(credits(p)).toEqual(['2578570.passing_tds+1', '4360761.receiving_tds+1']);
    });

    test('two same-kind TDs aggregate (Collins 2 receiving, Stroud 3 passing) and the whole game agrees', () => {
        expect(d.expectedTotals['4258173'].receiving_tds).toBe(2);
        expect(d.expectedTotals['4432577'].passing_tds).toBe(3);
        expect(d.dbTotals['4258173'].receiving_tds).toBe(2);
        expect(d.discrepancies).toEqual([]);
        expect(d.summary).toEqual({ tds: 7, agreed: 7, disagreed: 0, ambiguous: 0, questions: 0 });
        expect(d.unmatched).toEqual({ tank01Only: [], espnOnly: [] });
        expect(d.plays.every(p => p.kind !== 'TD' || p.agreement === true)).toBe(true);
    });

    test('FGs are NOT_TD with agreement null', () => {
        const p = findPlay(d, /Fairbairn 30 Yd Field Goal/);
        expect(p.kind).toBe('FG');
        expect(p.awardClass).toBe('NOT_TD');
        expect(p.agreement).toBeNull();
    });
});

describe('case 2: 2025 wk2 NE@MIA — Gibson KR TD, Malik Washington PR TD', () => {
    const fx = loadFixture('20250914_NE@MIA');
    const d = buildGameDossier(fx);

    test('Gibson 90-yd kickoff return -> RETURN_20_KICK', () => {
        const p = findPlay(d, /Antonio Gibson 90 Yd Kickoff Return/);
        expect(p.awardClass).toBe('RETURN_20_KICK');
        expect(credits(p)).toEqual(['4360294.kick_return_tds+1']);
        expect(p.exemptions).toEqual([]);
        expect(p.dbCredit.DEF_NE.def_fumble_return_tds).toBe(0);
        expect(p.agreement).toBe(true);
    });

    test('Malik Washington 74-yd punt return -> RETURN_20_PUNT', () => {
        const p = findPlay(d, /Malik Washington 74 Yd Punt Return/);
        expect(p.awardClass).toBe('RETURN_20_PUNT');
        expect(credits(p)).toEqual(['4569603.punt_return_tds+1']);
        expect(p.agreement).toBe(true);
    });

    test('Stevenson 2-pt run credited', () => {
        const p = findPlay(d, /Drake Maye 6 Yd Rush/);
        expect(p.awardClass).toBe('OFF_RUSH');
        expect(p.twoPoint).toEqual({ pass: null, run: '4569173', rec: null });
        expect(credits(p)).toEqual(['4431452.rushing_tds+1', '4569173.two_point_conversions_run+1']);
        expect(p.agreement).toBe(true);
    });

    test('whole game agrees with the live rows', () => {
        expect(d.discrepancies).toEqual([]);
        expect(d.summary.disagreed).toBe(0);
        expect(d.summary.ambiguous).toBe(0);
    });
});

describe('case 3: 2025 wk1 MIN@CHI — Nahshon Wright INT TD + 2-pt conversions', () => {
    const fx = loadFixture('20250908_MIN@CHI');
    const d = buildGameDossier(fx);

    test('Wright 74-yd interception return -> DEF_8_INT for DEF_CHI', () => {
        const p = findPlay(d, /Nahshon Wright 74 Yd Interception Return/);
        expect(p.awardClass).toBe('DEF_8_INT');
        expect(p.espn.drive.isTurnover).toBe(true);
        expect(p.espn.drive.startTeam).toBe('MIN');
        expect(p.espn.drive.endTeam).toBe('CHI');
        expect(credits(p)).toEqual(['DEF_CHI.def_int_return_tds+1']);
        expect(p.dbCredit.DEF_CHI.def_int_return_tds).toBe(1);
        expect(p.agreement).toBe(true);
    });

    test('McCarthy -> Thielen 2-pt pass credited to both', () => {
        const p = findPlay(d, /Aaron Jones Sr\. 27 Yd pass/);
        expect(p.awardClass).toBe('OFF_PASS');
        expect(p.twoPoint).toEqual({ pass: '4433970', run: null, rec: '16460' });
        expect(credits(p)).toEqual([
            '16460.two_point_conversions_rec+1', '3042519.receiving_tds+1',
            '4433970.passing_tds+1', '4433970.two_point_conversions_pass+1'
        ]);
        expect(p.dbCredit['16460'].two_point_conversions_rec).toBe(1);
        expect(p.agreement).toBe(true);
    });

    test('failed 2-pt -> no credit', () => {
        const p = findPlay(d, /Justin Jefferson 13 Yd pass/);
        expect(p.twoPoint).toEqual({ pass: null, run: null, rec: null });
        expect(p.reasons.some(r => /2-pt attempt failed/.test(r))).toBe(true);
    });

    test('whole game agrees', () => {
        expect(d.discrepancies).toEqual([]);
        expect(d.summary).toEqual({ tds: 6, agreed: 6, disagreed: 0, ambiguous: 0, questions: 0 });
    });
});

describe('case 4: 2025 wk4 CAR@NE — Marcus Jones (CB) punt return TD exemption', () => {
    const fx = loadFixture('20250928_CAR@NE');
    const d = buildGameDossier(fx);

    test('RETURN_20_PUNT with the non-draftable exemption and no expected credits', () => {
        const p = findPlay(d, /Marcus Jones 87 Yd Punt Return/);
        expect(fx.nflPlayers['4241720']).toBeUndefined();
        expect(fx.playerPositions['4241720'].pos).toBe('CB');
        expect(p.awardClass).toBe('RETURN_20_PUNT');
        expect(p.expectedCredits).toEqual([]);
        expect(p.exemptions).toEqual(['non-draftable returner Marcus Jones (CB) — credited to nobody by design']);
        expect(p.dbCredit.DEF_NE.def_fumble_return_tds).toBe(0);
        expect(p.dbCredit.DEF_NE.def_blocked_return_tds).toBe(0);
        expect(p.agreement).toBe(true);
    });

    test('whole game agrees', () => {
        expect(d.discrepancies).toEqual([]);
        expect(d.summary.disagreed).toBe(0);
    });
});

describe('case 5: 2024 wk1 TEN@CHI — Owens blocked-punt return', () => {
    const fx = loadFixture('20240908_TEN@CHI');
    const d = buildGameDossier(fx);

    test('blocked punt return -> DEF_8_BLOCKED for DEF_CHI (never RETURN_20)', () => {
        const p = findPlay(d, /Jonathan Owens 21 Yd Return of Blocked Punt/);
        expect(p.awardClass).toBe('DEF_8_BLOCKED');
        expect(credits(p)).toEqual(['DEF_CHI.def_blocked_return_tds+1']);
        expect(p.dbCredit.DEF_CHI.def_blocked_return_tds).toBe(1);
        expect(p.agreement).toBe(true);
    });

    test('Stevenson INT TD with Williams -> Swift 2-pt pass', () => {
        const p = findPlay(d, /Tyrique Stevenson 43 Yd Interception Return/);
        expect(p.awardClass).toBe('DEF_8_INT');
        expect(p.twoPoint).toEqual({ pass: '4431611', run: null, rec: '4259545' });
        expect(credits(p)).toEqual([
            '4259545.two_point_conversions_rec+1', '4431611.two_point_conversions_pass+1', 'DEF_CHI.def_int_return_tds+1'
        ]);
        expect(p.agreement).toBe(true);
    });

    test('2024 "Yd Run" text form is OFF_RUSH', () => {
        const p = findPlay(d, /Tony Pollard 26 Yd Run/);
        expect(p.awardClass).toBe('OFF_RUSH');
        expect(credits(p)).toEqual(['3916148.rushing_tds+1']);
    });

    test('whole game agrees (DEF_CHI 16 = INT + blocked)', () => {
        expect(d.expectedTotals.DEF_CHI).toMatchObject({ def_int_return_tds: 1, def_blocked_return_tds: 1, def_fumble_return_tds: 0 });
        expect(d.discrepancies).toEqual([]);
        expect(d.summary).toEqual({ tds: 4, agreed: 4, disagreed: 0, ambiguous: 0, questions: 0 });
    });
});

describe('case 6a: 2025 wk5 TEN@ARI — Lockett end-zone recovery', () => {
    const fx = loadFixture('20251005_TEN@ARI');
    const d = buildGameDossier(fx);

    test('OFF_RECOVERY: +rushing_tds Lockett, DEF_TEN 0', () => {
        const p = findPlay(d, /Tyler Lockett 0 Yd Fumble Recovery/);
        expect(p.espn.typeText).toBe('Fumble Return Touchdown');
        expect(p.espn.drive.isTurnover).toBe(false);
        expect(p.espn.drive.team).toBe('TEN');
        expect(p.awardClass).toBe('OFF_RECOVERY');
        expect(credits(p)).toEqual(['2577327.rushing_tds+1']);
        expect(p.expectedCredits[0].note).toMatch(/teammate's fumble/);
        expect(p.dbCredit.DEF_TEN.def_fumble_return_tds).toBe(0);
        expect(p.dbCredit['2577327'].rushing_tds).toBe(1);
        expect(p.agreement).toBe(true);
        expect(d.discrepancies).toEqual([]);
    });
});

describe('case 6b: 2025 wk7 NE@TEN — Chaisson sack-fumble TD', () => {
    const fx = loadFixture('20251019_NE@TEN');
    const d = buildGameDossier(fx);

    test('DEF_8_FUMBLE for DEF_NE', () => {
        const p = findPlay(d, /Chaisson 4 Yd Fumble Recovery/);
        expect(p.espn.drive.isTurnover).toBe(true);
        expect(p.espn.drive.team).toBe('TEN');
        expect(p.espn.drive.startTeam).toBe('TEN');
        expect(p.espn.drive.endTeam).toBe('NE');
        expect(p.awardClass).toBe('DEF_8_FUMBLE');
        expect(credits(p)).toEqual(['DEF_NE.def_fumble_return_tds+1']);
        expect(p.dbCredit.DEF_NE.def_fumble_return_tds).toBe(1);
        expect(p.agreement).toBe(true);
        expect(d.discrepancies).toEqual([]);
        expect(d.summary.disagreed).toBe(0);
    });
});

describe('disagreement detection (pre-correction shape)', () => {
    test('Lockett credited to DEF_TEN instead of the player is flagged', () => {
        const fx = clone(loadFixture('20251005_TEN@ARI'));
        for (const r of fx.dbRows) {
            if (r.player_id === '2577327') r.rushing_tds = 0;
            if (r.player_id === 'DEF_TEN') r.def_fumble_return_tds = 1;
        }
        const d = buildGameDossier(fx);
        const p = findPlay(d, /Tyler Lockett 0 Yd Fumble Recovery/);
        expect(p.agreement).toBe(false);
        expect(d.summary.disagreed).toBe(1);
        expect(d.discrepancies).toEqual(expect.arrayContaining([
            expect.objectContaining({ player_id: '2577327', column: 'rushing_tds', expected: 1, actual: 0, plays: [p.idx] }),
            expect.objectContaining({ player_id: 'DEF_TEN', column: 'def_fumble_return_tds', expected: 0, actual: 1 })
        ]));
    });

    test('missing return TD credit is flagged', () => {
        const fx = clone(loadFixture('20250914_NE@MIA'));
        for (const r of fx.dbRows) if (r.player_id === '4360294') r.kick_return_tds = 0;
        const d = buildGameDossier(fx);
        expect(findPlay(d, /Gibson 90 Yd Kickoff Return/).agreement).toBe(false);
        expect(d.discrepancies).toEqual([expect.objectContaining({ player_id: '4360294', name: 'Antonio Gibson', column: 'kick_return_tds', expected: 1, actual: 0 })]);
    });

    test('no dbRows -> agreement null everywhere, no discrepancies', () => {
        const fx = clone(loadFixture('20250914_NE@MIA'));
        fx.dbRows = [];
        const d = buildGameDossier(fx);
        expect(d.plays.every(p => p.agreement === null)).toBe(true);
        expect(d.discrepancies).toEqual([]);
    });
});

describe('synthetic: lateral -> AMBIGUOUS', () => {
    test('a return with a lateral is AMBIGUOUS with agreement null', () => {
        const fx = clone(loadFixture('20250914_NE@MIA'));
        const tp = fx.tank01Body.scoringPlays.find(p => /Antonio Gibson 90 Yd Kickoff Return/.test(p.score));
        tp.score = 'Antonio Gibson 90 Yd Kickoff Return (Lateral from Rhamondre Stevenson) (Andy Borregales Kick)';
        const d = buildGameDossier(fx);
        const p = findPlay(d, /Lateral/);
        expect(p.awardClass).toBe('AMBIGUOUS');
        expect(p.expectedCredits).toEqual([]);
        expect(p.agreement).toBeNull();
        expect(p.reasons.some(r => /lateral/i.test(r))).toBe(true);
        expect(d.summary.ambiguous).toBe(1);
        // The stored kick_return_tds for Gibson now exceeds the (zero) expectation; flagged with the ambiguity note.
        const disc = d.discrepancies.find(x => x.player_id === '4360294' && x.column === 'kick_return_tds');
        expect(disc).toBeDefined();
        expect(disc.note).toMatch(new RegExp(`ambiguous play\\(s\\) ${p.idx}`));
    });
});

describe('synthetic: ESPN missing', () => {
    test('espnSummary null: fumble recovery is AMBIGUOUS, plain pass/rush/INT/return still classify from Tank01 text', () => {
        const fx = clone(loadFixture('20251214_ARI@HOU'));
        fx.espnSummary = null;
        const d = buildGameDossier(fx);
        const marks = findPlay(d, /Woody Marks 1 Yd Fumble Recovery/);
        expect(marks.espn).toBeNull();
        expect(marks.awardClass).toBe('AMBIGUOUS');
        expect(marks.agreement).toBeNull();
        expect(marks.reasons.some(r => /ESPN summary unavailable/.test(r))).toBe(true);
        expect(marks.reasons.some(r => /no ESPN possession data/.test(r))).toBe(true);
        const pass = findPlay(d, /Nico Collins 57 Yd pass/);
        expect(pass.awardClass).toBe('OFF_PASS');
        expect(pass.agreement).toBe(true);
        expect(d.unmatched).toEqual({ tank01Only: [], espnOnly: [] });
        expect(d.game.espnAvailable).toBe(false);

        const mia = clone(loadFixture('20250914_NE@MIA'));
        mia.espnSummary = null;
        const d2 = buildGameDossier(mia);
        expect(findPlay(d2, /Gibson 90 Yd Kickoff Return/).awardClass).toBe('RETURN_20_KICK');
        const chi = clone(loadFixture('20250908_MIN@CHI'));
        chi.espnSummary = null;
        expect(findPlay(buildGameDossier(chi), /Nahshon Wright/).awardClass).toBe('DEF_8_INT');
    });

    test('ESPN present but a Tank01 TD has no ESPN match -> AMBIGUOUS and listed in unmatched.tank01Only', () => {
        const fx = clone(loadFixture('20251214_ARI@HOU'));
        const tp = fx.tank01Body.scoringPlays.find(p => /Woody Marks/.test(p.score));
        tp.scoreTime = '5:55';
        tp.homeScore = '99';
        const d = buildGameDossier(fx);
        const p = findPlay(d, /Woody Marks/);
        expect(p.espn).toBeNull();
        expect(p.awardClass).toBe('AMBIGUOUS');
        expect(p.reasons.some(r => /no ESPN scoring play matched/.test(r))).toBe(true);
        expect(d.unmatched.tank01Only).toEqual([p.idx]);
    });

    test('ESPN-only scoring play is included with tank01:null and AMBIGUOUS', () => {
        const fx = clone(loadFixture('20251214_ARI@HOU'));
        fx.tank01Body.scoringPlays = fx.tank01Body.scoringPlays.filter(p => !/Woody Marks/.test(p.score));
        const d = buildGameDossier(fx);
        const p = d.plays.find(x => x.tank01 === null);
        expect(p).toBeDefined();
        expect(p.espn.text).toMatch(/Woody Marks/);
        expect(p.awardClass).toBe('AMBIGUOUS');
        expect(p.period).toBe('Q1');
        expect(p.clock).toBe('6:12');
        expect(d.unmatched.espnOnly).toEqual([{ typeText: 'Fumble Return Touchdown', text: expect.stringMatching(/Woody Marks/) }]);
    });
});

describe('synthetic: CAR@PHI 2026 wk6 — the same scoring play stamped one second apart across feeds', () => {
    const YOUNG = '4685720', TREMBLE = '4372780', FITZGERALD = '4568263';
    const EARLY = 'Tommy Tremble 12 Yd pass from Bryce Young (Ryan Fitzgerald Kick)';
    const LATE = 'Tommy Tremble 19 Yd pass from Bryce Young (Ryan Fitzgerald PAT Failed)';
    const ids = [YOUNG, TREMBLE, FITZGERALD];
    function fixture() {
        return {
            gameId: '20261018_CAR@PHI', season: 2026, week: 6, homeTeam: 'PHI', awayTeam: 'CAR',
            tank01Body: {
                gameID: '20261018_CAR@PHI', gameStatus: 'Completed', home: 'PHI', away: 'CAR', homePts: '0', awayPts: '13',
                scoringPlays: [
                    { score: EARLY, scorePeriod: 'Q4', scoreTime: '11:42', team: 'CAR', scoreType: 'TD', homeScore: '0', awayScore: '7', playerIDs: ids },
                    // Tank01 stamps this play at 6:33 ...
                    { score: LATE, scorePeriod: 'Q4', scoreTime: '6:33', team: 'CAR', scoreType: 'TD', homeScore: '0', awayScore: '13', playerIDs: ids }
                ],
                playerStats: {
                    [YOUNG]: { playerID: YOUNG, longName: 'Bryce Young', team: 'CAR', teamAbv: 'CAR' },
                    [TREMBLE]: { playerID: TREMBLE, longName: 'Tommy Tremble', team: 'CAR', teamAbv: 'CAR' },
                    [FITZGERALD]: { playerID: FITZGERALD, longName: 'Ryan Fitzgerald', team: 'CAR', teamAbv: 'CAR' }
                }
            },
            espnSummary: {
                header: { competitions: [{ status: { type: { name: 'STATUS_FINAL', completed: true } }, competitors: [
                    { id: '21', homeAway: 'home', team: { abbreviation: 'PHI' }, score: '0' },
                    { id: '29', homeAway: 'away', team: { abbreviation: 'CAR' }, score: '13' }] }] },
                scoringPlays: [
                    { id: 'early', type: { text: 'Passing Touchdown' }, text: EARLY, period: { number: 4 }, clock: { displayValue: '11:42' }, team: { abbreviation: 'CAR' }, homeScore: 0, awayScore: 7, scoringType: { name: 'touchdown' } },
                    // ... and ESPN at 6:34: same text, team and period. No running score on
                    // this ESPN play, so the period+score fallback cannot rescue it (the
                    // production shape: the pre-fix matcher left both feeds' plays unmatched).
                    { id: 'late', type: { text: 'Passing Touchdown' }, text: LATE, period: { number: 4 }, clock: { displayValue: '6:34' }, team: { abbreviation: 'CAR' }, scoringType: { name: 'touchdown' } }
                ],
                drives: { previous: [] }
            },
            playerPositions: {
                [YOUNG]: { name: 'Bryce Young', pos: 'QB', team: 'CAR' },
                [TREMBLE]: { name: 'Tommy Tremble', pos: 'TE', team: 'CAR' },
                [FITZGERALD]: { name: 'Ryan Fitzgerald', pos: 'PK', team: 'CAR' }
            },
            nflPlayers: {
                [YOUNG]: { name: 'Bryce Young', position: 'QB', team: 'CAR' },
                [TREMBLE]: { name: 'Tommy Tremble', position: 'TE', team: 'CAR' },
                [FITZGERALD]: { name: 'Ryan Fitzgerald', position: 'K', team: 'CAR' }
            },
            dbRows: [
                { player_id: YOUNG, passing_tds: 2, rushing_tds: 0, receiving_tds: 0, kick_return_tds: 0, punt_return_tds: 0 },
                { player_id: TREMBLE, passing_tds: 0, rushing_tds: 0, receiving_tds: 2, kick_return_tds: 0, punt_return_tds: 0 },
                { player_id: 'DEF_CAR', def_int_return_tds: 0, def_fumble_return_tds: 0, def_blocked_return_tds: 0, safeties: 0 },
                { player_id: 'DEF_PHI', def_int_return_tds: 0, def_fumble_return_tds: 0, def_blocked_return_tds: 0, safeties: 0 }
            ]
        };
    }

    test('the 19-yard TD is ONE late OFF_PASS play, not a Tank01-only + ESPN-only AMBIGUOUS pair', () => {
        const d = buildGameDossier(fixture());
        expect(d.plays.map(p => `${p.period} ${p.clock} ${p.scoringTeam} ${p.awardClass}`))
            .toEqual(['Q4 11:42 CAR OFF_PASS', 'Q4 6:33 CAR OFF_PASS']);
        expect(d.unmatched).toEqual({ tank01Only: [], espnOnly: [] });
        const late = findPlay(d, /Tremble 19 Yd/);
        expect(late.espn.text).toBe(LATE);
        expect(late.reasons).toContain('ESPN match by period+clock±1s+team+text');
        expect(late.questionId).toBeNull();
        expect(d.summary).toMatchObject({ tds: 2, ambiguous: 0, questions: 0, disagreed: 0 });
    });

    test('both Carolina passing TDs survive: Young 2 passing, Tremble 2 receiving, both defenses 0', () => {
        const d = buildGameDossier(fixture());
        const passCredits = [`${TREMBLE}.receiving_tds+1`, `${YOUNG}.passing_tds+1`];
        expect(credits(findPlay(d, /Tremble 12 Yd/))).toEqual(passCredits);
        expect(credits(findPlay(d, /Tremble 19 Yd/))).toEqual(passCredits);
        expect(d.expectedTotals[YOUNG].passing_tds).toBe(2);
        expect(d.expectedTotals[TREMBLE].receiving_tds).toBe(2);
        for (const def of ['DEF_CAR', 'DEF_PHI']) {
            const t = d.expectedTotals[def];
            expect(t.def_int_return_tds + t.def_fumble_return_tds + t.def_blocked_return_tds + t.safeties).toBe(0);
        }
        expect(d.discrepancies).toEqual([]);
        expect(d.plays.every(p => p.agreement === true)).toBe(true);
    });

    test('the one-second tier is tried before the period+score fallback when both would apply', () => {
        const fx = fixture();
        Object.assign(fx.espnSummary.scoringPlays[1], { homeScore: 0, awayScore: 13 });
        const d = buildGameDossier(fx);
        expect(findPlay(d, /Tremble 19 Yd/).reasons).toContain('ESPN match by period+clock±1s+team+text');
        expect(d.unmatched).toEqual({ tank01Only: [], espnOnly: [] });
    });

    test('a one-second offset with DIFFERENT text is still two distinct plays', () => {
        const fx = fixture();
        const espnLate = fx.espnSummary.scoringPlays[1];
        espnLate.text = 'Tommy Tremble 9 Yd pass from Bryce Young (Ryan Fitzgerald PAT Failed)';
        const d = buildGameDossier(fx);
        expect(d.plays).toHaveLength(3);
        expect(d.unmatched.tank01Only).toHaveLength(1);
        expect(d.unmatched.espnOnly).toEqual([{ typeText: 'Passing Touchdown', text: espnLate.text }]);
        expect(findPlay(d, /Tremble 19 Yd/).awardClass).toBe('AMBIGUOUS');
    });
});

describe('matchPlays', () => {
    test('tolerates clock format differences and maps OT to ESPN period 5', () => {
        const tank01 = [
            { scorePeriod: 'Q1', scoreTime: '06:12', team: 'HOU', scoreType: 'TD', score: 'x', homeScore: '7', awayScore: '0' },
            { scorePeriod: 'OT', scoreTime: '3:05', team: 'WSH', scoreType: 'FG', score: 'y', homeScore: '10', awayScore: '7' }
        ];
        const espn = [
            { id: 'a', period: { number: 1 }, clock: { displayValue: '6:12' }, team: { abbreviation: 'HOU' }, homeScore: 7, awayScore: 0 },
            { id: 'b', period: { number: 5 }, clock: { displayValue: '03:05' }, team: { abbreviation: 'WSH' }, homeScore: 10, awayScore: 7 },
            { id: 'c', period: { number: 2 }, clock: { displayValue: '1:00' }, team: { abbreviation: 'HOU' }, homeScore: 14, awayScore: 0 }
        ];
        const drives = [{ drive: { team: { abbreviation: 'HOU' } }, play: { id: 'a', scoringPlay: true, period: { number: 1 }, clock: { displayValue: '6:12' } } }];
        const r = matchPlays(tank01, espn, drives);
        expect(r.matched[0].espn.id).toBe('a');
        expect(r.matched[0].drive.play.id).toBe('a');
        expect(r.matched[0].matchedBy).toBe('period+clock+team');
        expect(r.matched[1].espn.id).toBe('b');
        expect(r.espnOnly.map(e => e.id)).toEqual(['c']);
        expect(normClock('06:12')).toBe('6:12');
        expect(periodNumber('OT')).toBe(5);
    });

    test('falls back to score-after when the clock differs by a second', () => {
        const tank01 = [{ scorePeriod: 'Q3', scoreTime: '0:33', team: 'ARI', scoreType: 'TD', score: 'x', homeScore: '30', awayScore: '14' }];
        const espn = [{ id: 'a', period: { number: 3 }, clock: { displayValue: '0:34' }, team: { abbreviation: 'ARI' }, homeScore: 30, awayScore: 14 }];
        const r = matchPlays(tank01, espn, []);
        expect(r.matched[0].espn.id).toBe('a');
        expect(r.matched[0].matchedBy).toBe('period+score');
    });

    test('CAR@PHI: matches equivalent TD text at a one-second clock offset without merging the earlier TD', () => {
        const tank01 = [
            { scorePeriod: 'Q4', scoreTime: '11:42', team: 'CAR', scoreType: 'TD', score: 'Tommy Tremble 12 Yd pass from Bryce Young', homeScore: '24', awayScore: '13' },
            { scorePeriod: 'Q4', scoreTime: '6:33', team: 'CAR', scoreType: 'TD', score: 'Tommy Tremble 19 Yd pass from Bryce Young', homeScore: '24', awayScore: '19' }
        ];
        const espn = [
            { id: 'early', text: 'Tommy Tremble 12 Yd pass from Bryce Young', period: { number: 4 }, clock: { displayValue: '11:42' }, team: { abbreviation: 'CAR' }, homeScore: 24, awayScore: 13 },
            // Deliberately omit matching running scores: text/team/period plus the
            // narrow clock tolerance must identify this play, not period+score.
            { id: 'late', text: 'Tommy Tremble 19 yd PASS from Bryce Young', period: { number: 4 }, clock: { displayValue: '6:34' }, team: { abbreviation: 'CAR' } }
        ];
        const r = matchPlays(tank01, espn, []);
        expect(r.matched.map(m => m.espn && m.espn.id)).toEqual(['early', 'late']);
        expect(r.matched.map(m => m.matchedBy)).toEqual(['period+clock+team', 'period+clock±1s+team+text']);
        expect(r.espnOnly).toEqual([]);
    });

    test('one-second tolerance does not merge different same-team scoring plays', () => {
        const tank01 = [{ scorePeriod: 'Q4', scoreTime: '6:33', team: 'CAR', scoreType: 'TD', score: 'Tommy Tremble 12 Yd pass from Bryce Young' }];
        const espn = [{ id: 'late', text: 'Tommy Tremble 19 Yd pass from Bryce Young', period: { number: 4 }, clock: { displayValue: '6:34' }, team: { abbreviation: 'CAR' } }];
        const r = matchPlays(tank01, espn, []);
        expect(r.matched[0].espn).toBeNull();
        expect(r.espnOnly.map(p => p.id)).toEqual(['late']);
    });
});

describe('extractTwoPoint', () => {
    const resolver = (n) => ({ 'j.j. mccarthy': '1', 'adam thielen': '2', 'rhamondre stevenson': '3' }[n.toLowerCase()] || null);
    test('pass', () => {
        expect(extractTwoPoint('Aaron Jones Sr. 27 Yd pass from J.J. McCarthy (J.J. McCarthy Pass to Adam Thielen for Two-Point Conversion)', resolver))
            .toMatchObject({ success: true, pass: '1', rec: '2', run: null, passName: 'J.J. McCarthy', recName: 'Adam Thielen' });
    });
    test('run', () => {
        expect(extractTwoPoint('Drake Maye 6 Yd Rush (Rhamondre Stevenson Run for Two-Point Conversion)', resolver))
            .toMatchObject({ success: true, run: '3', pass: null, rec: null });
    });
    test('failed and absent', () => {
        expect(extractTwoPoint('Michael Wilson 11 Yd pass from Jacoby Brissett (Two-Point Pass Conversion Failed)', resolver)).toMatchObject({ success: false, pass: null, run: null, rec: null });
        expect(extractTwoPoint('Nico Collins 4 Yd pass from C.J. Stroud (Ka\'imi Fairbairn Kick)', resolver)).toBeNull();
    });
});

describe('classifyPlay (pure)', () => {
    test('safety -> SAFETY_2 for the scoring team defense', () => {
        const r = classifyPlay({ kind: 'SAFETY', scoringTeam: 'DEN', defendingTeam: 'KC', tank01: { text: 'Safety', players: [] }, espn: null, espnAvailable: false });
        expect(r.awardClass).toBe('SAFETY_2');
        expect(r.expectedCredits).toEqual([{ player_id: 'DEF_DEN', column: 'safeties', delta: 1 }]);
    });
    test('blocked FG return with isTurnover=false is still DEF_8_BLOCKED', () => {
        const r = classifyPlay({
            kind: 'TD', scoringTeam: 'SEA', defendingTeam: 'ARI', espnAvailable: true, espnScoringTeam: 'SEA', period: 'Q2', espnPeriod: 'Q2',
            tank01: { text: 'Coby Bryant 69 Yd Return of Blocked Field Goal (Jason Myers Kick)', scoreDetails: '9 plays, 40 yards', players: [{ id: '9', name: 'Coby Bryant', pos: 'CB', roles: ['returner'], draftable: false }] },
            espn: { typeText: 'Blocked Field Goal Touchdown', text: 'Coby Bryant 69 Yd Return of Blocked Field Goal', drive: { team: 'ARI', isTurnover: false, startTeam: 'ARI', endTeam: 'SEA', playText: 'field goal is BLOCKED' } }
        });
        expect(r.awardClass).toBe('DEF_8_BLOCKED');
        expect(r.expectedCredits).toEqual([{ player_id: 'DEF_SEA', column: 'def_blocked_return_tds', delta: 1 }]);
        expect(r.exemptions).toEqual([]);
    });
    test('muffed punt recovered by coverage team (isTurnover=true) -> DEF_8_FUMBLE, not RETURN_20', () => {
        const r = classifyPlay({
            kind: 'TD', scoringTeam: 'NE', defendingTeam: 'MIA', espnAvailable: true, espnScoringTeam: 'NE', period: 'Q4', espnPeriod: 'Q4',
            tank01: { text: 'Brenden Schooler 12 Yd Fumble Recovery (Muffed Punt Return) (Andy Borregales Kick)', scoreDetails: '4 plays, 9 yards', players: [] },
            espn: { typeText: 'Fumble Return Touchdown', text: 'x', drive: { team: 'NE', isTurnover: true, startTeam: 'NE', endTeam: 'NE', playText: 'punt MUFFS, RECOVERED by NE' } }
        });
        expect(r.awardClass).toBe('DEF_8_FUMBLE');
        expect(r.reasons.some(x => /muffed/.test(x))).toBe(true);
    });
    test('team disagreement -> AMBIGUOUS', () => {
        const r = classifyPlay({
            kind: 'TD', scoringTeam: 'NE', defendingTeam: 'MIA', espnAvailable: true, espnScoringTeam: 'MIA', period: 'Q1', espnPeriod: 'Q1',
            tank01: { text: 'A 5 Yd Rush', players: [] }, espn: { typeText: 'Rushing Touchdown', text: 'x', drive: null }
        });
        expect(r.awardClass).toBe('AMBIGUOUS');
        expect(r.reasons[0]).toMatch(/Tank01 says NE scored, ESPN says MIA/);
    });
});

describe('dbCreditFor', () => {
    test('shows only class-relevant columns for involved players plus DST columns for both defenses', () => {
        const fx = loadFixture('20250914_NE@MIA');
        const d = buildGameDossier(fx);
        const p = findPlay(d, /Malik Washington 74 Yd Punt Return/);
        const c = dbCreditFor(p, fx.dbRows, { homeTeam: 'MIA', awayTeam: 'NE' });
        expect(Object.keys(c['4569603']).sort()).toEqual(['kick_return_tds', 'punt_return_tds']);
        expect(c['4569603'].punt_return_tds).toBe(1);
        expect(Object.keys(c.DEF_MIA).sort()).toEqual(['def_blocked_return_tds', 'def_fumble_return_tds', 'def_int_return_tds', 'safeties']);
        expect(c.DEF_NE).toBeDefined();
        expect(c['4243371']).toBeUndefined(); // kicker not listed
    });
});

describe('renderGameMarkdown', () => {
    test('contains header, legend, and a play-N anchor + heading for every play', () => {
        const fx = loadFixture('20251214_ARI@HOU');
        const d = buildGameDossier(fx);
        const md = renderGameMarkdown(d);
        expect(md).toMatch(/^# Game 20251214_ARI@HOU — ARI @ HOU/);
        expect(md).toMatch(/Final score ARI 20 – HOU 40/);
        expect(md).toContain('## Award-class legend');
        expect(LEGEND).toHaveLength(6);
        for (const l of LEGEND) expect(md).toContain(l);
        for (const p of d.plays) {
            expect(md).toContain(`<a id="play-${p.idx}"></a>`);
            expect(md).toContain(`### Play ${p.idx} — ${p.period} ${p.clock} ${p.scoringTeam} ${p.kind}`);
        }
        expect(md).toContain('### Play 3 — Q1 6:12 HOU TD');
        expect(md).toContain('**OFF_RECOVERY**');
        expect(md).toMatch(/Gamebook: "B\.Fisher reported in as eligible\.\s+C\.Stroud FUMBLES \(Aborted\)/);
        expect(md).toContain('| DB credited |');
        expect(md).toContain('| DEF_HOU |');
    });

    test('renders exemptions, discrepancies and unmatched sections', () => {
        const fx = clone(loadFixture('20250928_CAR@NE'));
        for (const r of fx.dbRows) if (r.player_id === 'DEF_NE') r.def_fumble_return_tds = 1;
        const d = buildGameDossier(fx);
        const md = renderGameMarkdown(d);
        expect(md).toContain('Exemptions: non-draftable returner Marcus Jones (CB)');
        expect(md).toContain('## Discrepancies');
        expect(md).toMatch(/\| DEF_NE \| DEF_NE \| def_fumble_return_tds \| 0 \| 1 \|/);
    });
});

describe('independence', () => {
    test('tdDossier does not require any server/services scoring module', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../scripts/lib/tdDossier.js'), 'utf8');
        expect(src).not.toMatch(/require\(['"][^'"]*server\/services/);
    });
});

describe('tdDossier classify: laterals and kickoff recoveries', () => {
    const { classifyPlay } = require('../../scripts/lib/tdDossier');
    const base = (over) => ({ kind: 'TD', scoringTeam: 'HOU', defendingTeam: 'IND', ...over });

    test('a lateral in the gamebook prose of a takeaway does not make the play ambiguous (IND@HOU wk18 2025)', () => {
        const r = classifyPlay(base({
            tank01: { text: 'Tommy Togiai 17 Yd Fumble Recovery', players: [{ id: '4361366', name: 'Tommy Togiai', pos: 'DT' }] },
            espn: { typeText: 'Fumble Return Touchdown', text: 'Tommy Togiai 17 Yd Fumble Recovery',
                drive: { team: 'IND', result: 'FUMBLE RETURN TD', isTurnover: true, startTeam: 'IND', endTeam: 'HOU',
                    playText: 'R.Leonard pass short middle to J.Downs. Lateral to M.Pittman. Lateral to R.Leonard. FUMBLES, RECOVERED by HST-T.Togiai at IND 17. T.Togiai for 17 yards, TOUCHDOWN.' } }
        }));
        expect(r.awardClass).toBe('DEF_8_FUMBLE');
        expect(r.expectedCredits).toEqual([expect.objectContaining({ player_id: 'DEF_HOU', column: 'def_fumble_return_tds', delta: 1 })]);
    });

    test('a lateral in the scoring play text itself is still ambiguous', () => {
        const r = classifyPlay(base({ tank01: { text: 'Amari Cooper 5 Yd Lateral from Josh Allen', players: [] }, espn: null }));
        expect(r.awardClass).toBe('AMBIGUOUS');
    });

    test('a kickoff recovered by the kicking team in the end zone is a special-teams takeaway (SEA wk2 2025, Holani)', () => {
        const r = classifyPlay(base({ scoringTeam: 'SEA', defendingTeam: 'PIT',
            tank01: { text: 'George Holani Recovered Kickoff in End Zone for a Touchdown (Jason Myers Kick)', players: [{ id: '4', name: 'George Holani', pos: 'RB' }] },
            espn: { typeText: 'Fumble Return Touchdown', text: 'George Holani Recovered Kickoff in End Zone for a Touchdown (Jason Myers Kick)', drive: null } }));
        expect(r.awardClass).toBe('DEF_8_FUMBLE');
        expect(r.expectedCredits[0]).toEqual(expect.objectContaining({ player_id: 'DEF_SEA', column: 'def_fumble_return_tds' }));
    });
});

/* ------------------------------------------------------------------------- *
 * Three-vote possession, gamebook parsing, score reconciliation, defensive
 * scores (2026-09: the deterministic pass decides everything it can; what it
 * cannot decide becomes a question).
 * ------------------------------------------------------------------------- */

describe('parseGamebook', () => {
    const { parseGamebook, gamebookTeam, GAMEBOOK_TEAM_CODES } = require('../../scripts/lib/tdDossier');

    test('maps NFL gamebook team codes to canonical league codes', () => {
        expect(gamebookTeam('HST')).toBe('HOU');
        expect(gamebookTeam('ARZ')).toBe('ARI');
        expect(gamebookTeam('BLT')).toBe('BAL');
        expect(gamebookTeam('CLV')).toBe('CLE');
        expect(gamebookTeam('LA')).toBe('LAR');
        expect(gamebookTeam('SD')).toBe('LAC');
        expect(gamebookTeam('WSH')).toBe('WAS');
        expect(gamebookTeam('JAC')).toBe('JAX');
        expect(gamebookTeam('LV')).toBe('LV');
        expect(gamebookTeam('NE')).toBe('NE');
        expect(gamebookTeam('phi')).toBe('PHI');
        expect(gamebookTeam(null)).toBeNull();
        expect(Object.keys(GAMEBOOK_TEAM_CODES)).toEqual(expect.arrayContaining(['ARZ', 'BLT', 'CLV', 'HST', 'LA']));
    });

    test('Togiai: opponent fumble RECOVERED by HST- (upper-case = change of possession)', () => {
        const gb = parseGamebook('R.Leonard pass short middle to J.Downs. Lateral to M.Pittman. Lateral to R.Leonard. FUMBLES, RECOVERED by HST-T.Togiai at IND 17. T.Togiai for 17 yards, TOUCHDOWN.');
        expect(gb).toMatchObject({ recoveredBy: 'HOU', recovered: true, recoveredUpper: true, recoveredPlayer: 'T.Togiai', interceptedBy: null, intercepted: false, muffed: false, blocked: false, lateral: true, fumbled: true, touchdownBy: null, touchdownPlayer: 'T.Togiai' });
    });

    test('Marks: own aborted snap "recovered by HST-" (lower-case = same possession)', () => {
        const gb = parseGamebook('B.Fisher reported in as eligible.  C.Stroud FUMBLES (Aborted) at ARZ 2, recovered by HST-W.Marks at ARZ 7. W.Marks for 7 yards, TOUCHDOWN.');
        expect(gb).toMatchObject({ recoveredBy: 'HOU', recovered: true, recoveredUpper: false, recoveredPlayer: 'W.Marks', lateral: false, fumbled: true, touchdownPlayer: 'W.Marks' });
    });

    test('Owens: BLOCKED punt RECOVERED by CHI-', () => {
        const gb = parseGamebook('R.Stonehouse punt is BLOCKED by D.Hardy, Center-M.Cox, RECOVERED by CHI-J.Owens at TEN 21. J.Owens for 21 yards, TOUCHDOWN.');
        expect(gb).toMatchObject({ recoveredBy: 'CHI', recoveredUpper: true, blocked: true, intercepted: false, touchdownPlayer: 'J.Owens' });
    });

    test('Davis (PHI wk3): blocked FG recovered in the end zone', () => {
        const gb = parseGamebook('J.Karty 44 yard field goal is BLOCKED (J.Davis), Center-A.Brewer, Holder-E.Evans, RECOVERED by PHI-J.Davis at PHI 0. J.Davis for 0 yards, TOUCHDOWN.');
        expect(gb).toMatchObject({ recoveredBy: 'PHI', recoveredUpper: true, blocked: true });
    });

    test('Wright INT with no team prefix; Kneeland-style ARZ/BLT/CLV prefixes', () => {
        expect(parseGamebook('(Shotgun) J.McCarthy pass short left intended for J.Jefferson INTERCEPTED by N.Wright at CHI 26. N.Wright for 74 yards, TOUCHDOWN.'))
            .toMatchObject({ intercepted: true, interceptedBy: null, interceptedPlayer: 'N.Wright', recovered: false, touchdownPlayer: 'N.Wright' });
        expect(parseGamebook('K.Murray pass INTERCEPTED by BLT-K.Hamilton at ARZ 30. K.Hamilton for 30 yards, TOUCHDOWN.')).toMatchObject({ intercepted: true, interceptedBy: 'BAL' });
        expect(parseGamebook('D.Watson FUMBLES, RECOVERED by ARZ-B.Baker at CLV 12. B.Baker for 12 yards, TOUCHDOWN.')).toMatchObject({ recoveredBy: 'ARI', recoveredUpper: true });
        expect(parseGamebook('D.Watson FUMBLES (Aborted), recovered by CLV-N.Chubb at CLV 1. CLV-N.Chubb for 1 yard, TOUCHDOWN.')).toMatchObject({ recoveredBy: 'CLE', recoveredUpper: false, touchdownBy: 'CLE', touchdownPlayer: 'N.Chubb' });
    });

    test('muffed punt recovered by the coverage team', () => {
        const gb = parseGamebook('B.Baringer punts 45 yards to MIA 20, Center-J.Ashby. M.Washington MUFFS catch, RECOVERED by NE-B.Schooler at MIA 12. B.Schooler for 12 yards, TOUCHDOWN.');
        expect(gb).toMatchObject({ muffed: true, recoveredBy: 'NE', recoveredUpper: true });
    });

    test('empty / plain offensive prose has no possession facts', () => {
        expect(parseGamebook('')).toMatchObject({ recoveredBy: null, recovered: false, interceptedBy: null, intercepted: false, muffed: false, blocked: false, lateral: false });
        expect(parseGamebook('(Shotgun) C.Stroud pass short middle to N.Collins for 57 yards, TOUCHDOWN.')).toMatchObject({ recovered: false, intercepted: false, touchdownPlayer: 'N.Collins' });
    });
});

describe('votes: drive / gamebook / text', () => {
    const { driveVote, gamebookVote, textVote, voteConsensus, parseGamebook } = require('../../scripts/lib/tdDossier');

    test('driveVote', () => {
        expect(driveVote(null, 'HOU')).toBeNull();
        expect(driveVote({ team: 'IND', isTurnover: true }, 'HOU')).toBe('takeaway');
        expect(driveVote({ team: 'HOU', isTurnover: false }, 'HOU')).toBe('same');
        expect(driveVote({ team: 'NE', isTurnover: false }, 'MIA')).toBeNull(); // punting team's drive, no turnover flag: no opinion
    });

    test('gamebookVote uses the RECOVERED/recovered convention and the recovering team', () => {
        expect(gamebookVote(parseGamebook('FUMBLES, RECOVERED by HST-T.Togiai at IND 17. T.Togiai for 17 yards, TOUCHDOWN.'), 'HOU')).toBe('takeaway');
        expect(gamebookVote(parseGamebook('C.Stroud FUMBLES (Aborted) at ARZ 2, recovered by HST-W.Marks at ARZ 7. W.Marks for 7 yards, TOUCHDOWN.'), 'HOU')).toBe('same');
        expect(gamebookVote(parseGamebook('pass INTERCEPTED by N.Wright at CHI 26. N.Wright for 74 yards, TOUCHDOWN.'), 'CHI')).toBe('takeaway');
        expect(gamebookVote(parseGamebook('FUMBLES, RECOVERED by HST-T.Togiai at IND 17.'), 'IND')).toBeNull(); // someone else recovered last
        expect(gamebookVote(parseGamebook('C.Stroud pass to N.Collins for 57 yards, TOUCHDOWN.'), 'HOU')).toBeNull();
        expect(gamebookVote(null, 'HOU')).toBeNull();
    });

    test('textVote', () => {
        expect(textVote('Nahshon Wright 74 Yd Interception Return')).toBe('takeaway');
        expect(textVote('Jonathan Owens 21 Yd Return of Blocked Punt')).toBe('blocked');
        expect(textVote('George Holani Recovered Kickoff in End Zone for a Touchdown')).toBe('takeaway');
        expect(textVote('Brenden Schooler 12 Yd Fumble Recovery (Muffed Punt Return)')).toBe('takeaway');
        expect(textVote('Antonio Gibson 90 Yd Kickoff Return')).toBe('return');
        expect(textVote('Malik Washington 74 Yd Punt Return')).toBe('return');
        expect(textVote('Nico Collins 57 Yd pass from C.J. Stroud')).toBe('same');
        expect(textVote('Tony Pollard 26 Yd Run')).toBe('same');
        expect(textVote('Drake Maye 6 Yd Rush')).toBe('same');
        expect(textVote('Woody Marks 1 Yd Fumble Recovery')).toBeNull();
        expect(textVote('')).toBeNull();
    });

    test('voteConsensus: return == same possession, blocked is not a possession vote, nulls abstain', () => {
        expect(voteConsensus({ drive: 'same', gamebook: null, text: 'return' })).toEqual({ agree: true, consensus: 'same', cast: 2 });
        expect(voteConsensus({ drive: 'takeaway', gamebook: 'takeaway', text: 'blocked' })).toEqual({ agree: true, consensus: 'takeaway', cast: 3 });
        expect(voteConsensus({ drive: 'takeaway', gamebook: 'same', text: null })).toEqual({ agree: false, consensus: null, cast: 2 });
        expect(voteConsensus({ drive: null, gamebook: null, text: null })).toEqual({ agree: true, consensus: null, cast: 0 });
    });

    test('every fixture play carries agreeing votes and no question', () => {
        const want = {
            '20251214_ARI@HOU': [/Woody Marks 1 Yd Fumble Recovery/, { drive: 'same', gamebook: 'same', text: null }, 'OFF_RECOVERY'],
            '20251019_NE@TEN': [/Chaisson 4 Yd Fumble Recovery/, { drive: 'takeaway', gamebook: 'takeaway', text: null }, 'DEF_8_FUMBLE'],
            '20240908_TEN@CHI': [/Jonathan Owens 21 Yd Return of Blocked Punt/, { drive: 'takeaway', gamebook: 'takeaway', text: 'blocked' }, 'DEF_8_BLOCKED'],
            '20250908_MIN@CHI': [/Nahshon Wright 74 Yd Interception Return/, { drive: 'takeaway', gamebook: 'takeaway', text: 'takeaway' }, 'DEF_8_INT'],
            '20250914_NE@MIA': [/Antonio Gibson 90 Yd Kickoff Return/, { drive: 'same', gamebook: null, text: 'return' }, 'RETURN_20_KICK'],
            '20250928_CAR@NE': [/Marcus Jones 87 Yd Punt Return/, { drive: null, gamebook: null, text: 'return' }, 'RETURN_20_PUNT'],
            '20251005_TEN@ARI': [/Tyler Lockett 0 Yd Fumble Recovery/, { drive: 'same', gamebook: null, text: null }, 'OFF_RECOVERY']
        };
        for (const [gameId, [re, votes, cls]] of Object.entries(want)) {
            const d = buildGameDossier(loadFixture(gameId));
            const p = findPlay(d, re);
            expect([gameId, p.votes]).toEqual([gameId, votes]);
            expect(p.votesAgree).toBe(true);
            expect(p.awardClass).toBe(cls);
            expect(p.questionId).toBeNull();
            expect(d.summary.questions).toBe(0);
            expect(d.plays.filter(x => x.kind === 'TD').every(x => x.votesAgree === true)).toBe(true);
        }
        const chi = buildGameDossier(loadFixture('20250914_NE@MIA'));
        expect(findPlay(chi, /Malik Washington 74 Yd Punt Return/).votes).toEqual({ drive: null, gamebook: null, text: 'return' });
        expect(findPlay(chi, /Mack Hollins 8 Yd pass/).votes).toEqual({ drive: 'same', gamebook: null, text: 'same' });
    });

    test('a vote disagreement makes the play AMBIGUOUS with a question (Marks with a flipped isTurnover)', () => {
        const fx = clone(loadFixture('20251214_ARI@HOU'));
        for (const dr of fx.espnSummary.drives.previous) for (const p of dr.plays) if (/W\.Marks for 7 yards/.test(p.text)) p.isTurnover = true;
        const d = buildGameDossier(fx);
        const p = findPlay(d, /Woody Marks 1 Yd Fumble Recovery/);
        expect(p.votes).toEqual({ drive: 'takeaway', gamebook: 'same', text: null });
        expect(p.votesAgree).toBe(false);
        expect(p.awardClass).toBe('AMBIGUOUS');
        expect(p.expectedCredits).toEqual([]);
        expect(p.questionId).toBe('2025-wk15-20251214_ARI@HOU-play-3');
        expect(p.reasons.some(r => /votes: drive=takeaway gamebook=same text=- \(DISAGREE\)/.test(r))).toBe(true);
        expect(d.summary.questions).toBe(1);
        const ds = d.defensiveScores.find(x => x.playIdx === p.idx);
        expect(ds).toMatchObject({ kind: 'TD', scoringTeam: 'HOU', awardClass: 'AMBIGUOUS', votesAgree: false, questionId: p.questionId, agreement: null });
        expect(ds.creditedTo).toEqual([{ player_id: '4429059', column: 'rushing_tds' }]);
    });

    test('Togiai (IND@HOU wk18): drive + gamebook agree on a takeaway despite the laterals', () => {
        const r = classifyPlay({
            kind: 'TD', scoringTeam: 'HOU', defendingTeam: 'IND', espnAvailable: true, espnScoringTeam: 'HOU', period: 'Q2', espnPeriod: 'Q2',
            tank01: { text: 'Tommy Togiai 17 Yd Fumble Recovery', players: [{ id: '4361366', name: 'Tommy Togiai', pos: 'DT' }] },
            espn: { typeText: 'Fumble Return Touchdown', text: 'Tommy Togiai 17 Yd Fumble Recovery',
                drive: { team: 'IND', result: 'FUMBLE RETURN TD', isTurnover: true, startTeam: 'IND', endTeam: 'HOU',
                    playText: 'R.Leonard pass short middle to J.Downs. Lateral to M.Pittman. Lateral to R.Leonard. FUMBLES, RECOVERED by HST-T.Togiai at IND 17. T.Togiai for 17 yards, TOUCHDOWN.' } }
        });
        expect(r.awardClass).toBe('DEF_8_FUMBLE');
        expect(r.votes).toEqual({ drive: 'takeaway', gamebook: 'takeaway', text: null });
        expect(r.votesAgree).toBe(true);
        expect(r.gamebook.recoveredBy).toBe('HOU');
    });

    test('a fumble recovery with no vote at all is AMBIGUOUS; the gamebook alone can decide it', () => {
        const base = {
            kind: 'TD', scoringTeam: 'HOU', defendingTeam: 'ARI', espnAvailable: true, espnScoringTeam: 'HOU', period: 'Q1', espnPeriod: 'Q1',
            tank01: { text: 'Woody Marks 1 Yd Fumble Recovery', players: [{ id: '4429059', name: 'Woody Marks', pos: 'RB', roles: ['recoverer'], draftable: true, fumbles: 0 }] }
        };
        const none = classifyPlay({ ...base, espn: { typeText: 'Fumble Return Touchdown', text: 'Woody Marks 1 Yd Fumble Recovery', drive: null } });
        expect(none.awardClass).toBe('AMBIGUOUS');
        expect(none.votes).toEqual({ drive: null, gamebook: null, text: null });
        const gbOnly = classifyPlay({ ...base, espn: { typeText: 'Fumble Return Touchdown', text: 'x', drive: { team: 'ARI', isTurnover: false, playText: 'C.Stroud FUMBLES (Aborted) at ARZ 2, recovered by HST-W.Marks at ARZ 7. W.Marks for 7 yards, TOUCHDOWN.' } } });
        expect(gbOnly.votes).toEqual({ drive: null, gamebook: 'same', text: null });
        expect(gbOnly.awardClass).toBe('OFF_RECOVERY');
        const gbTake = classifyPlay({ ...base, espn: { typeText: 'Fumble Return Touchdown', text: 'x', drive: { team: 'ARI', isTurnover: false, playText: 'K.Murray FUMBLES, RECOVERED by HST-W.Marks at ARZ 7. W.Marks for 7 yards, TOUCHDOWN.' } } });
        expect(gbTake.votes).toEqual({ drive: null, gamebook: 'takeaway', text: null });
        expect(gbTake.awardClass).toBe('DEF_8_FUMBLE');
    });
});

describe('reconcileScore', () => {
    const { reconcileScore, tryPoints } = require('../../scripts/lib/tdDossier');

    test('tryPoints reads the try-for-point parenthetical', () => {
        expect(tryPoints("Nico Collins 57 Yd pass from C.J. Stroud (Ka'imi Fairbairn Kick)")).toBe(1);
        expect(tryPoints('Mack Hollins 8 Yd pass from Drake Maye (Andy Borregales PAT Failed)')).toBe(0);
        expect(tryPoints('Jacory Croskey-Merritt 1 Yd Rush (Drew Stevens PAT blocked)')).toBe(0);
        expect(tryPoints('Drake Maye 6 Yd Rush (Rhamondre Stevenson Run for Two-Point Conversion)')).toBe(2);
        expect(tryPoints('Michael Wilson 11 Yd pass from Jacoby Brissett (Two-Point Pass Conversion Failed)')).toBe(0);
        expect(tryPoints('Will McDonald 50 Yd Touchdown Return')).toBe(0);
        expect(tryPoints('Blocked Kick Recovered by Will McDonald IV (NYJ) Will McDonald 50 Yd Touchdown Return')).toBe(0);
    });

    test('synthetic game: TD 6 + try, FG 3, safety 2 per source; the text tally OR the running score after the last play must reach the final', () => {
        const teams = { home: 'HOU', away: 'ARI' };
        const plays = [
            { kind: 'TD', scoringTeam: 'HOU', tank01: { text: 'A 5 Yd Rush (K Kick)', scoreAfter: { home: 7, away: 0 } }, espn: { text: 'A 5 Yd Rush (K Kick)', team: 'HOU', scoreAfter: { home: 7, away: 0 } } },
            { kind: 'FG', scoringTeam: 'ARI', tank01: { text: 'B 40 Yd Field Goal', scoreAfter: { home: 7, away: 3 } }, espn: { text: 'B 40 Yd Field Goal', team: 'ARI', scoreAfter: { home: 7, away: 3 } } },
            { kind: 'SAFETY', scoringTeam: 'HOU', tank01: { text: 'Safety', scoreAfter: { home: 9, away: 3 } }, espn: { text: 'Safety', team: 'HOU', scoreAfter: { home: 9, away: 3 } } },
            { kind: 'TD', scoringTeam: 'ARI', tank01: { text: 'C 2 Yd pass from D (Two-Point Pass Conversion Failed)', scoreAfter: { home: 9, away: 9 } }, espn: { text: 'C 2 Yd pass from D (Two-Point Pass Conversion Failed)', team: 'ARI', scoreAfter: { home: 9, away: 9 } } },
            { kind: 'TD', scoringTeam: 'ARI', tank01: { text: 'E 9 Yd Rush (F Run for Two-Point Conversion)', scoreAfter: { home: 9, away: 17 } }, espn: null },
            { kind: '2PT', scoringTeam: 'HOU', tank01: { text: 'G Defensive PAT Conversion', scoreAfter: { home: 11, away: 17 } }, espn: null },
            // try text missing on both sources; the running score says 7
            { kind: 'TD', scoringTeam: 'HOU', tank01: { text: 'H 50 Yd Touchdown Return', scoreAfter: { home: 18, away: 17 } }, espn: { text: 'H 50 Yd Touchdown Return', team: 'HOU', scoreAfter: { home: 18, away: 17 } } }
        ];
        const sc = reconcileScore(plays, 18, 17, teams);
        expect(sc.tank01).toEqual({ home: 17, away: 17, plays: 7, lastReported: { home: 18, away: 17 }, okText: false, okReported: true, ok: true });
        expect(sc.espn).toEqual({ home: 15, away: 9, plays: 5, lastReported: { home: 18, away: 17 }, okText: false, okReported: true, ok: true });
        expect(sc.final).toEqual({ home: 18, away: 17 });
        // no running score: the text tally alone decides
        const bare = plays.map(p => ({ ...p, tank01: p.tank01 ? { text: p.tank01.text } : null, espn: null }));
        expect(reconcileScore(bare, 18, 17, teams).tank01).toMatchObject({ home: 17, away: 17, lastReported: null, okText: false, okReported: null, ok: false });
        expect(reconcileScore(bare, 17, 17, teams).tank01).toMatchObject({ okText: true, ok: true });
        // a play missing from the list is missing from both tallies (the 2025 wk12 shape)
        const short = plays.slice(0, -1);
        expect(reconcileScore(short, 18, 17, teams).tank01).toMatchObject({ home: 11, lastReported: { home: 11, away: 17 }, okText: false, okReported: false, ok: false });
        // unknown final / no plays -> ok null
        expect(reconcileScore(plays, null, null, teams).tank01.ok).toBeNull();
        expect(reconcileScore([], 0, 0, teams).espn.ok).toBeNull();
    });

    test('every fixture reproduces its final score from both sources; a wrong final is a mismatch', () => {
        for (const f of fs.readdirSync(FIXTURE_DIR)) {
            const fx = loadFixture(f.replace(/\.json$/, ''));
            const d = buildGameDossier(fx);
            expect([f, d.scoreCheck.tank01.ok, d.scoreCheck.espn.ok]).toEqual([f, true, true]);
            expect(d.scoreCheck.final).toEqual({ home: d.game.homeScore, away: d.game.awayScore });
            expect(d.scoreCheck.espnFinal).toEqual(d.scoreCheck.final);
            expect(d.scoreCheck.tank01.plays).toBe(d.plays.filter(p => p.tank01).length);
        }
        const fx = clone(loadFixture('20251214_ARI@HOU'));
        const d = buildGameDossier({ ...fx, finalScore: { home: 43, away: 20 } }); // as if a final FG were missing from both play lists
        expect(d.scoreCheck.final).toEqual({ home: 43, away: 20 });
        expect(d.scoreCheck.tank01).toMatchObject({ home: 40, away: 20, ok: false });
        expect(d.scoreCheck.espn.ok).toBe(false);
        // a Tank01 list short of its last play (the 2025 wk12 PHI@DAL shape)
        const short = clone(loadFixture('20251214_ARI@HOU'));
        short.tank01Body.scoringPlays = short.tank01Body.scoringPlays.slice(0, -1);
        const d2 = buildGameDossier(short);
        expect(d2.scoreCheck.tank01).toMatchObject({ home: 33, away: 20, ok: false });
        expect(d2.scoreCheck.espn.ok).toBe(true);
        expect(d2.unmatched.espnOnly).toHaveLength(1);
    });
});

describe('defensiveScores', () => {
    test('lists every takeaway / blocked kick / safety with the DB credit restricted to the play', () => {
        const chi = buildGameDossier(loadFixture('20240908_TEN@CHI'));
        expect(chi.defensiveScores.map(x => [x.playIdx, x.kind, x.awardClass, x.creditedTo])).toEqual([
            [5, 'TD', 'DEF_8_BLOCKED', [{ player_id: 'DEF_CHI', column: 'def_blocked_return_tds' }]],
            [8, 'TD', 'DEF_8_INT', [{ player_id: 'DEF_CHI', column: 'def_int_return_tds' }]]
        ]);
        expect(chi.defensiveScores[0]).toMatchObject({ gameId: '20240908_TEN@CHI', scoringTeam: 'CHI', period: 'Q3', votes: { drive: 'takeaway', gamebook: 'takeaway', text: 'blocked' }, votesAgree: true, agreement: true, questionId: null, expectedCredits: [{ player_id: 'DEF_CHI', column: 'def_blocked_return_tds' }] });
        expect(buildGameDossier(loadFixture('20251019_NE@TEN')).defensiveScores).toEqual([expect.objectContaining({ playIdx: 8, awardClass: 'DEF_8_FUMBLE', creditedTo: [{ player_id: 'DEF_NE', column: 'def_fumble_return_tds' }] })]);
        // offensive recoveries and plain returns are not defensive scores
        expect(buildGameDossier(loadFixture('20251214_ARI@HOU')).defensiveScores).toEqual([]);
        expect(buildGameDossier(loadFixture('20250914_NE@MIA')).defensiveScores).toEqual([]);
        expect(buildGameDossier(loadFixture('20251005_TEN@ARI')).defensiveScores).toEqual([]);
    });

    test('a safety and an ambiguous play with defensive wording are candidates; a blocked PAT is not', () => {
        const fx = clone(loadFixture('20251019_NE@TEN'));
        fx.tank01Body.scoringPlays.push({ scorePeriod: 'Q4', scoreTime: '1:00', team: 'NE', scoreType: 'SF', score: 'Safety', playerIDs: [], homeScore: '13', awayScore: '33', scoreDetails: '' });
        fx.espnSummary.scoringPlays.push({ id: 'zz', type: { text: 'Safety' }, text: 'Safety', period: { number: 4 }, clock: { displayValue: '1:00' }, team: { abbreviation: 'NE' }, homeScore: 13, awayScore: 33, scoringType: { name: 'safety' } });
        const d = buildGameDossier(fx);
        const saf = d.defensiveScores.find(x => x.kind === 'SAFETY');
        expect(saf).toMatchObject({ scoringTeam: 'NE', awardClass: 'SAFETY_2', expectedCredits: [{ player_id: 'DEF_NE', column: 'safeties' }] });
        // the DB has no safety for DEF_NE: the safety is flagged as a discrepancy
        expect(d.discrepancies).toEqual([expect.objectContaining({ player_id: 'DEF_NE', column: 'safeties', expected: 1, actual: 0 })]);

        const amb = clone(loadFixture('20251214_ARI@HOU'));
        amb.espnSummary = null;
        const d2 = buildGameDossier(amb);
        expect(d2.defensiveScores.map(x => x.awardClass)).toEqual(['AMBIGUOUS']); // Marks' fumble recovery without ESPN
        expect(d2.defensiveScores[0].questionId).toBe('2025-wk15-20251214_ARI@HOU-play-3');
        const pat = clone(loadFixture('20250928_CAR@NE'));
        pat.espnSummary = null;
        const p = pat.tank01Body.scoringPlays.find(x => /Drake Maye 5 Yd Rush/.test(x.score));
        p.score = 'Drake Maye 5 Yd Rush (Andy Borregales PAT blocked)';
        expect(buildGameDossier(pat).defensiveScores).toEqual([]);
    });
});

describe('renderGameMarkdown: votes, score check, questions', () => {
    test('shows the votes per play, the score check line and a Questions section', () => {
        const fx = clone(loadFixture('20251214_ARI@HOU'));
        for (const dr of fx.espnSummary.drives.previous) for (const p of dr.plays) if (/W\.Marks for 7 yards/.test(p.text)) p.isTurnover = true;
        const md = renderGameMarkdown(buildGameDossier(fx));
        expect(md).toMatch(/Score check: final ARI 20 – HOU 40 · Tank01 plays ARI 20 – HOU 40 \(11 plays, OK\) · ESPN plays ARI 20 – HOU 40 \(11 plays, OK\)/);
        expect(md).toContain('## Questions');
        expect(md).toContain('- `2025-wk15-20251214_ARI@HOU-play-3` — play 3 (Q1 6:12 HOU)');
        expect(md).toContain('- Votes: drive=takeaway gamebook=same text=- → **DISAGREE** · gamebook: recoveredBy HOU (recovered)');
        expect(md).toContain('## Defensive scores');
        const clean = renderGameMarkdown(buildGameDossier(loadFixture('20250914_NE@MIA')));
        expect(clean).toContain('None — every scoring play was decided by the rules.');
        expect(clean).toContain('- Votes: drive=same gamebook=- text=return → agree');
    });
});
