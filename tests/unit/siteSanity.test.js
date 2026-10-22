/**
 * scripts/lib/siteSanity.js - public-site probes and ESPN score comparison
 * with fake fetch / tls; the read-only DB helpers on a throwaway sqlite file.
 * Never touches the network or the real database.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const ss = require('../../scripts/lib/siteSanity');

const NOW = Date.parse('2026-09-20T18:00:00Z');
const BASE = 'https://peninsulafootball.com';
const SEASON = 2026;
const WEEK = 2;

// The real shape of GET /api/league/sync-status (curl, 2026-09-14): the
// route fills last_sync_time with the request time; no last_live_update.
const REAL_SYNC_STATUS = {
    success: true,
    data: { last_sync_time: '2026-09-14T00:57:14.754Z', latest_week: 1, weeks_synced: 1, players_synced: 393, latest_season: 2026 }
};

function response({ status = 200, url, body = '', json = null }) {
    return {
        status,
        ok: status >= 200 && status < 300,
        url,
        text: async () => body,
        json: async () => (json !== null ? json : JSON.parse(body))
    };
}

/** fetchImpl keyed by URL; a value may be a response, an Error to throw, or 'hang' (never resolves until abort). */
function fakeFetch(routes) {
    const calls = [];
    const impl = (url, opts = {}) => {
        calls.push(url);
        const r = routes[url];
        if (r === undefined) return Promise.reject(new Error(`unexpected fetch ${url}`));
        if (r instanceof Error) return Promise.reject(r);
        if (r === 'hang') {
            return new Promise((_, reject) => {
                if (opts.signal) opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
            });
        }
        return Promise.resolve(r);
    };
    impl.calls = calls;
    return impl;
}

const days = n => new Date(NOW + n * 86400000);
const tlsOk = async () => ({ validTo: days(60) });
const byName = (signals, name) => signals.find(s => s.name === name);

const healthy = () => fakeFetch({
    [`${BASE}/`]: response({ url: `${BASE}/statfink/${SEASON}/${WEEK}`, body: '<html>league</html>' }),
    [`${BASE}/api/league/sync-status`]: response({ url: `${BASE}/api/league/sync-status`, json: { success: true, data: { last_live_update: new Date(NOW - 30000).toISOString() } } })
});

describe('probePublicSite: public_site', () => {
    test('200 on the week page (via redirect) is ok with url and timing', async () => {
        const signals = await ss.probePublicSite({ baseUrl: BASE, season: SEASON, week: WEEK, live: true, now: NOW, fetchImpl: healthy(), tlsImpl: tlsOk });
        expect(signals.map(s => s.name)).toEqual(['public_site', 'public_api_fresh', 'tls_cert']);
        const site = byName(signals, 'public_site');
        expect(site.ok).toBe(true);
        expect(site.detail).toMatch(/^200 in \d+ ms → https:\/\/peninsulafootball\.com\/statfink\/2026\/2$/);
    });

    test('a page whose body references the week path is ok even without a redirect', async () => {
        const f = fakeFetch({
            [`${BASE}/`]: response({ url: `${BASE}/`, body: `<a href="/statfink/${SEASON}/${WEEK}">week</a>` }),
            [`${BASE}/api/league/sync-status`]: response({ url: '', json: REAL_SYNC_STATUS })
        });
        const [site] = await ss.probePublicSite({ baseUrl: BASE, season: SEASON, week: WEEK, now: NOW, fetchImpl: f, tlsImpl: tlsOk });
        expect(site.ok).toBe(true);
    });

    test('network error -> critical', async () => {
        const f = fakeFetch({ [`${BASE}/`]: new Error('getaddrinfo ENOTFOUND peninsulafootball.com'), [`${BASE}/api/league/sync-status`]: new Error('ENOTFOUND') });
        const [site] = await ss.probePublicSite({ baseUrl: BASE, season: SEASON, week: WEEK, now: NOW, fetchImpl: f, tlsImpl: tlsOk });
        expect(site).toMatchObject({ ok: false, severity: 'critical' });
        expect(site.detail).toContain('unreachable: getaddrinfo ENOTFOUND');
    });

    test('non-200 -> critical with the code', async () => {
        const f = fakeFetch({ [`${BASE}/`]: response({ status: 502, url: `${BASE}/`, body: 'Bad Gateway' }), [`${BASE}/api/league/sync-status`]: response({ status: 502, url: '' }) });
        const [site] = await ss.probePublicSite({ baseUrl: BASE, season: SEASON, week: WEEK, now: NOW, fetchImpl: f, tlsImpl: tlsOk });
        expect(site).toMatchObject({ ok: false, severity: 'critical' });
        expect(site.detail).toMatch(/^HTTP 502 from /);
    });

    test('200 but the page is for another week -> critical naming both weeks', async () => {
        const f = fakeFetch({ [`${BASE}/`]: response({ url: `${BASE}/statfink/2026/1`, body: '' }), [`${BASE}/api/league/sync-status`]: response({ url: '', json: REAL_SYNC_STATUS }) });
        const [site] = await ss.probePublicSite({ baseUrl: BASE, season: SEASON, week: WEEK, now: NOW, fetchImpl: f, tlsImpl: tlsOk });
        expect(site).toMatchObject({ ok: false, severity: 'critical' });
        expect(site.detail).toContain('page is for week 1 not 2');
    });

    test.each([
        [200, '/statfink/2026/1', true],
        [502, '/statfink/2026/1', false],
        [200, '/statfink/2025/1', false],
        [200, '/unrelated', false]
    ])('disabled displayed-week check: HTTP %s at %s -> ok=%s', async (status, pathname, ok) => {
        const f = fakeFetch({
            [`${BASE}/`]: response({ status, url: `${BASE}${pathname}`, body: '' }),
            [`${BASE}/api/league/sync-status`]: response({ url: '', json: REAL_SYNC_STATUS })
        });
        const signals = await ss.probePublicSite({ baseUrl: BASE, season: SEASON, week: WEEK, checkDisplayedWeek: false, now: NOW, fetchImpl: f, tlsImpl: tlsOk });
        const site = byName(signals, 'public_site');
        expect(site.ok).toBe(ok);
        if (ok) expect(site.detail).toContain('displayed-week check disabled');
        else expect(site.severity).toBe('critical');
        expect(signals.map(s => s.name)).toEqual(['public_site', 'public_api_fresh', 'tls_cert']);
    });

    test('timeout -> critical mentioning the timeout', async () => {
        const f = fakeFetch({ [`${BASE}/`]: 'hang', [`${BASE}/api/league/sync-status`]: response({ url: '', json: REAL_SYNC_STATUS }) });
        const [site] = await ss.probePublicSite({ baseUrl: BASE, season: SEASON, week: WEEK, now: NOW, fetchImpl: f, tlsImpl: tlsOk, timeoutMs: 20 });
        expect(site.ok).toBe(false);
        expect(site.detail).toContain('timeout after 20 ms');
    });

    test('without a known season/week (server down, DB unreadable) any 200 is ok', async () => {
        const f = fakeFetch({ [`${BASE}/`]: response({ url: `${BASE}/statfink/2026/1`, body: '' }), [`${BASE}/api/league/sync-status`]: response({ url: '', json: REAL_SYNC_STATUS }) });
        const [site] = await ss.probePublicSite({ baseUrl: BASE, season: null, week: null, now: NOW, fetchImpl: f, tlsImpl: tlsOk });
        expect(site.ok).toBe(true);
    });

    test('a trailing slash on the base URL is tolerated', async () => {
        const f = healthy();
        await ss.probePublicSite({ baseUrl: `${BASE}/`, season: SEASON, week: WEEK, now: NOW, fetchImpl: f, tlsImpl: tlsOk });
        expect(f.calls).toContain(`${BASE}/`);
        expect(f.calls).toContain(`${BASE}/api/league/sync-status`);
    });
});

describe('probePublicSite: public_api_fresh', () => {
    const api = async ({ live, json, siteStatus = 200 }) => {
        const f = fakeFetch({
            [`${BASE}/`]: response({ status: siteStatus, url: `${BASE}/statfink/${SEASON}/${WEEK}` }),
            [`${BASE}/api/league/sync-status`]: json instanceof Error ? json : response({ url: '', json })
        });
        const signals = await ss.probePublicSite({ baseUrl: BASE, season: SEASON, week: WEEK, live, now: NOW, fetchImpl: f, tlsImpl: tlsOk });
        return byName(signals, 'public_api_fresh');
    };

    test('findLiveTimestamp prefers last_live_update, then lastLiveUpdate, then the real last_sync_time', () => {
        expect(ss.findLiveTimestamp(REAL_SYNC_STATUS)).toEqual({ ts: Date.parse('2026-09-14T00:57:14.754Z'), field: 'last_sync_time' });
        expect(ss.findLiveTimestamp({ data: { last_live_update: '2026-09-14 00:50:00', last_sync_time: '2026-09-14T00:57:14.754Z' } }))
            .toEqual({ ts: Date.parse('2026-09-14T00:50:00Z'), field: 'last_live_update' });
        expect(ss.findLiveTimestamp({ data: { lastLiveUpdate: '2026-09-14T00:51:00Z' } }).field).toBe('lastLiveUpdate');
        expect(ss.findLiveTimestamp({ data: { live: { last_live_update: '2026-09-14T00:52:00Z' } } }).field).toBe('last_live_update');
        expect(ss.findLiveTimestamp({ last_live_update: '2026-09-14T00:53:00Z' }).field).toBe('last_live_update');
        expect(ss.findLiveTimestamp({ success: true, data: { latest_week: 1 } })).toBeNull();
        expect(ss.findLiveTimestamp(null)).toBeNull();
    });

    test('live and fresh -> ok naming the field and age', async () => {
        const s = await api({ live: true, json: { data: { last_live_update: new Date(NOW - 45000).toISOString() } } });
        expect(s).toEqual({ name: 'public_api_fresh', ok: true, detail: 'last_live_update 45s ago' });
    });

    test('live and stale (> 5 min) -> warning in minutes', async () => {
        const s = await api({ live: true, json: { data: { last_live_update: new Date(NOW - 9 * 60000).toISOString() } } });
        expect(s).toMatchObject({ ok: false, severity: 'warning' });
        expect(s.detail).toBe('public API last live update 9 min ago (last_live_update)');
    });

    test('not live -> ok idle regardless of age', async () => {
        const s = await api({ live: false, json: { data: { last_live_update: new Date(NOW - 5 * 3600000).toISOString() } } });
        expect(s).toEqual({ name: 'public_api_fresh', ok: true, detail: 'idle' });
    });

    test('the real route shape (last_sync_time = request time) is fresh while live', async () => {
        const s = await api({ live: true, json: { success: true, data: { ...REAL_SYNC_STATUS.data, last_sync_time: new Date(NOW - 200).toISOString() } } });
        expect(s.ok).toBe(true);
        expect(s.detail).toBe('last_sync_time 0s ago');
    });

    test('live with no timestamp at all -> warning', async () => {
        const s = await api({ live: true, json: { success: true, data: { latest_week: 1 } } });
        expect(s).toMatchObject({ ok: false, severity: 'warning' });
        expect(s.detail).toContain('no live-update timestamp');
    });

    test('unreachable while the site is up -> warning; while the site is down -> info only (no double page)', async () => {
        const up = await api({ live: true, json: new Error('ECONNRESET') });
        expect(up).toMatchObject({ ok: false, severity: 'warning' });
        expect(up.detail).toBe('sync-status unreachable: ECONNRESET');
        expect(up.unreachable).toBeUndefined();

        const down = await api({ live: true, json: new Error('ECONNRESET'), siteStatus: 503 });
        expect(down).toEqual({ name: 'public_api_fresh', ok: true, detail: 'sync-status unavailable (site down)' });
    });

    test('non-200 from the API counts as unreachable', async () => {
        const f = fakeFetch({
            [`${BASE}/`]: response({ url: `${BASE}/statfink/${SEASON}/${WEEK}` }),
            [`${BASE}/api/league/sync-status`]: response({ status: 500, url: '', body: 'boom' })
        });
        const s = byName(await ss.probePublicSite({ baseUrl: BASE, season: SEASON, week: WEEK, live: true, now: NOW, fetchImpl: f, tlsImpl: tlsOk }), 'public_api_fresh');
        expect(s).toMatchObject({ ok: false, severity: 'warning', detail: 'sync-status unreachable: HTTP 500' });
    });
});

describe('probePublicSite: tls_cert', () => {
    const tls = async tlsImpl => byName(await ss.probePublicSite({ baseUrl: BASE, season: SEASON, week: WEEK, now: NOW, fetchImpl: healthy(), tlsImpl }), 'tls_cert');

    test('thresholds: >= 14 days ok, < 14 warning, < 3 critical, expired critical', async () => {
        expect(await tls(async () => ({ validTo: days(60) }))).toEqual({ name: 'tls_cert', ok: true, detail: 'expires in 60 days' });
        expect(await tls(async () => ({ validTo: days(14) }))).toMatchObject({ ok: true, detail: 'expires in 14 days' });
        const warn = await tls(async () => ({ validTo: days(13.5) }));
        expect(warn).toMatchObject({ ok: false, severity: 'warning' });
        expect(warn.detail).toContain('expires in 13 days');
        expect(await tls(async () => ({ validTo: days(3) }))).toMatchObject({ ok: false, severity: 'warning' });
        const crit = await tls(async () => ({ validTo: days(2.9) }));
        expect(crit).toMatchObject({ ok: false, severity: 'critical' });
        expect(crit.detail).toContain('expires in 2 day(s)');
        expect((await tls(async () => ({ validTo: days(-1) }))).detail).toContain('EXPIRED');
    });

    test('valid_to as a string (openssl format) is parsed', async () => {
        const s = await tls(async () => ({ validTo: 'Nov 19 18:00:00 2026 GMT' }));
        expect(s.ok).toBe(true);
        expect(s.detail).toBe('expires in 60 days');
    });

    test('tls error -> warning, never critical', async () => {
        const s = await tls(async () => { throw new Error('socket hang up'); });
        expect(s).toEqual({ name: 'tls_cert', ok: false, severity: 'warning', detail: 'TLS check failed: socket hang up' });
    });

    test('http base URL -> ok (nothing to check)', async () => {
        const f = fakeFetch({
            'http://localhost:8000/': response({ url: `http://localhost:8000/statfink/${SEASON}/${WEEK}` }),
            'http://localhost:8000/api/league/sync-status': response({ url: '', json: REAL_SYNC_STATUS })
        });
        const s = byName(await ss.probePublicSite({ baseUrl: 'http://localhost:8000', season: SEASON, week: WEEK, now: NOW, fetchImpl: f, tlsImpl: async () => { throw new Error('should not be called'); } }), 'tls_cert');
        expect(s).toEqual({ name: 'tls_cert', ok: true, detail: 'not https' });
    });

    test('the default tlsImpl exists and takes a URL', () => {
        expect(typeof ss.defaultTlsImpl).toBe('function');
    });
});

describe('compareScoresToEspn', () => {
    const sqliteTs = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
    const game = (id, over = {}) => ({
        game_id: id, home_team: 'KC', away_team: 'LAC', home_score: 17, away_score: 21, status: 'Q3 5:00',
        last_updated: sqliteTs(NOW - 30000), ...over
    });
    const match = (gameId, over = {}) => ({
        eventId: '1', gameId, home: 'KC', away: 'LAC', espnStatus: 'STATUS_IN_PROGRESS', completed: false, homeScore: 17, awayScore: 21, ...over
    });

    test('not live -> idle', () => {
        expect(ss.compareScoresToEspn({ live: false, matches: [match('G1')], nflGames: [game('G1')], now: NOW }))
            .toEqual({ name: 'scores_vs_espn', ok: true, detail: 'idle' });
    });

    test('ESPN unavailable (matches null) -> ok info, never colours', () => {
        expect(ss.compareScoresToEspn({ live: true, matches: null, nflGames: [game('G1')], now: NOW }))
            .toEqual({ name: 'scores_vs_espn', ok: true, detail: 'ESPN scoreboard unavailable' });
    });

    test('scores equal -> ok counting the games checked', () => {
        const r = ss.compareScoresToEspn({ live: true, matches: [match('G1'), match('G2', { espnStatus: 'STATUS_SCHEDULED' })], nflGames: [game('G1'), game('G2', { status: 'Scheduled' })], now: NOW });
        expect(r).toEqual({ name: 'scores_vs_espn', ok: true, detail: '1 game(s) match ESPN' });
    });

    test('no ESPN game active yet -> ok', () => {
        const r = ss.compareScoresToEspn({ live: true, matches: [match('G1', { espnStatus: 'STATUS_SCHEDULED' })], nflGames: [game('G1')], now: NOW });
        expect(r.detail).toBe('no ESPN game in progress yet');
    });

    test('scores differ but ours was just rewritten -> ok (Tank01 lag within 5 min is normal)', () => {
        const r = ss.compareScoresToEspn({ live: true, matches: [match('G1', { homeScore: 24 })], nflGames: [game('G1')], now: NOW });
        expect(r.ok).toBe(true);
    });

    test('scores differ and ours is older than 5 min -> warning listing the game', () => {
        const r = ss.compareScoresToEspn({ live: true, matches: [match('G1', { homeScore: 24 })], nflGames: [game('G1', { last_updated: sqliteTs(NOW - 9 * 60000) })], now: NOW });
        expect(r).toMatchObject({ name: 'scores_vs_espn', ok: false, severity: 'warning' });
        expect(r.detail).toBe('1 of 1 game(s) behind ESPN: LAC@KC espn 21-24, ours 21-17, ours updated 9 min ago');
    });

    test('scores equal but stale ours -> ok (nothing has changed to miss)', () => {
        const r = ss.compareScoresToEspn({ live: true, matches: [match('G1')], nflGames: [game('G1', { last_updated: sqliteTs(NOW - 30 * 60000) })], now: NOW });
        expect(r.ok).toBe(true);
    });

    test('ESPN completed, ours not Final, ours updated > 20 min ago -> warning; within 20 min -> ok', () => {
        const done = match('G1', { espnStatus: 'STATUS_FINAL', completed: true });
        const late = ss.compareScoresToEspn({ live: true, matches: [done], nflGames: [game('G1', { last_updated: sqliteTs(NOW - 25 * 60000) })], now: NOW });
        expect(late).toMatchObject({ ok: false, severity: 'warning' });
        expect(late.detail).toContain("(ESPN final, ours 'Q3 5:00')");
        const soon = ss.compareScoresToEspn({ live: true, matches: [done], nflGames: [game('G1', { last_updated: sqliteTs(NOW - 10 * 60000) })], now: NOW });
        expect(soon.ok).toBe(true);
        const ours = ss.compareScoresToEspn({ live: true, matches: [done], nflGames: [game('G1', { status: 'Final/OT', last_updated: sqliteTs(NOW - 3 * 3600000) })], now: NOW });
        expect(ours.ok).toBe(true);
    });

    test('last_updated never -> treated as stale', () => {
        const r = ss.compareScoresToEspn({ live: true, matches: [match('G1', { homeScore: 24 })], nflGames: [game('G1', { last_updated: null })], now: NOW });
        expect(r.ok).toBe(false);
        expect(r.detail).toContain('ours updated never');
    });

    test('lists at most 5 games and counts the rest', () => {
        const matches = [];
        const games = [];
        for (let i = 0; i < 7; i++) {
            matches.push(match(`G${i}`, { homeScore: 30 + i }));
            games.push(game(`G${i}`, { last_updated: sqliteTs(NOW - 10 * 60000) }));
        }
        const r = ss.compareScoresToEspn({ live: true, matches, nflGames: games, now: NOW });
        expect(r.detail.startsWith('7 of 7 game(s) behind ESPN: ')).toBe(true);
        expect(r.detail.split('; ')).toHaveLength(5);
        expect(r.detail.endsWith(' and 2 more')).toBe(true);
    });

    test('unknown gameId in matches is ignored; halftime counts as active; last_updated may be ms', () => {
        const r = ss.compareScoresToEspn({
            live: true,
            matches: [match('NOPE', { homeScore: 99 }), match('G1', { espnStatus: 'STATUS_HALFTIME', homeScore: 24 })],
            nflGames: [game('G1', { last_updated: NOW - 6 * 60000 })], now: NOW
        });
        expect(r.ok).toBe(false);
        expect(r.detail).toContain('1 of 1 game(s)');
    });
});

describe('read-only DB helpers and the ESPN cache', () => {
    let dir;
    let dbPath;

    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-sanity-'));
        dbPath = path.join(dir, 'games.db');
        const db = new sqlite3.Database(dbPath);
        const run = sql => new Promise((res, rej) => db.run(sql, e => (e ? rej(e) : res())));
        await run(`CREATE TABLE nfl_games (game_id TEXT PRIMARY KEY, week INTEGER, season INTEGER, home_team TEXT, away_team TEXT,
                   home_score INTEGER, away_score INTEGER, status TEXT, last_updated DATETIME, game_time_epoch INTEGER)`);
        await run(`INSERT INTO nfl_games VALUES ('20260920_LAC@KC', 2, 2026, 'KC', 'LAC', 17, 21, 'Q3 5:00', '2026-09-20 17:59:30', 1789000000)`);
        await run(`INSERT INTO nfl_games VALUES ('20260920_DAL@WSH', 2, 2026, 'WSH', 'DAL', 0, 0, NULL, NULL, 1789003600)`);
        await run(`INSERT INTO nfl_games VALUES ('20260913_X@Y', 1, 2026, 'NYG', 'DAL', 3, 6, 'Final', '2026-09-14 03:00:00', 1788400000)`);
        await run(`CREATE TABLE league_settings (league_id INTEGER, season_year INTEGER, current_week INTEGER)`);
        await run(`INSERT INTO league_settings VALUES (1, 2026, 2)`);
        await new Promise(res => db.close(res));
    });

    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('readWeekGamesReadOnly canonicalises teams, defaults status and parses last_updated as UTC', async () => {
        const rows = await ss.readWeekGamesReadOnly(dbPath, 2026, 2);
        expect(rows.map(r => r.game_id)).toEqual(['20260920_LAC@KC', '20260920_DAL@WSH']);
        expect(rows[0]).toMatchObject({ home_team: 'KC', away_team: 'LAC', home_score: 17, away_score: 21, status: 'Q3 5:00', game_time_epoch: 1789000000 });
        expect(rows[0].last_updated_ms).toBe(Date.parse('2026-09-20T17:59:30Z'));
        expect(rows[1]).toMatchObject({ home_team: 'WAS', away_team: 'DAL', status: 'Scheduled', last_updated_ms: null });
    });

    test('readLeagueWeekReadOnly returns season/week; both helpers return null on a missing DB', async () => {
        expect(await ss.readLeagueWeekReadOnly(dbPath)).toEqual({ season: 2026, week: 2 });
        expect(await ss.readLeagueWeekReadOnly(path.join(dir, 'nope.db'))).toBeNull();
        expect(await ss.readWeekGamesReadOnly(path.join(dir, 'nope.db'), 2026, 2)).toBeNull();
    });

    test('dbTimestampMs handles SQLite text, ISO, numbers and junk', () => {
        expect(ss.dbTimestampMs('2026-09-20 18:00:00')).toBe(NOW);
        expect(ss.dbTimestampMs('2026-09-20T18:00:00.000Z')).toBe(NOW);
        expect(ss.dbTimestampMs(NOW)).toBe(NOW);
        expect(ss.dbTimestampMs(null)).toBeNull();
        expect(ss.dbTimestampMs('soon')).toBeNull();
    });

    const scoreboard = (season, week) => ({ season: { year: season, type: 2 }, week: { number: week }, events: [{ id: '401', shortName: 'LAC @ KC' }] });

    test('fetchScoreboardCached fetches once, writes its own cache file, and reuses it within the TTL', async () => {
        const cacheFile = path.join(dir, 'espn-scoreboard.json');
        const f = fakeFetch({ [`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=2026&seasontype=2&week=2`]: response({ url: '', json: scoreboard(2026, 2) }) });
        const events = await ss.fetchScoreboardCached({ season: 2026, week: 2, cacheFile, now: NOW, fetchImpl: f });
        expect(events).toEqual([{ id: '401', shortName: 'LAC @ KC' }]);
        expect(f.calls).toHaveLength(1);
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        expect(cached).toMatchObject({ season: 2026, week: 2, fetchedAt: new Date(NOW).toISOString() });
        expect(cached.body.events).toHaveLength(1);

        const again = await ss.fetchScoreboardCached({ season: 2026, week: 2, cacheFile, now: NOW + 60000, fetchImpl: f });
        expect(again).toHaveLength(1);
        expect(f.calls).toHaveLength(1);

        await ss.fetchScoreboardCached({ season: 2026, week: 2, cacheFile, now: NOW + 91000, fetchImpl: f });
        expect(f.calls).toHaveLength(2);

        // a different week ignores the cache
        const f3 = fakeFetch({ [`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=2026&seasontype=2&week=3`]: response({ url: '', json: scoreboard(2026, 3) }) });
        await ss.fetchScoreboardCached({ season: 2026, week: 3, cacheFile, now: NOW + 92000, fetchImpl: f3 });
        expect(f3.calls).toHaveLength(1);
    });

    test('fetchScoreboardCached returns null on network error, non-200, a mismatched week, or missing args', async () => {
        const cacheFile = path.join(dir, 'espn-none.json');
        const url = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=2026&seasontype=2&week=2';
        expect(await ss.fetchScoreboardCached({ season: 2026, week: 2, cacheFile, now: NOW, fetchImpl: fakeFetch({ [url]: new Error('ECONNRESET') }) })).toBeNull();
        expect(await ss.fetchScoreboardCached({ season: 2026, week: 2, cacheFile, now: NOW, fetchImpl: fakeFetch({ [url]: response({ status: 503, url: '', body: '{}' }) }) })).toBeNull();
        expect(await ss.fetchScoreboardCached({ season: 2026, week: 2, cacheFile, now: NOW, fetchImpl: fakeFetch({ [url]: response({ url: '', json: scoreboard(2026, 1) }) }) })).toBeNull();
        expect(await ss.fetchScoreboardCached({ season: null, week: 2, cacheFile, now: NOW, fetchImpl: fakeFetch({}) })).toBeNull();
        expect(fs.existsSync(cacheFile)).toBe(false);
    });
});
