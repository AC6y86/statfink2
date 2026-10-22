/**
 * scripts/doublecheck-reconcile.js — prompt construction, verdict validation,
 * and the reconcile loop with an injected fake `claude -p` runner. No network,
 * no DB, never spawns the real CLI.
 */
const path = require('path');
const {
    buildPrompt, validateResolution, reconcileQuestions, extractJson, rulingsMap, resolutionsMap, parseArgs
} = require('../../scripts/doublecheck-reconcile');
const { QUESTION_OPTIONS } = require('../../scripts/lib/tdDossier');

const RULE = '#### Defensive Touchdowns — Exact Award Logic\n\nThe Team Defense **IS** awarded 8 points when ...';
const OPTIONS = '| answer | award class |\n|---|---|\n| takeaway | DEF_8_FUMBLE |';

function question(over = {}) {
    return {
        id: '2026-wk01-20260913_ARI@HOU-play-3', season: 2026, week: 1, gameId: '20260913_ARI@HOU', playIdx: 3, kind: 'td_award_class',
        question: 'Who should be credited for this scoring play?',
        evidence: {
            tank01Text: 'C.J. Stroud Aborted Snap C.J. Stroud Fumble Woody Marks 1 Yd Fumble Recovery (Kick)',
            espnType: 'Fumble Return Touchdown', espnText: 'Woody Marks 1 Yd Fumble Recovery',
            drive: { team: 'HOU', result: 'FUMBLE RETURN TD', isTurnover: true, startTeam: 'HOU', endTeam: 'HOU' },
            gamebook: 'C.Stroud FUMBLES (Aborted) at ARZ 2, recovered by HST-W.Marks at ARZ 7. W.Marks for 7 yards, TOUCHDOWN.',
            votes: { drive: 'takeaway', gamebook: 'same', text: null }, votesAgree: false,
            scoringTeam: 'HOU', defendingTeam: 'ARI',
            players: [{ id: '4432577', name: 'C.J. Stroud', pos: 'QB', roles: ['fumbler'], draftable: true }, { id: '4429059', name: 'Woody Marks', pos: 'RB', roles: ['recoverer'], draftable: true }],
            dbCredit: { '4429059': { rushing_tds: 1 }, DEF_HOU: { def_fumble_return_tds: 0 } },
            rule: RULE
        },
        options: [...QUESTION_OPTIONS], relatedFindingIds: ['B4-2026-1-play-x-1'],
        ...over
    };
}

const good = (over = {}) => ({
    questionId: question().id, awardClass: 'OFF_RECOVERY',
    credits: [{ player_id: '4429059', column: 'rushing_tds', delta: 1 }],
    confidence: 'certain', reasoning: 'Aborted snap recovered by the offense on its own drive; lower-case "recovered by" = no change of possession.',
    ...over
});

describe('buildPrompt', () => {
    test('includes the rule text verbatim, the options table, the evidence bundle, the schema and the question id', () => {
        const q = question();
        const p = buildPrompt(q, { rule: RULE, options: OPTIONS, season: 2026, week: 1 });
        expect(p).toContain(RULE);
        expect(p).toContain(OPTIONS);
        expect(p).toContain(q.id);
        expect(p).toContain('"tank01Text": "C.J. Stroud Aborted Snap');
        expect(p).toContain('recovered by HST-W.Marks');
        expect(p).toContain('"votes": {');
        expect(p).toContain('"required": [');
        expect(p).toMatch(/"enum": \[\s*"DEF_8_INT",/);
        expect(p).toContain('Respond with the JSON object only.');
        expect(p).toMatch(/HST=HOU/);
    });

    test('defaults to the real docs: SCORING_SYSTEM.md rule section and the DOUBLECHECK.md award-class table', () => {
        const p = buildPrompt(question());
        expect(p).toContain('#### Defensive Touchdowns — Exact Award Logic');
        expect(p).toContain('did the ball change possession on the play');
        expect(p).toMatch(/\| .*DEF_8_INT/);
    });

    test('the kick-recovery clarification reaches the model from both the rule text and the instructions (2025 wk2 Holani kickoff: Qwen said OFF_RECOVERY until this was spelled out)', () => {
        const p = buildPrompt(question());
        expect(p).toMatch(/muffed kickoff, or returner's fumble recovered by the kicking \(coverage\) team/);
        expect(p).toMatch(/kicking team is the coverage unit, not the offense/);
        expect(p).toMatch(/never OFF_RECOVERY/);
        expect(p).toMatch(/reasoning: at most three short sentences/);
        // 2025 wk9 blocked punt: with brief reasoning Qwen credited the punting team's defense until the evidence named the credited defense outright
        expect(p).toMatch(/always go to evidence.teamDefenseId/);
    });
});

describe('validateResolution', () => {
    test('accepts a valid verdict', () => {
        expect(validateResolution(good(), question())).toEqual([]);
        expect(validateResolution(good({ awardClass: 'DEF_8_FUMBLE', credits: [{ player_id: 'DEF_HOU', column: 'def_fumble_return_tds', delta: 1 }], confidence: 'likely' }), question())).toEqual([]);
        expect(validateResolution(good({ awardClass: 'NOT_A_SCORE', credits: [] }), question())).toEqual([]);
        expect(validateResolution(good({ awardClass: 'RETURN_20_PUNT', credits: [] }), question())).toEqual([]);
    });

    test('rejects a bad awardClass, a foreign questionId, missing fields and bad credits', () => {
        expect(validateResolution(good({ awardClass: 'AMBIGUOUS' }), question())[0]).toMatch(/awardClass must be one of/);
        expect(validateResolution(good({ awardClass: 'OFF_RUSH_TD' }), question())[0]).toMatch(/awardClass/);
        expect(validateResolution(good({ questionId: 'other' }), question())[0]).toMatch(/questionId must be/);
        expect(validateResolution(good({ confidence: 'high' }), question())).toEqual([expect.stringMatching(/confidence/)]);
        expect(validateResolution(good({ reasoning: '' }), question())).toEqual([expect.stringMatching(/reasoning/)]);
        expect(validateResolution(good({ credits: 'none' }), question())).toEqual([expect.stringMatching(/credits must be an array/)]);
        expect(validateResolution(good({ credits: [{ player_id: 4429059, column: 'rushing_tds', delta: 1 }] }), question())[0]).toMatch(/player_id/);
        expect(validateResolution(good({ credits: [{ player_id: '4429059', column: 'rushing_yards', delta: 1 }] }), question())[0]).toMatch(/column/);
        expect(validateResolution(good({ credits: [{ player_id: '4429059', column: 'rushing_tds', delta: 1.5 }] }), question())[0]).toMatch(/delta/);
        expect(validateResolution(null, question())).toEqual(['result is not a JSON object']);
        expect(validateResolution([], question())).toEqual(['result is not a JSON object']);
    });

    test('rejects credits that contradict the award class', () => {
        expect(validateResolution(good({ awardClass: 'DEF_8_FUMBLE' }), question())).toEqual([
            expect.stringMatching(/DEF_8_FUMBLE must credit DEF_HOU\.def_fumble_return_tds/),
            expect.stringMatching(/credits no individual player/)
        ]);
        expect(validateResolution(good({ awardClass: 'NOT_A_SCORE' }), question())).toEqual([expect.stringMatching(/NOT_A_SCORE must have no credits/)]);
        expect(validateResolution(good({ awardClass: 'OFF_PASS' }), question())).toEqual([expect.stringMatching(/OFF_PASS must credit passing_tds and receiving_tds/)]);
        expect(validateResolution(good({ awardClass: 'RETURN_20_KICK', credits: [{ player_id: 'DEF_HOU', column: 'kick_return_tds', delta: 1 }] }), question())).toEqual([expect.stringMatching(/credits no team defense/)]);
        expect(validateResolution(good({ credits: [{ player_id: '4429059', column: 'rushing_tds', delta: 1 }, { player_id: 'DEF_HOU', column: 'def_fumble_return_tds', delta: 1 }] }), question())).toEqual([expect.stringMatching(/OFF_RECOVERY credits no team defense/)]);
    });

    test('extractJson tolerates fences and prose around the object', () => {
        expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
        expect(extractJson('Here you go: {"a":1} — done')).toEqual({ a: 1 });
        expect(() => extractJson('nope')).toThrow();
    });
});

describe('reconcileQuestions', () => {
    const logs = [];
    const log = m => logs.push(m);
    beforeEach(() => { logs.length = 0; });

    test('a valid verdict is stored as a resolution with model and ts', async () => {
        const calls = [];
        const runClaude = async (prompt, opts) => { calls.push({ prompt, opts }); return JSON.stringify(good()); };
        const resolutions = {};
        const r = await reconcileQuestions({ questions: [question()], resolutions, rulings: {}, runClaude, model: 'opus', log, rule: RULE, options: OPTIONS });
        expect(calls).toHaveLength(1);
        expect(calls[0].opts).toEqual({ model: 'opus' });
        expect(calls[0].prompt).toContain(RULE);
        expect(r.resolved).toEqual([{ id: question().id, awardClass: 'OFF_RECOVERY', confidence: 'certain' }]);
        expect(r.failed).toEqual([]);
        expect(resolutions[question().id]).toMatchObject({ questionId: question().id, awardClass: 'OFF_RECOVERY', credits: good().credits, confidence: 'certain', model: 'opus' });
        expect(typeof resolutions[question().id].ts).toBe('string');
        expect(r.resolutions).toBe(resolutions);
    });

    test('an invalid answer is retried once with a reminder; the valid retry wins', async () => {
        const prompts = [];
        let n = 0;
        const runClaude = async (prompt) => { prompts.push(prompt); n++; return n === 1 ? '```json\n{"awardClass":"DEF_8_FUMBLE"}\n```' : JSON.stringify(good({ confidence: 'likely' })); };
        const resolutions = {};
        const r = await reconcileQuestions({ questions: [question()], resolutions, rulings: {}, runClaude, log, rule: RULE, options: OPTIONS });
        expect(prompts).toHaveLength(2);
        expect(prompts[1]).toMatch(/REMINDER: your previous output was not valid/);
        expect(prompts[1]).toMatch(/questionId must be/);
        expect(r.resolved[0]).toMatchObject({ awardClass: 'OFF_RECOVERY', confidence: 'likely' });
        expect(logs.some(l => /attempt 1 rejected/.test(l))).toBe(true);
    });

    test('two bad answers (or a runner error) leave the question failed, without a resolution', async () => {
        const runClaude = async () => 'not json at all';
        const resolutions = {};
        const r = await reconcileQuestions({ questions: [question()], resolutions, rulings: {}, runClaude, log, rule: RULE, options: OPTIONS });
        expect(r.failed).toEqual([{ id: question().id, error: expect.stringMatching(/not JSON/) }]);
        expect(resolutions).toEqual({});
        const boom = async () => { throw new Error('claude -p timed out after 120000ms'); };
        const r2 = await reconcileQuestions({ questions: [question()], resolutions, rulings: {}, runClaude: boom, log, rule: RULE, options: OPTIONS });
        expect(r2.failed[0].error).toMatch(/timed out/);
    });

    test('a ruling suppresses the call; an existing resolution is skipped unless --redo', async () => {
        let calls = 0;
        const runClaude = async () => { calls++; return JSON.stringify(good()); };
        const q = question();
        const rulings = { [q.id]: { questionId: q.id, awardClass: 'OFF_RECOVERY', note: 'commissioner', by: 'admin', ts: 'x' } };
        const r = await reconcileQuestions({ questions: [q], resolutions: {}, rulings, runClaude, log, rule: RULE, options: OPTIONS });
        expect(calls).toBe(0);
        expect(r.skipped).toEqual([{ id: q.id, reason: 'ruled OFF_RECOVERY' }]);

        const resolutions = { [q.id]: { questionId: q.id, awardClass: 'DEF_8_FUMBLE', credits: [], confidence: 'unsure', reasoning: 'old', model: 'opus', ts: 'x' } };
        const r2 = await reconcileQuestions({ questions: [q], resolutions, rulings: {}, runClaude, log, rule: RULE, options: OPTIONS });
        expect(calls).toBe(0);
        expect(r2.skipped[0].reason).toMatch(/already resolved DEF_8_FUMBLE/);
        const r3 = await reconcileQuestions({ questions: [q], resolutions, rulings: {}, runClaude, log, redo: true, rule: RULE, options: OPTIONS });
        expect(calls).toBe(1);
        expect(r3.resolved).toHaveLength(1);
        expect(resolutions[q.id].awardClass).toBe('OFF_RECOVERY');
    });

    test('dry-run builds prompts but never calls the runner', async () => {
        const runClaude = async () => { throw new Error('must not be called'); };
        const r = await reconcileQuestions({ questions: [question(), question({ id: 'q2' })], resolutions: {}, rulings: {}, runClaude, dryRun: true, log, rule: RULE, options: OPTIONS });
        expect(r.dryRun).toHaveLength(2);
        expect(r.dryRun[0].promptChars).toBeGreaterThan(500);
        expect(r.resolved).toEqual([]);
    });
});

describe('file shapes and args', () => {
    test('rulings.json may be a map, an array or {rulings}; resolutions.json a map or array', () => {
        const rul = { questionId: 'q1', awardClass: 'OFF_RUSH' };
        expect(rulingsMap({ q1: rul })).toEqual({ q1: rul });
        expect(rulingsMap([rul])).toEqual({ q1: rul });
        expect(rulingsMap({ rulings: [rul] })).toEqual({ q1: rul });
        expect(rulingsMap(null)).toEqual({});
        const res = { questionId: 'q1', awardClass: 'OFF_RUSH' };
        expect(resolutionsMap({ generatedAt: 'x', resolutions: { q1: res } })).toEqual({ q1: res });
        expect(resolutionsMap([res])).toEqual({ q1: res });
        expect(resolutionsMap(undefined)).toEqual({});
    });

    test('parseArgs', () => {
        const a = parseArgs(['node', 'x', '2026', '3', '--model', 'sonnet', '--dry-run', '--redo', '--quiet']);
        expect(a).toMatchObject({ season: 2026, week: 3, model: 'sonnet', dryRun: true, redo: true, quiet: true, valid: true });
        expect(a.workspace).toBe(path.join(__dirname, '../../logs/doublecheck/2026/week03'));
        expect(parseArgs(['node', 'x']).valid).toBe(false);
        expect(parseArgs(['node', 'x', '2026', '1', '--workspace', '/tmp/w']).workspace).toBe('/tmp/w');
    });
});

describe('live-review hints', () => {
    const { hintLine } = require('../../scripts/doublecheck-reconcile');
    test('hintLine renders the Qwen vote as one more opinion; buildPrompt includes it only when hints.qwen exists', () => {
        const q = question({ source: 'live-review', hints: { qwen: { awardClass: 'DEF_8_FUMBLE', confidence: 'unsure', reasoning: 'ESPN  labels it a\nfumble return' } } });
        const line = hintLine(q);
        expect(line).toBe('A local model (Qwen) voted DEF_8_FUMBLE (unsure) during the game because: ESPN labels it a fumble return. Treat it as one more opinion, not evidence.');
        const p = buildPrompt(q, { rule: RULE, options: OPTIONS });
        expect(p).toContain(line);
        expect(p.indexOf(line)).toBeGreaterThan(p.indexOf('EVIDENCE:'));
        expect(p.indexOf(line)).toBeLessThan(p.indexOf('OUTPUT JSON SCHEMA'));
        expect(hintLine(question())).toBe('');
        expect(hintLine(question({ hints: { qwen: null } }))).toBe('');
        expect(buildPrompt(question(), { rule: RULE, options: OPTIONS })).not.toContain('A local model (Qwen) voted');
    });
});
