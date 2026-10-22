/**
 * server/services/jobStatusService.js evaluate() with a watchdog line in the
 * public_path_unreachable state: the admin status must carry the status and
 * the failing layer through, keep a VM-DNS self-probe at warning, and keep
 * the overall colour critical only when the line itself is critical.
 */

const { evaluate } = require('../../server/services/jobStatusService');

const NOW = Date.parse('2026-10-18T18:07:02.037Z');

function inputs(live) {
    return {
        statuses: {}, live, notifier: null, emailPollerMtime: null, maintenanceLockAgeSec: null,
        doublecheck: null, questions: [], resolutions: [], rulings: {}, recaps: null, weeklyValidation: null,
        liveReview: null, diagnosis: null, logErrors: null, pm2: null,
        settings: { season: 2026, week: 7 }, offseason: false, advanceDeadline: null,
        alerts: { unacknowledged: 0, critical: 0, items: [] }
    };
}

const line = (status, severity, extra = {}) => ({
    ts: new Date(NOW - 60000).toISOString(), status, severity, summary: `${status} summary`,
    season: 2026, week: 7, expectedGames: 9, gamesInProgress: 7, loopAgeSec: 12, signals: [], ...extra
});

describe('admin status with a public_path_unreachable watchdog line', () => {
    test('VM DNS self-probe failure (warning) -> watchdog job warning, layer in details, overall not critical', () => {
        const out = evaluate(inputs(line('public_path_unreachable', 'warning', { publicPathLayer: 'dns' })), NOW);
        const job = out.jobs.find(j => j.job === 'watchdog');
        expect(job.status).toBe('warning');
        expect(job.details).toMatchObject({ liveStatus: 'public_path_unreachable', publicPathLayer: 'dns' });
        expect(out.overall).not.toBe('critical');
        expect(out.live.latest.publicPathLayer).toBe('dns');
    });

    test('post-DNS self-probe failure (critical) -> watchdog job critical, overall critical, layer carried', () => {
        const out = evaluate(inputs(line('public_path_unreachable', 'critical', { publicPathLayer: 'http' })), NOW);
        const job = out.jobs.find(j => j.job === 'watchdog');
        expect(job.status).toBe('critical');
        expect(job.details.publicPathLayer).toBe('http');
        expect(out.overall).toBe('critical');
    });

    test('an old site_down line (no layer) is still read: status passed through, no publicPathLayer key', () => {
        const out = evaluate(inputs(line('site_down', 'critical')), NOW);
        const job = out.jobs.find(j => j.job === 'watchdog');
        expect(job.status).toBe('critical');
        expect(job.details.liveStatus).toBe('site_down');
        expect(job.details).not.toHaveProperty('publicPathLayer');
    });
});
