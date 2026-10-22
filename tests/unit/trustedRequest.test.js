/**
 * server/auth/trust.js - password-free access is decided by the socket a
 * request arrived on, never by header-derived addresses.
 */

const { trustedVia, isLoopback } = require('../../server/auth/trust');

function req({ remoteAddress = '203.0.113.9', headers = {}, trustedListener } = {}) {
    return { socket: { remoteAddress }, headers, trustedListener };
}

describe('trustedVia', () => {
    const savedLogins = process.env.TAILSCALE_ADMIN_LOGINS;
    afterEach(() => {
        if (savedLogins === undefined) delete process.env.TAILSCALE_ADMIN_LOGINS;
        else process.env.TAILSCALE_ADMIN_LOGINS = savedLogins;
    });

    test('bare loopback call (cron script) is localhost', () => {
        for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
            expect(trustedVia(req({ remoteAddress: addr }))).toEqual({ via: 'localhost', login: null });
        }
    });

    test('loopback call carrying X-Forwarded-For (nginx) is NOT trusted', () => {
        expect(trustedVia(req({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '198.51.100.7' } })).via).toBeNull();
        expect(trustedVia(req({ remoteAddress: '127.0.0.1', headers: { 'x-real-ip': '198.51.100.7' } })).via).toBeNull();
    });

    test('public socket with a forged X-Forwarded-For: 127.0.0.1 is NOT trusted', () => {
        const r = req({ remoteAddress: '203.0.113.9', headers: { 'x-forwarded-for': '127.0.0.1' } });
        expect(trustedVia(r).via).toBeNull();
    });

    test('Tailscale listener over loopback is tailscale', () => {
        delete process.env.TAILSCALE_ADMIN_LOGINS;
        const r = req({ remoteAddress: '127.0.0.1', trustedListener: 'tailscale',
            headers: { 'x-forwarded-for': '100.101.102.103', 'tailscale-user-login': 'joe@example.com' } });
        expect(trustedVia(r)).toEqual({ via: 'tailscale', login: 'joe@example.com' });
    });

    test('Tailscale listener stamp on a non-loopback socket is NOT trusted', () => {
        const r = req({ remoteAddress: '100.101.102.103', trustedListener: 'tailscale' });
        expect(trustedVia(r).via).toBeNull();
    });

    test('TAILSCALE_ADMIN_LOGINS pins the tailnet identity (case-insensitive)', () => {
        process.env.TAILSCALE_ADMIN_LOGINS = 'Joe@Example.com, other@example.com';
        const ok = req({ remoteAddress: '127.0.0.1', trustedListener: 'tailscale', headers: { 'tailscale-user-login': 'joe@example.com' } });
        const wrong = req({ remoteAddress: '127.0.0.1', trustedListener: 'tailscale', headers: { 'tailscale-user-login': 'stranger@example.com' } });
        const missing = req({ remoteAddress: '127.0.0.1', trustedListener: 'tailscale' });
        expect(trustedVia(ok).via).toBe('tailscale');
        expect(trustedVia(wrong).via).toBeNull();
        expect(trustedVia(missing).via).toBeNull();
    });

    test('localhost substring look-alikes are not loopback', () => {
        expect(isLoopback('127.0.0.10')).toBe(false);
        expect(isLoopback('1127.0.0.1')).toBe(false);
        expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
        expect(trustedVia(req({ remoteAddress: '127.0.0.10' })).via).toBeNull();
    });
});
