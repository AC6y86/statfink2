/**
 * Who is allowed in without a password.
 *
 * Trust is decided by WHICH SOCKET a request arrived on, never by an address
 * parsed out of headers (X-Forwarded-For is client-controlled at its left end):
 *
 *   - 'tailscale'  the request came in on the loopback-only Tailscale listener
 *                  (server/app.js binds 127.0.0.1:TAILSCALE_PORT and stamps
 *                  req.trustedListener). Only `tailscale serve` - i.e. a
 *                  tailnet identity - or a local process can reach that port.
 *                  Optionally pinned to TAILSCALE_ADMIN_LOGINS (comma list of
 *                  tailnet logins, matched against the Tailscale-User-Login
 *                  header that serve adds).
 *   - 'localhost'  a bare local call (cron scripts hitting 127.0.0.1:8000).
 *                  nginx and tailscale serve also connect from loopback but
 *                  always add X-Forwarded-For / X-Real-IP; a direct local
 *                  call never does.
 *   - null         everything else: needs a session.
 */

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLoopback(addr) {
    return LOOPBACK.has(addr);
}

function allowedTailscaleLogins() {
    return (process.env.TAILSCALE_ADMIN_LOGINS || '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
}

/** @returns {{ via: 'tailscale'|'localhost'|null, login: string|null }} */
function trustedVia(req) {
    const peer = req.socket && req.socket.remoteAddress;
    const headers = req.headers || {};

    if (req.trustedListener === 'tailscale' && isLoopback(peer)) {
        const login = headers['tailscale-user-login'] ? String(headers['tailscale-user-login']) : null;
        const allowed = allowedTailscaleLogins();
        if (allowed.length && !(login && allowed.includes(login.toLowerCase()))) {
            return { via: null, login };
        }
        return { via: 'tailscale', login };
    }

    if (isLoopback(peer) && !headers['x-forwarded-for'] && !headers['x-real-ip']) {
        return { via: 'localhost', login: null };
    }

    return { via: null, login: null };
}

module.exports = { isLoopback, trustedVia };
