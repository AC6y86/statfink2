'use strict';

/**
 * Per-week recap themes (the commissioner-reviewed list the /recap command
 * writes one recap per theme from).
 *
 *   recaps/{season}/data/week{NN}-themes.json
 *   { season, week, proposedAt, proposedBy: 'claude'|'manual', generatedAt|null,
 *     themes: [ { slug, name, description, origin: 'suggested'|'commissioner', addedAt } ] }
 *
 * Proposed by scripts/recap-setup.js once every game of the week is Final;
 * edited from /admin Recaps (add / remove); consumed by .claude/commands/recap.md.
 */

const fs = require('fs');
const path = require('path');
const { isValidSlug, weekPad } = require('./recapFiles');

const RECAPS_ROOT = path.join(__dirname, '../../recaps');
const MAX_THEMES = 20;
const DEFAULT_COUNT = 10;

function themesPath(season, week, root = RECAPS_ROOT) {
    return path.join(root, String(season), 'data', `week${weekPad(week)}-themes.json`);
}

function readThemes(season, week, root = RECAPS_ROOT) {
    try {
        const t = JSON.parse(fs.readFileSync(themesPath(season, week, root), 'utf8'));
        if (!t || !Array.isArray(t.themes)) return null;
        return t;
    } catch (_) {
        return null;
    }
}

function writeThemes(doc, root = RECAPS_ROOT) {
    const file = themesPath(doc.season, doc.week, root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
    fs.renameSync(tmp, file);
    return file;
}

/** "Morgan Freeman narration" -> "morgan-freeman-narration" */
function slugify(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)
        .replace(/-+$/, '');
}

/** Validate + normalise one theme; throws Error(message) on bad input. */
function normaliseTheme(input, origin) {
    const name = String((input && input.name) || '').trim().replace(/\s+/g, ' ');
    if (name.length < 3 || name.length > 80) throw new Error('Theme name must be 3-80 characters');
    const slug = (input && input.slug && isValidSlug(String(input.slug))) ? String(input.slug) : slugify(name);
    if (!slug || !isValidSlug(slug)) throw new Error(`Cannot make a usable slug from "${name}"`);
    const description = String((input && input.description) || '').trim().slice(0, 300);
    return { slug, name, description, origin, addedAt: new Date().toISOString() };
}

/** All theme docs of a season, newest week first. */
function listThemeWeeks(season, root = RECAPS_ROOT) {
    const dir = path.join(root, String(season), 'data');
    let files = [];
    try { files = fs.readdirSync(dir); } catch (_) { return []; }
    return files
        .map(f => (/^week(\d{2})-themes\.json$/.exec(f) || [])[1])
        .filter(Boolean)
        .map(Number)
        .sort((a, b) => b - a)
        .map(week => readThemes(season, week, root))
        .filter(Boolean);
}

/** Slugs proposed earlier this season (used or not) - part of the exclusion list. */
function slugsProposedThisSeason(season, root = RECAPS_ROOT) {
    const out = new Set();
    for (const doc of listThemeWeeks(season, root)) for (const t of doc.themes) out.add(t.slug);
    return [...out];
}

function addTheme(doc, input, origin = 'commissioner') {
    const theme = normaliseTheme(input, origin);
    if (doc.themes.length >= MAX_THEMES) throw new Error(`At most ${MAX_THEMES} themes per week`);
    if (doc.themes.some(t => t.slug === theme.slug)) throw new Error(`Theme "${theme.slug}" is already on the list`);
    doc.themes.push(theme);
    return theme;
}

function removeTheme(doc, slug) {
    const i = doc.themes.findIndex(t => t.slug === slug);
    if (i < 0) throw new Error(`No theme "${slug}" on the list`);
    return doc.themes.splice(i, 1)[0];
}

module.exports = { RECAPS_ROOT, MAX_THEMES, DEFAULT_COUNT, themesPath, readThemes, writeThemes, slugify, normaliseTheme, listThemeWeeks, slugsProposedThisSeason, addTheme, removeTheme };
