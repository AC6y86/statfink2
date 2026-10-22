/**
 * SLOW / opt-in: the Double Check job's own regression test.
 *
 * Runs the deterministic layer (scripts/doublecheck-data.js) on the
 * pre-correction 2025 backup and on the live DB for the weeks listed in
 * tests/fixtures/doublecheck/calibration-2025.json, then asserts that every
 * documented 2025 correction (docs/DEFENSIVE_SCORING.md) is flagged on the
 * backup and absent on the live record.
 *
 *   npm run doublecheck:calibrate          (DOUBLECHECK_CALIBRATION=1)
 *
 * Needs the ESPN file cache for those weeks (logs/doublecheck/espn/2025/);
 * the first run fetches it (~30 s per week). Read-only: both DBs are opened
 * read-only, the backup immutable. Skipped unless DOUBLECHECK_CALIBRATION=1.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '../..');
const FIXTURE = require('../fixtures/doublecheck/calibration-2025.json');
const RUN = process.env.DOUBLECHECK_CALIBRATION === '1';
const maybe = RUN ? describe : describe.skip;

function runData(week, dbPath, outDir) {
    const args = [path.join(REPO, 'scripts/doublecheck-data.js'), '2025', String(week), '--out', outDir, '--refresh', '--quiet'];
    if (dbPath) args.push('--db', dbPath);
    const res = spawnSync(process.execPath, args, { cwd: REPO, encoding: 'utf8', timeout: 5 * 60 * 1000 });
    if (res.status !== 0) throw new Error(`doublecheck-data 2025 wk${week} failed: ${res.stderr || res.stdout}`);
    const checks = JSON.parse(fs.readFileSync(path.join(outDir, 'checks.json'), 'utf8'));
    const findings = checks.findings;
    findings.knownErrors = checks.knownErrors || { matched: [], unmatched: [] };
    return findings;
}

function matches(f, rule) {
    if (f.bugClassRef !== rule.ref) return false;
    if (rule.severity && f.severity !== rule.severity) return false;
    if (rule.flips && !f.flipsResult) return false;
    if (!['FAIL', 'WARN'].includes(f.severity)) return false;
    const hay = `${f.explanation} ${(f.entity || {}).id || ''} ${(f.entity || {}).name || ''} ${(f.entity || {}).owner || ''}`;
    return new RegExp(rule.match, 'i').test(hay);
}

maybe('Double Check calibration against the pre-correction 2025 backup', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doublecheck-calib-'));
    const backup = path.join(REPO, FIXTURE.backupDb);
    const findings = { backup: {}, live: {} };

    beforeAll(() => {
        expect(fs.existsSync(backup)).toBe(true);
        for (const w of FIXTURE.weeks) {
            findings.backup[w] = runData(w, backup, path.join(root, 'backup', `week${String(w).padStart(2, '0')}`));
            findings.live[w] = runData(w, null, path.join(root, 'live', `week${String(w).padStart(2, '0')}`));
        }
    }, 40 * 60 * 1000);

    afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

    test('every documented correction is flagged on the backup', () => {
        const missing = [];
        for (const rule of FIXTURE.mustFindOnBackup) {
            const hits = (findings.backup[rule.week] || []).filter(f => matches(f, rule));
            if (hits.length < (rule.count || 1)) missing.push(`wk${rule.week} ${rule.ref} /${rule.match}/ (${rule.note}): ${hits.length}/${rule.count || 1}`);
        }
        expect(missing).toEqual([]);
    });

    test('none of the corrected errors is flagged on the live record', () => {
        const leaked = [];
        for (const rule of FIXTURE.mustNotFindOnLive) {
            const hits = (findings.live[rule.week] || []).filter(f => matches(f, rule));
            for (const h of hits) leaked.push(`wk${rule.week} ${h.severity} ${h.bugClassRef}: ${h.explanation.slice(0, 120)}`);
        }
        expect(leaked).toEqual([]);
    });

    test('the live record has no FAIL: every residual error is registered in server/config/knownScoringErrors.json', () => {
        const over = [];
        for (const w of FIXTURE.weeks) {
            const fails = findings.live[w].filter(f => f.severity === 'FAIL');
            if (fails.length) over.push(`wk${w}: ${fails.map(f => `${f.bugClassRef} ${f.explanation.slice(0, 100)}`).join(' | ')}`);
        }
        expect(over).toEqual([]);
    });

    test('every registered known error for the audited weeks is still observed (nobody silently "fixed" the record)', () => {
        const unmatched = [];
        for (const w of FIXTURE.weeks) {
            for (const id of findings.live[w].knownErrors.unmatched) unmatched.push(`wk${w}: ${id}`);
        }
        expect(unmatched).toEqual([]);
    });
});
