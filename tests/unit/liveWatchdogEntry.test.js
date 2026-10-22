/**
 * scripts/live-watchdog.js buildEntry - pure assembly of one watchdog line
 * from the server's answer (or its absence), the maintenance lock and the
 * script-side signals. No network, no files.
 */

const { buildEntry, MAINTENANCE_STUCK_SEC } = require('../../scripts/live-watchdog');
const { SIGNAL_NAMES: NET_SIGNALS } = require('../../scripts/lib/netDiag');

const NOW = Date.parse('2026-09-20T18:07:02.037Z');
const TS = '2026-09-20T18:07:02.037Z';

const serverOk = () => ({
    checkedAt: TS,
    week: 2,
    season: 2026,
    loopAgeSec: 12,
    status: 'ok',
    severity: 'ok',
    expectedGames: 9,
    gamesInProgress: 7,
    signals: [
        { name: 'expected_activity', ok: true, detail: '9 game(s) in the live window' },
        { name: 'week_match', ok: true },
        { name: 'loop_heartbeat', ok: true, detail: 'loop ticked 12s ago' },
        { name: 'game_freshness', ok: true, detail: '7 in progress, all updated within 300s' },
        { name: 'stats_flow', ok: true, detail: 'player_stats written 40s ago' },
        { name: 'matchup_totals', ok: true, detail: 'All 6 matchups match' },
        { name: 'live_errors', ok: true },
        { name: 'disk_free', ok: true, detail: '50.4 GB free' }
    ],
    summary: '9 game(s) in window (7 in progress), loop ticked 12s ago, stats flowing'
});

const probesOk = () => [
    { name: 'public_site', ok: true, detail: '200 in 41 ms → https://peninsulafootball.com/statfink/2026/2' },
    { name: 'public_api_fresh', ok: true, detail: 'last_sync_time 0s ago' },
    { name: 'tls_cert', ok: true, detail: 'expires in 61 days' },
    { name: 'scores_vs_espn', ok: true, detail: '7 game(s) match ESPN' }
];

const siteDown = () => [
    { name: 'public_site', ok: false, severity: 'critical', detail: 'HTTP 502 from https://peninsulafootball.com/ in 12 ms' },
    { name: 'public_api_fresh', ok: true, detail: 'sync-status unavailable (site down)' },
    { name: 'tls_cert', ok: true, detail: 'expires in 61 days' },
    { name: 'scores_vs_espn', ok: true, detail: '7 game(s) match ESPN' }
];

// scripts/lib/netDiag.js signals as the watchdog gathers them every tick
const netOk = () => [
    { name: 'dns_system', ok: true, detail: 'peninsulafootball.com → 203.0.113.5 in 3 ms (system resolver)' },
    { name: 'dns_gateway', ok: true, detail: '192.168.1.1 answered for peninsulafootball.com in 4 ms (203.0.113.5)' },
    { name: 'dns_public', ok: true, detail: '1.1.1.1 ok 12 ms; 9.9.9.9 ok 15 ms (203.0.113.5)' },
    { name: 'tcp_public', ok: true, detail: 'connected to 203.0.113.5:443 in 4 ms' },
    { name: 'tls_public', ok: true, detail: 'handshake with 203.0.113.5:443 (SNI peninsulafootball.com) ok in 21 ms, TLSv1.3, CN=peninsulafootball.com' }
];

// The 2026-10 incident: the VM's resolver (via the gateway) is dead, the
// independent public resolver answers, TCP/TLS to the public address work,
// and the self-probe of the public hostname times out.
const vmDnsBroken = () => [
    { name: 'public_site', ok: false, severity: 'critical', detail: 'https://peninsulafootball.com/ unreachable: timeout after 8000 ms' },
    { name: 'public_api_fresh', ok: true, detail: 'sync-status unavailable (site down)' },
    { name: 'tls_cert', ok: false, severity: 'warning', detail: 'TLS check failed: getaddrinfo EAI_AGAIN peninsulafootball.com' },
    { name: 'dns_system', ok: false, severity: 'warning', detail: 'system resolver cannot resolve peninsulafootball.com: EAI_AGAIN (2001 ms)' },
    { name: 'dns_gateway', ok: false, severity: 'warning', detail: 'gateway DNS 192.168.1.1 did not answer for peninsulafootball.com: timeout after 2000 ms (2003 ms)' },
    { name: 'dns_public', ok: true, detail: '1.1.1.1 ok 12 ms; 9.9.9.9 ok 15 ms (203.0.113.5)' },
    { name: 'tcp_public', ok: true, detail: 'connected to 203.0.113.5:443 in 4 ms' },
    { name: 'tls_public', ok: true, detail: 'handshake with 203.0.113.5:443 (SNI peninsulafootball.com) ok in 21 ms, TLSv1.3, CN=peninsulafootball.com' },
    { name: 'scores_vs_espn', ok: true, detail: '7 game(s) match ESPN' }
];

describe('buildEntry: server answered', () => {
    test('ok probes leave status/severity/summary exactly as the server said, signals appended', () => {
        const data = serverOk();
        const e = buildEntry({ serverData: data, extraSignals: probesOk(), now: NOW });
        expect(e.ts).toBe(TS);
        expect(e.status).toBe('ok');
        expect(e.severity).toBe('ok');
        expect(e.summary).toBe(data.summary);
        expect(e.maintenance).toBe(false);
        expect(e.signals.map(s => s.name)).toEqual([...data.signals.map(s => s.name), 'public_site', 'public_api_fresh', 'tls_cert', 'scores_vs_espn']);
        expect(e).toMatchObject({ week: 2, season: 2026, expectedGames: 9, gamesInProgress: 7, loopAgeSec: 12, checkedAt: TS });
        expect(e.durationMs).toBeUndefined(); // the caller measures the tick
    });

    test('an idle server line stays idle with probes attached', () => {
        const data = { ...serverOk(), status: 'idle', expectedGames: 0, gamesInProgress: 0, summary: 'No games in the live window; loop ticked 12s ago' };
        const e = buildEntry({ serverData: data, extraSignals: [{ name: 'public_site', ok: true, detail: '200' }, { name: 'scores_vs_espn', ok: true, detail: 'idle' }], now: NOW });
        expect(e.status).toBe('idle');
        expect(e.severity).toBe('ok');
        expect(e.summary).toBe('No games in the live window; loop ticked 12s ago');
    });

    test('public_site critical with the network path fine (HTTP layer) -> public_path_unreachable/critical, never site_down', () => {
        const e = buildEntry({ serverData: serverOk(), extraSignals: [...siteDown(), ...netOk()], now: NOW });
        expect(e.status).toBe('public_path_unreachable');
        expect(e.severity).toBe('critical');
        expect(e.publicPathLayer).toBe('http');
        expect(e.summary.startsWith('HTTP 502 from https://peninsulafootball.com/ in 12 ms - self-probe from this VM, not an external check')).toBe(true);
        const site = e.signals.find(s => s.name === 'public_site');
        expect(site).toMatchObject({ ok: false, severity: 'critical' });
        expect(site.detail).toBe('HTTP 502 from https://peninsulafootball.com/ in 12 ms - self-probe from this VM, not an external check: DNS, TCP and TLS to the public address are fine, the HTTP layer is failing (nginx / upstream / page content) - confirm from outside');
        expect(e.signals.map(s => s.name)).toEqual([...serverOk().signals.map(s => s.name), 'public_site', 'public_api_fresh', 'tls_cert', 'scores_vs_espn', ...NET_SIGNALS]);
    });

    test('public_site critical with no network diagnostics on the line -> still public_path_unreachable/critical, worded as a self-probe', () => {
        const e = buildEntry({ serverData: serverOk(), extraSignals: siteDown(), now: NOW });
        expect(e.status).toBe('public_path_unreachable');
        expect(e.severity).toBe('critical');
        expect(e.publicPathLayer).toBe('unknown');
        expect(e.summary.startsWith('HTTP 502 from https://peninsulafootball.com/ in 12 ms - self-probe from this VM, not an external check (no network diagnostics on this line)')).toBe(true);
    });

    test('the incident: self-probe fails because the VM cannot resolve its own hostname while the app is healthy -> public_path_unreachable/WARNING, not a proven outage', () => {
        const e = buildEntry({ serverData: serverOk(), extraSignals: vmDnsBroken(), now: NOW });
        expect(e.status).toBe('public_path_unreachable');
        expect(e.severity).toBe('warning');
        expect(e.publicPathLayer).toBe('dns');
        expect(e.summary.startsWith('https://peninsulafootball.com/ unreachable: timeout after 8000 ms - self-probe from this VM, not an external check')).toBe(true);
        expect(e.summary).not.toMatch(/site_down/);
        const site = e.signals.find(s => s.name === 'public_site');
        expect(site).toMatchObject({ ok: false, severity: 'warning' });
        expect(site.detail).toBe("https://peninsulafootball.com/ unreachable: timeout after 8000 ms - self-probe from this VM, not an external check: the VM's own resolver cannot resolve the public hostname (gateway DNS failing, public DNS answering); TCP/TLS to the public address fine - a VM DNS problem, not proof the site is down");
        expect(e.signals.find(s => s.name === 'dns_gateway')).toMatchObject({ ok: false, severity: 'warning' });
        expect(e.signals.find(s => s.name === 'dns_public').ok).toBe(true);
    });

    test('a critical server verdict (misconfigured) is never hidden behind the public self-probe; its detail leads the summary', () => {
        const data = serverOk();
        data.status = 'misconfigured';
        data.severity = 'critical';
        data.signals[1] = { name: 'week_match', ok: false, severity: 'critical', detail: '1 game(s) live in week 3 but current_week is 2' };
        data.summary = data.signals[1].detail;
        const e = buildEntry({ serverData: data, extraSignals: vmDnsBroken(), now: NOW });
        expect(e.status).toBe('misconfigured');
        expect(e.severity).toBe('critical');
        expect(e.summary.startsWith('1 game(s) live in week 3 but current_week is 2; ')).toBe(true);
    });

    test('a stalled live pipeline during games keeps stalled/critical even when the self-probe is explained by VM DNS', () => {
        const data = serverOk();
        data.status = 'stalled';
        data.severity = 'critical';
        data.signals[2] = { name: 'loop_heartbeat', ok: false, severity: 'critical', detail: 'last_live_update 412s ago (limit 180s) - not ticking' };
        data.summary = data.signals[2].detail;
        const e = buildEntry({ serverData: data, extraSignals: vmDnsBroken(), now: NOW });
        expect(e).toMatchObject({ status: 'stalled', severity: 'critical', publicPathLayer: 'dns' });
        expect(e.summary.startsWith('last_live_update 412s ago (limit 180s) - not ticking; ')).toBe(true);
    });

    test('the server says critical live_errors / game_freshness because Tank01 is unreachable through the same dead resolver -> stalled/critical: the real local verdict, not the self-probe', () => {
        const data = serverOk();
        data.status = 'stalled';
        data.severity = 'critical';
        data.signals[3] = { name: 'game_freshness', ok: false, severity: 'critical', detail: '7 in progress, 7 not updated in 300s' };
        data.signals[6] = { name: 'live_errors', ok: false, severity: 'warning', detail: 'last update swallowed 3 error(s): getaddrinfo EAI_AGAIN tank01' };
        data.summary = `${data.signals[3].detail}; ${data.signals[6].detail}`;
        const e = buildEntry({ serverData: data, extraSignals: vmDnsBroken(), now: NOW });
        expect(e).toMatchObject({ status: 'stalled', severity: 'critical', publicPathLayer: 'dns' });
        expect(e.summary.startsWith('7 in progress, 7 not updated in 300s; last update swallowed 3 error(s)')).toBe(true);
        expect(e.signals.find(s => s.name === 'public_site')).toMatchObject({ ok: false, severity: 'warning' });
    });

    test('a post-DNS self-probe failure (TCP refused) outranks warning-only server signals: public_path_unreachable/critical, layer tcp', () => {
        const data = serverOk();
        data.status = 'degraded';
        data.severity = 'warning';
        data.signals[4] = { name: 'stats_flow', ok: false, severity: 'warning', detail: 'game status moved but no player_stats written in 420s' };
        data.summary = data.signals[4].detail;
        const net = netOk();
        net[3] = { name: 'tcp_public', ok: false, severity: 'warning', detail: 'connect to 203.0.113.5:443 failed: ECONNREFUSED (3 ms)' };
        net[4] = { name: 'tls_public', ok: true, detail: 'not attempted (tcp_public failed)' };
        const e = buildEntry({ serverData: data, extraSignals: [...siteDown(), ...net], now: NOW });
        expect(e).toMatchObject({ status: 'public_path_unreachable', severity: 'critical', publicPathLayer: 'tcp' });
        expect(e.signals.find(s => s.name === 'public_site').detail).toContain('the hostname resolves but TCP to the public address fails - confirm from outside');
    });

    test('no line built here ever carries the retired site_down status', () => {
        const stalled = serverOk();
        stalled.signals[2] = { name: 'loop_heartbeat', ok: false, severity: 'critical', detail: 'not ticking' };
        const lines = [
            buildEntry({ serverData: serverOk(), extraSignals: [...siteDown(), ...netOk()], now: NOW }),
            buildEntry({ serverData: serverOk(), extraSignals: siteDown(), now: NOW }),
            buildEntry({ serverData: serverOk(), extraSignals: vmDnsBroken(), now: NOW }),
            buildEntry({ serverData: stalled, extraSignals: vmDnsBroken(), now: NOW }),
            buildEntry({ serverError: 'ECONNREFUSED', expectedGames: 1, extraSignals: siteDown(), now: NOW })
        ];
        expect(lines.map(l => l.status)).toEqual(['public_path_unreachable', 'public_path_unreachable', 'public_path_unreachable', 'stalled', 'server_down']);
        expect(JSON.stringify(lines)).not.toContain('site_down');
    });

    test('a failing diagnostic alone (gateway DNS dead, public site fine) is only degraded/warning', () => {
        const net = netOk();
        net[1] = { name: 'dns_gateway', ok: false, severity: 'warning', detail: 'gateway DNS 192.168.1.1 did not answer for peninsulafootball.com: timeout after 2000 ms (2003 ms)' };
        const e = buildEntry({ serverData: serverOk(), extraSignals: [...probesOk(), ...net], now: NOW });
        expect(e.status).toBe('degraded');
        expect(e.severity).toBe('warning');
        expect(e.publicPathLayer).toBeUndefined();
        expect(e.summary).toContain('gateway DNS 192.168.1.1 did not answer');
    });

    test('warning-only probes (tls, api freshness, scores) -> degraded/warning', () => {
        const e = buildEntry({
            serverData: serverOk(),
            extraSignals: [
                { name: 'public_site', ok: true, detail: '200' },
                { name: 'public_api_fresh', ok: false, severity: 'warning', detail: 'public API last live update 9 min ago (last_live_update)' },
                { name: 'tls_cert', ok: false, severity: 'warning', detail: 'certificate expires in 10 days' },
                { name: 'scores_vs_espn', ok: false, severity: 'warning', detail: '1 of 7 game(s) behind ESPN: LAC@KC espn 21-24, ours 21-17, ours updated 9 min ago' }
            ],
            now: NOW
        });
        expect(e.status).toBe('degraded');
        expect(e.severity).toBe('warning');
        expect(e.summary).toContain('9 min ago (last_live_update); certificate expires in 10 days; 1 of 7');
    });

    test('a stalled server verdict is kept when the probes are fine', () => {
        const data = serverOk();
        data.status = 'stalled';
        data.severity = 'critical';
        data.signals[2] = { name: 'loop_heartbeat', ok: false, severity: 'critical', detail: 'last_live_update 412s ago (limit 180s) - not ticking' };
        data.summary = data.signals[2].detail;
        const e = buildEntry({ serverData: data, extraSignals: probesOk(), now: NOW });
        expect(e).toMatchObject({ status: 'stalled', severity: 'critical', summary: data.summary });
    });

    test('no extra signals at all behaves like the old line', () => {
        const data = serverOk();
        const e = buildEntry({ serverData: data, now: NOW });
        expect(e.signals).toHaveLength(8);
        expect(e).toMatchObject({ status: 'ok', severity: 'ok', summary: data.summary });
    });
});

describe('buildEntry: server down', () => {
    test('server_reachable signal plus probes; status stays server_down; old summary text preserved', () => {
        const e = buildEntry({ serverError: 'connect ECONNREFUSED 127.0.0.1:8000', expectedGames: 3, extraSignals: probesOk(), now: NOW });
        expect(e).toMatchObject({ ts: TS, status: 'server_down', severity: 'critical', expectedGames: 3, maintenance: false });
        expect(e.summary).toBe('statfink2 server unreachable (connect ECONNREFUSED 127.0.0.1:8000); 3 game(s) in the live window');
        expect(e.signals[0]).toEqual({ name: 'server_reachable', ok: false, severity: 'critical', detail: 'GET /api/internal/health/live failed: connect ECONNREFUSED 127.0.0.1:8000' });
        expect(e.signals.map(s => s.name)).toEqual(['server_reachable', 'public_site', 'public_api_fresh', 'tls_cert', 'scores_vs_espn']);
    });

    test('games note: none in window / unknown', () => {
        expect(buildEntry({ serverError: 'HTTP 500', expectedGames: 0, now: NOW }).summary)
            .toBe('statfink2 server unreachable (HTTP 500); no games in the live window');
        expect(buildEntry({ serverError: 'timeout of 30000ms exceeded', expectedGames: null, now: NOW }).summary)
            .toBe('statfink2 server unreachable (timeout of 30000ms exceeded)');
        expect(buildEntry({ expectedGames: null, now: NOW }).summary).toBe('statfink2 server unreachable (no response)');
    });

    test('public site also down -> still server_down (server_reachable has priority), site detail in the summary', () => {
        const e = buildEntry({ serverError: 'connect ECONNREFUSED 127.0.0.1:8000', expectedGames: 0, extraSignals: siteDown(), now: NOW });
        expect(e.status).toBe('server_down');
        expect(e.severity).toBe('critical');
        expect(e.summary).toBe('statfink2 server unreachable (connect ECONNREFUSED 127.0.0.1:8000); no games in the live window; HTTP 502 from https://peninsulafootball.com/ in 12 ms');
    });

    test('server down with the VM DNS broken -> server_down/critical untouched; the diagnostics ride along unannotated', () => {
        const e = buildEntry({ serverError: 'timeout of 30000ms exceeded', expectedGames: 3, extraSignals: vmDnsBroken(), now: NOW });
        expect(e.status).toBe('server_down');
        expect(e.severity).toBe('critical');
        expect(e.publicPathLayer).toBeUndefined();
        expect(e.signals.find(s => s.name === 'public_site')).toMatchObject({ ok: false, severity: 'critical', detail: 'https://peninsulafootball.com/ unreachable: timeout after 8000 ms' });
        expect(e.signals.map(s => s.name)).toContain('dns_gateway');
    });
});

describe('buildEntry: maintenance', () => {
    test('fresh lock -> maintenance/ok, no signals even when probes are passed', () => {
        const e = buildEntry({ maintenanceLockAgeSec: 120, extraSignals: siteDown(), serverData: serverOk(), now: NOW });
        expect(e).toEqual({
            ts: TS,
            status: 'maintenance',
            severity: 'ok',
            maintenance: true,
            lockAgeSec: 120,
            signals: [],
            summary: 'Maintenance window (logs/maintenance.lock, 120s old) - checks skipped'
        });
    });

    test('stale lock -> maintenance/warning', () => {
        const e = buildEntry({ maintenanceLockAgeSec: MAINTENANCE_STUCK_SEC + 60, now: NOW });
        expect(e.status).toBe('maintenance');
        expect(e.severity).toBe('warning');
        expect(e.summary).toContain('31m old (limit 30m)');
    });

    test('lock age 0 is still maintenance (present, just written)', () => {
        expect(buildEntry({ maintenanceLockAgeSec: 0, now: NOW }).status).toBe('maintenance');
    });
});
