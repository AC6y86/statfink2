'use strict';

/**
 * Per-week recap ratings: storytelling + interest, 1-5 stars in half steps,
 * one line of rationale each, and ONE recommended recap (the star on
 * /admin Recaps).
 *
 *   recaps/{season}/data/week{NN}-ratings.json
 *   { season, week, ratedAt, ratedBy, recommended: slug|null,
 *     ratings: { [slug]: { stars, blurb } } }
 *
 * Written by scripts/recap-rate.js (headless claude, run by
 * scripts/weekly-recap-run.js after generation, or from /admin Recaps);
 * the commissioner's own preference (2026-09-15): rate on storytelling and
 * how interesting the recap is, and put a recommended star next to one.
 */

const fs = require('fs');
const path = require('path');
const { isValidSlug, weekPad } = require('./recapFiles');

const RECAPS_ROOT = path.join(__dirname, '../../recaps');

function ratingsPath(season, week, root = RECAPS_ROOT) {
    return path.join(root, String(season), 'data', `week${weekPad(week)}-ratings.json`);
}

function readRatings(season, week, root = RECAPS_ROOT) {
    try {
        const r = JSON.parse(fs.readFileSync(ratingsPath(season, week, root), 'utf8'));
        if (!r || typeof r.ratings !== 'object' || r.ratings === null) return null;
        return r;
    } catch (_) {
        return null;
    }
}

function writeRatings(doc, root = RECAPS_ROOT) {
    const file = ratingsPath(doc.season, doc.week, root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
    fs.renameSync(tmp, file);
    return file;
}

/** Clamp to 1-5 in half steps; null when not a number. */
function normaliseStars(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.min(5, Math.max(1, Math.round(n * 2) / 2));
}

/**
 * Turn a model reply ({ recommended, ratings: [{slug, stars, blurb}] }) into a
 * ratings doc restricted to `slugs` (the week's recap files). Recaps that
 * failed the fact-check (`failed`) may be rated but never recommended.
 */
function normaliseRatings(raw, { season, week, slugs, failed = [], ratedBy = 'claude' }) {
    const allowed = new Set(slugs);
    const ratings = {};
    const list = Array.isArray(raw && raw.ratings) ? raw.ratings : [];
    for (const item of list) {
        if (!item || !isValidSlug(String(item.slug || ''))) continue;
        const slug = String(item.slug);
        if (!allowed.has(slug) || ratings[slug]) continue;
        const stars = normaliseStars(item.stars);
        if (stars === null) continue;
        ratings[slug] = { stars, blurb: String(item.blurb || '').trim().slice(0, 300) };
    }
    const failedSet = new Set(failed);
    let recommended = raw && typeof raw.recommended === 'string' && ratings[raw.recommended] && !failedSet.has(raw.recommended) ? raw.recommended : null;
    if (!recommended) {
        // Fall back to the best-rated recap that passed the fact-check
        const best = Object.entries(ratings).filter(([s]) => !failedSet.has(s)).sort((a, b) => b[1].stars - a[1].stars || a[0].localeCompare(b[0]))[0];
        recommended = best ? best[0] : null;
    }
    return { season, week, ratedAt: new Date().toISOString(), ratedBy, recommended, ratings };
}

/** Rating for one slug ({ stars, blurb, recommended }) or null. */
function ratingFor(doc, slug) {
    if (!doc || !doc.ratings[slug]) return null;
    return { ...doc.ratings[slug], recommended: doc.recommended === slug };
}

module.exports = { RECAPS_ROOT, ratingsPath, readRatings, writeRatings, normaliseStars, normaliseRatings, ratingFor };
