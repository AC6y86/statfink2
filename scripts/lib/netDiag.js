'use strict';

/**
 * Network-path diagnostics for the live watchdog (scripts/live-watchdog.js).
 *
 * The watchdog's public-site probes (scripts/lib/siteSanity.js) run ON the
 * statfink VM against the VM's OWN public hostname. When they fail, that is
 * evidence about the VM's network path - its resolver (systemd-resolved ->
 * the UniFi gateway), its route out, nginx - not an independent, external
 * proof that league owners cannot reach the site. During the 2026-10
 * incident the app and LAN were healthy, the gateway DNS stopped answering,
 * the self-probe timed out and the watchdog reported `site_down`.
 *
 * probeNetworkPath gathers five small, time-bounded signals every tick so a
 * line can say WHICH layer failed:
 *
 *   dns_system   the VM's own resolver (getaddrinfo, what fetch/axios/Tank01 use)
 *   dns_gateway  a direct query to the LAN gateway (192.168.1.1)
 *   dns_public   direct queries to independent public resolvers (1.1.1.1, 9.9.9.9)
 *   tcp_public   TCP connect to the public address on the site's port
 *   tls_public   TLS handshake on that connection with SNI = the public hostname
 *
 * explainPublicProbe / annotatePublicProbe then read a failed `public_site`
 * next to those signals and say which layer broke, and whether the failure
 * is explained by the VM's own DNS (a warning: nothing is proven about the
 * outside) or sits past name resolution (TCP / TLS / HTTP: still critical,
 * but worded as a self-probe to confirm from outside).
 *
 * Every I/O is injectable (resolveImpl, lookupImpl, connectImpl) so the unit
 * tests never touch the network. Signals are { name, ok, severity?, detail }
 * like every other watchdog signal. Details carry hostnames, addresses,
 * latencies and error codes only - never headers, tokens or bodies.
 *
 * Environment overrides (all optional):
 *   WATCHDOG_GATEWAY_DNS        gateway resolver address (default 192.168.1.1; empty/off disables)
 *   WATCHDOG_PUBLIC_DNS         comma-separated public resolvers (default 1.1.1.1,9.9.9.9)
 *   WATCHDOG_PUBLIC_IP          address for the TCP/TLS probe (default: first DNS answer)
 *   WATCHDOG_DNS_TIMEOUT_MS     per-resolver query budget (default 2000)
 *   WATCHDOG_CONNECT_TIMEOUT_MS TCP connect and TLS handshake budget, each (default 5000)
 *   PUBLIC_SITE_URL             hostname and port under test (shared with siteSanity)
 */

const dns = require('dns');
const net = require('net');
const tls = require('tls');
const { URL } = require('url');
const { STATUS_PUBLIC_PATH } = require('../../server/utils/liveRollup');

const DEFAULT_GATEWAY_DNS = '192.168.1.1';
const DEFAULT_PUBLIC_DNS = ['1.1.1.1', '9.9.9.9'];
const DEFAULT_DNS_TIMEOUT_MS = 2000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_BASE_URL = 'https://peninsulafootball.com';

const SIGNAL_NAMES = ['dns_system', 'dns_gateway', 'dns_public', 'tcp_public', 'tls_public'];

// ---------- configuration ----------

function parseList(value, fallback) {
    if (value === undefined || value === null) return fallback.slice();
    const items = String(value).split(',').map(s => s.trim()).filter(Boolean);
    return items.filter(s => !/^(off|none|false)$/i.test(s));
}

function parseMs(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Resolve the probe configuration from the environment (pure; env injectable). */
function configFromEnv(env = process.env, { baseUrl } = {}) {
    const base = baseUrl || env.PUBLIC_SITE_URL || DEFAULT_BASE_URL;
    let hostname = null;
    let port = 443;
    let secure = true;
    try {
        const u = new URL(base);
        hostname = u.hostname;
        secure = u.protocol === 'https:';
        port = u.port ? Number(u.port) : (secure ? 443 : 80);
    } catch (_) { /* reported by the probe as a config problem */ }
    const gateway = parseList(env.WATCHDOG_GATEWAY_DNS, [DEFAULT_GATEWAY_DNS]);
    return {
        hostname,
        port,
        secure,
        gatewayDns: gateway[0] || null,
        publicDns: parseList(env.WATCHDOG_PUBLIC_DNS, DEFAULT_PUBLIC_DNS),
        publicIp: env.WATCHDOG_PUBLIC_IP ? String(env.WATCHDOG_PUBLIC_IP).trim() : null,
        dnsTimeoutMs: parseMs(env.WATCHDOG_DNS_TIMEOUT_MS, DEFAULT_DNS_TIMEOUT_MS),
        connectTimeoutMs: parseMs(env.WATCHDOG_CONNECT_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS)
    };
}

// ---------- helpers ----------

/** Short, secret-free error text: the libuv/c-ares code when there is one. */
function errText(e) {
    if (!e) return 'unknown error';
    if (e.code) return String(e.code);
    return String(e.message || e).split('\n')[0].slice(0, 120);
}

function withDeadline(promise, timeoutMs, onTimeout) {
    let timer;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
            if (onTimeout) { try { onTimeout(); } catch (_) { /* best effort */ } }
            const e = new Error(`timeout after ${timeoutMs} ms`);
            e.code = `timeout after ${timeoutMs} ms`;
            reject(e);
        }, timeoutMs);
        if (timer.unref) timer.unref();
    });
    return Promise.race([Promise.resolve().then(() => promise), deadline]).finally(() => clearTimeout(timer));
}

// ---------- default I/O implementations ----------

/** A-record query sent straight to one resolver, bypassing the system resolver. */
function defaultResolveImpl(server, hostname, timeoutMs) {
    const resolver = new dns.promises.Resolver({ timeout: timeoutMs, tries: 1 });
    resolver.setServers([server]);
    // c-ares has its own timeout but may stretch it; the outer deadline is the
    // hard budget and cancels the query so the handle never outlives the tick.
    return withDeadline(resolver.resolve4(hostname), timeoutMs, () => resolver.cancel());
}

/** The VM's own resolver path (getaddrinfo) - what fetch, axios and Tank01 use. */
function defaultLookupImpl(hostname, timeoutMs) {
    // getaddrinfo cannot be cancelled; the deadline only bounds our wait.
    return withDeadline(dns.promises.lookup(hostname, { all: true }).then(rs => rs.map(r => r.address)), timeoutMs);
}

/**
 * One socket: TCP connect, then (when secure) a TLS handshake with SNI.
 * Resolves (never rejects) to { tcp: {ok, ms, error?}, tls: {ok, ms, error?, protocol?, cn?} | null }.
 */
function defaultConnectImpl({ host, port, servername, secure = true, timeoutMs }) {
    return new Promise(resolve => {
        const result = { tcp: null, tls: null };
        let settled = false;
        let socket = null;
        let secureSocket = null;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(guard);
            if (secureSocket) secureSocket.destroy();
            if (socket) socket.destroy();
            resolve(result);
        };
        // Hard stop whatever happens (both stages may each take timeoutMs).
        const guard = setTimeout(() => {
            if (!result.tcp) result.tcp = { ok: false, ms: timeoutMs, error: `timeout after ${timeoutMs} ms` };
            else if (secure && !result.tls) result.tls = { ok: false, ms: timeoutMs, error: `timeout after ${timeoutMs} ms` };
            finish();
        }, timeoutMs * 2 + 250);
        if (guard.unref) guard.unref();

        const t0 = Date.now();
        socket = net.connect({ host, port });
        socket.setTimeout(timeoutMs);
        socket.once('timeout', () => {
            if (!result.tcp) result.tcp = { ok: false, ms: Date.now() - t0, error: `timeout after ${timeoutMs} ms` };
            else if (secure && !result.tls) result.tls = { ok: false, ms: Date.now() - t0, error: `timeout after ${timeoutMs} ms` };
            finish();
        });
        socket.once('error', e => {
            if (!result.tcp) result.tcp = { ok: false, ms: Date.now() - t0, error: errText(e) };
            else if (secure && !result.tls) result.tls = { ok: false, ms: Date.now() - t0, error: errText(e) };
            finish();
        });
        socket.once('connect', () => {
            result.tcp = { ok: true, ms: Date.now() - t0 };
            if (!secure) return finish();
            const t1 = Date.now();
            secureSocket = tls.connect({ socket, servername, rejectUnauthorized: true });
            secureSocket.setTimeout(timeoutMs);
            secureSocket.once('timeout', () => {
                if (!result.tls) result.tls = { ok: false, ms: Date.now() - t1, error: `timeout after ${timeoutMs} ms` };
                finish();
            });
            secureSocket.once('error', e => {
                if (!result.tls) result.tls = { ok: false, ms: Date.now() - t1, error: errText(e) };
                finish();
            });
            secureSocket.once('secureConnect', () => {
                const cert = secureSocket.getPeerCertificate ? secureSocket.getPeerCertificate() : null;
                result.tls = {
                    ok: true,
                    ms: Date.now() - t1,
                    protocol: secureSocket.getProtocol ? secureSocket.getProtocol() : null,
                    cn: cert && cert.subject && cert.subject.CN ? cert.subject.CN : null
                };
                finish();
            });
        });
    });
}

// ---------- probes ----------

async function timed(fn) {
    const started = Date.now();
    try {
        const value = await fn();
        return { ok: true, ms: Date.now() - started, value };
    } catch (e) {
        return { ok: false, ms: Date.now() - started, error: errText(e) };
    }
}

const firstAddress = r => (r && r.ok && Array.isArray(r.value) && r.value.length ? r.value[0] : null);

/**
 * Run the five probes concurrently. Never throws: a probe that blows up is
 * reported as a failing warning signal. Returns the signals in SIGNAL_NAMES order.
 */
async function probeNetworkPath({
    baseUrl,
    env = process.env,
    resolveImpl = defaultResolveImpl,
    lookupImpl = defaultLookupImpl,
    connectImpl = defaultConnectImpl
} = {}) {
    const cfg = configFromEnv(env, { baseUrl });
    const { hostname, port, secure } = cfg;
    if (!hostname) {
        const detail = `not attempted: cannot parse PUBLIC_SITE_URL (${baseUrl || env.PUBLIC_SITE_URL || ''})`;
        return SIGNAL_NAMES.map(name => ({ name, ok: false, severity: 'warning', detail }));
    }

    const [system, gateway, publics] = await Promise.all([
        timed(() => lookupImpl(hostname, cfg.dnsTimeoutMs)),
        cfg.gatewayDns ? timed(() => resolveImpl(cfg.gatewayDns, hostname, cfg.dnsTimeoutMs)) : Promise.resolve(null),
        Promise.all(cfg.publicDns.map(server => timed(() => resolveImpl(server, hostname, cfg.dnsTimeoutMs)).then(r => ({ server, ...r }))))
    ]);

    const signals = [];

    signals.push(system.ok
        ? { name: 'dns_system', ok: true, detail: `${hostname} → ${(system.value || []).join(', ') || 'no address'} in ${system.ms} ms (system resolver)` }
        : { name: 'dns_system', ok: false, severity: 'warning', detail: `system resolver cannot resolve ${hostname}: ${system.error} (${system.ms} ms)` });

    if (!gateway) {
        signals.push({ name: 'dns_gateway', ok: true, detail: 'disabled (WATCHDOG_GATEWAY_DNS empty)' });
    } else if (gateway.ok) {
        signals.push({ name: 'dns_gateway', ok: true, detail: `${cfg.gatewayDns} answered for ${hostname} in ${gateway.ms} ms (${(gateway.value || []).join(', ') || 'no address'})` });
    } else {
        signals.push({ name: 'dns_gateway', ok: false, severity: 'warning', detail: `gateway DNS ${cfg.gatewayDns} did not answer for ${hostname}: ${gateway.error} (${gateway.ms} ms)` });
    }

    const publicParts = publics.map(r => (r.ok ? `${r.server} ok ${r.ms} ms` : `${r.server} ${r.error} (${r.ms} ms)`));
    const publicAnswered = publics.find(r => r.ok);
    if (!publics.length) {
        signals.push({ name: 'dns_public', ok: true, detail: 'disabled (WATCHDOG_PUBLIC_DNS empty)' });
    } else if (publicAnswered) {
        signals.push({ name: 'dns_public', ok: true, detail: `${publicParts.join('; ')} (${(publicAnswered.value || []).join(', ') || 'no address'})` });
    } else {
        signals.push({ name: 'dns_public', ok: false, severity: 'warning', detail: `no public resolver answered for ${hostname}: ${publicParts.join('; ')}` });
    }

    // TCP/TLS target: the override, else the first answer from the most independent source.
    const target = cfg.publicIp || firstAddress(publicAnswered) || firstAddress(gateway) || firstAddress(system);
    if (!target) {
        signals.push({ name: 'tcp_public', ok: false, severity: 'warning', detail: `not attempted: no address for ${hostname} from any resolver (set WATCHDOG_PUBLIC_IP to probe anyway)` });
        signals.push({ name: 'tls_public', ok: true, detail: 'not attempted (no address)' });
        return signals;
    }

    let conn;
    try {
        conn = await connectImpl({ host: target, port, servername: hostname, secure, timeoutMs: cfg.connectTimeoutMs });
    } catch (e) {
        conn = { tcp: { ok: false, ms: 0, error: `probe threw: ${errText(e)}` }, tls: null };
    }
    const tcp = conn && conn.tcp ? conn.tcp : { ok: false, ms: 0, error: 'no result' };
    const where = `${target}:${port}`;
    if (tcp.ok) {
        signals.push({ name: 'tcp_public', ok: true, detail: `connected to ${where} in ${tcp.ms} ms` });
    } else {
        signals.push({ name: 'tcp_public', ok: false, severity: 'warning', detail: `connect to ${where} failed: ${tcp.error} (${tcp.ms} ms)` });
    }

    if (!secure) {
        signals.push({ name: 'tls_public', ok: true, detail: 'not https' });
    } else if (!tcp.ok) {
        signals.push({ name: 'tls_public', ok: true, detail: 'not attempted (tcp_public failed)' });
    } else {
        const t = conn.tls || { ok: false, ms: 0, error: 'no result' };
        signals.push(t.ok
            ? { name: 'tls_public', ok: true, detail: `handshake with ${where} (SNI ${hostname}) ok in ${t.ms} ms${t.protocol ? `, ${t.protocol}` : ''}${t.cn ? `, CN=${t.cn}` : ''}` }
            : { name: 'tls_public', ok: false, severity: 'warning', detail: `handshake with ${where} (SNI ${hostname}) failed: ${t.error} (${t.ms} ms)` });
    }
    return signals;
}

// ---------- classification of a failed public_site self-probe ----------

const byName = (signals, name) => (signals || []).find(s => s && s.name === name) || null;
const attempted = s => s && !/^not attempted/.test(String(s.detail || ''));
const state = s => (s === null ? 'not probed' : s.ok ? 'answering' : 'failing');

/**
 * Pure. Given one tick's signals, explain a failed `public_site`.
 * @returns {null | { layer: 'dns'|'tcp'|'tls'|'http'|'unknown', severity: 'warning'|'critical', note: string }}
 *   null when public_site is absent or ok.
 *   layer 'dns'  the VM's own resolver failed: warning, not proof of an outage.
 *   layer 'tcp'/'tls'/'http': the name resolves but the path past it fails from
 *   this VM: critical, worded as a self-probe to confirm from outside.
 */
function explainPublicProbe(signals) {
    const site = byName(signals, 'public_site');
    if (!site || site.ok) return null;
    const sys = byName(signals, 'dns_system');
    const gw = byName(signals, 'dns_gateway');
    const pub = byName(signals, 'dns_public');
    const tcp = byName(signals, 'tcp_public');
    const tlsSig = byName(signals, 'tls_public');
    const haveDiag = SIGNAL_NAMES.some(n => byName(signals, n));
    const selfProbe = 'self-probe from this VM, not an external check';

    if (!haveDiag) {
        return { layer: 'unknown', severity: 'critical', note: `${selfProbe} (no network diagnostics on this line) - confirm from outside` };
    }
    if (sys && !sys.ok) {
        const reach = tcp && tcp.ok ? `; TCP${tlsSig && tlsSig.ok && !/^not/.test(tlsSig.detail || '') ? '/TLS' : ''} to the public address fine` : '';
        return {
            layer: 'dns',
            severity: 'warning',
            note: `${selfProbe}: the VM's own resolver cannot resolve the public hostname (gateway DNS ${state(gw)}, public DNS ${state(pub)})${reach} - a VM DNS problem, not proof the site is down`
        };
    }
    if (tcp && !tcp.ok && attempted(tcp)) {
        return { layer: 'tcp', severity: 'critical', note: `${selfProbe}: the hostname resolves but TCP to the public address fails - confirm from outside` };
    }
    if (tlsSig && !tlsSig.ok && attempted(tlsSig)) {
        return { layer: 'tls', severity: 'critical', note: `${selfProbe}: TCP to the public address is fine but the TLS handshake fails - confirm from outside` };
    }
    return { layer: 'http', severity: 'critical', note: `${selfProbe}: DNS, TCP and TLS to the public address are fine, the HTTP layer is failing (nginx / upstream / page content) - confirm from outside` };
}

/**
 * Pure. Returns a copy of the signals where a failed `public_site` carries
 * the explanation in its detail and the severity explainPublicProbe decided
 * (so the roll-up no longer treats a VM-side DNS failure as a critical
 * outage). Everything else is returned untouched.
 */
function annotatePublicProbe(signals) {
    const why = explainPublicProbe(signals);
    if (!why) return { signals: (signals || []).slice(), explanation: null };
    const out = (signals || []).map(s => (s && s.name === 'public_site' && !s.ok
        ? { ...s, severity: why.severity, detail: `${s.detail} - ${why.note}` }
        : s));
    return { signals: out, explanation: why };
}

module.exports = {
    DEFAULT_GATEWAY_DNS,
    DEFAULT_PUBLIC_DNS,
    DEFAULT_DNS_TIMEOUT_MS,
    DEFAULT_CONNECT_TIMEOUT_MS,
    SIGNAL_NAMES,
    STATUS_PUBLIC_PATH,
    configFromEnv,
    errText,
    defaultResolveImpl,
    defaultLookupImpl,
    defaultConnectImpl,
    probeNetworkPath,
    explainPublicProbe,
    annotatePublicProbe
};
