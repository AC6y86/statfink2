/**
 * Daily sanity checks: schedule integrity (incl. ESPN kickoff comparison from
 * the cached scoreboard) and clock sanity (NTP, timezone, game_time text vs epoch).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkScheduleIntegrity, checkClockSanity, etTimeText, etDateText, normalizeTimeText } = require('../../server/services/sanityChecks');

const SEASON = 2026;
// letter-only fake team codes (the game_id parser expects [A-Z]+)
const CODE = (n) => 'Q' + String.fromCharCode(65 + Math.floor(n / 26)) + String.fromCharCode(65 + (n % 26));
const T = (iso) => Math.floor(Date.parse(iso) / 1000);
function game(id, week, home, away, iso, extra = {}) {
    const [date] = id.split('_');
    return { game_id: id, week, season: SEASON, home_team: home, away_team: away, game_date: date, game_time: etTimeText(T(iso)), game_time_epoch: T(iso), status: 'Scheduled', ...extra };
}
function fakeDb(rows) { return { async all() { return rows; } }; }
function espnDir(week, events) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'espn-'));
    const wk = path.join(dir, String(SEASON), `week${String(week).padStart(2, '0')}`);
    fs.mkdirSync(wk, { recursive: true });
    fs.writeFileSync(path.join(wk, 'scoreboard.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), body: { week: { number: week }, events } }));
    return dir;
}
const ev = (id, home, away, iso, week) => ({ id, date: iso, week: { number: week }, competitions: [{ competitors: [{ homeAway: 'home', team: { abbreviation: home } }, { homeAway: 'away', team: { abbreviation: away } }] }] });

const WEEK2 = [
    game('20260917_DET@BUF', 2, 'BUF', 'DET', '2026-09-18T00:15:00Z'),
    game('20260920_CAR@ATL', 2, 'ATL', 'CAR', '2026-09-20T17:00:00Z'),
    game('20260920_WSH@DAL', 2, 'DAL', 'WAS', '2026-09-20T20:25:00Z')
];

describe('checkScheduleIntegrity', () => {
    test('a clean week with a matching ESPN scoreboard passes', async () => {
        const dir = espnDir(2, [ev('1', 'BUF', 'DET', '2026-09-18T00:15Z', 2), ev('2', 'ATL', 'CAR', '2026-09-20T17:00Z', 2), ev('3', 'DAL', 'WSH', '2026-09-20T20:25Z', 2)]);
        const r = await checkScheduleIntegrity({ db: fakeDb(WEEK2), week: 2, season: SEASON, espnCacheDir: dir });
        expect(r.status).toBe('warning'); // 3 games in the fixture week (< 13) is a shape warning by design
        expect(r.details).toEqual(expect.arrayContaining([expect.stringMatching(/week 2: 3 games/)]));
        expect(r.details.some(d => /kickoff/.test(d))).toBe(false);
    });

    test('a flexed kickoff and a game ESPN puts in another week are warnings; a moved game id is a failure', async () => {
        const rows = [...WEEK2, game('20260920_NYJ@TEN', 2, 'TEN', 'NYJ', '2026-09-20T17:00:00Z', { home_team: 'TEN', away_team: 'MIA' })];
        const dir = espnDir(2, [ev('1', 'BUF', 'DET', '2026-09-18T00:15Z', 2), ev('2', 'ATL', 'CAR', '2026-09-20T20:25Z', 2), ev('3', 'DAL', 'WSH', '2026-09-20T20:25Z', 3)]);
        const r = await checkScheduleIntegrity({ db: fakeDb(rows), week: 2, season: SEASON, espnCacheDir: dir });
        expect(r.status).toBe('failed');
        expect(r.details).toEqual(expect.arrayContaining([
            expect.stringMatching(/20260920_NYJ@TEN: id teams NYJ@TEN but columns say MIA@TEN/),
            expect.stringMatching(/20260920_CAR@ATL: kickoff .* here vs .* on ESPN/),
            expect.stringMatching(/20260920_WSH@DAL: ESPN puts this game in week 3/)
        ]));
    });

    test('a team in two games in one week and a duplicate game id fail', async () => {
        const rows = [...WEEK2, game('20260920_CAR@ATL', 2, 'ATL', 'CAR', '2026-09-20T17:00:00Z'), game('20260921_BUF@MIA', 2, 'MIA', 'BUF', '2026-09-22T00:15:00Z')];
        const r = await checkScheduleIntegrity({ db: fakeDb(rows), week: 2, season: SEASON, espnCacheDir: null });
        expect(r.status).toBe('failed');
        expect(r.details).toEqual(expect.arrayContaining([expect.stringMatching(/duplicate game_id 20260920_CAR@ATL/), expect.stringMatching(/week 2: BUF appears in 2 games/)]));
    });

    test('bye gaps and a kickoff far outside the week are warnings; no ESPN cache defers the comparison', async () => {
        const rows = [];
        for (let w = 4; w <= 6; w++) for (let i = 0; i < 16; i++) {
            const a = CODE(i * 2), h = CODE(i * 2 + 1);
            if (w === 5 && i === 0) continue; // the first pair on bye in week 5
            if (w === 6 && i === 0) continue; // ... and also missing week 6 = gap
            rows.push(game(`202610${String(w).padStart(2, '0')}_${a}@${h}`, w, h, a, `2026-10-${String(w + 10).padStart(2, '0')}T17:00:00Z`));
        }
        rows.push(game('20261025_QAY@QAZ', 5, 'QAZ', 'QAY', '2026-10-25T17:00:00Z')); // 10 days after the week's first game
        const r = await checkScheduleIntegrity({ db: fakeDb(rows), week: 5, season: SEASON, espnCacheDir: null });
        expect(['warning', 'failed']).toContain(r.status);
        expect(r.details.some(d => /schedule gap/.test(d))).toBe(true);
        expect(r.details.some(d => /days after the first game of week 5/.test(d))).toBe(true);
        const clean = await checkScheduleIntegrity({ db: fakeDb(WEEK2.slice(0, 1)), week: 2, season: SEASON, espnCacheDir: null });
        expect(clean.status).toBe('warning'); // 1 game shape warning
        const noWarn = { ...clean };
        expect(noWarn.message).toMatch(/schedule warning/);
    });

    test('TBD games (NULL epoch) never anchor the week window - the week 16 Saturday-slot case', async () => {
        const rows = [];
        for (let i = 0; i < 12; i++) rows.push(game(`20261227_${CODE(i * 2)}@${CODE(i * 2 + 1)}`, 16, CODE(i * 2 + 1), CODE(i * 2), '2026-12-27T18:00:00Z'));
        for (let i = 12; i < 16; i++) rows.push(game(`20261227_${CODE(i * 2)}@${CODE(i * 2 + 1)}`, 16, CODE(i * 2 + 1), CODE(i * 2), '2026-12-27T18:00:00Z', { game_time: 'TBD', game_time_epoch: null }));
        const r = await checkScheduleIntegrity({ db: fakeDb(rows), week: 16, season: SEASON, espnCacheDir: null, now: Date.parse('2026-09-14T00:00:00Z') });
        expect(r.details.filter(d => /days after the first game/.test(d))).toEqual([]);
        expect(r.status).toBe('deferred');
    });

    test('defers when there is nothing to compare against and the internal schedule is consistent', async () => {
        const rows = [];
        for (let i = 0; i < 16; i++) rows.push(game(`20260920_${CODE(i * 2)}@${CODE(i * 2 + 1)}`, 2, CODE(i * 2 + 1), CODE(i * 2), '2026-09-20T17:00:00Z'));
        const r = await checkScheduleIntegrity({ db: fakeDb(rows), week: 2, season: SEASON, espnCacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'empty-')) });
        expect(r.status).toBe('deferred');
        expect(r.message).toMatch(/deferred - no cached scoreboard/);
    });
});

describe('checkClockSanity', () => {
    test('Eastern conversions match Tank01 text', () => {
        expect(etTimeText(T('2026-09-20T17:00:00Z'))).toBe('1:00p');
        expect(etTimeText(T('2026-09-18T00:15:00Z'))).toBe('8:15p');
        expect(etDateText(T('2026-09-18T00:15:00Z'))).toBe('20260917');
        expect(normalizeTimeText('4:25 PM')).toBe('4:25p');
    });

    test('NTP synced + UTC + consistent times passes', async () => {
        const r = await checkClockSanity({ db: fakeDb(WEEK2), week: 2, season: SEASON, timedatectlImpl: () => ({ NTPSynchronized: 'yes', Timezone: 'Etc/UTC' }) });
        expect(r.status).toBe('passed');
        expect(r.message).toMatch(/3 kickoff time\(s\) consistent/);
    });

    test('NTP off is a failure; a non-UTC timezone and a game_time that disagrees with its epoch are warnings', async () => {
        const off = await checkClockSanity({ db: fakeDb(WEEK2), week: 2, season: SEASON, timedatectlImpl: () => ({ NTPSynchronized: 'no', Timezone: 'Etc/UTC' }) });
        expect(off.status).toBe('failed');
        const rows = [...WEEK2, game('20260920_CLE@TB', 2, 'TB', 'CLE', '2026-09-20T17:00:00Z', { game_time: '4:25p' }), game('20260921_QX@QY', 2, 'QY', 'QX', '2026-09-22T00:15:00Z', { game_date: '20260922' })];
        const r = await checkClockSanity({ db: fakeDb(rows), week: 2, season: SEASON, timedatectlImpl: () => ({ NTPSynchronized: 'yes', Timezone: 'America/Los_Angeles' }) });
        expect(r.status).toBe('warning');
        expect(r.details).toEqual(expect.arrayContaining([
            expect.stringMatching(/timezone is America\/Los_Angeles/),
            expect.stringMatching(/20260920_CLE@TB: game_time '4:25p' but the kickoff epoch is 1:00p ET/),
            expect.stringMatching(/20260921_QX@QY: game_date 20260922 but the kickoff epoch is 20260921 ET/)
        ]));
    });

    test('timedatectl unavailable is noted, not failed; TBD rows are skipped', async () => {
        const rows = [...WEEK2, game('20260921_QA@QB', 2, 'QB', 'QA', '2026-09-22T00:15:00Z', { game_time: 'TBD', game_time_epoch: null })];
        const r = await checkClockSanity({ db: fakeDb(rows), week: 2, season: SEASON, timedatectlImpl: () => null });
        expect(r.status).toBe('passed');
        expect(r.details).toEqual(expect.arrayContaining([expect.stringMatching(/timedatectl unavailable/)]));
    });
});
