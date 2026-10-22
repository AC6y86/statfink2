#!/usr/bin/env node
'use strict';

/**
 * Recap setup: propose this week's recap themes once every game is Final.
 *
 * pm2 `statfink2-recap-setup` runs this every 30 min. It exits `skipped`
 * unless the current week (or, right after an advance, the previous one) has
 * every game Final, no recaps yet and no themes file yet. Then it asks
 * headless claude for 10 fresh themes - each a particular named person (the
 * commissioner's preference; formats/genres only when he adds them by hand),
 * none used or proposed earlier this season (scripts/recap-styles-used.js +
 * earlier themes files) - and writes
 * recaps/{season}/data/week{NN}-themes.json. Nothing is generated: the
 * commissioner reviews the list on /admin Recaps, adds or removes themes,
 * and presses Generate (which runs scripts/weekly-recap-run.js --season --week).
 *
 * Flags: --season Y --week N (target a week explicitly; still refuses unless
 *        its games are Final)  --force (ignore "themes already proposed":
 *        appends NEW suggestions up to 10 suggested ones)  --dry-run
 */

const fs = require('fs');
const path = require('path');
const { writeJobStatus } = require('./lib/jobStatus');
const { runClaude } = require('./lib/claudeHeadless');
const { readThemes, writeThemes, slugsProposedThisSeason, normaliseTheme, DEFAULT_COUNT } = require('../server/utils/recapThemes');
const { recapFilenames } = require('./recap-styles-used');
const { filenamesToSlugs, parseRecapFilename, isValidSlug } = require('../server/utils/recapFiles');

const REPO = path.join(__dirname, '..');
const RECAPS_ROOT = path.join(REPO, 'recaps');
const BASE_URL = process.env.STATFINK_BASE_URL || 'http://localhost:8000';
const JOB = 'recap-setup';
const CLAUDE_TIMEOUT_MS = 5 * 60 * 1000;

const args = process.argv.slice(2);
const argValue = flag => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const OPTS = {
    season: argValue('--season') ? parseInt(argValue('--season')) : null,
    week: argValue('--week') ? parseInt(argValue('--week')) : null,
    force: args.includes('--force'),
    dryRun: args.includes('--dry-run')
};

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

async function getJson(url) {
    const res = await fetch(url, { headers: { 'X-Internal-Token': 'statfink-internal-cron' } });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return body && body.data !== undefined ? body.data : body;
}

async function weekCompletion(season, week) {
    const games = await getJson(`${BASE_URL}/api/nfl-games/${week}/${season}`);
    const list = Array.isArray(games) ? games : [];
    const finals = list.filter(g => /^Final/.test(g.status || '')).length;
    return { total: list.length, finals, complete: list.length > 0 && finals === list.length };
}

function recapsExist(season, week) {
    return recapFilenames(RECAPS_ROOT, season).some(f => { const p = parseRecapFilename(f); return p && Number(p.week) === Number(week); });
}

/** Pick the week to set up: explicit, else current week if complete, else the previous week (just advanced). */
async function resolveTarget() {
    if (OPTS.season && OPTS.week) {
        const c = await weekCompletion(OPTS.season, OPTS.week);
        return c.complete ? { season: OPTS.season, week: OPTS.week, completion: c } : { skip: `${OPTS.season} week ${OPTS.week}: ${c.finals}/${c.total} final — not complete` };
    }
    const settings = await getJson(`${BASE_URL}/api/league/settings`);
    const season = Number(settings.season_year);
    const week = Number(settings.current_week);
    if (!season || !week) return { skip: 'League settings have no season/current_week' };
    const cur = await weekCompletion(season, week);
    if (cur.complete) return { season, week, completion: cur };
    if (week > 1) {
        const prev = await weekCompletion(season, week - 1);
        if (prev.complete && !readThemes(season, week - 1) && !recapsExist(season, week - 1)) return { season, week: week - 1, completion: prev };
    }
    return { skip: cur.total === 0 ? `${season} week ${week}: no games scheduled (offseason?)` : `${season} week ${week}: ${cur.finals}/${cur.total} final — waiting for the week to complete` };
}

function exclusionList(season) {
    const used = filenamesToSlugs(recapFilenames(RECAPS_ROOT, season));
    return [...new Set([...used, ...slugsProposedThisSeason(season)])].sort();
}

function buildPrompt(season, week, exclude, count) {
    return [
        `Propose ${count} persona "themes" for the PFL fantasy football league's ${season} week ${week} owner recaps.`,
        'Each recap is a one-page write-up of the week\'s matchups, written entirely in one persona\'s voice, read by 12 league owners who have seen many of these.',
        'Rules:',
        '- Every theme is a PARTICULAR PERSON, named: a real celebrity, comedian, broadcaster, actor, politician, author or historical figure, or a specific well-known fictional character (e.g. "Christopher Walken", "Jim Gaffigan", "Howard Cosell", "Ron Swanson"). The commissioner prefers named people over broad formats or genres - do NOT propose formats, genres or generic roles (no "courtroom transcript", "film noir", "cooking show host", "pirate captain", "1920s radio").',
        '- Pick people with an instantly recognisable voice: distinctive cadence, catchphrases, recurring obsessions, so the recap reads unmistakably as them.',
        '- Every theme must be distinct from every other and from the exclusion list below (near-duplicates count: "walken" vs "christopher-walken").',
        '- Vary the mix: comedians, sports broadcasters, actors, TV hosts, musicians, authors, historical figures, fictional characters - no more than two or three from one category, and lean towards people a mixed group of American adults would recognise.',
        '- Keep every theme workable in ~600 words of prose and suitable for a mixed adult audience.',
        `- Week ${week} of an 18-week season${week >= 12 && week <= 13 ? ' (Thanksgiving week - a seasonally apt person or two is welcome)' : week >= 16 ? ' (holiday season - a seasonally apt person is welcome)' : ''}.`,
        '',
        'Exclusion list (already used or proposed this season):',
        exclude.length ? exclude.map(s => `- ${s}`).join('\n') : '- (none yet)',
        '',
        'Reply with ONLY a JSON array, no prose, no code fence:',
        '[{"name": "Morgan Freeman", "slug": "morgan-freeman", "description": "one sentence on the voice and what makes it fun"}, ...]',
        'slug: the person\'s name, lowercase letters, digits and hyphens only.'
    ].join('\n');
}

function parseThemes(envelope, exclude) {
    const text = envelope && typeof envelope.result === 'string' ? envelope.result : '';
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) throw new Error(`claude returned no JSON array: ${text.slice(0, 300)}`);
    let arr;
    try { arr = JSON.parse(m[0]); } catch (err) { throw new Error(`claude JSON unparsable: ${err.message}`); }
    const seen = new Set(exclude);
    const out = [];
    for (const raw of arr) {
        let t;
        try { t = normaliseTheme(raw, 'suggested'); } catch (_) { continue; }
        if (!isValidSlug(t.slug) || seen.has(t.slug)) continue;
        seen.add(t.slug);
        out.push(t);
    }
    return out;
}

async function main() {
    const started = Date.now();
    log(`Recap setup starting${OPTS.dryRun ? ' (dry run)' : ''}${OPTS.force ? ' (force)' : ''}`);
    let target;
    try { target = await resolveTarget(); } catch (err) {
        const summary = `Server unreachable: ${err.message}`;
        log(summary);
        if (!OPTS.dryRun) writeJobStatus(JOB, { status: 'critical', summary, durationMs: Date.now() - started, link: '/admin/recaps' });
        return 1;
    }
    if (target.skip) {
        log(`Skipped: ${target.skip}`);
        if (!OPTS.dryRun) writeJobStatus(JOB, { status: 'skipped', summary: target.skip, durationMs: Date.now() - started, link: '/admin/recaps' });
        return 0;
    }
    const { season, week } = target;
    const existing = readThemes(season, week);
    if (existing && !OPTS.force) {
        const summary = `${season} week ${week}: ${existing.themes.length} themes proposed ${existing.proposedAt} — ${existing.generatedAt ? `recaps generated ${existing.generatedAt}` : 'review and generate on /admin Recaps'}`;
        log(`Skipped: ${summary}`);
        if (!OPTS.dryRun) writeJobStatus(JOB, { status: 'skipped', summary, season, week, durationMs: Date.now() - started, link: '/admin/recaps' });
        return 0;
    }
    if (!existing && recapsExist(season, week) && !OPTS.force) {
        const summary = `${season} week ${week}: recaps already exist — nothing to set up`;
        log(`Skipped: ${summary}`);
        if (!OPTS.dryRun) writeJobStatus(JOB, { status: 'skipped', summary, season, week, durationMs: Date.now() - started, link: '/admin/recaps' });
        return 0;
    }

    const doc = existing || { season, week, proposedAt: null, proposedBy: 'claude', generatedAt: null, themes: [] };
    const suggestedNow = doc.themes.filter(t => t.origin === 'suggested').length;
    const want = Math.max(0, DEFAULT_COUNT - suggestedNow);
    if (want === 0) {
        log(`Skipped: ${season} week ${week} already has ${suggestedNow} suggested themes`);
        return 0;
    }
    const exclude = [...new Set([...exclusionList(season), ...doc.themes.map(t => t.slug)])];
    const prompt = buildPrompt(season, week, exclude, want);
    log(`Asking claude for ${want} themes for ${season} week ${week} (${exclude.length} excluded)`);
    if (OPTS.dryRun) { console.log(prompt); return 0; }

    writeJobStatus(JOB, { status: 'running', summary: `proposing themes for ${season} week ${week}`, season, week, link: '/admin/recaps' });
    const result = await runClaude(['-p', prompt, '--output-format', 'json', '--model', 'sonnet', '--max-turns', '1', '--allowedTools', ''], { timeoutMs: CLAUDE_TIMEOUT_MS });
    let themes = [];
    let error = result.error;
    if (!error) {
        try { themes = parseThemes(result.envelope, exclude).slice(0, want); } catch (err) { error = err.message; }
    }
    if (!error && themes.length < Math.min(want, 5)) error = `claude proposed only ${themes.length} usable themes`;

    if (error) {
        const summary = `${season} week ${week}: could not propose themes (${error.slice(0, 200)}) — add themes by hand on /admin Recaps or retry`;
        log(summary);
        writeJobStatus(JOB, { status: 'warning', summary, season, week, durationMs: Date.now() - started, link: '/admin/recaps', details: { error } });
        return 1;
    }

    for (const t of themes) doc.themes.push(t);
    doc.proposedAt = new Date().toISOString();
    doc.proposedBy = 'claude';
    const file = writeThemes(doc);
    const summary = `${season} week ${week}: ${themes.length} themes proposed — review and generate on /admin Recaps`;
    log(`${summary} (${path.relative(REPO, file)}): ${themes.map(t => t.slug).join(', ')}`);
    writeJobStatus(JOB, { status: 'ok', summary, season, week, durationMs: Date.now() - started, link: '/admin/recaps',
        details: { themes: themes.map(t => t.slug), file: path.relative(REPO, file), claude: { costUsd: result.envelope?.total_cost_usd ?? null, durationMs: result.envelope?.duration_ms ?? null } } });
    return 0;
}

module.exports = { buildPrompt, parseThemes, exclusionList };

if (require.main === module) {
    main().then(code => process.exit(code)).catch(err => { log(`Recap setup crashed: ${err.message}`); writeJobStatus(JOB, { status: 'critical', summary: `crashed: ${err.message}`, link: '/admin/recaps' }); process.exit(1); });
}
