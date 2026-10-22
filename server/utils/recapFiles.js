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

// Standing commissioner rule handed verbatim to every narrator and fact-checker
// (scripts/weekly-recap-run.js, scripts/recap-regenerate.js). Joe, 2026-10-15:
// draft grades are no longer relevant to the weekly recaps.
const NO_DRAFT_GRADES_RULE = 'Standing commissioner rule (Joe, 2026-10-15): never mention, compare against or otherwise use preseason/draft grades (letter grades, draft-recap rankings, "the A-grade team", "the C+ unbeatens") - they are no longer relevant. If the storylines file still contains draft grades, ignore that material entirely and do not carry it forward.';

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
 * blockquotes, flat lists, pipe tables, paragraphs). Used for the Gmail draft
 * body; the admin dashboard has its own equivalent client-side renderer
 * (helm/admin/js/ui.js renderMarkdown - keep the two in step). Input is
 * HTML-escaped first, so untrusted markdown cannot inject markup.
 */
function markdownToHtml(md) {
    const inline = s => s
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>');

    const out = [];
    let list = null; // 'ul' | 'ol' | null
    let table = false;
    const closeBlocks = () => {
        if (list) { out.push(`</${list}>`); list = null; }
        if (table) { out.push('</table>'); table = false; }
    };

    for (const rawLine of escapeHtml(md).split('\n')) {
        const line = rawLine.trimEnd();
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        const bullet = /^[-*]\s+(.*)$/.exec(line);
        const numbered = /^\d+\.\s+(.*)$/.exec(line);

        if (heading) {
            closeBlocks();
            const level = heading[1].length;
            out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        } else if (/^(-{3,}|_{3,}|\*{3,})$/.test(line)) {
            closeBlocks();
            out.push('<hr>');
        } else if (line.startsWith('&gt;')) {
            closeBlocks();
            out.push(`<blockquote>${inline(line.replace(/^&gt;\s?/, ''))}</blockquote>`);
        } else if (/^\|.*\|$/.test(line)) {
            const cells = line.slice(1, -1).split('|').map(c => c.trim());
            if (cells.every(c => /^:?-+:?$/.test(c))) continue; // header/body separator row
            if (list) { out.push(`</${list}>`); list = null; }
            if (!table) {
                out.push('<table>');
                table = true;
                out.push(`<tr>${cells.map(c => `<th>${inline(c)}</th>`).join('')}</tr>`);
            } else {
                out.push(`<tr>${cells.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`);
            }
        } else if (bullet || numbered) {
            const type = bullet ? 'ul' : 'ol';
            if (table) { out.push('</table>'); table = false; }
            if (list !== type) { if (list) out.push(`</${list}>`); out.push(`<${type}>`); list = type; }
            out.push(`<li>${inline((bullet || numbered)[1])}</li>`);
        } else if (line === '') {
            closeBlocks();
        } else {
            closeBlocks();
            out.push(`<p>${inline(line)}</p>`);
        }
    }
    closeBlocks();
    return out.join('\n');
}

/**
 * The fact-check report's section for one recap: from its
 * "## {file}-style.md: VERDICT" heading to the next "## " heading. Returns
 * { verdict, detail } (detail = the section body, markdown) or null.
 */
function factcheckSection(text, slug) {
    if (!text || !isValidSlug(slug)) return null;
    const re = new RegExp(`^#{2,3}\\s+[\\w.-]*-week\\d{2}-${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-style\\.md\\s*:\\s*\\**\\s*(PASS|FAIL)[^\\n]*\\n([\\s\\S]*?)(?=^#{2,3}\\s|(?![\\s\\S]))`, 'mi');
    const m = re.exec(text);
    if (!m) return null;
    return { verdict: m[1].toUpperCase(), detail: m[2].trim() };
}

const FEEDBACK_MIN = 5;
const FEEDBACK_MAX = 2000;

/**
 * Commissioner feedback for a single-recap rewrite (the "Give feedback and run
 * again" box on /admin Recaps). Trims, normalises line endings, and bounds the
 * length; throws Error(message) on bad input so the route can answer 400.
 */
function normaliseFeedback(input) {
    if (typeof input !== 'string') throw new Error('feedback must be a string');
    const text = input.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
    if (text.length < FEEDBACK_MIN) throw new Error(`Say what should change (at least ${FEEDBACK_MIN} characters)`);
    if (text.length > FEEDBACK_MAX) throw new Error(`Feedback is too long (${text.length} characters; at most ${FEEDBACK_MAX})`);
    return text;
}

/**
 * Put one recap's verdict into a week's fact-check report after that recap
 * alone was rewritten: replaces its "## {file}: VERDICT" section (through the
 * next "## " heading) and its Summary line, or adds both when missing; with no
 * report yet, starts one. Pure: returns the new report text.
 */
function replaceFactcheckEntry(report, { season, week, slug, verdict, critical = 0, minor = 0, detail = '' }) {
    const file = recapFilename(season, week, slug);
    const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const v = String(verdict).toUpperCase() === 'PASS' ? 'PASS' : 'FAIL';
    const body = String(detail || '').trim();
    const section = `## ${file}: ${v}\n\n${body ? `${body}\n\n` : ''}`;
    const summaryLine = `- ${file}: ${v} (${critical} critical, ${minor} minor)`;

    let out = report && report.trim() ? report.replace(/\r\n?/g, '\n') : `# Week ${week} Recap Fact-Check\n\n`;
    if (!/^## Summary[ \t]*$/m.test(out)) out = `${out.trimEnd()}\n\n## Summary\n`;

    const sectionRe = new RegExp(`^#{2,3}[ \\t]+\\**${escaped}\\**[ \\t]*:[^\\n]*\\n[\\s\\S]*?(?=^#{2,3}[ \\t])`, 'm');
    if (sectionRe.test(out)) out = out.replace(sectionRe, () => section);
    else out = out.replace(/^## Summary[ \t]*$/m, () => `${section}## Summary`);

    const lineRe = new RegExp(`^[-*][ \\t]*\\**${escaped}\\**[ \\t]*:[^\\n]*$`, 'm');
    if (lineRe.test(out)) out = out.replace(lineRe, () => summaryLine);
    else out = `${out.trimEnd()}\n${summaryLine}\n`;
    return out.endsWith('\n') ? out : `${out}\n`;
}

module.exports = {
    parseRecapFilename,
    markdownToHtml,
    factcheckSection,
    normaliseFeedback,
    replaceFactcheckEntry,
    FEEDBACK_MAX,
    NO_DRAFT_GRADES_RULE,
    filenamesToSlugs,
    isValidSlug,
    isValidSeason,
    isValidWeek,
    weekPad,
    recapFilename,
    slugToDisplayName,
    parseFactcheckReport
};
