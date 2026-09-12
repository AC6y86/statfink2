#!/usr/bin/env node

/**
 * Print every recap style slug already used, scoped to one season (the
 * exclusion list resets each season - commissioner's call). The /recap
 * command runs this with the target season so a style is never repeated
 * within a season; prior seasons' styles become available again.
 *
 * Usage: node scripts/recap-styles-used.js [season]
 *   With a season: slugs used in that season only (the normal case).
 *   Without: slugs across all seasons (reference/debugging).
 */

const fs = require('fs');
const path = require('path');
const { filenamesToSlugs } = require('../server/utils/recapFiles');

const RECAPS_ROOT = path.join(__dirname, '../recaps');

function recapFilenames(root, season) {
    let seasons = [];
    try {
        seasons = fs.readdirSync(root).filter(d => /^\d{4}$/.test(d));
    } catch (_) {
        return [];
    }
    if (season) seasons = seasons.filter(d => d === String(season));
    const names = [];
    for (const s of seasons) {
        try {
            names.push(...fs.readdirSync(path.join(root, s)));
        } catch (_) { /* not a directory */ }
    }
    return names;
}

function main() {
    const season = process.argv[2] || null;
    if (season && !/^\d{4}$/.test(season)) {
        console.error(`Invalid season: ${season}`);
        process.exit(1);
    }
    const slugs = filenamesToSlugs(recapFilenames(RECAPS_ROOT, season));
    const scope = season ? `in ${season}` : 'across all seasons';
    console.log(`# ${slugs.length} styles already used ${scope} - do not reuse these or near-duplicates`);
    for (const slug of slugs) console.log(slug);
}

if (require.main === module) main();

module.exports = { recapFilenames };
