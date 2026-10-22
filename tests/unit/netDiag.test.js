/**
 * scripts/lib/netDiag.js - the watchdog's network-path diagnostics with fake
 * resolvers / sockets, and the pure classification of a failed public_site
 * self-probe. Never touches the network.
 */

const nd = require('../../scripts/lib/netDiag');

const HOST = 'peninsulafootball.com';
const BASE = `https://${HOST}`;
const IP = '203.0.113.5';
const GW = '192.168.1.1';
const ENV = {};   // no overrides: defaults under test

const byName = (signals, name) => signals.find(s => s.name === name);

/** resolveImpl keyed by server; a value may be an address list or an Error. */
function fakeResolve(answers) {
    const calls = [];
    const impl = (server, hostname) => {
        calls.push({ server, hostname });
        const a = answers[server];
        if (a === undefined) return Promise.reject(Object.assign(new Error('no route'), { code: 'ECONNREFUSED' }));
        if (a instanceof Error) return Promise.reject(a);
        return Promise.resolve(a);
    };
    impl.calls = calls;
    return impl;
}

const lookupOk = async () => [IP];
const lookupEaiAgain = async () => { throw Object.assign(new Error('getaddrinfo EAI_AGAIN peninsulafootball.com'), { code: 'EAI_AGAIN' }); };

const connectOk = async () => ({ tcp: { ok: true, ms: 4 }, tls: { ok: true, ms: 21, protocol: 'TLSv1.3', cn: HOST } });
const connectRefused = async () => ({ tcp: { ok: false, ms: 1, error: 'ECONNREFUSED' }, tls: null });
const connectTlsFails = async () => ({ tcp: { ok: true, ms: 4 }, tls: { ok: false, ms: 30, error: 'CERT_HAS_EXPIRED' } });

const timeout = () => Object.assign(new Error('timeout after 2000 ms'), { code: 'timeout after 2000 ms' });

describe('configFromEnv', () => {
    test('defaults: gateway 192.168.1.1, public 1.1.1.1 + 9.9.9.9, host/port from PUBLIC_SITE_URL', () => {
        const c = nd.configFromEnv({}, { baseUrl: BASE });
        expect(c).toMatchObject({ hostname: HOST, port: 443, secure: true, gatewayDns: GW, publicDns: ['1.1.1.1', '9.9.9.9'], publicIp: null, dnsTimeoutMs: 2000, connectTimeoutMs: 5000 });
    });

    test('environment overrides, including disabling the gateway probe and a bad timeout', () => {
        const c = nd.configFromEnv({
            PUBLIC_SITE_URL: 'http://statfink.local:8080',
            WATCHDOG_GATEWAY_DNS: 'off',
            WATCHDOG_PUBLIC_DNS: '8.8.8.8, 8.8.4.4',
            WATCHDOG_PUBLIC_IP: ' 198.51.100.7 ',
            WATCHDOG_DNS_TIMEOUT_MS: '500',
            WATCHDOG_CONNECT_TIMEOUT_MS: 'soon'
        });
        expect(c).toMatchObject({ hostname: 'statfink.local', port: 8080, secure: false, gatewayDns: null, publicDns: ['8.8.8.8', '8.8.4.4'], publicIp: '198.51.100.7', dnsTimeoutMs: 500, connectTimeoutMs: 5000 });
    });
});

describe('probeNetworkPath', () => {
    test('everything answers -> five ok signals with latency, addresses and the TLS details', async () => {
        const resolveImpl = fakeResolve({ [GW]: [IP], '1.1.1.1': [IP], '9.9.9.9': [IP] });
        const signals = await nd.probeNetworkPath({ baseUrl: BASE, env: ENV, resolveImpl, lookupImpl: lookupOk, connectImpl: connectOk });
        expect(signals.map(s => s.name)).toEqual(nd.SIGNAL_NAMES);
        expect(signals.every(s => s.ok)).toBe(true);
        expect(byName(signals, 'dns_system').detail).toMatch(new RegExp(`^${HOST} → ${IP} in \\d+ ms \\(system resolver\\)$`));
        expect(byName(signals, 'dns_gateway').detail).toMatch(new RegExp(`^${GW} answered for ${HOST} in \\d+ ms \\(${IP}\\)$`));
        expect(byName(signals, 'dns_public').detail).toMatch(/^1\.1\.1\.1 ok \d+ ms; 9\.9\.9\.9 ok \d+ ms \(203\.0\.113\.5\)$/);
        expect(byName(signals, 'tcp_public').detail).toBe(`connected to ${IP}:443 in 4 ms`);
        expect(byName(signals, 'tls_public').detail).toBe(`handshake with ${IP}:443 (SNI ${HOST}) ok in 21 ms, TLSv1.3, CN=${HOST}`);
        expect(resolveImpl.calls.map(c => c.server).sort()).toEqual(['1.1.1.1', '9.9.9.9', GW].sort());
        expect(resolveImpl.calls.every(c => c.hostname === HOST)).toBe(true);
    });

    test('gateway DNS times out while public DNS answers -> dns_gateway warning, the rest ok (the incident shape)', async () => {
        const resolveImpl = fakeResolve({ [GW]: timeout(), '1.1.1.1': [IP], '9.9.9.9': timeout() });
        const signals = await nd.probeNetworkPath({ baseUrl: BASE, env: ENV, resolveImpl, lookupImpl: lookupEaiAgain, connectImpl: connectOk });
        expect(byName(signals, 'dns_system')).toMatchObject({ ok: false, severity: 'warning' });
        expect(byName(signals, 'dns_system').detail).toMatch(/^system resolver cannot resolve peninsulafootball\.com: EAI_AGAIN \(\d+ ms\)$/);
        expect(byName(signals, 'dns_gateway')).toMatchObject({ ok: false, severity: 'warning' });
        expect(byName(signals, 'dns_gateway').detail).toMatch(/^gateway DNS 192\.168\.1\.1 did not answer for peninsulafootball\.com: timeout after 2000 ms \(\d+ ms\)$/);
        const pub = byName(signals, 'dns_public');
        expect(pub.ok).toBe(true);
        expect(pub.detail).toMatch(/^1\.1\.1\.1 ok \d+ ms; 9\.9\.9\.9 timeout after 2000 ms \(\d+ ms\) \(203\.0\.113\.5\)$/);
        // the TCP/TLS probe used the public resolver's answer, so the path past DNS is proven fine
        expect(byName(signals, 'tcp_public')).toMatchObject({ ok: true, detail: `connected to ${IP}:443 in 4 ms` });
        expect(byName(signals, 'tls_public').ok).toBe(true);
    });

    test('total DNS failure -> three dns warnings, tcp not attempted (warning), tls not attempted (ok)', async () => {
        const resolveImpl = fakeResolve({ [GW]: timeout(), '1.1.1.1': timeout(), '9.9.9.9': timeout() });
        const connectImpl = jest.fn(connectOk);
        const signals = await nd.probeNetworkPath({ baseUrl: BASE, env: ENV, resolveImpl, lookupImpl: lookupEaiAgain, connectImpl });
        expect(signals.map(s => s.name)).toEqual(nd.SIGNAL_NAMES);
        expect(byName(signals, 'dns_system').ok).toBe(false);
        expect(byName(signals, 'dns_gateway').ok).toBe(false);
        expect(byName(signals, 'dns_public')).toMatchObject({ ok: false, severity: 'warning' });
        expect(byName(signals, 'dns_public').detail).toMatch(/^no public resolver answered for peninsulafootball\.com: 1\.1\.1\.1 timeout after 2000 ms \(\d+ ms\); 9\.9\.9\.9 timeout/);
        expect(byName(signals, 'tcp_public')).toMatchObject({ ok: false, severity: 'warning', detail: `not attempted: no address for ${HOST} from any resolver (set WATCHDOG_PUBLIC_IP to probe anyway)` });
        expect(byName(signals, 'tls_public')).toEqual({ name: 'tls_public', ok: true, detail: 'not attempted (no address)' });
        expect(connectImpl).not.toHaveBeenCalled();
    });

    test('total DNS failure with WATCHDOG_PUBLIC_IP still probes TCP/TLS at that address', async () => {
        const resolveImpl = fakeResolve({});
        const connectImpl = jest.fn(connectOk);
        const signals = await nd.probeNetworkPath({ baseUrl: BASE, env: { WATCHDOG_PUBLIC_IP: '198.51.100.7' }, resolveImpl, lookupImpl: lookupEaiAgain, connectImpl });
        expect(connectImpl).toHaveBeenCalledWith({ host: '198.51.100.7', port: 443, servername: HOST, secure: true, timeoutMs: 5000 });
        expect(byName(signals, 'tcp_public').detail).toBe('connected to 198.51.100.7:443 in 4 ms');
    });

    test('DNS fine but TCP refused -> tcp_public warning, tls not attempted', async () => {
        const resolveImpl = fakeResolve({ [GW]: [IP], '1.1.1.1': [IP], '9.9.9.9': [IP] });
        const signals = await nd.probeNetworkPath({ baseUrl: BASE, env: ENV, resolveImpl, lookupImpl: lookupOk, connectImpl: connectRefused });
        expect(byName(signals, 'tcp_public')).toMatchObject({ ok: false, severity: 'warning', detail: `connect to ${IP}:443 failed: ECONNREFUSED (1 ms)` });
        expect(byName(signals, 'tls_public')).toEqual({ name: 'tls_public', ok: true, detail: 'not attempted (tcp_public failed)' });
    });

    test('TCP fine but the handshake fails -> tls_public warning with the OpenSSL code', async () => {
        const resolveImpl = fakeResolve({ [GW]: [IP], '1.1.1.1': [IP], '9.9.9.9': [IP] });
        const signals = await nd.probeNetworkPath({ baseUrl: BASE, env: ENV, resolveImpl, lookupImpl: lookupOk, connectImpl: connectTlsFails });
        expect(byName(signals, 'tcp_public').ok).toBe(true);
        expect(byName(signals, 'tls_public')).toMatchObject({ ok: false, severity: 'warning', detail: `handshake with ${IP}:443 (SNI ${HOST}) failed: CERT_HAS_EXPIRED (30 ms)` });
    });

    test('gateway probe disabled and a plain http site -> both reported as ok/not applicable', async () => {
        const resolveImpl = fakeResolve({ '1.1.1.1': [IP], '9.9.9.9': [IP] });
        const signals = await nd.probeNetworkPath({ baseUrl: 'http://statfink.local:8080', env: { WATCHDOG_GATEWAY_DNS: '' }, resolveImpl, lookupImpl: lookupOk, connectImpl: async () => ({ tcp: { ok: true, ms: 2 }, tls: null }) });
        expect(byName(signals, 'dns_gateway')).toEqual({ name: 'dns_gateway', ok: true, detail: 'disabled (WATCHDOG_GATEWAY_DNS empty)' });
        expect(resolveImpl.calls.map(c => c.server)).not.toContain(GW);
        expect(byName(signals, 'tcp_public').detail).toBe(`connected to ${IP}:8080 in 2 ms`);
        expect(byName(signals, 'tls_public')).toEqual({ name: 'tls_public', ok: true, detail: 'not https' });
    });

    test('a probe implementation that throws becomes a failing signal, never an exception', async () => {
        const resolveImpl = fakeResolve({ [GW]: [IP], '1.1.1.1': [IP], '9.9.9.9': [IP] });
        const signals = await nd.probeNetworkPath({ baseUrl: BASE, env: ENV, resolveImpl, lookupImpl: lookupOk, connectImpl: async () => { throw new Error('boom'); } });
        expect(byName(signals, 'tcp_public')).toMatchObject({ ok: false, severity: 'warning' });
        expect(byName(signals, 'tcp_public').detail).toContain('probe threw: boom');
    });

    test('an unparseable site URL is reported on every signal instead of thrown', async () => {
        const signals = await nd.probeNetworkPath({ baseUrl: 'not a url', env: ENV, resolveImpl: fakeResolve({}), lookupImpl: lookupOk, connectImpl: connectOk });
        expect(signals).toHaveLength(5);
        expect(signals.every(s => !s.ok && s.severity === 'warning' && /cannot parse PUBLIC_SITE_URL/.test(s.detail))).toBe(true);
    });

    test('the configured timeouts are handed to the implementations', async () => {
        const resolveImpl = jest.fn(async () => [IP]);
        const lookupImpl = jest.fn(async () => [IP]);
        const connectImpl = jest.fn(connectOk);
        await nd.probeNetworkPath({ baseUrl: BASE, env: { WATCHDOG_DNS_TIMEOUT_MS: '700', WATCHDOG_CONNECT_TIMEOUT_MS: '1500' }, resolveImpl, lookupImpl, connectImpl });
        expect(lookupImpl).toHaveBeenCalledWith(HOST, 700);
        expect(resolveImpl).toHaveBeenCalledWith(GW, HOST, 700);
        expect(connectImpl).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 1500 }));
    });

    test('details never carry the fetched page, headers or tokens: only names, addresses, timings, codes', async () => {
        const resolveImpl = fakeResolve({ [GW]: [IP], '1.1.1.1': [IP], '9.9.9.9': [IP] });
        const signals = await nd.probeNetworkPath({ baseUrl: BASE, env: { WATCHDOG_PUBLIC_IP: IP }, resolveImpl, lookupImpl: lookupOk, connectImpl: connectOk });
        for (const s of signals) {
            expect(Object.keys(s).sort()).toEqual(['detail', 'name', 'ok']);
            expect(s.detail.length).toBeLessThan(200);
        }
    });
});

describe('errText', () => {
    test('prefers the error code, falls back to the first line of the message, caps the length', () => {
        expect(nd.errText(Object.assign(new Error('getaddrinfo EAI_AGAIN x'), { code: 'EAI_AGAIN' }))).toBe('EAI_AGAIN');
        expect(nd.errText(new Error('first line\nsecond line'))).toBe('first line');
        expect(nd.errText(new Error('x'.repeat(300))).length).toBe(120);
        expect(nd.errText(null)).toBe('unknown error');
    });
});

// ---------- classification of a failed public_site self-probe ----------

const siteFailed = () => ({ name: 'public_site', ok: false, severity: 'critical', detail: `${BASE}/ unreachable: timeout after 8000 ms` });
const diag = ({ sys = true, gw = true, pub = true, tcp = true, tls = true, tcpAttempted = true } = {}) => [
    sys ? { name: 'dns_system', ok: true, detail: `${HOST} → ${IP} in 3 ms (system resolver)` } : { name: 'dns_system', ok: false, severity: 'warning', detail: `system resolver cannot resolve ${HOST}: EAI_AGAIN (2001 ms)` },
    gw ? { name: 'dns_gateway', ok: true, detail: `${GW} answered for ${HOST} in 4 ms (${IP})` } : { name: 'dns_gateway', ok: false, severity: 'warning', detail: `gateway DNS ${GW} did not answer for ${HOST}: timeout after 2000 ms (2003 ms)` },
    pub ? { name: 'dns_public', ok: true, detail: `1.1.1.1 ok 12 ms; 9.9.9.9 ok 15 ms (${IP})` } : { name: 'dns_public', ok: false, severity: 'warning', detail: `no public resolver answered for ${HOST}: 1.1.1.1 timeout after 2000 ms (2002 ms); 9.9.9.9 timeout after 2000 ms (2002 ms)` },
    tcp ? { name: 'tcp_public', ok: true, detail: `connected to ${IP}:443 in 4 ms` }
        : tcpAttempted ? { name: 'tcp_public', ok: false, severity: 'warning', detail: `connect to ${IP}:443 failed: ECONNREFUSED (1 ms)` }
            : { name: 'tcp_public', ok: false, severity: 'warning', detail: `not attempted: no address for ${HOST} from any resolver (set WATCHDOG_PUBLIC_IP to probe anyway)` },
    !tcp ? { name: 'tls_public', ok: true, detail: tcpAttempted ? 'not attempted (tcp_public failed)' : 'not attempted (no address)' }
        : tls ? { name: 'tls_public', ok: true, detail: `handshake with ${IP}:443 (SNI ${HOST}) ok in 21 ms, TLSv1.3, CN=${HOST}` }
            : { name: 'tls_public', ok: false, severity: 'warning', detail: `handshake with ${IP}:443 (SNI ${HOST}) failed: CERT_HAS_EXPIRED (30 ms)` }
];

describe('explainPublicProbe', () => {
    test('public_site ok or absent -> null', () => {
        expect(nd.explainPublicProbe([{ name: 'public_site', ok: true, detail: '200' }, ...diag()])).toBeNull();
        expect(nd.explainPublicProbe(diag())).toBeNull();
        expect(nd.explainPublicProbe([])).toBeNull();
    });

    test('the incident: VM resolver fails, gateway DNS dead, public DNS fine, TCP/TLS fine -> dns layer, warning', () => {
        const why = nd.explainPublicProbe([siteFailed(), ...diag({ sys: false, gw: false })]);
        expect(why.layer).toBe('dns');
        expect(why.severity).toBe('warning');
        expect(why.note).toBe("self-probe from this VM, not an external check: the VM's own resolver cannot resolve the public hostname (gateway DNS failing, public DNS answering); TCP/TLS to the public address fine - a VM DNS problem, not proof the site is down");
    });

    test('total DNS failure (nothing answers, tcp not attempted) -> dns layer, warning, states both resolvers failing', () => {
        const why = nd.explainPublicProbe([siteFailed(), ...diag({ sys: false, gw: false, pub: false, tcp: false, tcpAttempted: false })]);
        expect(why).toMatchObject({ layer: 'dns', severity: 'warning' });
        expect(why.note).toContain('gateway DNS failing, public DNS failing');
        expect(why.note).not.toContain('TCP');
    });

    test('name resolves, TCP refused -> tcp layer, critical, worded as a self-probe', () => {
        const why = nd.explainPublicProbe([siteFailed(), ...diag({ tcp: false })]);
        expect(why).toEqual({ layer: 'tcp', severity: 'critical', note: 'self-probe from this VM, not an external check: the hostname resolves but TCP to the public address fails - confirm from outside' });
    });

    test('TCP fine, handshake fails -> tls layer, critical', () => {
        const why = nd.explainPublicProbe([siteFailed(), ...diag({ tls: false })]);
        expect(why).toMatchObject({ layer: 'tls', severity: 'critical' });
        expect(why.note).toContain('TLS handshake fails');
    });

    test('DNS, TCP and TLS all fine but the page fails (502 / wrong week) -> http layer, critical', () => {
        const site = { name: 'public_site', ok: false, severity: 'critical', detail: `HTTP 502 from ${BASE}/ in 12 ms` };
        const why = nd.explainPublicProbe([site, ...diag()]);
        expect(why).toMatchObject({ layer: 'http', severity: 'critical' });
        expect(why.note).toContain('the HTTP layer is failing (nginx / upstream / page content)');
    });

    test('no diagnostics on the line at all -> unknown layer, stays critical, still says self-probe', () => {
        const why = nd.explainPublicProbe([siteFailed(), { name: 'tls_cert', ok: true, detail: 'expires in 61 days' }]);
        expect(why).toMatchObject({ layer: 'unknown', severity: 'critical' });
        expect(why.note).toContain('no network diagnostics on this line');
    });
});

describe('annotatePublicProbe', () => {
    test('a failed public_site gets the explanation appended and the decided severity; other signals untouched', () => {
        const input = [siteFailed(), { name: 'public_api_fresh', ok: true, detail: 'sync-status unavailable (site down)' }, ...diag({ sys: false, gw: false })];
        const { signals, explanation } = nd.annotatePublicProbe(input);
        expect(explanation.layer).toBe('dns');
        const site = byName(signals, 'public_site');
        expect(site.severity).toBe('warning');
        expect(site.detail.startsWith(`${BASE}/ unreachable: timeout after 8000 ms - self-probe from this VM`)).toBe(true);
        expect(signals.slice(1)).toEqual(input.slice(1));
        expect(input[0].severity).toBe('critical');   // input not mutated
    });

    test('a critical explanation keeps critical', () => {
        const { signals } = nd.annotatePublicProbe([siteFailed(), ...diag({ tcp: false })]);
        expect(byName(signals, 'public_site')).toMatchObject({ ok: false, severity: 'critical' });
    });

    test('nothing to explain -> same signals, null explanation', () => {
        const input = [{ name: 'public_site', ok: true, detail: '200' }, ...diag()];
        const out = nd.annotatePublicProbe(input);
        expect(out.signals).toEqual(input);
        expect(out.explanation).toBeNull();
        expect(nd.annotatePublicProbe(undefined)).toEqual({ signals: [], explanation: null });
    });
});
