#!/usr/bin/env node
'use strict';

/**
 * Double Check — reconcile (Claude Opus answers the open questions).
 *
 * Usage:
 *   node scripts/doublecheck-reconcile.js <season> <week> [--workspace <dir>] [--model opus]
 *        [--dry-run] [--redo] [--quiet]
 *
 * Reads <workspace>/questions.json (written by scripts/doublecheck-data.js),
 * the existing <workspace>/resolutions.json and logs/doublecheck/rulings.json
 * (the commissioner's rulings, written by POST /api/admin/doublecheck/ruling).
 * For every question that has neither a ruling nor a resolution (all of them
 * with --redo) it builds one prompt — the league rule text from
 * docs/SCORING_SYSTEM.md verbatim, the award-class table from
 * docs/DOUBLECHECK.md, the question's evidence bundle, and a strict JSON
 * schema — and runs headless `claude -p --output-format json --model <model>
 * --max-turns 1` exactly like server/services/emailMoveParsingService.js
 * (120 s timeout, one retry when the answer fails schema validation). Verdicts
 * are appended to resolutions.json, then scripts/doublecheck-finalize.js
 * --script-only re-applies rulings > resolutions to the findings and rewrites
 * report.md / logs/doublecheck-latest.json.
 *
 * A ruling always wins: a question with a ruling is never sent to the model.
 * Nothing here touches the database or the network beyond the claude CLI.
 *
 * Exit codes: 0 every question is resolved or ruled (or nothing to do),
 * 1 at least one question could not be resolved after the retry, 2 bad args /
 * missing questions.json.
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { envWithClaude } = require('./lib/claudeHeadless');
const { QUESTION_OPTIONS, TD_COLUMNS, TWO_PT_COLUMNS, CLASS_CREDIT_COLUMNS } = require('./lib/tdDossier');
const { ruleText, optionsTable } = require('./lib/doublecheckChecks');

const REPO = path.join(__dirname, '..');
const DEFAULT_MODEL = process.env.DOUBLECHECK_RECONCILE_MODEL || 'opus';
const TIMEOUT_MS = 120000;
const CONFIDENCES = ['certain', 'likely', 'unsure'];
const CREDIT_COLUMNS = [...TD_COLUMNS, ...TWO_PT_COLUMNS];

const weekPad = w => String(w).padStart(2, '0');
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }
function rulingsFile() { return process.env.DOUBLECHECK_RULINGS_FILE || path.join(REPO, 'logs/doublecheck/rulings.json'); }

/** rulings.json is a map keyed by questionId (jobStatusService.saveRuling); tolerate arrays / {rulings}. */
function rulingsMap(raw) {
    if (!raw) return {};
    const list = Array.isArray(raw) ? raw : Array.isArray(raw.rulings) ? raw.rulings : null;
    if (list) return Object.fromEntries(list.filter(r => r && (r.questionId || r.id)).map(r => [r.questionId || r.id, r]));
    if (raw.rulings && typeof raw.rulings === 'object') return raw.rulings;
    return typeof raw === 'object' ? raw : {};
}

/** resolutions.json is { generatedAt, resolutions: { [questionId]: {...} } }; tolerate arrays. */
function resolutionsMap(raw) {
    if (!raw) return {};
    const list = Array.isArray(raw) ? raw : Array.isArray(raw.resolutions) ? raw.resolutions : null;
    if (list) return Object.fromEntries(list.filter(r => r && r.questionId).map(r => [r.questionId, r]));
    if (raw.resolutions && typeof raw.resolutions === 'object') return raw.resolutions;
    return {};
}

// ---------- prompt ----------

const SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['questionId', 'awardClass', 'credits', 'confidence', 'reasoning'],
    properties: {
        questionId: { type: 'string' },
        awardClass: { type: 'string', enum: '<one of the question options>' },
        credits: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['player_id', 'column', 'delta'],
            properties: { player_id: { type: 'string', description: 'a player id from evidence.players, or DEF_<team> for a team defense' }, column: { type: 'string', enum: CREDIT_COLUMNS }, delta: { type: 'integer' } } } },
        confidence: { type: 'string', enum: CONFIDENCES },
        reasoning: { type: 'string' }
    }
};

const INSTRUCTIONS = `You are the independent scoring auditor for the Peninsula Football League (PFL), a fantasy football league with custom rules. A deterministic script could not decide how one NFL scoring play must be credited under the league's rules. Decide it from the evidence below and answer with ONE JSON object only — no prose, no markdown fences.

HOW TO DECIDE
- The determining question is in the rule text: did the ball change possession on the play (interception, opponent's fumble, muffed kick recovered by the kicking team), or was the kick blocked? If yes, the Team Defense DEF_<scoring team> gets the touchdown (8 points): DEF_8_INT / DEF_8_FUMBLE / DEF_8_BLOCKED. A blocked kick is ALWAYS DEF_8_BLOCKED, never a 20-point return.
- Same possession: a kickoff or punt returned for a TD is RETURN_20_KICK / RETURN_20_PUNT (the individual returner, kick_return_tds / punt_return_tds; a returner who is not a draftable position (CB, S, LB...) is credited to nobody — give empty credits); a pass is OFF_PASS (passer passing_tds +1, receiver receiving_tds +1); a rush is OFF_RUSH (rusher rushing_tds +1); an offensive player recovering his own or a teammate's fumble (or an aborted snap) in or into the end zone is OFF_RECOVERY (recoverer rushing_tds +1; the Team Defense gets nothing even if ESPN labels it "Fumble Return Touchdown").
- Kicks: once a kickoff or punt is kicked, the kicking team is the coverage unit, not the offense. If the kicking team ends up with the ball for a TD (muffed kick, returner's fumble, or a kickoff it recovers in the end zone), that is a takeaway: DEF_8_FUMBLE, never OFF_RECOVERY. On kick plays ESPN's drive isTurnover is often false because ESPN opens the new drive with the kick, so trust the play text over the drive flag there.
- SAFETY_2: DEF_<scoring team> safeties +1. NOT_A_SCORE: the play was nullified or is not a scoring play (empty credits).
- Evidence: "votes" are three independent possession signals (drive = ESPN drive isTurnover / drive team; gamebook = NFL gamebook prose, where upper-case "RECOVERED by" / "INTERCEPTED by" marks a change of possession and lower-case "recovered by" a recovery by the team that had the ball; text = the scoring-play wording). ESPN's type label (espnType) is advisory only. "dbCredit" is what the database currently stores for the players and both defenses in this game — it is NOT evidence of what is correct.
- Team Defense credits (DEF_8_*, SAFETY_2) always go to evidence.teamDefenseId, the SCORING team's defense (DEF_<scoringTeam>). evidence.opponent is the team scored against; its defense is never credited for a score against it.
- Team ids: DEF_<canonical code> (e.g. DEF_HOU). NFL gamebook prose uses HST=HOU, ARZ=ARI, BLT=BAL, CLV=CLE, LA=LAR, WSH=WAS.
- credits must list every column the decided class implies (delta 1 each) using the player ids from evidence.players; questionId must be copied verbatim; awardClass must be one of the question's options.
- reasoning: at most three short sentences - the possession fact you relied on and the rule it triggers. Do not narrate every field of the evidence.
- confidence: "certain" when the evidence is unambiguous, "likely" when mild inference was needed, "unsure" when you would want the commissioner to look (an "unsure" answer is a good outcome; a confident wrong answer is the worst).`;

/**
 * One line of prior context when the live reviewer (scripts/live-review.js)
 * recorded a local-model vote for this play during the game; '' otherwise.
 */
function hintLine(question) {
    const q = question && question.hints && question.hints.qwen;
    if (!q || !q.awardClass) return '';
    const why = String(q.reasoning || '').replace(/\s+/g, ' ').trim().slice(0, 600) || 'no reasoning given';
    return `A local model (Qwen) voted ${q.awardClass} (${q.confidence || 'unknown confidence'}) during the game because: ${why}. Treat it as one more opinion, not evidence.`;
}

/**
 * Build the prompt for one question: rule text verbatim + options table +
 * evidence bundle + schema.
 */
function buildPrompt(question, { rule, options, season, week } = {}) {
    const ruleTxt = rule !== undefined ? rule : ruleText();
    const optTxt = options !== undefined ? options : optionsTable();
    const schema = { ...SCHEMA, properties: { ...SCHEMA.properties, awardClass: { type: 'string', enum: question.options || [...QUESTION_OPTIONS] } } };
    return [
        INSTRUCTIONS,
        '',
        `LEAGUE RULE (docs/SCORING_SYSTEM.md, verbatim):`,
        ruleTxt || '(rule text unavailable)',
        '',
        'AWARD CLASSES (docs/DOUBLECHECK.md):',
        optTxt || (question.options || QUESTION_OPTIONS).join(', '),
        '',
        `QUESTION ${question.id}${season ? ` (season ${season}, week ${week})` : ''}: ${question.question}`,
        `Game ${question.gameId || '?'}${question.playIdx ? `, play ${question.playIdx}` : ''}. Options: ${(question.options || QUESTION_OPTIONS).join(', ')}`,
        '',
        'EVIDENCE:',
        JSON.stringify(question.evidence || {}, null, 1),
        '',
        ...(hintLine(question) ? [hintLine(question), ''] : []),
        'OUTPUT JSON SCHEMA (follow exactly; all fields required):',
        JSON.stringify(schema, null, 1),
        '',
        'Respond with the JSON object only.'
    ].join('\n');
}

// ---------- validation ----------

/** Strip markdown fences if the model wrapped the JSON despite instructions. */
function extractJson(text) {
    let t = String(text === undefined || text === null ? '' : text).trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fence) t = fence[1].trim();
    if (!t.startsWith('{')) {
        const i = t.indexOf('{'), j = t.lastIndexOf('}');
        if (i >= 0 && j > i) t = t.slice(i, j + 1);
    }
    return JSON.parse(t);
}

/**
 * Validate a verdict against the schema and the question. Returns an array of
 * error strings (empty = valid).
 */
function validateResolution(res, question) {
    const errors = [];
    if (!res || typeof res !== 'object' || Array.isArray(res)) return ['result is not a JSON object'];
    const options = (question && question.options) || QUESTION_OPTIONS;
    if (question && res.questionId !== question.id) errors.push(`questionId must be "${question.id}"`);
    if (typeof res.awardClass !== 'string' || !options.includes(res.awardClass)) errors.push(`awardClass must be one of ${options.join('|')}`);
    if (!CONFIDENCES.includes(res.confidence)) errors.push(`confidence must be one of ${CONFIDENCES.join('|')}`);
    if (typeof res.reasoning !== 'string' || !res.reasoning.trim()) errors.push('reasoning must be a non-empty string');
    if (!Array.isArray(res.credits)) {
        errors.push('credits must be an array');
        return errors;
    }
    res.credits.forEach((c, i) => {
        if (!c || typeof c !== 'object') { errors.push(`credits[${i}] is not an object`); return; }
        if (typeof c.player_id !== 'string' || !c.player_id.trim()) errors.push(`credits[${i}].player_id must be a string`);
        if (!CREDIT_COLUMNS.includes(c.column)) errors.push(`credits[${i}].column must be one of ${CREDIT_COLUMNS.join('|')}`);
        if (!Number.isInteger(c.delta)) errors.push(`credits[${i}].delta must be an integer`);
    });
    if (errors.length) return errors;
    // Class <-> credits consistency (cheap, and it keeps a confused answer out of the record)
    const cls = res.awardClass;
    const cols = res.credits.map(c => c.column);
    const scoringTeam = question && question.evidence && question.evidence.scoringTeam;
    const defId = scoringTeam ? `DEF_${scoringTeam}` : null;
    if (cls === 'NOT_A_SCORE' && res.credits.length) errors.push('NOT_A_SCORE must have no credits');
    if (CLASS_CREDIT_COLUMNS[cls] && (cls.startsWith('DEF_8_') || cls === 'SAFETY_2')) {
        const want = CLASS_CREDIT_COLUMNS[cls];
        const hit = res.credits.find(c => c.column === want && (!defId || c.player_id === defId));
        if (!hit) errors.push(`${cls} must credit ${defId || 'DEF_<scoring team>'}.${want}`);
        if (res.credits.some(c => !c.player_id.startsWith('DEF_') && TD_COLUMNS.includes(c.column))) errors.push(`${cls} credits no individual player with a TD column`);
    }
    if ((cls === 'RETURN_20_KICK' || cls === 'RETURN_20_PUNT') && res.credits.length) {
        const want = CLASS_CREDIT_COLUMNS[cls];
        if (!cols.includes(want)) errors.push(`${cls} must credit ${want} (or nobody for a non-draftable returner)`);
        if (res.credits.some(c => c.player_id.startsWith('DEF_'))) errors.push(`${cls} credits no team defense`);
    }
    if (cls === 'OFF_PASS' && !(cols.includes('passing_tds') && cols.includes('receiving_tds'))) errors.push('OFF_PASS must credit passing_tds and receiving_tds');
    if ((cls === 'OFF_RUSH' || cls === 'OFF_RECOVERY') && !cols.includes('rushing_tds')) errors.push(`${cls} must credit rushing_tds`);
    if (cls.startsWith('OFF_') && res.credits.some(c => c.player_id.startsWith('DEF_') && TD_COLUMNS.includes(c.column))) errors.push(`${cls} credits no team defense`);
    return errors;
}

// ---------- claude -p ----------

/**
 * Default runner: headless Claude Code, prompt on stdin, JSON envelope on
 * stdout (same pattern as EmailMoveParsingService.HeadlessClaudeBackend).
 */
function runClaudeHeadless(prompt, { model = DEFAULT_MODEL, timeoutMs = TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn('claude', ['-p', '--output-format', 'json', '--model', model, '--max-turns', '1'], { env: envWithClaude(), stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`claude -p timed out after ${timeoutMs}ms`)); }, timeoutMs);
        proc.stdout.on('data', d => { stdout += d; });
        proc.stderr.on('data', d => { stderr += d; });
        proc.on('error', err => { clearTimeout(timer); reject(err); });
        proc.on('close', code => {
            clearTimeout(timer);
            if (code !== 0) return reject(new Error(`claude -p exited ${code}: ${stderr.slice(0, 500)}`));
            try {
                const envelope = JSON.parse(stdout);
                if (envelope.is_error) return reject(new Error(`claude -p error result: ${String(envelope.result).slice(0, 500)}`));
                resolve(envelope.result ?? '');
            } catch (e) {
                reject(new Error(`claude -p produced unparseable envelope: ${stdout.slice(0, 300)}`));
            }
        });
        proc.stdin.write(prompt);
        proc.stdin.end();
    });
}

// ---------- core ----------

/**
 * Answer every question that has no ruling and no resolution (or all, with
 * redo). `runClaude(prompt, {model})` -> Promise<string> is injectable.
 * Returns { resolutions (map, updated in place), resolved, skipped, failed }.
 */
async function reconcileQuestions({ questions, resolutions = {}, rulings = {}, runClaude = runClaudeHeadless, model = DEFAULT_MODEL, redo = false, dryRun = false, log = () => {}, season, week, rule, options }) {
    const out = { resolutions, resolved: [], skipped: [], failed: [], dryRun: [] };
    for (const q of questions || []) {
        if (rulings[q.id]) { out.skipped.push({ id: q.id, reason: `ruled ${rulings[q.id].awardClass}` }); continue; }
        if (resolutions[q.id] && !redo) { out.skipped.push({ id: q.id, reason: `already resolved ${resolutions[q.id].awardClass}` }); continue; }
        const prompt = buildPrompt(q, { rule, options, season, week });
        if (dryRun) { out.dryRun.push({ id: q.id, promptChars: prompt.length }); log(`[dry-run] ${q.id}: prompt ${prompt.length} chars`); continue; }
        let lastError = null;
        let verdict = null;
        for (let attempt = 1; attempt <= 2 && !verdict; attempt++) {
            const p = attempt === 1 ? prompt : `${prompt}\n\nREMINDER: your previous output was not valid for the schema (${lastError}). Output ONLY the JSON object.`;
            let raw;
            try { raw = await runClaude(p, { model }); } catch (e) { lastError = e.message; log(`${q.id}: attempt ${attempt} failed: ${e.message}`); continue; }
            try {
                const parsed = extractJson(raw);
                const errors = validateResolution(parsed, q);
                if (errors.length) { lastError = errors.join('; '); log(`${q.id}: attempt ${attempt} rejected: ${lastError}`); continue; }
                verdict = parsed;
            } catch (e) {
                lastError = `not JSON: ${e.message}`;
                log(`${q.id}: attempt ${attempt} produced invalid JSON`);
            }
        }
        if (!verdict) { out.failed.push({ id: q.id, error: lastError }); continue; }
        resolutions[q.id] = {
            questionId: q.id, awardClass: verdict.awardClass, credits: verdict.credits, confidence: verdict.confidence,
            reasoning: String(verdict.reasoning).slice(0, 4000), model, ts: new Date().toISOString()
        };
        out.resolved.push({ id: q.id, awardClass: verdict.awardClass, confidence: verdict.confidence });
        log(`${q.id}: ${verdict.awardClass} (${verdict.confidence})`);
    }
    return out;
}

// ---------- cli ----------

function parseArgs(argv) {
    const args = argv.slice(2);
    const positional = args.filter(a => !a.startsWith('--'));
    const value = f => { const i = args.indexOf(f); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
    const season = parseInt(positional[0], 10);
    const week = parseInt(positional[1], 10);
    return {
        season, week,
        workspace: value('--workspace') ? path.resolve(value('--workspace')) : path.join(REPO, 'logs', 'doublecheck', String(season), `week${weekPad(week)}`),
        model: value('--model') || DEFAULT_MODEL,
        dryRun: args.includes('--dry-run'),
        redo: args.includes('--redo'),
        quiet: args.includes('--quiet'),
        noFinalize: args.includes('--no-finalize'),
        valid: Number.isInteger(season) && Number.isInteger(week) && week >= 1
    };
}

async function main() {
    const opts = parseArgs(process.argv);
    const log = opts.quiet ? () => {} : msg => console.log(msg);
    if (!opts.valid) {
        console.error('Usage: node scripts/doublecheck-reconcile.js <season> <week> [--workspace <dir>] [--model opus] [--dry-run] [--redo] [--quiet]');
        process.exit(2);
    }
    const qFile = path.join(opts.workspace, 'questions.json');
    const qRaw = readJson(qFile);
    if (!qRaw) {
        console.error(`doublecheck-reconcile: no ${qFile} — run node scripts/doublecheck-data.js ${opts.season} ${opts.week} first.`);
        process.exit(2);
    }
    const questions = Array.isArray(qRaw) ? qRaw : Array.isArray(qRaw.questions) ? qRaw.questions : [];
    // Live-review hints survive the daily rewrite of questions.json in live-hints.json (keyed by question id).
    const liveHints = readJson(path.join(opts.workspace, 'live-hints.json'));
    if (liveHints && liveHints.hints && typeof liveHints.hints === 'object') {
        for (const q of questions) {
            const h = q && liveHints.hints[q.id];
            if (h && h.qwen && !(q.hints && q.hints.qwen)) q.hints = { ...(q.hints || {}), qwen: h.qwen };
        }
    }
    const resFile = path.join(opts.workspace, 'resolutions.json');
    const resolutions = resolutionsMap(readJson(resFile));
    const rulings = rulingsMap(readJson(rulingsFile()));

    const result = await reconcileQuestions({ questions, resolutions, rulings, model: opts.model, redo: opts.redo, dryRun: opts.dryRun, log, season: opts.season, week: opts.week });

    if (!opts.dryRun) {
        fs.mkdirSync(opts.workspace, { recursive: true });
        fs.writeFileSync(resFile, JSON.stringify({ generatedAt: new Date().toISOString(), season: opts.season, week: opts.week, model: opts.model, resolutions }, null, 2));
        if (!opts.noFinalize) {
            const finArgs = [path.join(REPO, 'scripts/doublecheck-finalize.js'), String(opts.season), String(opts.week), '--script-only', '--quiet'];
            if (path.resolve(opts.workspace) !== path.join(REPO, 'logs', 'doublecheck', String(opts.season), `week${weekPad(opts.week)}`)) finArgs.push('--workspace', opts.workspace);
            const fin = spawnSync(process.execPath, finArgs, { cwd: REPO, encoding: 'utf8', timeout: 5 * 60 * 1000, env: process.env });
            if (fin.status === 2) console.error(`doublecheck-finalize exit 2: ${(fin.stderr || fin.stdout).trim().split('\n').slice(-3).join(' | ')}`);
            else log(`finalize: exit ${fin.status}`);
        }
    }

    const total = questions.length;
    const open = questions.filter(q => !rulings[q.id] && !resolutions[q.id]).length;
    console.log(`Double check reconcile ${opts.season} week ${opts.week}: ${total} question(s); resolved now ${result.resolved.length}, skipped ${result.skipped.length}, failed ${result.failed.length}${opts.dryRun ? `, dry-run ${result.dryRun.length}` : ''}; still open ${open}`);
    for (const r of result.resolved) console.log(`  ${r.id}: ${r.awardClass} (${r.confidence})`);
    for (const f of result.failed) console.log(`  FAILED ${f.id}: ${f.error}`);
    const unsure = result.resolved.filter(r => r.confidence === 'unsure').length;
    if (unsure) console.log(`  ${unsure} verdict(s) are unsure — they need your ruling on /admin/status`);
    if (!opts.dryRun) console.log(`  resolutions: ${resFile}`);
    process.exitCode = result.failed.length ? 1 : 0;
}

if (require.main === module) {
    main().catch(err => {
        console.error(`doublecheck-reconcile fatal: ${err.message}`);
        process.exit(2);
    });
}

module.exports = { buildPrompt, hintLine, validateResolution, reconcileQuestions, extractJson, runClaudeHeadless, rulingsMap, resolutionsMap, parseArgs, INSTRUCTIONS, SCHEMA, DEFAULT_MODEL };
