#!/usr/bin/env node

/**
 * Double Check — finalize (the last step). See docs/DOUBLECHECK.md.
 *
 * Reads a workspace produced by scripts/doublecheck-data.js (manifest.json,
 * checks.json, questions.json), the verdicts of scripts/doublecheck-reconcile.js
 * (resolutions.json) and the commissioner's rulings
 * (logs/doublecheck/rulings.json), then:
 *
 *   1. validates every script finding against the Finding shape — invalid
 *      ones are dropped and listed in report.md, never silently;
 *   2. applies rulings > resolutions to the findings each question relates
 *      to: decided credits present in the DB ⇒ INFO "resolved"; decided
 *      credits missing from the DB ⇒ FAIL "CONFIRMED by <ruling|opus>";
 *      an "unsure" verdict (or no verdict) ⇒ stays WARN "needs your ruling";
 *   3. rolls up: FAIL > INCOMPLETE (any DEFER) > WARN > PASS;
 *   4. writes findings.json + report.md into the workspace and
 *      logs/doublecheck-latest.json (+ history, cap 52) with `questions`,
 *      `defensiveScores` and `scoreCheck` for the status page.
 *
 * Script-only is the default. `--with-units` re-enables the retired LLM
 * runbook path (agents/*.md unit outputs merged with the script findings).
 *
 * Nothing here touches fantasy_football.db, pm2, or the network (except the
 * optional Gmail send, never used from a cron path). Everything comes from
 * files on disk.
 *
 * Usage:
 *   node scripts/doublecheck-finalize.js <season> <week> [--workspace <dir>] [--rulings <file>]
 *        [--trigger manual|standings-rerun|calibration|daily] [--with-units] [--email] [--quiet]
 *
 * Env: DOUBLECHECK_STATUS_DIR overrides the directory of the latest/history
 * status files (default logs/); DOUBLECHECK_RULINGS_FILE overrides the rulings
 * file (default logs/doublecheck/rulings.json). Tests use both so they never
 * touch logs/.
 *
 * Exit codes: 0 PASS / WARN / INCOMPLETE, 1 FAIL, 2 error (bad args, missing
 * manifest/checks, unwritable workspace).
 */

const fs = require('fs');
const path = require('path');
const { CLASS_CREDIT_COLUMNS } = require('./lib/tdDossier');

const REPO = path.join(__dirname, '..');
const NOTIFY_EMAIL = 'joe.paley@gmail.com';
const HISTORY_CAP = 52;
const SCHEMA_VERSION = 1;

const SEVERITIES = ['FAIL', 'WARN', 'INFO', 'DEFER'];
const SEVERITY_RANK = { FAIL: 4, WARN: 3, DEFER: 2, INFO: 1 };
const ENTITY_TYPES = ['play', 'player', 'dst', 'team', 'matchup', 'game', 'league'];
const CONFIDENCES = ['certain', 'likely', 'needs-ruling'];
const TRIGGERS = ['manual', 'standings-rerun', 'calibration', 'daily', 'weekly-validate', 'reconcile', 'ruling'];
const BUG_CLASS_RE = /^[A-Z][A-Z0-9]{0,2}(\/[A-Z][A-Z0-9]{0,2})?$/; // A1, NV, LLM, F3/F4
const DISAGREE_PREFIX = /^DISAGREE:/;

// Parseable lines the LLM writes (formats are the contract in docs/DOUBLECHECK.md).
const TOTAL_LINE_RE = /^TOTAL:\s*stored=(NA|-?[\d.]+)\s+recomputed=(NA|-?[\d.]+)\s+espn=(NA|-?[\d.]+)\s+lineup=(MATCH|DIFF)\s*$/m;
const VERDICT_LINE_RE = /^VERDICT:\s*play-(\d+)\s+(AGREE|DISAGREE|NEEDS-RULING)\s+([A-Z0-9_]+)\s+(?:—|--|-)\s*(.*?)\s*$/gm;
const CHECK_LINE_RE = /^CHECK\s+([A-Z][A-Z0-9]{0,2}(?:\/[A-Z][A-Z0-9]{0,2})?):\s*(AGREE|DISAGREE)\s+(?:—|--|-)\s*(.*?)\s*$/gm;
const JSON_FENCE_RE = /```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;

// ---------- small helpers ----------
const weekPad = week => String(week).padStart(2, '0');
const statusDir = () => process.env.DOUBLECHECK_STATUS_DIR || path.join(REPO, 'logs');
const defaultRulingsFile = () => process.env.DOUBLECHECK_RULINGS_FILE || path.join(REPO, 'logs', 'doublecheck', 'rulings.json');
const uniq = arr => [...new Set(arr)];
const num = v => (v === 'NA' || v === undefined || v === null) ? null : Number(v);
const fmt = n => (n === null || n === undefined || Number.isNaN(n)) ? '?'
    : (Number.isInteger(n) ? String(n) : Number(n).toFixed(2).replace(/\.?0+$/, ''));
const md = s => String(s === undefined || s === null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readText(file) {
    try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
}

function readJsonOrNull(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function listWorkspaceFiles(dir) {
    const out = new Set();
    const walk = (abs, rel) => {
        let entries = [];
        try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) { return; }
        for (const e of entries) {
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) walk(path.join(abs, e.name), r);
            else out.add(r);
        }
    };
    walk(dir, '');
    return out;
}

// ---------- args ----------
function parseArgs(argv) {
    const args = argv.slice(2);
    const positional = args.filter(a => !a.startsWith('--'));
    const value = flag => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
    const season = parseInt(positional[0], 10);
    const week = parseInt(positional[1], 10);
    const trigger = value('--trigger') || 'manual';
    return {
        season, week,
        workspace: value('--workspace') ||
            path.join(REPO, 'logs', 'doublecheck', String(season), `week${weekPad(week)}`),
        rulingsFile: value('--rulings') || defaultRulingsFile(),
        email: args.includes('--email'),
        quiet: args.includes('--quiet'),
        // Script-only is the default: status comes from the script findings plus
        // rulings/resolutions. --with-units re-enables the retired LLM unit path
        // (agents/*.md); --script-only is accepted for compatibility.
        scriptOnly: !args.includes('--with-units'),
        trigger,
        valid: Number.isInteger(season) && Number.isInteger(week) && week >= 1 && TRIGGERS.includes(trigger)
    };
}

// ---------- extraction from agents/*.md ----------

/** Last fenced ```json block of a markdown string. Returns {found, raw, value, error}. */
function extractJsonBlock(markdown) {
    if (typeof markdown !== 'string') return { found: false, raw: null, value: null, error: 'no content' };
    let last = null;
    let m;
    JSON_FENCE_RE.lastIndex = 0;
    while ((m = JSON_FENCE_RE.exec(markdown)) !== null) last = m[1];
    if (last === null) return { found: false, raw: null, value: null, error: 'no fenced ```json block' };
    try {
        return { found: true, raw: last, value: JSON.parse(last), error: null };
    } catch (e) {
        return { found: true, raw: last, value: null, error: `json block unparseable: ${e.message}` };
    }
}

/** `TOTAL: stored=<n> recomputed=<n> espn=<n|NA> lineup=<MATCH|DIFF>` (team units). */
function parseTotalLine(markdown) {
    const m = TOTAL_LINE_RE.exec(markdown || '');
    if (!m) return null;
    return { stored: num(m[1]), recomputed: num(m[2]), espn: num(m[3]), lineup: m[4] };
}

/** `VERDICT: play-<n> <AGREE|DISAGREE|NEEDS-RULING> <awardClass> — <one line>` (game units). */
function parseVerdictLines(markdown) {
    const out = [];
    let m;
    VERDICT_LINE_RE.lastIndex = 0;
    while ((m = VERDICT_LINE_RE.exec(markdown || '')) !== null) {
        out.push({ play: parseInt(m[1], 10), verdict: m[2], awardClass: m[3], note: m[4] });
    }
    return out;
}

/** `CHECK <id>: <AGREE|DISAGREE> — <one line>` (league unit). Returns {id: {verdict, note}}. */
function parseCheckLines(markdown) {
    const out = {};
    let m;
    CHECK_LINE_RE.lastIndex = 0;
    while ((m = CHECK_LINE_RE.exec(markdown || '')) !== null) {
        out[m[1]] = { verdict: m[2], note: m[3] };
    }
    return out;
}

/**
 * Load every unit listed in manifest.units. A unit is `done` only when its
 * output file exists and its last json block parses to an array; otherwise
 * `missing` with a reason (and the run can never be PASS).
 */
function loadUnits(workspace, manifest) {
    const units = [];
    for (const u of manifest.units || []) {
        const output = u.output || `agents/${u.id}.md`;
        const text = readText(path.join(workspace, output));
        const unit = { id: u.id, input: u.input || null, output, status: 'missing', reason: null,
            rawFindings: [], markdown: text };
        if (text === null) {
            unit.reason = 'output file missing';
        } else {
            const block = extractJsonBlock(text);
            if (!block.found) unit.reason = block.error;
            else if (block.error) unit.reason = block.error;
            else if (!Array.isArray(block.value)) unit.reason = 'json block is not an array';
            else { unit.status = 'done'; unit.rawFindings = block.value; }
        }
        units.push(unit);
    }
    return units;
}

// ---------- validation ----------

function evidenceFileOk(ref, workspaceFiles) {
    if (typeof ref !== 'string' || !ref.trim()) return false;
    const file = ref.split('#')[0].replace(/^\.\//, '').trim();
    return file.length > 0 && workspaceFiles.has(file);
}

/**
 * Validate one finding against the Finding shape. `ctx` carries season/week,
 * a default source and an id sequence. Returns {ok, finding, errors}; the
 * returned finding is normalized (defaults filled, id generated if missing).
 */
function validateFinding(f, workspaceFiles, ctx = {}) {
    const errors = [];
    if (!f || typeof f !== 'object' || Array.isArray(f)) {
        return { ok: false, finding: null, errors: ['finding is not an object'] };
    }
    const entity = (f.entity && typeof f.entity === 'object') ? f.entity : null;
    if (typeof f.check !== 'string' || !f.check.trim()) errors.push('check missing');
    if (typeof f.bugClassRef !== 'string' || !BUG_CLASS_RE.test(f.bugClassRef)) errors.push('bugClassRef missing or malformed (A1..I3, NV, LLM)');
    if (!SEVERITIES.includes(f.severity)) errors.push(`severity must be one of ${SEVERITIES.join('|')}`);
    if (!entity || !ENTITY_TYPES.includes(entity.type)) errors.push(`entity.type must be one of ${ENTITY_TYPES.join('|')}`);
    if (typeof f.explanation !== 'string' || !f.explanation.trim()) errors.push('explanation missing');
    if (!Array.isArray(f.evidence) || f.evidence.length === 0) {
        errors.push('evidence must be a non-empty array of workspace file anchors');
    } else {
        const bad = f.evidence.filter(e => !evidenceFileOk(e, workspaceFiles));
        if (bad.length) errors.push(`evidence not found in workspace: ${bad.map(String).join(', ')}`);
    }
    if (errors.length) return { ok: false, finding: null, errors };

    const source = (typeof f.source === 'string' && f.source.trim()) ? f.source.trim() : (ctx.defaultSource || 'script');
    const isScript = source === 'script';
    const entityId = entity.id === undefined || entity.id === null ? '' : String(entity.id);
    let id = typeof f.id === 'string' && f.id.trim() ? f.id.trim() : null;
    if (!id) {
        const prefix = `${f.bugClassRef}-${ctx.season}-${ctx.week}-${entity.type}-${entityId || 'x'}`;
        ctx.seq = ctx.seq || {};
        ctx.seq[prefix] = (ctx.seq[prefix] || 0) + 1;
        id = `${prefix}-${ctx.seq[prefix]}`;
    }
    const finding = {
        id,
        check: f.check.trim(),
        bugClassRef: f.bugClassRef,
        severity: f.severity,
        flipsResult: f.flipsResult === true,
        entity: { ...entity, id: entityId },
        internal: f.internal && typeof f.internal === 'object' ? f.internal : {},
        espn: f.espn && typeof f.espn === 'object' ? f.espn : {},
        expected: f.expected && typeof f.expected === 'object' ? f.expected : {},
        explanation: f.explanation.trim(),
        source,
        confidence: CONFIDENCES.includes(f.confidence) ? f.confidence : (isScript ? 'certain' : 'likely'),
        suggestedFix: typeof f.suggestedFix === 'string' ? f.suggestedFix.trim() : '',
        evidence: f.evidence.map(String)
    };
    if (typeof f.disputes === 'string' && f.disputes.trim()) finding.disputes = f.disputes.trim();
    return { ok: true, finding, errors: [] };
}

// ---------- merge ----------

const groupKey = f => `${f.bugClassRef}|${f.entity.type}|${f.entity.id || ''}|${f.check}`;
const maxSeverity = list => list.reduce((best, s) => (SEVERITY_RANK[s] > SEVERITY_RANK[best] ? s : best), 'INFO');
const isDispute = f => f.severity === 'INFO' && DISAGREE_PREFIX.test(f.explanation);

/**
 * Merge script findings with LLM findings.
 *  - same (bugClassRef, entity.type, entity.id, check) from both → one finding,
 *    sources ['script','llm:<unit>',...], max severity; differing severities
 *    ⇒ confidence 'needs-ruling'.
 *  - LLM-only FAIL/WARN on a bug class the script checklist marks PASS ⇒
 *    confidence 'needs-ruling', disagreement 'llm-only'.
 *  - an LLM INFO finding whose explanation starts with "DISAGREE:" disputes the
 *    script finding with the same key (or the id named in `disputes`) ⇒ both
 *    kept, both tagged disagreement 'llm-disputes-script'.
 */
function mergeFindings(scriptFindings, llmFindings, checklist = []) {
    const groups = new Map();
    const disputes = [];
    const add = (f, side) => {
        const k = groupKey(f);
        if (!groups.has(k)) groups.set(k, { script: [], llm: [] });
        groups.get(k)[side].push(f);
    };
    for (const f of scriptFindings) add(f, 'script');
    for (const f of llmFindings) (isDispute(f) ? disputes.push(f) : add(f, 'llm'));

    const out = [];
    for (const [, g] of groups) {
        if (g.script.length && g.llm.length) {
            const all = [...g.script, ...g.llm];
            const merged = { ...g.script[0] };
            merged.sources = uniq(all.map(f => f.source));
            merged.severity = maxSeverity(all.map(f => f.severity));
            merged.flipsResult = all.some(f => f.flipsResult);
            merged.evidence = uniq(all.flatMap(f => f.evidence));
            merged.llmNotes = g.llm.map(f => ({ source: f.source, severity: f.severity, confidence: f.confidence, explanation: f.explanation }));
            const severities = uniq(all.map(f => f.severity));
            if (severities.length > 1) merged.confidence = 'needs-ruling';
            else if (g.llm.some(f => f.confidence === 'needs-ruling')) merged.confidence = 'needs-ruling';
            if (!merged.suggestedFix) merged.suggestedFix = (g.llm.find(f => f.suggestedFix) || {}).suggestedFix || '';
            out.push(merged);
        } else if (g.script.length) {
            for (const f of g.script) out.push({ ...f, sources: ['script'] });
        } else {
            const merged = { ...g.llm[0] };
            merged.sources = uniq(g.llm.map(f => f.source));
            merged.severity = maxSeverity(g.llm.map(f => f.severity));
            merged.flipsResult = g.llm.some(f => f.flipsResult);
            merged.evidence = uniq(g.llm.flatMap(f => f.evidence));
            if (g.llm.length > 1) {
                merged.llmNotes = g.llm.slice(1).map(f => ({ source: f.source, severity: f.severity, confidence: f.confidence, explanation: f.explanation }));
            }
            const row = checklist.find(c => c && c.id === merged.bugClassRef);
            if (row && row.status === 'PASS' && ['FAIL', 'WARN'].includes(merged.severity)) {
                merged.confidence = 'needs-ruling';
                merged.disagreement = 'llm-only';
            }
            out.push(merged);
        }
    }

    for (const d of disputes) {
        const key = groupKey(d);
        const target = out.find(f => f.sources.includes('script') &&
            ((d.disputes && f.id === d.disputes) || groupKey(f) === key));
        const dis = { ...d, sources: [d.source], disagreement: 'llm-disputes-script' };
        if (target) {
            target.disagreement = 'llm-disputes-script';
            target.confidence = 'needs-ruling';
            target.disputedBy = uniq([...(target.disputedBy || []), d.source]);
            dis.disputes = target.id;
        } else {
            dis.disputeNote = 'no matching script finding (same check/entity or `disputes` id)';
        }
        out.push(dis);
    }

    const rank = f => [
        f.flipsResult ? 0 : 1,
        -SEVERITY_RANK[f.severity],
        f.bugClassRef,
        f.entity.type,
        String(f.entity.id || ''),
        f.check
    ];
    out.sort((a, b) => {
        const ra = rank(a), rb = rank(b);
        for (let i = 0; i < ra.length; i++) {
            if (ra[i] < rb[i]) return -1;
            if (ra[i] > rb[i]) return 1;
        }
        return 0;
    });
    return out;
}

// ---------- questions, resolutions, rulings ----------

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

function questionsList(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw.questions)) return raw.questions;
    return [];
}

const NON_KICKER = p => !['K', 'PK', 'P'].includes(String(p.pos || '').toUpperCase());

/**
 * Credits a decided award class implies for a question, when the decision
 * itself carries none (a bare ruling). Defensive classes are deterministic;
 * offensive/return classes come from the players' roles on the play. Returns
 * null when they cannot be derived.
 */
function creditsForClass(awardClass, question, resolution) {
    if (resolution && resolution.awardClass === awardClass && Array.isArray(resolution.credits)) return resolution.credits;
    const ev = (question && question.evidence) || {};
    const team = ev.scoringTeam;
    const col = CLASS_CREDIT_COLUMNS[awardClass];
    if (awardClass === 'NOT_A_SCORE' || awardClass === 'NOT_AN_ERROR' || awardClass === 'CONFIRMED') return [];
    if (awardClass.startsWith('DEF_8_') || awardClass === 'SAFETY_2') return team ? [{ player_id: `DEF_${team}`, column: col, delta: 1 }] : null;
    const players = Array.isArray(ev.players) ? ev.players : [];
    const byRole = role => players.find(p => (p.roles || []).includes(role)) || null;
    const first = players.find(NON_KICKER) || null;
    if (awardClass === 'RETURN_20_KICK' || awardClass === 'RETURN_20_PUNT') {
        const r = byRole('returner') || first;
        if (!r) return null;
        return r.draftable === false ? [] : [{ player_id: String(r.id), column: col, delta: 1 }];
    }
    if (awardClass === 'OFF_PASS') {
        const passer = byRole('passer') || players[0] || null;
        const receiver = byRole('receiver') || (players.length > 1 ? players[1] : null);
        if (!passer || !receiver) return null;
        return [{ player_id: String(passer.id), column: 'passing_tds', delta: 1 }, { player_id: String(receiver.id), column: 'receiving_tds', delta: 1 }];
    }
    if (awardClass === 'OFF_RUSH' || awardClass === 'OFF_RECOVERY') {
        const r = byRole(awardClass === 'OFF_RUSH' ? 'rusher' : 'recoverer') || first;
        return r ? [{ player_id: String(r.id), column: 'rushing_tds', delta: 1 }] : null;
    }
    return null;
}

/** The decision for one question: a ruling beats a resolution. */
function decideQuestion(q, resolution, ruling) {
    if (ruling && ruling.awardClass) {
        return { source: 'ruling', by: ruling.by || 'admin', awardClass: ruling.awardClass, credits: Array.isArray(ruling.credits) ? ruling.credits : creditsForClass(ruling.awardClass, q, resolution),
            confidence: 'certain', reasoning: ruling.note || '', ts: ruling.ts || null };
    }
    if (resolution && resolution.awardClass) {
        return { source: resolution.model || 'opus', awardClass: resolution.awardClass, credits: Array.isArray(resolution.credits) ? resolution.credits : creditsForClass(resolution.awardClass, q, resolution),
            confidence: resolution.confidence || 'likely', reasoning: resolution.reasoning || '', ts: resolution.ts || null };
    }
    return null;
}

const dbHas = (db, c) => num((db[c.player_id] || {})[c.column]) >= num(c.delta);

/**
 * Apply rulings > resolutions to the findings. Mutates copies of the findings
 * and returns { findings, questions } where questions is the status list for
 * latest.json ({id, gameId, playIdx, question, resolution, ruling, status}).
 */
function applyDecisions(findings, questions, resolutions = {}, rulings = {}) {
    const byId = new Map(findings.map(f => [f.id, { ...f }]));
    const status = [];
    const relatedOf = new Map(); // finding id -> [question status entries]
    for (const q of questions) {
        const resolution = resolutions[q.id] || null;
        const ruling = rulings[q.id] || null;
        const decision = decideQuestion(q, resolution, ruling);
        const open = !decision || decision.confidence === 'unsure';
        const entry = {
            id: q.id, gameId: q.gameId || null, playIdx: q.playIdx ?? null, kind: q.kind || 'td_award_class', question: q.question,
            scoringTeam: q.evidence ? q.evidence.scoringTeam || null : null, text: q.evidence ? q.evidence.tank01Text || q.evidence.espnText || null : null,
            votes: q.evidence ? q.evidence.votes || null : null, scriptAwardClass: q.evidence ? q.evidence.scriptAwardClass || null : null,
            options: q.options || [], resolution, ruling, decision,
            status: ruling ? 'ruled' : (decision && !open ? 'resolved' : 'open'),
            relatedFindingIds: q.relatedFindingIds || []
        };
        if (decision) {
            const db = (q.evidence && q.evidence.dbCredit) || {};
            const credits = decision.credits;
            entry.creditsMissing = Array.isArray(credits) ? credits.filter(c => !dbHas(db, c)) : null;
            entry.creditsDerivable = Array.isArray(credits);
        }
        status.push(entry);
        for (const fid of entry.relatedFindingIds) {
            if (!relatedOf.has(fid)) relatedOf.set(fid, []);
            relatedOf.get(fid).push(entry);
        }
    }
    for (const [fid, entries] of relatedOf) {
        const f = byId.get(fid);
        if (!f) continue;
        f.questionIds = entries.map(e => e.id);
        const openOnes = entries.filter(e => e.status === 'open');
        const decided = entries.filter(e => e.status !== 'open');
        if (decided.length) {
            f.resolution = decided.map(e => e.resolution).find(Boolean) || null;
            f.ruling = decided.map(e => e.ruling).find(Boolean) || null;
        }
        if (openOnes.length) {
            const unsure = openOnes.filter(e => e.decision && e.decision.confidence === 'unsure');
            f.needsRuling = true;
            f.confidence = 'needs-ruling';
            if (f.severity === 'FAIL' || f.severity === 'WARN') f.severity = 'WARN';
            f.explanation = `${unsure.length ? `NEEDS YOUR RULING (${unsure.map(e => `${e.decision.source} unsure: ${e.decision.awardClass}`).join('; ')}): ` : 'NEEDS YOUR RULING: '}${f.explanation}`;
            continue;
        }
        // Every related question is decided. What does the decision say about THIS finding?
        const isOverCredit = f.check === 'td_over_credit';
        const isReview = entries.some(e => e.kind === 'finding_review');
        let confirmed = false;
        let note = '';
        const verdictOf = e => `${e.decision.awardClass}${e.decision.reasoning ? ` — ${e.decision.reasoning}` : ''}`;
        if (isReview) {
            const d = entries[0].decision;
            confirmed = d.awardClass === 'CONFIRMED';
            note = verdictOf(entries[0]);
        } else if (isOverCredit) {
            const col = Object.keys(f.internal || {})[0];
            const pid = String((f.entity || {}).id || '');
            const explained = decided.some(e => Array.isArray(e.decision.credits) && e.decision.credits.some(c => String(c.player_id) === pid && c.column === col));
            confirmed = !explained;
            note = decided.map(e => `play ${e.playIdx} ruled ${verdictOf(e)}`).join('; ');
        } else {
            const missing = decided.flatMap(e => e.creditsMissing || []);
            const underivable = decided.some(e => e.creditsDerivable === false);
            confirmed = missing.length > 0;
            note = decided.map(verdictOf).join('; ');
            if (missing.length) note += `; credits missing from the DB: ${missing.map(c => `${c.player_id}.${c.column}+${c.delta}`).join(', ')}`;
            if (underivable) { note += '; credits could not be derived from the ruling — verify by hand'; f.needsRuling = true; }
        }
        const rulingEntry = decided.find(e => e.decision.source === 'ruling');
        const src = rulingEntry ? 'ruling' : decided[0].decision.source;
        const who = `${src}${rulingEntry && rulingEntry.decision.by ? ` (${rulingEntry.decision.by})` : ''}`;
        if (!confirmed && !isReview && !isOverCredit && decided.some(e => e.creditsDerivable === false)) {
            // decided, but nobody can say which rows the class credits: keep it visible
            f.severity = 'WARN';
            f.confidence = 'needs-ruling';
            f.explanation = `DECIDED by ${who} (${note}) but the credits could not be derived from the play — verify by hand. ${f.explanation}`;
            f.decidedBy = src;
            continue;
        }
        if (confirmed) {
            f.severity = 'FAIL';
            f.confidence = src === 'ruling' ? 'certain' : 'likely';
            f.explanation = `CONFIRMED by ${who}: ${note}. ${f.explanation}`;
        } else {
            f.severity = 'INFO';
            f.confidence = src === 'ruling' ? 'certain' : 'likely';
            f.explanation = `resolved by ${who}: ${note}. ${f.explanation}`;
        }
        f.decidedBy = src;
    }
    return { findings: findings.map(f => byId.get(f.id) || f), questions: status };
}

// ---------- roll-up ----------

/**
 * Any FAIL → FAIL; else any WARN → WARN; else any DEFER → INCOMPLETE; else
 * PASS. A missing unit (or any extra incomplete reason) forbids PASS.
 */
function rollUp(findings, units = [], opts = {}) {
    const counts = { FAIL: 0, WARN: 0, INFO: 0, DEFER: 0, flips: 0 };
    for (const f of findings) {
        counts[f.severity] = (counts[f.severity] || 0) + 1;
        if (f.flipsResult) counts.flips++;
    }
    const missing = units.filter(u => u.status !== 'done').map(u => u.id);
    const incompleteReasons = [...(opts.incompleteReasons || [])];
    if (missing.length) incompleteReasons.push(`${missing.length} unit(s) missing: ${missing.join(', ')}`);

    let overallStatus;
    // FAIL > INCOMPLETE > WARN > PASS: an unfinished or deferred audit is never
    // reported as a mere WARN, and never as PASS.
    if (counts.FAIL > 0) overallStatus = 'FAIL';
    else if (counts.DEFER > 0 || incompleteReasons.length) overallStatus = 'INCOMPLETE';
    else if (counts.WARN > 0) overallStatus = 'WARN';
    else overallStatus = 'PASS';
    return { overallStatus, counts, missing, incompleteReasons };
}

// ---------- report ----------

function entityLabel(f) {
    const e = f.entity || {};
    let s = e.name || (e.id ? `${e.type} ${e.id}` : e.type);
    if (e.nflTeam) s += ` (${e.nflTeam})`;
    if (e.owner) s += ` — ${e.owner}`;
    else if (e.fantasyTeamId) s += ` — team ${e.fantasyTeamId}`;
    return s;
}

function expectedVsInternal(f) {
    const exp = f.expected || {}, int = f.internal || {}, espn = f.espn || {};
    // No `expected` given: compare internal against the ESPN line instead.
    const useEspn = !Object.keys(exp).length;
    const other = useEspn ? espn : exp;
    const keys = uniq([...Object.keys(other), ...Object.keys(int)]);
    if (!keys.length) return '';
    return keys.map(k => {
        const i = int[k] === undefined ? '?' : fmtVal(int[k]);
        const x = other[k] === undefined ? '?' : fmtVal(other[k]);
        return `${k}: internal ${i} → ${useEspn ? 'espn' : 'expected'} ${x}`;
    }).join('; ');
}

function fmtVal(v) {
    if (typeof v === 'number') return fmt(v);
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}

function findingLine(f) {
    const tags = [];
    if (f.flipsResult) tags.push('FLIPS RESULT');
    if (f.disagreement) tags.push(f.disagreement);
    if (f.confidence === 'needs-ruling') tags.push('needs-ruling');
    const diff = expectedVsInternal(f);
    return `- **${f.bugClassRef}** \`${f.check}\` — ${md(entityLabel(f))}${tags.length ? ` [${tags.join(', ')}]` : ''}` +
        `\n  ${md(f.explanation)}${diff ? `\n  ${md(diff)}` : ''}` +
        `\n  sources: ${(f.sources || [f.source]).join(', ')}; evidence: ${f.evidence.map(e => `\`${e}\``).join(', ')}` +
        (f.suggestedFix ? `\n  fix: ${md(f.suggestedFix)}` : '') +
        (f.llmNotes && f.llmNotes.length ? f.llmNotes.map(n => `\n  ${n.source} (${n.severity}): ${md(n.explanation)}`).join('') : '');
}

function findingSection(title, list, emptyText) {
    const lines = [`## ${title}`, ''];
    if (!list.length) lines.push(emptyText, '');
    else { for (const f of list) lines.push(findingLine(f)); lines.push(''); }
    return lines;
}

function ownerFromUnit(unit) {
    const m = /team-\d+-([^/]+)\.md$/.exec(unit.input || '');
    return m ? m[1] : '';
}

/**
 * Render report.md. `ctx` = { season, week, workspace, manifest, checks, units,
 * findings, rejected, roll, trigger, generatedAt }.
 */
function renderReport(ctx) {
    const { season, week, manifest = {}, checks = {}, units = [], findings = [], rejected = [], roll, trigger } = ctx;
    const counts = roll.counts;
    const done = units.filter(u => u.status === 'done');
    const missing = units.filter(u => u.status !== 'done');
    const L = [];

    L.push(`# Double Check — ${season} week ${week}: ${roll.overallStatus}`, '');
    L.push('## Summary', '');
    L.push('| field | value |', '|---|---|');
    L.push(`| status | **${roll.overallStatus}** |`);
    L.push(`| counts | FAIL ${counts.FAIL}, WARN ${counts.WARN}, DEFER ${counts.DEFER}, INFO ${counts.INFO}, result flips ${counts.flips} |`);
    L.push(`| games | ${fmt(manifest.gamesFinal)}/${fmt(manifest.gamesTotal)} final${manifest.allFinal ? '' : ' (NOT all final)'} |`);
    L.push(`| ESPN | ${manifest.espn ? (manifest.espn.ok ? 'ok' : 'DEGRADED') : 'unknown'}; games with ESPN data ${countEspnGames(manifest)}/${fmt(manifest.gamesTotal)} |`);
    L.push(`| standings present | ${manifest.standingsPresent === undefined ? 'unknown' : manifest.standingsPresent} |`);
    if (units.length) L.push(`| units | ${done.length}/${units.length} done${missing.length ? `; missing: ${missing.map(u => u.id).join(', ')}` : ''} |`);
    const qsum = ctx.questions || [];
    L.push(`| questions | ${qsum.length} (open ${qsum.filter(q => q.status === 'open').length}, resolved ${qsum.filter(q => q.status === 'resolved').length}, ruled ${qsum.filter(q => q.status === 'ruled').length}) |`);
    if (manifest.scoreCheck) L.push(`| score check | ${fmt(manifest.scoreCheck.checked)} final game(s) checked; mismatches: ${(manifest.scoreCheck.mismatches || []).join(', ') || 'none'} |`);
    L.push(`| coverage | ${md(coverageSummary(manifest.coverage))} |`);
    L.push(`| trigger | ${trigger} |`);
    if (roll.incompleteReasons.length) L.push(`| incomplete because | ${md(roll.incompleteReasons.join('; '))} |`);
    L.push('');

    L.push(...findingSection('Result-flipping findings', findings.filter(f => f.flipsResult), 'None.'));
    L.push(...findingSection('FAIL', findings.filter(f => f.severity === 'FAIL'), 'None.'));
    L.push(...findingSection('WARN', findings.filter(f => f.severity === 'WARN'), 'None.'));

    L.push('## Rulings & questions', '');
    const qs = ctx.questions || [];
    if (!qs.length) L.push('No open questions: every scoring play was decided by the rules.', '');
    else {
        L.push('| question | game / play | play text | votes (drive / gamebook / text) | script | verdict | ruling | status |', '|---|---|---|---|---|---|---|---|');
        for (const q of qs) {
            const v = q.votes || {};
            const verdict = q.resolution ? `${q.resolution.awardClass} (${q.resolution.confidence}, ${q.resolution.model || 'opus'})` : '—';
            const ruling = q.ruling ? `${q.ruling.awardClass} (${q.ruling.by || 'admin'})` : '—';
            L.push(`| \`${q.id}\` | ${md(q.gameId || '')}${q.playIdx ? ` play ${q.playIdx}` : ''} | ${md(q.text || q.question)} | ${v.drive || '-'} / ${v.gamebook || '-'} / ${v.text || '-'} | ${q.scriptAwardClass || ''} | ${md(verdict)} | ${md(ruling)} | ${q.status === 'open' ? '**OPEN — needs your ruling**' : q.status} |`);
        }
        L.push('');
        for (const q of qs) {
            if (q.resolution && q.resolution.reasoning) L.push(`- \`${q.id}\` ${q.resolution.model || 'opus'}: ${md(q.resolution.reasoning)}`);
            if (q.ruling && q.ruling.note) L.push(`- \`${q.id}\` ruling (${q.ruling.by || 'admin'}): ${md(q.ruling.note)}`);
        }
        L.push('');
        L.push('Rule a question on /admin/status (POST /api/admin/doublecheck/ruling); rulings beat verdicts. Re-ask Claude with `node scripts/doublecheck-reconcile.js <season> <week> --redo`.', '');
    }

    L.push('## Defensive scores', '');
    const ds = ctx.defensiveScores || [];
    if (!ds.length) L.push('No defensive touchdowns, blocked kicks, safeties or candidates this week.', '');
    else {
        L.push('| game | play | kind | team | award class | votes (drive / gamebook / text) | votes agree | credited in DB | DB agrees | question |', '|---|---|---|---|---|---|---|---|---|---|');
        for (const x of ds) {
            const v = x.votes || {};
            const qm = (ctx.questions || []).find(q => q.id === x.questionId);
            const decided = x.decided ? `${x.decided.awardClass} (${x.decided.source})` : (qm ? qm.status : '');
            L.push(`| ${md(x.gameId)} | ${x.playIdx} | ${x.kind} | ${x.scoringTeam} | ${x.awardClass}${x.decided && x.decided.awardClass !== x.awardClass ? ` → ${x.decided.awardClass}` : ''} | ${v.drive || '-'} / ${v.gamebook || '-'} / ${v.text || '-'} | ${x.votesAgree === false ? '**no**' : 'yes'} | ${(x.creditedTo || []).length ? x.creditedTo.map(c => `${c.player_id}.${c.column}`).join('; ') : 'nobody'} | ${x.agreement === null || x.agreement === undefined ? 'n/a' : x.agreement ? 'yes' : '**no**'} | ${x.questionId ? `${x.questionId}${decided ? ` (${decided})` : ''}` : ''} |`);
        }
        L.push('');
    }

    L.push('## Deferred', '');
    const deferredFindings = findings.filter(f => f.severity === 'DEFER');
    const deferredClasses = manifest.deferred || [];
    if (deferredClasses.length) L.push(`Deferred by the data script (not decidable yet): ${deferredClasses.join(', ')}`, '');
    if (deferredFindings.length) { for (const f of deferredFindings) L.push(findingLine(f)); L.push(''); }
    if (!deferredClasses.length && !deferredFindings.length) L.push('None.', '');

    L.push('## Per-team audit table', '');
    L.push('| unit | owner | stored | recomputed | espn | lineup | status |', '|---|---|---|---|---|---|---|');
    for (const u of units.filter(x => /^team-/.test(x.id))) {
        const t = parseTotalLine(u.markdown);
        if (u.status !== 'done') L.push(`| ${u.id} | ${md(ownerFromUnit(u))} | | | | | missing (${md(u.reason)}) |`);
        else if (!t) L.push(`| ${u.id} | ${md(ownerFromUnit(u))} | | | | | done, no TOTAL line |`);
        else L.push(`| ${u.id} | ${md(ownerFromUnit(u))} | ${fmt(t.stored)} | ${fmt(t.recomputed)} | ${t.espn === null ? 'NA' : fmt(t.espn)} | ${t.lineup} | done |`);
    }
    L.push('');

    L.push('## TD ledger', '');
    L.push('| game | play | verdict | award class | note |', '|---|---|---|---|---|');
    let verdictCount = 0;
    for (const u of units.filter(x => /^game-/.test(x.id))) {
        const gameId = u.id.replace(/^game-/, '');
        if (u.status !== 'done') { L.push(`| ${md(gameId)} | | missing | | ${md(u.reason)} |`); continue; }
        const verdicts = parseVerdictLines(u.markdown);
        if (!verdicts.length) { L.push(`| ${md(gameId)} | | | | no VERDICT lines |`); continue; }
        for (const v of verdicts) {
            verdictCount++;
            L.push(`| ${md(gameId)} | play-${v.play} | ${v.verdict} | ${v.awardClass} | ${md(v.note)} |`);
        }
    }
    L.push('');

    L.push('## Stat discrepancies', '');
    const stat = findings.filter(f => f.entity.type === 'player' && /^stat_/.test(f.check));
    if (!stat.length) L.push('None.', '');
    else {
        L.push('| player | check | severity | internal → expected | explanation | sources |', '|---|---|---|---|---|---|');
        for (const f of stat) L.push(`| ${md(entityLabel(f))} | ${f.check} | ${f.severity} | ${md(expectedVsInternal(f))} | ${md(f.explanation)} | ${(f.sources || [f.source]).join(', ')} |`);
        L.push('');
    }

    L.push('## Bug-class checklist', '');
    const league = units.find(u => u.id === 'league');
    const llmChecks = league && league.status === 'done' ? parseCheckLines(league.markdown) : {};
    const checklist = Array.isArray(checks.checklist) ? checks.checklist : [];
    if (!checklist.length) L.push('checks.json has no checklist.', '');
    else {
        L.push('| id | check | script | LLM | script summary | LLM note |', '|---|---|---|---|---|---|');
        for (const c of checklist) {
            const l = llmChecks[c.id];
            L.push(`| ${c.id} | ${md(c.name)} | ${c.status} | ${l ? l.verdict : '—'} | ${md(c.summary)} | ${l ? md(l.note) : ''} |`);
        }
        L.push('');
        const unmatched = Object.keys(llmChecks).filter(id => !checklist.some(c => c.id === id));
        if (unmatched.length) L.push(`LLM CHECK lines with no checklist row: ${unmatched.join(', ')}`, '');
    }

    L.push('## What to fix', '');
    const fixes = uniq(findings.filter(f => ['FAIL', 'WARN'].includes(f.severity) && f.suggestedFix).map(f => f.suggestedFix));
    if (!fixes.length) L.push('Nothing to fix.', '');
    else { for (const fix of fixes) L.push(`- ${md(fix)}`); L.push(''); }
    L.push('Reminder: fix logic, then recalc — never edit the DB.', '');

    L.push('## Rejected findings', '');
    if (!rejected.length) L.push('None.', '');
    else {
        L.push('| unit | source | reason | raw |', '|---|---|---|---|');
        for (const r of rejected) L.push(`| ${r.unit} | ${r.source} | ${md(r.errors.join('; '))} | ${md(JSON.stringify(r.raw).slice(0, 200))} |`);
        L.push('');
    }

    L.push('## Coverage & run info', '');
    L.push('| field | value |', '|---|---|');
    L.push(`| workspace | ${md(ctx.workspace)} |`);
    L.push(`| generated | ${ctx.generatedAt} |`);
    L.push(`| data extracted | ${manifest.generatedAt || 'unknown'} |`);
    L.push(`| db | ${md(manifest.dbPath || 'unknown')} |`);
    L.push(`| current week at extraction | ${fmt(manifest.currentWeek)} |`);
    L.push(`| validation at extraction | ${manifest.validation ? `${manifest.validation.status} (${manifest.validation.runAt})` : 'none'} |`);
    L.push(`| ESPN | ${manifest.espn ? md(JSON.stringify(manifest.espn)) : 'unknown'} |`);
    L.push(`| verdict lines | ${verdictCount} |`);
    L.push(`| findings | script ${ctx.scriptCount || 0}, llm ${ctx.llmCount || 0}, merged ${findings.length}, rejected ${rejected.length} |`);
    L.push('');
    L.push('| unit | status | reason |', '|---|---|---|');
    for (const u of units) L.push(`| ${u.id} | ${u.status} | ${md(u.reason || '')} |`);
    L.push('');
    if (manifest.coverage) L.push('```json', JSON.stringify(manifest.coverage, null, 2), '```', '');
    return L.join('\n');
}

function countEspnGames(manifest) {
    const games = Array.isArray(manifest.games) ? manifest.games : [];
    return games.filter(g => g.espnFetched).length;
}

function coverageSummary(cov) {
    if (!cov || typeof cov !== 'object') return 'not reported by manifest';
    return Object.entries(cov).map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ');
}

// ---------- status files + email ----------

function buildLatest(ctx) {
    const { manifest = {}, units, findings, roll } = ctx;
    return {
        schemaVersion: SCHEMA_VERSION,
        runAt: ctx.generatedAt,
        trigger: ctx.trigger,
        season: ctx.season,
        week: ctx.week,
        dbPath: manifest.dbPath || null,
        overallStatus: roll.overallStatus,
        completeness: {
            gamesFinal: manifest.gamesFinal ?? null,
            gamesTotal: manifest.gamesTotal ?? null,
            espnGamesFetched: countEspnGames(manifest),
            standingsPresent: manifest.standingsPresent ?? null,
            deferred: manifest.deferred || []
        },
        counts: roll.counts,
        coverage: manifest.coverage || null,
        units: { total: units.length, done: units.filter(u => u.status === 'done').length, missing: roll.missing },
        findings: findings.filter(f => ['FAIL', 'WARN', 'DEFER'].includes(f.severity)),
        questions: ctx.questions || [],
        defensiveScores: ctx.defensiveScores || [],
        scoreCheck: manifest.scoreCheck || null,
        infoCount: roll.counts.INFO,
        rejectedCount: (ctx.rejected || []).length,
        reportFile: ctx.reportFile,
        workspace: ctx.workspace,
        email: { sent: false, to: NOTIFY_EMAIL, error: null }
    };
}

function writeStatusFile(status) {
    const dir = statusDir();
    const latestFile = path.join(dir, 'doublecheck-latest.json');
    const historyFile = path.join(dir, 'doublecheck-history.json');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(latestFile, JSON.stringify(status, null, 2));

    let history = [];
    try {
        history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
        if (!Array.isArray(history)) history = [];
    } catch (_) { /* missing or corrupt: start fresh */ }
    history.push({
        runAt: status.runAt,
        trigger: status.trigger,
        season: status.season,
        week: status.week,
        overallStatus: status.overallStatus,
        counts: status.counts,
        unitsDone: status.units.done,
        unitsTotal: status.units.total,
        emailSent: status.email.sent
    });
    fs.writeFileSync(historyFile, JSON.stringify(history.slice(-HISTORY_CAP), null, 2));
    return { latestFile, historyFile };
}

function buildEmail(status, findings) {
    const c = status.counts;
    const subject = `statfink2 double check ${status.overallStatus} — ${status.season} week ${status.week} ` +
        `(${fmt(status.completeness.gamesFinal)}/${fmt(status.completeness.gamesTotal)} final, ${c.flips} result flips)`;
    const lines = [
        `Double check run at ${status.runAt} (trigger: ${status.trigger})`,
        `Status: ${status.overallStatus}`,
        `Counts: FAIL ${c.FAIL}, WARN ${c.WARN}, DEFER ${c.DEFER}, INFO ${c.INFO}, result flips ${c.flips}`,
        `Units: ${status.units.done}/${status.units.total} done${status.units.missing.length ? ` (missing: ${status.units.missing.join(', ')})` : ''}`,
        ''
    ];
    const oneLine = f => `- ${entityLabel(f)}: ${expectedVsInternal(f) || '(see report)'} — ${f.explanation}`;
    const flips = findings.filter(f => f.flipsResult);
    lines.push('RESULT FLIPS', '------------');
    if (!flips.length) lines.push('None.');
    for (const f of flips) lines.push(oneLine(f));
    lines.push('');
    lines.push('FAIL', '----');
    const fails = findings.filter(f => f.severity === 'FAIL');
    if (!fails.length) lines.push('None.');
    for (const f of fails) lines.push(oneLine(f));
    lines.push('');
    lines.push(`WARN: ${c.WARN}`);
    lines.push(`Deferred: ${status.completeness.deferred.length ? status.completeness.deferred.join(', ') : 'none'}`);
    lines.push('');
    lines.push(`Report: ${status.reportFile}`);
    lines.push('');
    lines.push('Rerun:');
    lines.push(`  node scripts/doublecheck-data.js ${status.season} ${status.week} --refresh   # re-extract`);
    lines.push(`  node scripts/doublecheck-data.js ${status.season} ${status.week} --rerun-standings && node scripts/doublecheck-finalize.js ${status.season} ${status.week} --trigger standings-rerun --email   # after the weekly update`);
    lines.push('Never edit the DB: fix logic, then recalc.');
    return { subject, body: lines.join('\n') };
}

async function sendReportEmail(status, findings, log) {
    const { subject, body } = buildEmail(status, findings);
    try {
        const { sendGmail } = require('./lib/gmailSend'); // lazy: googleapis is heavy
        await sendGmail({ to: NOTIFY_EMAIL, subject, body });
        status.email.sent = true;
        log(`Report emailed to ${NOTIFY_EMAIL}: ${subject}`);
    } catch (error) {
        status.email.error = error.message;
        const fallback = path.join(statusDir(), `doublecheck-email-failure-${Date.now()}.log`);
        try {
            fs.mkdirSync(statusDir(), { recursive: true });
            fs.writeFileSync(fallback, `${subject}\n\n${body}`);
        } catch (_) { /* logging only */ }
        log(`FAILED to send email (${error.message}). Report saved to ${fallback}`);
        log('If this is a scope error, re-authorize with: node roster_moves/authSetup.js');
    }
}

// ---------- orchestration ----------

/** Pure-ish core: given a workspace on disk, compute everything without writing. */
function finalizeWorkspace({ season, week, workspace, trigger, generatedAt, scriptOnly = true, rulingsFile }) {
    const manifest = readJson(path.join(workspace, 'manifest.json'));
    const checksFile = path.join(workspace, (manifest.files && manifest.files.checks) || 'checks.json');
    const checks = readJson(checksFile);
    const workspaceFiles = listWorkspaceFiles(workspace);
    const units = scriptOnly ? [] : loadUnits(workspace, manifest);
    const questionsRaw = questionsList(readJsonOrNull(path.join(workspace, (manifest.files && manifest.files.questions) || 'questions.json')));
    const resolutions = resolutionsMap(readJsonOrNull(path.join(workspace, (manifest.files && manifest.files.resolutions) || 'resolutions.json')));
    const rulings = rulingsMap(readJsonOrNull(rulingsFile || defaultRulingsFile()));

    const rejected = [];
    const ctx = { season, week, seq: {} };
    const scriptFindings = [];
    for (const raw of (Array.isArray(checks.findings) ? checks.findings : [])) {
        const v = validateFinding(raw, workspaceFiles, { ...ctx, defaultSource: 'script' });
        if (v.ok) scriptFindings.push(v.finding);
        else rejected.push({ unit: 'checks.json', source: 'script', errors: v.errors, raw });
    }
    const llmFindings = [];
    for (const u of units) {
        if (u.status !== 'done') continue;
        for (const raw of u.rawFindings) {
            const v = validateFinding(raw, workspaceFiles, { ...ctx, defaultSource: `llm:${u.id}` });
            if (v.ok) llmFindings.push(v.finding);
            else rejected.push({ unit: u.id, source: `llm:${u.id}`, errors: v.errors, raw });
        }
    }

    const checklist = Array.isArray(checks.checklist) ? checks.checklist : [];
    const merged = mergeFindings(scriptFindings, llmFindings, checklist);
    const applied = applyDecisions(merged, questionsRaw, resolutions, rulings);
    const findings = applied.findings;
    const incompleteReasons = [];
    const rejectedScript = rejected.filter(r => r.source === 'script');
    if (rejectedScript.length) incompleteReasons.push(`${rejectedScript.length} script finding(s) rejected (data layer output malformed)`);
    const roll = rollUp(findings, units, { incompleteReasons });
    // Defensive scores carry the decision that applies to them (for the status page)
    const decisionById = new Map(applied.questions.map(q => [q.id, q]));
    const defensiveScores = (Array.isArray(checks.defensiveScores) ? checks.defensiveScores : (manifest.defensiveScores || [])).map(x => {
        const q = x.questionId ? decisionById.get(x.questionId) : null;
        return { ...x, questionStatus: q ? q.status : null, decided: q && q.decision && q.status !== 'open' ? { awardClass: q.decision.awardClass, source: q.decision.source } : null };
    });

    return {
        season, week, workspace, trigger, generatedAt, manifest, checks, units, findings, rejected, roll, scriptOnly,
        questions: applied.questions, defensiveScores,
        scriptCount: scriptFindings.length, llmCount: llmFindings.length,
        reportFile: path.join(workspace, 'report.md')
    };
}

function printSummary(status, log) {
    const c = status.counts;
    log(`Double check ${status.season} week ${status.week}: ${status.overallStatus}`);
    log(`  games final ${fmt(status.completeness.gamesFinal)}/${fmt(status.completeness.gamesTotal)}; ESPN games ${status.completeness.espnGamesFetched}; standings ${status.completeness.standingsPresent}`);
    log(`  FAIL ${c.FAIL}  WARN ${c.WARN}  DEFER ${c.DEFER}  INFO ${c.INFO}  result flips ${c.flips}`);
    if (status.units.total) log(`  units ${status.units.done}/${status.units.total} done${status.units.missing.length ? `; missing ${status.units.missing.join(', ')}` : ''}`);
    const qs = status.questions || [];
    log(`  questions ${qs.length}: open ${qs.filter(q => q.status === 'open').length}, resolved ${qs.filter(q => q.status === 'resolved').length}, ruled ${qs.filter(q => q.status === 'ruled').length}; defensive scores ${(status.defensiveScores || []).length}`);
    log(`  deferred classes: ${status.completeness.deferred.length ? status.completeness.deferred.join(', ') : 'none'}`);
    log(`  rejected findings: ${status.rejectedCount}`);
    log(`  report: ${status.reportFile}`);
    log(`  findings: ${path.join(status.workspace, 'findings.json')}`);
    log(`  status: ${path.join(statusDir(), 'doublecheck-latest.json')}`);
    log(`  email: ${status.email.sent ? `sent to ${status.email.to}` : (status.email.error ? `FAILED (${status.email.error})` : 'not requested')}`);
}

async function main() {
    const opts = parseArgs(process.argv);
    const log = opts.quiet ? () => {} : msg => console.log(msg);
    if (!opts.valid) {
        console.error('Usage: node scripts/doublecheck-finalize.js <season> <week> [--workspace <dir>] [--rulings <file>] [--with-units] [--email] [--trigger manual|standings-rerun|calibration|daily|reconcile|ruling] [--quiet]');
        process.exit(2);
    }
    let ctx;
    try {
        ctx = finalizeWorkspace({ ...opts, generatedAt: new Date().toISOString() });
    } catch (error) {
        console.error(`doublecheck-finalize error: ${error.message}`);
        console.error(`Workspace: ${opts.workspace} — run node scripts/doublecheck-data.js ${opts.season} ${opts.week} first.`);
        process.exit(2);
    }

    const status = buildLatest(ctx);
    try {
        fs.writeFileSync(path.join(ctx.workspace, 'findings.json'), JSON.stringify({
            schemaVersion: SCHEMA_VERSION,
            season: ctx.season,
            week: ctx.week,
            generatedAt: ctx.generatedAt,
            trigger: ctx.trigger,
            overallStatus: ctx.roll.overallStatus,
            counts: ctx.roll.counts,
            units: ctx.units.map(u => ({ id: u.id, status: u.status, reason: u.reason, output: u.output })),
            findings: ctx.findings,
            questions: ctx.questions,
            defensiveScores: ctx.defensiveScores,
            rejected: ctx.rejected
        }, null, 2));
        fs.writeFileSync(ctx.reportFile, renderReport(ctx));
    } catch (error) {
        console.error(`doublecheck-finalize error writing workspace outputs: ${error.message}`);
        process.exit(2);
    }

    if (opts.email) await sendReportEmail(status, ctx.findings, log);

    try {
        writeStatusFile(status);
    } catch (error) {
        console.error(`doublecheck-finalize error writing status file: ${error.message}`);
        process.exit(2);
    }

    printSummary(status, msg => console.log(msg));
    process.exitCode = status.overallStatus === 'FAIL' ? 1 : 0;
}

if (require.main === module) {
    main().catch(err => {
        console.error(`doublecheck-finalize fatal: ${err.message}`);
        process.exit(2);
    });
}

module.exports = {
    extractJsonBlock,
    parseTotalLine,
    parseVerdictLines,
    parseCheckLines,
    loadUnits,
    validateFinding,
    mergeFindings,
    applyDecisions,
    decideQuestion,
    creditsForClass,
    rulingsMap,
    resolutionsMap,
    rollUp,
    renderReport,
    buildLatest,
    buildEmail,
    writeStatusFile,
    finalizeWorkspace,
    parseArgs,
    listWorkspaceFiles,
    NOTIFY_EMAIL,
    HISTORY_CAP
};
