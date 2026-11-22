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
 * Player color: before the concepts, one claude call WITH WebSearch/WebFetch
 * researches the week's 6-8 featured players (their real NFL game, who they
 * are, current news) into sourced notes, podcast/{season}/data/week{NN}-players.md
 * (reused on later runs; --refresh-research searches again). If research
 * fails, the outlines are written without it.
 *
 * Usage: node scripts/podcast-outlines.js --season Y --week N [--count 5] [--model opus]
 *        [--refresh-research] [--research-only] [--out-root DIR] [--dry-run]
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
const RESEARCH_TIMEOUT_MS = 15 * 60 * 1000;
const RESEARCH_MAX_TURNS = '30';
const PODCAST_JOE_RULE = 'Joe (the scorekeeper, who makes this show) owns a team like everyone else. He can be the main character when the week\'s story genuinely puts him there, but never force it.';

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function parseArgs(argv) {
    const val = flag => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
    return {
        season: val('--season') ? parseInt(val('--season')) : null,
        week: val('--week') ? parseInt(val('--week')) : null,
        count: Math.min(Math.max(parseInt(val('--count') || '5'), 1), 8),
        model: val('--model') || DEFAULT_MODEL,
        dryRun: argv.includes('--dry-run'),
        refreshResearch: argv.includes('--refresh-research'),
        researchOnly: argv.includes('--research-only'),
        // Write the episode doc somewhere else (trial runs that must not replace a week's real outlines).
        outRoot: val('--out-root')
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
    const hosts = Array.isArray(prev.hosts) ? prev.hosts.map(h => h.name).join(', ') : null;
    return chosen ? { week: week - 1, title: chosen.title, markdown: chosen.markdown, hosts } : null;
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

function playersFile(season, week) {
    return path.join(store.DEFAULT_ROOT, String(season), 'data', `week${store.weekPad(week)}-players.md`);
}

function researchPrompt({ season, week, digest, storylines }) {
    return [
        `You are the researcher for The PFL Cast, a comedy podcast about the PFL, a 12-owner fantasy football league of friends. The ${season} Week ${week} show wants to get into the NFL players themselves - who they are, what happened in their real game, their story - not just their fantasy points.`,
        '',
        'TASK:',
        `1. From the digest below, pick the 6-8 players who matter most to this week's league stories: the Top Performances, the One-Player Carry and Player Arcs seeds, notable injuries, and players on teams in the Next Week Preview. Spread them across different owners; do not pick three players from one team.`,
        `2. Search the web for each player and write notes for the podcast: their real NFL Week ${week} game, who they are as a person and a player, and what is next for them.`,
        '',
        'RULES:',
        '- Every fact needs a source: put the URL in brackets at the end of the bullet. Use only what you found in this search; if you cannot find something, leave it out. Never fill a gap from memory.',
        `- This is the ${season} NFL season. Make sure every game detail is from the ${season} season, Week ${week} - not an earlier year.`,
        '- Do not restate or contradict PFL fantasy points: those come only from the league digest. Real NFL stats from the game (yards, touchdowns, a long catch) are fine with a source.',
        '- Football-relevant and public only: career path, college, draft story, contract or trade storylines, records and milestones, nicknames, celebrations, well-known quirks, what teammates or coaches said. No gossip, family matters or anything mean-spirited.',
        '- No fantasy advice and no predictions.',
        '- Injury or roster news is "as of" now: say the date of the report.',
        '',
        'OUTPUT: markdown only, no preamble, in this shape:',
        `# Player notes: ${season} Week ${week}`,
        '## <Player name> (<position>, <NFL team>) - <PFL owner> in the league',
        '- **Week ' + week + ' game:** opponent, result, the moment that mattered [url]',
        '- **Who they are:** 2-3 bullets of backstory, path to the NFL, a quirk or milestone [url]',
        '- **What\'s next:** injury status, news, next opponent [url]',
        '- **On-air hook:** one line on how a comedy host could use this (no new facts here)',
        '',
        storylines ? `SEASON STORYLINES (context):\n<<<\n${storylines.trim()}\n>>>\n` : '',
        `THE WEEK ${week} LEAGUE DIGEST:\n<<<\n${digest.trim()}\n>>>`
    ].join('\n');
}

/** Sourced player notes for the week: reuse the saved file, else research. Returns { notes, file, costUsd, error }. */
async function researchPlayers({ season, week, digest, storylines, model, refresh = false }) {
    const file = playersFile(season, week);
    if (!refresh) {
        const saved = readIf(file);
        if (saved && saved.trim()) return { notes: saved, file, costUsd: 0, error: null, reused: true };
    }
    log(`Researching the week's players on the web (model ${model})`);
    const result = await runClaude(['-p', '--output-format', 'json', '--model', model, '--max-turns', RESEARCH_MAX_TURNS, '--allowedTools', 'WebSearch', 'WebFetch'],
        { timeoutMs: RESEARCH_TIMEOUT_MS, input: researchPrompt({ season, week, digest, storylines }) });
    const costUsd = Number(result.envelope?.total_cost_usd || 0);
    if (result.error) return { notes: null, file: null, costUsd, error: result.error.slice(0, 500) };
    const notes = String(result.envelope?.result || '').replace(/^```(?:markdown)?\s*/i, '').replace(/```\s*$/, '').trim();
    if (notes.length < 300 || !/^##\s/m.test(notes)) return { notes: null, file: null, costUsd, error: `research came back without player notes: ${notes.slice(0, 200)}` };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, notes + '\n');
    return { notes, file, costUsd, error: null, reused: false };
}

function hostBlock(hosts) {
    return hosts.map(h => `- ${h.name} (${h.role})${h.traits ? `: ${h.traits}` : ' - use the real person\'s well-known on-air personality'}`).join('\n');
}

function sharedBrief({ season, week, hosts, digest, storylines, prev, house, playerNotes = null }) {
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
        '- Get into the players themselves, not just their fantasy points: who they are, what happened in their real game, their story, a quirk or milestone. Every storyline should bring at least one player to life with a detail from the PLAYER NOTES, ideally one that plays off a host\'s personality. Player facts come only from the notes or the digest; never invent biography, and never read sources out on air.',
        '- Segments: a cold open, 2-3 big storylines, an awards/roast bit, next-week picks from each host with some stakes, a sign-off.',
        '- The lineup changes from week to week: different hosts and guests, and nobody is guaranteed to come back. Introduce whoever is on the show as this week\'s crew. Never promise these hosts will return or "see you next week" as a pair, and never set up stakes that need them back next week; stakes should pay off within this episode (a dare, a forfeit, a bet settled on air).',
        '',
        'LEAGUE FACTS JELLYPOD WILL GET WRONG UNLESS TOLD (put a "Never say" list in the outline):',
        '- There is no starting lineup: the scoring lineup fills itself from the best scorers, so nobody "started", "benched" or "sat" anyone.',
        '- No waivers, FAAB or projections. Roster moves are IR moves, supplemental moves and trades.',
        `- Week ${nextWeek} has not been played: no Week ${nextWeek} results.`,
        `- Every number must come from the digest below${playerNotes ? ' (league numbers) or the player notes (real NFL game details)' : ''}. If a number is not there, talk around it.`,
        '- Do not guess pronouns for league owners: use their names.',
        '',
        'JOE\'S STANDING RULES (from the written recaps; they apply here too):',
        ...house.rules.map(r => `- ${r.replace(/^-\s*/, '')}`),
        '',
        house.taste ? `JOE'S TASTE (what he actually sends to the league):\n${house.taste}\n` : null,
        prev ? `LAST WEEK'S EPISODE (Week ${prev.week}, "${prev.title}"), possibly with a different crew${prev.hosts ? ` (${prev.hosts})` : ''}. If it made picks, this week's hosts can grade them against this week's results in the digest ("checking last week's receipts"); if the hosts were different people, treat those picks as someone else's and feel free to mock them. Do not repeat its jokes or award names:\n<<<\n${prev.markdown.trim()}\n>>>\n` : null,
        storylines ? `SEASON STORYLINES (context; numbers must still match the digest):\n<<<\n${storylines.trim()}\n>>>\n` : null,
        playerNotes ? `PLAYER NOTES (researched on the web for this week, with sources; the ONLY allowed source of facts about players beyond the digest - their real games, backgrounds and news):\n<<<\n${playerNotes.trim()}\n>>>\n` : null,
        `THE WEEK ${week} DIGEST (the only source of league facts):\n<<<\n${digest.trim()}\n>>>`
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
    return `${brief}\n\n---\nTASK: Write the outline for this concept:\nTitle: ${concept.title}\nPremise: ${concept.premise}\nRunning bit: ${concept.runningBit}\n\nFormat (markdown, roughly 600-1000 words):\n# The PFL Cast — Week N: <title>\n**On the show:** ... · **Runtime:** ~10 minutes · **Tone:** affectionate roast\n## Notes for the show writer\n- one short block per person: the traits to play up in THIS episode\n- how they play off each other, and the running bit\n- Never say: (the league facts above, plus anything this episode risks)\n## 1. Cold open (~0:30)\n... numbered segments with rough timings that add to ~10 minutes, each with talking-point bullets, which host drives it, a **Player color** bullet (a real detail about a player from the notes and how the hosts use it), the disagreement, and the handoff to the next segment ...\n\nTalking points, not dialogue. Few numbers. Every host on the show (${hosts.map(h => h.name).join(', ')}) gets real moments. Reply with ONLY the markdown outline.`;
}

function judgePrompt(brief, outlines, week) {
    const body = outlines.map(o => `\n\n===== OUTLINE id: ${o.id} ("${o.title}") =====\n${o.markdown.trim()}`).join('');
    return `${brief}\n\n---\nTASK: You are the producer. Below are ${outlines.length} outlines for this week's episode. Pick your favorite: the one that will make the funniest, most interesting 10 minutes for these 12 friends, uses the hosts best, and follows the rules (few numbers, no game-by-game recap). Reward outlines that bring the players to life with real details from the player notes woven into the bits, not just their points. Check its facts against the digest and the player notes: an outline with a wrong fact, an invented player fact (anything about a player that is in neither the notes nor the digest) or a broken rule (a wrong season mark, an all-play claim, a previous season, a Week ${week + 1} result) can never be the favorite, and its blurb must name the error. Rate each one 1-5 stars in half steps and use the whole scale.\n\nReply with ONLY a JSON object, no prose:\n{"favorite": "id", "reason": "two sentences on why", "ratings": [{"id": "id", "stars": 4, "blurb": "one sentence naming a concrete bit that works or does not"}]}${body}`;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!opts.season || !opts.week) { console.error('Usage: node scripts/podcast-outlines.js --season Y --week N [--count 5] [--model opus] [--dry-run]'); process.exit(2); }
    const { season, week, count, model } = opts;
    const outRoot = opts.outRoot ? path.resolve(opts.outRoot) : store.DEFAULT_ROOT;
    const started = Date.now();
    const { hosts } = store.readHosts();
    const doc = { season, week, hosts, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, error: null, model, outlines: [], favorite: null, favoriteReason: null, costUsd: 0 };
    const save = () => { if (!opts.dryRun && !opts.researchOnly) store.writeEpisode(doc, outRoot); };
    const status = (st, summary) => writeJobStatus(JOB, { status: st, summary, season, week, link: '/admin/podcast', durationMs: st === 'running' ? null : Date.now() - started, details: { pid: process.pid } });
    const addCost = env => { doc.costUsd = Math.round((doc.costUsd + Number(env?.total_cost_usd || 0)) * 100) / 100; };

    try {
        save();
        status('running', `writing ${count} outlines for ${season} week ${week}`);
        const digest = loadDigest(season, week);
        const storylines = readIf(path.join(REPO, 'recaps', String(season), 'data', `week${store.weekPad(week)}-storylines.md`));
        doc.digest = path.relative(REPO, digest.file);
        if (opts.dryRun) {
            console.log(researchPrompt({ season, week, digest: digest.text, storylines }).slice(0, 4000));
            console.log('\n=========== BRIEF (with a notes placeholder) ===========\n');
            console.log(conceptsPrompt(sharedBrief({ season, week, hosts, digest: digest.text, storylines, prev: previousEpisode(season, week), house: podcastHouseRules(), playerNotes: '## (player notes go here)' }), count));
            return;
        }

        status('running', `researching players for ${season} week ${week}`);
        const research = await researchPlayers({ season, week, digest: digest.text, storylines, model, refresh: opts.refreshResearch });
        doc.costUsd = Math.round((doc.costUsd + research.costUsd) * 100) / 100;
        if (research.error) { doc.researchError = research.error; log(`Player research failed, continuing without it: ${research.error}`); }
        else { doc.playerNotes = path.relative(REPO, research.file); log(`Player notes ${research.reused ? 'reused' : 'written'}: ${doc.playerNotes}`); }
        if (opts.researchOnly) { log(research.error ? 'Research failed' : `Research only: ${doc.playerNotes} ($${doc.costUsd})`); process.exitCode = research.error ? 1 : 0; return; }
        save();
        status('running', `writing ${count} outlines for ${season} week ${week}`);
        const brief = sharedBrief({ season, week, hosts, digest: digest.text, storylines, prev: previousEpisode(season, week), house: podcastHouseRules(), playerNotes: research.notes });
        const factText = digest.text + (research.notes ? `\n${research.notes}` : '');

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
                return { id: `o${i + 1}`, title: String(c.title).slice(0, 120), premise: String(c.premise || '').slice(0, 500), runningBit: String(c.runningBit || '').slice(0, 300), markdown, unverifiedNumbers: store.numbersNotInDigest(markdown, factText) };
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

module.exports = { PODCAST_JOE_RULE, researchPrompt, researchPlayers, playersFile, sharedBrief, conceptsPrompt, outlinePrompt, judgePrompt, podcastHouseRules, parseJson };

if (require.main === module) main();
