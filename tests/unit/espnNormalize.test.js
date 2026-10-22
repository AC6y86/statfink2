/**
 * Unit tests for scripts/lib/espnNormalize.js and scripts/lib/espnClient.js.
 * No network, no database: the client is exercised through opts.fetchImpl /
 * opts.sleepImpl with a throwaway cache directory under os.tmpdir().
 *
 * Fixtures in tests/fixtures/espn/ were produced from raw ESPN responses
 * (curl of the summary/scoreboard endpoints, 2025 week 1) with:
 *
 *   node -e '
 *     const fs = require("fs"); const N = require("./scripts/lib/espnNormalize");
 *     const S = "<dir with raw sum.json, s_401772810.json, sb.json>";
 *     fs.writeFileSync("tests/fixtures/espn/summary-401772510.json",
 *       JSON.stringify(N.trimSummary(JSON.parse(fs.readFileSync(S + "/sum.json", "utf8"))), null, 1));
 *     fs.writeFileSync("tests/fixtures/espn/summary-401772810.json",
 *       JSON.stringify(N.trimSummary(JSON.parse(fs.readFileSync(S + "/s_401772810.json", "utf8"))), null, 1));
 *     fs.writeFileSync("tests/fixtures/espn/scoreboard-2025-wk1.json",
 *       JSON.stringify(N.trimScoreboard(JSON.parse(fs.readFileSync(S + "/sb.json", "utf8"))), null, 1));
 *   '
 *
 * summary-401772510 = DAL @ PHI (Thu, 2025 wk1, PHI 24-20)
 * summary-401772810 = MIN @ CHI (Mon, 2025 wk1, MIN 27-24; one 2-pt pass
 *                     conversion and one failed 2-pt pass)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const N = require('../../scripts/lib/espnNormalize');
const C = require('../../scripts/lib/espnClient');

const FIX = path.join(__dirname, '..', 'fixtures', 'espn');
const load = f => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));

const dalPhi = load('summary-401772510.json');
const minChi = load('summary-401772810.json');
const scoreboard = load('scoreboard-2025-wk1.json');

const isNum = v => typeof v === 'number' && Number.isFinite(v);

// A tiny synthetic summary using ESPN's WSH code, a group with labels but no
// keys, a successful 2-pt run, a failed 2-pt, and an unresolvable 2-pt name.
function syntheticWsh() {
    return {
        header: { competitions: [{
            status: { type: { name: 'STATUS_FINAL', completed: true } },
            competitors: [
                { homeAway: 'home', team: { abbreviation: 'WSH' }, score: '31' },
                { homeAway: 'away', team: { abbreviation: 'NYG' }, score: '6' }
            ]
        }] },
        boxscore: {
            teams: [
                { team: { abbreviation: 'WSH' }, statistics: [{ name: 'totalYards', displayValue: '410' }, { name: 'turnovers', displayValue: '0' }] },
                { team: { abbreviation: 'NYG' }, statistics: [{ name: 'totalYards', displayValue: '188' }, { name: 'turnovers', displayValue: '3' }] }
            ],
            players: [
                { team: { abbreviation: 'WSH' }, statistics: [
                    { name: 'rushing', labels: ['CAR', 'YDS', 'AVG', 'TD', 'LONG'],
                      athletes: [{ athlete: { id: '111', displayName: 'Jayden Daniels' }, stats: ['8', '55', '6.9', '1', '20'] }] },
                    { name: 'passing', keys: ['completions/passingAttempts', 'passingYards', 'passingTouchdowns', 'interceptions', 'sacks-sackYardsLost'],
                      athletes: [{ athlete: { id: '111', displayName: 'Jayden Daniels' }, stats: ['20/30', '250', '2', '1', '3-21'] }] },
                    { name: 'defensive', keys: ['totalTackles', 'sacks'],
                      athletes: [{ athlete: { id: '222', displayName: 'Bobby Wagner' }, stats: ['9', '1.5'] }, { athlete: { id: '223', displayName: 'Frankie Luvu' }, stats: ['4', '1'] }] },
                    { name: 'interceptions', keys: ['interceptions', 'interceptionYards', 'interceptionTouchdowns'],
                      athletes: [{ athlete: { id: '224', displayName: 'Mike Sainristil' }, stats: ['2', '30', '0'] }] }
                ] },
                { team: { abbreviation: 'NYG' }, statistics: [
                    { name: 'passing', keys: ['completions/passingAttempts', 'passingYards', 'passingTouchdowns', 'interceptions'],
                      athletes: [{ athlete: { id: '333', displayName: 'Russell Wilson' }, stats: ['15/30', '160', '0', '2'] }] }
                ] }
            ]
        },
        scoringPlays: [
            { type: { text: 'Rushing Touchdown' }, text: 'Jayden Daniels 5 Yd Rush (Jayden Daniels Run for Two-Point Conversion)', team: { abbreviation: 'WSH' } },
            { type: { text: 'Passing Touchdown' }, text: 'Terry McLaurin 9 Yd pass from Jayden Daniels (Two-Point Run Conversion Failed)', team: { abbreviation: 'WSH' } },
            { type: { text: 'Passing Touchdown' }, text: 'Zach Ertz 3 Yd pass from Jayden Daniels (Jayden Daniels Pass to Ghost Player for Two-Point Conversion)', team: { abbreviation: 'WSH' } },
            { type: { text: 'Safety' }, text: 'Bobby Wagner Safety', team: { abbreviation: 'WSH' } },
            { type: { text: 'Safety' }, text: 'Another Safety', team: { abbreviation: 'WSH' } }
        ],
        drives: { previous: [] }
    };
}

describe('espnNormalize.playerLines (DAL @ PHI)', () => {
    const { lines, unresolvedTwoPoint } = N.playerLines(dalPhi, { gameId: '20250904_DAL@PHI', eventId: '401772510' });

    test('returns an object with a Map of lines and no unresolved 2-pt names', () => {
        expect(lines).toBeInstanceOf(Map);
        expect(unresolvedTwoPoint).toEqual([]);
        expect(lines.size).toBeGreaterThan(40);
    });

    test('Dak Prescott: 188 passing yards, 0 passing TDs, split C/ATT in raw', () => {
        const dak = lines.get('2577417');
        expect(dak.name).toBe('Dak Prescott');
        expect(dak.team).toBe('DAL');
        expect(dak.gameId).toBe('20250904_DAL@PHI');
        expect(dak.eventId).toBe('401772510');
        expect(dak.passing_yards).toBe(188);
        expect(dak.passing_tds).toBe(0);
        expect(dak.interceptions).toBe(0);
        expect(dak.raw.passing.completions).toBe('21');
        expect(dak.raw.passing.passingAttempts).toBe('34');
        expect(dak.raw.passing.sacks).toBe('0');
        expect(dak.raw.passing.sackYardsLost).toBe('0');
    });

    test('Brandon Aubrey: FG 2/2, XP 2/2', () => {
        const k = lines.get('3953687');
        expect(k.field_goals_made).toBe(2);
        expect(k.field_goals_attempted).toBe(2);
        expect(k.extra_points_made).toBe(2);
        expect(k.extra_points_attempted).toBe(2);
    });

    test('Jake Elliott: XP 3/3, FG 1/1', () => {
        const k = lines.get('3050478');
        expect(k.extra_points_made).toBe(3);
        expect(k.extra_points_attempted).toBe(3);
        expect(k.field_goals_made).toBe(1);
        expect(k.field_goals_attempted).toBe(1);
    });

    test('Jalen Hurts: rushing line and 1-8 sack split', () => {
        const h = lines.get('4040715');
        expect(h.team).toBe('PHI');
        expect(h.rushing_yards).toBe(62);
        expect(h.rushing_tds).toBe(2);
        expect(h.passing_yards).toBe(152);
        expect(h.raw.passing.sacks).toBe('1');
        expect(h.raw.passing.sackYardsLost).toBe('8');
    });

    test('defense-only athletes are present with all-zero lines', () => {
        const hooker = lines.get('3121415');
        expect(hooker.name).toBe('Malik Hooker');
        for (const col of N.NUMERIC_COLUMNS) expect(hooker[col]).toBe(0);
    });

    test('every numeric column is a Number on every line', () => {
        for (const line of lines.values()) {
            for (const col of N.NUMERIC_COLUMNS) expect(isNum(line[col])).toBe(true);
        }
    });
});

describe('espnNormalize.dstLines + gameFacts (DAL @ PHI)', () => {
    const dst = N.dstLines(dalPhi, { gameId: '20250904_DAL@PHI', eventId: '401772510' });

    test('DEF_PHI allowed 20 points and 307 yards', () => {
        const phi = dst.get('DEF_PHI');
        expect(phi.points_allowed).toBe(20);
        expect(phi.yards_allowed).toBe(307);
        expect(phi.safeties).toBe(0);
        expect(phi.gameId).toBe('20250904_DAL@PHI');
    });

    test('DEF_DAL allowed 24 points and 302 yards, 1 sack', () => {
        const dal = dst.get('DEF_DAL');
        expect(dal.points_allowed).toBe(24);
        expect(dal.yards_allowed).toBe(302);
        expect(dal.sacks).toBe(1);
        expect(dal.def_interceptions).toBe(0);
    });

    test('never sets defensive-TD columns', () => {
        for (const line of dst.values()) {
            expect(line).not.toHaveProperty('def_touchdowns');
            expect(line).not.toHaveProperty('def_int_return_tds');
            expect(line).not.toHaveProperty('def_fumble_return_tds');
            expect(line).not.toHaveProperty('def_blocked_return_tds');
        }
    });

    test('gameFacts', () => {
        expect(N.gameFacts(dalPhi)).toEqual({
            home: 'PHI', away: 'DAL', homeScore: 24, awayScore: 20,
            completed: true, statusName: 'STATUS_FINAL',
            totalYards: { PHI: 302, DAL: 307 },
            turnovers: { PHI: 0, DAL: 1 }
        });
    });
});

describe('espnNormalize two-point conversions (MIN @ CHI)', () => {
    const { lines, unresolvedTwoPoint } = N.playerLines(minChi, { gameId: '20250908_MIN@CHI', eventId: '401772810' });

    test('Adam Thielen rec 1, J.J. McCarthy pass 1, failed attempt ignored', () => {
        expect(lines.get('16460').name).toBe('Adam Thielen');
        expect(lines.get('16460').two_point_conversions_rec).toBe(1);
        expect(lines.get('4433970').name).toBe('J.J. McCarthy');
        expect(lines.get('4433970').two_point_conversions_pass).toBe(1);
        expect(unresolvedTwoPoint).toEqual([]);
    });

    test('exactly one successful 2-pt conversion in the game', () => {
        let pass = 0, run = 0, rec = 0;
        for (const l of lines.values()) {
            pass += l.two_point_conversions_pass;
            run += l.two_point_conversions_run;
            rec += l.two_point_conversions_rec;
        }
        expect(pass).toBe(1);
        expect(run).toBe(0);
        expect(rec).toBe(1);
    });

    test('Nahshon Wright INT return TD shows in raw interceptions, not on a player column', () => {
        const wright = [...lines.values()].find(l => l.name === 'Nahshon Wright');
        expect(wright.team).toBe('CHI');
        expect(wright.raw.interceptions.interceptionTouchdowns).toBe('1');
    });

    test('DST sacks and interceptions summed from athletes', () => {
        const dst = N.dstLines(minChi);
        expect(dst.get('DEF_CHI').def_interceptions).toBe(1);
        expect(dst.get('DEF_CHI').points_allowed).toBe(27);
        expect(dst.get('DEF_MIN').points_allowed).toBe(24);
    });
});

describe('espnNormalize synthetic WSH input', () => {
    const summary = syntheticWsh();
    const { lines, unresolvedTwoPoint } = N.playerLines(summary, { gameId: 'x', eventId: '1' });

    test('WSH canonicalizes to WAS on player and DST lines', () => {
        expect(lines.get('111').team).toBe('WAS');
        expect(lines.get('333').team).toBe('NYG');
        const dst = N.dstLines(summary);
        expect([...dst.keys()].sort()).toEqual(['DEF_NYG', 'DEF_WAS']);
        expect(dst.get('DEF_WAS').points_allowed).toBe(6);
        expect(dst.get('DEF_WAS').yards_allowed).toBe(188);
        expect(dst.get('DEF_WAS').sacks).toBe(2.5);
        expect(dst.get('DEF_WAS').def_interceptions).toBe(2);
        expect(dst.get('DEF_WAS').safeties).toBe(2);
        expect(dst.get('DEF_NYG').safeties).toBe(0);
        expect(N.gameFacts(summary).home).toBe('WAS');
    });

    test('labels fallback when keys are missing', () => {
        expect(lines.get('111').rushing_yards).toBe(55);
        expect(lines.get('111').rushing_tds).toBe(1);
        expect(lines.get('111').passing_yards).toBe(250);
        expect(lines.get('111').passing_tds).toBe(2);
    });

    test('2-pt run credited, failed ignored, unknown name reported', () => {
        expect(lines.get('111').two_point_conversions_run).toBe(1);
        expect(lines.get('111').two_point_conversions_pass).toBe(1);
        expect(lines.get('111').two_point_conversions_rec).toBe(0);
        expect(unresolvedTwoPoint).toEqual([{
            text: 'Zach Ertz 3 Yd pass from Jayden Daniels (Jayden Daniels Pass to Ghost Player for Two-Point Conversion)',
            name: 'Ghost Player'
        }]);
    });

    test('missing groups yield zeros, not undefined', () => {
        const rw = lines.get('333');
        expect(rw.rushing_yards).toBe(0);
        expect(rw.field_goals_made).toBe(0);
        expect(rw.raw.rushing).toBeUndefined();
    });
});

describe('espnNormalize.normalizeName / parseTwoPoint', () => {
    test('strips suffixes and periods, keeps hyphens and apostrophes', () => {
        expect(N.normalizeName('Aaron Jones Sr.')).toBe('aaron jones');
        expect(N.normalizeName('J.J. McCarthy')).toBe('jj mccarthy');
        expect(N.normalizeName('Luther Burden III')).toBe('luther burden');
        expect(N.normalizeName('Odell Beckham Jr.')).toBe('odell beckham');
        expect(N.normalizeName("D'Andre Swift")).toBe("d'andre swift");
        expect(N.normalizeName('Ihmir Smith-Marsette')).toBe('ihmir smith-marsette');
        expect(N.normalizeName('  Kenneth   Walker  IV ')).toBe('kenneth walker');
    });

    test('parseTwoPoint', () => {
        expect(N.parseTwoPoint('A 1 Yd Rush (B Pass to C for Two-Point Conversion)')).toEqual({ kind: 'pass', passer: 'B', receiver: 'C' });
        expect(N.parseTwoPoint('A 1 Yd Rush (B Run for Two-Point Conversion)')).toEqual({ kind: 'run', rusher: 'B' });
        expect(N.parseTwoPoint('A 1 Yd Rush (Two-Point Pass Conversion Failed)')).toBeNull();
        expect(N.parseTwoPoint('A 1 Yd Rush (K Kick)')).toBeNull();
        expect(N.parseTwoPoint('A 1 Yd Rush (Defensive Two-Point Conversion)')).toEqual({ kind: 'unknown', inner: 'Defensive Two-Point Conversion' });
    });
});

describe('espnNormalize.trimSummary', () => {
    test('keeps header, boxscore, scoringPlays and slim drives; drops junk', () => {
        const raw = JSON.parse(JSON.stringify(dalPhi));
        raw.news = { big: 'x'.repeat(1000) };
        raw.videos = [1, 2, 3];
        raw.odds = [{}];
        raw.pickcenter = [{}];
        raw.winprobability = [{}];
        raw.article = {};
        raw.standings = {};
        raw.leaders = [];
        raw.injuries = [];
        raw.broadcasts = [];
        const t = N.trimSummary(raw);
        expect(Object.keys(t).sort()).toEqual(['boxscore', 'drives', 'header', 'scoringPlays']);
        expect(t.scoringPlays).toHaveLength(8);
        expect(t.scoringPlays[0].type.text).toBe('Rushing Touchdown');
        expect(t.scoringPlays[0].team.abbreviation).toBe('DAL');
        expect(t.drives.previous).toHaveLength(16);
        expect(t.drives.previous[0].team.abbreviation).toBe('DAL');
        expect(t.drives.previous[0].plays.length).toBeGreaterThan(0);
        const play = t.drives.previous[0].plays[0];
        expect(Object.keys(play).sort()).toEqual(['awayScore', 'clock', 'end', 'homeScore', 'id', 'isTurnover', 'period', 'scoringPlay', 'start', 'text', 'type']);
        expect(play.start.team).toEqual({ id: '21' });
        expect(t.header.competitions[0].competitors.map(c => c.team.abbreviation).sort()).toEqual(['DAL', 'PHI']);
        expect(t.boxscore.players).toHaveLength(2);
    });

    test('fixtures are well under 300 KB', () => {
        for (const f of ['summary-401772510.json', 'summary-401772810.json', 'scoreboard-2025-wk1.json']) {
            expect(fs.statSync(path.join(FIX, f)).size).toBeLessThan(300 * 1024);
        }
    });

    test('trimmed output still normalizes identically', () => {
        const again = N.trimSummary(dalPhi);
        expect(N.playerLines(again).lines.get('2577417').passing_yards).toBe(188);
        expect(N.dstLines(again).get('DEF_PHI').yards_allowed).toBe(307);
    });
});

describe('espnClient.matchEventsToGames', () => {
    test('matches DAL@PHI and NYG@WAS (ESPN WSH), reports unmatched', () => {
        const nflGames = [
            { game_id: '20250904_DAL@PHI', home_team: 'PHI', away_team: 'DAL', status: 'Final' },
            { game_id: '20250907_NYG@WAS', home_team: 'WAS', away_team: 'NYG', status: 'Final' },
            { game_id: '20250907_ZZZ@QQQ', home_team: 'QQQ', away_team: 'ZZZ', status: 'Scheduled' }
        ];
        const { matches, unmatchedEvents, unmatchedGames } = C.matchEventsToGames(scoreboard.events, nflGames);
        expect(matches).toHaveLength(2);
        const dal = matches.find(m => m.gameId === '20250904_DAL@PHI');
        expect(dal).toEqual({
            eventId: '401772510', gameId: '20250904_DAL@PHI', home: 'PHI', away: 'DAL',
            espnStatus: 'STATUS_FINAL', completed: true, homeScore: 24, awayScore: 20
        });
        const was = matches.find(m => m.gameId === '20250907_NYG@WAS');
        expect(was.eventId).toBe('401772827');
        expect(was.home).toBe('WAS');
        expect(unmatchedGames).toEqual([{ game_id: '20250907_ZZZ@QQQ', home_team: 'QQQ', away_team: 'ZZZ', status: 'Scheduled' }]);
        expect(unmatchedEvents).toHaveLength(scoreboard.events.length - 2);
        expect(unmatchedEvents.map(e => e.eventId)).not.toContain('401772510');
    });

    test('neutral-site game (KC VS LAC) still matches by homeAway', () => {
        const { matches } = C.matchEventsToGames(scoreboard.events, [
            { game_id: '20250905_KC@LAC', home_team: 'LAC', away_team: 'KC', status: 'Final' }
        ]);
        expect(matches).toHaveLength(1);
        expect(matches[0].eventId).toBe('401772714');
    });

    test('handles empty inputs', () => {
        expect(C.matchEventsToGames([], [])).toEqual({ matches: [], unmatchedEvents: [], unmatchedGames: [] });
    });
});

// ---------- client: fetch/retry/throttle/cache with a fake fetch ----------

function makeFetch(script) {
    // script: url -> array of responses (each {status, body} or Error), consumed in order; last one repeats
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        const list = script[url] || script['*'];
        if (!list) throw new Error(`unexpected url ${url}`);
        const step = list.length > 1 ? list.shift() : list[0];
        if (step instanceof Error) throw step;
        return { ok: step.status >= 200 && step.status < 300, status: step.status, json: async () => step.body };
    };
    return { fetchImpl, calls };
}

function makeSleep() {
    const sleeps = [];
    const sleepImpl = async ms => { sleeps.push(ms); };
    return { sleepImpl, sleeps };
}

describe('espnClient.fetchJson', () => {
    beforeEach(() => C.resetThrottle());

    test('retries on 5xx with 2s/5s backoff and sends the User-Agent', async () => {
        const { fetchImpl, calls } = makeFetch({ '*': [{ status: 503 }, { status: 500 }, { status: 200, body: { ok: 1 } }] });
        const { sleepImpl, sleeps } = makeSleep();
        const body = await C.fetchJson('u', { fetchImpl, sleepImpl, sleepMs: 0 });
        expect(body).toEqual({ ok: 1 });
        expect(calls).toHaveLength(3);
        expect(calls[0].init.headers['User-Agent']).toBe('statfink2-doublecheck');
        expect(calls[0].init.signal).toBeDefined();
        expect(sleeps).toEqual([2000, 5000]);
    });

    test('retries on 429 and network errors, gives up after 4 attempts', async () => {
        const { fetchImpl, calls } = makeFetch({ '*': [{ status: 429 }, new Error('ECONNRESET'), { status: 502 }, { status: 503 }] });
        const { sleepImpl, sleeps } = makeSleep();
        await expect(C.fetchJson('u', { fetchImpl, sleepImpl, sleepMs: 0 })).rejects.toThrow(/failed after 4 attempts.*HTTP 503/);
        expect(calls).toHaveLength(4);
        expect(sleeps).toEqual([2000, 5000, 10000]);
    });

    test('does not retry a 404', async () => {
        const { fetchImpl, calls } = makeFetch({ '*': [{ status: 404 }] });
        const { sleepImpl, sleeps } = makeSleep();
        await expect(C.fetchJson('u', { fetchImpl, sleepImpl, sleepMs: 0 })).rejects.toThrow('HTTP 404');
        expect(calls).toHaveLength(1);
        expect(sleeps).toEqual([]);
    });

    test('module-level throttle sleeps between consecutive live calls', async () => {
        const { fetchImpl } = makeFetch({ '*': [{ status: 200, body: {} }] });
        const { sleepImpl, sleeps } = makeSleep();
        await C.fetchJson('a', { fetchImpl, sleepImpl });
        expect(sleeps).toEqual([]);                      // first call never waits
        await C.fetchJson('b', { fetchImpl, sleepImpl });
        expect(sleeps).toHaveLength(1);
        expect(sleeps[0]).toBeGreaterThan(0);
        expect(sleeps[0]).toBeLessThanOrEqual(C.DEFAULT_SLEEP_MS);
    });
});

describe('espnClient cache behaviour', () => {
    let cacheDir;
    beforeEach(() => {
        C.resetThrottle();
        cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statfink2-espn-test-'));
    });
    afterEach(() => fs.rmSync(cacheDir, { recursive: true, force: true }));

    const sbUrl = C.scoreboardUrl(2025, 1);
    const quiet = { sleepMs: 0, sleepImpl: async () => {} };

    test('fetchScoreboard caches and reuses a fully-completed scoreboard', async () => {
        const { fetchImpl, calls } = makeFetch({ [sbUrl]: [{ status: 200, body: scoreboard }] });
        const a = await C.fetchScoreboard(2025, 1, { ...quiet, fetchImpl, cacheDir });
        expect(a.events).toHaveLength(16);
        const cached = JSON.parse(fs.readFileSync(path.join(cacheDir, 'scoreboard.json'), 'utf8'));
        expect(cached.completed).toBe(true);
        expect(cached.season).toBe(2025);
        const b = await C.fetchScoreboard(2025, 1, { ...quiet, fetchImpl, cacheDir });
        expect(b.events).toHaveLength(16);
        expect(calls).toHaveLength(1);
    });

    test('fetchScoreboard refetches when any cached event is not completed', async () => {
        const inProgress = JSON.parse(JSON.stringify(scoreboard));
        inProgress.events[3].competitions[0].status.type.completed = false;
        const { fetchImpl, calls } = makeFetch({ [sbUrl]: [{ status: 200, body: inProgress }, { status: 200, body: scoreboard }] });
        await C.fetchScoreboard(2025, 1, { ...quiet, fetchImpl, cacheDir });
        expect(JSON.parse(fs.readFileSync(path.join(cacheDir, 'scoreboard.json'), 'utf8')).completed).toBe(false);
        await C.fetchScoreboard(2025, 1, { ...quiet, fetchImpl, cacheDir });
        expect(calls).toHaveLength(2);
        // offline reuses whatever is cached, even in-progress
        await C.fetchScoreboard(2025, 1, { ...quiet, fetchImpl, cacheDir, offline: true });
        expect(calls).toHaveLength(2);
    });

    test('fetchScoreboard rejects a season/week mismatch and offline-without-cache', async () => {
        const { fetchImpl } = makeFetch({ '*': [{ status: 200, body: scoreboard }] });
        await expect(C.fetchScoreboard(2025, 2, { ...quiet, fetchImpl, cacheDir })).rejects.toThrow(/mismatch.*week 2.*week 1/);
        await expect(C.fetchScoreboard(2025, 1, { ...quiet, fetchImpl, cacheDir, offline: true })).rejects.toThrow(/offline/);
    });

    test('fetchSummary caches completed games permanently', async () => {
        const url = C.summaryUrl('401772510');
        const { fetchImpl, calls } = makeFetch({ [url]: [{ status: 200, body: dalPhi }] });
        const a = await C.fetchSummary('401772510', { ...quiet, fetchImpl, cacheDir });
        expect(a.header.competitions[0].competitors).toHaveLength(2);
        const file = path.join(cacheDir, 'summary-401772510.json');
        const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
        expect(rec.completed).toBe(true);
        expect(rec.eventId).toBe('401772510');
        expect(rec.fetchedAt).toMatch(/^\d{4}-/);
        expect(rec.body.scoringPlays).toHaveLength(8);
        const b = await C.fetchSummary('401772510', { ...quiet, fetchImpl, cacheDir });
        expect(b.scoringPlays).toHaveLength(8);
        expect(calls).toHaveLength(1);
        expect(fs.existsSync(path.join(cacheDir, 'summary-401772510.partial.json'))).toBe(false);
    });

    test('fetchSummary writes .partial.json for in-progress games and refetches', async () => {
        const live = JSON.parse(JSON.stringify(dalPhi));
        live.header.competitions[0].status.type = { name: 'STATUS_IN_PROGRESS', completed: false };
        const url = C.summaryUrl('401772510');
        const { fetchImpl, calls } = makeFetch({ [url]: [{ status: 200, body: live }, { status: 200, body: live }, { status: 200, body: dalPhi }] });
        const o = { ...quiet, fetchImpl, cacheDir };
        await C.fetchSummary('401772510', o);
        expect(fs.existsSync(path.join(cacheDir, 'summary-401772510.partial.json'))).toBe(true);
        expect(fs.existsSync(path.join(cacheDir, 'summary-401772510.json'))).toBe(false);
        await C.fetchSummary('401772510', o);
        expect(calls).toHaveLength(2);
        // offline: partial is allowed, no network
        const off = await C.fetchSummaryWithMeta('401772510', { ...o, offline: true });
        expect(off.source).toBe('partial-cache');
        expect(off.completed).toBe(false);
        expect(calls).toHaveLength(2);
        // offline and nothing cached -> null
        expect(await C.fetchSummary('999', { ...o, offline: true })).toBeNull();
        // game goes final: permanent file written, partial removed
        const fin = await C.fetchSummaryWithMeta('401772510', o);
        expect(fin.source).toBe('network');
        expect(fin.completed).toBe(true);
        expect(fs.existsSync(path.join(cacheDir, 'summary-401772510.json'))).toBe(true);
        expect(fs.existsSync(path.join(cacheDir, 'summary-401772510.partial.json'))).toBe(false);
    });

    test('fetchWeek records a per-game failure without throwing', async () => {
        const { fetchImpl, calls } = makeFetch({
            [sbUrl]: [{ status: 200, body: scoreboard }],
            [C.summaryUrl('401772510')]: [{ status: 200, body: dalPhi }],
            [C.summaryUrl('401772810')]: [{ status: 200, body: minChi }],
            [C.summaryUrl('401772827')]: [{ status: 500 }]
        });
        const nflGames = [
            { game_id: '20250904_DAL@PHI', home_team: 'PHI', away_team: 'DAL', status: 'Final' },
            { game_id: '20250908_MIN@CHI', home_team: 'CHI', away_team: 'MIN', status: 'Final' },
            { game_id: '20250907_NYG@WAS', home_team: 'WAS', away_team: 'NYG', status: 'Final' }
        ];
        const r = await C.fetchWeek(2025, 1, nflGames, { ...quiet, fetchImpl, cacheDir });
        expect(r.matches).toHaveLength(3);
        expect(r.summaries.get('20250904_DAL@PHI').scoringPlays).toHaveLength(8);
        expect(r.summaries.get('20250908_MIN@CHI').scoringPlays).toHaveLength(9);
        expect(r.summaries.get('20250907_NYG@WAS')).toBeNull();
        expect(r.status.ok).toBe(false);
        expect(r.status.fetched).toBe(2);
        expect(r.status.cached).toBe(0);
        expect(r.status.failed).toHaveLength(1);
        expect(r.status.failed[0]).toMatchObject({ gameId: '20250907_NYG@WAS', eventId: '401772827' });
        expect(r.status.failed[0].error).toMatch(/HTTP 500/);
        expect(r.unmatchedEvents).toHaveLength(13);
        expect(r.unmatchedGames).toEqual([]);
        // 1 scoreboard + 2 ok summaries + 4 attempts for the failing one
        expect(calls).toHaveLength(7);

        // second run: everything final comes from cache, only the failed one is retried
        const again = await C.fetchWeek(2025, 1, nflGames, { ...quiet, fetchImpl, cacheDir });
        expect(again.status.cached).toBe(2);
        expect(again.status.fetched).toBe(0);
        expect(calls).toHaveLength(11);

        // offline: cached ones present, missing one reported, no network
        const off = await C.fetchWeek(2025, 1, nflGames, { ...quiet, fetchImpl, cacheDir, offline: true });
        expect(off.status.cached).toBe(2);
        expect(off.status.failed[0].error).toMatch(/offline/);
        expect(calls).toHaveLength(11);
    });
});
