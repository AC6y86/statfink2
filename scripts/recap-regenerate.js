#!/usr/bin/env node
'use strict';

/**
 * Rewrite ONE recap from the commissioner's feedback ("Give feedback and run
 * again" in the /admin Recaps reader; POST /api/admin/recaps/:season/:week/:slug/regenerate).
 *
 * Same pipeline as a weekly run, narrowed to one persona: headless claude
 * spawns one `weekly-standings-narrator` agent for that style with the
 * feedback quoted in its prompt (plus the week's digest and storylines and
 * the previous version), then one `recap-fact-checker` agent for that recap
 * alone. Both write into logs/recap-regenerate/{season}-week{NN}-{slug}/;
 * the live file under recaps/{season}/ is untouched until the draft passes
 * the fact-check, then swapped in atomically (the old version is kept next
 * to the draft). A draft that FAILS the fact-check is left in the scratch
 * dir and the current recap stays live. On a PASS the week's fact-check
 * report gets the new verdict for that recap and the recap's stale rating is
 * dropped (press Rate recaps to re-rate).
 *
 * Feedback accumulates: every submission for a recap is appended to
 * {workDir}/feedback.json (never pruned, identical resubmissions are
 * not duplicated), and every rewrite hands the narrator AND the fact-checker
 * the whole history, oldest first, with the rule that each instruction stays
 * binding unless a later one explicitly supersedes it. The fact-checker
 * fails a draft that ignores any instruction, alongside its factual checks.
 *
 * Progress and the result go to logs/status/recap-regenerate.json (the
 * reader polls it). Never emails, never commits, reads the DB not at all
 * (the digest must already exist - Generate the week first).
 *
 * Usage: node scripts/recap-regenerate.js --season Y --week N --slug S --feedback "..." [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { writeJobStatus } = require('./lib/jobStatus');
const { runClaude } = require('./lib/claudeHeadless');
const { readThemes } = require('../server/utils/recapThemes');
const recapRatings = require('../server/utils/recapRatings');
const {
    isValidSlug, isValidSeason, isValidWeek, weekPad, recapFilename, slugToDisplayName,
    parseFactcheckReport, factcheckSection, replaceFactcheckEntry, normaliseFeedback, NO_DRAFT_GRADES_RULE
} = require('../server/utils/recapFiles');

const REPO = path.join(__dirname, '..');
const RECAPS_ROOT = path.join(REPO, 'recaps');
const WORK_ROOT = path.join(REPO, 'logs', 'recap-regenerate');
const JOB = 'recap-regenerate';
const CLAUDE_TIMEOUT_MS = 20 * 60 * 1000;
const MIN_WORDS = 400; // the narrator's hard floor is 800; below this the draft is plainly broken
const FEEDBACK_HISTORY_FILE = 'feedback.json';
const FEEDBACK_HISTORY_VERSION = 1;
const BINDING_RULE = 'Every instruction below remains binding unless a later instruction explicitly supersedes it. Where two instructions conflict, the later one wins; everything else still applies. The recap must honour all of them together.';

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function parseArgs(argv) {
    const val = flag => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : null; };
    return {
        season: val('--season') ? parseInt(val('--season'), 10) : null,
        week: val('--week') ? parseInt(val('--week'), 10) : null,
        slug: val('--slug'),
        feedback: val('--feedback'),
        dryRun: argv.includes('--dry-run')
    };
}

/** Every path one rewrite touches. `root` = the recaps dir, `work` = the scratch dir. */
function paths(season, week, slug, { root = RECAPS_ROOT, work = WORK_ROOT } = {}) {
    const seasonDir = path.join(root, String(season));
    const data = path.join(seasonDir, 'data');
    const nn = weekPad(week);
    const workDir = path.join(work, `${season}-week${nn}-${slug}`);
    const liveStorylines = path.join(seasonDir, 'storylines.md');
    const snapshot = path.join(data, `week${nn}-storylines.md`);
    return {
        recap: path.join(seasonDir, recapFilename(season, week, slug)),
        digest: path.join(data, `week${nn}-digest.md`),
        storylines: fs.existsSync(snapshot) ? snapshot : liveStorylines,
        factcheck: path.join(data, `week${nn}-factcheck.md`),
        workDir,
        draft: path.join(workDir, 'recap.md'),
        draftReport: path.join(workDir, 'factcheck.md'),
        previous: path.join(workDir, 'previous.md'),
        feedbackHistory: path.join(workDir, FEEDBACK_HISTORY_FILE)
    };
}

function wordCount(text) {
    return String(text || '').split(/\s+/).filter(Boolean).length;
}

// ---------- feedback history: {workDir}/feedback.json ----------

/**
 * Read the accumulated feedback for one recap. Never throws: a missing file
 * is an empty history; an unreadable or malformed one is set aside as
 * feedback.corrupt.json (so nothing is silently lost) and treated as
 * empty. Entries that are not { feedback: non-empty string } are dropped.
 * Returns { season, week, slug, version, entries: [{ n, feedback, submittedAt, lastSubmittedAt, submissions }] }.
 */
function readFeedbackHistory(file, { season = null, week = null, slug = null } = {}) {
    const empty = { season, week, slug, version: FEEDBACK_HISTORY_VERSION, entries: [] };
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return empty; }
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
    const usable = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.entries);
    if (!usable) {
        log(`feedback history at ${file} is malformed - starting a fresh history (the old file is kept as ${path.basename(file).replace(/\.json$/, '')}.corrupt.json)`);
        try { fs.copyFileSync(file, file.replace(/\.json$/, '') + '.corrupt.json'); } catch (_) { /* best effort */ }
        return empty;
    }
    const entries = [];
    for (const e of parsed.entries) {
        if (!e || typeof e !== 'object' || typeof e.feedback !== 'string' || !e.feedback.trim()) continue;
        const submittedAt = typeof e.submittedAt === 'string' ? e.submittedAt : null;
        entries.push({
            n: entries.length + 1,
            feedback: e.feedback,
            submittedAt,
            lastSubmittedAt: typeof e.lastSubmittedAt === 'string' ? e.lastSubmittedAt : submittedAt,
            submissions: Number.isInteger(e.submissions) && e.submissions > 0 ? e.submissions : 1
        });
    }
    return { season: parsed.season ?? season, week: parsed.week ?? week, slug: parsed.slug ?? slug, version: FEEDBACK_HISTORY_VERSION, entries };
}

/**
 * Append one normalised submission (pure: returns a new history). Identical
 * text to an existing entry does not add an entry - that entry's submissions
 * count and lastSubmittedAt move instead, so a repeated click never repeats
 * a prompt instruction. Entries are only ever appended, never reordered.
 * Returns { history, entry, added }.
 */
function appendFeedback(history, feedback, now = new Date().toISOString()) {
    const text = String(feedback);
    const entries = (history && Array.isArray(history.entries) ? history.entries : []).map(e => ({ ...e }));
    let entry = entries.find(e => e.feedback === text);
    const added = !entry;
    if (entry) {
        entry.submissions = (entry.submissions || 1) + 1;
        entry.lastSubmittedAt = now;
    } else {
        entry = { n: entries.length + 1, feedback: text, submittedAt: now, lastSubmittedAt: now, submissions: 1 };
        entries.push(entry);
    }
    return { history: { ...(history || {}), version: FEEDBACK_HISTORY_VERSION, updatedAt: now, entries }, entry, added };
}

/** Atomic write (temp file + rename next to the target). Throws on failure - losing feedback silently is worse than a failed run. */
function writeFeedbackHistory(file, history) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(history, null, 2) + '\n');
    fs.renameSync(tmp, file);
}

/**
 * The feedback section of the prompt: the complete history oldest first,
 * each entry numbered, quoted verbatim and dated, the current submission
 * marked, under the rule that earlier instructions stay binding.
 * `feedback` is the current text; `feedbackHistory` the accumulated entries
 * (strings or { feedback, submittedAt }) - the current text is appended when
 * it is not already among them, so callers that pass only priors still work.
 */
function feedbackSection(feedback, feedbackHistory = []) {
    const entries = (Array.isArray(feedbackHistory) ? feedbackHistory : [])
        .map(e => (typeof e === 'string' ? { feedback: e } : e))
        .filter(e => e && typeof e.feedback === 'string' && e.feedback.trim());
    if (!entries.some(e => e.feedback === feedback)) entries.push({ feedback });
    const total = entries.length;
    const lines = [
        '## The commissioner\'s feedback (complete history for this recap, oldest first)',
        '',
        `The commissioner has given feedback on this recap ${total === 1 ? 'once' : `${total} times`}. ${BINDING_RULE}`
    ];
    entries.forEach((e, i) => {
        const tags = [];
        if (e.submittedAt) tags.push(`submitted ${e.submittedAt}`);
        if (e.feedback === feedback) tags.push('THIS submission - the reason for this rewrite');
        else tags.push('earlier - still binding');
        lines.push('', `### Feedback ${i + 1} of ${total}${tags.length ? ` (${tags.join('; ')})` : ''}`, '"""', e.feedback, '"""');
    });
    return lines.join('\n');
}

/** The narrator's prompt is written by claude from this; every fact the agent needs is spelled out here. */
function buildPrompt({ season, week, slug, styleName, description, feedback, feedbackHistory = [], p, previousFactcheck }) {
    const contract = 'The digest is your ONLY source of scores, records, standings, and player stats. Copy numbers verbatim. Do not query the database or invent statistics.';
    const complianceInstruction = 'Besides checking every factual claim against the digest as usual, check that the recap honours every commissioner instruction in the feedback block above (each remains binding unless a later instruction explicitly supersedes it; where two conflict, the later one wins). Any instruction that is not honoured makes the recap a FAIL, exactly as a critical factual error would. Record each unhonoured instruction as its own row in the same discrepancy table: Claim = "Feedback N: <the instruction, quoted>", Recap says = what the draft actually does instead (quote or describe the passage, or state that nothing in the draft addresses it), Digest says = "commissioner instruction - not honoured", Severity = Critical; count each such row as critical in the Summary line. Do not skip the factual verification because of a feedback failure, and do not skip the feedback check because the facts pass.';
    const lines = [
        `Rewrite ONE recap for the PFL fantasy football league, season ${season} week ${week}: the "${styleName}" style (slug: ${slug}). The commissioner read the current version and gave feedback; the new version must act on it. Run non-interactively: never ask questions, never pause for approval.`,
        '',
        feedbackSection(feedback, feedbackHistory),
        '',
        '## Step 1: the narrator',
        '',
        'Spawn ONE `weekly-standings-narrator` agent (Task tool). Its prompt must contain exactly:',
        `- Season ${season}, week ${week}, and its one style: "${styleName}" (style slug: ${slug})${description ? ` - ${description}` : ''}`,
        `- The absolute path to the digest: ${p.digest}`,
        `- The absolute path to the storylines file: ${p.storylines}`,
        `- The output path: ${p.draft}`,
        `- This contract, verbatim: "${contract}"`,
        `- This standing rule, verbatim: "${NO_DRAFT_GRADES_RULE}"`,
        `- The previous version of this recap is at ${p.previous}. Tell the agent to read it first so it knows what the commissioner reacted to, then write a fresh recap - not a light edit - that keeps what the feedback does not object to.`,
        '- The commissioner\'s feedback: the COMPLETE feedback block above, copied verbatim (every numbered entry in the same order, its quoted text, and the binding rule), marked as the reason for the rewrite. Every instruction in every entry must be acted on unless a later entry explicitly supersedes it.'
    ];
    if (previousFactcheck && previousFactcheck.verdict === 'FAIL') {
        lines.push('', '- Also tell the agent: "Your previous attempt contained these factual errors, which you must not repeat:" followed by this fact-check detail verbatim:', '', previousFactcheck.detail || '(no detail recorded)');
    }
    lines.push(
        '',
        '## Step 2: the fact-check',
        '',
        `After the narrator finishes, spawn ONE \`recap-fact-checker\` agent with the digest path (${p.digest}), the storylines path (${p.storylines}), exactly one recap path (${p.draft}), and the report output path ${p.draftReport}. The report must use the filename \`${recapFilename(season, week, slug)}\` in its headings and Summary line (the draft is that file's replacement).`,
        '',
        `Also give the fact-checker the same COMPLETE feedback block above, copied verbatim (every numbered entry in order, its quoted text, and the binding rule), followed by this instruction verbatim: "${complianceInstruction}"`,
        '',
        `Also give the fact-checker this standing rule verbatim: "${NO_DRAFT_GRADES_RULE}" Tell it that any draft-grade mention in the recap is recorded as its own Critical row (Claim = "Standing rule: no draft grades", Recap says = the offending passage quoted) and makes the recap a FAIL.`,
        '',
        '## Rules',
        '',
        `- Do NOT write, edit or delete ${p.recap} or anything else under ${path.dirname(p.recap)} - the caller swaps the draft in only after it passes inspection.`,
        `- Write only ${p.draft} and ${p.draftReport}. Do not run scripts, do not regenerate the digest, ledger or index.`,
        '- When both agents are done, reply with the single word DONE.'
    );
    return lines.join('\n');
}

/**
 * Do the rewrite. Everything with a side effect is injectable so the unit
 * tests never run claude or touch recaps/ or logs/:
 *   claude(args, opts) -> { exitCode, envelope, error }   (default: scripts/lib/claudeHeadless.runClaude)
 *   writeStatus(job, record)                               (default: scripts/lib/jobStatus.writeJobStatus)
 *   root / work                                            (default: recaps/ and logs/recap-regenerate/)
 * Returns { ok, error, verdict, critical, minor, detail, file, previous, claude } and never throws past the status write.
 * ok is false when the draft FAILED the fact-check (the current recap stays live; `detail` is the checker's finding).
 */
async function regenerateRecap({ season, week, slug, feedback, dryRun = false }, deps = {}) {
    const claude = deps.claude || runClaude;
    const writeStatus = deps.writeStatus || writeJobStatus;
    const started = Date.now();
    const fail = (error, extra = {}) => {
        log(`Regeneration failed: ${error}`);
        if (!dryRun) writeStatus(JOB, { status: 'critical', summary: `${season} week ${week} ${slug}: ${error}`.slice(0, 500), season, week, durationMs: Date.now() - started, link: '/admin/recaps', details: { slug, feedback, error, ...extra } });
        return { ok: false, error, ...extra };
    };

    if (!isValidSeason(season) || !isValidWeek(week)) return fail('invalid season or week');
    if (!isValidSlug(slug)) return fail('invalid style slug');
    let text;
    try { text = normaliseFeedback(feedback); } catch (err) { return fail(err.message); }
    const p = paths(season, week, slug, deps);
    if (!fs.existsSync(p.recap)) return fail(`no recap on disk at ${path.relative(deps.root || RECAPS_ROOT, p.recap)}`);
    if (!fs.existsSync(p.digest)) return fail(`no data digest for ${season} week ${week} - Generate the week first`);

    const themes = readThemes(season, week, deps.root || RECAPS_ROOT);
    const theme = themes && themes.themes.find(t => t.slug === slug);
    const styleName = theme ? theme.name : slugToDisplayName(slug);

    // The accumulated feedback for this recap, plus this submission (persisted below, before claude runs, so it survives a failed attempt)
    const { history, added } = appendFeedback(readFeedbackHistory(p.feedbackHistory, { season, week, slug }), text);
    const feedbackHistory = history.entries;

    // What the last attempt got wrong: a failed draft's report (still in the scratch dir - it was never swapped in), else the live report
    let previousFactcheck = null;
    try { const s = factcheckSection(fs.readFileSync(p.draftReport, 'utf8'), slug); if (s && s.verdict === 'FAIL') previousFactcheck = s; } catch (_) { /* no earlier draft */ }
    if (!previousFactcheck) { try { previousFactcheck = factcheckSection(fs.readFileSync(p.factcheck, 'utf8'), slug); } catch (_) { /* no report */ } }

    const prompt = buildPrompt({ season, week, slug, styleName, description: theme ? theme.description : '', feedback: text, feedbackHistory, p, previousFactcheck });
    const claudeArgs = ['-p', '--output-format', 'json', '--model', 'sonnet', '--max-turns', '40',
        '--allowedTools', 'Read', 'Write', 'Glob', 'Grep', 'Task', 'WebSearch', 'TodoWrite'];
    if (dryRun) {
        log(`Dry run for ${season} week ${week} ${slug} (${styleName}). Would run claude ${claudeArgs.join(' ')} with this prompt on stdin:`);
        console.log(prompt);
        return { ok: true, dryRun: true, prompt, claudeArgs, feedbackHistory };
    }

    // Scratch dir: the feedback history first (it must outlive whatever happens next), the previous version (the narrator reads it; kept as the undo copy), no stale draft
    try {
        fs.mkdirSync(p.workDir, { recursive: true });
        writeFeedbackHistory(p.feedbackHistory, history);
    } catch (err) { return fail(`could not save the feedback history: ${err.message}`); }
    log(`Feedback ${added ? `#${feedbackHistory.length} recorded` : 'already on file (identical to an earlier submission)'} - ${feedbackHistory.length} instruction set(s) go to the narrator and the fact-checker`);
    for (const f of [p.draft, p.draftReport]) { try { fs.unlinkSync(f); } catch (_) { /* none */ } }
    fs.copyFileSync(p.recap, p.previous);

    writeStatus(JOB, { status: 'running', summary: `rewriting ${styleName} for ${season} week ${week} from your feedback`, season, week, link: '/admin/recaps', details: { slug, styleName, feedback: text, feedbackCount: feedbackHistory.length, pid: process.pid, startedAt: new Date(started).toISOString() } });
    log(`Rewriting ${season} week ${week} ${slug} (${styleName}) from feedback: ${text.slice(0, 120).replace(/\n/g, ' ')}${text.length > 120 ? '…' : ''}`);
    const result = await claude(claudeArgs, { timeoutMs: CLAUDE_TIMEOUT_MS, input: prompt });
    const claudeInfo = { exitCode: result.exitCode, costUsd: result.envelope?.total_cost_usd ?? null, durationMs: result.envelope?.duration_ms ?? null, numTurns: result.envelope?.num_turns ?? null };
    if (result.error) return fail(result.error.slice(0, 500), { claude: claudeInfo });

    // Inspect the draft before anything on the live side changes
    let draft;
    try { draft = fs.readFileSync(p.draft, 'utf8'); } catch (_) { return fail('the narrator wrote no draft', { claude: claudeInfo }); }
    const words = wordCount(draft);
    if (words < MIN_WORDS) return fail(`draft is only ${words} words (need at least ${MIN_WORDS}) - kept the current version`, { claude: claudeInfo });

    let verdict = null;
    let counts = { critical: null, minor: null };
    let section = null;
    let reportProblem = null;
    let rawReport = null;
    try { rawReport = fs.readFileSync(p.draftReport, 'utf8'); }
    catch (err) { reportProblem = `no readable fact-check report at ${path.relative(REPO, p.draftReport)} (${err.message})`; }
    if (rawReport !== null) {
        try {
            const parsed = parseFactcheckReport(rawReport)[slug];
            section = factcheckSection(rawReport, slug);
            if (parsed) { verdict = parsed.verdict; counts = { critical: parsed.critical, minor: parsed.minor }; }
            else if (section) verdict = section.verdict;
            if (!verdict) reportProblem = `fact-check report at ${path.relative(REPO, p.draftReport)} has no parseable verdict for "${slug}"`;
        } catch (err) { reportProblem = `could not parse the fact-check report at ${path.relative(REPO, p.draftReport)} (${err.message})`; }
    }

    // Only a parseable PASS may go live: a FAIL, a missing/unreadable/unparseable report, or any other
    // verdict all fail closed, leaving the draft and its report in the scratch dir and the current recap,
    // live fact-check, and ratings untouched.
    if (verdict !== 'PASS') {
        const detail = section ? section.detail : '';
        const error = verdict === 'FAIL'
            ? `draft FAILED the fact-check (${counts.critical ?? '?'} critical, ${counts.minor ?? '?'} minor) - kept the current version`
            : `${reportProblem || 'fact-check produced no parseable verdict'} - kept the current version`;
        const summary = `${season} week ${week}: ${styleName} ${error}`;
        log(summary);
        writeStatus(JOB, { status: 'warning', summary, season, week, durationMs: Date.now() - started, link: '/admin/recaps',
            details: { slug, styleName, feedback: text, feedbackCount: feedbackHistory.length, verdict, critical: counts.critical, minor: counts.minor, words, kept: true, factcheck: detail, reportProblem, draft: path.relative(REPO, p.draft), previous: path.relative(REPO, p.previous), claude: claudeInfo, finishedAt: new Date().toISOString() } });
        return { ok: false, error, verdict, critical: counts.critical, minor: counts.minor, detail, words, kept: true, draft: p.draft, previous: p.previous, claude: claudeInfo };
    }

    // Swap in: write next to the live file, then rename (atomic on the same filesystem)
    const tmp = `${p.recap}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, draft.endsWith('\n') ? draft : `${draft}\n`);
    fs.renameSync(tmp, p.recap);

    // The week's fact-check report: this recap's new verdict (or, unchecked, nothing)
    if (verdict) {
        let report = '';
        try { report = fs.readFileSync(p.factcheck, 'utf8'); } catch (_) { /* first report */ }
        fs.mkdirSync(path.dirname(p.factcheck), { recursive: true });
        const updated = replaceFactcheckEntry(report, { season, week, slug, verdict, critical: counts.critical ?? 0, minor: counts.minor ?? 0, detail: section ? section.detail : '' });
        fs.writeFileSync(`${p.factcheck}.tmp`, updated);
        fs.renameSync(`${p.factcheck}.tmp`, p.factcheck);
    }

    // The old rating judged the old text: drop it (Rate recaps redoes the week)
    const ratings = recapRatings.readRatings(season, week, deps.root || RECAPS_ROOT);
    if (ratings && ratings.ratings[slug]) {
        delete ratings.ratings[slug];
        if (ratings.recommended === slug) ratings.recommended = null;
        recapRatings.writeRatings(ratings, deps.root || RECAPS_ROOT);
    }

    const out = { ok: true, verdict, critical: counts.critical, minor: counts.minor, words, file: p.recap, previous: p.previous, claude: claudeInfo };
    const summary = `${season} week ${week}: ${styleName} rewritten from your feedback (${words} words, fact-check ${verdict || 'not run'})`;
    log(summary);
    writeStatus(JOB, { status: 'ok', summary, season, week, durationMs: Date.now() - started, link: '/admin/recaps',
        details: { slug, styleName, feedback: text, feedbackCount: feedbackHistory.length, verdict, critical: counts.critical, minor: counts.minor, words, previous: path.relative(REPO, p.previous), claude: claudeInfo, finishedAt: new Date().toISOString() } });
    return out;
}

module.exports = {
    buildPrompt, feedbackSection, paths, wordCount, regenerateRecap, parseArgs,
    readFeedbackHistory, appendFeedback, writeFeedbackHistory,
    JOB, MIN_WORDS, FEEDBACK_HISTORY_FILE, BINDING_RULE
};

if (require.main === module) {
    const opts = parseArgs(process.argv.slice(2));
    if (!opts.season || !opts.week || !opts.slug || opts.feedback === null) {
        console.error('Usage: node scripts/recap-regenerate.js --season Y --week N --slug S --feedback "..." [--dry-run]');
        process.exit(2);
    }
    regenerateRecap(opts)
        .then(r => process.exit(r.ok ? 0 : 1))
        .catch(err => {
            log(`Fatal: ${err.message}`);
            writeJobStatus(JOB, { status: 'critical', summary: `${opts.season} week ${opts.week} ${opts.slug}: ${err.message}`.slice(0, 500), season: opts.season, week: opts.week, link: '/admin/recaps', details: { slug: opts.slug, error: err.message } });
            process.exit(1);
        });
}
