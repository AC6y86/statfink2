/**
 * NFL.com-only, fail-closed IR eligibility gate. Fixture-driven: every page
 * comes from tests/fixtures/nfl/nflPages.js builders (modeled on the live
 * markup) through an injected fetchPage - no network, no database.
 */
const {
    NflRosterEligibilityService,
    NflEligibilityError,
    parseInjuryReport,
    parseTeamRoster,
    parseReserveTransactions,
    normalizeName,
    classifyRosterStatus,
    ROSTER_STATUS
} = require('../../server/services/nflRosterEligibilityService');
const pages = require('../fixtures/nfl/nflPages');

const INJURY_URL = 'https://www.nfl.com/injuries/league/2026/reg3';
const BAL_ROSTER_URL = 'https://www.nfl.com/teams/baltimore-ravens/roster';
const HOU_ROSTER_URL = 'https://www.nfl.com/teams/houston-texans/roster';
const RES_SEP_URL = 'https://www.nfl.com/transactions/league/reserve-list/2026/09';
const RES_SEP_P2_URL = 'https://www.nfl.com/transactions/league/reserve-list/2026/9?after=CURSOR2';
const RES_AUG_URL = 'https://www.nfl.com/transactions/league/reserve-list/2026/08';
const RES_JUL_URL = 'https://www.nfl.com/transactions/league/reserve-list/2026/07';

const INJURY_PAGE = pages.injuryReport({
    season: 2026, week: 3,
    teams: [
        { nickname: 'Texans', rows: [
            { name: 'Nico Collins', slug: 'nico-collins', pos: 'WR', practice: 'Did Not Participate In Practice', game: '' },
            { name: 'Joe Mixon', slug: 'joe-mixon', pos: 'RB', injuries: 'Ankle', practice: 'Limited Participation in Practice', game: 'Questionable' }
        ] },
        { nickname: 'Ravens', rows: [
            { name: 'Derrick Henry', slug: 'derrick-henry', pos: 'RB', injuries: 'Knee', practice: 'Did Not Participate In Practice', game: 'Out' },
            { name: 'Mark Andrews', slug: 'mark-andrews', pos: 'TE', injuries: 'Hip', practice: 'Full Participation in Practice', game: 'Doubtful' }
        ] }
    ]
});

const BAL_ROSTER = pages.teamRoster({
    teamName: 'Baltimore Ravens', season: 2026,
    players: [
        { name: 'Lamar Jackson', slug: 'lamar-jackson', no: '8', pos: 'QB', status: 'ACT' },
        { name: 'Ja&#x27;Kobi Lane', slug: 'ja-kobi-lane', no: '6', pos: 'WR', status: 'RES' },
        { name: 'Derrick Henry', slug: 'derrick-henry', no: '22', pos: 'RB', status: 'ACT' },
        { name: 'Sam Pup', slug: 'sam-pup', no: '90', pos: 'DE', status: 'RES' }
    ]
});
const HOU_ROSTER = pages.teamRoster({
    teamName: 'Houston Texans', season: 2026,
    players: [{ name: 'Nico Collins', slug: 'nico-collins', no: '12', pos: 'WR', status: 'ACT' }]
});

const RES_SEP_P1 = pages.reserveList({
    year: 2026, month: 9, nextAfter: 'CURSOR2',
    rows: [{ teamSlug: 'new-york-giants', teamNick: 'Giants', date: '09/24', name: 'Jaxson Dart', slug: 'jaxson-dart', transaction: 'Reserve/Injured' }]
});
const RES_SEP_P2 = pages.reserveList({
    year: 2026, month: 9,
    rows: [
        { teamSlug: 'baltimore-ravens', teamNick: 'Ravens', date: '09/16', name: 'Sam Pup', slug: 'sam-pup', transaction: 'Reserve/Physically Unable to Perform' },
        { teamSlug: 'baltimore-ravens', teamNick: 'Ravens', date: '09/16', name: 'Ja&#x27;Kobi Lane', slug: 'ja-kobi-lane', transaction: 'Reserve/Injured' }
    ]
});
const RES_EMPTY = month => pages.reserveList({ year: 2026, month, rows: [] });

function ok(body, finalUrl) {
    return { status: 200, contentType: 'text/html; charset=utf-8', body, finalUrl };
}

/** fetchPage stub from a url -> response map; records every url requested. */
function fakeFetch(map) {
    const calls = [];
    const fn = async (url) => {
        calls.push(url);
        const hit = map[url];
        if (hit === undefined) throw new Error(`fixture has no page for ${url}`);
        if (typeof hit === 'function') return hit(url);
        return hit;
    };
    fn.calls = calls;
    return fn;
}

const DEFAULT_PAGES = {
    [INJURY_URL]: ok(INJURY_PAGE, INJURY_URL),
    [BAL_ROSTER_URL]: ok(BAL_ROSTER, BAL_ROSTER_URL),
    [HOU_ROSTER_URL]: ok(HOU_ROSTER, HOU_ROSTER_URL),
    [RES_SEP_URL]: ok(RES_SEP_P1, RES_SEP_URL),
    [RES_SEP_P2_URL]: ok(RES_SEP_P2, RES_SEP_P2_URL),
    [RES_AUG_URL]: ok(RES_EMPTY(8), RES_AUG_URL),
    [RES_JUL_URL]: ok(RES_EMPTY(7), RES_JUL_URL)
};

function service(overrides = {}, options = {}) {
    const fetchPage = fakeFetch({ ...DEFAULT_PAGES, ...overrides });
    const svc = new NflRosterEligibilityService({
        fetchPage,
        timeoutMs: 50,
        now: () => new Date('2026-09-25T12:00:00Z'),
        ...options
    });
    svc.calls = fetchPage.calls;
    return svc;
}

async function failure(promise) {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error('expected the check to throw');
}

describe('normalizeName', () => {
    test('decodes entities, strips punctuation/diacritics/suffixes, lowercases', () => {
        expect(normalizeName('Ja&#x27;Kobi Lane')).toBe('jakobilane');
        expect(normalizeName("Ja'Kobi Lane")).toBe('jakobilane');
        expect(normalizeName('D.J. Moore')).toBe('djmoore');
        expect(normalizeName('Odell Beckham Jr.')).toBe('odellbeckham');
        expect(normalizeName('José Ramírez')).toBe('joseramirez');
        expect(normalizeName('  Isiah   Pacheco ')).toBe('isiahpacheco');
    });
});

describe('parseInjuryReport', () => {
    test('groups rows by team and reads the Game Status cell exactly', () => {
        const report = parseInjuryReport(INJURY_PAGE, { season: 2026, week: 3 });
        expect(Object.keys(report.teams).sort()).toEqual(['BAL', 'HOU']);
        expect(report.teams.HOU[0]).toMatchObject({ name: 'Nico Collins', practiceStatus: 'Did Not Participate In Practice', gameStatus: '' });
        expect(report.teams.HOU[1].gameStatus).toBe('Questionable');
        expect(report.teams.BAL[0].gameStatus).toBe('Out');
    });

    test('rejects a page for a different week (NFL.com redirects bad weeks to the current one)', () => {
        expect(() => parseInjuryReport(INJURY_PAGE, { season: 2026, week: 4 }))
            .toThrow(/fresh NFL\.com data unavailable \(injury report page identity mismatch/);
        expect(() => parseInjuryReport(INJURY_PAGE, { season: 2025, week: 3 }))
            .toThrow(/identity mismatch/);
    });

    test('rejects a page whose selected week disagrees with its title', () => {
        const html = pages.injuryReport({ season: 2026, week: 3, selectedPath: '/injuries/league/2026/reg2', teams: [{ nickname: 'Ravens', rows: [] }] });
        expect(() => parseInjuryReport(html, { season: 2026, week: 3 })).toThrow(/identity mismatch/);
    });

    test('fails closed when a table cannot be attributed to a team', () => {
        const html = pages.injuryReport({ season: 2026, week: 3, teams: [{ nickname: 'Space Cadets', rows: [{ name: 'X Y', game: 'Out' }] }] });
        expect(() => parseInjuryReport(html, { season: 2026, week: 3 })).toThrow(/could not attribute a table to a team/);
    });

    test('fails closed on a malformed page with no tables', () => {
        const html = pages.wrap('Official NFL Injury Report for Players - Week 3 of the 2026 Season | NFL.com',
            '<select><option value="/injuries/league/2026/reg3" selected>WEEK 3</option></select><p>maintenance</p>');
        expect(() => parseInjuryReport(html, { season: 2026, week: 3 })).toThrow(/no team tables found/);
    });
});

describe('parseTeamRoster', () => {
    test('reads name, slug and Status per player', () => {
        const roster = parseTeamRoster(BAL_ROSTER, { teamCode: 'BAL', season: 2026 });
        expect(roster.players).toHaveLength(4);
        expect(roster.players[1]).toEqual({ name: "Ja'Kobi Lane", slug: 'ja-kobi-lane', number: '6', position: 'WR', status: 'RES' });
    });

    test('rejects a roster page for another team or season', () => {
        expect(() => parseTeamRoster(BAL_ROSTER, { teamCode: 'HOU', season: 2026 })).toThrow(/roster page identity mismatch/);
        expect(() => parseTeamRoster(BAL_ROSTER, { teamCode: 'BAL', season: 2025 })).toThrow(/roster page identity mismatch/);
    });

    test('rejects a 404-style page with an empty title', () => {
        expect(() => parseTeamRoster(pages.wrap('', '<table><tr><th>Player</th><th>Status</th></tr></table>'), { teamCode: 'BAL', season: 2026 }))
            .toThrow(/identity mismatch/);
    });
});

describe('parseReserveTransactions', () => {
    test('reads team slugs, date, name, player slug, transaction and the next-page cursor', () => {
        const page = parseReserveTransactions(RES_SEP_P1, { year: 2026 });
        expect(page.rows).toEqual([{
            fromSlug: 'new-york-giants', toSlug: 'new-york-giants', date: '09/24',
            name: 'Jaxson Dart', playerSlug: 'jaxson-dart', position: '', transaction: 'Reserve/Injured'
        }]);
        expect(page.nextPath).toBe('/transactions/league/reserve-list/2026/9?after=CURSOR2');

        const last = parseReserveTransactions(RES_SEP_P2, { year: 2026 });
        expect(last.nextPath).toBeNull();
        expect(last.rows[1].name).toBe("Ja'Kobi Lane");
    });

    test('an empty month parses to zero rows (not an error)', () => {
        expect(parseReserveTransactions(RES_EMPTY(7), { year: 2026 }).rows).toEqual([]);
    });

    test('rejects a page for the wrong year', () => {
        expect(() => parseReserveTransactions(RES_SEP_P1, { year: 2025 })).toThrow(/transactions page identity mismatch/);
    });
});

describe('NflRosterEligibilityService.checkIrEligibility', () => {
    test('Game Status exactly "Out" on the current-week injury report is eligible (no further fetches)', async () => {
        const svc = service();
        const evidence = await svc.checkIrEligibility({ playerName: 'Derrick Henry', team: 'BAL', season: 2026, week: 3 });
        expect(evidence.eligible).toBe(true);
        expect(evidence.code).toBe('OUT_ON_INJURY_REPORT');
        expect(evidence.observedStatus).toBe('Game Status: Out');
        expect(evidence.sources).toEqual([INJURY_URL]);
        expect(evidence.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(evidence.player).toEqual({ name: 'Derrick Henry', team: 'BAL' });
        expect(svc.calls).toEqual([INJURY_URL]);
    });

    test('"Out" matching is case-insensitive after trim, and nothing else counts', async () => {
        const html = pages.injuryReport({ season: 2026, week: 3, teams: [{ nickname: 'Ravens', rows: [
            { name: 'Derrick Henry', slug: 'derrick-henry', game: '  out ' },
            { name: 'Mark Andrews', slug: 'mark-andrews', game: 'Out (knee)' }
        ] }] });
        const svc = service({ [INJURY_URL]: ok(html, INJURY_URL) });
        await expect(svc.checkIrEligibility({ playerName: 'Derrick Henry', team: 'BAL', season: 2026, week: 3 })).resolves.toMatchObject({ eligible: true });
        const err = await failure(svc.checkIrEligibility({ playerName: 'Mark Andrews', team: 'BAL', season: 2026, week: 3 }));
        expect(err.code).toBe('NFL_INELIGIBLE');
        expect(err.message).toContain('Game Status: "Out (knee)"');
    });

    test('blank Game Status with DNP (Nico Collins case) is definitively ineligible with the observed status', async () => {
        const svc = service();
        const err = await failure(svc.checkIrEligibility({ playerName: 'Nico Collins', team: 'HOU', season: 2026, week: 3 }));
        expect(err).toBeInstanceOf(NflEligibilityError);
        expect(err.code).toBe('NFL_INELIGIBLE');
        expect(err.message).toMatch(/^IR move not allowed: NFL\.com does not list Nico Collins \(HOU\) as Out or on Reserve\/Injured/);
        expect(err.message).toContain('Game Status: blank; Practice: Did Not Participate In Practice');
        expect(err.message).toContain('Houston Texans roster: Status "ACT"');
        expect(err.evidence).toMatchObject({ eligible: false, code: 'NFL_INELIGIBLE', sources: [INJURY_URL, HOU_ROSTER_URL] });
        expect(err.evidence.checkedAt).toBeTruthy();
    });

    test('Questionable / Doubtful are not eligible', async () => {
        const svc = service();
        const err = await failure(svc.checkIrEligibility({ playerName: 'Joe Mixon', team: 'HOU', season: 2026, week: 3 }));
        expect(err.code).toBe('NFL_INELIGIBLE');
        expect(err.message).toContain('Game Status: "Questionable"');
    });

    test('current RES on the roster + Reserve/Injured transaction is eligible (paginates and decodes entities)', async () => {
        const svc = service();
        const evidence = await svc.checkIrEligibility({ playerName: "Ja'Kobi Lane", team: 'BAL', season: 2026, week: 3 });
        expect(evidence.eligible).toBe(true);
        expect(evidence.code).toBe('RESERVE_INJURED');
        expect(evidence.transaction).toMatchObject({ date: '09/16/2026', transaction: 'Reserve/Injured', team: 'baltimore-ravens' });
        expect(evidence.roster).toMatchObject({ status: 'RES', slug: 'ja-kobi-lane' });
        expect(evidence.sources).toEqual([INJURY_URL, BAL_ROSTER_URL, RES_SEP_URL, RES_SEP_P2_URL]);
        expect(evidence.observedStatus).toContain('Reserve/Injured transaction 09/16/2026');
    });

    test('RES without a Reserve/Injured transaction (e.g. PUP) is ineligible after every season month is searched', async () => {
        const svc = service();
        const err = await failure(svc.checkIrEligibility({ playerName: 'Sam Pup', team: 'BAL', season: 2026, week: 3 }));
        expect(err.code).toBe('NFL_INELIGIBLE');
        expect(err.message).toContain('Status "RES" (Reserve/Injured) but no Reserve/Injured transaction found (2026-09, 2026-08, 2026-07)');
        expect(svc.calls).toEqual([INJURY_URL, BAL_ROSTER_URL, RES_SEP_URL, RES_SEP_P2_URL, RES_AUG_URL, RES_JUL_URL]);
    });

    test('player not on the roster and not on the injury report is ineligible', async () => {
        const svc = service();
        const err = await failure(svc.checkIrEligibility({ playerName: 'Nobody Here', team: 'BAL', season: 2026, week: 3 }));
        expect(err.code).toBe('NFL_INELIGIBLE');
        expect(err.message).toContain('injury report: not listed; Baltimore Ravens roster: not on roster');
    });

    test('team codes are normalized (WSH -> WAS, nickname) and unknown teams fail closed', async () => {
        const svc = service();
        const err = await failure(svc.checkIrEligibility({ playerName: 'Someone', team: 'XYZ', season: 2026, week: 3 }));
        expect(err.code).toBe('NFL_UNAVAILABLE');
        expect(err.message).toContain('unknown NFL team "XYZ"');
        expect(svc.calls).toEqual([]);
        expect(NflRosterEligibilityService.rosterUrl('WAS')).toBe('https://www.nfl.com/teams/washington-commanders/roster');
        const err2 = await failure(svc.checkIrEligibility({ playerName: 'Someone', team: 'WSH', season: 2026, week: 3 }));
        expect(err2.evidence.player.team).toBe('WAS');
    });

    test('NFL.com full names and team slugs also resolve to a canonical code', async () => {
        const svc = service();
        const err = await failure(svc.checkIrEligibility({ playerName: 'Someone', team: 'Houston Texans', season: 2026, week: 3 }));
        expect(err.evidence.player.team).toBe('HOU');
        const err2 = await failure(svc.checkIrEligibility({ playerName: 'Someone', team: 'houston-texans', season: 2026, week: 3 }));
        expect(err2.evidence.player.team).toBe('HOU');
    });

    test('ambiguous name matches fail closed as unavailable', async () => {
        const html = pages.teamRoster({ teamName: 'Baltimore Ravens', season: 2026, players: [
            { name: 'Sam Pup', slug: 'sam-pup', status: 'RES' }, { name: 'Sam Pup', slug: 'sam-pup-2', status: 'ACT' }
        ] });
        const svc = service({ [BAL_ROSTER_URL]: ok(html, BAL_ROSTER_URL) });
        const err = await failure(svc.checkIrEligibility({ playerName: 'Sam Pup', team: 'BAL', season: 2026, week: 3 }));
        expect(err.code).toBe('NFL_UNAVAILABLE');
        expect(err.message).toContain('ambiguous');
    });

    test('a Reserve/Injured row for a different player slug with the same name fails closed', async () => {
        const p2 = pages.reserveList({ year: 2026, month: 9, rows: [
            { teamSlug: 'baltimore-ravens', teamNick: 'Ravens', date: '09/16', name: "Ja'Kobi Lane", slug: 'ja-kobi-lane-2', transaction: 'Reserve/Injured' }
        ] });
        const svc = service({ [RES_SEP_P2_URL]: ok(p2, RES_SEP_P2_URL) });
        const err = await failure(svc.checkIrEligibility({ playerName: "Ja'Kobi Lane", team: 'BAL', season: 2026, week: 3 }));
        expect(err.code).toBe('NFL_UNAVAILABLE');
        expect(err.message).toContain('different');
    });

    test('a transaction for the same name on another team does not corroborate', async () => {
        const p2 = pages.reserveList({ year: 2026, month: 9, rows: [
            { teamSlug: 'houston-texans', teamNick: 'Texans', date: '09/16', name: "Ja'Kobi Lane", slug: 'ja-kobi-lane', transaction: 'Reserve/Injured' }
        ] });
        const svc = service({ [RES_SEP_P2_URL]: ok(p2, RES_SEP_P2_URL) });
        const err = await failure(svc.checkIrEligibility({ playerName: "Ja'Kobi Lane", team: 'BAL', season: 2026, week: 3 }));
        expect(err.code).toBe('NFL_INELIGIBLE');
    });

    test('wrong-week injury page (bad-week redirect) fails closed as unavailable', async () => {
        const wrong = pages.injuryReport({ season: 2026, week: 3, teams: [{ nickname: 'Ravens', rows: [{ name: 'Derrick Henry', game: 'Out' }] }] });
        const svc = service({ [INJURY_URL]: ok(wrong, INJURY_URL) });
        // ask for week 3 but the service is configured for week 4's URL -> stub for reg4 returns the week 3 page
        const url4 = 'https://www.nfl.com/injuries/league/2026/reg4';
        const svc4 = service({ [url4]: ok(wrong, INJURY_URL) });
        const err = await failure(svc4.checkIrEligibility({ playerName: 'Derrick Henry', team: 'BAL', season: 2026, week: 4 }));
        expect(err.code).toBe('NFL_UNAVAILABLE');
        expect(err.message).toMatch(/^Validation failed: fresh NFL\.com data unavailable \(injury report page identity mismatch/);
        expect(svc.calls).toEqual([]);
    });

    test('malformed injury page fails closed', async () => {
        const svc = service({ [INJURY_URL]: ok('<html><body><table><tr><td>???</td></tr></table></body></html>', INJURY_URL) });
        const err = await failure(svc.checkIrEligibility({ playerName: 'Derrick Henry', team: 'BAL', season: 2026, week: 3 }));
        expect(err.code).toBe('NFL_UNAVAILABLE');
    });

    test('timeout fails closed with a distinct unavailable error', async () => {
        const timeoutFetch = async () => {
            const e = new Error('timeout of 50ms exceeded');
            e.code = 'ECONNABORTED';
            throw e;
        };
        const svc = new NflRosterEligibilityService({ fetchPage: timeoutFetch, timeoutMs: 50 });
        const err = await failure(svc.checkIrEligibility({ playerName: 'Derrick Henry', team: 'BAL', season: 2026, week: 3 }));
        expect(err.code).toBe('NFL_UNAVAILABLE');
        expect(err.message).toBe(`Validation failed: fresh NFL.com data unavailable (timeout after 50ms fetching ${INJURY_URL})`);
    });

    test('a response that ends on a non-nfl.com host fails closed', async () => {
        const svc = service({ [INJURY_URL]: ok(INJURY_PAGE, 'https://evil.example.com/injuries/league/2026/reg3') });
        const err = await failure(svc.checkIrEligibility({ playerName: 'Derrick Henry', team: 'BAL', season: 2026, week: 3 }));
        expect(err.code).toBe('NFL_UNAVAILABLE');
        expect(err.message).toContain('did not end on nfl.com');
    });

    test('non-200, non-HTML and table-less responses fail closed', async () => {
        for (const bad of [
            { status: 404, contentType: 'text/html', body: INJURY_PAGE, finalUrl: INJURY_URL },
            { status: 200, contentType: 'application/json', body: INJURY_PAGE, finalUrl: INJURY_URL },
            { status: 200, contentType: 'text/html', body: '<html><body>Access denied</body></html>', finalUrl: INJURY_URL }
        ]) {
            const svc = service({ [INJURY_URL]: bad });
            const err = await failure(svc.checkIrEligibility({ playerName: 'Derrick Henry', team: 'BAL', season: 2026, week: 3 }));
            expect(err.code).toBe('NFL_UNAVAILABLE');
            expect(err.message).toMatch(/^Validation failed: fresh NFL\.com data unavailable/);
        }
    });

    test('a roster fetch failure after a clean injury report fails closed (no partial verdict)', async () => {
        const svc = service({ [BAL_ROSTER_URL]: { status: 503, contentType: 'text/html', body: '<html><table></table></html>', finalUrl: BAL_ROSTER_URL } });
        const err = await failure(svc.checkIrEligibility({ playerName: "Ja'Kobi Lane", team: 'BAL', season: 2026, week: 3 }));
        expect(err.code).toBe('NFL_UNAVAILABLE');
        expect(err.message).toContain('HTTP 503');
    });

    test('exceeding the per-month transaction page cap fails closed', async () => {
        const loop = pages.reserveList({ year: 2026, month: 9, nextAfter: 'CURSOR2', rows: [] });
        const svc = service({ [RES_SEP_URL]: ok(loop, RES_SEP_URL), [RES_SEP_P2_URL]: ok(pages.reserveList({ year: 2026, month: 9, nextAfter: 'CURSOR3', rows: [] }), RES_SEP_P2_URL), 'https://www.nfl.com/transactions/league/reserve-list/2026/9?after=CURSOR3': ok(pages.reserveList({ year: 2026, month: 9, nextAfter: 'CURSOR4', rows: [] }), RES_SEP_P2_URL) }, { maxTransactionPages: 2 });
        const err = await failure(svc.checkIrEligibility({ playerName: "Ja'Kobi Lane", team: 'BAL', season: 2026, week: 3 }));
        expect(err.code).toBe('NFL_UNAVAILABLE');
        expect(err.message).toContain('exceeded 2 pages');
    });

    test('a CDN replay of an earlier transactions page fails closed rather than hiding rows', async () => {
        // The cursor is honoured in the URL but the CDN hands back the page
        // already seen (same rows, same next cursor). Accepting it would skip
        // Ja'Kobi Lane's Reserve/Injured row and wrongly deny an eligible move.
        const svc = service({ [RES_SEP_P2_URL]: ok(RES_SEP_P1, RES_SEP_P2_URL) });
        const err = await failure(svc.checkIrEligibility({ playerName: "Ja'Kobi Lane", team: 'BAL', season: 2026, week: 3 }));
        expect(err.code).toBe('NFL_UNAVAILABLE');
        expect(err.message).toContain('came back as a copy of another page');
    });

    test('a page that points back at the cursor just requested fails closed', async () => {
        const echo = pages.reserveList({ year: 2026, month: 9, nextAfter: 'CURSOR2', rows: [
            { teamSlug: 'new-york-giants', teamNick: 'Giants', date: '09/23', name: 'Other Guy', slug: 'other-guy', transaction: 'Reserve/Injured' }
        ] });
        const svc = service({ [RES_SEP_P2_URL]: ok(echo, RES_SEP_P2_URL) });
        const err = await failure(svc.checkIrEligibility({ playerName: "Ja'Kobi Lane", team: 'BAL', season: 2026, week: 3 }));
        expect(err.code).toBe('NFL_UNAVAILABLE');
        expect(err.message).toContain('cursor "CURSOR2" was not honoured');
    });

    test('empty pages with distinct cursors are a legitimate walk, not a replay', async () => {
        // Two empty pages share a row fingerprint; only their cursors tell
        // them apart, so the replay guard must not fire on them.
        const empty = next => pages.reserveList({ year: 2026, month: 9, nextAfter: next, rows: [] });
        const svc = service({
            [RES_SEP_URL]: ok(empty('CURSOR2'), RES_SEP_URL),
            [RES_SEP_P2_URL]: ok(empty('CURSOR3'), RES_SEP_P2_URL),
            'https://www.nfl.com/transactions/league/reserve-list/2026/9?after=CURSOR3': ok(empty(null), RES_SEP_P2_URL)
        });
        const err = await failure(svc.checkIrEligibility({ playerName: "Ja'Kobi Lane", team: 'BAL', season: 2026, week: 3 }));
        expect(err.code).toBe('NFL_INELIGIBLE');
        expect(err.message).toContain('no Reserve/Injured transaction found');
        expect(svc.calls).toContain('https://www.nfl.com/transactions/league/reserve-list/2026/9?after=CURSOR3');
    });

    test('never caches: two checks perform two fresh fetch sequences', async () => {
        const svc = service();
        await svc.checkIrEligibility({ playerName: 'Derrick Henry', team: 'BAL', season: 2026, week: 3 });
        await svc.checkIrEligibility({ playerName: 'Derrick Henry', team: 'BAL', season: 2026, week: 3 });
        expect(svc.calls).toEqual([INJURY_URL, INJURY_URL]);
    });

    test('monthsToSearch covers July through the current month in-season, and the whole season window afterwards', () => {
        const inSeason = new NflRosterEligibilityService({ now: () => new Date('2026-09-25T12:00:00Z') });
        expect(inSeason.monthsToSearch(2026).map(m => `${m.year}-${m.month}`)).toEqual(['2026-9', '2026-8', '2026-7']);
        const offSeason = new NflRosterEligibilityService({ now: () => new Date('2027-06-01T12:00:00Z') });
        expect(offSeason.monthsToSearch(2026).map(m => `${m.year}-${m.month}`)).toEqual(['2027-2', '2027-1', '2026-12', '2026-11', '2026-10', '2026-9', '2026-8', '2026-7']);
    });
});

describe('classifyRosterStatus', () => {
    test('RES and RSR are the only Reserve/Injured codes', () => {
        expect(classifyRosterStatus('RES')).toEqual({ code: 'RES', kind: 'reserve_injured', meaning: 'Reserve/Injured' });
        expect(classifyRosterStatus(' rsr ')).toEqual({ code: 'RSR', kind: 'reserve_injured', meaning: 'Reserve/Injured; Designated for Return' });
        const irCodes = Object.keys(ROSTER_STATUS).filter(c => ROSTER_STATUS[c].kind === 'reserve_injured').sort();
        expect(irCodes).toEqual(['RES', 'RSR']);
    });

    test('other reserve lists are known non-injury codes with their meaning spelled out', () => {
        expect(classifyRosterStatus('PUP')).toMatchObject({ kind: 'not_injured_reserve', meaning: 'Reserve/Physically Unable to Perform' });
        expect(classifyRosterStatus('RSN')).toMatchObject({ kind: 'not_injured_reserve', meaning: 'Reserve/Non-Football Injury or Illness' });
        expect(classifyRosterStatus('EXE')).toMatchObject({ kind: 'not_injured_reserve', meaning: 'Exempt/Commissioner Permission' });
        expect(classifyRosterStatus('SUS')).toMatchObject({ kind: 'not_injured_reserve' });
        expect(classifyRosterStatus('RET')).toMatchObject({ kind: 'not_injured_reserve' });
        expect(classifyRosterStatus('ACT')).toMatchObject({ kind: 'not_injured_reserve', meaning: 'Active' });
        expect(classifyRosterStatus('DEV')).toMatchObject({ kind: 'not_injured_reserve' });
    });

    test('blank or never-seen codes are unknown (callers fail closed as unavailable)', () => {
        expect(classifyRosterStatus('')).toMatchObject({ code: '', kind: 'unknown' });
        expect(classifyRosterStatus(null)).toMatchObject({ kind: 'unknown' });
        expect(classifyRosterStatus('RSX')).toMatchObject({ code: 'RSX', kind: 'unknown' });
    });
});

/**
 * Regression: James Conner, ARI RB, 2026 week 4 (pending move pm-1790894988583-1).
 * Modeled on the live NFL.com pages fetched 2026-10-01: he is absent from the
 * Week 4 injury report (IR players are not carried on it), the Cardinals
 * roster prints Status "RSR", and the reserve-list for August 2026 carries
 * "Cardinals 08/30 James Conner Reserve/Injured" several pages deep. The old
 * gate accepted only "RES" and refused him as definitively ineligible.
 */
describe('Reserve/Injured status codes on the roster page (James Conner, RSR)', () => {
    const W4_URL = 'https://www.nfl.com/injuries/league/2026/reg4';
    const ARI_ROSTER_URL = 'https://www.nfl.com/teams/arizona-cardinals/roster';
    const OCT_URL = 'https://www.nfl.com/transactions/league/reserve-list/2026/10';
    const SEP_URL = 'https://www.nfl.com/transactions/league/reserve-list/2026/09';
    const AUG_URL = 'https://www.nfl.com/transactions/league/reserve-list/2026/08';
    const AUG_P2_URL = 'https://www.nfl.com/transactions/league/reserve-list/2026/8?after=AUGP2';
    const JUL_URL = 'https://www.nfl.com/transactions/league/reserve-list/2026/07';

    // Week 4 report: Cardinals table exists but does not mention Conner.
    const W4_PAGE = pages.injuryReport({ season: 2026, week: 4, teams: [
        { nickname: 'Cardinals', rows: [{ name: 'Trey McBride', slug: 'trey-mcbride', pos: 'TE', injuries: 'Knee', practice: 'Limited Participation in Practice', game: 'Questionable' }] },
        { nickname: 'Ravens', rows: [] }
    ] });

    const ARI_ROSTER = pages.teamRoster({ teamName: 'Arizona Cardinals', season: 2026, players: [
        { name: 'Tyler Allgeier', slug: 'tyler-allgeier', no: '22', pos: 'RB', status: 'ACT' },
        { name: 'Trey Benson', slug: 'trey-benson', no: '33', pos: 'RB', status: 'RES' },
        { name: 'Zachary Carter', slug: 'zachary-carter', no: '90', pos: 'DT', status: 'RSR' },
        { name: 'Hayden Conner', slug: 'hayden-conner', no: '58', pos: 'G', status: 'ACT' },
        { name: 'James Conner', slug: 'james-conner', no: '6', pos: 'RB', status: 'RSR' },
        { name: 'Tip Reiman', slug: 'tip-reiman', no: '87', pos: 'TE', status: 'PUP' },
        { name: 'Non Football', slug: 'non-football', no: '99', pos: 'DE', status: 'RSN' },
        { name: 'Ex Empt', slug: 'ex-empt', no: '98', pos: 'LB', status: 'EXE' },
        { name: 'Back Already', slug: 'back-already', no: '97', pos: 'WR', status: 'ACT' },
        { name: 'Brand New', slug: 'brand-new', no: '96', pos: 'CB', status: 'RSX' },
        { name: 'No Status', slug: 'no-status', no: '95', pos: 'S', status: '' }
    ] });

    const OCT = pages.reserveList({ year: 2026, month: 10, rows: [
        { teamSlug: 'arizona-cardinals', teamNick: 'Cardinals', date: '10/01', name: 'Trey Benson', slug: 'trey-benson', transaction: 'Reserve/Injured' }
    ] });
    const SEP = pages.reserveList({ year: 2026, month: 9, rows: [
        { teamSlug: 'arizona-cardinals', teamNick: 'Cardinals', date: '09/10', name: 'Back Already', slug: 'back-already', transaction: 'Reserve/Injured' }
    ] });
    const AUG_P1 = pages.reserveList({ year: 2026, month: 8, nextAfter: 'AUGP2', rows: [
        { teamSlug: 'dallas-cowboys', teamNick: 'Cowboys', date: '08/30', name: 'Marist Liufau', slug: 'marist-liufau', transaction: 'Reserve/Injured' }
    ] });
    const AUG_P2 = pages.reserveList({ year: 2026, month: 8, rows: [
        { teamSlug: 'arizona-cardinals', teamNick: 'Cardinals', date: '08/30', name: 'Zachary Carter', slug: 'zachary-carter', transaction: 'Reserve/Injured' },
        { teamSlug: 'arizona-cardinals', teamNick: 'Cardinals', date: '08/30', name: 'James Conner', slug: 'james-conner', transaction: 'Reserve/Injured' },
        { teamSlug: 'arizona-cardinals', teamNick: 'Cardinals', date: '08/30', name: 'Tip Reiman', slug: 'tip-reiman', transaction: 'Reserve/Physically Unable to Perform' },
        { teamSlug: 'arizona-cardinals', teamNick: 'Cardinals', date: '08/30', name: 'Non Football', slug: 'non-football', transaction: 'Reserve/Non-Football Injury' }
    ] });
    const JUL = pages.reserveList({ year: 2026, month: 7, rows: [] });

    const CONNER_PAGES = {
        [W4_URL]: ok(W4_PAGE, W4_URL),
        [ARI_ROSTER_URL]: ok(ARI_ROSTER, ARI_ROSTER_URL),
        [OCT_URL]: ok(OCT, OCT_URL),
        [SEP_URL]: ok(SEP, SEP_URL),
        [AUG_URL]: ok(AUG_P1, AUG_URL),
        [AUG_P2_URL]: ok(AUG_P2, AUG_P2_URL),
        [JUL_URL]: ok(JUL, JUL_URL)
    };

    function conner(overrides = {}) {
        return service({ ...CONNER_PAGES, ...overrides }, { now: () => new Date('2026-10-01T23:00:00Z') });
    }
    const check = (svc, playerName) => svc.checkIrEligibility({ playerName, team: 'ARI', season: 2026, week: 4 });

    test('parseTeamRoster reads RSR verbatim', () => {
        const roster = parseTeamRoster(ARI_ROSTER, { teamCode: 'ARI', season: 2026 });
        expect(roster.players.find(p => p.name === 'James Conner')).toEqual({ name: 'James Conner', slug: 'james-conner', number: '6', position: 'RB', status: 'RSR' });
    });

    test('James Conner: not on the Week 4 report, roster RSR, Reserve/Injured 08/30 -> eligible', async () => {
        const svc = conner();
        const evidence = await check(svc, 'James Conner');
        expect(evidence.eligible).toBe(true);
        expect(evidence.code).toBe('RESERVE_INJURED');
        expect(evidence.player).toEqual({ name: 'James Conner', team: 'ARI' });
        expect(evidence.roster).toEqual({ status: 'RSR', meaning: 'Reserve/Injured; Designated for Return', slug: 'james-conner', position: 'RB' });
        expect(evidence.transaction).toMatchObject({ date: '08/30/2026', transaction: 'Reserve/Injured', team: 'arizona-cardinals', page: AUG_P2_URL });
        expect(evidence.injuryReport).toEqual({ observed: 'not listed', note: 'players on Reserve/Injured are not carried on the weekly injury report' });
        expect(evidence.observedStatus).toBe('roster Status "RSR" (Reserve/Injured; Designated for Return); Reserve/Injured transaction 08/30/2026');
        expect(evidence.reason).toBe('NFL.com lists James Conner (ARI) as RSR (Reserve/Injured; Designated for Return) on the Arizona Cardinals roster with a Reserve/Injured transaction dated 08/30/2026');
        // Walked newest month first and stopped at the corroborating page.
        expect(svc.calls).toEqual([W4_URL, ARI_ROSTER_URL, OCT_URL, SEP_URL, AUG_URL, AUG_P2_URL]);
        expect(evidence.sources).toEqual(svc.calls);
    });

    test('the namesake Hayden Conner (ACT) does not collide with James Conner', async () => {
        const err = await failure(check(conner(), 'Hayden Conner'));
        expect(err.code).toBe('NFL_INELIGIBLE');
        expect(err.message).toContain('Arizona Cardinals roster: Status "ACT" (Active), not Reserve/Injured');
    });

    test('RES placed in-season (Trey Benson, 10/01) is still eligible; the newest month is searched first', async () => {
        const svc = conner();
        const evidence = await check(svc, 'Trey Benson');
        expect(evidence).toMatchObject({ eligible: true, code: 'RESERVE_INJURED', roster: { status: 'RES', meaning: 'Reserve/Injured' } });
        expect(evidence.observedStatus).toBe('roster Status "RES" (Reserve/Injured); Reserve/Injured transaction 10/01/2026');
        expect(svc.calls).toEqual([W4_URL, ARI_ROSTER_URL, OCT_URL]);
    });

    test('RSR with no Reserve/Injured transaction anywhere in the season window is refused (status alone never suffices)', async () => {
        const noConner = pages.reserveList({ year: 2026, month: 8, rows: [
            { teamSlug: 'arizona-cardinals', teamNick: 'Cardinals', date: '08/30', name: 'Zachary Carter', slug: 'zachary-carter', transaction: 'Reserve/Injured' }
        ] });
        const svc = conner({ [AUG_P2_URL]: ok(noConner, AUG_P2_URL) });
        const err = await failure(check(svc, 'James Conner'));
        expect(err.code).toBe('NFL_INELIGIBLE');
        expect(err.message).toContain('Status "RSR" (Reserve/Injured; Designated for Return) but no Reserve/Injured transaction found (2026-10, 2026-09, 2026-08, 2026-07)');
        expect(err.evidence.roster).toMatchObject({ status: 'RSR' });
        expect(svc.calls).toEqual([W4_URL, ARI_ROSTER_URL, OCT_URL, SEP_URL, AUG_URL, AUG_P2_URL, JUL_URL]);
    });

    test('a Reserve/Injured transaction on another team does not corroborate RSR', async () => {
        const otherTeam = pages.reserveList({ year: 2026, month: 8, rows: [
            { teamSlug: 'pittsburgh-steelers', teamNick: 'Steelers', date: '08/30', name: 'James Conner', slug: 'james-conner', transaction: 'Reserve/Injured' }
        ] });
        const err = await failure(check(conner({ [AUG_P2_URL]: ok(otherTeam, AUG_P2_URL) }), 'James Conner'));
        expect(err.code).toBe('NFL_INELIGIBLE');
        expect(err.message).toContain('no Reserve/Injured transaction found');
    });

    test('PUP (Reserve/Physically Unable to Perform) is refused definitively without searching transactions', async () => {
        const svc = conner();
        const err = await failure(check(svc, 'Tip Reiman'));
        expect(err.code).toBe('NFL_INELIGIBLE');
        expect(err.message).toBe('IR move not allowed: NFL.com does not list Tip Reiman (ARI) as Out or on Reserve/Injured (observed injury report: not listed; Arizona Cardinals roster: Status "PUP" (Reserve/Physically Unable to Perform), not Reserve/Injured)');
        expect(err.evidence.roster).toEqual({ status: 'PUP', slug: 'tip-reiman', position: 'TE' });
        expect(svc.calls).toEqual([W4_URL, ARI_ROSTER_URL]);
    });

    test('RSN (Reserve/Non-Football Injury) and EXE (Exempt) are refused definitively', async () => {
        const rsn = await failure(check(conner(), 'Non Football'));
        expect(rsn.code).toBe('NFL_INELIGIBLE');
        expect(rsn.message).toContain('Status "RSN" (Reserve/Non-Football Injury or Illness), not Reserve/Injured');
        const exe = await failure(check(conner(), 'Ex Empt'));
        expect(exe.code).toBe('NFL_INELIGIBLE');
        expect(exe.message).toContain('Status "EXE" (Exempt/Commissioner Permission), not Reserve/Injured');
    });

    test('a player activated from IR (ACT now, old Reserve/Injured transaction) is refused without consulting transactions', async () => {
        const svc = conner();
        const err = await failure(check(svc, 'Back Already'));
        expect(err.code).toBe('NFL_INELIGIBLE');
        expect(err.message).toContain('Status "ACT" (Active), not Reserve/Injured');
        expect(svc.calls).toEqual([W4_URL, ARI_ROSTER_URL]);
    });

    test('a Status code the validator has never seen fails closed as unavailable, not as a verdict', async () => {
        const svc = conner();
        const err = await failure(check(svc, 'Brand New'));
        expect(err).toBeInstanceOf(NflEligibilityError);
        expect(err.code).toBe('NFL_UNAVAILABLE');
        expect(err.message).toBe('Validation failed: fresh NFL.com data unavailable (Arizona Cardinals roster shows Brand New (ARI) with unrecognised Status "RSX"; cannot tell whether it is Reserve/Injured)');
        expect(err.evidence.observedStatus).toContain('Status "RSX" (unrecognised NFL.com roster Status code)');
        expect(svc.calls).toEqual([W4_URL, ARI_ROSTER_URL]);
    });

    test('a blank Status cell fails closed as unavailable', async () => {
        const err = await failure(check(conner(), 'No Status'));
        expect(err.code).toBe('NFL_UNAVAILABLE');
        expect(err.message).toContain('a blank Status ""');
    });

    test('Game Status "Out" still wins before any roster lookup, whatever the roster code', async () => {
        const out = pages.injuryReport({ season: 2026, week: 4, teams: [{ nickname: 'Cardinals', rows: [{ name: 'James Conner', slug: 'james-conner', pos: 'RB', injuries: 'Foot', practice: 'Did Not Participate In Practice', game: 'Out' }] }] });
        const svc = conner({ [W4_URL]: ok(out, W4_URL) });
        const evidence = await check(svc, 'James Conner');
        expect(evidence.code).toBe('OUT_ON_INJURY_REPORT');
        expect(svc.calls).toEqual([W4_URL]);
    });
});
