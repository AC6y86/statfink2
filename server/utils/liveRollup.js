/**
 * Shared roll-up for the live-scoring watchdog line: signals -> one
 * { status, severity, summary }.
 *
 * Used by HealthCheckService.checkLiveScoring (the server's eight signals)
 * and by scripts/live-watchdog.js after it appends its own script-side
 * signals (public site probe, TLS, ESPN score comparison, and the
 * server_reachable signal it writes when the server does not answer). One
 * function so the notifier's hysteresis and the status table in WATCHDOG.md
 * stay true no matter who produced the signals.
 *
 * Priority chain (first failing name wins the status):
 *   server_reachable -> server_down    (the script's own signal; the site is
 *                                        down as a consequence, fix the server)
 *   week_match       -> misconfigured
 *   loop_heartbeat | game_freshness -> stalled
 *   public_site      -> public_path_unreachable
 *                                       (server answers on localhost but the
 *                                        watchdog's SELF-probe of the public
 *                                        hostname, run on the VM, failed: a
 *                                        VM DNS / nginx / certificate problem,
 *                                        not proof of an external outage; the
 *                                        signal's severity says which - see
 *                                        scripts/lib/netDiag.js)
 *   anything else failing -> degraded
 *   nothing failing -> ok (live) | idle
 *
 * The server's own verdicts (misconfigured, stalled) outrank the public
 * self-probe on purpose: local evidence that scoring is broken is stronger
 * than a probe that fails whenever the VM's resolver does, and must never be
 * hidden behind it. Lines written before this change carry `site_down` for
 * the same situation; readers should treat the two names alike.
 */

const SEVERITY_RANK = { ok: 0, info: 0, warning: 1, critical: 2 };
const SUMMARY_MAX = 400;
/** Status for a failed public self-probe. Older log lines say `site_down`. */
const STATUS_PUBLIC_PATH = 'public_path_unreachable';
const LEGACY_STATUS_PUBLIC_PATH = 'site_down';

/**
 * @param {Array<{name, ok, severity?, detail?}>} signals
 * @param {{ live: boolean, expectedGames: number, inProgress: number, loopAgeSec: number|null }} ctx
 * @returns {{ status: string, severity: string, summary: string }}
 */
function rollUpLive(signals, { live, expectedGames, inProgress, loopAgeSec }) {
    const failing = (signals || []).filter(s => !s.ok);
    const has = name => failing.some(s => s.name === name);
    let status;
    if (has('server_reachable')) status = 'server_down';
    else if (has('week_match')) status = 'misconfigured';
    else if (has('loop_heartbeat') || has('game_freshness')) status = 'stalled';
    else if (has('public_site')) status = STATUS_PUBLIC_PATH;
    else if (failing.length) status = 'degraded';
    else status = live ? 'ok' : 'idle';
    const severity = failing.reduce(
        (worst, s) => (SEVERITY_RANK[s.severity] > SEVERITY_RANK[worst] ? s.severity : worst), 'ok');

    let summary;
    if (!failing.length) {
        summary = live
            ? `${expectedGames} game(s) in window (${inProgress} in progress), loop ticked ${loopAgeSec}s ago, stats flowing`
            : `No games in the live window; loop ticked ${loopAgeSec === null ? 'never' : `${loopAgeSec}s ago`}`;
    } else {
        summary = failing.map(s => s.detail).join('; ');
    }
    summary = clampSummary(summary);

    return { status, severity, summary };
}

function clampSummary(summary) {
    const s = String(summary);
    return s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX - 3)}...` : s;
}

module.exports = { SEVERITY_RANK, SUMMARY_MAX, STATUS_PUBLIC_PATH, LEGACY_STATUS_PUBLIC_PATH, rollUpLive, clampSummary };
