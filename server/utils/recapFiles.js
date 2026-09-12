/**
 * Shared helpers for the weekly recap files under recaps/{season}/.
 *
 * Recap filenames are the source of truth for season/week/style
 * ({season}-week{NN}-{style-slug}-style.md); these parsers are used by the
 * admin recap endpoints, scripts/recap-styles-used.js, and
 * scripts/weekly-recap-run.js. Pure functions only - no fs, no DB.
 */

const RECAP_FILENAME_RE = /^(\d{4})-week(\d{2})-([a-z0-9-]+)-style\.md$/;
const SLUG_RE = /^[a-z0-9-]{1,80}$/;

function parseRecapFilename(name) {
    const m = RECAP_FILENAME_RE.exec(name);
    if (!m) return null;
    return { season: parseInt(m[1], 10), week: parseInt(m[2], 10), slug: m[3] };
}

function filenamesToSlugs(names) {
    const slugs = new Set();
    for (const name of names) {
        const parsed = parseRecapFilename(name);
        if (parsed) slugs.add(parsed.slug);
    }
    return [...slugs].sort();
}

function isValidSlug(slug) {
    return typeof slug === 'string' && SLUG_RE.test(slug);
}

function isValidSeason(season) {
    return /^\d{4}$/.test(String(season));
}

function isValidWeek(week) {
    const n = parseInt(week, 10);
    return /^\d{1,2}$/.test(String(week)) && n >= 1 && n <= 22;
}

function weekPad(week) {
    return String(week).padStart(2, '0');
}

function recapFilename(season, week, slug) {
    return `${season}-week${weekPad(week)}-${slug}-style.md`;
}

function slugToDisplayName(slug) {
    return slug.split('-')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

/**
 * Parse a recap-fact-checker report. Verdicts appear on greppable lines of the
 * form "{filename}: PASS" or "{filename}: FAIL (2 critical, 1 minor)", both as
 * per-recap headings and in the Summary section. Returns a map keyed by style
 * slug: { verdict: 'PASS'|'FAIL', critical, minor }. Later (Summary) lines win
 * because they carry the counts.
 */
function parseFactcheckReport(text) {
    const results = {};
    const lineRe = /^[-#>*\s]*([\w][\w.-]*-style\.md)\s*\**\s*:\s*\**\s*(PASS|FAIL)\s*\**(?:\s*\((\d+)\s*critical(?:,\s*(\d+)\s*minor)?\))?/gim;
    let m;
    while ((m = lineRe.exec(text)) !== null) {
        const parsed = parseRecapFilename(m[1]);
        if (!parsed) continue;
        results[parsed.slug] = {
            verdict: m[2].toUpperCase(),
            critical: m[3] !== undefined ? parseInt(m[3], 10) : null,
            minor: m[4] !== undefined ? parseInt(m[4], 10) : null
        };
    }
    return results;
}

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Minimal markdown -> HTML for recap prose (headings, bold/italic, hr,
 * blockquotes, flat lists, paragraphs). Used for the Gmail draft body; the
 * admin dashboard has its own equivalent client-side renderer. Input is
 * HTML-escaped first, so untrusted markdown cannot inject markup.
 */
function markdownToHtml(md) {
    const inline = s => s
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>');

    const out = [];
    let list = null; // 'ul' | 'ol' | null
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

    for (const rawLine of escapeHtml(md).split('\n')) {
        const line = rawLine.trimEnd();
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        const bullet = /^[-*]\s+(.*)$/.exec(line);
        const numbered = /^\d+\.\s+(.*)$/.exec(line);

        if (heading) {
            closeList();
            const level = heading[1].length;
            out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        } else if (/^(-{3,}|_{3,}|\*{3,})$/.test(line)) {
            closeList();
            out.push('<hr>');
        } else if (line.startsWith('&gt;')) {
            closeList();
            out.push(`<blockquote>${inline(line.replace(/^&gt;\s?/, ''))}</blockquote>`);
        } else if (bullet || numbered) {
            const type = bullet ? 'ul' : 'ol';
            if (list !== type) { closeList(); out.push(`<${type}>`); list = type; }
            out.push(`<li>${inline((bullet || numbered)[1])}</li>`);
        } else if (line === '') {
            closeList();
        } else {
            closeList();
            out.push(`<p>${inline(line)}</p>`);
        }
    }
    closeList();
    return out.join('\n');
}

module.exports = {
    parseRecapFilename,
    markdownToHtml,
    filenamesToSlugs,
    isValidSlug,
    isValidSeason,
    isValidWeek,
    weekPad,
    recapFilename,
    slugToDisplayName,
    parseFactcheckReport
};
