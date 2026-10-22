/** Plain-language projection of existing verification evidence; never acknowledges anything. */
export function warningSummary(s, moves = null) {
    const jobs = s.jobs || [], questions = s.questions || [], alerts = s.alerts?.items || [];
    const rows = [], handledJobs = new Set();
    const add = (label, kind, title, detail, href) => rows.push({ label, kind, title, detail, href });
    const bad = value => ['warning', 'critical', 'failed', 'error'].includes(value);
    const liveJob = jobs.find(j => j.job === 'watchdog');
    const live = s.live?.latest;
    const age = live ? Date.parse(s.generatedAt) - Date.parse(live.ts) : NaN;
    const fresh = Number.isFinite(age) && age >= 0 && age < 15 * 60000;
    const healthyLive = !!(fresh && live.severity === 'ok' && !bad(liveJob?.effective));
    const open = questions.filter(q => q.needsRuling);
    if (open.length) add('Action needed', 'warning', `${open.length} scoring question${open.length === 1 ? '' : 's'} need a ruling`,
        'The evidence is not yet resolved. Review the plays before changing any scores.', '#rulings');

    const reviewJob = jobs.find(j => j.job === 'live-review');
    const sm = s.liveReview?.summary || {};
    if (bad(reviewJob?.effective) || sm.underReview || sm.suspected) {
        const flagged = (s.liveReview?.flaggedReviews || s.liveReview?.reviews || []).filter(r => ['under review', 'miscredit suspected'].includes(r.status));
        const ruled = flagged.filter(r => questions.some(q => q.ruling && q.gameId === r.gameId &&
            Number(q.season) === Number(r.season) && Number(q.week) === Number(r.week) &&
            q.evidence?.period === r.period && q.evidence?.clock === r.clock && q.evidence?.scoringTeam === r.scoringTeam));
        const total = (sm.underReview || 0) + (sm.suspected || 0);
        if (total > 0 && ruled.length === total) {
            add('Resolved', 'ok', 'Automated play-review warning has a saved ruling',
                `${ruled.map(r => r.text).join(' · ')} — the ruling is saved; the automated reviewer still carries its earlier warning. No further ruling is needed.`, '#rulings');
        } else add('Review needed', 'warning', 'Live play verification', reviewJob?.summary || sm.summary || 'A play is still under review.', '#live-review');
        if (sm.qwenUnreachable) add('Incomplete check', 'warning', 'Qwen could not complete a verification',
            `${sm.qwenUnreachable} play check${sm.qwenUnreachable === 1 ? ' lacks' : 's lack'} a Qwen response in the latest report. This is a verification gap, not proof of a scoring error.`, '#live-review');
        handledJobs.add('live-review');
    }

    const fingerprints = s.logErrors?.fingerprints || [];
    const flaggedLogs = fingerprints.filter(f => f.new || f.spiking);
    if (flaggedLogs.length) {
        const groups = new Map();
        for (const f of flaggedLogs) {
            const key = `${f.job}|${Math.floor(Date.parse(f.lastSeen) / 1000)}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(f);
        }
        for (const group of groups.values()) {
            const sample = group.map(f => f.sample || '').join('\n');
            const game = sample.match(/\d{8}_([A-Z]{2,3})@([A-Z]{2,3})/);
            const timeout = /Tank01/i.test(sample) && /timeout|network error/i.test(sample);
            const title = timeout ? `Data-feed timeout${game ? ` — ${game[1]} @ ${game[2]}` : ''}` :
                (group[0].sample || group[0].fingerprint || 'Unacknowledged log warning').split('\n')[0].replace(/^.*?\b(?:ERROR|WARN):\s*/i, '');
            const repeated = group.some(f => f.spiking);
            add(repeated ? 'Repeating' : 'Unacknowledged', repeated ? 'critical' : 'warning', title,
                `${group.length} log pattern${group.length === 1 ? '' : 's'} last recorded together. ${repeated ? 'The error rate has increased.' : 'These remain listed until reviewed or acknowledged.'}${healthyLive ? ' The latest live-scoring check is healthy.' : ''}`,
                '#log-errors');
            rows[rows.length - 1].timestamp = group[0].lastSeen;
        }
        handledJobs.add('log-sentinel');
    }
    const older = fingerprints.filter(f => !f.known && !f.new && !f.spiking).length;
    if (older) add('Older notices', 'info', `${older} older log patterns are still unacknowledged`,
        'These are previously recorded messages, not a count of current scoring errors.', '#log-errors');

    for (const alert of alerts.filter(a => !a.acknowledged && ['warning', 'critical'].includes(a.severity))) {
        const recovery = alert.source === 'live-watchdog' && healthyLive && alerts.find(a =>
            a.source === alert.source && /recovered/i.test(a.message) && Date.parse(a.timestamp) > Date.parse(alert.timestamp));
        const related = moves?.items?.filter(i => i.parse?.summary && alert.message.includes(i.parse.summary)) || [];
        const completed = alert.source === 'email-moves' && related.length && related.every(i => ['approved', 'rejected'].includes(i.status));
        if (recovery) add('Recovered', 'ok', 'Earlier live-scoring delay',
            `${recovery.message}. The original warning has not been acknowledged.`, '#alerts');
        else if (completed) {
            const owner = (related[0].email?.from || 'Roster request').replace(/\s*<[^>]*>/g, '');
            add('Resolved', 'ok', `${owner}: roster-move notice`,
                `The linked proposals are ${related.every(i => i.status === 'approved') ? 'approved' : 'resolved'}. The original “needs review” notice is still unacknowledged.`, '#alerts');
        } else add('Unacknowledged', alert.severity, alert.source === 'email-moves' ? 'Roster-move notice' : 'Recorded warning', alert.message, '#alerts');
    }
    for (const j of jobs.filter(j => bad(j.effective) && !handledJobs.has(j.job))) {
        add(j.reason === 'stale' ? 'Overdue' : 'Check needed', j.effective, j.title, j.summary || j.reason || 'Check details below.', j.link || '#jobs');
    }
    const headline = healthyLive ? `Live scoring is healthy. ${open.length ? `${open.length} ruling${open.length === 1 ? '' : 's'} needed.` : 'No scoring questions need a ruling.'}` :
        `${open.length ? `${open.length} scoring question${open.length === 1 ? '' : 's'} need a ruling.` : 'No scoring questions currently need a ruling.'} Check the live-scoring status below.`;
    return { headline, rows };
}
