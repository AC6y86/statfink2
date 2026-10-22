'use strict';

/**
 * Live play review — pure logic (no I/O, no network, no DB). Driven by
 * scripts/live-review.js every 5 minutes during game windows.
 *
 *   selectGames(games, live, now)      games worth reviewing this tick
 *   inWindow(games, live, now)         is anything live (or just finished)?
 *   playKey(gameId, play)              dedupe key across ticks
 *   newPlays(dossier, state)           TD / SAFETY plays not yet in state
 *   prioritize(plays)                  defensive candidates first
 *   compareVotes({ play, qwen })       confirmed | under review | miscredit suspected
 *   toQuestion(play, gameId, season, week, qwen, { rule })
 *   buildReviewPrompt(play, gameId, { rule, options, season, week })
 *   summarize(reviews)                 job-status colour + summary line
 *   mergeQuestions(existingJson, newQuestions)
 *
 * Status colours follow the call-to-action rule: only "under review" and
 * "miscredit suspected" turn the job yellow. "Qwen unreachable" is information.
 */

const { QUESTION_OPTIONS, questionIdFor } = require('./tdDossier');
const reconcile = require('../doublecheck-reconcile');

const HOUR = 3600 * 1000;
const MINUTE = 60 * 1000;
const LIVE_WINDOW_BEFORE_MS = 4 * HOUR;     // kickoff up to 4 h ago
const LIVE_WINDOW_AHEAD_MS = 15 * MINUTE;   // kickoff within the next 15 min
const POST_FINAL_TAIL_MS = 90 * MINUTE;     // a Final game's boxscore may still be settling
const STATE_RETENTION_MS = 7 * 24 * HOUR;

const STATUS = Object.freeze({ CONFIRMED: 'confirmed', UNDER_REVIEW: 'under review', SUSPECTED: 'miscredit suspected' });
const DEFENSIVE_TEXT_RE = /intercept|fumble|recover|block|muff|safety/i;

const isFinal = s => /^Final/i.test(String(s || ''));
const isScheduled = s => /^(Scheduled|Not Started|Pregame)$/i.test(String(s || '').trim());
const pad2 = n => String(n).padStart(2, '0');

/** Epoch seconds / ms, ISO string, or SQLite "YYYY-MM-DD HH:MM:SS" (UTC) -> ms (NaN if unknown). */
function toMs(v) {
    if (v === null || v === undefined || v === '') return NaN;
    if (typeof v === 'number') return v < 1e11 ? v * 1000 : v;
    const s = String(v).trim();
    if (/^\d+(\.\d+)?$/.test(s)) return toMs(Number(s));
    if (/[TZ]/.test(s) || /[+-]\d\d:?\d\d$/.test(s)) return Date.parse(s);
    return Date.parse(s.replace(' ', 'T') + 'Z');
}

/**
 * Games to review this tick: every game in progress (status neither Final nor
 * Scheduled), a Scheduled game whose kickoff is inside the live window
 * (-4 h … +15 min), and a Final game whose last_updated is < 90 min old.
 */
function selectGames(games, live, now = Date.now()) {
    const out = [];
    for (const g of games || []) {
        if (!g) continue;
        const status = String(g.status || '');
        if (isFinal(status)) {
            const upd = toMs(g.last_updated);
            if (Number.isFinite(upd) && now - upd >= 0 && now - upd <= POST_FINAL_TAIL_MS) out.push(g);
            continue;
        }
        if (isScheduled(status) || !status) {
            const ko = toMs(g.game_time_epoch);
            if (Number.isFinite(ko) && ko >= now - LIVE_WINDOW_BEFORE_MS && ko <= now + LIVE_WINDOW_AHEAD_MS) out.push(g);
            continue;
        }
        out.push(g); // Live / Q1..OT / Halftime / Delayed ...
    }
    return out;
}

function inWindow(games, live, now = Date.now()) {
    if (selectGames(games, live, now).length) return true;
    return !!(live && Number(live.expectedGames) > 0);
}

function playKey(gameId, play) {
    return `${gameId}|${play.period}|${play.clock}|${play.scoringTeam}`;
}

const reviewable = p => p && (p.kind === 'TD' || p.kind === 'SAFETY');

/** TD / SAFETY plays of a dossier whose key is not in state.reviewed. */
function newPlays(dossier, state) {
    const reviewed = (state && state.reviewed) || {};
    const gameId = dossier && dossier.gameId;
    return ((dossier && dossier.plays) || []).filter(p => reviewable(p) && !reviewed[playKey(gameId, p)]);
}

function playText(play) {
    return (play.tank01 && play.tank01.text) || (play.espn && play.espn.text) || null;
}

/** A defensive score, a return, a recovery, or anything the rules found hard. */
function isDefensiveCandidate(play) {
    if (!play) return false;
    if (play.kind === 'SAFETY') return true;
    const cls = String(play.awardClass || '');
    if (cls.startsWith('DEF_8_') || cls.startsWith('RETURN_20') || cls === 'OFF_RECOVERY' || cls === 'AMBIGUOUS' || cls === 'SAFETY_2') return true;
    if (play.votesAgree === false || play.agreement === false) return true;
    const gamebook = play.espn && play.espn.drive ? String(play.espn.drive.playText || '') : '';
    return DEFENSIVE_TEXT_RE.test(`${playText(play) || ''} ${play.espn ? play.espn.typeText || '' : ''} ${gamebook}`);
}

/** Defensive candidates first (stable), so a tick budget spends Qwen where it matters. */
function prioritize(plays) {
    const a = [], b = [];
    for (const p of plays || []) (isDefensiveCandidate(p) ? a : b).push(p);
    return [...a, ...b];
}

/**
 * The comparison matrix (plan "Compare"):
 *   qwen null            -> deterministic only: agreement true -> confirmed; AMBIGUOUS -> under review;
 *                           agreement false -> miscredit suspected; otherwise confirmed
 *   qwen != script class -> under review;  script AMBIGUOUS -> under review
 *   agree, DB disagrees  -> miscredit suspected
 *   agree, DB agrees/n.a.-> confirmed
 */
function compareVotes({ play, qwen }) {
    const cls = play.awardClass;
    const agreement = play.agreement;
    if (!qwen || !qwen.awardClass) {
        if (cls === 'AMBIGUOUS') return { status: STATUS.UNDER_REVIEW, reason: 'the rules could not decide the play (no Qwen vote)' };
        if (agreement === false) return { status: STATUS.SUSPECTED, reason: `script says ${cls} but the DB credit differs (no Qwen vote)` };
        if (agreement === true) return { status: STATUS.CONFIRMED, reason: `script says ${cls} and the DB agrees (no Qwen vote)` };
        return { status: STATUS.CONFIRMED, reason: `script says ${cls}; DB credit not yet available (no Qwen vote)` };
    }
    if (cls === 'AMBIGUOUS') return { status: STATUS.UNDER_REVIEW, reason: `the rules could not decide the play; Qwen voted ${qwen.awardClass} (${qwen.confidence || '?'})` };
    if (qwen.awardClass !== cls) return { status: STATUS.UNDER_REVIEW, reason: `Qwen voted ${qwen.awardClass} (${qwen.confidence || '?'}) but the script says ${cls}` };
    if (agreement === false) return { status: STATUS.SUSPECTED, reason: `Qwen and the script agree on ${cls} but the DB credit differs` };
    if (agreement === true) return { status: STATUS.CONFIRMED, reason: `Qwen and the script agree on ${cls}; the DB agrees` };
    return { status: STATUS.CONFIRMED, reason: `Qwen and the script agree on ${cls}; DB credit not yet available` };
}

/** Same evidence bundle scripts/lib/doublecheckChecks.js questionEvidence() writes. */
function questionEvidence(play, rule) {
    const drive = play.espn && play.espn.drive ? play.espn.drive : null;
    const ev = {
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
        dbCredit: play.dbCredit || {}
    };
    if (rule !== undefined) ev.rule = rule;
    return ev;
}

function questionId(play, gameId, season, week) {
    if (play.questionId) return play.questionId;
    if (typeof questionIdFor === 'function') return questionIdFor(season, week, gameId, play.idx);
    return `${season}-wk${pad2(week)}-${gameId}-play-${play.idx}`;
}

/** A question in the shape Collector.ask writes, tagged source 'live-review' with the Qwen vote as a hint. */
function toQuestion(play, gameId, season, week, qwen, { rule } = {}) {
    const cls = play.awardClass;
    const question = cls === 'AMBIGUOUS'
        ? 'Who should be credited for this scoring play?'
        : play.votesAgree === false
            ? `The script classified this play ${cls} but its possession votes disagree. Who should be credited?`
            : `The script classified this play ${cls}${qwen && qwen.awardClass && qwen.awardClass !== cls ? ` but a local model voted ${qwen.awardClass} during the game` : ''}. Who should be credited?`;
    return {
        id: questionId(play, gameId, season, week),
        season, week, gameId, playIdx: play.idx ?? null,
        kind: 'td_award_class',
        question,
        evidence: questionEvidence(play, rule),
        options: [...QUESTION_OPTIONS],
        relatedFindingIds: [],
        source: 'live-review',
        hints: { qwen: qwen ? { awardClass: qwen.awardClass, credits: qwen.credits || [], confidence: qwen.confidence || null, reasoning: qwen.reasoning || null, model: qwen.model || null, ts: qwen.ts || null } : null }
    };
}

/**
 * The prompt Qwen votes on: the reconcile prompt (rule text verbatim + award
 * table + evidence + schema) for this play. The script's own verdict is left
 * out of the evidence so the vote is independent.
 */
function buildReviewPrompt(play, gameId, { rule, options, season, week } = {}) {
    const q = toQuestion(play, gameId, season, week, null);
    delete q.evidence.scriptAwardClass;
    delete q.evidence.scriptReasons;
    q.question = 'How must this scoring play be credited under the league rule?';
    return { question: q, prompt: reconcile.buildPrompt(q, { rule, options, season, week }) };
}

/** Job colour + one line. Only under-review / suspected plays are a call to action. */
function summarize(reviews) {
    const list = reviews || [];
    const confirmed = list.filter(r => r.status === STATUS.CONFIRMED).length;
    const underReview = list.filter(r => r.status === STATUS.UNDER_REVIEW).length;
    const suspected = list.filter(r => r.status === STATUS.SUSPECTED).length;
    const qwenUnreachable = list.filter(r => !r.qwen).length;
    const status = (underReview > 0 || suspected > 0) ? 'warning' : 'ok';
    const parts = [];
    if (!list.length) parts.push('no touchdowns or safeties to review yet');
    else {
        const bits = [`${confirmed} confirmed`];
        if (underReview) bits.push(`${underReview} under review`);
        if (suspected) bits.push(`${suspected} miscredit suspected`);
        parts.push(`${list.length} play(s) reviewed: ${bits.join(', ')}`);
    }
    if (qwenUnreachable && list.length) parts.push(qwenUnreachable === list.length ? 'Qwen unreachable (deterministic only)' : `Qwen unreachable for ${qwenUnreachable}`);
    return { confirmed, underReview, suspected, qwenUnreachable, status, summary: parts.join('; ') };
}

/**
 * Merge live-review questions into a questions.json object. Existing entries
 * win (the daily job's evidence is the fuller one); they only gain hints.
 */
function mergeQuestions(existingJson, newQuestions) {
    const base = existingJson && typeof existingJson === 'object' && !Array.isArray(existingJson) ? existingJson : {};
    const existing = Array.isArray(existingJson) ? existingJson : Array.isArray(base.questions) ? base.questions : [];
    const byId = new Map();
    for (const q of existing) if (q && q.id) byId.set(q.id, { ...q });
    for (const q of newQuestions || []) {
        if (!q || !q.id) continue;
        const cur = byId.get(q.id);
        if (!cur) { byId.set(q.id, { ...q }); continue; }
        const hints = { ...(cur.hints || {}), ...(q.hints || {}) };
        if (cur.hints && cur.hints.qwen && !(q.hints && q.hints.qwen)) hints.qwen = cur.hints.qwen;
        cur.hints = hints;
        if (!cur.source) cur.source = q.source;
        byId.set(q.id, cur);
    }
    return { ...base, generatedAt: base.generatedAt || new Date().toISOString(), questions: [...byId.values()] };
}

/**
 * Retire only live-review questions with a matching, later DB-confirmed review.
 * Keep commissioner rulings and independent daily findings in the active record.
 * The caller persists the returned evidence archive before removing active rows.
 */
function retireConfirmedQuestions(existingJson, reviews = [], rulings = {}, now = new Date().toISOString()) {
    const base = Array.isArray(existingJson) ? { questions: existingJson } : (existingJson || {});
    const active = [], retired = [];
    for (const q of base.questions || []) {
        const ev = q.evidence || {};
        const matches = reviews.filter(r =>
            Number(r.season) === Number(q.season) && Number(r.week) === Number(q.week) &&
            r.gameId === q.gameId && r.period === ev.period && r.clock === ev.clock &&
            r.scoringTeam === ev.scoringTeam);
        const r = matches.length === 1 ? matches[0] : null;
        const verifiedAt = r && (r.updatedTs || r.ts);
        const questionEvidenceAt = q.hints?.qwen?.ts;
        const later = Number.isFinite(Date.parse(verifiedAt)) &&
            (!questionEvidenceAt || Date.parse(verifiedAt) >= Date.parse(questionEvidenceAt));
        if (q.source === 'live-review' && !(q.relatedFindingIds || []).length && !rulings[q.id] &&
            ev.period && ev.clock && ev.scoringTeam && r && later &&
            r.status === STATUS.CONFIRMED && r.deterministic?.agreement === true &&
            r.deterministic.awardClass && r.deterministic.awardClass !== 'AMBIGUOUS') {
            retired.push({ question: q, resolvedAt: verifiedAt, archivedAt: now,
                reason: 'Latest live verification confirms the play and recorded scoring agree', review: r });
        } else active.push(q);
    }
    return { active: { ...base, questions: active }, retired };
}

/** Drop state entries older than the retention window. */
function pruneState(state, now = Date.now(), retentionMs = STATE_RETENTION_MS) {
    const reviewed = {};
    for (const [k, v] of Object.entries((state && state.reviewed) || {})) {
        const t = Date.parse(v && v.ts);
        if (Number.isFinite(t) && now - t > retentionMs) continue;
        reviewed[k] = v;
    }
    return { ...(state || {}), reviewed };
}

/** The review record kept in state and rendered in latest.json. */
function reviewRecord({ play, gameId, season, week, qwen, qwenError, verdict, ts }) {
    return {
        key: playKey(gameId, play),
        gameId, season, week,
        playIdx: play.idx,
        kind: play.kind,
        period: play.period,
        clock: play.clock,
        text: playText(play),
        scoringTeam: play.scoringTeam,
        deterministic: {
            awardClass: play.awardClass,
            votes: play.votes || { drive: null, gamebook: null, text: null },
            votesAgree: play.votesAgree,
            agreement: play.agreement,
            expectedCredits: (play.expectedCredits || []).map(c => ({ player_id: c.player_id, column: c.column }))
        },
        dbCredit: play.dbCredit || {},
        qwen: qwen ? { awardClass: qwen.awardClass, credits: qwen.credits || [], confidence: qwen.confidence || null, reasoning: qwen.reasoning || null, latencyMs: qwen.latencyMs ?? null, model: qwen.model || null, ts: qwen.ts || ts } : null,
        qwenError: qwen ? null : (qwenError || null),
        status: verdict.status,
        reason: verdict.reason,
        ts
    };
}

module.exports = {
    STATUS, LIVE_WINDOW_BEFORE_MS, LIVE_WINDOW_AHEAD_MS, POST_FINAL_TAIL_MS, STATE_RETENTION_MS,
    selectGames, inWindow, playKey, newPlays, prioritize, isDefensiveCandidate, compareVotes,
    toQuestion, buildReviewPrompt, questionEvidence, summarize, mergeQuestions, retireConfirmedQuestions, pruneState, reviewRecord, toMs, playText
};
