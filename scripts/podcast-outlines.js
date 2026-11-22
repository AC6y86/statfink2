#!/usr/bin/env node
'use strict';

/**
 * The PFL Cast: write five podcast OUTLINES for one week and pick a favorite.
 * Joe pastes the chosen outline into Jellypod, which writes the dialogue, so
 * these are segments + talking points, never a script.
 *
 *   1. one claude call proposes five clearly different episode concepts
 *   2. five claude calls (in parallel) each write one outline
 *   3. one claude call rates them and picks a favorite
 *
 * Facts come from the week's validated recap digest (recaps/{season}/data/
 * week{NN}-digest.md). If no recap run built one yet, recap-data.js builds it
 * into podcast/{season}/data/ (same validation gate as the recaps).
 * Hosts come from podcast/hosts.json (edited on /admin/podcast).
 * Writes podcast/{season}/data/week{NN}-episode.json as it goes, plus the
 * job record logs/status/podcast-outlines.json.
 *
 * Usage: node scripts/podcast-outlines.js --season Y --week N [--count 5] [--model opus] [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { runClaude } = require('./lib/claudeHeadless');
const { writeJobStatus } = require('./lib/jobStatus');
const store = require('../server/utils/podcastStore');
// Joe's recap house rules (server/config/recapHouseRules.md via recapSettings),
// when that module is present; the podcast works without them.
let loadHouseRules = () => ({ rules: [], taste: '' });
try { ({ loadHouseRules } = require('../server/utils/recapSettings')); } catch (_) { /* no house rules */ }

const REPO = path.join(__dirname, '..');
const JOB = 'podcast-outlines';
const DEFAULT_MODEL = 'opus';
const CALL_TIMEOUT_MS = 12 * 60 * 1000;
const PODCAST_JOE_RULE = 'Joe (the scorekeeper, who makes this show) owns a team like everyone else. He can be the main character when the week\'s story genuinely puts him there, but never force it.';

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function parseArgs(argv) {
    const val = flag => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
    return {
        season: val('--season') ? parseInt(val('--season')) : null,
        week: val('--week') ? parseInt(val('--week')) : null,
        count: Math.min(Math.max(parseInt(val('--count') || '5'), 1), 8),
        model: val('--model') || DEFAULT_MODEL,
        dryRun: argv.includes('--dry-run')
    };
}

function readIf(file) { try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; } }

/** The week's digest: the recap one if it exists, else build one for the podcast. */
function loadDigest(season, week) {
    const wk = store.weekPad(week);
    const recapDigest = path.join(REPO, 'recaps', String(season), 'data', `week${wk}-digest.md`);
    const podDigest = path.join(store.DEFAULT_ROOT, String(season), 'data', `week${wk}-digest.md`);
    let text = readIf(recapDigest);
    if (text) return { text, file: recapDigest };
    text = readIf(podDigest);
    if (text) return { text, file: podDigest };
    log(`No digest for ${season} week ${week} yet - building one with recap-data.js`);
    const r = spawnSync(process.execPath, [path.join(__dirname, 'recap-data.js'), String(season), String(week), '--out', podDigest], { cwd: REPO, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`could not build the week ${week} digest: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' ')}`);
    return { text: fs.readFileSync(podDigest, 'utf8'), file: podDigest };
}

/** Last week's chosen outline (for grading the hosts' picks), if there is one. */
function previousEpisode(season, week) {
    if (week <= 1) return null;
    const prev = store.readEpisode(season, week - 1);
    if (!prev || !Array.isArray(prev.outlines)) return null;
    // Joe's pick (the one that aired) wins over Claude's favorite.
    const chosen = prev.outlines.find(o => o.id === prev.chosen) || prev.outlines.find(o => o.id === prev.favorite) || null;
    return chosen ? { week: week - 1, title: chosen.title, markdown: chosen.markdown } : null;
}

/** House rules that apply to a spoken show (the written-recap mechanics are left out). */
function podcastHouseRules() {
    const h = loadHouseRules();
    const rules = h.rules
        .filter(r => !/appendix|every matchup gets real treatment|Next week comes from/i.test(r))
        // The recaps keep Joe out of the spotlight; the podcast may feature him (Joe, 2026-11-22).
        .filter(r => !/main character/i.test(r));
    rules.push(PODCAST_JOE_RULE);
    return { rules, taste: h.taste || '' };
}

function hostBlock(hosts) {
    return hosts.map(h => `- ${h.name} (${h.role})${h.traits ? `: ${h.traits}` : ' - use the real person\'s well-known on-air personality'}`).join('\n');
}

function sharedBrief({ season, week, hosts, digest, storylines, prev, house }) {
    const nextWeek = week + 1;
    return [
        `The PFL Cast is a ~10-minute comedy podcast about the PFL, a 12-owner fantasy football league of adult friends. This is the ${season} Week ${week} episode: what happened in Week ${week}, and a look ahead to Week ${nextWeek}.`,
        '',
        'The show is voiced by Jellypod, an AI that writes the actual dialogue from an OUTLINE. We write the outline: segments, talking points, bits, disagreements. Never write the full script or long verbatim lines; a short sample line or catchphrase cue is fine.',
        '',
        'ON THE SHOW:',
        hostBlock(hosts),
        '',
        'WHAT JOE (who makes the show) WANTS:',
        '- Interesting and funny above all. NOT a game-by-game recap; that is dull. Pick the 2-3 best stories and build the show around them.',
        '- Few numbers. Two or three per segment at most; the show is about stories and personalities, not stat lines.',
        '- Bring out each host\'s real personality traits, and give every segment at least one genuine disagreement between them.',
        '- Tone: affectionate roast. The owners should laugh, not wince. Nobody gets roasted twice.',
        '- Segments: a cold open, 2-3 big storylines, an awards/roast bit, next-week picks from each host with some stakes, a sign-off.',
        '',
        'LEAGUE FACTS JELLYPOD WILL GET WRONG UNLESS TOLD (put a "Never say" list in the outline):',
        '- There is no starting lineup: the scoring lineup fills itself from the best scorers, so nobody "started", "benched" or "sat" anyone.',
        '- No waivers, FAAB or projections. Roster moves are IR moves, supplemental moves and trades.',
        `- Week ${nextWeek} has not been played: no Week ${nextWeek} results.`,
        '- Every number must come from the digest below. If a number is not there, talk around it.',
        '- Do not guess pronouns for league owners: use their names.',
        '',
        'JOE\'S STANDING RULES (from the written recaps; they apply here too):',
        ...house.rules.map(r => `- ${r.replace(/^-\s*/, '')}`),
        '',
        house.taste ? `JOE'S TASTE (what he actually sends to the league):\n${house.taste}\n` : null,
        prev ? `LAST WEEK'S EPISODE (Week ${prev.week}, "${prev.title}"). If it made picks, grade them against this week's results in the digest ("checking the receipts"). Do not repeat its jokes or awards names unless they are a deliberate running bit:\n<<<\n${prev.markdown.trim()}\n>>>\n` : null,
        storylines ? `SEASON STORYLINES (context; numbers must still match the digest):\n<<<\n${storylines.trim()}\n>>>\n` : null,
        `THE WEEK ${week} DIGEST (the only source of facts):\n<<<\n${digest.trim()}\n>>>`
    ].filter(l => l !== null).join('\n');
}

function parseJson(envelope) {
    const text = envelope && typeof envelope.result === 'string' ? envelope.result : '';
    const m = text.match(/[[{][\s\S]*[\]}]/);
    if (!m) throw new Error(`claude returned no JSON: ${text.slice(0, 300)}`);
    return JSON.parse(m[0]);
}

async function ask(prompt, model) {
    const result = await runClaude(['-p', '--output-format', 'json', '--model', model, '--max-turns', '1', '--allowedTools', ''], { timeoutMs: CALL_TIMEOUT_MS, input: prompt });
    if (result.error) throw new Error(result.error);
    return result.envelope;
}

function conceptsPrompt(brief, count) {
    return `${brief}\n\n---\nTASK: Propose ${count} clearly DIFFERENT episode concepts for this week. They should differ in their premise and shape (e.g. one built around a running argument, one around a fake trial or draft or awards gala, one where a host is on a mission, ...), not just in which story leads. Each concept must be built on this week's real stories from the digest and suit these hosts.\n\nReply with ONLY a JSON array, no prose:\n[{"title": "short episode title", "premise": "two sentences: the hook and how the show is shaped", "runningBit": "the one bit that builds across the episode"}]`;
}

function outlinePrompt(brief, concept, hosts) {
    return `${brief}\n\n---\nTASK: Write the outline for this concept:\nTitle: ${concept.title}\nPremise: ${concept.premise}\nRunning bit: ${concept.runningBit}\n\nFormat (markdown, roughly 600-1000 words):\n# The PFL Cast — Week N: <title>\n**On the show:** ... · **Runtime:** ~10 minutes · **Tone:** affectionate roast\n## Notes for the show writer\n- one short block per person: the traits to play up in THIS episode\n- how they play off each other, and the running bit\n- Never say: (the league facts above, plus anything this episode risks)\n## 1. Cold open (~0:30)\n... numbered segments with rough timings that add to ~10 minutes, each with talking-point bullets, which host drives it, the disagreement, and the handoff to the next segment ...\n\nTalking points, not dialogue. Few numbers. Every host on the show (${hosts.map(h => h.name).join(', ')}) gets real moments. Reply with ONLY the markdown outline.`;
}

function judgePrompt(brief, outlines, week) {
    const body = outlines.map(o => `\n\n===== OUTLINE id: ${o.id} ("${o.title}") =====\n${o.markdown.trim()}`).join('');
    return `${brief}\n\n---\nTASK: You are the producer. Below are ${outlines.length} outlines for this week's episode. Pick your favorite: the one that will make the funniest, most interesting 10 minutes for these 12 friends, uses the hosts best, and follows the rules (few numbers, no game-by-game recap). Check its facts against the digest: an outline with a wrong fact or a broken rule (a wrong season mark, an all-play claim, a previous season, a Week ${week + 1} result) can never be the favorite, and its blurb must name the error. Rate each one 1-5 stars in half steps and use the whole scale.\n\nReply with ONLY a JSON object, no prose:\n{"favorite": "id", "reason": "two sentences on why", "ratings": [{"id": "id", "stars": 4, "blurb": "one sentence naming a concrete bit that works or does not"}]}${body}`;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!opts.season || !opts.week) { console.error('Usage: node scripts/podcast-outlines.js --season Y --week N [--count 5] [--model opus] [--dry-run]'); process.exit(2); }
    const { season, week, count, model } = opts;
    const started = Date.now();
    const { hosts } = store.readHosts();
    const doc = { season, week, hosts, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, error: null, model, outlines: [], favorite: null, favoriteReason: null, costUsd: 0 };
    const save = () => { if (!opts.dryRun) store.writeEpisode(doc); };
    const status = (st, summary) => writeJobStatus(JOB, { status: st, summary, season, week, link: '/admin/podcast', durationMs: st === 'running' ? null : Date.now() - started, details: { pid: process.pid } });
    const addCost = env => { doc.costUsd = Math.round((doc.costUsd + Number(env?.total_cost_usd || 0)) * 100) / 100; };

    try {
        save();
        status('running', `writing ${count} outlines for ${season} week ${week}`);
        const digest = loadDigest(season, week);
        const storylines = readIf(path.join(REPO, 'recaps', String(season), 'data', `week${store.weekPad(week)}-storylines.md`));
        const brief = sharedBrief({ season, week, hosts, digest: digest.text, storylines, prev: previousEpisode(season, week), house: podcastHouseRules() });
        doc.digest = path.relative(REPO, digest.file);
        if (opts.dryRun) { console.log(conceptsPrompt(brief, count)); return; }

        log(`Proposing ${count} concepts (${hosts.map(h => h.name).join(', ')}; model ${model})`);
        const cEnv = await ask(conceptsPrompt(brief, count), model);
        addCost(cEnv);
        const concepts = (parseJson(cEnv) || []).filter(c => c && c.title).slice(0, count);
        if (!concepts.length) throw new Error('no episode concepts came back');

        log(`Writing ${concepts.length} outlines in parallel`);
        const written = await Promise.all(concepts.map(async (c, i) => {
            try {
                const env = await ask(outlinePrompt(brief, c, hosts), model);
                addCost(env);
                const markdown = String(env.result || '').replace(/^```(?:markdown)?\s*/i, '').replace(/```\s*$/, '').trim();
                if (markdown.length < 400) throw new Error('outline came back too short');
                return { id: `o${i + 1}`, title: String(c.title).slice(0, 120), premise: String(c.premise || '').slice(0, 500), runningBit: String(c.runningBit || '').slice(0, 300), markdown, unverifiedNumbers: store.numbersNotInDigest(markdown, digest.text) };
            } catch (error) {
                log(`Outline ${i + 1} ("${c.title}") failed: ${error.message}`);
                return null;
            }
        }));
        doc.outlines = written.filter(Boolean);
        if (!doc.outlines.length) throw new Error('every outline failed');
        save();

        if (doc.outlines.length > 1) {
            log('Picking a favorite');
            try {
                const jEnv = await ask(judgePrompt(brief, doc.outlines, week), model);
                addCost(jEnv);
                const verdict = parseJson(jEnv);
                const ids = new Set(doc.outlines.map(o => o.id));
                for (const r of Array.isArray(verdict.ratings) ? verdict.ratings : []) {
                    const o = doc.outlines.find(x => x.id === r.id);
                    if (!o) continue;
                    const stars = Math.round(Number(r.stars) * 2) / 2;
                    if (stars >= 1 && stars <= 5) o.stars = stars;
                    if (r.blurb) o.blurb = String(r.blurb).slice(0, 300);
                }
                if (ids.has(verdict.favorite)) { doc.favorite = verdict.favorite; doc.favoriteReason = String(verdict.reason || '').slice(0, 600); }
            } catch (error) {
                log(`Picking a favorite failed: ${error.message}`);
                doc.error = `Outlines are ready, but picking a favorite failed: ${error.message}`;
            }
        } else {
            doc.favorite = doc.outlines[0].id;
        }

        doc.status = 'ok';
        doc.finishedAt = new Date().toISOString();
        save();
        const fav = doc.outlines.find(o => o.id === doc.favorite);
        status('ok', `${doc.outlines.length} outlines for ${season} week ${week}${fav ? `; favorite: ${fav.title}` : ''}`);
        log(`Done: ${doc.outlines.length} outlines, favorite ${doc.favorite || 'none'}, $${doc.costUsd}`);
    } catch (error) {
        doc.status = 'failed';
        doc.error = error.message;
        doc.finishedAt = new Date().toISOString();
        save();
        status('critical', `podcast outlines for ${season} week ${week} failed: ${error.message}`);
        log(`Failed: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { PODCAST_JOE_RULE, sharedBrief, conceptsPrompt, outlinePrompt, judgePrompt, podcastHouseRules, parseJson };

if (require.main === module) main();
