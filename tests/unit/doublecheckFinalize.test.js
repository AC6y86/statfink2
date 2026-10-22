/**
 * scripts/doublecheck-finalize.js — pure pieces + an end-to-end run over a
 * synthetic workspace under os.tmpdir(). No DB, no network, never writes logs/.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '../../scripts/doublecheck-finalize.js');
const {
    extractJsonBlock,
    parseTotalLine,
    parseVerdictLines,
    parseCheckLines,
    validateFinding,
    mergeFindings,
    rollUp,
    renderReport,
    finalizeWorkspace,
    buildLatest,
    buildEmail,
    writeStatusFile,
    HISTORY_CAP
} = require(SCRIPT);

const SEASON = 2026;
const WEEK = 1;

function jsonFence(arr) {
    return '```json\n' + JSON.stringify(arr, null, 2) + '\n```\n';
}

function buildWorkspace() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doublecheck-finalize-'));
    const ws = path.join(root, 'workspace');
    const statusDir = path.join(root, 'status');
    for (const d of ['teams', 'games', 'agents']) fs.mkdirSync(path.join(ws, d), { recursive: true });
    fs.mkdirSync(statusDir, { recursive: true });

    const manifest = {
        schemaVersion: 1, season: SEASON, week: WEEK, generatedAt: '2026-09-13T10:00:00.000Z',
        dbPath: '/repo/fantasy_football.db', currentWeek: 1,
        games: [
            { game_id: '20260910_DAL@PHI', home: 'PHI', away: 'DAL', status: 'Final', final: true, espnEventId: '1', espnFetched: true },
            { game_id: '20260914_KC@LAC', home: 'LAC', away: 'KC', status: 'Scheduled', final: false, espnEventId: '2', espnFetched: false }
        ],
        gamesFinal: 1, gamesTotal: 2, allFinal: false, standingsPresent: false,
        espn: { ok: true, fetched: 1, cached: 0, failed: [] },
        validation: { status: 'PASS', runAt: '2026-09-13T09:00:00.000Z' },
        units: [
            { id: 'team-1', input: 'teams/team-1-Pete.md', output: 'agents/team-1.md' },
            { id: 'team-2', input: 'teams/team-2-Mitch.md', output: 'agents/team-2.md' },
            { id: 'team-3', input: 'teams/team-3-Joe.md', output: 'agents/team-3.md' },
            { id: 'game-20260910_DAL@PHI', input: 'games/game-20260910_DAL@PHI.md', output: 'agents/game-20260910_DAL@PHI.md' },
            { id: 'league', input: 'league.md', output: 'agents/league.md' }
        ],
        deferred: ['F3/F4'],
        coverage: { players: 57, rowsCompared: 40, playsAdjudicated: 7 },
        files: { rubric: 'rubric.md', checks: 'checks.json' }
    };
    fs.writeFileSync(path.join(ws, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(ws, 'rubric.md'), '# rubric\n');
    fs.writeFileSync(path.join(ws, 'league.md'), '# league\n');
    fs.writeFileSync(path.join(ws, 'teams/team-1-Pete.md'), '# team 1\n');
    fs.writeFileSync(path.join(ws, 'teams/team-2-Mitch.md'), '# team 2\n');
    fs.writeFileSync(path.join(ws, 'teams/team-3-Joe.md'), '# team 3\n');
    fs.writeFileSync(path.join(ws, 'games/game-20260910_DAL@PHI.md'), '# game\n');

    const checks = {
        generatedAt: manifest.generatedAt,
        findings: [
            {
                id: 'B3-2026-1-111', check: 'td_return_credit', bugClassRef: 'B3', severity: 'WARN', flipsResult: false,
                entity: { type: 'player', id: '111', name: 'Fast Returner', nflTeam: 'PHI', fantasyTeamId: 1, owner: 'Pete', gameId: '20260910_DAL@PHI' },
                internal: { punt_return_tds: 0 }, espn: { text: 'punt return 74 yds' }, expected: { punt_return_tds: 1 },
                explanation: 'ESPN shows a punt return TD; DB credits none.', source: 'script', confidence: 'likely',
                suggestedFix: 'fix scoringPlayParserService return detection then recalc', evidence: ['games/game-20260910_DAL@PHI.md#play-2']
            },
            {
                id: 'A1-2026-1-matchup-3', check: 'matchup_total_vs_lineup_sum', bugClassRef: 'A1', severity: 'FAIL', flipsResult: true,
                entity: { type: 'matchup', id: '3' }, internal: { team1_scoring_points: 90 }, expected: { team1_scoring_points: 84.5 },
                explanation: 'stored total differs from lineup sum', source: 'script', confidence: 'certain',
                suggestedFix: 'rerun scoringPlayersService then recalc', evidence: ['league.md#matchup-3']
            },
            {
                id: 'A3-2026-1-player-222', check: 'rubric_drift', bugClassRef: 'A3', severity: 'INFO',
                entity: { type: 'player', id: '222', name: 'Zero Row' },
                explanation: 'zero-stat row', source: 'script', evidence: ['teams/team-3-Joe.md']
            }
        ],
        checklist: [
            { id: 'A1', name: 'matchup totals', status: 'FAIL', summary: '1 matchup differs' },
            { id: 'A2', name: 'lineup selection', status: 'PASS', summary: 'all 12 lineups match' },
            { id: 'A3', name: 'rubric drift', status: 'PASS', summary: '0 drift' },
            { id: 'B3', name: 'return TD credit', status: 'WARN', summary: '1 uncredited' },
            { id: 'F3/F4', name: 'standings deltas', status: 'DEFER', summary: 'pre-update' }
        ]
    };
    fs.writeFileSync(path.join(ws, 'checks.json'), JSON.stringify(checks, null, 2));

    // team-1: valid, TOTAL line, an LLM-only FAIL on a class the script marks PASS (A2),
    // plus a decoy first json block to prove we take the LAST block.
    fs.writeFileSync(path.join(ws, 'agents/team-1.md'), [
        '# team-1 audit', '',
        '## Players', '```json', '{"decoy": true}', '```', '',
        '## Summary',
        'TOTAL: stored=84.5 recomputed=84.5 espn=86.5 lineup=DIFF', '',
        '## Findings',
        jsonFence([{
            check: 'lineup_selection', bugClassRef: 'A2', severity: 'FAIL', flipsResult: false,
            entity: { type: 'team', id: '1', owner: 'Pete' },
            internal: { total: 84.5 }, expected: { total: 86.5 },
            explanation: 'Bonus slot should hold the 9.0 WR, not the 7.0 TE.',
            evidence: ['teams/team-1-Pete.md#lineup']
        }])
    ].join('\n'));

    // team-2: missing on purpose.

    // team-3: one invalid finding (no evidence) + one valid INFO.
    fs.writeFileSync(path.join(ws, 'agents/team-3.md'), [
        '# team-3 audit',
        'TOTAL: stored=70 recomputed=70 espn=NA lineup=MATCH',
        jsonFence([
            { check: 'stat_receiving_yards', bugClassRef: 'LLM', severity: 'WARN', entity: { type: 'player', id: '333', name: 'No Evidence' }, explanation: 'ESPN says 61, internal 58' },
            { check: 'stat_receiving_yards', bugClassRef: 'LLM', severity: 'INFO', entity: { type: 'player', id: '444', name: 'Cosmetic Guy', owner: 'Joe' }, internal: { receiving_yards: 48 }, espn: { receiving_yards: 49 }, explanation: 'COSMETIC: 48 vs 49, no tier crossed', evidence: ['teams/team-3-Joe.md#p-444'] }
        ])
    ].join('\n'));

    // game: VERDICT lines + a finding that duplicates the script's B3 finding (same key).
    fs.writeFileSync(path.join(ws, 'agents/game-20260910_DAL@PHI.md'), [
        '# game audit', '',
        'VERDICT: play-1 AGREE OFF_PASS — Hurts to Brown, same possession',
        'VERDICT: play-2 DISAGREE RETURN_20_PUNT — punt return TD by 111, DB credits nobody',
        'VERDICT: play-3 NEEDS-RULING AMBIGUOUS — lateral on kickoff return', '',
        jsonFence([{
            check: 'td_return_credit', bugClassRef: 'B3', severity: 'FAIL', flipsResult: false,
            entity: { type: 'player', id: '111', name: 'Fast Returner', nflTeam: 'PHI', owner: 'Pete' },
            internal: { punt_return_tds: 0 }, expected: { punt_return_tds: 1 },
            explanation: 'Gamebook prose confirms the punt return TD; player is rostered so this is FAIL.',
            confidence: 'certain', evidence: ['games/game-20260910_DAL@PHI.md#play-2']
        }])
    ].join('\n'));

    // league: CHECK lines + a DISAGREE dispute of the script's A1 finding.
    fs.writeFileSync(path.join(ws, 'agents/league.md'), [
        '# league audit', '',
        'CHECK A1: DISAGREE — stored 90 equals the lineup sum in league.md; the 84.5 is a stale value',
        'CHECK A2: AGREE — all 12 lineups match',
        'CHECK B3: AGREE — one uncredited return TD', '',
        jsonFence([{
            check: 'matchup_total_vs_lineup_sum', bugClassRef: 'A1', severity: 'INFO',
            entity: { type: 'matchup', id: '3' }, disputes: 'A1-2026-1-matchup-3',
            explanation: 'DISAGREE: league.md#matchup-3 shows the lineup sum is 90, matching the stored total.',
            evidence: ['league.md#matchup-3']
        }])
    ].join('\n'));

    return { root, ws, statusDir, manifest, checks };
}

describe('doublecheck-finalize', () => {
    let fx;
    beforeAll(() => { fx = buildWorkspace(); });
    afterAll(() => { fs.rmSync(fx.root, { recursive: true, force: true }); });

    describe('extraction', () => {
        it('takes the LAST fenced json block', () => {
            const md = 'x\n```json\n{"a":1}\n```\ntext\n```json\n[{"b":2}]\n```\n';
            const r = extractJsonBlock(md);
            expect(r.found).toBe(true);
            expect(r.value).toEqual([{ b: 2 }]);
        });
        it('reports no block and unparseable blocks', () => {
            expect(extractJsonBlock('no fence here').found).toBe(false);
            const bad = extractJsonBlock('```json\n[oops\n```');
            expect(bad.found).toBe(true);
            expect(bad.value).toBeNull();
            expect(bad.error).toMatch(/unparseable/);
        });
        it('parses TOTAL, VERDICT and CHECK lines', () => {
            expect(parseTotalLine('TOTAL: stored=84.5 recomputed=84.5 espn=NA lineup=DIFF'))
                .toEqual({ stored: 84.5, recomputed: 84.5, espn: null, lineup: 'DIFF' });
            expect(parseTotalLine('TOTAL: stored=x')).toBeNull();
            const v = parseVerdictLines('VERDICT: play-2 DISAGREE RETURN_20_PUNT — punt return\nVERDICT: play-3 NEEDS-RULING AMBIGUOUS - lateral');
            expect(v).toEqual([
                { play: 2, verdict: 'DISAGREE', awardClass: 'RETURN_20_PUNT', note: 'punt return' },
                { play: 3, verdict: 'NEEDS-RULING', awardClass: 'AMBIGUOUS', note: 'lateral' }
            ]);
            expect(parseCheckLines('CHECK A1: DISAGREE — nope\nCHECK F3/F4: AGREE — ok'))
                .toEqual({ A1: { verdict: 'DISAGREE', note: 'nope' }, 'F3/F4': { verdict: 'AGREE', note: 'ok' } });
        });
    });

    describe('validateFinding', () => {
        const files = new Set(['league.md', 'teams/team-1-Pete.md']);
        const good = { check: 'c', bugClassRef: 'A1', severity: 'WARN', entity: { type: 'team', id: 1 }, explanation: 'e', evidence: ['league.md#x'] };

        it('accepts a valid finding, fills defaults and generates an id', () => {
            const r = validateFinding(good, files, { season: 2026, week: 1, defaultSource: 'llm:team-1' });
            expect(r.ok).toBe(true);
            expect(r.finding.id).toBe('A1-2026-1-team-1-1');
            expect(r.finding.source).toBe('llm:team-1');
            expect(r.finding.confidence).toBe('likely');
            expect(r.finding.flipsResult).toBe(false);
        });
        it('rejects missing evidence, unknown evidence files, bad severity, bad entity type', () => {
            expect(validateFinding({ ...good, evidence: [] }, files).ok).toBe(false);
            expect(validateFinding({ ...good, evidence: ['nope.md#a'] }, files).errors[0]).toMatch(/not found in workspace/);
            expect(validateFinding({ ...good, severity: 'ERROR' }, files).ok).toBe(false);
            expect(validateFinding({ ...good, entity: { type: 'owner' } }, files).ok).toBe(false);
            expect(validateFinding({ ...good, explanation: '' }, files).ok).toBe(false);
            expect(validateFinding('nope', files).ok).toBe(false);
        });
    });

    describe('mergeFindings', () => {
        const mk = (o) => ({ id: o.id || 'x', check: 'c', bugClassRef: 'B3', severity: 'WARN', flipsResult: false,
            entity: { type: 'player', id: '1' }, explanation: 'e', source: 'script', confidence: 'likely', evidence: ['a.md'], ...o });

        it('dedupes script+llm on the same key with both sources and max severity', () => {
            const out = mergeFindings([mk({})], [mk({ source: 'llm:game-1', severity: 'FAIL', evidence: ['b.md'] })]);
            expect(out).toHaveLength(1);
            expect(out[0].sources).toEqual(['script', 'llm:game-1']);
            expect(out[0].severity).toBe('FAIL');
            expect(out[0].confidence).toBe('needs-ruling');
            expect(out[0].evidence).toEqual(['a.md', 'b.md']);
        });
        it('tags LLM-only FAIL/WARN on a PASS checklist class as llm-only needs-ruling', () => {
            const out = mergeFindings([], [mk({ source: 'llm:team-1', bugClassRef: 'A2', severity: 'FAIL' })],
                [{ id: 'A2', status: 'PASS' }]);
            expect(out[0].disagreement).toBe('llm-only');
            expect(out[0].confidence).toBe('needs-ruling');
            const notPass = mergeFindings([], [mk({ source: 'llm:team-1', bugClassRef: 'A2', severity: 'FAIL' })], [{ id: 'A2', status: 'WARN' }]);
            expect(notPass[0].disagreement).toBeUndefined();
        });
        it('keeps both sides of a DISAGREE: dispute and tags them', () => {
            const out = mergeFindings([mk({ id: 'S1', severity: 'FAIL' })],
                [mk({ source: 'llm:league', severity: 'INFO', explanation: 'DISAGREE: not so' })]);
            expect(out).toHaveLength(2);
            const script = out.find(f => f.id === 'S1');
            const llm = out.find(f => f.id !== 'S1');
            expect(script.severity).toBe('FAIL');
            expect(script.disagreement).toBe('llm-disputes-script');
            expect(script.confidence).toBe('needs-ruling');
            expect(llm.disagreement).toBe('llm-disputes-script');
            expect(llm.disputes).toBe('S1');
        });
    });

    describe('rollUp', () => {
        const f = sev => ({ severity: sev, flipsResult: sev === 'FAIL' });
        const done = [{ id: 'u', status: 'done' }];
        it('FAIL > INCOMPLETE > WARN > PASS', () => {
            expect(rollUp([f('FAIL'), f('WARN'), f('DEFER')], done).overallStatus).toBe('FAIL');
            expect(rollUp([f('WARN'), f('DEFER')], done).overallStatus).toBe('INCOMPLETE');
            expect(rollUp([f('WARN')], done).overallStatus).toBe('WARN');
            expect(rollUp([f('DEFER'), f('INFO')], done).overallStatus).toBe('INCOMPLETE');
            expect(rollUp([f('INFO')], done).overallStatus).toBe('PASS');
            expect(rollUp([], done).overallStatus).toBe('PASS');
            expect(rollUp([f('FAIL')], done).counts).toEqual({ FAIL: 1, WARN: 0, INFO: 0, DEFER: 0, flips: 1 });
        });
        it('a missing unit forbids PASS', () => {
            const r = rollUp([], [{ id: 'a', status: 'done' }, { id: 'b', status: 'missing' }]);
            expect(r.overallStatus).toBe('INCOMPLETE');
            expect(r.missing).toEqual(['b']);
            expect(rollUp([f('WARN')], [{ id: 'b', status: 'missing' }]).overallStatus).toBe('INCOMPLETE');
        });
    });

    describe('end to end over the synthetic workspace', () => {
        let ctx;
        beforeAll(() => {
            // --with-units: the retired LLM unit path, kept for the merge logic
            ctx = finalizeWorkspace({ season: SEASON, week: WEEK, workspace: fx.ws, trigger: 'manual', generatedAt: '2026-09-13T12:00:00.000Z', scriptOnly: false, rulingsFile: path.join(fx.statusDir, 'rulings.json') });
        });

        it('counts units, rejects the evidence-less finding, merges and rolls up FAIL', () => {
            expect(ctx.units.map(u => [u.id, u.status])).toEqual([
                ['team-1', 'done'], ['team-2', 'missing'], ['team-3', 'done'], ['game-20260910_DAL@PHI', 'done'], ['league', 'done']
            ]);
            expect(ctx.units[1].reason).toBe('output file missing');
            expect(ctx.rejected).toHaveLength(1);
            expect(ctx.rejected[0].unit).toBe('team-3');
            expect(ctx.rejected[0].errors[0]).toMatch(/evidence/);

            const b3 = ctx.findings.find(f => f.bugClassRef === 'B3');
            expect(b3.sources).toEqual(['script', 'llm:game-20260910_DAL@PHI']);
            expect(b3.severity).toBe('FAIL');

            const a2 = ctx.findings.find(f => f.bugClassRef === 'A2');
            expect(a2.disagreement).toBe('llm-only');
            expect(a2.source).toBe('llm:team-1');

            const a1 = ctx.findings.filter(f => f.bugClassRef === 'A1');
            expect(a1).toHaveLength(2);
            expect(a1.every(f => f.disagreement === 'llm-disputes-script')).toBe(true);

            expect(ctx.roll.overallStatus).toBe('FAIL');
            expect(ctx.roll.counts).toEqual({ FAIL: 3, WARN: 0, INFO: 3, DEFER: 0, flips: 1 });
            expect(ctx.roll.missing).toEqual(['team-2']);
        });

        it('renders every report section in order with the parsed tables', () => {
            const report = renderReport(ctx);
            const order = ['## Summary', '## Result-flipping findings', '## FAIL', '## WARN', '## Deferred',
                '## Per-team audit table', '## TD ledger', '## Stat discrepancies', '## Bug-class checklist',
                '## What to fix', '## Rejected findings', '## Coverage & run info'];
            let last = -1;
            for (const h of order) {
                const i = report.indexOf(h);
                expect(i).toBeGreaterThan(last);
                last = i;
            }
            expect(report).toContain('| team-1 | Pete | 84.5 | 84.5 | 86.5 | DIFF | done |');
            expect(report).toContain('| team-2 | Mitch | | | | | missing (output file missing) |');
            expect(report).toContain('| 20260910_DAL@PHI | play-3 | NEEDS-RULING | AMBIGUOUS | lateral on kickoff return |');
            expect(report).toContain('| A1 | matchup totals | FAIL | DISAGREE |');
            expect(report).toContain('| A3 | rubric drift | PASS | — |');
            expect(report).toContain('Cosmetic Guy');
            expect(report).toContain('No Evidence');
            expect(report).toContain('fix logic, then recalc — never edit the DB');
            expect(report).toContain('- fix scoringPlayParserService return detection then recalc');
            expect(report).toContain('F3/F4');
        });

        it('builds latest.json in the documented shape and the email', () => {
            const latest = buildLatest(ctx);
            expect(Object.keys(latest)).toEqual(expect.arrayContaining([
                'schemaVersion', 'runAt', 'trigger', 'season', 'week', 'dbPath', 'overallStatus', 'completeness',
                'counts', 'coverage', 'units', 'findings', 'reportFile', 'email'
            ]));
            expect(latest.completeness).toEqual({ gamesFinal: 1, gamesTotal: 2, espnGamesFetched: 1, standingsPresent: false, deferred: ['F3/F4'] });
            expect(latest.units).toEqual({ total: 5, done: 4, missing: ['team-2'] });
            expect(latest.findings.every(f => ['FAIL', 'WARN', 'DEFER'].includes(f.severity))).toBe(true);
            expect(latest.infoCount).toBe(3);
            expect(latest.coverage).toEqual(fx.manifest.coverage);

            const mail = buildEmail(latest, ctx.findings);
            expect(mail.subject).toBe('statfink2 double check FAIL — 2026 week 1 (1/2 final, 1 result flips)');
            expect(mail.body).toMatch(/RESULT FLIPS[\s\S]*FAIL[\s\S]*WARN: 0[\s\S]*Deferred: F3\/F4[\s\S]*Report:/);
            expect(mail.body).toContain('Fast Returner');
        });

        it('caps history at 52 rows and honours DOUBLECHECK_STATUS_DIR', () => {
            const prev = process.env.DOUBLECHECK_STATUS_DIR;
            process.env.DOUBLECHECK_STATUS_DIR = fx.statusDir;
            try {
                const historyFile = path.join(fx.statusDir, 'doublecheck-history.json');
                const filler = Array.from({ length: HISTORY_CAP }, (_, i) => ({ runAt: `old-${i}`, overallStatus: 'PASS' }));
                fs.writeFileSync(historyFile, JSON.stringify(filler));
                const latest = buildLatest(ctx);
                const { latestFile } = writeStatusFile(latest);
                expect(latestFile).toBe(path.join(fx.statusDir, 'doublecheck-latest.json'));
                const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
                expect(history).toHaveLength(HISTORY_CAP);
                expect(history[0].runAt).toBe('old-1');
                expect(history[HISTORY_CAP - 1]).toMatchObject({ runAt: latest.runAt, overallStatus: 'FAIL', season: SEASON, week: WEEK });
            } finally {
                if (prev === undefined) delete process.env.DOUBLECHECK_STATUS_DIR; else process.env.DOUBLECHECK_STATUS_DIR = prev;
            }
        });

        it('CLI writes findings.json + report.md, prints the summary and exits 1 on FAIL', () => {
            const res = spawnSync(process.execPath, [SCRIPT, String(SEASON), String(WEEK), '--workspace', fx.ws, '--trigger', 'calibration', '--with-units'], {
                encoding: 'utf8',
                env: { ...process.env, DOUBLECHECK_STATUS_DIR: fx.statusDir, DOUBLECHECK_RULINGS_FILE: path.join(fx.statusDir, 'rulings.json') }
            });
            expect(res.status).toBe(1);
            expect(res.stdout).toContain('Double check 2026 week 1: FAIL');
            expect(res.stdout).toContain('units 4/5 done; missing team-2');
            const findings = JSON.parse(fs.readFileSync(path.join(fx.ws, 'findings.json'), 'utf8'));
            expect(findings.overallStatus).toBe('FAIL');
            expect(findings.findings).toHaveLength(6);
            expect(findings.rejected).toHaveLength(1);
            expect(fs.existsSync(path.join(fx.ws, 'report.md'))).toBe(true);
            const latest = JSON.parse(fs.readFileSync(path.join(fx.statusDir, 'doublecheck-latest.json'), 'utf8'));
            expect(latest.trigger).toBe('calibration');
            expect(latest.email).toEqual({ sent: false, to: 'joe.paley@gmail.com', error: null });
            // status files went to DOUBLECHECK_STATUS_DIR, never into the repo's logs/
            expect(fs.existsSync(path.join(fx.statusDir, 'doublecheck-latest.json'))).toBe(true);
        });

        it('exits 2 when the workspace has no manifest', () => {
            const empty = fs.mkdtempSync(path.join(fx.root, 'empty-'));
            const res = spawnSync(process.execPath, [SCRIPT, '2026', '1', '--workspace', empty], {
                encoding: 'utf8', env: { ...process.env, DOUBLECHECK_STATUS_DIR: fx.statusDir }
            });
            expect(res.status).toBe(2);
            expect(res.stderr).toContain('doublecheck-data.js');
        });
    });
});

describe('doublecheck-finalize script-only (the default; --with-units restores the unit path)', () => {
    const { finalizeWorkspace } = require('../../scripts/doublecheck-finalize');
    const fs = require('fs'); const os = require('os'); const path = require('path');
    function ws(findings) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-script-only-'));
        fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 1, season: 2026, week: 1, games: [], gamesFinal: 16, gamesTotal: 16, allFinal: true, standingsPresent: true, espn: { ok: true }, units: [{ id: 'team-1', input: 'league.md', output: 'agents/team-1.md' }, { id: 'league', input: 'league.md', output: 'agents/league.md' }], deferred: [], files: { checks: 'checks.json' } }));
        fs.writeFileSync(path.join(root, 'league.md'), '# league');
        fs.writeFileSync(path.join(root, 'checks.json'), JSON.stringify({ findings, checklist: [{ id: 'A1', name: 'a', status: 'PASS', summary: '' }] }));
        return root;
    }
    const f = (severity) => ({ check: 'c', bugClassRef: 'A1', severity, entity: { type: 'team', id: '1' }, explanation: 'e', evidence: ['league.md'] });

    test('missing LLM units do not make a script-only run INCOMPLETE; status comes from the findings', () => {
        const root = ws([f('WARN')]);
        const ctx = finalizeWorkspace({ season: 2026, week: 1, workspace: root, trigger: 'daily', generatedAt: new Date().toISOString() });
        expect(ctx.units).toEqual([]);
        expect(ctx.roll.overallStatus).toBe('WARN');
        const clean = finalizeWorkspace({ season: 2026, week: 1, workspace: ws([]), trigger: 'daily', generatedAt: new Date().toISOString() });
        expect(clean.roll.overallStatus).toBe('PASS');
        const full = finalizeWorkspace({ season: 2026, week: 1, workspace: ws([]), trigger: 'manual', generatedAt: new Date().toISOString(), scriptOnly: false });
        expect(full.roll.overallStatus).toBe('INCOMPLETE');
    });
});

/* ------------------------------------------------------------------------- *
 * Rulings > resolutions applied to the findings (2026-09: the deterministic
 * pass raises questions; Claude Opus answers; the commissioner overrides).
 * ------------------------------------------------------------------------- */
describe('applyDecisions: rulings > resolutions', () => {
    const { applyDecisions, decideQuestion, creditsForClass, finalizeWorkspace, buildLatest, renderReport } = require('../../scripts/doublecheck-finalize');
    const fs = require('fs'); const os = require('os'); const path = require('path');

    const QID = '2026-wk01-20260913_ARI@HOU-play-3';
    const question = () => ({
        id: QID, season: 2026, week: 1, gameId: '20260913_ARI@HOU', playIdx: 3, kind: 'td_award_class',
        question: 'Who should be credited for this scoring play?',
        evidence: {
            tank01Text: 'C.J. Stroud Aborted Snap C.J. Stroud Fumble Woody Marks 1 Yd Fumble Recovery (Kick)', espnType: 'Fumble Return Touchdown',
            votes: { drive: 'takeaway', gamebook: 'same', text: null }, votesAgree: false, scoringTeam: 'HOU', defendingTeam: 'ARI', scriptAwardClass: 'AMBIGUOUS',
            players: [{ id: '4432577', name: 'C.J. Stroud', pos: 'QB', roles: ['fumbler'], draftable: true }, { id: '4429059', name: 'Woody Marks', pos: 'RB', roles: ['recoverer'], draftable: true }],
            dbCredit: { '4429059': { rushing_tds: 1 }, DEF_HOU: { def_fumble_return_tds: 0, def_int_return_tds: 0 }, DEF_ARI: { def_fumble_return_tds: 0 } }
        },
        options: ['DEF_8_INT', 'DEF_8_FUMBLE', 'DEF_8_BLOCKED', 'RETURN_20_KICK', 'RETURN_20_PUNT', 'OFF_PASS', 'OFF_RUSH', 'OFF_RECOVERY', 'SAFETY_2', 'NOT_A_SCORE'],
        relatedFindingIds: ['B4-1', 'T1-over']
    });
    const findings = () => [
        { id: 'B4-1', check: 'td_award_class', bugClassRef: 'B4', severity: 'WARN', flipsResult: false, entity: { type: 'play', id: '20260913_ARI@HOU#3', gameId: '20260913_ARI@HOU' }, internal: {}, espn: {}, expected: {}, explanation: 'Ambiguous scoring play needs adjudication: votes disagree', source: 'script', sources: ['script'], confidence: 'needs-ruling', suggestedFix: '', evidence: ['games/game-20260913_ARI@HOU.md#play-3'] },
        { id: 'T1-over', check: 'td_over_credit', bugClassRef: 'T1', severity: 'WARN', flipsResult: false, entity: { type: 'player', id: '4429059', name: 'Woody Marks', gameId: '20260913_ARI@HOU', owner: 'Pete' }, internal: { rushing_tds: 1 }, espn: {}, expected: { rushing_tds: 0 }, explanation: 'Woody Marks is credited with rushing_tds=1 but the scoring plays support only 0: may be explained by ambiguous play(s) 3.', source: 'script', sources: ['script'], confidence: 'needs-ruling', suggestedFix: '', evidence: ['games/game-20260913_ARI@HOU.md#play-3'] },
        { id: 'A1-x', check: 'c', bugClassRef: 'A1', severity: 'FAIL', flipsResult: false, entity: { type: 'matchup', id: '3' }, internal: {}, espn: {}, expected: {}, explanation: 'unrelated', source: 'script', sources: ['script'], confidence: 'certain', suggestedFix: '', evidence: ['league.md'] }
    ];
    const res = (over = {}) => ({ questionId: QID, awardClass: 'OFF_RECOVERY', credits: [{ player_id: '4429059', column: 'rushing_tds', delta: 1 }], confidence: 'certain', reasoning: 'own aborted snap', model: 'opus', ts: '2026-09-14T06:05:00Z', ...over });

    it('a confident verdict whose credits are in the DB resolves the related findings to INFO', () => {
        const out = applyDecisions(findings(), [question()], { [QID]: res() }, {});
        const b4 = out.findings.find(f => f.id === 'B4-1'), over = out.findings.find(f => f.id === 'T1-over'), a1 = out.findings.find(f => f.id === 'A1-x');
        expect(b4.severity).toBe('INFO');
        expect(b4.explanation).toMatch(/^resolved by opus: OFF_RECOVERY — own aborted snap\. Ambiguous/);
        expect(b4.resolution).toEqual(res());
        expect(b4.ruling).toBeNull();
        expect(b4.decidedBy).toBe('opus');
        expect(over.severity).toBe('INFO'); // the over-credit is explained by the decided class
        expect(over.explanation).toMatch(/^resolved by opus: play 3 ruled OFF_RECOVERY/);
        expect(a1.severity).toBe('FAIL'); // untouched
        expect(out.questions).toEqual([expect.objectContaining({ id: QID, gameId: '20260913_ARI@HOU', playIdx: 3, status: 'resolved', creditsMissing: [], resolution: res(), ruling: null })]);
        expect(out.questions[0].decision).toMatchObject({ source: 'opus', awardClass: 'OFF_RECOVERY', confidence: 'certain' });
    });

    it('a confident verdict whose credits are NOT in the DB confirms a miscredit: FAIL, prefixed CONFIRMED by opus', () => {
        const verdict = res({ awardClass: 'DEF_8_FUMBLE', credits: [{ player_id: 'DEF_HOU', column: 'def_fumble_return_tds', delta: 1 }], reasoning: 'takeaway' });
        const out = applyDecisions(findings(), [question()], { [QID]: verdict }, {});
        const b4 = out.findings.find(f => f.id === 'B4-1'), over = out.findings.find(f => f.id === 'T1-over');
        expect(b4.severity).toBe('FAIL');
        expect(b4.confidence).toBe('likely');
        expect(b4.explanation).toMatch(/^CONFIRMED by opus: DEF_8_FUMBLE — takeaway; credits missing from the DB: DEF_HOU\.def_fumble_return_tds\+1\. Ambiguous/);
        expect(over.severity).toBe('FAIL'); // Marks' rushing TD is not explained by a defensive award
        expect(over.explanation).toMatch(/^CONFIRMED by opus/);
        expect(out.questions[0]).toMatchObject({ status: 'resolved', creditsMissing: [{ player_id: 'DEF_HOU', column: 'def_fumble_return_tds', delta: 1 }] });
    });

    it('a ruling beats the verdict, carries certainty, and derives credits from the players on the play', () => {
        const verdict = res({ awardClass: 'DEF_8_FUMBLE', credits: [{ player_id: 'DEF_HOU', column: 'def_fumble_return_tds', delta: 1 }] });
        const ruling = { questionId: QID, awardClass: 'OFF_RECOVERY', note: 'Marks recovered the aborted snap on his own drive', by: 'admin', ts: '2026-09-14T15:00:00Z' };
        const out = applyDecisions(findings(), [question()], { [QID]: verdict }, { [QID]: ruling });
        const b4 = out.findings.find(f => f.id === 'B4-1');
        expect(b4.severity).toBe('INFO');
        expect(b4.confidence).toBe('certain');
        expect(b4.explanation).toMatch(/^resolved by ruling \(admin\): OFF_RECOVERY — Marks recovered/);
        expect(b4.ruling).toEqual(ruling);
        expect(b4.resolution).toEqual(verdict);
        expect(out.questions[0]).toMatchObject({ status: 'ruled', decision: { source: 'ruling', by: 'admin', awardClass: 'OFF_RECOVERY', credits: [{ player_id: '4429059', column: 'rushing_tds', delta: 1 }] } });
        // and the other way round: a ruling that confirms the defensive award while the DB paid the player
        const out2 = applyDecisions(findings(), [question()], { [QID]: res() }, { [QID]: { ...ruling, awardClass: 'DEF_8_FUMBLE', note: 'it was a takeaway' } });
        const b42 = out2.findings.find(f => f.id === 'B4-1');
        expect(b42.severity).toBe('FAIL');
        expect(b42.confidence).toBe('certain');
        expect(b42.explanation).toMatch(/^CONFIRMED by ruling \(admin\): DEF_8_FUMBLE — it was a takeaway; credits missing from the DB: DEF_HOU\.def_fumble_return_tds\+1/);
        expect(out2.findings.find(f => f.id === 'T1-over').severity).toBe('FAIL');
    });

    it('an unsure verdict (or none) keeps the findings WARN "needs your ruling" and the question open', () => {
        const out = applyDecisions(findings(), [question()], { [QID]: res({ confidence: 'unsure', awardClass: 'DEF_8_FUMBLE', credits: [] }) }, {});
        const b4 = out.findings.find(f => f.id === 'B4-1'), over = out.findings.find(f => f.id === 'T1-over');
        expect(b4.severity).toBe('WARN');
        expect(b4.needsRuling).toBe(true);
        expect(b4.confidence).toBe('needs-ruling');
        expect(b4.explanation).toMatch(/^NEEDS YOUR RULING \(opus unsure: DEF_8_FUMBLE\): Ambiguous/);
        expect(over.severity).toBe('WARN');
        expect(out.questions[0].status).toBe('open');
        const none = applyDecisions(findings(), [question()], {}, {});
        expect(none.findings.find(f => f.id === 'B4-1')).toMatchObject({ severity: 'WARN', needsRuling: true });
        expect(none.findings.find(f => f.id === 'B4-1').explanation).toMatch(/^NEEDS YOUR RULING: /);
        expect(none.questions[0]).toMatchObject({ status: 'open', resolution: null, ruling: null, decision: null });
    });

    it('decideQuestion / creditsForClass derive defensive, return and offensive credits from a bare ruling', () => {
        const q = question();
        expect(decideQuestion(q, null, null)).toBeNull();
        expect(decideQuestion(q, null, { awardClass: 'DEF_8_INT', by: 'admin' }).credits).toEqual([{ player_id: 'DEF_HOU', column: 'def_int_return_tds', delta: 1 }]);
        expect(creditsForClass('SAFETY_2', q)).toEqual([{ player_id: 'DEF_HOU', column: 'safeties', delta: 1 }]);
        expect(creditsForClass('NOT_A_SCORE', q)).toEqual([]);
        expect(creditsForClass('OFF_RUSH', q)).toEqual([{ player_id: '4432577', column: 'rushing_tds', delta: 1 }]); // no rusher role: first non-kicker
        expect(creditsForClass('OFF_RECOVERY', q)).toEqual([{ player_id: '4429059', column: 'rushing_tds', delta: 1 }]);
        expect(creditsForClass('OFF_PASS', q)).toEqual([{ player_id: '4432577', column: 'passing_tds', delta: 1 }, { player_id: '4429059', column: 'receiving_tds', delta: 1 }]);
        const cb = { evidence: { scoringTeam: 'NE', players: [{ id: '4241720', name: 'Marcus Jones', pos: 'CB', roles: ['returner'], draftable: false }] } };
        expect(creditsForClass('RETURN_20_PUNT', cb)).toEqual([]); // non-draftable returner: nobody
        expect(creditsForClass('RETURN_20_KICK', { evidence: { scoringTeam: 'NE', players: [{ id: '1', roles: ['returner'], draftable: true }] } })).toEqual([{ player_id: '1', column: 'kick_return_tds', delta: 1 }]);
        expect(creditsForClass('RETURN_20_KICK', { evidence: { scoringTeam: 'NE', players: [] } })).toBeNull();
        // a resolution with credits for the same class is reused
        const verdict = res();
        expect(creditsForClass('OFF_RECOVERY', q, verdict)).toBe(verdict.credits);
        expect(creditsForClass('OFF_RUSH', q, verdict)).toEqual([{ player_id: '4432577', column: 'rushing_tds', delta: 1 }]); // different class: derived, not reused
    });

    it('finalizeWorkspace reads questions/resolutions/rulings, and latest.json + report.md carry them', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-decisions-'));
        fs.mkdirSync(path.join(root, 'games'));
        fs.writeFileSync(path.join(root, 'games/game-20260913_ARI@HOU.md'), '# game');
        fs.writeFileSync(path.join(root, 'league.md'), '# league');
        const defensiveScores = [{ gameId: '20260913_ARI@HOU', playIdx: 3, kind: 'TD', scoringTeam: 'HOU', awardClass: 'AMBIGUOUS', votes: { drive: 'takeaway', gamebook: 'same', text: null }, votesAgree: false, creditedTo: [{ player_id: '4429059', column: 'rushing_tds' }], agreement: null, questionId: QID }];
        const scoreCheck = { checked: 1, mismatches: [], games: [{ gameId: '20260913_ARI@HOU', final: true, tank01: { home: 40, away: 20, ok: true }, espn: { home: 40, away: 20, ok: true } }] };
        fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 1, season: 2026, week: 1, games: [{ game_id: '20260913_ARI@HOU', final: true, espnFetched: true }], gamesFinal: 1, gamesTotal: 1, allFinal: true, standingsPresent: true, espn: { ok: true }, deferred: [], files: { checks: 'checks.json' }, questionCount: 1, defensiveScores, scoreCheck }));
        fs.writeFileSync(path.join(root, 'checks.json'), JSON.stringify({ findings: findings().slice(0, 2), checklist: [{ id: 'B4', name: 'b4', status: 'WARN', summary: '' }], defensiveScores }));
        fs.writeFileSync(path.join(root, 'questions.json'), JSON.stringify({ generatedAt: 'x', season: 2026, week: 1, questions: [question()] }));
        fs.writeFileSync(path.join(root, 'resolutions.json'), JSON.stringify({ generatedAt: 'x', resolutions: { [QID]: res() } }));
        const rulingsFile = path.join(root, 'rulings.json');

        const ctx = finalizeWorkspace({ season: 2026, week: 1, workspace: root, trigger: 'reconcile', generatedAt: new Date().toISOString(), rulingsFile });
        expect(ctx.roll.overallStatus).toBe('PASS');
        expect(ctx.questions[0].status).toBe('resolved');
        expect(ctx.defensiveScores[0]).toMatchObject({ questionStatus: 'resolved', decided: { awardClass: 'OFF_RECOVERY', source: 'opus' } });
        const latest = buildLatest(ctx);
        expect(latest.questions).toHaveLength(1);
        expect(latest.questions[0]).toMatchObject({ id: QID, gameId: '20260913_ARI@HOU', playIdx: 3, status: 'resolved' });
        expect(latest.defensiveScores).toHaveLength(1);
        expect(latest.scoreCheck).toEqual(scoreCheck);
        const report = renderReport(ctx);
        expect(report).toContain('## Rulings & questions');
        expect(report).toContain('## Defensive scores');
        expect(report).toContain('| `' + QID + '` | 20260913_ARI@HOU play 3 |');
        expect(report).toContain('OFF_RECOVERY (certain, opus)');
        expect(report).toContain('AMBIGUOUS → OFF_RECOVERY');

        // a ruling on disk overrides the verdict and the finding turns FAIL
        fs.writeFileSync(rulingsFile, JSON.stringify({ [QID]: { questionId: QID, awardClass: 'DEF_8_FUMBLE', note: 'takeaway', by: 'admin', ts: 'y' } }));
        const ruled = finalizeWorkspace({ season: 2026, week: 1, workspace: root, trigger: 'ruling', generatedAt: new Date().toISOString(), rulingsFile });
        expect(ruled.roll.overallStatus).toBe('FAIL');
        expect(ruled.questions[0].status).toBe('ruled');
        expect(ruled.findings.find(f => f.id === 'B4-1').explanation).toMatch(/^CONFIRMED by ruling/);
        expect(renderReport(ruled)).toContain('DEF_8_FUMBLE (admin)');
        fs.rmSync(root, { recursive: true, force: true });
    });
});
