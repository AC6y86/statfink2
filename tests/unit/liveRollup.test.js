/**
 * server/utils/liveRollup.js - the one roll-up shared by the server's live
 * health check and the watchdog script. Pins the status precedence: the
 * server's own verdicts outrank the public self-probe, and a failed
 * self-probe alone is public_path_unreachable (never the old site_down).
 */

const { rollUpLive, STATUS_PUBLIC_PATH, LEGACY_STATUS_PUBLIC_PATH } = require('../../server/utils/liveRollup');
const netDiag = require('../../scripts/lib/netDiag');

const ctx = { live: true, expectedGames: 9, inProgress: 7, loopAgeSec: 12 };
const ok = name => ({ name, ok: true, detail: `${name} fine` });
const bad = (name, severity = 'critical') => ({ name, ok: false, severity, detail: `${name} failing` });

describe('rollUpLive status precedence', () => {
    test('nothing failing -> ok when live, idle otherwise', () => {
        expect(rollUpLive([ok('loop_heartbeat'), ok('public_site')], ctx)).toMatchObject({ status: 'ok', severity: 'ok' });
        expect(rollUpLive([ok('loop_heartbeat')], { ...ctx, live: false, expectedGames: 0, inProgress: 0 })).toMatchObject({ status: 'idle', severity: 'ok' });
    });

    test('server_reachable outranks everything', () => {
        const r = rollUpLive([bad('server_reachable'), bad('week_match'), bad('loop_heartbeat'), bad('public_site')], ctx);
        expect(r.status).toBe('server_down');
        expect(r.severity).toBe('critical');
    });

    test('a failed public self-probe never masks week_match (misconfigured)', () => {
        const r = rollUpLive([ok('loop_heartbeat'), bad('week_match'), bad('public_site'), bad('dns_system', 'warning')], ctx);
        expect(r.status).toBe('misconfigured');
        expect(r.severity).toBe('critical');
    });

    test('a failed public self-probe never masks loop_heartbeat / game_freshness (stalled)', () => {
        expect(rollUpLive([bad('loop_heartbeat'), bad('public_site')], ctx).status).toBe('stalled');
        expect(rollUpLive([bad('game_freshness'), bad('public_site', 'warning')], ctx).status).toBe('stalled');
    });

    test('a failed public self-probe alone is public_path_unreachable, never site_down; severity follows the signal', () => {
        const critical = rollUpLive([ok('loop_heartbeat'), bad('public_site'), ok('dns_system')], ctx);
        expect(critical).toMatchObject({ status: 'public_path_unreachable', severity: 'critical' });
        const dns = rollUpLive([ok('loop_heartbeat'), bad('public_site', 'warning'), bad('dns_system', 'warning'), bad('dns_gateway', 'warning')], ctx);
        expect(dns).toMatchObject({ status: 'public_path_unreachable', severity: 'warning' });
        expect(JSON.stringify([critical, dns])).not.toContain('site_down');
    });

    test('the self-probe outranks warning-only server signals (degraded)', () => {
        const r = rollUpLive([bad('stats_flow', 'warning'), bad('public_site', 'warning')], ctx);
        expect(r.status).toBe('public_path_unreachable');
        expect(r.severity).toBe('warning');
    });

    test('other failures alone are degraded; summary joins the failing details in signal order', () => {
        const r = rollUpLive([ok('loop_heartbeat'), bad('tls_cert', 'warning'), bad('dns_gateway', 'warning')], ctx);
        expect(r).toMatchObject({ status: 'degraded', severity: 'warning', summary: 'tls_cert failing; dns_gateway failing' });
    });

    test('the status name is shared with scripts/lib/netDiag.js and the legacy name is exported for old lines', () => {
        expect(STATUS_PUBLIC_PATH).toBe('public_path_unreachable');
        expect(netDiag.STATUS_PUBLIC_PATH).toBe(STATUS_PUBLIC_PATH);
        expect(LEGACY_STATUS_PUBLIC_PATH).toBe('site_down');
    });
});
