/**
 * scripts/lib/liveReview.js — pure logic of the live play reviewer. No
 * network, no DB, no files.
 */
const LR = require('../../scripts/lib/liveReview');
const { buildPrompt, hintLine } = require('../../scripts/doublecheck-reconcile');
const { QUESTION_OPTIONS } = require('../../scripts/lib/tdDossier');

const NOW = Date.parse('2026-09-20T18:00:00Z');
const MIN = 60 * 1000;
const H = 60 * MIN;
const sqlite = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

function game(over = {}) {
    return { game_id: '20260920_ARI@HOU', status: 'Live - In Progress', game_time_epoch: (NOW - H) / 1000, home_team: 'HOU', away_team: 'ARI', last_updated: sqlite(NOW - MIN), ...over };
}

function play(over = {}) {
    return {
        idx: 3, kind: 'TD', period: 'Q2', clock: '4:11', scoringTeam: 'HOU', defendingTeam: 'ARI',
        tank01: { text: 'C.J. Stroud Aborted Snap C.J. Stroud Fumble Woody Marks 1 Yd Fumble Recovery (Kick)', scoreType: 'TD', scoreDetails: '1 play, 7 yards', scoreAfter: { home: 7, away: 0 },
            players: [{ id: '4432577', name: 'C.J. Stroud', pos: 'QB', team: 'HOU', roles: ['fumbler'], draftable: true }, { id: '4429059', name: 'Woody Marks', pos: 'RB', team: 'HOU', roles: ['recoverer'], draftable: true }] },
        espn: { typeText: 'Fumble Return Touchdown', text: 'Woody Marks 1 Yd Fumble Recovery', team: 'HOU', drive: { team: 'HOU', result: 'TD', isTurnover: false, startTeam: 'HOU', endTeam: 'HOU', playText: 'C.Stroud FUMBLES (Aborted) at ARZ 2, recovered by HST-W.Marks at ARZ 7. W.Marks for 7 yards, TOUCHDOWN.' }, scoreAfter: { home: 7, away: 0 } },
        awardClass: 'OFF_RECOVERY', votes: { drive: 'same', gamebook: 'same', text: null }, votesAgree: true, gamebook: { recovered: true, recoveredUpper: false, recoveredBy: 'HOU' },
        twoPoint: null, expectedCredits: [{ player_id: '4429059', column: 'rushing_tds', delta: 1, note: 'x' }], exemptions: [],
        dbCredit: { '4429059': { rushing_tds: 1 }, DEF_HOU: { def_fumble_return_tds: 0 } }, agreement: true, reasons: ['offensive fumble recovery'], questionId: null,
        ...over
    };
}

const qwenVote = (over = {}) => ({ awardClass: 'OFF_RECOVERY', credits: [{ player_id: '4429059', column: 'rushing_tds', delta: 1 }], confidence: 'likely', reasoning: 'lower-case recovered by = same possession', latencyMs: 1400, model: 'qwen', ...over });

describe('selectGames / inWindow', () => {
    test('in-progress games are always selected; Scheduled only inside the kickoff window (-4h … +15min)', () => {
        const live = game();
        const soon = game({ game_id: 'soon', status: 'Scheduled', game_time_epoch: (NOW + 10 * MIN) / 1000 });
        const later = game({ game_id: 'later', status: 'Scheduled', game_time_epoch: (NOW + 30 * MIN) / 1000 });
        const stale = game({ game_id: 'stale', status: 'Scheduled', game_time_epoch: (NOW - 5 * H) / 1000 });
        const edge = game({ game_id: 'edge', status: 'Scheduled', game_time_epoch: (NOW - 4 * H) / 1000 });
        const half = game({ game_id: 'half', status: 'Halftime' });
        expect(LR.selectGames([live, soon, later, stale, edge, half], null, NOW).map(g => g.game_id)).toEqual(['20260920_ARI@HOU', 'soon', 'edge', 'half']);
        expect(LR.selectGames([], null, NOW)).toEqual([]);
        expect(LR.selectGames(null, null, NOW)).toEqual([]);
    });

    test('a Final game stays selected for 90 minutes after its last update (boxscore may still settle)', () => {
        const fresh = game({ game_id: 'f1', status: 'Final', last_updated: sqlite(NOW - 30 * MIN) });
        const edge = game({ game_id: 'f2', status: 'Final/OT', last_updated: sqlite(NOW - 90 * MIN) });
        const old = game({ game_id: 'f3', status: 'Final', last_updated: sqlite(NOW - 91 * MIN) });
        const iso = game({ game_id: 'f4', status: 'Final', last_updated: new Date(NOW - 10 * MIN).toISOString() });
        const none = game({ game_id: 'f5', status: 'Final', last_updated: null });
        expect(LR.selectGames([fresh, edge, old, iso, none], null, NOW).map(g => g.game_id)).toEqual(['f1', 'f2', 'f4']);
    });

    test('inWindow: any selected game, or the watchdog expecting games', () => {
        expect(LR.inWindow([game()], null, NOW)).toBe(true);
        const idle = game({ status: 'Final', last_updated: sqlite(NOW - 3 * H) });
        expect(LR.inWindow([idle], { expectedGames: 0 }, NOW)).toBe(false);
        expect(LR.inWindow([idle], null, NOW)).toBe(false);
        expect(LR.inWindow([idle], { expectedGames: 2 }, NOW)).toBe(true);
    });
});

describe('playKey / newPlays', () => {
    test('key = game|period|clock|team; newPlays skips reviewed keys across ticks and non TD/SAFETY plays', () => {
        const p = play();
        expect(LR.playKey('G1', p)).toBe('G1|Q2|4:11|HOU');
        const fg = play({ idx: 1, kind: 'FG', clock: '9:00' });
        const sf = play({ idx: 2, kind: 'SAFETY', clock: '7:00', awardClass: 'SAFETY_2' });
        const dossier = { gameId: 'G1', plays: [fg, sf, p] };
        const tick1 = LR.newPlays(dossier, { reviewed: {} });
        expect(tick1.map(x => x.idx)).toEqual([2, 3]);
        const state = { reviewed: { [LR.playKey('G1', sf)]: { ts: 'x', status: 'confirmed' } } };
        expect(LR.newPlays(dossier, state).map(x => x.idx)).toEqual([3]);
        state.reviewed[LR.playKey('G1', p)] = { ts: 'y' };
        expect(LR.newPlays(dossier, state)).toEqual([]);
        expect(LR.newPlays(dossier, null).map(x => x.idx)).toEqual([2, 3]);
    });

    test('prioritize puts defensive candidates first', () => {
        const pass = play({ idx: 1, awardClass: 'OFF_PASS', tank01: { ...play().tank01, text: 'A 5 Yd pass from B (Kick)' }, espn: { ...play().espn, typeText: 'Passing Touchdown', text: 'A 5 Yd pass from B', drive: { ...play().espn.drive, playText: 'B pass to A for 5 yards, TOUCHDOWN.' } } });
        const def = play({ idx: 2, awardClass: 'DEF_8_INT' });
        expect(LR.prioritize([pass, def]).map(p => p.idx)).toEqual([2, 1]);
        expect(LR.isDefensiveCandidate(pass)).toBe(false);
        expect(LR.isDefensiveCandidate(play())).toBe(true);
    });
});

describe('compareVotes (the matrix)', () => {
    const S = LR.STATUS;
    test('qwen null: deterministic agreement decides', () => {
        expect(LR.compareVotes({ play: play({ agreement: true }), qwen: null }).status).toBe(S.CONFIRMED);
        expect(LR.compareVotes({ play: play({ agreement: false }), qwen: null }).status).toBe(S.SUSPECTED);
        expect(LR.compareVotes({ play: play({ awardClass: 'AMBIGUOUS', agreement: null }), qwen: null }).status).toBe(S.UNDER_REVIEW);
        expect(LR.compareVotes({ play: play({ agreement: null }), qwen: undefined }).status).toBe(S.CONFIRMED);
    });
    test('qwen disagrees with the script, or the script is AMBIGUOUS -> under review', () => {
        expect(LR.compareVotes({ play: play({ agreement: true }), qwen: qwenVote({ awardClass: 'DEF_8_FUMBLE' }) })).toEqual({ status: S.UNDER_REVIEW, reason: expect.stringMatching(/Qwen voted DEF_8_FUMBLE \(likely\) but the script says OFF_RECOVERY/) });
        expect(LR.compareVotes({ play: play({ awardClass: 'AMBIGUOUS', agreement: null }), qwen: qwenVote() }).status).toBe(S.UNDER_REVIEW);
        expect(LR.compareVotes({ play: play({ agreement: false }), qwen: qwenVote({ awardClass: 'OFF_RUSH' }) }).status).toBe(S.UNDER_REVIEW);
    });
    test('agree: DB disagrees -> miscredit suspected; DB agrees or unknown -> confirmed', () => {
        expect(LR.compareVotes({ play: play({ agreement: false }), qwen: qwenVote() })).toEqual({ status: S.SUSPECTED, reason: expect.stringMatching(/DB credit differs/) });
        expect(LR.compareVotes({ play: play({ agreement: true }), qwen: qwenVote() }).status).toBe(S.CONFIRMED);
        expect(LR.compareVotes({ play: play({ agreement: null }), qwen: qwenVote() }).status).toBe(S.CONFIRMED);
        const sf = play({ kind: 'SAFETY', awardClass: 'SAFETY_2', agreement: true });
        expect(LR.compareVotes({ play: sf, qwen: qwenVote({ awardClass: 'SAFETY_2' }) }).status).toBe(S.CONFIRMED);
    });
});

describe('toQuestion / buildReviewPrompt', () => {
    test('matches the Collector.ask shape, plus source and hints', () => {
        const q = LR.toQuestion(play({ votesAgree: false }), '20260920_ARI@HOU', 2026, 2, qwenVote(), { rule: 'RULE' });
        expect(q).toMatchObject({
            id: '2026-wk02-20260920_ARI@HOU-play-3', season: 2026, week: 2, gameId: '20260920_ARI@HOU', playIdx: 3, kind: 'td_award_class',
            question: expect.stringMatching(/classified this play OFF_RECOVERY but its possession votes disagree/),
            options: [...QUESTION_OPTIONS], relatedFindingIds: [], source: 'live-review',
            hints: { qwen: { awardClass: 'OFF_RECOVERY', confidence: 'likely', reasoning: expect.any(String), model: 'qwen' } }
        });
        expect(Object.keys(q).sort()).toEqual(['evidence', 'gameId', 'hints', 'id', 'kind', 'options', 'playIdx', 'question', 'relatedFindingIds', 'season', 'source', 'week']);
        expect(q.evidence).toMatchObject({ tank01Text: expect.stringMatching(/Woody Marks/), espnType: 'Fumble Return Touchdown', gamebook: expect.stringMatching(/recovered by HST-W.Marks/), votes: { drive: 'same', gamebook: 'same', text: null }, scoringTeam: 'HOU', opponent: 'ARI', teamDefenseId: 'DEF_HOU', scriptAwardClass: 'OFF_RECOVERY', players: [expect.objectContaining({ id: '4432577' }), expect.objectContaining({ id: '4429059', roles: ['recoverer'] })], dbCredit: { '4429059': { rushing_tds: 1 }, DEF_HOU: { def_fumble_return_tds: 0 } }, rule: 'RULE' });
        expect(LR.toQuestion(play({ awardClass: 'AMBIGUOUS' }), 'G', 2026, 2, null).question).toBe('Who should be credited for this scoring play?');
        expect(LR.toQuestion(play(), 'G', 2026, 2, null).hints).toEqual({ qwen: null });
        expect(LR.toQuestion(play({ questionId: 'pre-set' }), 'G', 2026, 2, null).id).toBe('pre-set');
    });

    test('the Qwen prompt is the reconcile prompt without the script verdict (independent vote)', () => {
        const { question, prompt } = LR.buildReviewPrompt(play(), 'G1', { rule: 'THE RULE', options: '| t |', season: 2026, week: 2 });
        expect(prompt).toContain('THE RULE');
        expect(prompt).toContain('| t |');
        expect(prompt).toContain(question.id);
        expect(prompt).toContain('recovered by HST-W.Marks');
        expect(prompt).not.toContain('scriptAwardClass');
        expect(prompt).not.toContain('A local model (Qwen) voted');
        expect(question.evidence.scriptAwardClass).toBeUndefined();
        expect(question.options).toEqual([...QUESTION_OPTIONS]);
    });
});

describe('summarize (status colours)', () => {
    const rec = (status, qwen = qwenVote()) => ({ status, qwen });
    test('only under review / suspected are a call to action; Qwen unreachable is info', () => {
        expect(LR.summarize([])).toMatchObject({ confirmed: 0, underReview: 0, suspected: 0, qwenUnreachable: 0, status: 'ok', summary: expect.stringMatching(/no touchdowns/) });
        expect(LR.summarize([rec('confirmed'), rec('confirmed', null)])).toMatchObject({ confirmed: 2, qwenUnreachable: 1, status: 'ok', summary: expect.stringMatching(/2 confirmed; Qwen unreachable for 1/) });
        expect(LR.summarize([rec('confirmed', null)])).toMatchObject({ status: 'ok', summary: expect.stringMatching(/Qwen unreachable \(deterministic only\)/) });
        expect(LR.summarize([rec('confirmed'), rec('under review')])).toMatchObject({ underReview: 1, status: 'warning', summary: expect.stringMatching(/1 under review/) });
        expect(LR.summarize([rec('miscredit suspected')])).toMatchObject({ suspected: 1, status: 'warning', summary: expect.stringMatching(/1 miscredit suspected/) });
    });
});

describe('mergeQuestions', () => {
    test('dedupes by id, keeps the existing entry, adds hints; creates the file shape when absent', () => {
        const existing = { generatedAt: 'g', season: 2026, week: 2, questions: [{ id: 'q1', question: 'daily', evidence: { a: 1 } }, { id: 'q0' }] };
        const fromLive = [LR.toQuestion(play(), 'G', 2026, 2, qwenVote()), { ...LR.toQuestion(play({ idx: 9 }), 'G', 2026, 2, null), id: 'q1', question: 'live' }];
        const out = LR.mergeQuestions(existing, fromLive);
        expect(out.generatedAt).toBe('g');
        expect(out.questions.map(q => q.id)).toEqual(['q1', 'q0', '2026-wk02-G-play-3']);
        const q1 = out.questions[0];
        expect(q1.question).toBe('daily');
        expect(q1.evidence).toEqual({ a: 1 });
        expect(q1.hints).toEqual({ qwen: null });
        expect(q1.source).toBe('live-review');
        expect(existing.questions[0].hints).toBeUndefined();
        const again = LR.mergeQuestions(out, [{ ...fromLive[1], hints: { qwen: qwenVote() } }]);
        expect(again.questions).toHaveLength(3);
        expect(again.questions[0].hints.qwen.awardClass).toBe('OFF_RECOVERY');
        const keep = LR.mergeQuestions(again, [{ ...fromLive[1], hints: { qwen: null } }]);
        expect(keep.questions[0].hints.qwen.awardClass).toBe('OFF_RECOVERY');
        const fresh = LR.mergeQuestions(null, fromLive.slice(0, 1));
        expect(fresh.questions).toHaveLength(1);
        expect(typeof fresh.generatedAt).toBe('string');
    });
});

describe('pruneState / reviewRecord', () => {
    test('entries older than 7 days are dropped; the record carries the plan fields', () => {
        const state = { reviewed: { old: { ts: new Date(NOW - 8 * 24 * H).toISOString() }, recent: { ts: new Date(NOW - H).toISOString() }, bad: { ts: 'nope' } } };
        expect(Object.keys(LR.pruneState(state, NOW).reviewed).sort()).toEqual(['bad', 'recent']);
        const rec = LR.reviewRecord({ play: play(), gameId: 'G', season: 2026, week: 2, qwen: qwenVote(), verdict: LR.compareVotes({ play: play(), qwen: qwenVote() }), ts: 'T' });
        expect(rec).toMatchObject({ key: 'G|Q2|4:11|HOU', gameId: 'G', playIdx: 3, period: 'Q2', clock: '4:11', text: expect.stringMatching(/Woody Marks/), scoringTeam: 'HOU',
            deterministic: { awardClass: 'OFF_RECOVERY', votes: { drive: 'same', gamebook: 'same', text: null }, agreement: true, expectedCredits: [{ player_id: '4429059', column: 'rushing_tds' }] },
            dbCredit: { '4429059': { rushing_tds: 1 } }, qwen: { awardClass: 'OFF_RECOVERY', confidence: 'likely', reasoning: expect.any(String), latencyMs: 1400 }, status: 'confirmed', reason: expect.any(String), ts: 'T' });
        const none = LR.reviewRecord({ play: play(), gameId: 'G', season: 2026, week: 2, qwen: null, qwenError: 'timeout', verdict: LR.compareVotes({ play: play(), qwen: null }), ts: 'T' });
        expect(none.qwen).toBeNull();
        expect(none.qwenError).toBe('timeout');
    });
});

describe('reconcile hint hand-off', () => {
    test('hintLine appears in the Opus prompt only when hints.qwen exists', () => {
        const withHint = LR.toQuestion(play({ votesAgree: false }), 'G', 2026, 2, qwenVote(), { rule: 'R' });
        const line = hintLine(withHint);
        expect(line).toBe('A local model (Qwen) voted OFF_RECOVERY (likely) during the game because: lower-case recovered by = same possession. Treat it as one more opinion, not evidence.');
        expect(buildPrompt(withHint, { rule: 'R', options: 'O' })).toContain(line);
        const without = LR.toQuestion(play({ votesAgree: false }), 'G', 2026, 2, null, { rule: 'R' });
        expect(hintLine(without)).toBe('');
        expect(buildPrompt(without, { rule: 'R', options: 'O' })).not.toContain('A local model (Qwen) voted');
    });
});

describe('retireConfirmedQuestions lifecycle', () => {
    const make = () => {
        const p = play();
        const q = LR.toQuestion(p, 'game', 2026, 3, qwenVote({ ts: '2026-09-27T20:00:00Z' }));
        const r = LR.reviewRecord({ play: p, gameId: 'game', season: 2026, week: 3,
            qwen: qwenVote(), verdict: { status: 'confirmed', reason: 'DB agrees' }, ts: '2026-09-27T20:01:00Z' });
        r.updatedTs = '2026-09-27T20:02:00Z';
        return { q, r };
    };
    test('archives original question plus later verification, without inventing a ruling', () => {
        const { q, r } = make();
        const result = LR.retireConfirmedQuestions({ season: 2026, week: 3, questions: [q] }, [r]);
        expect(result.active.questions).toEqual([]);
        expect(result.retired[0]).toMatchObject({ question: q, review: r, resolvedAt: r.updatedTs });
        expect(q.source).toBe('live-review');
    });
    test.each([
        { status: 'under review' }, { status: 'miscredit suspected' },
        { deterministic: { awardClass: 'OFF_PASS', agreement: null } },
        { deterministic: { awardClass: 'OFF_PASS', agreement: false } },
        { deterministic: { awardClass: 'AMBIGUOUS', agreement: true } },
        { scoringTeam: 'ARI' }, { clock: '4:10' }, { season: 2025 },
        { updatedTs: '2026-09-27T19:59:00Z' }, { updatedTs: 'bad time' }
    ])('does not retire when latest evidence is unsafe or mismatched: %j', patch => {
        const { q, r } = make();
        expect(LR.retireConfirmedQuestions({ questions: [q] }, [{ ...r, ...patch }]).active.questions).toEqual([q]);
    });
    test('preserves commissioner rulings, independent findings, and ambiguous matches', () => {
        const { q, r } = make();
        expect(LR.retireConfirmedQuestions({ questions: [q] }, [r], { [q.id]: { awardClass: 'OFF_RECOVERY' } }).retired).toEqual([]);
        expect(LR.retireConfirmedQuestions({ questions: [{ ...q, source: 'daily' }] }, [r]).retired).toEqual([]);
        expect(LR.retireConfirmedQuestions({ questions: [{ ...q, relatedFindingIds: ['B1'] }] }, [r]).retired).toEqual([]);
        expect(LR.retireConfirmedQuestions({ questions: [q] }, [r, r]).retired).toEqual([]);
    });
    test('can reopen on a later disagreement and retire again only after confirmation', () => {
        const { q, r } = make();
        const closed = LR.retireConfirmedQuestions({ questions: [q] }, [r]);
        const merged = LR.mergeQuestions(closed.active, [{ ...q, hints: { liveStatus: 'miscredit suspected' } }]);
        const reopened = LR.retireConfirmedQuestions(merged, [{ ...r, status: 'miscredit suspected' }]);
        expect(reopened.active.questions).toHaveLength(1);
        expect(LR.retireConfirmedQuestions(reopened.active, [r]).retired).toHaveLength(1);
    });
    test('persistence cleans existing questions even when the tick produced no new questions', () => {
        const fs = require('fs'), os = require('os'), path = require('path');
        const { mergeIntoWorkspace } = require('../../scripts/live-review');
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-retirement-'));
        try {
            const ws = path.join(root, '2026', 'week03'); fs.mkdirSync(ws, { recursive: true });
            const { q, r } = make();
            const qFile = path.join(ws, 'questions.json');
            fs.writeFileSync(qFile, JSON.stringify({ questions: [q] }));
            mergeIntoWorkspace(2026, 3, [], () => {}, [r], root);
            expect(JSON.parse(fs.readFileSync(qFile)).questions).toEqual([]);
            const archiveFile = path.join(ws, 'live-resolved-questions.json');
            const archive = JSON.parse(fs.readFileSync(archiveFile));
            expect(archive.questions[q.id].question).toEqual(q);
            expect(archive.questions[q.id].review).toEqual(r);
            mergeIntoWorkspace(2026, 3, [], () => {}, [r], root);
            expect(JSON.parse(fs.readFileSync(archiveFile))).toEqual(archive);
            mergeIntoWorkspace(2026, 3, [q], () => {}, [{ ...r, status: 'under review' }], root);
            expect(JSON.parse(fs.readFileSync(qFile)).questions).toHaveLength(1);
            // The original evidence remains in the archive after reopening.
            expect(JSON.parse(fs.readFileSync(archiveFile)).questions[q.id].question).toEqual(q);
            fs.writeFileSync(archiveFile, '{broken archive');
            expect(() => mergeIntoWorkspace(2026, 3, [], () => {}, [r], root)).toThrow();
            expect(JSON.parse(fs.readFileSync(qFile)).questions).toHaveLength(1);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
});
