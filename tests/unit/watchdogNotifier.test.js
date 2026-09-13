/**
 * scripts/watchdog-notifier.js policy (pure: state + log lines -> next state +
 * actions) and scripts/lib/watchdogLog.js cursor reading. Temp dirs only.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    applyPolicy,
    REMIND_EVERY_MS,
    WATCHDOG_SILENT_MS
} = require('../../scripts/watchdog-notifier');
const wl = require('../../scripts/lib/watchdogLog');

const T0 = Date.parse('2026-09-20T18:00:00Z');
const at = min => new Date(T0 + min * 60000).toISOString();

function line(status, severity, min, extra = {}) {
    return {
        ts: at(min),
        status,
        severity,
        summary: `${status} summary at +${min}m`,
        week: 2,
        season: 2026,
        expectedGames: 9,
        signals: [{ name: 'loop_heartbeat', ok: severity === 'ok', severity, detail: 'detail text' }],
        ...extra
    };
}

const emails = actions => actions.filter(a => a.type === 'email');
const alerts = actions => actions.filter(a => a.type === 'alert');

describe('watchdog notifier policy', () => {
    test('a single bad line followed by ok does nothing', () => {
        const { state, actions } = applyPolicy({}, [line('stalled', 'critical', 0), line('ok', 'ok', 2)], { now: T0 + 3 * 60000 });
        expect(actions).toEqual([]);
        expect(state.incident).toBeNull();
        expect(state.badStreak).toEqual([]);
    });

    test('two consecutive critical lines open a critical incident: alert + email', () => {
        const { state, actions } = applyPolicy({}, [line('stalled', 'critical', 0), line('stalled', 'critical', 2)], { now: T0 + 3 * 60000 });
        expect(state.incident).toMatchObject({ status: 'stalled', severity: 'critical', since: at(0) });
        expect(alerts(actions)).toHaveLength(1);
        expect(alerts(actions)[0].severity).toBe('critical');
        expect(emails(actions)).toHaveLength(1);
        expect(emails(actions)[0].kind).toBe('opened');
        expect(emails(actions)[0].subject).toMatch(/^statfink2 LIVE: CRITICAL stalled/);
        expect(emails(actions)[0].body).toContain('pm2 logs statfink2-live-continuous');
        expect(emails(actions)[0].body).toContain('loop_heartbeat: detail text');
    });

    test('two consecutive warning lines open a warning incident: dashboard alert only', () => {
        const { state, actions } = applyPolicy({}, [line('degraded', 'warning', 0), line('degraded', 'warning', 2)], { now: T0 + 3 * 60000 });
        expect(state.incident.severity).toBe('warning');
        expect(alerts(actions)).toHaveLength(1);
        expect(emails(actions)).toHaveLength(0);
    });

    test('a warning incident escalates to critical after two critical lines', () => {
        let r = applyPolicy({}, [line('degraded', 'warning', 0), line('degraded', 'warning', 2)], { now: T0 + 3 * 60000 });
        r = applyPolicy(r.state, [line('stalled', 'critical', 4)], { now: T0 + 5 * 60000 });
        expect(r.state.incident.severity).toBe('warning');
        expect(emails(r.actions)).toHaveLength(0);
        expect(alerts(r.actions)).toHaveLength(1); // status changed degraded -> stalled

        r = applyPolicy(r.state, [line('stalled', 'critical', 6)], { now: T0 + 7 * 60000 });
        expect(r.state.incident.severity).toBe('critical');
        expect(emails(r.actions)).toHaveLength(1);
        expect(emails(r.actions)[0].kind).toBe('escalated');
    });

    test('the bad streak survives across runs (state persistence)', () => {
        const run1 = applyPolicy({}, [line('server_down', 'critical', 0)], { now: T0 + 60000 });
        expect(run1.state.incident).toBeNull();
        expect(run1.actions).toEqual([]);
        const run2 = applyPolicy(run1.state, [line('server_down', 'critical', 2)], { now: T0 + 3 * 60000 });
        expect(run2.state.incident).toMatchObject({ status: 'server_down', severity: 'critical', since: at(0) });
        expect(emails(run2.actions)).toHaveLength(1);
    });

    test('recovery closes a critical incident with an info alert and a recovery email', () => {
        let r = applyPolicy({}, [line('stalled', 'critical', 0), line('stalled', 'critical', 2)], { now: T0 + 3 * 60000 });
        r.state.incident.lastEmailAt = at(3);
        r.state.incident.emails = 1;
        r = applyPolicy(r.state, [line('ok', 'ok', 40)], { now: T0 + 41 * 60000 });
        expect(r.state.incident).toBeNull();
        expect(alerts(r.actions)).toHaveLength(1);
        expect(alerts(r.actions)[0].severity).toBe('info');
        expect(alerts(r.actions)[0].message).toContain('recovered after 40m');
        expect(emails(r.actions)).toHaveLength(1);
        expect(emails(r.actions)[0].kind).toBe('recovered');
        expect(emails(r.actions)[0].subject).toContain('RECOVERED after 40m');
    });

    test('recovery from a warning incident does not email', () => {
        let r = applyPolicy({}, [line('degraded', 'warning', 0), line('degraded', 'warning', 2)], { now: T0 + 3 * 60000 });
        r = applyPolicy(r.state, [line('idle', 'ok', 4)], { now: T0 + 5 * 60000 });
        expect(r.state.incident).toBeNull();
        expect(alerts(r.actions)).toHaveLength(1);
        expect(emails(r.actions)).toHaveLength(0);
    });

    test('critical incidents get an hourly reminder email, not sooner', () => {
        const base = applyPolicy({}, [line('stalled', 'critical', 0), line('stalled', 'critical', 2)], { now: T0 + 3 * 60000 }).state;

        base.incident.lastEmailAt = new Date(T0 - 30 * 60000).toISOString();
        expect(emails(applyPolicy(base, [line('stalled', 'critical', 4)], { now: T0 + 5 * 60000 }).actions)).toHaveLength(0);

        base.incident.lastEmailAt = new Date(T0 + 5 * 60000 - REMIND_EVERY_MS - 1000).toISOString();
        const reminded = applyPolicy(base, [line('stalled', 'critical', 4)], { now: T0 + 5 * 60000 });
        expect(emails(reminded.actions)).toHaveLength(1);
        expect(emails(reminded.actions)[0].kind).toBe('reminder');
        expect(emails(reminded.actions)[0].subject).toContain('STILL STALLED');
    });

    test('a never-sent critical email is retried on the next run', () => {
        const base = applyPolicy({}, [line('stalled', 'critical', 0), line('stalled', 'critical', 2)], { now: T0 + 3 * 60000 }).state;
        expect(base.incident.lastEmailAt).toBeNull(); // executor sets it only on success
        const retry = applyPolicy(base, [], { now: T0 + 8 * 60000 });
        expect(emails(retry.actions)).toHaveLength(1);
        expect(retry.actions.some(a => a.type === 'alert')).toBe(false);
    });

    test('maintenance lines neither open nor close incidents', () => {
        const quiet = applyPolicy({}, [line('maintenance', 'ok', 0), line('maintenance', 'ok', 2)], { now: T0 + 3 * 60000 });
        expect(quiet.actions).toEqual([]);
        expect(quiet.state.incident).toBeNull();

        const open = applyPolicy({}, [line('stalled', 'critical', 0), line('stalled', 'critical', 2)], { now: T0 + 3 * 60000 }).state;
        open.incident.lastEmailAt = at(3);
        const held = applyPolicy(open, [line('maintenance', 'ok', 4)], { now: T0 + 5 * 60000 });
        expect(held.state.incident).not.toBeNull();
        expect(held.state.incident.status).toBe('stalled');
        expect(held.actions).toEqual([]);
    });

    test('a stale maintenance lock (maintenance/warning) counts as a bad line', () => {
        const r = applyPolicy({}, [line('maintenance', 'warning', 0), line('maintenance', 'warning', 2)], { now: T0 + 3 * 60000 });
        expect(r.state.incident).toMatchObject({ status: 'maintenance', severity: 'warning' });
        expect(alerts(r.actions)).toHaveLength(1);
    });

    test('a silent log opens a watchdog_dead incident unless a maintenance lock explains it', () => {
        const state = { lastLineTs: at(0), incident: null, badStreak: [] };
        const now = T0 + WATCHDOG_SILENT_MS + 60000;

        const covered = applyPolicy(state, [], { now, lockAgeSec: 120 });
        expect(covered.state.incident).toBeNull();
        expect(covered.actions).toEqual([]);

        const dead = applyPolicy(state, [], { now, lockAgeSec: null });
        expect(dead.state.incident).toMatchObject({ status: 'watchdog_dead', severity: 'critical' });
        expect(alerts(dead.actions)).toHaveLength(1);
        expect(emails(dead.actions)).toHaveLength(1);
        expect(emails(dead.actions)[0].body).toContain('pm2 restart statfink2-watchdog');

        // Lines resume healthy: closes with a recovery email
        dead.state.incident.lastEmailAt = new Date(now).toISOString();
        const back = applyPolicy(dead.state, [line('idle', 'ok', 30)], { now: T0 + 31 * 60000 });
        expect(back.state.incident).toBeNull();
        expect(emails(back.actions)).toHaveLength(1);
        expect(emails(back.actions)[0].kind).toBe('recovered');
    });

    test('a status change inside an open incident is a dashboard alert, not an email', () => {
        const open = applyPolicy({}, [line('stalled', 'critical', 0), line('stalled', 'critical', 2)], { now: T0 + 3 * 60000 }).state;
        open.incident.lastEmailAt = at(3);
        const r = applyPolicy(open, [line('degraded', 'warning', 4)], { now: T0 + 5 * 60000 });
        expect(r.state.incident.status).toBe('degraded');
        expect(r.state.incident.severity).toBe('critical'); // never downgraded while open
        expect(alerts(r.actions)).toHaveLength(1);
        expect(emails(r.actions)).toHaveLength(0);
    });
});

describe('watchdog log cursor reading', () => {
    let dir;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-log-'));
    });

    test('appendEntry writes the daily file and live-latest.json', () => {
        const day = new Date('2026-09-20T18:00:00Z');
        wl.appendEntry({ ts: day.toISOString(), status: 'ok', severity: 'ok', summary: 's' }, { dir, now: day });
        expect(fs.existsSync(path.join(dir, 'live-2026-09-20.jsonl'))).toBe(true);
        expect(wl.readLatest(dir)).toMatchObject({ status: 'ok' });
    });

    test('reads only new complete lines and advances the cursor across days', () => {
        const d1 = new Date('2026-09-20T23:58:00Z');
        const d2 = new Date('2026-09-21T00:02:00Z');
        wl.appendEntry({ ts: d1.toISOString(), status: 'ok', severity: 'ok', summary: 'a' }, { dir, now: d1 });
        wl.appendEntry({ ts: d1.toISOString(), status: 'ok', severity: 'ok', summary: 'b' }, { dir, now: d1 });

        const first = wl.readLinesSince(null, dir);
        expect(first.lines.map(l => l.summary)).toEqual(['a', 'b']);
        expect(first.cursor.file).toBe('live-2026-09-20.jsonl');

        const again = wl.readLinesSince(first.cursor, dir);
        expect(again.lines).toEqual([]);

        wl.appendEntry({ ts: d1.toISOString(), status: 'stalled', severity: 'critical', summary: 'c' }, { dir, now: d1 });
        wl.appendEntry({ ts: d2.toISOString(), status: 'stalled', severity: 'critical', summary: 'd' }, { dir, now: d2 });
        // A torn write in progress (no trailing newline) is left for next time
        fs.appendFileSync(path.join(dir, 'live-2026-09-21.jsonl'), '{"ts":"2026-09-21T00:04:00Z","status":"ok"');

        const next = wl.readLinesSince(first.cursor, dir);
        expect(next.lines.map(l => l.summary)).toEqual(['c', 'd']);
        expect(next.cursor.file).toBe('live-2026-09-21.jsonl');

        fs.appendFileSync(path.join(dir, 'live-2026-09-21.jsonl'), ',"severity":"ok","summary":"e"}\n');
        const finished = wl.readLinesSince(next.cursor, dir);
        expect(finished.lines.map(l => l.summary)).toEqual(['e']);
    });

    test('a cursor pointing at a pruned file resumes with the next file', () => {
        const d = new Date('2026-09-21T00:02:00Z');
        wl.appendEntry({ ts: d.toISOString(), status: 'ok', severity: 'ok', summary: 'x' }, { dir, now: d });
        const r = wl.readLinesSince({ file: 'live-2026-08-01.jsonl', offset: 999 }, dir);
        expect(r.lines.map(l => l.summary)).toEqual(['x']);
        expect(r.cursor.file).toBe('live-2026-09-21.jsonl');
    });

    test('pruneOldLogs removes files older than the retention window', () => {
        for (const day of ['2026-08-01', '2026-09-19', '2026-09-20']) {
            fs.writeFileSync(path.join(dir, `live-${day}.jsonl`), '{}\n');
        }
        const removed = wl.pruneOldLogs(30, dir, new Date('2026-09-20T12:00:00Z'));
        expect(removed).toEqual(['live-2026-08-01.jsonl']);
        expect(wl.listLogFiles(dir)).toEqual(['live-2026-09-19.jsonl', 'live-2026-09-20.jsonl']);
    });
});
