/**
 * scripts/watchdog-notifier.js policy (pure: state + log lines -> next state +
 * actions) and scripts/lib/watchdogLog.js cursor reading. Temp dirs only.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    applyPolicy,
    buildEmail,
    readDiagnosis,
    isPublicPathStatus,
    REMIND_EVERY_MS,
    WATCHDOG_SILENT_MS,
    DIAGNOSIS_FRESH_MS
} = require('../../scripts/watchdog-notifier');
const wl = require('../../scripts/lib/watchdogLog');

const T0 = Date.parse('2026-09-20T18:00:00Z');
const at = min => new Date(T0 + min * 60000).toISOString();

// Keep the policy tests hermetic: never read the repo's real diagnosis file.
let diagDir;
beforeAll(() => {
    diagDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notifier-diag-'));
    process.env.WATCHDOG_DIAGNOSIS_FILE = path.join(diagDir, 'missing.json');
});
afterAll(() => {
    delete process.env.WATCHDOG_DIAGNOSIS_FILE;
    fs.rmSync(diagDir, { recursive: true, force: true });
});

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

    test('two consecutive site_down/critical lines open a critical incident with the nginx/cert runbook', () => {
        const siteLine = min => line('site_down', 'critical', min, {
            summary: 'HTTP 502 from https://peninsulafootball.com/ in 12 ms',
            gamesInProgress: 7,
            loopAgeSec: 12,
            signals: [
                { name: 'loop_heartbeat', ok: true, detail: 'loop ticked 12s ago' },
                { name: 'public_site', ok: false, severity: 'critical', detail: 'HTTP 502 from https://peninsulafootball.com/ in 12 ms' },
                { name: 'public_api_fresh', ok: true, detail: 'sync-status unavailable (site down)' },
                { name: 'tls_cert', ok: true, detail: 'expires in 61 days' }
            ]
        });
        const { state, actions } = applyPolicy({}, [siteLine(0), siteLine(2)], { now: T0 + 3 * 60000 });
        expect(state.incident).toMatchObject({ status: 'site_down', severity: 'critical', since: at(0) });
        expect(alerts(actions)).toHaveLength(1);
        expect(alerts(actions)[0].severity).toBe('critical');
        expect(alerts(actions)[0].details).toEqual(['public_site: HTTP 502 from https://peninsulafootball.com/ in 12 ms']);
        expect(emails(actions)).toHaveLength(1);
        expect(emails(actions)[0].kind).toBe('opened');
        expect(emails(actions)[0].subject).toMatch(/^statfink2 LIVE: CRITICAL site_down - HTTP 502/);
        const { body } = emails(actions)[0];
        expect(body).toContain('systemctl status nginx');
        expect(body).toContain('curl -I https://peninsulafootball.com');
        expect(body).toContain('certbot certificates');
        expect(body).toContain('public_site: HTTP 502');
        expect(body).not.toContain('pm2 restart statfink2');
    });

    test('a single site_down line never pages', () => {
        const { state, actions } = applyPolicy({}, [line('site_down', 'critical', 0)], { now: T0 + 60000 });
        expect(state.incident).toBeNull();
        expect(actions).toEqual([]);
    });

    // ---- public_path_unreachable: the watchdog's self-probe of the public hostname ----

    const dnsLine = min => line('public_path_unreachable', 'warning', min, {
        summary: "https://peninsulafootball.com/ unreachable: timeout after 8000 ms - self-probe from this VM, not an external check: the VM's own resolver cannot resolve the public hostname (gateway DNS failing, public DNS answering); TCP/TLS to the public address fine - a VM DNS problem, not proof the site is down",
        publicPathLayer: 'dns',
        gamesInProgress: 7,
        loopAgeSec: 12,
        signals: [
            { name: 'loop_heartbeat', ok: true, detail: 'loop ticked 12s ago' },
            { name: 'public_site', ok: false, severity: 'warning', detail: 'https://peninsulafootball.com/ unreachable: timeout after 8000 ms - self-probe from this VM, not an external check: ...' },
            { name: 'dns_system', ok: false, severity: 'warning', detail: 'system resolver cannot resolve peninsulafootball.com: EAI_AGAIN (2001 ms)' },
            { name: 'dns_gateway', ok: false, severity: 'warning', detail: 'gateway DNS 192.168.1.1 did not answer for peninsulafootball.com: timeout after 2000 ms (2003 ms)' },
            { name: 'dns_public', ok: true, detail: '1.1.1.1 ok 12 ms; 9.9.9.9 ok 15 ms (203.0.113.5)' },
            { name: 'tcp_public', ok: true, detail: 'connected to 203.0.113.5:443 in 4 ms' },
            { name: 'tls_public', ok: true, detail: 'handshake ok' }
        ]
    });
    const httpLine = min => line('public_path_unreachable', 'critical', min, {
        summary: 'HTTP 502 from https://peninsulafootball.com/ in 12 ms - self-probe from this VM, not an external check: DNS, TCP and TLS to the public address are fine, the HTTP layer is failing (nginx / upstream / page content) - confirm from outside',
        publicPathLayer: 'http',
        gamesInProgress: 7,
        loopAgeSec: 12,
        signals: [
            { name: 'loop_heartbeat', ok: true, detail: 'loop ticked 12s ago' },
            { name: 'public_site', ok: false, severity: 'critical', detail: 'HTTP 502 from https://peninsulafootball.com/ in 12 ms - self-probe from this VM, not an external check: ... - confirm from outside' },
            { name: 'dns_system', ok: true, detail: 'resolved' },
            { name: 'tcp_public', ok: true, detail: 'connected' },
            { name: 'tls_public', ok: true, detail: 'handshake ok' }
        ]
    });

    test('the 2026-10 incident: VM DNS self-probe failures are a WARNING incident - dashboard alert, no email, no outage claim', () => {
        const { state, actions } = applyPolicy({}, [dnsLine(0), dnsLine(2), dnsLine(4)], { now: T0 + 5 * 60000 });
        expect(state.incident).toMatchObject({ status: 'public_path_unreachable', severity: 'warning', since: at(0) });
        expect(alerts(actions)).toHaveLength(1);
        expect(alerts(actions)[0].severity).toBe('warning');
        expect(alerts(actions)[0].message).toMatch(/^Live scoring public_path_unreachable: /);
        expect(alerts(actions)[0].message).toContain('not proof the site is down');
        expect(alerts(actions)[0].details).toEqual(expect.arrayContaining([expect.stringMatching(/^dns_gateway: gateway DNS 192\.168\.1\.1 did not answer/)]));
        expect(emails(actions)).toHaveLength(0);

        // Hourly reminders are for critical incidents only: an hour of VM DNS trouble still never emails
        const later = applyPolicy(state, [dnsLine(62)], { now: T0 + 63 * 60000 });
        expect(emails(later.actions)).toHaveLength(0);
        expect(alerts(later.actions)).toHaveLength(0); // same status, same severity: nothing new to say

        // Recovery: one info alert, no "recovered" email (none was ever sent)
        const back = applyPolicy(later.state, [line('ok', 'ok', 64)], { now: T0 + 65 * 60000 });
        expect(back.state.incident).toBeNull();
        expect(alerts(back.actions)).toHaveLength(1);
        expect(alerts(back.actions)[0].severity).toBe('info');
        expect(emails(back.actions)).toHaveLength(0);
    });

    test('a post-DNS self-probe failure (http layer) is a CRITICAL incident whose email says explicitly it is a self-probe to confirm from outside', () => {
        const { state, actions } = applyPolicy({}, [httpLine(0), httpLine(2)], { now: T0 + 3 * 60000 });
        expect(state.incident).toMatchObject({ status: 'public_path_unreachable', severity: 'critical', since: at(0) });
        expect(alerts(actions)).toHaveLength(1);
        expect(alerts(actions)[0].severity).toBe('critical');
        expect(emails(actions)).toHaveLength(1);
        const email = emails(actions)[0];
        expect(email.kind).toBe('opened');
        expect(email.subject).toMatch(/^statfink2 LIVE: CRITICAL public_path_unreachable - HTTP 502/);
        expect(email.body).toContain("NOTE: this is the watchdog's SELF-PROBE of the public hostname from the VM, not an external check (failing layer: http). Confirm from outside before treating it as an outage.");
        expect(email.body).toContain('SELF-PROBE from the VM, not an external check: confirm from OUTSIDE the LAN first');
        expect(email.body).toContain('systemctl status nginx');
        expect(email.body).toContain('certbot certificates');
        expect(email.body).toContain('resolvectl query peninsulafootball.com');
        expect(email.body).toContain('public_site: HTTP 502');
        expect(email.body).not.toContain('pm2 restart statfink2');
        expect(email.body).not.toContain('This line predates the network diagnostics');
    });

    test('a warning (dns) incident escalates once when the layer moves past DNS and stays critical: one escalation alert, one email, no duplicates', () => {
        const open = applyPolicy({}, [dnsLine(0), dnsLine(2)], { now: T0 + 3 * 60000 }).state;
        const esc = applyPolicy(open, [httpLine(4), httpLine(6)], { now: T0 + 7 * 60000 });
        expect(esc.state.incident).toMatchObject({ status: 'public_path_unreachable', severity: 'critical', since: at(0) });
        expect(alerts(esc.actions)).toHaveLength(1);
        expect(alerts(esc.actions)[0].message).toMatch(/^Live scoring escalated to critical \(public_path_unreachable\)/);
        expect(emails(esc.actions)).toHaveLength(1);
        expect(emails(esc.actions)[0].kind).toBe('escalated');
        expect(emails(esc.actions)[0].body).toContain('failing layer: http');
    });

    test('backward compatibility: an open site_down incident from before the rename follows the new lines with ONE status-change alert and no extra email', () => {
        const legacy = applyPolicy({}, [line('site_down', 'critical', 0, { summary: 'HTTP 502 from https://peninsulafootball.com/ in 12 ms' }), line('site_down', 'critical', 2, { summary: 'HTTP 502 from https://peninsulafootball.com/ in 12 ms' })], { now: T0 + 3 * 60000 }).state;
        expect(legacy.incident.status).toBe('site_down');
        legacy.incident.lastEmailAt = at(3); // the opening email went out

        const next = applyPolicy(legacy, [httpLine(4), httpLine(6)], { now: T0 + 7 * 60000 });
        expect(next.state.incident).toMatchObject({ status: 'public_path_unreachable', severity: 'critical', since: at(0) });
        expect(alerts(next.actions)).toHaveLength(1);
        expect(alerts(next.actions)[0].message).toMatch(/^Live scoring incident now public_path_unreachable: /);
        expect(emails(next.actions)).toHaveLength(0);

        // Recovery email for an incident that opened under the old name still renders
        const back = applyPolicy(next.state, [line('ok', 'ok', 8)], { now: T0 + 9 * 60000 });
        expect(emails(back.actions)).toHaveLength(1);
        expect(emails(back.actions)[0].kind).toBe('recovered');
    });

    test('backward compatibility: an hourly reminder for a still-open legacy site_down incident uses the legacy runbook and the self-probe note', () => {
        const legacy = applyPolicy({}, [line('site_down', 'critical', 0), line('site_down', 'critical', 2)], { now: T0 + 3 * 60000 }).state;
        legacy.incident.lastEmailAt = at(3);
        const remind = applyPolicy(legacy, [line('site_down', 'critical', 64)], { now: T0 + 65 * 60000 });
        expect(emails(remind.actions)).toHaveLength(1);
        const email = emails(remind.actions)[0];
        expect(email.kind).toBe('reminder');
        expect(email.subject).toMatch(/^statfink2 LIVE: STILL SITE_DOWN for /);
        expect(email.body).toContain("NOTE: this is the watchdog's SELF-PROBE of the public hostname from the VM, not an external check. Confirm from outside");
        expect(email.body).toContain('This line predates the network diagnostics');
        expect(email.body).toContain('systemctl status nginx');
        expect(alerts(remind.actions)).toHaveLength(0);
    });

    test('isPublicPathStatus: the new and legacy names, nothing else', () => {
        expect(isPublicPathStatus('public_path_unreachable')).toBe(true);
        expect(isPublicPathStatus('site_down')).toBe(true);
        expect(isPublicPathStatus('server_down')).toBe(false);
        expect(isPublicPathStatus('stalled')).toBe(false);
    });

    test('a real server verdict (stalled) and a self-probe failure on the same line: the incident is stalled with the stalled runbook, never public_path_unreachable', () => {
        const both = min => line('stalled', 'critical', min, {
            summary: 'last_live_update 412s ago (limit 180s) - not ticking; https://peninsulafootball.com/ unreachable: timeout after 8000 ms - self-probe from this VM, not an external check: ...',
            publicPathLayer: 'dns',
            signals: [
                { name: 'loop_heartbeat', ok: false, severity: 'critical', detail: 'last_live_update 412s ago (limit 180s) - not ticking' },
                { name: 'public_site', ok: false, severity: 'warning', detail: 'https://peninsulafootball.com/ unreachable: timeout after 8000 ms - self-probe ...' },
                { name: 'dns_system', ok: false, severity: 'warning', detail: 'system resolver cannot resolve peninsulafootball.com: EAI_AGAIN (2001 ms)' }
            ]
        });
        const { state, actions } = applyPolicy({}, [both(0), both(2)], { now: T0 + 3 * 60000 });
        expect(state.incident).toMatchObject({ status: 'stalled', severity: 'critical' });
        expect(emails(actions)).toHaveLength(1);
        expect(emails(actions)[0].subject).toMatch(/^statfink2 LIVE: CRITICAL stalled - /);
        expect(emails(actions)[0].body).toContain('pm2 restart statfink2-live-continuous');
        expect(emails(actions)[0].body).not.toContain('SELF-PROBE of the public hostname');
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

describe('Qwen diagnosis in critical emails', () => {
    const diag = (min, extra = {}) => ({
        ts: at(min), watchdogTs: at(min), status: 'stalled', severity: 'critical', model: 'qwen3',
        diagnosis: 'The live loop has not ticked since a Tank01 timeout at 17:52.',
        suggestedAction: 'pm2 restart statfink2-live-continuous', ...extra
    });
    const incident = () => applyPolicy({}, [line('stalled', 'critical', 0), line('stalled', 'critical', 2)], { now: T0 + 3 * 60000 }).state.incident;
    let file;
    beforeEach(() => { file = path.join(diagDir, `diag-${Date.now()}-${Math.random()}.json`); });

    test('readDiagnosis: fresh and not ok is returned; stale, ok, missing and corrupt are null', () => {
        const now = T0 + 5 * 60000;
        fs.writeFileSync(file, JSON.stringify(diag(2)));
        expect(readDiagnosis(now, file)).toEqual({ ts: at(2), severity: 'critical', status: 'stalled', model: 'qwen3',
            diagnosis: 'The live loop has not ticked since a Tank01 timeout at 17:52.', suggestedAction: 'pm2 restart statfink2-live-continuous' });

        fs.writeFileSync(file, JSON.stringify(diag(5 - DIAGNOSIS_FRESH_MS / 60000)));
        expect(readDiagnosis(now, file)).toBeNull(); // exactly 15 min old: stale
        fs.writeFileSync(file, JSON.stringify(diag(2, { severity: 'ok', diagnosis: 'Nothing is wrong.' })));
        expect(readDiagnosis(now, file)).toBeNull();
        fs.writeFileSync(file, JSON.stringify(diag(2, { ts: 'not a date' })));
        expect(readDiagnosis(now, file)).toBeNull();
        fs.writeFileSync(file, '{ nope');
        expect(readDiagnosis(now, file)).toBeNull();
        expect(readDiagnosis(now, path.join(diagDir, 'does-not-exist.json'))).toBeNull();
        // the env override is the default file
        fs.writeFileSync(file, JSON.stringify(diag(2)));
        process.env.WATCHDOG_DIAGNOSIS_FILE = file;
        try { expect(readDiagnosis(now).severity).toBe('critical'); }
        finally { process.env.WATCHDOG_DIAGNOSIS_FILE = path.join(diagDir, 'missing.json'); }
    });

    test('a fresh diagnosis is appended to opened, escalated and reminder emails, after the runbook', () => {
        const now = T0 + 5 * 60000;
        const d = readDiagnosis(now, (fs.writeFileSync(file, JSON.stringify(diag(3))), file));
        for (const kind of ['opened', 'escalated', 'reminder']) {
            const { body } = buildEmail(kind, incident(), now, { diagnosis: d });
            expect(body).toContain(`Diagnosis (Qwen, ${at(3)}): The live loop has not ticked since a Tank01 timeout at 17:52.`);
            expect(body).toContain('Suggested: pm2 restart statfink2-live-continuous');
            expect(body.indexOf('What to look at:')).toBeLessThan(body.indexOf('Diagnosis (Qwen'));
            expect(body.indexOf('Diagnosis (Qwen')).toBeLessThan(body.indexOf('Watchdog log:'));
        }
        // never on a recovery email
        expect(buildEmail('recovered', incident(), now, { diagnosis: d }).body).not.toContain('Diagnosis (Qwen');
    });

    test('stale or ok diagnoses and a missing file leave the email unchanged', () => {
        const now = T0 + 5 * 60000;
        const plain = buildEmail('opened', incident(), now, { diagnosis: null }).body;
        expect(plain).not.toContain('Diagnosis');
        fs.writeFileSync(file, JSON.stringify(diag(-20)));
        expect(buildEmail('opened', incident(), now, { diagnosis: readDiagnosis(now, file) }).body).toBe(plain);
        fs.writeFileSync(file, JSON.stringify(diag(4, { severity: 'ok' })));
        expect(buildEmail('opened', incident(), now, { diagnosis: readDiagnosis(now, file) }).body).toBe(plain);
        // default path: reads the (missing) env file
        expect(buildEmail('opened', incident(), now).body).toBe(plain);
    });

    test('applyPolicy picks the diagnosis up through the env-configured file', () => {
        fs.writeFileSync(file, JSON.stringify(diag(2)));
        process.env.WATCHDOG_DIAGNOSIS_FILE = file;
        try {
            const { actions } = applyPolicy({}, [line('stalled', 'critical', 0), line('stalled', 'critical', 2)], { now: T0 + 3 * 60000 });
            expect(emails(actions)).toHaveLength(1);
            expect(emails(actions)[0].body).toContain('Diagnosis (Qwen');
            expect(emails(actions)[0].body).toContain('pm2 restart statfink2-live-continuous');
        } finally {
            process.env.WATCHDOG_DIAGNOSIS_FILE = path.join(diagDir, 'missing.json');
        }
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
