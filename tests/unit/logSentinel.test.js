/**
 * scripts/lib/logSentinel.js + scripts/log-sentinel.js over synthetic pm2
 * logs in a temp dir (both prefix formats, multi-line entries, cursors,
 * rotation, classification) and the shipped knownLogNoise.json. Never touches
 * ~/.pm2/logs or logs/.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const ls = require('../../scripts/lib/logSentinel');
const sentinel = require('../../scripts/log-sentinel');

const NOW = Date.parse('2026-09-14T12:00:00Z');
const iso = (secAgo, ms = 0) => new Date(NOW - secAgo * 1000 + ms).toISOString();
/** Main app line: `[ISO] LEVEL: message` (no pm2 prefix). */
const app = (secAgo, text) => `[${iso(secAgo)}] ${text}`;
/** Cron app line: `YYYY-MM-DDTHH:mm:ss: [ISO] message` (pm2 `time: true`). */
const cron = (secAgo, text, inner = true) => `${iso(secAgo).slice(0, 19)}: ${inner ? `[${iso(secAgo)}] ` : ''}${text}`;

/** The real 7-line FK error the main app writes (server/utils/errorHandler.logError with an object). */
const FK_ENTRY = (secAgo, playerId) => [
    app(secAgo, `ERROR: Failed to update stats for player ${playerId}: {`),
    "  error: 'SQLITE_CONSTRAINT: FOREIGN KEY constraint failed',",
    "  stack: 'DatabaseError: SQLITE_CONSTRAINT: FOREIGN KEY constraint failed\\n' +",
    "    '    at Statement.<anonymous> (/home/joepaley/statfink2/server/database/database.js:82:28)\\n' +",
    "    '    at Statement.replacement (/home/joepaley/statfink2/node_modules/sqlite3/lib/trace.js:25:27)'",
    '}'
].join('\n');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logsentinel-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const write = (name, text) => { fs.writeFileSync(path.join(dir, name), text); return path.join(dir, name); };
const append = (name, text) => fs.appendFileSync(path.join(dir, name), text);

describe('listLogFiles', () => {
    test('current statfink2 out/error files only; job and stream from the name; rotated, gz and the sentinel\'s own logs skipped; pm_id ignored', () => {
        for (const n of ['statfink2-error-0.log', 'statfink2-out-0.log', 'statfink2-live-continuous-out-1.log', 'statfink2-live-continuous-error-7.log',
            'statfink2-daily-out.log', 'statfink2-error-0__2026-09-14_00-00-00.log', 'statfink2-daily-out__2026-09-14_00-00-00.log.gz',
            'pm2-logrotate-out.log', 'statfink2-watchdog-notifier-out.log', 'statfink2-log-sentinel-out.log', 'statfink2-log-sentinel-error.log', 'notes.txt']) write(n, '');
        const files = ls.listLogFiles(dir);
        expect(files.map(f => [f.name, f.job, f.stream, f.pmId])).toEqual([
            ['statfink2-daily-out.log', 'daily', 'out', null],
            ['statfink2-error-0.log', 'server', 'error', 0],
            ['statfink2-live-continuous-error-7.log', 'live-continuous', 'error', 7],
            ['statfink2-live-continuous-out-1.log', 'live-continuous', 'out', 1],
            ['statfink2-out-0.log', 'server', 'out', 0],
            ['statfink2-watchdog-notifier-out.log', 'watchdog-notifier', 'out', null]
        ]);
        expect(files[0].file).toBe(path.join(dir, 'statfink2-daily-out.log'));
        expect(ls.listLogFiles(path.join(dir, 'missing'))).toEqual([]);
    });
});

describe('readNewText: byte cursor semantics (watchdogLog.readLinesSince)', () => {
    test('a partial trailing line stays unread until its newline lands; then only the new bytes come back', () => {
        const f = write('statfink2-out-0.log', 'line one\nline two\npart');
        const r1 = ls.readNewText(f, null);
        expect(r1.text).toBe('line one\nline two\n');
        expect(r1.cursor.offset).toBe(Buffer.byteLength('line one\nline two\n'));
        expect(r1.rotated).toBe(false);
        const r2 = ls.readNewText(f, r1.cursor);
        expect(r2.text).toBe('');
        expect(r2.cursor.offset).toBe(r1.cursor.offset);
        append('statfink2-out-0.log', 'ial\nnext\n');
        const r3 = ls.readNewText(f, r2.cursor);
        expect(r3.text).toBe('partial\nnext\n');
        expect(r3.cursor.offset).toBe(fs.statSync(f).size);
        expect(ls.readNewText(f, r3.cursor).text).toBe('');
    });

    test('offset past the file size (pm2-logrotate truncated it) restarts at 0 and flags rotated', () => {
        const f = write('statfink2-error-0.log', 'a long first generation of the file\nwith two lines\n');
        const r1 = ls.readNewText(f, null);
        write('statfink2-error-0.log', 'fresh\n');
        const r2 = ls.readNewText(f, r1.cursor);
        expect(r2.rotated).toBe(true);
        expect(r2.text).toBe('fresh\n');
        expect(r2.cursor.offset).toBe(6);
    });

    test('a new inode (file replaced) restarts at 0', () => {
        const f = write('statfink2-error-0.log', 'one\ntwo\n');
        const r1 = ls.readNewText(f, null);
        expect(r1.cursor.inode).toBeTruthy();
        const r2 = ls.readNewText(f, { offset: 4, inode: r1.cursor.inode + 1 });
        expect(r2.rotated).toBe(true);
        expect(r2.text).toBe('one\ntwo\n');
    });

    test('caps each pass at maxBytes on a line boundary and advances the cursor accordingly', () => {
        const f = write('statfink2-out-0.log', 'aaaa\nbbbb\ncccc\ndddd\n');
        const r1 = ls.readNewText(f, null, { maxBytes: 12 });
        expect(r1.text).toBe('aaaa\nbbbb\n');
        expect(r1.capped).toBe(true);
        const r2 = ls.readNewText(f, r1.cursor, { maxBytes: 12 });
        expect(r2.text).toBe('cccc\ndddd\n');
        expect(r2.capped).toBe(false);
        expect(ls.MAX_BYTES_PER_PASS).toBe(5 * 1024 * 1024);
    });

    test('missing file: no text, cursor untouched, never throws', () => {
        const r = ls.readNewText(path.join(dir, 'nope.log'), { offset: 7, inode: 1 });
        expect(r).toMatchObject({ text: '', cursor: { offset: 7, inode: 1 }, error: 'unreadable' });
    });
});

describe('splitEntries', () => {
    test('main app: an entry starts at a [ISO] line; the 7-line pretty-printed error is one entry', () => {
        const text = [app(30, 'INFO: Found 5 games to check for updates {}'), FK_ENTRY(20, 16195), app(10, 'ERROR: Error: SQLITE_CONSTRAINT: FOREIGN KEY constraint failed { error: undefined, stack: undefined }')].join('\n') + '\n';
        const entries = ls.splitEntries(text);
        expect(entries).toHaveLength(3);
        expect(entries[1].lines).toHaveLength(6);
        expect(entries[1].ts).toBe(iso(20));
        expect(entries[1].text).toBe(FK_ENTRY(20, 16195));
        expect(entries.map(e => e.lead)).toEqual([false, false, false]);
        expect(entries[2].lines).toHaveLength(1);
    });

    test('cron app: every line has the pm2 prefix; continuation lines (same second, or indented/closing) attach; a new second starts a new entry', () => {
        const text = [
            cron(60, 'Live update failed: Request failed with status code 500'),
            cron(60, 'Response status: 500', false),
            cron(60, 'Response data: {', false),
            cron(60, '  success: false,', false),
            cron(60, "  message: 'Live update already in progress',", false),
            cron(60, "  data: { success: false, message: 'Live update already in progress' }", false),
            cron(60, '}', false),
            cron(45, 'Received SIGINT, shutting down gracefully', false),
            cron(30, 'Starting continuous live game update...')
        ].join('\n') + '\n';
        const entries = ls.splitEntries(text);
        expect(entries.map(e => e.lines.length)).toEqual([7, 1, 1]);
        expect(entries[0].ts).toBe(iso(60));
        expect(entries[1].ts).toBe(iso(45).slice(0, 19) + 'Z');
        expect(entries[1].lead).toBe(false);
        expect(entries[2].ts).toBe(iso(30));
    });

    test('a leading chunk with no start line is an entry with ts null and lead=true; isTail tells a cut-off object from a crash dump', () => {
        const tail = ls.splitEntries("  stack: 'x'\n}\n" + app(5, 'WARN: after') + '\n');
        expect(tail).toHaveLength(2);
        expect(tail[0]).toMatchObject({ ts: null, lead: true, lines: ["  stack: 'x'", '}'] });
        expect(ls.isTail(tail[0])).toBe(true);
        expect(ls.isTail(tail[1])).toBe(false);
        const crash = ls.splitEntries('/home/joepaley/statfink2/server/app.js:12\n    throw err;\n    ^\n\nError: boom\n    at Object.<anonymous> (/home/joepaley/statfink2/server/app.js:12:9)\n');
        expect(crash).toHaveLength(1);
        expect(crash[0].lead).toBe(true);
        expect(ls.isTail(crash[0])).toBe(false);
        expect(ls.splitEntries('')).toEqual([]);
    });
});

describe('levelOf', () => {
    const e = text => ({ lines: text.split('\n'), text });
    test('explicit level on the first line wins; then error markers; then the stream; else info', () => {
        expect(ls.levelOf(e(app(1, 'ERROR: Failed to update stats for player 1: {\n  error: undefined')), 'error')).toBe('error');
        expect(ls.levelOf(e(app(1, 'WARN: Skipping player with incomplete data {')), 'error')).toBe('warn');
        expect(ls.levelOf(e(app(1, 'INFO: 0 errors this pass {}')), 'out')).toBe('info');
        expect(ls.levelOf(e(cron(1, 'Poll failed (AUTH): invalid_grant')), 'error')).toBe('error');
        expect(ls.levelOf(e(cron(1, 'Verification suite: FAILED (exit 1)')), 'out')).toBe('error');
        expect(ls.levelOf(e(cron(1, 'Live update completed: 1 games in progress')), 'out')).toBe('info');
        expect(ls.levelOf(e(cron(1, 'ok/ok 1 game(s) in window (1 in progress), loop ticked 8s ago, stats flowing')), 'out')).toBe('info');
        expect(ls.levelOf(e(cron(1, 'Received SIGINT, shutting down gracefully', false)), 'error')).toBe('error');
        expect(ls.levelOf(e('Error: boom\n    at x'), 'out')).toBe('error');
        expect(ls.levelOf(e(cron(1, 'WARNING: cache nearly full')), 'out')).toBe('warn');
    });
});

describe('fingerprint', () => {
    test('stable across timestamps, ids, paths, quoted strings and hex; both prefixes stripped; 140 chars; sha1[0..10] id', () => {
        const a = ls.fingerprint(ls.splitEntries(FK_ENTRY(20, 16195) + '\n')[0]);
        const b = ls.fingerprint(ls.splitEntries(FK_ENTRY(9000, 4725996) + '\n')[0]);
        expect(a).toEqual(b);
        expect(a.text).toBe('error: failed to update stats for player N: {');
        expect(a.id).toMatch(/^[0-9a-f]{10}$/);

        const p1 = ls.fingerprint({ lines: [cron(1, 'FAILED to send email (invalid_grant). Report saved to /home/joepaley/statfink2/logs/weekly-validation-email-failure-1785232824608.log')] });
        const p2 = ls.fingerprint({ lines: [cron(999, 'FAILED to send email (invalid_grant). Report saved to /srv/other/logs/weekly-validation-email-failure-1786442424611.log')] });
        expect(p1).toEqual(p2);
        expect(p1.text).toBe('failed to send email (invalid_grant). report saved to /…');

        const q1 = ls.fingerprint({ lines: [app(1, "ERROR: boxscore 20260913_ARI@LAC missing player 'Kyler Murray' token deadbeefcafe1234 uuid 123e4567-e89b-12d3-a456-426614174000")] });
        const q2 = ls.fingerprint({ lines: [app(2, 'ERROR: boxscore 20260920_ARI@LAC missing player "Josh Allen" token 0badf00d0badf00d uuid 00000000-1111-2222-3333-444444444444')] });
        expect(q1).toEqual(q2);
        expect(q1.text).toBe('error: boxscore N_ari@lac missing player "…" token H uuid H');

        const long = ls.fingerprint({ lines: [app(1, `ERROR: ${'x'.repeat(300)}`)] });
        expect(long.text).toHaveLength(ls.FP_TEXT_MAX);
        expect(ls.fingerprint({ lines: [app(1, 'ERROR:   spaced    out  ')] }).text).toBe('error: spaced out');
    });
});

describe('history buckets', () => {
    test('updateHistory keeps hourly buckets for 7 days and minute buckets for the last hour; prunes; countsOf', () => {
        const history = {};
        ls.updateHistory(history, 'abc', NOW - 8 * 86400000, { now: NOW });   // 8 days ago: firstSeen only
        ls.updateHistory(history, 'abc', NOW - 3 * 86400000, { now: NOW });
        ls.updateHistory(history, 'abc', NOW - 2 * 3600000, { now: NOW, count: 5 });
        ls.updateHistory(history, 'abc', NOW - 30 * 60000, { now: NOW, count: 3 });
        ls.updateHistory(history, 'abc', NOW - 5 * 60000, { now: NOW, count: 2 });
        const h = history.abc;
        expect(h.firstSeen).toBe(new Date(NOW - 8 * 86400000).toISOString());
        expect(h.lastSeen).toBe(new Date(NOW - 5 * 60000).toISOString());
        expect(Object.keys(h.buckets).sort()).toEqual([...new Set([ls.hourKey(NOW - 3 * 86400000), ls.hourKey(NOW - 2 * 3600000), ls.hourKey(NOW - 30 * 60000), ls.hourKey(NOW - 5 * 60000)])].sort());
        expect(Object.keys(h.minutes).sort()).toEqual([ls.minuteKey(NOW - 30 * 60000), ls.minuteKey(NOW - 5 * 60000)]);
        expect(ls.countsOf(h, NOW)).toEqual({ count10m: 2, count1h: 5, count24h: 10, count7d: 11 });
        // a week later everything but the record itself is gone, then the record too
        ls.updateHistory(history, 'abc', NOW + 7 * 86400000 + 1000, { now: NOW + 7 * 86400000 + 1000 });
        expect(Object.keys(h.buckets)).toEqual([ls.hourKey(NOW + 7 * 86400000 + 1000)]);
        ls.pruneHistory(history, NOW + 15 * 86400000);
        expect(history).toEqual({});
        // a bad timestamp lands on `now`
        ls.updateHistory(history, 'z', 'not a date', { now: NOW });
        expect(history.z.buckets).toEqual({ [ls.hourKey(NOW)]: 1 });
    });
});

describe('classify', () => {
    const known = { shipped: [{ id: 'fk', pattern: 'foreign key constraint failed|failed to update stats for player n' }], acked: { deadbeef00: { text: 'x', ackedAt: iso(0), by: 'session' } } };
    const hist = (firstSecAgo, buckets = {}, minutes = {}) => ({ firstSeen: iso(firstSecAgo), lastSeen: iso(0), buckets, minutes });

    test('new = first seen < 24 h and not known; known by shipped regex or acked id', () => {
        const fresh = ls.classify({ fp: { id: '0123456789', text: 'error: something odd happened' }, history: hist(3600), known, now: NOW });
        expect(fresh).toMatchObject({ new: true, known: false, knownVia: null, spiking: false });
        const old = ls.classify({ fp: { id: '0123456789', text: 'error: something odd happened' }, history: hist(25 * 3600), known, now: NOW });
        expect(old).toMatchObject({ new: false, known: false });
        const fk = ls.classify({ fp: { id: '1111111111', text: 'error: failed to update stats for player N: {' }, history: hist(60), known, now: NOW });
        expect(fk).toMatchObject({ new: false, known: true, knownVia: 'shipped:fk' });
        const acked = ls.classify({ fp: { id: 'deadbeef00', text: 'whatever' }, history: hist(60), known, now: NOW });
        expect(acked).toMatchObject({ new: false, known: true, knownVia: 'acked' });
        expect(ls.classify({ fp: { id: 'abcdef0123', text: 'x' }, history: null, known: {}, now: NOW })).toMatchObject({ new: true, count24h: 0 });
        // a bad shipped regex is skipped, not fatal
        expect(ls.matchKnown({ id: 'a', text: 'b' }, { shipped: [{ id: 'bad', pattern: '(' }] })).toEqual({ known: false, via: null });
    });

    test('spiking: last hour > max(50, 10 x 7-day hourly average), only after 6 observed hours, never for a new shape', () => {
        // first seen 24.5 h ago: 24 completed hours at 10/h, then 200 in the last hour
        const buckets = {};
        for (let h = 1; h <= 24; h++) buckets[ls.hourKey(NOW - h * 3600000)] = 10;
        const minutes = { [ls.minuteKey(NOW - 5 * 60000)]: 200 };
        const first = 24 * 3600 + 1800;
        const spike = ls.classify({ fp: { id: '1111111111', text: 'error: failed to update stats for player N: {' }, history: hist(first, buckets, minutes), known, now: NOW, observedSince: iso(2 * 86400) });
        expect(spike).toMatchObject({ known: true, spiking: true, count1h: 200, spikeThreshold: 100, hourlyAvg: 10 });
        // 90 in the last hour is under 10x
        const calm = ls.classify({ fp: { id: '1111111111', text: 'error: failed to update stats for player N: {' }, history: hist(first, buckets, { [ls.minuteKey(NOW - 60000)]: 90 }), known, now: NOW, observedSince: iso(2 * 86400) });
        expect(calm.spiking).toBe(false);
        // the average is over hours the sentinel has watched the shape, not hours with entries: a 48 h old shape with 24 h of entries averages 5/h
        expect(ls.classify({ fp: { id: '1111111111', text: 'error: failed to update stats for player N: {' }, history: hist(2 * 86400, buckets, minutes), known, now: NOW, observedSince: iso(2 * 86400) })).toMatchObject({ hourlyAvg: 5, spikeThreshold: 50 });
        // the floor of 50: a quiet shape needs more than 50 in an hour
        const quiet = { [ls.hourKey(NOW - 3600000)]: 1 };
        expect(ls.classify({ fp: { id: '2222222222', text: 'x' }, history: hist(3 * 86400, quiet, { [ls.minuteKey(NOW - 60000)]: 51 }), known: {}, now: NOW, observedSince: iso(3 * 86400) }).spiking).toBe(true);
        expect(ls.classify({ fp: { id: '2222222222', text: 'x' }, history: hist(3 * 86400, quiet, { [ls.minuteKey(NOW - 60000)]: 50 }), known: {}, now: NOW, observedSince: iso(3 * 86400) }).spiking).toBe(false);
        // the sentinel started 2 h ago: no past to compare with, so no spike yet
        expect(ls.classify({ fp: { id: '1111111111', text: 'error: failed to update stats for player N: {' }, history: hist(first, buckets, minutes), known, now: NOW, observedSince: iso(2 * 3600) }).spiking).toBe(false);
        // a new (unknown, < 24 h) shape is never also spiking
        expect(ls.classify({ fp: { id: '3333333333', text: 'y' }, history: hist(3600, {}, minutes), known: {}, now: NOW, observedSince: iso(86400) })).toMatchObject({ new: true, spiking: false });
    });
});

describe('summarize', () => {
    test('warning only for new or spiking; known noise is counted, never coloured; first run says baseline', () => {
        const fp = (o) => ({ new: false, known: false, spiking: false, count24h: 1, ...o });
        expect(ls.summarize([])).toMatchObject({ status: 'ok', newCount: 0, summary: 'no new errors; no errors in the pm2 logs' });
        expect(ls.summarize([fp({ known: true, count24h: 4594 }), fp({ known: true, count24h: 5006 })])).toMatchObject({ status: 'ok', knownSuppressed: 2, knownEntries24h: 9600, summary: 'no new errors; 2 known noise shape(s) suppressed (9,600 entries in 24 h)' });
        expect(ls.summarize([fp({ new: true }), fp({ known: true })])).toMatchObject({ status: 'warning', newCount: 1, summary: '1 new error shape(s) nobody has seen before; 1 known noise shape(s) suppressed (1 entries in 24 h)' });
        expect(ls.summarize([fp({ known: true, spiking: true })])).toMatchObject({ status: 'warning', spikingCount: 1 });
        expect(ls.summarize([fp({})])).toMatchObject({ status: 'ok', summary: 'no new errors; 1 older unacknowledged shape(s)' });
        expect(ls.summarize([fp({ known: true })], { firstRun: true })).toMatchObject({ status: 'ok', summary: 'first run: 1 existing shape(s) taken as baseline; 1 known noise shape(s) suppressed (1 entries in 24 h)' });
        expect(ls.sortFingerprints([fp({ known: true, id: 'k' }), fp({ id: 'o' }), fp({ spiking: true, id: 's' }), fp({ new: true, id: 'n' })]).map(f => f.id)).toEqual(['n', 's', 'o', 'k']);
    });
});

describe('scripts/log-sentinel.js scan()', () => {
    const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '../../server/config/knownLogNoise.json'), 'utf8')).entries;
    const known = (acked = {}) => ({ shipped, acked });

    function seedLogs() {
        write('statfink2-error-0.log', [
            FK_ENTRY(3000, 16195), app(3000, 'ERROR: Error: SQLITE_CONSTRAINT: FOREIGN KEY constraint failed { error: undefined, stack: undefined }'),
            FK_ENTRY(2000, 4725996), app(2000, 'ERROR: Error: SQLITE_CONSTRAINT: FOREIGN KEY constraint failed { error: undefined, stack: undefined }'),
            app(1500, 'WARN: Skipping player with incomplete data {'), "  playerID: '4040805',", '  position: null,', '}'
        ].join('\n') + '\n');
        write('statfink2-out-0.log', [app(100, 'INFO: Internal live update triggered {}'), app(90, 'INFO: Found 5 games to check for updates {}')].join('\n') + '\n');
        write('statfink2-live-continuous-out-1.log', [cron(120, 'Starting continuous live game update...'), cron(119, 'Live update completed: 1 games in progress')].join('\n') + '\n');
        write('statfink2-email-poller-error-4.log', [cron(700, 'Poll failed (AUTH): invalid_grant'), cron(580, 'Poll failed (AUTH): invalid_grant')].join('\n') + '\n');
        write('statfink2-error-0__2026-09-14_00-00-00.log', app(50000, 'ERROR: rotated away, never read') + '\n');
    }

    test('first run: every existing shape is baseline (firstSeen seeded 25 h back), shipped noise is known, status ok', () => {
        seedLogs();
        const r = sentinel.scan({ dir, state: {}, known: known(), now: NOW });
        expect(r.latest.firstRun).toBe(true);
        expect(r.summary.status).toBe('ok');
        expect(r.summary.summary).toMatch(/^first run: 4 existing shape\(s\) taken as baseline; 3 known noise shape\(s\) suppressed \(5 entries in 24 h\)$/);
        const byText = Object.fromEntries(r.latest.fingerprints.map(f => [f.fingerprint, f]));
        expect(Object.keys(byText).sort()).toEqual([
            'error: error: sqlite_constraint: foreign key constraint failed { error: undefined, stack: undefined }',
            'error: failed to update stats for player N: {',
            'poll failed (auth): invalid_grant',
            'warn: skipping player with incomplete data {'
        ]);
        const fk = byText['error: failed to update stats for player N: {'];
        expect(fk).toMatchObject({ job: 'server', level: 'error', known: true, knownVia: 'shipped:fk-constraint-non-draftable-player', new: false, spiking: false, count24h: 2, count7d: 2, count10m: 0 });
        expect(fk.firstSeen).toBe(iso(25 * 3600));
        expect(fk.lastSeen).toBe(iso(2000));
        expect(fk.sample).toBe(FK_ENTRY(2000, 4725996));
        expect(byText['warn: skipping player with incomplete data {']).toMatchObject({ level: 'warn', known: true, knownVia: 'shipped:player-sync-incomplete-data' });
        expect(byText['poll failed (auth): invalid_grant']).toMatchObject({ job: 'email-poller', level: 'error', known: false, new: false, count24h: 2 });
        // known rows sort last; info lines were ignored; the rotated file was never opened
        expect(r.latest.fingerprints.map(f => f.known)).toEqual([false, true, true, true]);
        expect(r.latest.scanned.map(s => s.file)).not.toContain('statfink2-error-0__2026-09-14_00-00-00.log');
        expect(r.latest.scanned.find(s => s.file === 'statfink2-error-0.log').bytes).toBe(fs.statSync(path.join(dir, 'statfink2-error-0.log')).size);
        expect(r.state.observedSince).toBe(new Date(NOW).toISOString());
        expect(Object.keys(r.state.cursors).sort()).toEqual(['statfink2-email-poller-error-4.log', 'statfink2-error-0.log', 'statfink2-live-continuous-out-1.log', 'statfink2-out-0.log']);
    });

    test('second run: nothing new reads no bytes and stays ok; a never-seen error shape is NEW => warning; acking it makes it known', () => {
        seedLogs();
        const r1 = sentinel.scan({ dir, state: {}, known: known(), now: NOW });
        const r2 = sentinel.scan({ dir, state: r1.state, known: known(), now: NOW + 600000 });
        expect(r2.latest.firstRun).toBe(false);
        expect(r2.latest.scanned.every(s => s.bytes === 0)).toBe(true);
        expect(r2.summary).toMatchObject({ status: 'ok', newCount: 0, knownSuppressed: 3 });
        expect(r2.summary.summary).toBe('no new errors; 3 known noise shape(s) suppressed (5 entries in 24 h); 1 older unacknowledged shape(s)');

        // a fresh error nobody has seen, written twice (with a partial trailing line left unread)
        append('statfink2-error-0.log', [app(-700, 'ERROR: Tank01 boxscore for 20260920_KC@LAC has no scoring plays {'), "  gameID: '20260920_KC@LAC'", '}', app(-710, 'ERROR: Tank01 boxscore for 20260927_KC@LAC has no scoring plays {'), "  gameID: '20260927_KC@LAC'", '}'].join('\n') + '\n' + app(-720, 'ERROR: half written'));
        const r3 = sentinel.scan({ dir, state: r2.state, known: known(), now: NOW + 1200000 });
        expect(r3.summary).toMatchObject({ status: 'warning', newCount: 1, spikingCount: 0 });
        const top = r3.latest.fingerprints[0];
        expect(top).toMatchObject({ new: true, known: false, fingerprint: 'error: tank01 boxscore for N_kc@lac has no scoring plays {', count10m: 2, count24h: 2, job: 'server', level: 'error' });
        expect(top.firstSeen).toBe(iso(-700));
        expect(top.sample).toContain("gameID: '20260927_KC@LAC'"); // the last raw entry
        expect(r3.latest.fingerprints.some(f => f.fingerprint === 'error: half written')).toBe(false);

        // acked from the page: known, not new, status back to ok
        const r4 = sentinel.scan({ dir, state: r3.state, known: known({ [top.id]: { text: top.fingerprint, ackedAt: iso(0), by: 'tailscale' } }), now: NOW + 1800000 });
        expect(r4.summary).toMatchObject({ status: 'ok', newCount: 0, knownSuppressed: 4 });
        expect(r4.latest.fingerprints.find(f => f.id === top.id)).toMatchObject({ known: true, knownVia: 'acked', new: false });
        // ... and the half-written line is read once its newline lands
        append('statfink2-error-0.log', '\n');
        const r5 = sentinel.scan({ dir, state: r4.state, known: known(), now: NOW + 2400000 });
        expect(r5.latest.fingerprints.find(f => f.fingerprint === 'error: half written')).toMatchObject({ new: true, count24h: 1 });
    });

    test('a never-seen WARN shape is listed and counted but never "new": only error shapes colour the page', () => {
        seedLogs();
        const r1 = sentinel.scan({ dir, state: {}, known: known(), now: NOW });
        append('statfink2-error-0.log', app(-500, 'WARN: boxscore boxscore_20260927_kc@lac is completed but not yet permanent (first completed sighting); refetch in 15 min {}') + '\n');
        const r2 = sentinel.scan({ dir, state: r1.state, known: known(), now: NOW + 600000 });
        const warnShape = r2.latest.fingerprints.find(f => f.fingerprint.startsWith('warn: boxscore'));
        expect(warnShape).toMatchObject({ level: 'warn', new: false, known: false, count24h: 1 });
        expect(r2.summary).toMatchObject({ status: 'ok', newCount: 0 });
        expect(r2.summary.summary).toContain('no new errors');
    });

    test('rotation: a truncated file restarts at 0; the cut-off tail of an already counted entry is not a new shape', () => {
        seedLogs();
        const r1 = sentinel.scan({ dir, state: {}, known: known(), now: NOW });
        // pm2-logrotate copied the file away and truncated it; new content is shorter than the old cursor
        write('statfink2-error-0.log', app(-100, 'ERROR: after rotation {') + '\n');
        const r2 = sentinel.scan({ dir, state: r1.state, known: known(), now: NOW + 600000 });
        expect(r2.latest.scanned.find(s => s.file === 'statfink2-error-0.log')).toMatchObject({ rotated: true, bytes: fs.statSync(path.join(dir, 'statfink2-error-0.log')).size });
        expect(r2.latest.fingerprints[0]).toMatchObject({ fingerprint: 'error: after rotation {', new: true });
        // the object's remaining lines arrive in the next pass: attached to nothing, they are a tail, not an entry
        append('statfink2-error-0.log', "  detail: 'late'\n}\n");
        const r3 = sentinel.scan({ dir, state: r2.state, known: known(), now: NOW + 1200000 });
        expect(r3.latest.fingerprints).toHaveLength(r2.latest.fingerprints.length);
        expect(r3.summary.newCount).toBe(1);
    });

    test('a corrupt or foreign state file is treated as a first run; the latest.json shape is what the page expects', () => {
        seedLogs();
        const r = sentinel.scan({ dir, state: { cursors: 'nope', history: null }, known: known(), now: NOW });
        expect(r.latest.firstRun).toBe(true);
        expect(Object.keys(r.latest).sort()).toEqual(['entriesSeen', 'fingerprints', 'firstRun', 'observedSince', 'scanned', 'summary', 'ts']);
        expect(Object.keys(r.latest.fingerprints[0]).sort()).toEqual(['count10m', 'count1h', 'count24h', 'count7d', 'firstSeen', 'fingerprint', 'hourlyAvg', 'id', 'job', 'known', 'knownVia', 'lastSeen', 'level', 'new', 'sample', 'spikeThreshold', 'spiking'].sort());
        expect(Object.keys(r.latest.scanned[0]).sort()).toEqual(['bytes', 'capped', 'file', 'job', 'rotated', 'stream']);
    });

    test('main() writes state, latest and the job status into --out / STATFINK_STATUS_DIR; --dry-run writes nothing; a bad flag exits 2', async () => {
        seedLogs();
        // seedLogs() uses NOW-relative timestamps. Freeze the production
        // entrypoint too so this test does not begin failing when its fixture
        // dates age beyond the sentinel's seven-day retention window.
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
        const out = path.join(dir, 'out');
        const statusDir = path.join(dir, 'status');
        process.env.STATFINK_STATUS_DIR = statusDir;
        let js;
        jest.isolateModules(() => { js = require('../../scripts/lib/jobStatus'); });
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        try {
            let code;
            jest.isolateModules(() => { code = require('../../scripts/log-sentinel').main(['node', 'x', '--once', '--dir', dir, '--out', out, '--dry-run']); });
            expect(await code).toBe(0);
            expect(fs.existsSync(path.join(out, 'state.json'))).toBe(false);
            jest.isolateModules(() => { code = require('../../scripts/log-sentinel').main(['node', 'x', '--once', '--dir', dir, '--out', out]); });
            expect(await code).toBe(0);
            const state = JSON.parse(fs.readFileSync(path.join(out, 'state.json'), 'utf8'));
            expect(Object.keys(state).sort()).toEqual(['cursors', 'history', 'meta', 'observedSince', 'updatedAt']);
            const latest = JSON.parse(fs.readFileSync(path.join(out, 'latest.json'), 'utf8'));
            expect(latest.summary.status).toBe('ok');
            const rec = js.readJobStatus('log-sentinel');
            expect(rec).toMatchObject({ job: 'log-sentinel', status: 'ok', link: '/admin/status#log-errors', details: { firstRun: true, knownSuppressed: 3, newCount: 0, filesScanned: 4 } });
            expect(fs.readdirSync(out).filter(f => f.endsWith('.tmp'))).toEqual([]);
            const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
            jest.isolateModules(() => { code = require('../../scripts/log-sentinel').main(['node', 'x', '--bogus']); });
            expect(await code).toBe(2);
            errSpy.mockRestore();
        } finally {
            nowSpy.mockRestore();
            logSpy.mockRestore();
            delete process.env.STATFINK_STATUS_DIR;
        }
    });
});

describe('server/config/knownLogNoise.json', () => {
    test('has the shipped shapes with valid regexes that match the real fingerprints', () => {
        const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../server/config/knownLogNoise.json'), 'utf8'));
        expect(cfg.entries.map(e => e.id)).toEqual(['fk-constraint-non-draftable-player', 'player-sync-incomplete-data', 'health-alert-echo', 'watchdog-narration', 'live-review-narration', 'nightly-tests-narration', 'log-sentinel-own-summary']);
        for (const e of cfg.entries) {
            expect(() => new RegExp(e.pattern, 'i')).not.toThrow();
            expect(e.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(typeof e.note).toBe('string');
        }
        const known = { shipped: cfg.entries, acked: {} };
        expect(ls.matchKnown({ id: 'a', text: 'error: error: sqlite_constraint: foreign key constraint failed { error: undefined, stack: undefined }' }, known).via).toBe('shipped:fk-constraint-non-draftable-player');
        expect(ls.matchKnown({ id: 'b', text: 'error: failed to update stats for player N: {' }, known).via).toBe('shipped:fk-constraint-non-draftable-player');
        expect(ls.matchKnown({ id: 'c', text: 'warn: skipping player with incomplete data {' }, known).via).toBe('shipped:player-sync-incomplete-data');
        // health alerts are already on the Alerts card; their log echo (header + per-team lines) is known noise
        expect(ls.matchKnown({ id: 'e', text: 'error: health alert [validation:roster invariant (12x19)]: week N/N: N team(s) without exactly N active players {' }, known).via).toBe('shipped:health-alert-echo');
        expect(ls.matchKnown({ id: 'f', text: "error: - cal's team: N active players { error: null, stack: null }" }, known).via).toBe('shipped:health-alert-echo');
        expect(ls.matchKnown({ id: 'g', text: "error: ⚠️ week N: N teams don't have N active players { error: null, stack: null }" }, known).via).toBe('shipped:health-alert-echo');
        // watchdog / notifier / live-review / nightly-test narration: their own cards are the surface
        expect(ls.matchKnown({ id: 'h', text: 'site_down/critical https://peninsulafootball.com/ unreachable: fetch failed; tls check failed' }, known).via).toBe('shipped:watchdog-narration');
        expect(ls.matchKnown({ id: 'i', text: 'degraded/warning public api last live update N min ago (last_live_update)' }, known).via).toBe('shipped:watchdog-narration');
        expect(ls.matchKnown({ id: 'j', text: 'diagnosis (qwen, critical): the watchdog reports the server as down' }, known).via).toBe('shipped:watchdog-narration');
        expect(ls.matchKnown({ id: 'k', text: 'emailed joe.paley@gmail.com: statfink2 live: critical site_down' }, known).via).toBe('shipped:watchdog-narration');
        expect(ls.matchKnown({ id: 'l', text: 'action email/opened: statfink2 live: critical site_down' }, known).via).toBe('shipped:watchdog-narration');
        expect(ls.matchKnown({ id: 'm', text: 'N new line(s); incident: degraded (warning) since N-N-22t00:N:N.007z; N action(s)' }, known).via).toBe('shipped:watchdog-narration');
        expect(ls.matchKnown({ id: 'n', text: 'done: warning — N game(s) in window; N play(s) reviewed: N confirmed; qwen unreachable for N (N ms)' }, known).via).toBe('shipped:live-review-narration');
        expect(ls.matchKnown({ id: 'o', text: 'qwen unreachable: network error: fetch failed (und_err_connect_timeout' }, known).via).toBe('shipped:live-review-narration');
        expect(ls.matchKnown({ id: 'p', text: 'N suite(s) failed — details saved to /…' }, known).via).toBe('shipped:nightly-tests-narration');
        expect(ls.matchKnown({ id: 'q', text: 'suite "…": failed (exit N)' }, known).via).toBe('shipped:nightly-tests-narration');
        expect(ls.matchKnown({ id: 't', text: 'N file(s), N with new bytes, N error/warn entries; no new errors; N known noise shape(s) suppressed (N,N entries in N h)' }, known).via).toBe('shipped:log-sentinel-own-summary');
        // real errors still surface
        expect(ls.matchKnown({ id: 'r', text: 'failed to submit email H: request failed with status code N' }, known).known).toBe(false);
        expect(ls.matchKnown({ id: 's', text: 'error: spawn claude enoent' }, known).known).toBe(false);
    });
});

describe('POST/DELETE /api/admin/log-noise/ack (server/routes/admin.js)', () => {
    const express = require('express');
    const request = require('supertest');
    let app;
    beforeEach(() => {
        app = express();
        app.use(express.json());
        app.locals.logSentinelDir = path.join(dir, 'sentinel');
        app.use('/api/admin', require('../../server/routes/admin'));
        app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ success: false, message: err.message })); // eslint-disable-line no-unused-vars
    });
    const ackFile = () => path.join(dir, 'sentinel', 'known.json');
    const read = () => JSON.parse(fs.readFileSync(ackFile(), 'utf8'));

    test('ack upserts known.json keyed by fingerprint id (by = trust path), un-ack removes it, and the sentinel honours it', async () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        try {
            let res = await request(app).post('/api/admin/log-noise/ack').send({ id: '0123456789', text: 'error: something odd' });
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ success: true, data: { id: '0123456789', text: 'error: something odd', by: 'localhost' } });
            expect(read()['0123456789']).toMatchObject({ text: 'error: something odd', by: 'localhost' });
            expect(read()['0123456789'].ackedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
            res = await request(app).post('/api/admin/log-noise/ack').send({ id: 'abcdefabcd', text: 'x'.repeat(400) });
            expect(read()['abcdefabcd'].text).toHaveLength(200);
            expect(Object.keys(read()).sort()).toEqual(['0123456789', 'abcdefabcd']);
            expect(fs.readdirSync(path.join(dir, 'sentinel')).filter(f => f.endsWith('.tmp'))).toEqual([]);

            // the sentinel reads the same file at classify time
            const known = sentinel.loadKnown({ ackFile: ackFile() });
            expect(ls.matchKnown({ id: '0123456789', text: 'whatever' }, known)).toEqual({ known: true, via: 'acked' });
            expect(known.shipped.map(e => e.id)).toContain('fk-constraint-non-draftable-player');

            res = await request(app).delete('/api/admin/log-noise/ack/0123456789');
            expect(res.body).toEqual({ success: true, data: { id: '0123456789', removed: true } });
            expect(Object.keys(read())).toEqual(['abcdefabcd']);
            res = await request(app).delete('/api/admin/log-noise/ack/0123456789');
            expect(res.body.data.removed).toBe(false);
        } finally {
            logSpy.mockRestore();
        }
    });

    test('POST /warnings/clear acks every open alert and every NEW log shape as seen, then re-runs the sentinel to green', async () => {
        const sentinelDir = path.join(dir, 'sentinel');
        fs.mkdirSync(sentinelDir, { recursive: true });
        // A prior pass that flagged one new error shape and listed one older one
        fs.writeFileSync(path.join(sentinelDir, 'latest.json'), JSON.stringify({ ts: iso(0), fingerprints: [
            { id: 'aaaaaaaaaa', new: true, fingerprint: 'error: brand new thing', level: 'error' },
            { id: 'bbbbbbbbbb', new: false, fingerprint: 'error: older thing', level: 'error' },
            { id: 'not-an-id', new: true, fingerprint: 'ignored', level: 'error' }
        ] }));
        const acked = [];
        app.locals.healthCheckService = { async acknowledgeAlerts(ids) { acked.push(ids); return { acknowledged: 3 }; } };
        app.locals.logSentinelLogDir = dir; // the seeded fake pm2 logs, never the real ~/.pm2/logs
        const prevStatusDir = process.env.STATFINK_STATUS_DIR;
        process.env.STATFINK_STATUS_DIR = path.join(dir, 'status');
        try {
            const res = await request(app).post('/api/admin/warnings/clear').send({});
            expect(res.status).toBe(200);
            expect(acked).toEqual([null]); // ack ALL alerts
            expect(res.body.data).toMatchObject({ alertsAcknowledged: 3, logShapesAcknowledged: 1, logShapes: ['aaaaaaaaaa'] });
            expect(res.body.data.sentinel).toMatchObject({ status: expect.any(String), summary: expect.any(String) });
            expect(read().aaaaaaaaaa).toMatchObject({ text: 'error: brand new thing', via: 'clear-all' });
            expect(read().bbbbbbbbbb).toBeUndefined();
            // the sentinel ran: latest.json is now a fresh pass over the fake logs
            const latest = JSON.parse(fs.readFileSync(path.join(sentinelDir, 'latest.json'), 'utf8'));
            expect(latest.firstRun).toBe(true);
            expect(latest.summary.status).toBe('ok');
        } finally {
            if (prevStatusDir === undefined) delete process.env.STATFINK_STATUS_DIR; else process.env.STATFINK_STATUS_DIR = prevStatusDir;
        }
    });

    test('ids are validated: 10 lowercase hex chars or 400; a corrupt known.json is started over', async () => {
        for (const bad of [{ id: 'nope' }, { id: '0123456789AB' }, {}, { id: 42 }]) {
            const res = await request(app).post('/api/admin/log-noise/ack').send(bad);
            expect(res.status).toBe(400);
            expect(res.body.message).toMatch(/10-character hex/);
        }
        expect((await request(app).delete('/api/admin/log-noise/ack/zz')).status).toBe(400);
        expect(fs.existsSync(ackFile())).toBe(false);
        fs.mkdirSync(path.join(dir, 'sentinel'), { recursive: true });
        fs.writeFileSync(ackFile(), '[not json');
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        try {
            expect((await request(app).post('/api/admin/log-noise/ack').send({ id: 'ffffffffff' })).status).toBe(200);
        } finally { logSpy.mockRestore(); }
        expect(Object.keys(read())).toEqual(['ffffffffff']);
    });
});
