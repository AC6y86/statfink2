/**
 * "Give feedback and run again" for one recap: the pure helpers in
 * server/utils/recapFiles.js, scripts/recap-regenerate.js with a FAKE claude
 * runner over temp directories, and the two admin routes through supertest
 * with app.locals.recapsEnv pointing at temp dirs. Never runs claude, never
 * touches recaps/, logs/ or the database.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const recapFiles = require('../../server/utils/recapFiles');
const { NO_DRAFT_GRADES_RULE } = recapFiles;
const regen = require('../../scripts/recap-regenerate');

const { normaliseFeedback, replaceFactcheckEntry, parseFactcheckReport, factcheckSection } = recapFiles;

const REPORT = `# Week 2 Recap Fact-Check

Preamble the checker wrote.

## 2026-week02-snoop-dogg-style.md: PASS

| Claim | Recap says | Digest says | Severity |
|-------|-----------|-------------|----------|
| Points to tie | "three more" | needs seven | Minor |

## 2026-week02-yogi-berra-style.md: PASS

No discrepancies found.

## Summary
- 2026-week02-snoop-dogg-style.md: PASS (0 critical, 1 minor)
- 2026-week02-yogi-berra-style.md: PASS (0 critical, 0 minor)
`;

describe('normaliseFeedback', () => {
    test('trims, normalises CRLF and trailing spaces, keeps inner newlines', () => {
        expect(normaliseFeedback('  more jokes  \r\nless stats \n')).toBe('more jokes\nless stats');
    });
    test('rejects non-strings, too short and too long', () => {
        expect(() => normaliseFeedback(undefined)).toThrow(/string/);
        expect(() => normaliseFeedback(42)).toThrow(/string/);
        expect(() => normaliseFeedback('  hi  ')).toThrow(/at least 5/);
        expect(() => normaliseFeedback('x'.repeat(recapFiles.FEEDBACK_MAX + 1))).toThrow(/too long/);
        expect(normaliseFeedback('x'.repeat(recapFiles.FEEDBACK_MAX)).length).toBe(recapFiles.FEEDBACK_MAX);
    });
});

describe('replaceFactcheckEntry', () => {
    test('replaces one recap\'s section and Summary line, leaves the others alone', () => {
        const out = replaceFactcheckEntry(REPORT, { season: 2026, week: 2, slug: 'snoop-dogg', verdict: 'FAIL', critical: 1, minor: 0, detail: '| Claim | Recap says | Digest says | Severity |\n|---|---|---|---|\n| Winner | Joe | Chris | Critical |' });
        expect(parseFactcheckReport(out)).toEqual({
            'snoop-dogg': { verdict: 'FAIL', critical: 1, minor: 0 },
            'yogi-berra': { verdict: 'PASS', critical: 0, minor: 0 }
        });
        expect(factcheckSection(out, 'snoop-dogg')).toEqual({ verdict: 'FAIL', detail: '| Claim | Recap says | Digest says | Severity |\n|---|---|---|---|\n| Winner | Joe | Chris | Critical |' });
        expect(factcheckSection(out, 'yogi-berra')).toEqual({ verdict: 'PASS', detail: 'No discrepancies found.' });
        expect(out).toContain('Preamble the checker wrote.');
        expect(out).not.toContain('"three more"');
        expect(out.match(/snoop-dogg-style\.md/g)).toHaveLength(2);
        expect(out.indexOf('## Summary')).toBeGreaterThan(out.indexOf('## 2026-week02-yogi-berra-style.md'));
    });

    test('adds a section before the Summary and a Summary line when the recap was never checked', () => {
        const out = replaceFactcheckEntry(REPORT, { season: 2026, week: 2, slug: 'new-guy', verdict: 'PASS' });
        expect(parseFactcheckReport(out)['new-guy']).toEqual({ verdict: 'PASS', critical: 0, minor: 0 });
        expect(factcheckSection(out, 'new-guy')).toEqual({ verdict: 'PASS', detail: '' });
        expect(out.indexOf('## 2026-week02-new-guy-style.md: PASS')).toBeLessThan(out.indexOf('## Summary'));
        expect(out.trim().endsWith('- 2026-week02-new-guy-style.md: PASS (0 critical, 0 minor)')).toBe(true);
    });

    test('starts a report from nothing, and treats anything but PASS as FAIL', () => {
        const out = replaceFactcheckEntry('', { season: 2026, week: 3, slug: 'x-y', verdict: 'fail', critical: 2, minor: 1, detail: 'bad' });
        expect(out.startsWith('# Week 3 Recap Fact-Check')).toBe(true);
        expect(parseFactcheckReport(out)).toEqual({ 'x-y': { verdict: 'FAIL', critical: 2, minor: 1 } });
        expect(factcheckSection(out, 'x-y')).toEqual({ verdict: 'FAIL', detail: 'bad' });
    });
});

// ---------- scripts/recap-regenerate.js over temp dirs with a fake claude ----------

const WORDS = n => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recap-regen-'));
    const root = path.join(dir, 'recaps');
    const work = path.join(dir, 'work');
    const season = path.join(root, '2026');
    fs.mkdirSync(path.join(season, 'data'), { recursive: true });
    fs.writeFileSync(path.join(season, '2026-week02-snoop-dogg-style.md'), '# Old Snoop\n\nthe old version\n');
    fs.writeFileSync(path.join(season, '2026-week02-yogi-berra-style.md'), '# Yogi\n');
    fs.writeFileSync(path.join(season, 'storylines.md'), 'live storylines');
    fs.writeFileSync(path.join(season, 'data', 'week02-digest.md'), '# digest');
    fs.writeFileSync(path.join(season, 'data', 'week02-storylines.md'), 'snapshot storylines');
    fs.writeFileSync(path.join(season, 'data', 'week02-factcheck.md'), REPORT);
    fs.writeFileSync(path.join(season, 'data', 'week02-ratings.json'), JSON.stringify({ season: 2026, week: 2, ratedAt: 't', ratedBy: 'claude-opus', recommended: 'snoop-dogg', ratings: { 'snoop-dogg': { stars: 4.5, blurb: 'good' }, 'yogi-berra': { stars: 3, blurb: 'ok' } } }));
    fs.writeFileSync(path.join(season, 'data', 'week02-themes.json'), JSON.stringify({ season: 2026, week: 2, themes: [{ slug: 'snoop-dogg', name: 'Snoop Dogg', description: 'laid back' }] }));
    return { dir, root, work, season };
}

describe('scripts/recap-regenerate.js', () => {
    let fx;
    let statuses;
    const writeStatus = (job, rec) => { statuses.push({ job, ...rec }); };
    beforeEach(() => { fx = fixture(); statuses = []; jest.spyOn(console, 'log').mockImplementation(() => {}); });
    afterEach(() => { fs.rmSync(fx.dir, { recursive: true, force: true }); jest.restoreAllMocks(); });

    const opts = (extra = {}) => ({ season: 2026, week: 2, slug: 'snoop-dogg', feedback: 'Shorter. More about the Chris/Joe game.\nKeep the ending.', ...extra });
    const deps = (claude) => ({ claude, writeStatus, root: fx.root, work: fx.work });

    test('buildPrompt carries the feedback verbatim, the style, every path, the data contract and the hands-off rule', () => {
        const p = regen.paths(2026, 2, 'snoop-dogg', { root: fx.root, work: fx.work });
        expect(p.storylines).toBe(path.join(fx.season, 'data', 'week02-storylines.md')); // snapshot preferred
        const prompt = regen.buildPrompt({ season: 2026, week: 2, slug: 'snoop-dogg', styleName: 'Snoop Dogg', description: 'laid back', feedback: 'Shorter.\nKeep the ending.', p, previousFactcheck: { verdict: 'FAIL', detail: '| Winner | Joe | Chris |' } });
        expect(prompt).toContain('"""\nShorter.\nKeep the ending.\n"""');
        expect(prompt).toContain('"Snoop Dogg" (style slug: snoop-dogg) - laid back');
        expect(prompt).toContain(`weekly-standings-narrator`);
        expect(prompt).toContain(`recap-fact-checker`);
        expect(prompt).toContain(`The absolute path to the digest: ${p.digest}`);
        expect(prompt).toContain(`The output path: ${p.draft}`);
        expect(prompt).toContain('The digest is your ONLY source of scores, records, standings, and player stats. Copy numbers verbatim. Do not query the database or invent statistics.');
        // standing rule (Joe, 2026-10-15): draft grades are out - handed to the narrator and enforced by the fact-checker
        expect(prompt).toContain(`This standing rule, verbatim: "${NO_DRAFT_GRADES_RULE}"`);
        expect(prompt).toContain(`Also give the fact-checker this standing rule verbatim: "${NO_DRAFT_GRADES_RULE}"`);
        expect(NO_DRAFT_GRADES_RULE).toMatch(/never mention, compare against or otherwise use preseason\/draft grades/);
        expect(prompt).toContain('must not repeat');
        expect(prompt).toContain('| Winner | Joe | Chris |');
        expect(prompt).toContain(`Do NOT write, edit or delete ${p.recap}`);
        expect(prompt).toContain('2026-week02-snoop-dogg-style.md');
        // a clean previous fact-check adds no "must not repeat" clause
        expect(regen.buildPrompt({ season: 2026, week: 2, slug: 'snoop-dogg', styleName: 'Snoop Dogg', description: '', feedback: 'Shorter please', p, previousFactcheck: { verdict: 'PASS', detail: '' } })).not.toContain('must not repeat');
    });

    test('dry run prints the prompt and touches nothing', async () => {
        const claude = jest.fn();
        const r = await regen.regenerateRecap(opts({ dryRun: true }), deps(claude));
        expect(r.ok).toBe(true);
        expect(r.prompt).toContain('Shorter. More about the Chris/Joe game.');
        expect(r.claudeArgs).toEqual(expect.arrayContaining(['--allowedTools', 'Task', 'Write']));
        expect(claude).not.toHaveBeenCalled();
        expect(fs.existsSync(fx.work)).toBe(false);
        expect(statuses).toEqual([]);
    });

    test('success: draft written by the "agents" is swapped in only after it passes, old version kept, fact-check and ratings updated', async () => {
        const live = path.join(fx.season, '2026-week02-snoop-dogg-style.md');
        const claude = jest.fn(async (args, { input }) => {
            expect(args[0]).toBe('-p');
            expect(input).toContain('Shorter. More about the Chris/Joe game.');
            // The live file is still the old one while claude "runs"
            expect(fs.readFileSync(live, 'utf8')).toContain('the old version');
            const p = regen.paths(2026, 2, 'snoop-dogg', { root: fx.root, work: fx.work });
            expect(fs.readFileSync(p.previous, 'utf8')).toContain('the old version');
            fs.writeFileSync(p.draft, `# New Snoop\n\n${WORDS(regen.MIN_WORDS + 50)}`);
            fs.writeFileSync(p.draftReport, '# Check\n\n## 2026-week02-snoop-dogg-style.md: PASS\n\nAll good now.\n\n## Summary\n- 2026-week02-snoop-dogg-style.md: PASS (0 critical, 2 minor)\n');
            return { exitCode: 0, envelope: { total_cost_usd: 0.42, duration_ms: 1234, num_turns: 5 }, error: null };
        });
        const r = await regen.regenerateRecap(opts(), deps(claude));
        expect(r.ok).toBe(true);
        expect(r.verdict).toBe('PASS');
        expect(r.minor).toBe(2);
        expect(fs.readFileSync(live, 'utf8')).toMatch(/^# New Snoop/);
        expect(fs.readFileSync(live, 'utf8').endsWith('\n')).toBe(true);
        expect(fs.readdirSync(fx.season).filter(f => f.endsWith('.tmp'))).toEqual([]);
        expect(fs.readFileSync(r.previous, 'utf8')).toContain('the old version');
        const report = fs.readFileSync(path.join(fx.season, 'data', 'week02-factcheck.md'), 'utf8');
        expect(parseFactcheckReport(report)).toEqual({ 'snoop-dogg': { verdict: 'PASS', critical: 0, minor: 2 }, 'yogi-berra': { verdict: 'PASS', critical: 0, minor: 0 } });
        expect(factcheckSection(report, 'snoop-dogg').detail).toBe('All good now.');
        const ratings = JSON.parse(fs.readFileSync(path.join(fx.season, 'data', 'week02-ratings.json'), 'utf8'));
        expect(ratings.ratings).toEqual({ 'yogi-berra': { stars: 3, blurb: 'ok' } });
        expect(ratings.recommended).toBeNull();
        expect(statuses.map(s => s.status)).toEqual(['running', 'ok']);
        expect(statuses[0].details).toMatchObject({ slug: 'snoop-dogg', styleName: 'Snoop Dogg', pid: process.pid });
        expect(statuses[1].details).toMatchObject({ slug: 'snoop-dogg', verdict: 'PASS', minor: 2, claude: { costUsd: 0.42 } });
        expect(statuses[1].summary).toContain('Snoop Dogg rewritten');
    });

    test('a FAIL from the checker does not swap the recap in, and leaves the live fact-check/ratings alone', async () => {
        const live = path.join(fx.season, '2026-week02-snoop-dogg-style.md');
        const before = {
            recap: fs.readFileSync(live, 'utf8'),
            report: fs.readFileSync(path.join(fx.season, 'data', 'week02-factcheck.md'), 'utf8'),
            ratings: fs.readFileSync(path.join(fx.season, 'data', 'week02-ratings.json'), 'utf8')
        };
        const claude = jest.fn(async () => {
            const p = regen.paths(2026, 2, 'snoop-dogg', { root: fx.root, work: fx.work });
            fs.writeFileSync(p.draft, `# New\n\n${WORDS(regen.MIN_WORDS)}`);
            fs.writeFileSync(p.draftReport, '## 2026-week02-snoop-dogg-style.md: FAIL\n\n| Winner | Joe | Chris | Critical |\n\n## Summary\n- 2026-week02-snoop-dogg-style.md: FAIL (1 critical, 0 minor)\n');
            return { exitCode: 0, envelope: {}, error: null };
        });
        const r = await regen.regenerateRecap(opts(), deps(claude));
        expect(r).toMatchObject({ ok: false, verdict: 'FAIL', critical: 1, minor: 0, kept: true });
        expect(r.detail).toContain('| Winner | Joe | Chris | Critical |');
        expect(statuses[1].status).toBe('warning');
        expect(statuses[1].details).toMatchObject({ verdict: 'FAIL', critical: 1, minor: 0, kept: true, factcheck: r.detail });
        // nothing on the live side changed - the draft and its report stayed in the scratch dir
        expect(fs.readFileSync(live, 'utf8')).toBe(before.recap);
        expect(fs.readFileSync(path.join(fx.season, 'data', 'week02-factcheck.md'), 'utf8')).toBe(before.report);
        expect(fs.readFileSync(path.join(fx.season, 'data', 'week02-ratings.json'), 'utf8')).toBe(before.ratings);
        expect(parseFactcheckReport(before.report)['snoop-dogg']).toEqual({ verdict: 'PASS', critical: 0, minor: 1 });
    });

    test('no fact-check report at all: fails closed, keeps the live recap/report/ratings, warns with actionable detail', async () => {
        const live = path.join(fx.season, '2026-week02-snoop-dogg-style.md');
        const before = {
            recap: fs.readFileSync(live, 'utf8'),
            report: fs.readFileSync(path.join(fx.season, 'data', 'week02-factcheck.md'), 'utf8'),
            ratings: fs.readFileSync(path.join(fx.season, 'data', 'week02-ratings.json'), 'utf8')
        };
        const claude = jest.fn(async () => {
            const p = regen.paths(2026, 2, 'snoop-dogg', { root: fx.root, work: fx.work });
            fs.writeFileSync(p.draft, `# New\n\n${WORDS(regen.MIN_WORDS)}`);
            // no draftReport written at all
            return { exitCode: 0, envelope: {}, error: null };
        });
        const r = await regen.regenerateRecap(opts(), deps(claude));
        expect(r).toMatchObject({ ok: false, verdict: null, kept: true });
        expect(r.error).toMatch(/no readable fact-check report/);
        expect(statuses[1].status).toBe('warning');
        expect(statuses[1].details.reportProblem).toMatch(/no readable fact-check report/);
        expect(fs.readFileSync(live, 'utf8')).toBe(before.recap);
        expect(fs.readFileSync(path.join(fx.season, 'data', 'week02-factcheck.md'), 'utf8')).toBe(before.report);
        expect(fs.readFileSync(path.join(fx.season, 'data', 'week02-ratings.json'), 'utf8')).toBe(before.ratings);
    });

    test('a fact-check report with no parseable verdict for this slug: fails closed, keeps the live recap/report/ratings', async () => {
        const live = path.join(fx.season, '2026-week02-snoop-dogg-style.md');
        const before = {
            recap: fs.readFileSync(live, 'utf8'),
            report: fs.readFileSync(path.join(fx.season, 'data', 'week02-factcheck.md'), 'utf8'),
            ratings: fs.readFileSync(path.join(fx.season, 'data', 'week02-ratings.json'), 'utf8')
        };
        const claude = jest.fn(async () => {
            const p = regen.paths(2026, 2, 'snoop-dogg', { root: fx.root, work: fx.work });
            fs.writeFileSync(p.draft, `# New\n\n${WORDS(regen.MIN_WORDS)}`);
            fs.writeFileSync(p.draftReport, 'This report is just prose with no headings or verdict at all.\n');
            return { exitCode: 0, envelope: {}, error: null };
        });
        const r = await regen.regenerateRecap(opts(), deps(claude));
        expect(r).toMatchObject({ ok: false, verdict: null, kept: true });
        expect(r.error).toMatch(/no parseable verdict/);
        expect(statuses[1].status).toBe('warning');
        expect(statuses[1].details.reportProblem).toMatch(/no parseable verdict/);
        expect(fs.readFileSync(live, 'utf8')).toBe(before.recap);
        expect(fs.readFileSync(path.join(fx.season, 'data', 'week02-factcheck.md'), 'utf8')).toBe(before.report);
        expect(fs.readFileSync(path.join(fx.season, 'data', 'week02-ratings.json'), 'utf8')).toBe(before.ratings);
    });

    test('claude error, no draft, or a stub draft: the current recap, report and ratings are untouched and the status is critical', async () => {
        const live = path.join(fx.season, '2026-week02-snoop-dogg-style.md');
        const before = { recap: fs.readFileSync(live, 'utf8'), report: fs.readFileSync(path.join(fx.season, 'data', 'week02-factcheck.md'), 'utf8'), ratings: fs.readFileSync(path.join(fx.season, 'data', 'week02-ratings.json'), 'utf8') };
        const cases = [
            jest.fn(async () => ({ exitCode: 1, envelope: null, error: 'claude exited 1: boom' })),
            jest.fn(async () => ({ exitCode: 0, envelope: {}, error: null })),
            jest.fn(async () => { fs.writeFileSync(regen.paths(2026, 2, 'snoop-dogg', { root: fx.root, work: fx.work }).draft, 'Sorry, I could not.'); return { exitCode: 0, envelope: {}, error: null }; })
        ];
        const errors = [];
        for (const claude of cases) {
            statuses = [];
            const r = await regen.regenerateRecap(opts(), deps(claude));
            expect(r.ok).toBe(false);
            errors.push(r.error);
            expect(statuses.map(s => s.status)).toEqual(['running', 'critical']);
            expect(fs.readFileSync(live, 'utf8')).toBe(before.recap);
            expect(fs.readFileSync(path.join(fx.season, 'data', 'week02-factcheck.md'), 'utf8')).toBe(before.report);
            expect(fs.readFileSync(path.join(fx.season, 'data', 'week02-ratings.json'), 'utf8')).toBe(before.ratings);
        }
        expect(errors[0]).toMatch(/boom/);
        expect(errors[1]).toMatch(/no draft/);
        expect(errors[2]).toMatch(/only 4 words/);
    });

    describe('feedback.json: persistence, deduplication, ordering, malformed recovery, compliance prompt', () => {
        const historyFile = () => regen.paths(2026, 2, 'snoop-dogg', { root: fx.root, work: fx.work }).feedbackHistory;
        const draftClaude = (verdict = 'PASS', detail = 'All good.') => jest.fn(async () => {
            const p = regen.paths(2026, 2, 'snoop-dogg', { root: fx.root, work: fx.work });
            fs.writeFileSync(p.draft, `# New\n\n${WORDS(regen.MIN_WORDS + 10)}`);
            fs.writeFileSync(p.draftReport, `## 2026-week02-snoop-dogg-style.md: ${verdict}\n\n${detail}\n\n## Summary\n- 2026-week02-snoop-dogg-style.md: ${verdict} (${verdict === 'FAIL' ? '1 critical' : '0 critical'}, 0 minor)\n`);
            return { exitCode: 0, envelope: {}, error: null };
        });

        test('readFeedbackHistory/appendFeedback: pure, ordered, exact-text dedup bumps submissions without reordering', () => {
            const empty = regen.readFeedbackHistory(path.join(fx.work, 'nope', 'feedback.json'), { season: 2026, week: 2, slug: 'snoop-dogg' });
            expect(empty).toEqual({ season: 2026, week: 2, slug: 'snoop-dogg', version: 1, entries: [] });

            let step = regen.appendFeedback(empty, 'Shorter please', '2026-01-01T00:00:00.000Z');
            expect(step.added).toBe(true);
            expect(step.history.entries).toEqual([{ n: 1, feedback: 'Shorter please', submittedAt: '2026-01-01T00:00:00.000Z', lastSubmittedAt: '2026-01-01T00:00:00.000Z', submissions: 1 }]);

            step = regen.appendFeedback(step.history, 'More jokes', '2026-01-02T00:00:00.000Z');
            expect(step.added).toBe(true);
            expect(step.history.entries.map(e => e.feedback)).toEqual(['Shorter please', 'More jokes']);

            // resubmitting the first entry's exact normalized text: no new entry, no reordering, submissions/lastSubmittedAt update
            step = regen.appendFeedback(step.history, 'Shorter please', '2026-01-03T00:00:00.000Z');
            expect(step.added).toBe(false);
            expect(step.history.entries.map(e => e.feedback)).toEqual(['Shorter please', 'More jokes']);
            expect(step.history.entries[0]).toMatchObject({ submissions: 2, submittedAt: '2026-01-01T00:00:00.000Z', lastSubmittedAt: '2026-01-03T00:00:00.000Z' });
            expect(step.history.entries[1]).toMatchObject({ submissions: 1 });
        });

        test('readFeedbackHistory recovers from a missing file (empty history) and a malformed one (backed up as .corrupt.json, treated as empty)', () => {
            const file = path.join(fx.work, 'scratch', 'feedback.json');
            expect(regen.readFeedbackHistory(file, { season: 2026, week: 2, slug: 'snoop-dogg' }).entries).toEqual([]);

            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, 'not json at all {{{');
            const recovered = regen.readFeedbackHistory(file, { season: 2026, week: 2, slug: 'snoop-dogg' });
            expect(recovered.entries).toEqual([]);
            expect(fs.readFileSync(file.replace(/\.json$/, '') + '.corrupt.json', 'utf8')).toBe('not json at all {{{');

            // valid JSON but the wrong shape (no entries array) is treated the same way
            fs.writeFileSync(file, JSON.stringify({ season: 2026 }));
            expect(regen.readFeedbackHistory(file, { season: 2026, week: 2, slug: 'snoop-dogg' }).entries).toEqual([]);

            // entries that are not { feedback: non-empty string } are dropped, not fatal
            fs.writeFileSync(file, JSON.stringify({ entries: [{ feedback: 'ok one' }, { feedback: '' }, { feedback: 42 }, null, 'nope', { feedback: '   ' }] }));
            expect(regen.readFeedbackHistory(file).entries.map(e => e.feedback)).toEqual(['ok one']);
        });

        test('writeFeedbackHistory writes atomically (no leftover .tmp) and round-trips through readFeedbackHistory', () => {
            const file = path.join(fx.work, 'atomic', 'feedback.json');
            const { history } = regen.appendFeedback({ entries: [] }, 'Be punchier');
            regen.writeFeedbackHistory(file, history);
            expect(fs.readdirSync(path.dirname(file)).filter(f => f.endsWith('.tmp'))).toEqual([]);
            expect(regen.readFeedbackHistory(file).entries).toEqual(history.entries);
        });

        test('feedbackSection: complete ordered history, current submission marked, binding rule stated, appends current text if absent from priors', () => {
            const priors = [
                { feedback: 'Shorter please', submittedAt: '2026-01-01T00:00:00.000Z' },
                { feedback: 'More jokes', submittedAt: '2026-01-02T00:00:00.000Z' }
            ];
            const section = regen.feedbackSection('Keep the ending', priors);
            expect(section).toContain(regen.BINDING_RULE);
            expect(section).toContain('given feedback on this recap 3 times');
            const iShorter = section.indexOf('Shorter please');
            const iJokes = section.indexOf('More jokes');
            const iEnding = section.indexOf('Keep the ending');
            expect(iShorter).toBeGreaterThan(-1);
            expect(iJokes).toBeGreaterThan(iShorter);
            expect(iEnding).toBeGreaterThan(iJokes);
            expect(section).toMatch(/Feedback 1 of 3 \(submitted 2026-01-01T00:00:00\.000Z; earlier - still binding\)/);
            expect(section).toMatch(/Feedback 3 of 3 \(THIS submission - the reason for this rewrite\)/);

            // current text already among priors: no duplicate entry, just re-tagged as THIS submission
            const already = regen.feedbackSection('Shorter please', priors);
            expect(already.match(/Shorter please/g)).toHaveLength(1);
            expect(already).toContain('given feedback on this recap 2 times');
        });

        test('buildPrompt hands the narrator and the fact-checker the same complete ordered history and the fact-checker a FAIL-on-unhonoured-feedback compliance instruction', () => {
            const p = regen.paths(2026, 2, 'snoop-dogg', { root: fx.root, work: fx.work });
            const feedbackHistory = [
                { feedback: 'Shorter please', submittedAt: '2026-01-01T00:00:00.000Z' },
                { feedback: 'No dad jokes', submittedAt: '2026-01-02T00:00:00.000Z' }
            ];
            const prompt = regen.buildPrompt({ season: 2026, week: 2, slug: 'snoop-dogg', styleName: 'Snoop Dogg', description: '', feedback: 'Keep the ending', feedbackHistory, p, previousFactcheck: null });
            expect(prompt).toContain('Shorter please');
            expect(prompt).toContain('No dad jokes');
            expect(prompt).toContain('Keep the ending');
            expect(prompt).toContain(regen.BINDING_RULE);
            expect(prompt).toContain('COMPLETE feedback block above, copied verbatim (every numbered entry in the same order');
            expect(prompt).toContain('same COMPLETE feedback block above, copied verbatim (every numbered entry in order');
            expect(prompt).toContain('Any instruction that is not honoured makes the recap a FAIL');
            expect(prompt).toContain('Claim = "Feedback N: <the instruction, quoted>"');
            expect(prompt).toContain('do not skip the feedback check because the facts pass');
        });

        test('end-to-end: persists to workDir/feedback.json across runs, ordered oldest-first, dedup on resubmission, and every entry reaches the prompt', async () => {
            const first = await regen.regenerateRecap(opts({ feedback: 'Shorter please' }), deps(draftClaude()));
            expect(first.ok).toBe(true);
            let saved = JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
            expect(saved.entries.map(e => e.feedback)).toEqual(['Shorter please']);
            expect(saved.entries[0].submissions).toBe(1);

            const second = await regen.regenerateRecap(opts({ feedback: 'More about the trade' }), deps(draftClaude()));
            expect(second.ok).toBe(true);
            saved = JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
            expect(saved.entries.map(e => e.feedback)).toEqual(['Shorter please', 'More about the trade']);

            // resubmitting the first, already-recorded feedback (normalizes identically): no third entry, submissions bumps
            let promptSeen;
            const echoClaude = jest.fn(async (args, { input }) => { promptSeen = input; return draftClaude()(args, { input }); });
            const third = await regen.regenerateRecap(opts({ feedback: '  Shorter please  \r\n' }), deps(echoClaude));
            expect(third.ok).toBe(true);
            saved = JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
            expect(saved.entries.map(e => e.feedback)).toEqual(['Shorter please', 'More about the trade']);
            expect(saved.entries[0].submissions).toBe(2);
            // both prior instructions reached the prompt, oldest first, alongside the (deduped) current one
            expect(promptSeen.indexOf('Shorter please')).toBeLessThan(promptSeen.indexOf('More about the trade'));
            expect(promptSeen).toContain(regen.BINDING_RULE);
        });

        test('a malformed feedback.json on disk does not abort the run: it is recovered as empty history and this submission is recorded fresh', async () => {
            const p = regen.paths(2026, 2, 'snoop-dogg', { root: fx.root, work: fx.work });
            fs.mkdirSync(p.workDir, { recursive: true });
            fs.writeFileSync(p.feedbackHistory, '{ this is not valid json');
            const r = await regen.regenerateRecap(opts({ feedback: 'Fix the intro' }), deps(draftClaude()));
            expect(r.ok).toBe(true);
            const saved = JSON.parse(fs.readFileSync(p.feedbackHistory, 'utf8'));
            expect(saved.entries.map(e => e.feedback)).toEqual(['Fix the intro']);
            expect(fs.existsSync(path.join(p.workDir, 'feedback.corrupt.json'))).toBe(true);
        });

        test('no swap on FAIL: feedback is still persisted to feedback.json even when the draft fails the fact-check', async () => {
            const r = await regen.regenerateRecap(opts({ feedback: 'Trim it down' }), deps(draftClaude('FAIL', '| Claim | Recap says | Digest says | Severity |\n|---|---|---|---|\n| X | Y | Z | Critical |')));
            expect(r.ok).toBe(false);
            expect(r.verdict).toBe('FAIL');
            const saved = JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
            expect(saved.entries.map(e => e.feedback)).toEqual(['Trim it down']);
        });
    });

    test('refuses bad identifiers, empty feedback, a missing recap and a missing digest before running anything', async () => {
        const claude = jest.fn();
        expect((await regen.regenerateRecap(opts({ slug: '../etc' }), deps(claude))).error).toMatch(/slug/);
        expect((await regen.regenerateRecap(opts({ week: 99 }), deps(claude))).error).toMatch(/season or week/);
        expect((await regen.regenerateRecap(opts({ feedback: 'ok' }), deps(claude))).error).toMatch(/at least 5/);
        expect((await regen.regenerateRecap(opts({ slug: 'nobody-here' }), deps(claude))).error).toMatch(/no recap on disk/);
        fs.unlinkSync(path.join(fx.season, 'data', 'week02-digest.md'));
        expect((await regen.regenerateRecap(opts(), deps(claude))).error).toMatch(/no data digest/);
        expect(claude).not.toHaveBeenCalled();
        expect(statuses.every(s => s.status === 'critical')).toBe(true);
    });

    test('parseArgs reads the flags the route passes', () => {
        expect(regen.parseArgs(['--season', '2026', '--week', '2', '--slug', 'snoop-dogg', '--feedback', 'Shorter.\nKeep the ending.'])).toEqual({ season: 2026, week: 2, slug: 'snoop-dogg', feedback: 'Shorter.\nKeep the ending.', dryRun: false });
    });
});

// ---------- the routes ----------

describe('POST/GET /api/admin/recaps/:season/:week/:slug/regenerate (server/routes/admin.js)', () => {
    const express = require('express');
    const request = require('supertest');
    let fx;
    let app;
    let spawned;
    let statusDir;
    beforeEach(() => {
        fx = fixture();
        spawned = [];
        statusDir = path.join(fx.dir, 'status');
        app = express();
        app.use(express.json());
        app.locals.recapsEnv = { root: fx.root, statusDir, spawnScript: (script, args, label) => { spawned.push({ script, args, label }); return { pid: 4242, log: 'logs/recap-regenerate-admin.log' }; } };
        app.use('/api/admin', require('../../server/routes/admin'));
        app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ success: false, message: err.message })); // eslint-disable-line no-unused-vars
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => { fs.rmSync(fx.dir, { recursive: true, force: true }); jest.restoreAllMocks(); });

    const url = (slug = 'snoop-dogg', season = 2026, week = 2) => `/api/admin/recaps/${season}/${week}/${slug}/regenerate`;
    const writeStatus = rec => { fs.mkdirSync(statusDir, { recursive: true }); fs.writeFileSync(path.join(statusDir, 'recap-regenerate.json'), JSON.stringify(rec)); };

    test('validates identifiers and feedback, and answers 404 for a recap that is not on disk', async () => {
        expect((await request(app).post(url('..%2Fetc')).send({ feedback: 'Shorter please' })).status).toBe(400);
        expect((await request(app).post(url('Snoop_Dogg')).send({ feedback: 'Shorter please' })).status).toBe(400);
        expect((await request(app).post(url('snoop-dogg', 2026, 99)).send({ feedback: 'Shorter please' })).status).toBe(400);
        for (const body of [{}, { feedback: '' }, { feedback: 'hi' }, { feedback: 42 }, { feedback: 'x'.repeat(2001) }]) {
            const res = await request(app).post(url()).send(body);
            expect(res.status).toBe(400);
            expect(res.body.message).toMatch(/feedback|characters|change/i);
        }
        const res = await request(app).post(url('nobody-here')).send({ feedback: 'Shorter please' });
        expect(res.status).toBe(404);
        expect(spawned).toEqual([]);
        expect(fs.existsSync(path.join(statusDir, 'recap-regenerate.json'))).toBe(false);
    });

    test('starts the rewrite: running status first (so a second submit gets 409), then the script with the feedback', async () => {
        const res = await request(app).post(url()).send({ feedback: '  Shorter. More about the Chris/Joe game.\r\nKeep the ending.  ' });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ pid: 4242, slug: 'snoop-dogg', styleName: 'Snoop Dogg', season: 2026, week: 2 });
        expect(res.body.data.message).toMatch(/current version stays/);
        expect(spawned).toEqual([{ script: 'recap-regenerate.js', args: ['--season', '2026', '--week', '2', '--slug', 'snoop-dogg', '--feedback', 'Shorter. More about the Chris/Joe game.\nKeep the ending.'], label: 'Recap regeneration' }]);
        const rec = JSON.parse(fs.readFileSync(path.join(statusDir, 'recap-regenerate.json'), 'utf8'));
        expect(rec).toMatchObject({ job: 'recap-regenerate', status: 'running', season: 2026, week: 2, details: { slug: 'snoop-dogg', styleName: 'Snoop Dogg', feedback: 'Shorter. More about the Chris/Joe game.\nKeep the ending.', pid: null } });
        expect(fs.readdirSync(statusDir).filter(f => f.endsWith('.tmp'))).toEqual([]);

        const again = await request(app).post(url('yogi-berra')).send({ feedback: 'Different recap, same time' });
        expect(again.status).toBe(409);
        expect(again.body.message).toMatch(/Already rewriting Snoop Dogg/);
        expect(spawned).toHaveLength(1);

        // The whole-week Generate button is refused too while the rewrite runs
        fs.writeFileSync(path.join(fx.season, 'data', 'week02-themes.json'), JSON.stringify({ season: 2026, week: 2, themes: [{ slug: 'snoop-dogg', name: 'Snoop Dogg' }] }));
        const gen = await request(app).post('/api/admin/recaps/2026/2/generate').send({});
        expect([400, 409]).toContain(gen.status); // 409 busy, or 400/409 from the themes/validation gates that read the real repo state
        expect(spawned).toHaveLength(1);
    });

    test('a stale or dead "running" record does not block a new rewrite', async () => {
        writeStatus({ job: 'recap-regenerate', ts: new Date(Date.now() - 31 * 60 * 1000).toISOString(), status: 'running', season: 2026, week: 2, details: { slug: 'yogi-berra', pid: null } });
        expect((await request(app).post(url()).send({ feedback: 'Shorter please' })).status).toBe(200);
        writeStatus({ job: 'recap-regenerate', ts: new Date().toISOString(), status: 'running', season: 2026, week: 2, details: { slug: 'yogi-berra', pid: 2147483647 } });
        expect((await request(app).post(url()).send({ feedback: 'Shorter please' })).status).toBe(200);
        expect(spawned).toHaveLength(2);
    });

    test('GET reports this recap\'s rewrite only, marks a dead running record as failed, and says whether any rewrite is active', async () => {
        let res = await request(app).get(url());
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ season: 2026, week: 2, slug: 'snoop-dogg', regeneration: null, active: false });
        expect((await request(app).get(url('bad slug'))).status).toBe(400);

        writeStatus({ job: 'recap-regenerate', ts: new Date().toISOString(), status: 'running', summary: 'rewriting Snoop Dogg', season: 2026, week: 2, details: { slug: 'snoop-dogg', pid: process.pid, feedback: 'Shorter please' } });
        res = await request(app).get(url());
        expect(res.body.data.regeneration).toMatchObject({ status: 'running', summary: 'rewriting Snoop Dogg', details: { feedback: 'Shorter please' } });
        expect(res.body.data.active).toBe(true);
        res = await request(app).get(url('yogi-berra'));
        expect(res.body.data).toMatchObject({ regeneration: null, active: true });

        writeStatus({ job: 'recap-regenerate', ts: new Date().toISOString(), status: 'running', summary: 'rewriting Snoop Dogg', season: 2026, week: 2, details: { slug: 'snoop-dogg', pid: 2147483647 } });
        res = await request(app).get(url());
        expect(res.body.data.regeneration.status).toBe('critical');
        expect(res.body.data.regeneration.summary).toMatch(/stopped without reporting/);
        expect(res.body.data.active).toBe(false);

        writeStatus({ job: 'recap-regenerate', ts: new Date().toISOString(), status: 'ok', summary: 'rewritten', season: 2026, week: 2, details: { slug: 'snoop-dogg', verdict: 'PASS', words: 950 } });
        res = await request(app).get(url());
        expect(res.body.data).toMatchObject({ regeneration: { status: 'ok', details: { verdict: 'PASS', words: 950 } }, active: false });
    });
});
