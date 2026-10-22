'use strict';

/**
 * Deterministic bug-class checks for the Double Check job.
 *
 * runChecks(S, C) -> { findings, checklist, knownErrors, questions, defensiveScores }
 *
 * S = DB snapshot (see scripts/doublecheck-data.js buildSnapshot)
 * C = computed view (players, teams, matchups, bonuses, dossiers, espn)
 *
 * Every check is named after the bug class in the approved plan
 * (~/.claude/plans/design-a-checker-job-glimmering-stallman.md) so a finding
 * can always be traced back to the historical failure it guards against.
 * This module never touches the database; it only reads S and C.
 *
 * What the deterministic pass cannot decide becomes a QUESTION (plan contract
 * "questions.json"): every AMBIGUOUS scoring play, every play whose three
 * possession votes disagree, and every finding with confidence 'needs-ruling'.
 * The evidence bundle travels with the question so the reconcile step
 * (scripts/doublecheck-reconcile.js, Claude Opus) and the commissioner can
 * answer it without the workspace.
 */

const fs = require('fs');
const path = require('path');
const { CANONICAL_TEAM_CODES } = require('../../server/utils/teamMappings');
const { knownErrorsFor, matchFinding } = require('../../server/config/knownScoringErrors');
const { QUESTION_OPTIONS, questionIdFor } = require('./tdDossier');

const REPO = path.join(__dirname, '../..');

/**
 * The league rule a question is judged by: docs/SCORING_SYSTEM.md
 * "Defensive Touchdowns — Exact Award Logic", verbatim (through the end of the
 * Team Defense section).
 */
function ruleText() {
    try {
        const src = fs.readFileSync(path.join(REPO, 'docs/SCORING_SYSTEM.md'), 'utf8');
        const start = src.indexOf('#### Defensive Touchdowns');
        if (start < 0) return '';
        const rest = src.slice(start);
        const end = rest.search(/\n### /);
        return (end > 0 ? rest.slice(0, end) : rest).trim();
    } catch (_) { return ''; }
}

/** The award-class options table from docs/DOUBLECHECK.md (section "Award classes"). */
function optionsTable() {
    try {
        const src = fs.readFileSync(path.join(REPO, 'docs/DOUBLECHECK.md'), 'utf8');
        const start = src.search(/\n#+ Award classes/);
        if (start < 0) return '';
        const rest = src.slice(start + 1);
        const tbl = rest.match(/(\|[^\n]*\n)+/);
        return tbl ? tbl[0].trim() : '';
    } catch (_) { return ''; }
}

const REGULAR_SEASON_WEEKS = 12;
const TOL = 0.05;
const STATUS_ALLOWLIST = [
    /^Scheduled$/i, /^Final/i, /^Live/i, /^In Progress/i, /^Halftime$/i, /^Half$/i,
    /^Q[1-4]/i, /^[1-4](st|nd|rd|th)( Quarter)?$/i, /^End of [1-4]/i, /^OT/i, /^Overtime/i,
    /^Delayed/i, /^Postponed/i, /^Suspended/i, /^Not Started/i, /^Pregame/i
];

const NV_COLUMNS = ['two_point_conversions_pass', 'two_point_conversions_run', 'two_point_conversions_rec',
    'safeties', 'kick_return_tds', 'punt_return_tds', 'def_int_return_tds', 'def_fumble_return_tds',
    'def_blocked_return_tds', 'extra_points_made', 'field_goals_made', 'passing_tds', 'rushing_tds', 'receiving_tds'];

const CHECK_NAMES = {
    S1: 'Player stats vs ESPN',
    S2: 'Matchup totals vs ESPN truth',
    A1: 'Matchup totals == scoring-lineup sums (and standings)',
    A2: 'Scoring lineup selection',
    A3: 'Rubric recompute of every fantasy_points',
    T1: 'Offensive TD / 2-pt credit matches the scoring plays',
    B1: 'Fumble-recovery TD attribution',
    B2: 'Blocked-kick returns are defensive (never 20)',
    B3: 'Return TDs credited (20 pts)',
    B4: 'Lateral / ambiguous plays',
    B5: 'DST points/yards allowed vs game facts',
    B6: 'Defensive bonuses (5 pts, tie split)',
    B7: 'DST rows present',
    B8: 'Scoring plays parsed for every final game',
    B9: 'Score reconciliation',
    C1: 'Roster/player id integrity',
    C2: 'Stats credited in the right game',
    C3: 'nfl_players freshness',
    D1: 'Team codes canonical and joinable',
    D2: 'DST roster composition / duplicates across rosters',
    E1: 'Roster invariant 12x19',
    E2: 'roster_position enum',
    E3: 'IR rules',
    E4: 'Closed weeks unchanged',
    F1: 'Matchup schedule shape',
    F3: 'Cumulative points',
    F4: 'Standings W/L/T deltas',
    G1: "Final/OT handling (source tripwire)",
    G2: 'Known game status strings',
    G3: 'Week advanced',
    G4: 'Next week schedule loaded',
    I2: 'Duplicate rows / legacy columns',
    I3: 'Freshness of daily update, watchdog, validation',
    NV: 'Signals that never vary'
};

function num(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function r2(x) { return Math.round(x * 100) / 100; }

class Collector {
    constructor(S) {
        this.S = S;
        this.findings = [];
        this.checklist = [];
        this.questions = [];
        this.seq = 0;
        // Known, accepted errors in blessed seasons (server/config/knownScoringErrors.json)
        this.knownErrors = knownErrorsFor(S.season, S.week);
        this.knownMatched = new Set();
    }
    /** Raise (or extend) a question. Same id twice merges relatedFindingIds. Returns the question. */
    ask(q) {
        const existing = this.questions.find(x => x.id === q.id);
        if (existing) {
            existing.relatedFindingIds = [...new Set([...(existing.relatedFindingIds || []), ...(q.relatedFindingIds || [])])];
            return existing;
        }
        const question = {
            id: q.id, season: this.S.season, week: this.S.week, gameId: q.gameId || null, playIdx: q.playIdx ?? null,
            kind: q.kind || 'td_award_class', question: q.question,
            evidence: q.evidence || {}, options: q.options || [...QUESTION_OPTIONS],
            relatedFindingIds: [...new Set(q.relatedFindingIds || [])]
        };
        this.questions.push(question);
        return question;
    }
    /** Last finding added (its generated id is what a question relates to). */
    last() { return this.findings[this.findings.length - 1] || null; }
    add(ref, f) {
        this.seq++;
        const ent = f.entity || { type: 'league', id: 'league' };
        let severity = f.severity;
        let explanation = f.explanation;
        let knownErrorId = null;
        if (severity === 'FAIL' || severity === 'WARN') {
            const probe = { ...f, bugClassRef: ref, entity: ent };
            const hit = this.knownErrors.find(e => matchFinding(e, probe, this.S.season, this.S.week));
            if (hit) {
                knownErrorId = hit.id;
                this.knownMatched.add(hit.id);
                severity = 'INFO';
                explanation = `KNOWN, accepted (${hit.id}; fixed from ${hit.fixedFrom} by ${hit.rule}): ${explanation}`;
            }
        }
        this.findings.push({
            knownErrorId,
            id: f.id || `${ref}-${this.S.season}-${this.S.week}-${ent.type}-${ent.id}-${this.seq}`,
            check: f.check || CHECK_NAMES[ref],
            bugClassRef: ref,
            severity,
            flipsResult: !!f.flipsResult && !knownErrorId,
            entity: ent,
            internal: f.internal || {},
            espn: f.espn || {},
            expected: f.expected || {},
            explanation,
            source: 'script',
            confidence: f.confidence || 'certain',
            suggestedFix: f.suggestedFix || '',
            evidence: f.evidence && f.evidence.length ? f.evidence : ['checks.json']
        });
    }
    done(ref, status, summary) {
        this.checklist.push({ id: ref, name: CHECK_NAMES[ref], status, summary });
    }
    /** Mark a check from the findings it produced. */
    close(ref, before, summaryOk, summaryBad) {
        const mine = this.findings.slice(before).filter(f => f.bugClassRef === ref);
        const sev = mine.some(f => f.severity === 'FAIL') ? 'FAIL'
            : mine.some(f => f.severity === 'WARN') ? 'WARN'
                : mine.some(f => f.severity === 'DEFER') ? 'DEFER'
                    : mine.length ? 'INFO' : 'PASS';
        this.done(ref, sev, sev === 'PASS' ? summaryOk : (summaryBad || `${mine.length} finding(s)`));
    }
}

function playerEntity(P, gameId) {
    return {
        type: P.position === 'DST' ? 'dst' : 'player',
        id: P.player_id, name: P.name, nflTeam: P.nflTeam,
        fantasyTeamId: P.roster ? P.roster.team_id : null,
        owner: P.roster ? P.roster.owner : null,
        gameId: gameId || (P.game ? P.game.game_id : null)
    };
}
function teamEntity(T) {
    return { type: 'team', id: String(T.team_id), name: T.owner, fantasyTeamId: T.team_id, owner: T.owner };
}
// Evidence anchors. Teams and players live in league.md (the per-team files of
// the retired LLM runbook are no longer written); games keep their own file.
function teamAnchor(T) { return `league.md#team-${T.team_id}`; }
function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function playerIdAnchor(pid) { return `league.md#player-${pid}`; }
function playerAnchor(P) { return playerIdAnchor(P.player_id); }
function gameFile(gameId) { return `games/game-${gameId}.md`; }
function playAnchor(gameId, idx) { return `${gameFile(gameId)}#play-${idx}`; }

// ---------------------------------------------------------------- S1 / S2

function checkStatsVsEspn(col, S, C) {
    const b = col.findings.length;
    if (!C.espn.summaries || C.espn.summaries.size === 0) {
        col.add('S1', { severity: 'DEFER', explanation: `ESPN unavailable (${C.espn.failed.length} failed fetches); player stat comparison deferred`, evidence: ['manifest.json'] });
        col.close('S1', b, '', 'deferred: ESPN unavailable');
        return;
    }
    const pending = new Set(C.espn.missingFinal || []);
    if (pending.size) {
        col.add('S1', { severity: 'DEFER', explanation: `${pending.size} final game(s) have no complete ESPN summary yet (${[...pending].join(', ')}); their players are not compared`, evidence: ['manifest.json'] });
    }
    const cosmetic = [];
    for (const P of C.players.values()) {
        if (!P.game) continue;
        if (!P.game.final) continue; // only compare completed games
        if (pending.has(P.game.game_id)) continue; // no trustworthy ESPN line for this game
        if (P.position === 'DST') continue; // DSTs are covered by B5/B1-3
        const rostered = !!P.roster;
        const sev = rostered ? 'FAIL' : 'WARN';
        if (P.status === 'INTERNAL_MISSING') {
            if (!(P.pointsEspn > 0)) continue; // ESPN lists him, but nothing that scores (hasValidStats drops such rows)
            col.add('S1', {
                severity: sev, entity: playerEntity(P), check: 'stat_internal_missing',
                internal: { row: null }, espn: P.espnSummary, expected: { fantasy_points: P.pointsEspn },
                explanation: `ESPN shows stats for ${P.name} (${P.nflTeam}) in a Final game but there is no player_stats row (would be ${P.pointsEspn} pts).`,
                suggestedFix: 'Check statsExtractionService.hasValidStats / player sync for this player; resync the game from cache and recalc.',
                evidence: [playerAnchor(P), gameFile(P.game.game_id)]
            });
            continue;
        }
        if (P.status === 'ESPN_MISSING') {
            col.add('S1', {
                severity: P.pointsStored > 0 ? sev : 'INFO', entity: playerEntity(P), check: 'stat_espn_missing',
                internal: P.internalSummary, espn: { line: null },
                explanation: `${P.name} has a player_stats row (${P.pointsStored} pts) for ${P.game.game_id} but ESPN lists no stats for him in that game.`,
                suggestedFix: 'Verify the game_id / player identity (C2). If the row is empty noise, it is harmless.',
                evidence: [playerAnchor(P), gameFile(P.game.game_id)]
            });
            continue;
        }
        if (!P.diffs || !P.diffs.length) continue;
        const tier = P.diffs.filter(d => d.affectsPoints);
        if (tier.length) {
            col.add('S1', {
                severity: sev, entity: playerEntity(P), check: 'stat_mismatch',
                flipsResult: false,
                internal: Object.fromEntries(tier.map(d => [d.field, d.internal])),
                espn: Object.fromEntries(tier.map(d => [d.field, d.espn])),
                expected: { fantasy_points: P.pointsEspn, internal_fantasy_points: P.pointsInternal },
                explanation: `${P.name}: ${tier.map(d => `${d.field} internal=${d.internal} espn=${d.espn}`).join('; ')} -> points ${P.pointsInternal} vs ESPN-derived ${P.pointsEspn}.`,
                suggestedFix: 'Compare the Tank01 boxscore in tank01_cache with ESPN; if Tank01 is wrong, wait for its correction and resync; if extraction is wrong, fix statsExtractionService and recalc.',
                evidence: [playerAnchor(P), gameFile(P.game.game_id)]
            });
        } else {
            cosmetic.push(`${P.name}: ${P.diffs.map(d => `${d.field} ${d.internal}/${d.espn}`).join(', ')}`);
        }
    }
    if (cosmetic.length) {
        col.add('S1', {
            severity: 'INFO', check: 'stat_cosmetic_diffs',
            explanation: `${cosmetic.length} player(s) differ from ESPN without crossing a scoring tier: ${cosmetic.slice(0, 25).join(' | ')}${cosmetic.length > 25 ? ' | ...' : ''}`,
            evidence: ['league.md#stat-diffs']
        });
    }
    col.close('S1', b, `every rostered player in a final game matches ESPN on every scoring-relevant stat`);
}

function checkMatchupsVsEspn(col, S, C) {
    const b = col.findings.length;
    if (!C.espn.ok) { col.add('S2', { severity: 'DEFER', explanation: 'ESPN unavailable; ESPN-truth matchup totals deferred', evidence: ['manifest.json'] }); col.close('S2', b, '', 'deferred'); return; }
    if (!C.allFinal) { col.add('S2', { severity: 'DEFER', explanation: `${C.finalCount}/${C.gameCount} games final; ESPN-truth matchup totals deferred until the week completes`, evidence: ['league.md#matchups'] }); }
    for (const m of C.matchups) {
        for (const side of [1, 2]) {
            const stored = m[`stored${side}`], truth = m[`espn${side}`];
            if (truth === null || truth === undefined) continue;
            if (Math.abs(stored - truth) > TOL) {
                col.add('S2', {
                    severity: C.allFinal ? (m.flipsEspn ? 'FAIL' : 'WARN') : 'INFO',
                    flipsResult: !!m.flipsEspn,
                    entity: { type: 'matchup', id: String(m.matchup_id), name: `${m.owner1} vs ${m.owner2}`, fantasyTeamId: m[`team${side}_id`], owner: m[`owner${side}`] },
                    internal: { stored }, espn: { truth }, expected: { scoring_points: truth },
                    explanation: `${m[`owner${side}`]}'s stored score ${stored} differs from the ESPN-derived best lineup ${truth}${m.flipsEspn ? ' - THE MATCHUP RESULT FLIPS' : ''}.`,
                    suggestedFix: 'Resolve the underlying S1/B* findings for this team; the matchup total follows from them.',
                    evidence: ['league.md#matchups', teamAnchor({ team_id: m[`team${side}_id`] })]
                });
            }
        }
    }
    col.close('S2', b, 'every matchup total equals the ESPN-derived best lineup');
}

// ---------------------------------------------------------------- A

function checkA1(col, S, C) {
    const b = col.findings.length;
    for (const m of C.matchups) {
        for (const side of [1, 2]) {
            const stored = m[`stored${side}`], sum = m[`lineupSum${side}`];
            if (Math.abs(stored - sum) > TOL) {
                col.add('A1', {
                    severity: 'FAIL', entity: { type: 'matchup', id: String(m.matchup_id), name: `${m.owner1} vs ${m.owner2}`, fantasyTeamId: m[`team${side}_id`], owner: m[`owner${side}`] },
                    internal: { scoring_points: stored, is_scoring_sum: sum }, expected: { scoring_points: sum },
                    explanation: `matchups.team${side}_scoring_points=${stored} but the is_scoring lineup sums to ${sum} (the 2025 full-roster overwrite fingerprint).`,
                    suggestedFix: 'Only scoringPlayersService.updateMatchupScoringTotals may write matchup totals; find the other writer, remove it, rerun calculateScoringPlayers for the week.',
                    evidence: ['league.md#matchups']
                });
            }
            if (C.standingsPresent) {
                const st = C.standingsCur.get(m[`team${side}_id`]);
                if (st && Math.abs(num(st.points_for_week) - stored) > TOL) {
                    col.add('A1', {
                        severity: 'FAIL', entity: { type: 'team', id: String(m[`team${side}_id`]), owner: m[`owner${side}`], fantasyTeamId: m[`team${side}_id`] },
                        internal: { matchup: stored, standings_points_for_week: st.points_for_week },
                        explanation: `weekly_standings.points_for_week=${st.points_for_week} disagrees with the matchup total ${stored} for ${m[`owner${side}`]}.`,
                        suggestedFix: 'Rerun standings for the week after the matchup totals are correct.',
                        evidence: ['league.md#standings']
                    });
                }
            }
        }
    }
    if (!C.standingsPresent) col.add('A1', { severity: 'DEFER', explanation: `week ${S.week} standings not written yet (manual weekly update) - matchup-vs-standings comparison deferred`, evidence: ['league.md#standings'] });
    col.close('A1', b, 'all matchup totals equal their scoring-lineup sums' + (C.standingsPresent ? ' and standings' : ''));
}

function checkA2(col, S, C) {
    const b = col.findings.length;
    for (const T of C.teams.values()) {
        const cmp = T.cmpInternal;
        if (!cmp.totalsMatch || (!cmp.setsMatch && !cmp.tieEquivalent)) {
            const pts = id => { const P = C.players.get(String(id)); return P ? P.pointsStored : 0; };
            const zeroOnly = cmp.totalsMatch && [...cmp.onlyStored, ...cmp.onlyIndependent].every(id => pts(id) === 0);
            col.add('A2', {
                severity: zeroOnly ? 'INFO' : (C.allFinal ? 'FAIL' : 'WARN'), entity: teamEntity(T),
                internal: { stored_total: cmp.storedTotal, stored_ids: [...T.storedIds] }, expected: { total: cmp.independentTotal, only_independent: cmp.onlyIndependent, only_stored: cmp.onlyStored },
                explanation: `${T.owner}: stored scoring lineup (${cmp.storedTotal}) differs from the independent best lineup (${cmp.independentTotal}); only-stored=[${cmp.onlyStored}] only-independent=[${cmp.onlyIndependent}]${zeroOnly ? ' (only zero-point slots differ: harmless slot-assignment timing)' : (C.allFinal ? '' : ' (week in progress: may be live-update timing)')}.`,
                suggestedFix: 'Rerun scoringPlayersService.calculateScoringPlayers for the week; if it persists, the selection rule drifted from docs/SCORING_SYSTEM.md.',
                evidence: [teamAnchor(T)]
            });
        }
        if (T.activeCount > 0 && T.storedIds.size > 13) {
            col.add('A2', { severity: 'FAIL', entity: teamEntity(T), internal: { is_scoring_count: T.storedIds.size }, expected: { max: 13 }, explanation: `${T.owner} has ${T.storedIds.size} players marked is_scoring (max 13).`, evidence: [teamAnchor(T)] });
        }
    }
    col.close('A2', b, 'every stored scoring lineup equals the independent best lineup');
}

function checkA3(col, S, C) {
    const b = col.findings.length;
    let dstDeferred = 0;
    for (const P of C.players.values()) {
        if (!P.internal) continue;
        if (Math.abs(P.pointsInternal - P.pointsStored) > 0.005) {
            if (P.position === 'DST' && !C.allFinal) { dstDeferred++; continue; }
            col.add('A3', {
                severity: 'FAIL', entity: playerEntity(P),
                internal: { fantasy_points: P.pointsStored }, expected: { fantasy_points: P.pointsInternal, breakdown: P.breakdownInternal },
                explanation: `${P.name}: stored fantasy_points=${P.pointsStored} but the rubric applied to the stored stat columns gives ${P.pointsInternal}.`,
                suggestedFix: 'scoringService.calculateFantasyPoints or the recalc path drifted from docs/SCORING_SYSTEM.md; fix and recalc the week.',
                evidence: [playerAnchor(P)]
            });
        }
    }
    if (dstDeferred) col.add('A3', { severity: 'DEFER', explanation: `${dstDeferred} DST row(s) carry TD/safety stats but 0 fantasy_points; DST points are applied at end of week after bonuses - recheck when all games are final`, evidence: ['league.md#dst'] });
    col.close('A3', b, `rubric recompute matches stored fantasy_points on all ${[...C.players.values()].filter(p => p.internal).length} rows`);
}

// ---------------------------------------------------------------- B (touchdowns)

function playEntity(d, play, extra = {}) {
    return { type: 'play', id: `${d.gameId}#${play.idx}`, name: (play.tank01 && play.tank01.text) || (play.espn && play.espn.text) || null, gameId: d.gameId, ...extra };
}

/** The evidence bundle a question carries (plan contract "questions.json"). */
function questionEvidence(d, play, rule) {
    const drive = play.espn && play.espn.drive ? play.espn.drive : null;
    return {
        tank01Text: play.tank01 ? play.tank01.text : null,
        tank01ScoreDetails: play.tank01 ? play.tank01.scoreDetails : null,
        espnType: play.espn ? play.espn.typeText : null,
        espnText: play.espn ? play.espn.text : null,
        drive: drive ? { team: drive.team, result: drive.result, isTurnover: drive.isTurnover, startTeam: drive.startTeam, endTeam: drive.endTeam } : null,
        gamebook: drive ? drive.playText : null,
        gamebookParsed: play.gamebook || null,
        votes: play.votes || { drive: null, gamebook: null, text: null },
        votesAgree: play.votesAgree,
        period: play.period, clock: play.clock,
        scoringTeam: play.scoringTeam, opponent: play.defendingTeam,
        // the Team Defense that is credited if this is a defensive score: always the SCORING team's
        teamDefenseId: play.scoringTeam ? `DEF_${play.scoringTeam}` : null,
        scriptAwardClass: play.awardClass,
        scriptReasons: play.reasons || [],
        players: ((play.tank01 && play.tank01.players) || []).map(p => ({ id: p.id, name: p.name, pos: p.pos, team: p.team || null, roles: p.roles || [], draftable: !!p.draftable })),
        dbCredit: play.dbCredit || {},
        rule
    };
}

function tdFindings(col, S, C) {
    const b1 = col.findings.length;
    const rule = ruleText();
    for (const d of C.dossiers.values()) {
        const gf = gameFile(d.gameId);
        const game = S.gamesById.get(d.gameId);
        const inProgress = !(game && game.final);
        // Severity cap: a game still in progress (ESPN and Tank01 lag each other) is never a FAIL
        const cap = sev => (inProgress && sev === 'FAIL') ? 'WARN' : sev;
        const questionIds = new Map(); // play idx -> question id
        for (const play of d.plays) {
            if (play.kind !== 'TD' && play.kind !== 'SAFETY') continue;
            const ev = [playAnchor(d.gameId, play.idx)];
            const involved = (play.expectedCredits || []).map(c => C.players.get(c.player_id)).filter(Boolean);
            const rostered = involved.some(P => P.roster);
            const disagree = play.agreement === false;
            if (play.awardClass === 'AMBIGUOUS') {
                col.add('B4', {
                    severity: 'WARN', check: 'td_award_class', entity: playEntity(d, play),
                    internal: play.dbCredit, explanation: `Ambiguous scoring play needs adjudication: ${(play.reasons || []).join('; ')}`,
                    confidence: 'needs-ruling', evidence: ev
                });
                // A game still in progress raises no question: Tank01/ESPN lag each other and the play settles by itself.
                if (!inProgress) {
                    const qid = play.questionId || questionIdFor(S.season, S.week, d.gameId, play.idx);
                    questionIds.set(play.idx, qid);
                    col.ask({ id: qid, gameId: d.gameId, playIdx: play.idx, kind: 'td_award_class',
                        question: 'Who should be credited for this scoring play?',
                        evidence: questionEvidence(d, play, rule), relatedFindingIds: [col.last().id] });
                }
                continue;
            }
            if (play.kind === 'TD' && play.votesAgree === false) {
                // Classified (the block decided it) but the possession signals disagree: worth a second opinion.
                col.add('B4', {
                    severity: 'WARN', check: 'td_vote_disagreement', entity: playEntity(d, play),
                    internal: play.dbCredit, expected: Object.fromEntries((play.expectedCredits || []).map(c => [`${c.player_id}.${c.column}`, `+${c.delta}`])),
                    explanation: `${play.awardClass} but the possession votes disagree (drive=${play.votes.drive || '-'} gamebook=${play.votes.gamebook || '-'} text=${play.votes.text || '-'}); confirm the award.`,
                    confidence: 'needs-ruling', evidence: ev
                });
                if (!inProgress) {
                    const qid = play.questionId || questionIdFor(S.season, S.week, d.gameId, play.idx);
                    questionIds.set(play.idx, qid);
                    col.ask({ id: qid, gameId: d.gameId, playIdx: play.idx, kind: 'td_award_class',
                        question: `The script classified this play ${play.awardClass} but its possession votes disagree. Who should be credited?`,
                        evidence: questionEvidence(d, play, rule), relatedFindingIds: [col.last().id] });
                }
            }
            if (!disagree) {
                for (const ex of play.exemptions || []) {
                    col.add('B3', { severity: 'INFO', check: 'td_exemption', entity: playEntity(d, play), explanation: ex, evidence: ev });
                }
                continue;
            }
            const ref = play.awardClass.startsWith('RETURN_20') ? 'B3' : play.awardClass === 'DEF_8_BLOCKED' ? 'B2'
                : (play.awardClass === 'OFF_PASS' || play.awardClass === 'OFF_RUSH') ? 'T1' : 'B1';
            const missing = (play.expectedCredits || []).filter(c => {
                const db = play.dbCredit && play.dbCredit[c.player_id];
                return !db || num(db[c.column]) < num(c.delta);
            });
            const nonDraftable = missing.length > 0 && missing.every(c => !S.players.has(String(c.player_id)));
            if (nonDraftable) {
                col.add(ref, { severity: 'INFO', check: 'td_exemption', entity: playEntity(d, play),
                    explanation: `${play.awardClass}: credit due to ${missing.map(c => c.player_id).join(', ')} who is not a draftable player in nfl_players (credited to nobody by design).`, evidence: ev });
                continue;
            }
            col.add(ref, {
                severity: cap(rostered ? 'FAIL' : 'WARN'), check: 'td_credit_missing',
                entity: playEntity(d, play, { fantasyTeamId: rostered ? involved.find(P => P.roster).roster.team_id : null, owner: rostered ? involved.find(P => P.roster).roster.owner : null }),
                internal: play.dbCredit, expected: Object.fromEntries((play.expectedCredits || []).map(c => [`${c.player_id}.${c.column}`, `+${c.delta}`])),
                explanation: `${play.awardClass}: ${(play.reasons || []).join('; ')}. Expected ${(play.expectedCredits || []).map(c => `${c.player_id}.${c.column}+${c.delta}`).join(', ')}; DB has ${JSON.stringify(play.dbCredit)}.`,
                suggestedFix: 'Fix scoringPlayParserService.categorizePlayType / individualPlayerScoringService for this play pattern, then recalc the season. Never edit the DB.',
                confidence: 'likely', evidence: ev
            });
        }
        // Over-credits: the DB has MORE TD/safety credit than the plays support (e.g. a DST paid for an offensive recovery)
        for (const disc of d.discrepancies || []) {
            if (!(num(disc.actual) > num(disc.expected))) continue;
            const P = C.players.get(String(disc.player_id));
            const rostered = !!(P && P.roster);
            const isDst = String(disc.player_id).startsWith('DEF_');
            const ref = isDst && /fumble/.test(disc.column) ? 'B1' : isDst && /blocked/.test(disc.column) ? 'B2' : /return_tds$/.test(disc.column) && !isDst ? 'B3' : isDst ? 'B1' : 'T1';
            // an unmatched/ambiguous play in the same game may account for the extra credit -> WARN, not FAIL
            const explained = !!disc.note;
            col.add(ref, {
                severity: cap(explained ? 'WARN' : (rostered ? 'FAIL' : 'WARN')), check: 'td_over_credit',
                entity: P ? playerEntity(P, d.gameId) : { type: isDst ? 'dst' : 'player', id: String(disc.player_id), name: disc.name, gameId: d.gameId },
                internal: { [disc.column]: disc.actual }, expected: { [disc.column]: disc.expected },
                explanation: `${disc.name || disc.player_id} is credited with ${disc.column}=${disc.actual} in ${d.gameId} but the scoring plays support only ${disc.expected}${disc.plays && disc.plays.length ? ` (plays ${disc.plays.join(', ')})` : ''}${disc.note ? `: ${disc.note}` : ''}.`,
                suggestedFix: 'The play parser credited the wrong side; fix scoringPlayParserService / dstManagementService for this pattern and recalc. Never edit the DB.',
                confidence: explained ? 'needs-ruling' : 'likely', evidence: (disc.plays || []).length ? disc.plays.map(i => playAnchor(d.gameId, i)) : [gf]
            });
            if (explained) {
                // "may be explained by ambiguous play(s) 3, 7": attach to those questions
                const m = String(disc.note).match(/ambiguous play\(s\) ([\d, ]+)/);
                const idxs = m ? m[1].split(',').map(x => parseInt(x.trim(), 10)).filter(Number.isFinite) : [];
                for (const idx of idxs) {
                    const qid = questionIds.get(idx);
                    if (qid) col.ask({ id: qid, relatedFindingIds: [col.last().id] });
                }
            }
        }
        // B2 extra: any /block/i play whose returner got 20
        for (const play of d.plays) {
            if (play.kind !== 'TD') continue;
            const txt = `${play.tank01 ? play.tank01.text : ''} ${play.espn ? play.espn.text : ''}`;
            if (!/block/i.test(txt)) continue;
            for (const [pid, cols] of Object.entries(play.dbCredit || {})) {
                if (num(cols.kick_return_tds) > 0 || num(cols.punt_return_tds) > 0) {
                    col.add('B2', { severity: cap('FAIL'), check: 'blocked_kick_as_return', entity: playEntity(d, play), internal: { [pid]: cols }, explanation: `Blocked-kick return TD credited as a 20-pt special-teams return to ${pid}; must be an 8-pt Team Defense TD.`, evidence: [playAnchor(d.gameId, play.idx)] });
                }
            }
        }
    }
    col.close('T1', b1, 'every offensive TD and 2-pt conversion is credited to the players on the play');
    col.close('B1', b1, 'every fumble-recovery / defensive TD is credited to the correct side');
    col.close('B2', b1, 'no blocked-kick return is scored as a 20-pt return');
    col.close('B3', b1, 'every kick/punt return TD is credited (or is a documented non-draftable exemption)');
    col.close('B4', b1, 'no ambiguous or lateral scoring plays; every possession vote agrees');
}

/**
 * B9 — every Final game's scoring plays (each source on its own) must
 * reproduce the final score, and no team defense may hold more safeties /
 * defensive TDs than the plays of the game can account for. A missing final
 * FG (short Tank01 play list) or a phantom safety (Tank01 DST field with no
 * play behind it) fails here deterministically.
 */
function checkB9(col, S, C) {
    const b = col.findings.length;
    let checked = 0;
    for (const g of S.weekGames) {
        if (!g.final) continue;
        const d = C.dossiers.get(g.game_id);
        if (!d || !d.scoreCheck) continue;
        const sc = d.scoreCheck;
        const gf = gameFile(g.game_id);
        const fin = sc.final;
        const label = (t) => `${g.away_team} ${t.away} – ${g.home_team} ${t.home}`;
        for (const src of ['tank01', 'espn']) {
            const t = sc[src];
            if (t.ok !== false) { if (t.ok === true) checked++; continue; }
            const extra = [];
            if (src === 'tank01' && d.unmatched && d.unmatched.espnOnly && d.unmatched.espnOnly.length) extra.push(`ESPN-only plays: ${d.unmatched.espnOnly.map(x => x.text || x.typeText).join(' | ')}`);
            if (src === 'espn' && d.unmatched && d.unmatched.tank01Only && d.unmatched.tank01Only.length) extra.push(`Tank01-only plays: ${d.unmatched.tank01Only.map(i => `play-${i}`).join(', ')}`);
            col.add('B9', {
                severity: 'FAIL', check: 'score_reconciliation',
                entity: { type: 'game', id: g.game_id, gameId: g.game_id },
                internal: { source: src, plays: t.plays, home: t.home, away: t.away }, expected: { home: fin.home, away: fin.away },
                explanation: `${src === 'tank01' ? 'Tank01' : 'ESPN'} scoring plays of ${g.game_id} sum to ${label(t)} (${t.plays} plays) but the final score is ${label(fin)}${extra.length ? `; ${extra.join('; ')}` : ''}.`,
                suggestedFix: src === 'tank01'
                    ? 'The cached Tank01 boxscore is incomplete or has a phantom play; refetch it (tank01Service boxscore quarantine) and resync the game, then recalc.'
                    : 'ESPN summary is incomplete (rerun without --offline) or a play is mis-typed; compare with the Tank01 list.',
                confidence: 'likely', evidence: [gf]
            });
        }
        // DST rows vs the plays: safeties and defensive TDs the DB holds must exist in the play lists.
        for (const team of [g.home_team, g.away_team]) {
            const pid = `DEF_${team}`;
            const db = d.dbTotals && d.dbTotals[pid];
            if (!db) continue;
            const safetiesInPlays = d.plays.filter(p => p.kind === 'SAFETY' && p.scoringTeam === team).length;
            const defTdCandidates = d.plays.filter(p => p.kind === 'TD' && p.scoringTeam === team
                && (String(p.awardClass).startsWith('DEF_8_') || (d.defensiveScores || []).some(x => x.playIdx === p.idx))).length;
            const storedSafeties = num(db.safeties);
            const storedDefTds = num(db.def_int_return_tds) + num(db.def_fumble_return_tds) + num(db.def_blocked_return_tds);
            const P = C.players.get(pid);
            if (storedSafeties > safetiesInPlays) {
                col.add('B9', {
                    severity: 'FAIL', check: 'score_reconciliation', entity: P ? playerEntity(P, g.game_id) : { type: 'dst', id: pid, nflTeam: team, gameId: g.game_id },
                    internal: { safeties: storedSafeties }, expected: { safeties: safetiesInPlays },
                    explanation: `${pid} is credited with safeties=${storedSafeties} in ${g.game_id} but ${safetiesInPlays === 0 ? 'neither source lists a safety' : `the plays list only ${safetiesInPlays}`} (phantom safety: the plays reproduce the final ${label(fin)} without it).`,
                    suggestedFix: 'dstManagementService: parsed safeties are authoritative (never fall through to Tank01 DST.safeties); resync the game and recalc.',
                    confidence: 'certain', evidence: [gf]
                });
            }
            if (storedDefTds > defTdCandidates) {
                col.add('B9', {
                    severity: 'FAIL', check: 'score_reconciliation', entity: P ? playerEntity(P, g.game_id) : { type: 'dst', id: pid, nflTeam: team, gameId: g.game_id },
                    internal: { def_int_return_tds: num(db.def_int_return_tds), def_fumble_return_tds: num(db.def_fumble_return_tds), def_blocked_return_tds: num(db.def_blocked_return_tds) },
                    expected: { defensive_tds_max: defTdCandidates },
                    explanation: `${pid} holds ${storedDefTds} defensive TD(s) in ${g.game_id} but only ${defTdCandidates} scoring play(s) by ${team} could be a takeaway or blocked kick.`,
                    suggestedFix: 'The play parser credited the defense for a same-possession TD; fix scoringPlayParserService / dstManagementService and recalc.',
                    confidence: 'likely', evidence: [gf]
                });
            }
        }
    }
    col.close('B9', b, `${checked} source play list(s) reproduce their final score; DST safeties/TDs are backed by plays`);
}

function checkB5(col, S, C) {
    const b = col.findings.length;
    for (const P of C.players.values()) {
        if (P.position !== 'DST' || !P.internal || !P.game || !P.game.final) continue;
        const g = P.game;
        const opp = g.home_team === P.nflTeam ? num(g.away_score) : num(g.home_score);
        const pa = P.internal.points_allowed;
        if (pa === null || pa === undefined || num(pa) !== opp) {
            col.add('B5', {
                severity: 'FAIL', entity: playerEntity(P), internal: { points_allowed: pa }, expected: { points_allowed: opp },
                explanation: `${P.player_id} points_allowed=${pa} but the opponent scored ${opp} in ${g.game_id}${num(pa) === 0 || pa === null ? ' (0-vs-missing bug class)' : ''}.`,
                suggestedFix: 'dstManagementService: use ?? not || for points allowed; resync the game and recalc.', evidence: [playerAnchor(P), gameFile(g.game_id)]
            });
        }
        const facts = C.espn.facts.get(g.game_id);
        if (facts && facts.totalYards) {
            const oppTeam = g.home_team === P.nflTeam ? g.away_team : g.home_team;
            const ya = facts.totalYards[oppTeam];
            if (ya !== undefined && num(P.internal.yards_allowed) !== num(ya)) {
                col.add('B5', {
                    // Tank01 and ESPN book team yardage differently at times; nothing for Joe to do unless the bonus flips (B6 covers that)
                    severity: 'INFO', entity: playerEntity(P), internal: { yards_allowed: P.internal.yards_allowed }, espn: { totalYards: ya }, expected: { yards_allowed: ya },
                    explanation: `${P.player_id} yards_allowed=${P.internal.yards_allowed} vs ESPN opponent total yards ${ya} (decides the least-yards bonus).`,
                    evidence: [playerAnchor(P), gameFile(g.game_id)]
                });
            }
        }
    }
    col.close('B5', b, 'every DST points_allowed equals the opponent score and yards_allowed matches ESPN');
}

function checkB6(col, S, C) {
    const b = col.findings.length;
    if (!C.allFinal) { col.add('B6', { severity: 'DEFER', explanation: `${C.finalCount}/${C.gameCount} games final - defensive bonuses are awarded at end of week`, evidence: ['league.md#dst'] }); col.close('B6', b, '', 'deferred'); return; }
    const exp = C.bonuses.expected;
    let sumP = 0, sumY = 0;
    for (const row of C.bonuses.pool) {
        const ep = num(exp.points.get(row.player_id)), ey = num(exp.yards.get(row.player_id));
        sumP += num(row.stored_points_bonus); sumY += num(row.stored_yards_bonus);
        const P = C.players.get(row.player_id);
        if (Math.abs(ep - num(row.stored_points_bonus)) > 0.01 || Math.abs(ey - num(row.stored_yards_bonus)) > 0.01) {
            col.add('B6', {
                severity: 'FAIL', entity: P ? playerEntity(P) : { type: 'dst', id: row.player_id },
                internal: { def_points_bonus: row.stored_points_bonus, def_yards_bonus: row.stored_yards_bonus, points_allowed: row.points_allowed, yards_allowed: row.yards_allowed },
                expected: { def_points_bonus: ep, def_yards_bonus: ey, min_points: exp.minPoints, min_yards: exp.minYards },
                explanation: `${row.player_id}: stored bonuses (${row.stored_points_bonus}/${row.stored_yards_bonus}) differ from recomputed (${ep}/${ey}) among ${C.bonuses.pool.length} rostered DSTs (min PA ${exp.minPoints}, min YA ${exp.minYards}).`,
                suggestedFix: 'Rerun scoringService.calculateDefensiveBonuses for the week once all games are final; if the pool differs, the roster filter drifted.',
                evidence: ['league.md#dst']
            });
        }
        if ((ep > 0 || ey > 0) && row.roster_position !== 'active') {
            col.add('B6', { severity: 'WARN', entity: P ? playerEntity(P) : { type: 'dst', id: row.player_id }, explanation: `${row.player_id} wins a defensive bonus while on ${row.roster_position} - the bonus pool includes non-active DSTs (calculateDefensiveBonuses has no roster_position filter).`, evidence: ['league.md#dst'] });
        }
    }
    if (C.bonuses.pool.length && (Math.abs(sumP - 5) > 0.02 || Math.abs(sumY - 5) > 0.02)) {
        col.add('B6', { severity: 'FAIL', internal: { sum_points_bonus: r2(sumP), sum_yards_bonus: r2(sumY) }, expected: { each: 5 }, explanation: `Stored defensive bonuses total ${r2(sumP)} (points) and ${r2(sumY)} (yards); each category must total exactly 5.0 once all games are final.`, evidence: ['league.md#dst'] });
    }
    col.close('B6', b, 'both defensive bonuses recompute exactly and total 5.0 each');
}

function checkB7(col, S, C) {
    const b = col.findings.length;
    for (const g of S.weekGames) {
        if (!g.final) continue;
        for (const t of [g.home_team, g.away_team]) {
            const P = C.players.get(`DEF_${t}`);
            if (!P || !P.internal) {
                col.add('B7', { severity: P && P.roster ? 'FAIL' : 'WARN', entity: { type: 'dst', id: `DEF_${t}`, nflTeam: t, gameId: g.game_id, fantasyTeamId: P && P.roster ? P.roster.team_id : null, owner: P && P.roster ? P.roster.owner : null }, explanation: `No player_stats row for DEF_${t} although ${g.game_id} is ${g.status}.`, suggestedFix: 'dstManagementService did not write this game; resync from cache and recalc.', evidence: [gameFile(g.game_id)] });
            }
        }
    }
    col.close('B7', b, 'both DST rows exist for every final game');
}

function checkB8(col, S, C) {
    const b = col.findings.length;
    for (const g of S.weekGames) {
        if (!g.final) continue;
        const score = num(g.home_score) + num(g.away_score);
        const box = S.boxscores.get(g.game_id);
        if (!box) { col.add('B8', { severity: 'WARN', entity: { type: 'game', id: g.game_id, gameId: g.game_id }, explanation: `No cached Tank01 boxscore for final game ${g.game_id}; scoring plays could not be checked.`, evidence: ['manifest.json'] }); continue; }
        const d = C.dossiers.get(g.game_id);
        const tank = d ? d.plays.filter(p => p.tank01).length : 0;
        if (score > 0 && tank === 0) {
            col.add('B8', { severity: 'FAIL', entity: { type: 'game', id: g.game_id, gameId: g.game_id }, internal: { scoring_plays: 0, score }, explanation: `${g.game_id} finished ${g.away_score}-${g.home_score} but the cached boxscore yields 0 scoring plays (parser swallowed an error or the boxscore is truncated).`, suggestedFix: 'scoringPlayParserService returns [] on any exception; inspect tank01_cache for this game.', evidence: [gameFile(g.game_id)] });
        }
        if (d && d.unmatched) {
            if (d.unmatched.espnOnly && d.unmatched.espnOnly.length) {
                col.add('B8', { severity: 'WARN', entity: { type: 'game', id: g.game_id, gameId: g.game_id }, espn: { only: d.unmatched.espnOnly }, explanation: `${d.unmatched.espnOnly.length} ESPN scoring play(s) have no Tank01 counterpart in ${g.game_id}: ${d.unmatched.espnOnly.map(x => x.text || x.typeText).join(' | ')}`, confidence: 'likely', evidence: [`${gameFile(g.game_id)}#unmatched`] });
            }
            if (d.unmatched.tank01Only && d.unmatched.tank01Only.length) {
                col.add('B8', { severity: 'WARN', entity: { type: 'game', id: g.game_id, gameId: g.game_id }, internal: { only: d.unmatched.tank01Only }, explanation: `${d.unmatched.tank01Only.length} Tank01 scoring play(s) have no ESPN counterpart in ${g.game_id} (nullified by penalty?).`, confidence: 'likely', evidence: [`${gameFile(g.game_id)}#unmatched`] });
            }
        }
    }
    col.close('B8', b, 'every final game has parsed scoring plays that reconcile with ESPN');
}

// ---------------------------------------------------------------- C

function checkC1(col, S, C) {
    const b = col.findings.length;
    for (const r of S.rosters) {
        const np = S.players.get(r.player_id);
        const isDst = r.player_position === 'DST' || String(r.player_id).startsWith('DEF_');
        if (!np) col.add('C1', { severity: 'FAIL', entity: { type: 'player', id: r.player_id, name: r.player_name, fantasyTeamId: r.team_id, owner: r.owner }, explanation: `Rostered player ${r.player_id} (${r.player_name}) is not in nfl_players.`, evidence: [playerIdAnchor(r.player_id)] });
        if (isDst && !/^DEF_[A-Z]{2,3}$/.test(r.player_id)) col.add('C1', { severity: 'FAIL', entity: { type: 'dst', id: r.player_id, fantasyTeamId: r.team_id, owner: r.owner }, explanation: `DST id ${r.player_id} is not DEF_XXX.`, evidence: ['league.md#rosters'] });
        if (!isDst && !/^\d+$/.test(String(r.player_id))) col.add('C1', { severity: 'FAIL', entity: { type: 'player', id: r.player_id, name: r.player_name, fantasyTeamId: r.team_id, owner: r.owner }, explanation: `Offensive player id ${r.player_id} is not a numeric Tank01/ESPN id.`, evidence: ['league.md#rosters'] });
    }
    for (const row of S.stats) {
        if (!S.players.has(row.player_id)) col.add('C1', { severity: 'WARN', entity: { type: 'player', id: row.player_id, name: row.name }, explanation: `player_stats row ${row.player_id} has no nfl_players row (position unknown; DST scoring would be skipped).`, evidence: [playerIdAnchor(row.player_id)] });
    }
    col.close('C1', b, 'all roster and stat ids resolve to nfl_players with the right id format');
}

function checkC2(col, S, C) {
    const b = col.findings.length;
    const weekGameIds = new Set(S.weekGames.map(g => g.game_id));
    for (const P of C.players.values()) {
        if (!P.internal) continue;
        const gid = P.internal.game_id;
        if (!gid) {
            if (P.hasStats) col.add('C2', { severity: 'WARN', entity: playerEntity(P, null), explanation: `${P.name} has non-zero stats but no game_id; the play->player evidence rule cannot be applied.`, evidence: [playerAnchor(P)] });
            continue;
        }
        if (!weekGameIds.has(gid)) { col.add('C2', { severity: 'FAIL', entity: playerEntity(P, gid), internal: { game_id: gid }, explanation: `${P.name}'s stat row points at ${gid}, which is not a week ${S.week} game.`, evidence: [playerAnchor(P)] }); continue; }
        if (P.espn && P.espn.gameId && P.espn.gameId !== gid) {
            col.add('C2', { severity: P.roster ? 'FAIL' : 'WARN', entity: playerEntity(P, gid), internal: { game_id: gid }, espn: { gameId: P.espn.gameId }, explanation: `${P.name} is credited in ${gid} but ESPN has him playing in ${P.espn.gameId} (wrong-player or wrong-game credit; name-collision class).`, evidence: [playerAnchor(P), gameFile(gid)] });
        }
        const g = S.gamesById.get(gid);
        if (g && P.nflTeam && g.home_team !== P.nflTeam && g.away_team !== P.nflTeam && !(P.espn && P.espn.gameId === gid)) {
            col.add('C2', { severity: 'WARN', entity: playerEntity(P, gid), internal: { game_id: gid, team: P.nflTeam }, explanation: `${P.name} (${P.nflTeam}) is credited in ${gid}, a game his team did not play (trade? stale nfl_players.team?).`, evidence: [playerAnchor(P)] });
        }
    }
    col.close('C2', b, 'every stat row is credited in the game the player actually played');
}

function checkC3(col, S, C) {
    const b = col.findings.length;
    if (!S.lastDailyUpdate) { col.close('C3', b, 'skipped (no last_daily_update)'); return; }
    const cutoff = Date.parse(S.lastDailyUpdate) - 3 * 86400000;
    const stale = [];
    for (const r of S.rosters) {
        const np = S.players.get(r.player_id);
        if (np && np.last_updated && Date.parse(np.last_updated) < cutoff && !String(r.player_id).startsWith('DEF_')) stale.push(`${r.player_name} (${np.last_updated})`);
    }
    if (stale.length) col.add('C3', { severity: 'WARN', explanation: `${stale.length} rostered player(s) not touched by the daily player sync in 3+ days: ${stale.slice(0, 20).join(', ')}${stale.length > 20 ? ', ...' : ''}`, suggestedFix: 'playerSyncService.normalizePosition may be dropping a position (the FB bug class); check pm2 logs for "Skipping player".', evidence: ['league.md#rosters'] });
    col.close('C3', b, 'all rostered players were refreshed by the daily sync');
}

// ---------------------------------------------------------------- D

function checkD1(col, S, C) {
    const b = col.findings.length;
    const canon = new Set(CANONICAL_TEAM_CODES);
    // RAW codes as stored (the snapshot canonicalizes its working copies; a live
    // 'WSH' row must still be seen here — the writer is the bug).
    const bad = new Map();
    const note = (src, code, row) => {
        if (!code || canon.has(code)) return;
        const k = `${src}:${code}`;
        if (!bad.has(k)) bad.set(k, []);
        bad.get(k).push(row);
    };
    for (const r of S.stats) note('player_stats.team', r.team_raw, { player_id: r.player_id, name: r.name, game_id: r.game_id });
    for (const r of S.rosters) note('weekly_rosters.player_team', r.player_team, { player_id: r.player_id, name: r.player_name, team_id: r.team_id, owner: r.owner });
    for (const g of S.weekGames) { note('nfl_games.home_team', g.home_team_raw ?? g.home_team, { game_id: g.game_id }); note('nfl_games.away_team', g.away_team_raw ?? g.away_team, { game_id: g.game_id }); }
    for (const [k, rows] of bad) {
        const n = rows.length;
        const examples = rows.slice(0, 5).map(r => r.game_id && !r.player_id ? r.game_id : `${r.name || r.player_id} ${r.player_id}${r.game_id ? ` in ${r.game_id}` : ''}`).join(', ');
        const one = n === 1 ? rows[0] : null;
        const entity = one && one.player_id
            ? { type: String(one.player_id).startsWith('DEF_') ? 'dst' : 'player', id: String(one.player_id), name: one.name, gameId: one.game_id || null, fantasyTeamId: one.team_id || null, owner: one.owner || null }
            : one && one.game_id ? { type: 'game', id: one.game_id, gameId: one.game_id }
                : { type: 'league', id: `team-codes-${slug(k)}` };
        col.add('D1', { severity: 'FAIL', check: 'team_code_raw', entity, internal: { [k]: n }, explanation: `Non-canonical team code ${k} (${n} row(s): ${examples}${n > 5 ? ', ...' : ''}); such rows silently fall out of game joins.`, suggestedFix: 'Wrap the writer in getTeamAbbreviation / normalizeTeamCode (server/utils/teamMappings.js) and resync the week.', evidence: ['league.md#team-codes'] });
    }
    const teamsWithGame = new Set(); for (const g of S.weekGames) { teamsWithGame.add(g.home_team); teamsWithGame.add(g.away_team); }
    const teamsInSeason = new Set(); for (const g of S.seasonGames) { teamsInSeason.add(g.home_team); teamsInSeason.add(g.away_team); }
    for (const r of S.rosters) {
        if (r.roster_position !== 'active') continue;
        const t = r.player_team;
        if (teamsWithGame.has(t)) continue;
        if (teamsInSeason.has(t)) continue; // bye week
        col.add('D1', { severity: 'FAIL', entity: { type: 'player', id: r.player_id, name: r.player_name, nflTeam: t, fantasyTeamId: r.team_id, owner: r.owner }, explanation: `${r.player_name}'s player_team '${t}' joins no nfl_games row this season - the Washington-players-invisible bug class.`, evidence: [playerIdAnchor(r.player_id)] });
    }
    col.close('D1', b, 'all team codes canonical; every rostered player joins the schedule (or is on bye)');
}

function checkD2(col, S, C) {
    const b = col.findings.length;
    for (const T of C.teams.values()) {
        const dsts = T.roster.filter(P => P.position === 'DST' && P.roster.roster_position === 'active');
        if (dsts.length < 2) col.add('D2', { severity: 'FAIL', entity: teamEntity(T), internal: { active_dsts: dsts.length }, expected: { min: 2 }, explanation: `${T.owner} has ${dsts.length} active Team Defense(s); the league requires 2 (docs/ROSTER.md).`, evidence: [teamAnchor(T)] });
    }
    const owners = new Map();
    for (const r of S.rosters) { if (!owners.has(r.player_id)) owners.set(r.player_id, []); owners.get(r.player_id).push(r.owner); }
    for (const [pid, os] of owners) if (os.length > 1) col.add('D2', { severity: 'FAIL', entity: { type: pid.startsWith('DEF_') ? 'dst' : 'player', id: pid }, internal: { owners: os }, explanation: `${pid} appears on ${os.length} rosters this week: ${os.join(', ')}.`, evidence: ['league.md#rosters'] });
    col.close('D2', b, 'every team has 2 active DSTs; no player is on two rosters');
}

// ---------------------------------------------------------------- E

function checkE1(col, S, C) {
    const b = col.findings.length;
    for (const T of C.teams.values()) {
        if (T.activeCount !== 19) col.add('E1', { severity: 'FAIL', entity: teamEntity(T), internal: { active: T.activeCount, ir: T.irCount }, expected: { active: 19 }, explanation: `${T.owner} has ${T.activeCount} active players in week ${S.week} (must be 19).`, suggestedFix: 'copyRostersToNextWeek guard / roster move left the team short; fix via the admin roster tools.', evidence: [teamAnchor(T)] });
    }
    if (C.teams.size !== 12) col.add('E1', { severity: 'FAIL', internal: { teams_with_rosters: C.teams.size }, expected: { teams: 12 }, explanation: `Only ${C.teams.size} teams have roster rows in week ${S.week} (the "week advanced with no rosters" bug class).`, evidence: ['league.md#rosters'] });
    for (const rc of S.rosterCounts) {
        if (rc.week >= S.week || rc.season < 2025) continue;
        if (rc.active !== 19) col.add('E1', { severity: 'WARN', entity: { type: 'team', id: String(rc.team_id), fantasyTeamId: rc.team_id }, internal: { week: rc.week, active: rc.active }, explanation: `Season-wide: team ${rc.team_id} had ${rc.active} active players in week ${rc.week}.`, evidence: ['league.md#season-invariants'] });
    }
    col.close('E1', b, '12 teams x 19 active players');
}

function checkE2(col, S, C) {
    const b = col.findings.length;
    const allowed = new Set(['active', 'injured_reserve']);
    const seen = new Map();
    for (const r of S.rosters) if (!allowed.has(r.roster_position)) seen.set(r.roster_position, (seen.get(r.roster_position) || 0) + 1);
    for (const [v, n] of seen) col.add('E2', { severity: S.season <= 2024 && v === 'DST' ? 'INFO' : 'FAIL', internal: { roster_position: v, rows: n }, explanation: `roster_position '${v}' on ${n} row(s); only active / injured_reserve exist (the legacy 'starter' bug class: such players never score).`, evidence: ['league.md#rosters'] });
    col.close('E2', b, 'roster_position values are all active/injured_reserve');
}

function checkE3(col, S, C) {
    const b = col.findings.length;
    for (const P of C.players.values()) {
        if (!P.roster || P.roster.roster_position !== 'injured_reserve') continue;
        if (P.hasStats) col.add('E3', { severity: 'WARN', entity: playerEntity(P), internal: P.internalSummary, explanation: `${P.name} is on IR for ${P.roster.owner} but has stats this week (${P.pointsStored} pts, not counted).`, evidence: [playerAnchor(P)] });
    }
    for (const ret of S.irReturns) {
        if (ret.weeksOnIr < 3) col.add('E3', { severity: 'WARN', entity: { type: 'player', id: ret.player_id, name: ret.player_name, fantasyTeamId: ret.team_id, owner: ret.owner }, internal: { weeks_on_ir: ret.weeksOnIr }, expected: { min: 3 }, explanation: `${ret.player_name} returned from IR after ${ret.weeksOnIr} week(s); the minimum is 3.`, evidence: ['league.md#rosters'] });
    }
    col.close('E3', b, 'IR players have no counted stats and served 3+ weeks');
}

function checkE4(col, S, C) {
    const b = col.findings.length;
    const changed = C.hashes.changed || [];
    for (const ch of changed) col.add('E4', { severity: 'WARN', entity: { type: 'league', id: `week-${ch.week}` }, internal: { previous: ch.previous, current: ch.current }, explanation: `Closed week ${ch.week} changed since the last double check (${ch.what}). Expected only after a deliberate recalc.`, evidence: ['league.md#season-invariants'] });
    col.close('E4', b, `${(C.hashes.checked || []).length} closed week(s) unchanged since last run${C.hashes.firstRun ? ' (baseline recorded)' : ''}`);
}

// ---------------------------------------------------------------- F

function checkF1(col, S, C) {
    const b = col.findings.length;
    const rows = S.matchups;
    const nonPlayoff = rows.filter(m => !num(m.is_playoff));
    const ids = [];
    for (const m of nonPlayoff) ids.push(m.team1_id, m.team2_id);
    const counts = new Map(); for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
    if (S.week <= 18 && rows.length === 0) {
        col.add('F1', { severity: S.week >= 13 ? 'DEFER' : 'FAIL', explanation: `No matchup rows for week ${S.week}${S.week >= 13 ? ' (playoff/week-18 format unresolved)' : ''}.`, evidence: ['league.md#matchups'] });
    } else {
        if (nonPlayoff.length !== 6) col.add('F1', { severity: S.week <= REGULAR_SEASON_WEEKS ? 'FAIL' : 'WARN', internal: { rows: nonPlayoff.length }, expected: { rows: 6 }, explanation: `Week ${S.week} has ${nonPlayoff.length} non-playoff matchup rows (expected 6).`, evidence: ['league.md#matchups'] });
        for (const T of C.teams.values()) {
            const n = counts.get(T.team_id) || 0;
            if (n !== 1) col.add('F1', { severity: S.week <= REGULAR_SEASON_WEEKS ? 'FAIL' : 'WARN', entity: teamEntity(T), internal: { appearances: n }, explanation: `${T.owner} appears ${n} time(s) in week ${S.week} matchups.`, evidence: ['league.md#matchups'] });
        }
        if (rows.length !== nonPlayoff.length) col.add('F1', { severity: 'INFO', internal: { playoff_rows: rows.length - nonPlayoff.length }, explanation: `${rows.length - nonPlayoff.length} is_playoff row(s) present in week ${S.week}.`, evidence: ['league.md#matchups'] });
    }
    if (S.template && S.week <= REGULAR_SEASON_WEEKS) {
        const want = new Set(S.template.map(p => [p.team1Id, p.team2Id].sort((a, c) => a - c).join('-')));
        const have = new Set(nonPlayoff.map(m => [m.team1_id, m.team2_id].sort((a, c) => a - c).join('-')));
        const missing = [...want].filter(x => !have.has(x)), extra = [...have].filter(x => !want.has(x));
        if (missing.length || extra.length) col.add('F1', { severity: 'FAIL', internal: { extra }, expected: { missing }, explanation: `Week ${S.week} pairings differ from the docs/MATCHUPS.md slot template: missing ${missing.join(', ') || 'none'}; extra ${extra.join(', ') || 'none'}.`, suggestedFix: 'node scripts/apply-season-matchups.js --season <year> (dry run first).', evidence: ['league.md#matchups'] });
    } else if (!S.template && S.week <= REGULAR_SEASON_WEEKS) {
        col.add('F1', { severity: 'INFO', explanation: `No reviewed draft order configured for ${S.season} in server/config/seasonMatchups.js; pairing template not checked.`, evidence: ['league.md#matchups'] });
    }
    col.close('F1', b, 'six matchups, each team once, pairings match the template');
}

function outcome(a, b) { if (Math.abs(a - b) < 0.001) return 'T'; return a > b ? 'W' : 'L'; }

function checkF34(col, S, C) {
    const b = col.findings.length;
    if (!C.standingsPresent) {
        col.add('F3', { severity: 'DEFER', explanation: `week ${S.week} standings not yet written (manual weekly update) - cumulative points deferred`, evidence: ['league.md#standings'] });
        col.add('F4', { severity: 'DEFER', explanation: `week ${S.week} standings not yet written - W/L/T deltas deferred`, evidence: ['league.md#standings'] });
        col.close('F3', b, '', 'deferred'); col.close('F4', b, '', 'deferred'); return;
    }
    for (const T of C.teams.values()) {
        const cur = C.standingsCur.get(T.team_id), prev = C.standingsPrev.get(T.team_id) || { wins: 0, losses: 0, ties: 0, cumulative_points: 0 };
        if (!cur) { col.add('F3', { severity: 'FAIL', entity: teamEntity(T), explanation: `No week ${S.week} standings row for ${T.owner}.`, evidence: ['league.md#standings'] }); continue; }
        const expCum = r2(num(prev.cumulative_points) + num(cur.points_for_week));
        if (Math.abs(expCum - num(cur.cumulative_points)) > 0.01) col.add('F3', { severity: 'FAIL', entity: teamEntity(T), internal: { cumulative_points: cur.cumulative_points }, expected: { cumulative_points: expCum }, explanation: `${T.owner}: cumulative ${cur.cumulative_points} != previous ${prev.cumulative_points} + week ${cur.points_for_week}.`, evidence: ['league.md#standings'] });
        const m = C.matchups.find(x => x.team1_id === T.team_id || x.team2_id === T.team_id);
        let want = { W: 0, L: 0, T: 0 };
        if (S.week <= REGULAR_SEASON_WEEKS && m) {
            const mine = m.team1_id === T.team_id ? m.stored1 : m.stored2, theirs = m.team1_id === T.team_id ? m.stored2 : m.stored1;
            want[outcome(mine, theirs)] = 1;
        }
        const got = { W: num(cur.wins) - num(prev.wins), L: num(cur.losses) - num(prev.losses), T: num(cur.ties) - num(prev.ties) };
        if (got.W !== want.W || got.L !== want.L || got.T !== want.T) col.add('F4', { severity: 'FAIL', entity: teamEntity(T), internal: got, expected: want, explanation: `${T.owner}: standings delta W/L/T ${got.W}/${got.L}/${got.T} but the matchup outcome implies ${want.W}/${want.L}/${want.T}${S.week > REGULAR_SEASON_WEEKS ? ' (playoff weeks are frozen)' : ''}.`, evidence: ['league.md#standings'] });
    }
    col.close('F3', b, 'cumulative points accumulate correctly'); col.close('F4', b, 'W/L/T deltas match matchup outcomes');
}

// ---------------------------------------------------------------- G

function checkG1(col, S, C) {
    const b = col.findings.length;
    const root = path.join(__dirname, '../../server');
    const hits = [];
    const walk = dir => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); if (f.isDirectory()) walk(p); else if (p.endsWith('.js')) { const src = fs.readFileSync(p, 'utf8'); src.split('\n').forEach((line, i) => { if (/(===?|!==?)\s*['"]Final['"]|['"]Final['"]\s*(===?|!==?)|status\s*=\s*['"]Final['"]/.test(line) && !/LIKE|startsWith|game_status|mock/i.test(line)) hits.push(`${path.relative(root, p)}:${i + 1}`); }); } } };
    try { walk(root); } catch (e) { /* ignore */ }
    if (hits.length) col.add('G1', { severity: 'WARN', internal: { hits }, explanation: `Exact-match 'Final' status comparisons in server/ (misses 'Final/OT'): ${hits.join(', ')}`, suggestedFix: "Use status LIKE 'Final%' / startsWith('Final').", evidence: ['checks.json'] });
    for (const g of S.weekGames) {
        const facts = C.espn.facts.get(g.game_id);
        if (facts && facts.completed && !g.final) col.add('G1', { severity: 'WARN', entity: { type: 'game', id: g.game_id, gameId: g.game_id }, internal: { status: g.status }, espn: { status: facts.statusName }, explanation: `ESPN says ${g.game_id} is complete but nfl_games.status is '${g.status}'.`, evidence: ['league.md#games'] });
    }
    col.close('G1', b, "no exact-match 'Final' comparisons; every ESPN-complete game is Final% internally");
}

function checkG2(col, S, C) {
    const b = col.findings.length;
    const unknown = new Map();
    for (const g of S.seasonGames) if (g.status && !STATUS_ALLOWLIST.some(re => re.test(g.status))) unknown.set(g.status, (unknown.get(g.status) || 0) + 1);
    for (const [s, n] of unknown) col.add('G2', { severity: 'WARN', internal: { status: s, games: n }, explanation: `Unknown nfl_games.status string '${s}' on ${n} game(s); status-dependent logic may misclassify it.`, evidence: ['league.md#games'] });
    col.close('G2', b, 'all game status strings are known');
}

function checkG3(col, S, C) {
    const b = col.findings.length;
    if (S.season !== S.currentSeason) { col.done('G3', 'INFO', `skipped: auditing ${S.season} while league_settings is on ${S.currentSeason}`); return; }
    for (const g of S.seasonGames) {
        if (g.week > S.currentWeek && g.status && !/^Scheduled$/i.test(g.status)) col.add('G3', { severity: 'FAIL', entity: { type: 'game', id: g.game_id, gameId: g.game_id }, internal: { week: g.week, status: g.status, current_week: S.currentWeek }, explanation: `${g.game_id} (week ${g.week}) is '${g.status}' while current_week is ${S.currentWeek}: the week was not advanced and live stats are not being collected.`, suggestedFix: 'Run the manual weekly update (advance the week) from the admin dashboard.', evidence: ['league.md#games'] });
    }
    col.close('G3', b, 'no games are live/final beyond current_week');
}

function checkG4(col, S, C) {
    const b = col.findings.length;
    if (S.week < 18 && !S.seasonGames.some(g => g.week === S.week + 1)) col.add('G4', { severity: 'WARN', explanation: `No nfl_games rows for week ${S.week + 1}; the Week Advance Deadline check has nothing to reason about.`, evidence: ['league.md#games'] });
    col.close('G4', b, 'next week schedule loaded');
}

// ---------------------------------------------------------------- I / NV

function checkI2(col, S, C) {
    const b = col.findings.length;
    for (const d of S.dupes.player_stats) col.add('I2', { severity: 'FAIL', entity: { type: 'player', id: d.player_id }, internal: d, explanation: `Duplicate player_stats rows for ${d.player_id} week ${d.week}.`, evidence: ['league.md#season-invariants'] });
    for (const d of S.dupes.weekly_rosters) col.add('I2', { severity: 'FAIL', entity: { type: 'player', id: d.player_id, fantasyTeamId: d.team_id }, internal: d, explanation: `Duplicate weekly_rosters rows for ${d.player_id} team ${d.team_id} week ${d.week}.`, evidence: ['league.md#season-invariants'] });
    for (const d of S.dupes.matchups) col.add('I2', { severity: 'FAIL', entity: { type: 'matchup', id: `${d.team1_id}-${d.team2_id}` }, internal: d, explanation: `Duplicate matchup ${d.team1_id} vs ${d.team2_id} in week ${d.week}.`, evidence: ['league.md#matchups'] });
    if (S.legacyReturnTds > 0) col.add('I2', { severity: 'FAIL', internal: { rows: S.legacyReturnTds }, explanation: `${S.legacyReturnTds} player_stats row(s) use the legacy return_tds column (scored x20 in addition to kick/punt_return_tds - double-count risk).`, evidence: ['league.md#season-invariants'] });
    col.close('I2', b, 'no duplicate rows; legacy return_tds unused');
}

function checkI3(col, S, C) {
    const b = col.findings.length;
    const now = Date.parse(S.nowIso);
    if (S.lastDailyUpdate) {
        const h = (now - Date.parse(S.lastDailyUpdate)) / 3600000;
        if (h > 26) col.add('I3', { severity: 'WARN', internal: { last_daily_update: S.lastDailyUpdate, hours: r2(h) }, explanation: `Last daily update was ${r2(h)} h ago (limit 26 h).`, evidence: ['manifest.json'] });
    }
    if (S.watchdog && S.watchdog.ts) {
        const m = (now - Date.parse(S.watchdog.ts)) / 60000;
        if (m > 15 && !S.maintenanceLock) col.add('I3', { severity: 'WARN', internal: { watchdog_ts: S.watchdog.ts, minutes: r2(m) }, explanation: `Live-scoring watchdog silent for ${r2(m)} min (see WATCHDOG.md).`, evidence: ['manifest.json'] });
        else if (S.watchdog.severity && S.watchdog.severity !== 'ok') col.add('I3', { severity: 'INFO', internal: { status: S.watchdog.status, summary: S.watchdog.summary }, explanation: `Watchdog currently reports ${S.watchdog.status} (${S.watchdog.severity}): ${S.watchdog.summary}`, evidence: ['manifest.json'] });
    }
    if (S.validation) {
        if (S.validation.season === S.season && S.validation.week === S.week && S.validation.overallStatus === 'FAIL') col.add('I3', { severity: 'WARN', internal: { validation: S.validation.overallStatus, runAt: S.validation.runAt }, explanation: `Weekly validation for this week reads FAIL (${S.validation.runAt}); see logs/weekly-validation-latest.json.`, evidence: ['manifest.json'] });
    }
    col.close('I3', b, 'daily update, watchdog and validation are fresh');
}

function checkNV(col, S, C) {
    const b = col.findings.length;
    if (!C.allFinal) { col.add('NV', { severity: 'DEFER', explanation: 'never-varies check runs only on a completed week', evidence: ['league.md#never-varies'] }); col.close('NV', b, '', 'deferred'); return; }
    const prior = S.nvPrior; // { column: [count per prior week] }
    for (const c of NV_COLUMNS) {
        const cur = num(S.nvCurrent[c]);
        const hist = (prior[c] || []).slice().sort((a, x) => a - x);
        if (hist.length < 2) continue;
        const median = hist[Math.floor(hist.length / 2)];
        if (hist.length < 4 || hist[0] === 0) continue; // only signals that have NEVER been zero this season
        if (cur === 0 && median > 0) col.add('NV', { severity: 'WARN', internal: { column: c, this_week: 0, prior_median: median, prior: hist }, explanation: `${c} is 0 this week but the season median is ${median}; a signal that never varies is a broken signal (parser/extractor may have gone dark).`, evidence: ['league.md#never-varies'] });
    }
    col.close('NV', b, 'all scoring signals vary as expected');
}

/**
 * Any finding that still needs a ruling and is not yet attached to a question
 * gets one: a play finding joins its play's question; anything else becomes a
 * 'finding_review' question (CONFIRMED / NOT_AN_ERROR).
 */
function questionsForNeedsRuling(col, S) {
    const attached = new Set(col.questions.flatMap(q => q.relatedFindingIds));
    for (const f of col.findings) {
        if (f.confidence !== 'needs-ruling' || attached.has(f.id)) continue;
        if (f.severity === 'INFO' || f.severity === 'DEFER') continue;
        const ent = f.entity || {};
        const game = ent.gameId ? S.gamesById.get(ent.gameId) : null;
        if (game && !game.final) continue; // settles by itself once the game is final
        if (ent.type === 'play' && /#\d+$/.test(String(ent.id))) {
            const idx = parseInt(String(ent.id).split('#').pop(), 10);
            const qid = questionIdFor(S.season, S.week, ent.gameId, idx);
            const q = col.questions.find(x => x.id === qid);
            if (q) { q.relatedFindingIds.push(f.id); continue; }
        }
        col.ask({
            id: `${S.season}-wk${String(S.week).padStart(2, '0')}-finding-${f.id}`, gameId: ent.gameId || null, playIdx: null, kind: 'finding_review',
            question: 'Is this finding a real error in the official record?',
            evidence: { finding: { id: f.id, check: f.check, bugClassRef: f.bugClassRef, severity: f.severity, entity: ent, internal: f.internal, espn: f.espn, expected: f.expected, explanation: f.explanation }, rule: ruleText() },
            options: ['CONFIRMED', 'NOT_AN_ERROR'], relatedFindingIds: [f.id]
        });
    }
}

function runChecks(S, C) {
    const col = new Collector(S);
    checkA1(col, S, C); checkA2(col, S, C); checkA3(col, S, C);
    checkStatsVsEspn(col, S, C); checkMatchupsVsEspn(col, S, C);
    tdFindings(col, S, C); checkB5(col, S, C); checkB6(col, S, C); checkB7(col, S, C); checkB8(col, S, C); checkB9(col, S, C);
    checkC1(col, S, C); checkC2(col, S, C); checkC3(col, S, C);
    checkD1(col, S, C); checkD2(col, S, C);
    checkE1(col, S, C); checkE2(col, S, C); checkE3(col, S, C); checkE4(col, S, C);
    checkF1(col, S, C); checkF34(col, S, C);
    checkG1(col, S, C); checkG2(col, S, C); checkG3(col, S, C); checkG4(col, S, C);
    checkI2(col, S, C); checkI3(col, S, C); checkNV(col, S, C);
    questionsForNeedsRuling(col, S);
    const order = Object.keys(CHECK_NAMES);
    col.checklist.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    const knownErrors = {
        matched: [...col.knownMatched],
        unmatched: col.knownErrors.filter(e => !col.knownMatched.has(e.id)).map(e => e.id)
    };
    // Every defensive score / candidate of the week, with its question id (if any)
    const questionById = new Map(col.questions.map(q => [q.id, q]));
    const defensiveScores = [];
    for (const d of C.dossiers.values()) {
        for (const x of d.defensiveScores || []) {
            // only questions actually raised (a game in progress raises none)
            defensiveScores.push({ ...x, questionId: x.questionId && questionById.has(x.questionId) ? x.questionId : null });
        }
    }
    return { findings: col.findings, checklist: col.checklist, knownErrors, questions: col.questions, defensiveScores };
}

module.exports = { runChecks, CHECK_NAMES, NV_COLUMNS, STATUS_ALLOWLIST, REGULAR_SEASON_WEEKS, teamAnchor, slug, playerAnchor, playerIdAnchor, gameFile, playAnchor, ruleText, optionsTable };
