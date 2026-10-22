const fs = require('fs');
const os = require('os');
const path = require('path');

describe('jobStatus contract (logs/status/<job>.json)', () => {
    let dir, js;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobstatus-'));
        process.env.STATFINK_STATUS_DIR = dir;
        jest.isolateModules(() => { js = require('../../scripts/lib/jobStatus'); });
    });
    afterEach(() => { delete process.env.STATFINK_STATUS_DIR; fs.rmSync(dir, { recursive: true, force: true }); });

    test('writes the record atomically with the contract fields and appends history', () => {
        const rec = js.writeJobStatus('doublecheck', { status: 'ok', summary: 'PASS', season: 2026, week: 1, durationMs: 25, details: { a: 1 } });
        expect(rec.job).toBe('doublecheck');
        expect(rec.link).toBe('/admin/status#doublecheck');
        const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'doublecheck.json'), 'utf8'));
        expect(onDisk).toEqual(rec);
        expect(fs.readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);
        js.writeJobStatus('doublecheck', { status: 'warning', summary: 'WARN' });
        expect(js.readJobHistory('doublecheck').map(h => h.status)).toEqual(['ok', 'warning']);
        expect(js.readJobStatus('doublecheck').status).toBe('warning');
    });

    test('running status does not enter history; unknown status becomes warning; bad job name never throws', () => {
        js.writeJobStatus('daily', { status: 'running', summary: 'x' });
        expect(js.readJobHistory('daily')).toEqual([]);
        expect(js.writeJobStatus('daily', { status: 'bogus' }).status).toBe('warning');
        expect(js.writeJobStatus('Bad Name!', { status: 'ok' })).toBeNull();
    });

    test('readAllJobStatus lists every job file and tolerates a missing directory', () => {
        js.writeJobStatus('a', { status: 'ok' }); js.writeJobStatus('b', { status: 'critical' });
        expect(Object.keys(js.readAllJobStatus()).sort()).toEqual(['a', 'b']);
        fs.rmSync(dir, { recursive: true, force: true });
        expect(js.readAllJobStatus()).toEqual({});
    });

    test('history is capped', () => {
        for (let i = 0; i < js.HISTORY_CAP + 5; i++) js.writeJobStatus('c', { status: 'ok', summary: String(i) });
        const h = js.readJobHistory('c', 1000);
        expect(h.length).toBe(js.HISTORY_CAP);
        expect(h[h.length - 1].summary).toBe(String(js.HISTORY_CAP + 4));
    });
});

describe('validationStatus (daily validation record + recap gate file)', () => {
    const { computeOverallStatus, buildValidationStatus } = require('../../scripts/lib/validationStatus');
    const health = (over, warnings = 0, failed = 0) => ({ season: 2026, week: 1, overallStatus: over, summary: { passed: 5, failed, warnings }, checks: [] });

    test('overall status precedence: SKIPPED > FAIL (health or double check) > WARN > PASS', () => {
        expect(computeOverallStatus({ skipped: true })).toBe('SKIPPED');
        expect(computeOverallStatus(health('failed', 0, 1), null)).toBe('FAIL');
        expect(computeOverallStatus(health('passed'), { overallStatus: 'FAIL' })).toBe('FAIL');
        expect(computeOverallStatus(health('passed', 2), null)).toBe('WARN');
        // an unfinished week is PASS-so-far: a status is a call to action, and there is nothing to do yet
        expect(computeOverallStatus({ ...health('passed'), completion: { isComplete: false } }, null)).toBe('PASS');
        expect(computeOverallStatus(health('passed'), { overallStatus: 'INCOMPLETE' })).toBe('PASS');
        expect(computeOverallStatus({ ...health('passed'), completion: { isComplete: true } }, { overallStatus: 'PASS' })).toBe('PASS');
    });

    test('buildValidationStatus keeps the legacy weekly-validation shape', () => {
        const s = buildValidationStatus({ health: health('passed'), completion: { isComplete: true, totalGames: 16, completedGames: 16 }, trigger: 'daily' });
        expect(s.schemaVersion).toBe(1);
        expect(s.season).toBe(2026); expect(s.week).toBe(1);
        expect(s.gamesComplete.isComplete).toBe(true);
        expect(s.healthValidation.summary.passed).toBe(5);
        expect(['PASS', 'WARN', 'FAIL']).toContain(s.overallStatus);
        expect(s.email).toEqual({ sent: false, to: null, error: null });
    });
});
