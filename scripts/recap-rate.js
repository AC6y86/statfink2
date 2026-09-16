#!/usr/bin/env node
'use strict';

/**
 * Rate one week's recaps on storytelling and how interesting they are
 * (1-5 stars, half steps, one line each) and pick ONE recommended recap.
 * Writes recaps/{season}/data/week{NN}-ratings.json (server/utils/recapRatings.js),
 * which /admin Recaps shows as stars + a recommended star next to each recap.
 *
 * Run by scripts/weekly-recap-run.js right after generation, and by the
 * "Rate recaps" button on /admin Recaps (POST /api/admin/recaps/:season/:week/rate).
 * Recaps that failed the fact-check are rated but never recommended.
 *
 * Usage: node scripts/recap-rate.js --season Y --week N [--model opus] [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { runClaude } = require('./lib/claudeHeadless');
const { parseRecapFilename, parseFactcheckReport, slugToDisplayName, weekPad } = require('../server/utils/recapFiles');
const { normaliseRatings, writeRatings } = require('../server/utils/recapRatings');

const REPO = path.join(__dirname, '..');
const RECAPS_ROOT = path.join(REPO, 'recaps');
const CLAUDE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MODEL = 'opus';

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function parseArgs(argv) {
    const val = flag => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
    return {
        season: val('--season') ? parseInt(val('--season')) : null,
        week: val('--week') ? parseInt(val('--week')) : null,
        model: val('--model') || DEFAULT_MODEL,
        dryRun: argv.includes('--dry-run')
    };
}

/** The week's recaps: [{ slug, name, markdown }] plus the fact-check verdicts. */
function loadWeek(season, week) {
    const dir = path.join(RECAPS_ROOT, String(season));
    let files = [];
    try { files = fs.readdirSync(dir); } catch (_) { /* none */ }
    const recaps = files
        .map(f => ({ f, p: parseRecapFilename(f) }))
        .filter(({ p }) => p && Number(p.week) === Number(week))
        .sort((a, b) => a.p.slug.localeCompare(b.p.slug))
        .map(({ f, p }) => ({ slug: p.slug, name: slugToDisplayName(p.slug), markdown: fs.readFileSync(path.join(dir, f), 'utf8') }));
    let factcheck = {};
    try { factcheck = parseFactcheckReport(fs.readFileSync(path.join(dir, 'data', `week${weekPad(week)}-factcheck.md`), 'utf8')); } catch (_) { /* none */ }
    const failed = recaps.map(r => r.slug).filter(s => factcheck[s] && factcheck[s].verdict !== 'PASS');
    return { recaps, failed };
}

function buildPrompt(season, week, recaps, failed) {
    const head = [
        `You are judging the ${recaps.length} persona-style recaps written for the PFL fantasy football league's ${season} week ${week}. All of them were written from the same data digest, so the FACTS are the same in each; judge only the writing.`,
        'Rate every recap on two things, equally weighted:',
        '1. Storytelling - does it have an arc, motifs, callbacks and a shape, or is it a box score with a costume on? Does the persona bend the form in a way that serves the week?',
        '2. How interesting it is - would the 12 league owners (adult friends who have read many of these) laugh, quote lines to each other, forward it? Sharp observations about the week count as much as jokes.',
        'Penalise: prose that is a template with the persona sprinkled on, repetition, jokes that need the reader to know the digest\'s quirks, and lines too crude for a mixed adult audience.',
        'Scale: 1-5 stars in half steps (e.g. 3.5). Use the whole scale; do not give everything 4. Exactly one recap gets "recommended": the one to send to the league.',
        failed.length ? `These recaps FAILED the fact-check and must not be recommended (still rate them): ${failed.join(', ')}.` : '',
        '',
        'Reply with ONLY a JSON object, no prose, no code fence:',
        '{"recommended": "slug", "ratings": [{"slug": "slug", "stars": 4.5, "blurb": "one sentence: what works or does not, naming a concrete line or device"}, ...]}',
        'Use each recap\'s slug exactly as given.',
        ''
    ].filter(l => l !== null).join('\n');
    const body = recaps.map(r => `\n\n===== RECAP slug: ${r.slug} (${r.name}) =====\n${r.markdown.trim()}`).join('');
    return head + body;
}

function parseReply(envelope) {
    const text = envelope && typeof envelope.result === 'string' ? envelope.result : '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`claude returned no JSON object: ${text.slice(0, 300)}`);
    try { return JSON.parse(m[0]); } catch (err) { throw new Error(`claude JSON unparsable: ${err.message}`); }
}

/** Rate a week; returns { file, doc } or throws. Used by weekly-recap-run.js. */
async function rateWeek(season, week, { model = DEFAULT_MODEL, dryRun = false } = {}) {
    const { recaps, failed } = loadWeek(season, week);
    if (recaps.length < 2) throw new Error(`${season} week ${week}: only ${recaps.length} recap(s) on disk - nothing to compare`);
    const prompt = buildPrompt(season, week, recaps, failed);
    log(`Rating ${recaps.length} recaps for ${season} week ${week} (${failed.length} failed fact-check, model ${model})`);
    if (dryRun) { console.log(prompt.slice(0, 3000) + '\n...'); return { file: null, doc: null }; }
    const result = await runClaude(['-p', '--output-format', 'json', '--model', model, '--max-turns', '1', '--allowedTools', ''], { timeoutMs: CLAUDE_TIMEOUT_MS, input: prompt });
    if (result.error) throw new Error(result.error);
    const doc = normaliseRatings(parseReply(result.envelope), { season, week, slugs: recaps.map(r => r.slug), failed, ratedBy: `claude-${model}` });
    const rated = Object.keys(doc.ratings).length;
    if (rated < Math.ceil(recaps.length / 2)) throw new Error(`claude rated only ${rated} of ${recaps.length} recaps`);
    doc.claude = { costUsd: result.envelope?.total_cost_usd ?? null, durationMs: result.envelope?.duration_ms ?? null };
    const file = writeRatings(doc);
    log(`Rated ${rated}/${recaps.length}; recommended: ${doc.recommended} (${path.relative(REPO, file)})`);
    return { file, doc };
}

module.exports = { buildPrompt, parseReply, loadWeek, rateWeek, DEFAULT_MODEL };

if (require.main === module) {
    const opts = parseArgs(process.argv.slice(2));
    if (!opts.season || !opts.week) { console.error('Usage: node scripts/recap-rate.js --season Y --week N [--model opus] [--dry-run]'); process.exit(2); }
    rateWeek(opts.season, opts.week, opts)
        .then(() => process.exit(0))
        .catch(err => { log(`Rating failed: ${err.message}`); process.exit(1); });
}
