/**
 * NFL.com-only, fail-closed injury eligibility gate for ordinary IR moves.
 *
 * A player may be placed on a StatFink IR slot (moveType 'ir') only when
 * NFL.com itself, fetched fresh at validation time, says one of:
 *
 *   1. the official current-week injury report
 *      (https://www.nfl.com/injuries/league/{season}/reg{week}) lists the
 *      player for his team with a Game Status of exactly "Out"; or
 *   2. the player's current NFL.com team roster page
 *      (https://www.nfl.com/teams/{slug}/roster) shows a Reserve/Injured
 *      Status code ("RES", or "RSR" = Reserve/Injured; Designated for Return)
 *      AND an official Reserve/Injured transaction for that player and team
 *      exists on the NFL.com reserve-list transactions pages
 *      (https://www.nfl.com/transactions/league/reserve-list/{year}/{month},
 *      paginated with ?after=).
 *
 * Players on Reserve/Injured are NOT carried on the weekly injury report, so
 * path 2 is the normal route for a player already on NFL IR (James Conner,
 * 2026 week 4: absent from the report, roster "RSR", Reserve/Injured
 * transaction 08/30/2026). Roster Status codes are classified in
 * ROSTER_STATUS (below): only the Reserve/Injured codes can lead to
 * eligibility and never on their own - the transaction is still required;
 * known non-injury reserve codes (PUP, RSN, EXE, SUS, RET, ...) are refused
 * definitively with their meaning spelled out; a code this module has never
 * seen is refused as NFL_UNAVAILABLE so a new NFL.com code can never be
 * silently read as "not injured" (or as injured).
 *
 * Nothing else establishes eligibility: no Tank01 data, no
 * nfl_players.injury_designation, no cache, no news copy, no fallback. Every
 * request has a hard timeout, must end on an nfl.com hostname with HTTP 200
 * and an HTML content type, and the page must identify itself as the
 * expected season/week/team before it is trusted. Any transport or parsing
 * uncertainty throws NflEligibilityError with code 'NFL_UNAVAILABLE'
 * ("Validation failed: fresh NFL.com data unavailable (...)"); a clean fetch
 * that does not show Out / current Reserve/Injured throws code
 * 'NFL_INELIGIBLE' with the observed status.
 *
 * The service holds no state and caches nothing; each check performs fresh
 * network fetches, each with its own CDN cache key (see cacheKeyHeaders) so a
 * cached copy of a different page can never stand in for the page asked for.
 * Parsing helpers are exported for fixture-driven tests, and the fetch
 * function is injectable so tests never touch the network.
 */
const axios = require('axios');
const { getTeamAbbreviation, isCanonicalTeamCode } = require('../utils/teamMappings');

const NFL_ORIGIN = 'https://www.nfl.com';
const ALLOWED_HOSTS = new Set(['www.nfl.com', 'nfl.com']);
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_MAX_TRANSACTION_PAGES = 20; // per month; fail closed if exceeded
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) statfink2-ir-eligibility-check';

// Canonical team code -> NFL.com team slug (path segment under /teams/).
const TEAM_SLUGS = {
    ARI: 'arizona-cardinals', ATL: 'atlanta-falcons', BAL: 'baltimore-ravens',
    BUF: 'buffalo-bills', CAR: 'carolina-panthers', CHI: 'chicago-bears',
    CIN: 'cincinnati-bengals', CLE: 'cleveland-browns', DAL: 'dallas-cowboys',
    DEN: 'denver-broncos', DET: 'detroit-lions', GB: 'green-bay-packers',
    HOU: 'houston-texans', IND: 'indianapolis-colts', JAX: 'jacksonville-jaguars',
    KC: 'kansas-city-chiefs', LAC: 'los-angeles-chargers', LAR: 'los-angeles-rams',
    LV: 'las-vegas-raiders', MIA: 'miami-dolphins', MIN: 'minnesota-vikings',
    NE: 'new-england-patriots', NO: 'new-orleans-saints', NYG: 'new-york-giants',
    NYJ: 'new-york-jets', PHI: 'philadelphia-eagles', PIT: 'pittsburgh-steelers',
    SEA: 'seattle-seahawks', SF: 'san-francisco-49ers', TB: 'tampa-bay-buccaneers',
    TEN: 'tennessee-titans', WAS: 'washington-commanders'
};
const SLUG_TO_CODE = Object.fromEntries(Object.entries(TEAM_SLUGS).map(([code, slug]) => [slug, code]));

/**
 * NFL.com roster-page Status codes, as established by cross-referencing the
 * roster pages of 13 teams against the official reserve-list transactions
 * on 2026-10-01 (every RSR player had a 53-man-cutdown-day Reserve/Injured
 * transaction, at most two per team - the NFL's cutdown return designation;
 * RES players had ordinary Reserve/Injured transactions; PUP players had
 * Reserve/Physically Unable to Perform transactions; etc.).
 *
 * kind: 'reserve_injured' - the player is on the Reserve/Injured list; may be
 *         eligible once an official Reserve/Injured transaction corroborates it.
 *       'not_injured_reserve' - a known code that is not Reserve/Injured;
 *         definitively ineligible, no transaction search needed.
 * Any code not listed here is UNKNOWN and fails closed as NFL_UNAVAILABLE.
 */
const ROSTER_STATUS = {
    RES: { kind: 'reserve_injured', meaning: 'Reserve/Injured' },
    RSR: { kind: 'reserve_injured', meaning: 'Reserve/Injured; Designated for Return' },
    ACT: { kind: 'not_injured_reserve', meaning: 'Active' },
    DEV: { kind: 'not_injured_reserve', meaning: 'Practice Squad' },
    PUP: { kind: 'not_injured_reserve', meaning: 'Reserve/Physically Unable to Perform' },
    RSN: { kind: 'not_injured_reserve', meaning: 'Reserve/Non-Football Injury or Illness' },
    NON: { kind: 'not_injured_reserve', meaning: 'Reserve/Non-Football Injury or Illness' },
    SUS: { kind: 'not_injured_reserve', meaning: 'Reserve/Suspended' },
    EXE: { kind: 'not_injured_reserve', meaning: 'Exempt/Commissioner Permission' },
    RET: { kind: 'not_injured_reserve', meaning: 'Reserve/Retired' },
    UDF: { kind: 'not_injured_reserve', meaning: 'Unsigned Draft Pick' },
    TRC: { kind: 'not_injured_reserve', meaning: 'transactional roster code, not Reserve/Injured' },
    TRD: { kind: 'not_injured_reserve', meaning: 'transactional roster code (traded), not Reserve/Injured' },
    CUT: { kind: 'not_injured_reserve', meaning: 'Released' },
    RLS: { kind: 'not_injured_reserve', meaning: 'Released' }
};

/**
 * Classify a roster Status cell. Returns { code, kind, meaning } where kind is
 * 'reserve_injured', 'not_injured_reserve' or 'unknown' (blank or never-seen
 * codes; callers must fail closed as unavailable, never as a verdict).
 */
function classifyRosterStatus(status) {
    const code = String(status || '').trim().toUpperCase();
    const known = Object.prototype.hasOwnProperty.call(ROSTER_STATUS, code) ? ROSTER_STATUS[code] : null;
    if (!code) return { code: '', kind: 'unknown', meaning: 'blank Status' };
    if (!known) return { code, kind: 'unknown', meaning: 'unrecognised NFL.com roster Status code' };
    return { code, kind: known.kind, meaning: known.meaning };
}

// Display name as NFL.com prints it in roster page titles.
const TEAM_FULL_NAMES = Object.fromEntries(Object.entries(TEAM_SLUGS).map(([code, slug]) => [
    code,
    slug.split('-').map(w => (w === '49ers' ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ')
]));

class NflEligibilityError extends Error {
    /**
     * @param {'NFL_UNAVAILABLE'|'NFL_INELIGIBLE'} code
     * @param {string} message
     * @param {object} evidence structured evidence (see buildEvidence)
     */
    constructor(code, message, evidence = null) {
        super(message);
        this.name = 'NflEligibilityError';
        this.code = code;
        this.evidence = evidence;
    }
}

// ---------------------------------------------------------------------------
// Small, dependency-free HTML helpers (NFL.com pages are plain server-rendered
// tables; a full DOM parser is not needed and would add a dependency).
// ---------------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
    return String(text)
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
        .replace(/&([a-z]+);/gi, (m, name) => (Object.prototype.hasOwnProperty.call(ENTITIES, name.toLowerCase()) ? ENTITIES[name.toLowerCase()] : m));
}

/** Strip tags and collapse whitespace. */
function textOf(html) {
    return decodeEntities(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** All <table>...</table> blocks with their start offsets. */
function findTables(html) {
    const tables = [];
    const re = /<table\b[^>]*>[\s\S]*?<\/table>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        tables.push({ html: m[0], start: m.index });
    }
    return tables;
}

/** Rows of a table as arrays of raw cell HTML (th/td). */
function tableRows(tableHtml) {
    const rows = [];
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let m;
    while ((m = rowRe.exec(tableHtml)) !== null) {
        const cells = [];
        const cellRe = /<t([hd])\b[^>]*>([\s\S]*?)<\/t\1>/gi;
        let c;
        while ((c = cellRe.exec(m[1])) !== null) {
            cells.push({ tag: 't' + c[1].toLowerCase(), html: c[2] });
        }
        if (cells.length) rows.push(cells);
    }
    return rows;
}

function headerIndex(rows) {
    const header = rows.find(r => r.every(c => c.tag === 'th'));
    if (!header) return null;
    const index = {};
    header.forEach((c, i) => { index[textOf(c.html).toLowerCase()] = i; });
    return index;
}

function firstMatch(re, html) {
    const m = re.exec(html);
    return m ? m[1] : null;
}

/**
 * Normalize a person name for deterministic comparison: HTML entities
 * decoded, diacritics stripped, generational suffix removed, everything but
 * letters and digits dropped, lower case. "Ja'Kobi Lane" -> "jakobilane".
 */
function normalizeName(name) {
    if (!name) return '';
    let s = decodeEntities(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    s = s.replace(/\s*,?\s+(jr|sr|ii|iii|iv|v)\.?$/i, '');
    return s.replace(/[^a-z0-9]/g, '');
}

/**
 * Canonical team code for anything NFL.com or the database calls a team, or
 * null when it cannot be resolved (the callers then fail closed). teamMappings
 * knows codes and nicknames ("Ravens", "49ers", WSH -> WAS); the full-name and
 * slug fallbacks cover the forms NFL.com prints on its own pages.
 */
function normalizeTeamCode(team) {
    const raw = String(team || '').trim();
    if (!raw) return null;
    const code = getTeamAbbreviation(raw);
    if (isCanonicalTeamCode(code)) return code;
    const key = raw.toLowerCase();
    const byFullName = Object.keys(TEAM_FULL_NAMES).find(c => TEAM_FULL_NAMES[c].toLowerCase() === key);
    return byFullName || SLUG_TO_CODE[key] || null;
}

// ---------------------------------------------------------------------------
// Page parsers (pure; fixture-tested)
// ---------------------------------------------------------------------------

/**
 * Parse the league injury report page. Returns { identity, teams } where
 * teams maps canonical team code -> [{ name, position, injuries,
 * practiceStatus, gameStatus }]. Throws NflEligibilityError(NFL_UNAVAILABLE)
 * when the page does not identify itself as the requested season/week.
 */
function parseInjuryReport(html, { season, week }) {
    const title = textOf(firstMatch(/<title>([\s\S]*?)<\/title>/i, html) || '');
    const selected = firstMatch(/<option value="(\/injuries\/league\/\d{4}\/reg\d{1,2})"[^>]*\bselected\b/i, html);
    const expectedPath = `/injuries/league/${season}/reg${week}`;
    const titleOk = new RegExp(`Week ${week} of the ${season} Season`, 'i').test(title);
    if (!titleOk || selected !== expectedPath) {
        throw new NflEligibilityError('NFL_UNAVAILABLE',
            `Validation failed: fresh NFL.com data unavailable (injury report page identity mismatch: expected ${expectedPath}, got title "${title}"${selected ? `, selected ${selected}` : ''})`);
    }

    const teams = {};
    const tables = findTables(html);
    for (const table of tables) {
        const rows = tableRows(table.html);
        const idx = headerIndex(rows);
        if (!idx || idx.player === undefined || idx['game status'] === undefined) continue;

        // The team is named in the nearest preceding section sub-title.
        const before = html.slice(Math.max(0, table.start - 4000), table.start);
        const subtitles = [...before.matchAll(/d3-o-section-sub-title[^>]*>\s*<span>([\s\S]*?)<\/span>/gi)];
        const nickname = subtitles.length ? textOf(subtitles[subtitles.length - 1][1]) : null;
        const code = nickname ? normalizeTeamCode(nickname) : null;
        if (!code) {
            throw new NflEligibilityError('NFL_UNAVAILABLE',
                `Validation failed: fresh NFL.com data unavailable (injury report: could not attribute a table to a team${nickname ? `: "${nickname}"` : ''})`);
        }
        const list = teams[code] || (teams[code] = []);
        for (const row of rows) {
            if (row.every(c => c.tag === 'th')) continue;
            const cell = i => (i !== undefined && row[i] ? textOf(row[i].html) : '');
            list.push({
                name: cell(idx.player),
                position: cell(idx.position),
                injuries: cell(idx.injuries),
                practiceStatus: cell(idx['practice status']),
                gameStatus: cell(idx['game status'])
            });
        }
    }
    if (Object.keys(teams).length === 0) {
        throw new NflEligibilityError('NFL_UNAVAILABLE',
            'Validation failed: fresh NFL.com data unavailable (injury report: no team tables found)');
    }
    return { identity: { title, selected }, teams };
}

/**
 * Parse a team roster page. Returns { identity, players: [{ name, slug,
 * number, position, status }] }. Throws when the title does not name the
 * expected team and season.
 */
function parseTeamRoster(html, { teamCode, season }) {
    const title = textOf(firstMatch(/<title>([\s\S]*?)<\/title>/i, html) || '');
    const fullName = TEAM_FULL_NAMES[teamCode];
    if (!fullName || !title.toLowerCase().includes(fullName.toLowerCase()) || !title.includes(String(season)) || !/roster/i.test(title)) {
        throw new NflEligibilityError('NFL_UNAVAILABLE',
            `Validation failed: fresh NFL.com data unavailable (roster page identity mismatch: expected "${fullName} ${season} ... Roster", got title "${title}")`);
    }
    const tables = findTables(html);
    let players = null;
    for (const table of tables) {
        const rows = tableRows(table.html);
        const idx = headerIndex(rows);
        if (!idx || idx.player === undefined || idx.status === undefined) continue;
        players = [];
        for (const row of rows) {
            if (row.every(c => c.tag === 'th')) continue;
            const cell = i => (i !== undefined && row[i] ? textOf(row[i].html) : '');
            players.push({
                name: cell(idx.player),
                slug: firstMatch(/href="\/players\/([a-z0-9-]+)\/?"/i, row[idx.player].html),
                number: cell(idx.no),
                position: cell(idx.pos),
                status: cell(idx.status)
            });
        }
        break;
    }
    if (!players) {
        throw new NflEligibilityError('NFL_UNAVAILABLE',
            'Validation failed: fresh NFL.com data unavailable (roster page: no Player/Status table found)');
    }
    return { identity: { title }, players };
}

/**
 * Parse one reserve-list transactions page. Returns { identity, rows:
 * [{ fromSlug, toSlug, date, name, playerSlug, position, transaction }],
 * nextPath } where nextPath is the ?after= continuation (or null).
 */
function parseReserveTransactions(html, { year }) {
    const title = textOf(firstMatch(/<title>([\s\S]*?)<\/title>/i, html) || '');
    if (!title.includes(String(year)) || !/reserve-list/i.test(title)) {
        throw new NflEligibilityError('NFL_UNAVAILABLE',
            `Validation failed: fresh NFL.com data unavailable (transactions page identity mismatch: expected ${year} reserve-list, got title "${title}")`);
    }
    const tables = findTables(html);
    let rows = null;
    for (const table of tables) {
        const trs = tableRows(table.html);
        const idx = headerIndex(trs);
        if (!idx || idx.name === undefined || idx.transaction === undefined) continue;
        rows = [];
        for (const tr of trs) {
            if (tr.every(c => c.tag === 'th')) continue;
            const cell = i => (i !== undefined && tr[i] ? textOf(tr[i].html) : '');
            const slugIn = i => (i !== undefined && tr[i] ? firstMatch(/href="\/teams\/([a-z0-9-]+)\/?"/i, tr[i].html) : null);
            rows.push({
                fromSlug: slugIn(idx.from),
                toSlug: slugIn(idx.to),
                date: cell(idx.date),
                name: cell(idx.name),
                playerSlug: firstMatch(/href="\/players\/([a-z0-9-]+)\/?"/i, tr[idx.name].html),
                position: cell(idx.position),
                transaction: cell(idx.transaction)
            });
        }
        break;
    }
    if (rows === null) {
        throw new NflEligibilityError('NFL_UNAVAILABLE',
            'Validation failed: fresh NFL.com data unavailable (transactions page: no Name/Transaction table found)');
    }
    const next = firstMatch(/href="(\/transactions\/league\/reserve-list\/[^"]*?[?&]after=[^"]+)"/i, html);
    return { identity: { title }, rows, nextPath: next ? decodeEntities(next) : null };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * NFL.com is fronted by a CDN whose cache key for these pages is the path
 * alone - the ?after= pagination cursor is NOT part of it (Vary is
 * "Accept-Encoding, X-NFL-Geo, Origin", max-age=5). A plain walk therefore
 * gets HTTP 200 with a cached copy of a *different* page of the same month,
 * which silently hides transactions (observed: Isiah Pacheco's Reserve/Injured
 * row on page 3 of 2026/09). Varying a header the CDN varies on gives each
 * request its own cache key, so every response comes from the origin for the
 * exact URL asked for - which is also what "fresh, live NFL.com data" means
 * here. The value is an obviously non-browser, reserved-TLD (RFC 2606) origin
 * so it cannot be mistaken for a real site.
 */
let requestCounter = 0;
function cacheKeyHeaders() {
    requestCounter = (requestCounter + 1) % 1e6;
    const nonce = `${Date.now().toString(36)}-${requestCounter}-${Math.random().toString(36).slice(2, 8)}`;
    return {
        Origin: `https://${nonce}.statfink-ir-check.invalid`,
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache'
    };
}

/**
 * Default page fetcher: axios with a hard timeout. Returns
 * { status, contentType, body, finalUrl }. Follows redirects and reports the
 * final URL so the caller can enforce the nfl.com hostname. httpClient is
 * injectable so the transport contract can be unit tested without a network.
 */
async function defaultFetchPage(url, { timeoutMs, httpClient = axios } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await httpClient.get(url, {
            timeout: timeoutMs,
            signal: controller.signal,
            maxRedirects: 5,
            responseType: 'text',
            transformResponse: [d => d],
            validateStatus: () => true,
            maxContentLength: 5 * 1024 * 1024,
            headers: { 'User-Agent': USER_AGENT, Accept: 'text/html', ...cacheKeyHeaders() }
        });
        const finalUrl = (response.request && response.request.res && response.request.res.responseUrl) || url;
        return {
            status: response.status,
            contentType: String((response.headers && response.headers['content-type']) || ''),
            body: typeof response.data === 'string' ? response.data : '',
            finalUrl
        };
    } finally {
        clearTimeout(timer);
    }
}

/** The ?after= cursor of a reserve-list URL or path (null when there is none). */
function cursorOf(urlOrPath) {
    if (!urlOrPath) return null;
    try {
        return new URL(urlOrPath, NFL_ORIGIN).searchParams.get('after');
    } catch (_) {
        return null;
    }
}

/**
 * Order-sensitive fingerprint of a parsed transactions page: its rows AND the
 * cursor it points at next. Two genuinely different pages of the same month
 * always differ in at least one of those - including two *empty* pages, which
 * would collide on rows alone and make a legitimate walk look like a CDN
 * replay.
 */
function pageSignature(parsed) {
    const rows = (parsed && parsed.rows) || [];
    return `${rows.map(r => `${r.date}|${r.playerSlug || r.name}|${r.transaction}`).join(';')}>>${cursorOf(parsed && parsed.nextPath) || ''}`;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class NflRosterEligibilityService {
    /**
     * @param {object} [options]
     * @param {Function} [options.fetchPage] (url, { timeoutMs }) -> { status, contentType, body, finalUrl }
     * @param {number} [options.timeoutMs] per-request hard timeout
     * @param {number} [options.maxTransactionPages] per-month page cap (fail closed beyond)
     * @param {Function} [options.now] clock, for choosing which months to search
     */
    constructor({ fetchPage = defaultFetchPage, timeoutMs = DEFAULT_TIMEOUT_MS, maxTransactionPages = DEFAULT_MAX_TRANSACTION_PAGES, now = () => new Date() } = {}) {
        this.fetchPage = fetchPage;
        this.timeoutMs = timeoutMs;
        this.maxTransactionPages = maxTransactionPages;
        this.now = now;
    }

    static injuryReportUrl(season, week) {
        return `${NFL_ORIGIN}/injuries/league/${season}/reg${week}`;
    }

    static rosterUrl(teamCode) {
        return `${NFL_ORIGIN}/teams/${TEAM_SLUGS[teamCode]}/roster`;
    }

    static reserveListUrl(year, month) {
        return `${NFL_ORIGIN}/transactions/league/reserve-list/${year}/${String(month).padStart(2, '0')}`;
    }

    /** Fetch one NFL.com page with every transport check; throws NFL_UNAVAILABLE. */
    async fetchNflPage(url) {
        let result;
        try {
            result = await this.fetchPage(url, { timeoutMs: this.timeoutMs });
        } catch (error) {
            const why = error && (error.code === 'ECONNABORTED' || error.name === 'CanceledError' || error.name === 'AbortError')
                ? `timeout after ${this.timeoutMs}ms`
                : (error && error.message) || String(error);
            throw new NflEligibilityError('NFL_UNAVAILABLE', `Validation failed: fresh NFL.com data unavailable (${why} fetching ${url})`);
        }
        let host = null;
        try { host = new URL(result.finalUrl || url).hostname.toLowerCase(); } catch (_) { host = null; }
        if (!host || !ALLOWED_HOSTS.has(host)) {
            throw new NflEligibilityError('NFL_UNAVAILABLE', `Validation failed: fresh NFL.com data unavailable (response did not end on nfl.com: ${result.finalUrl || 'unknown host'} for ${url})`);
        }
        if (result.status !== 200) {
            throw new NflEligibilityError('NFL_UNAVAILABLE', `Validation failed: fresh NFL.com data unavailable (HTTP ${result.status} for ${url})`);
        }
        if (!/text\/html/i.test(result.contentType || '')) {
            throw new NflEligibilityError('NFL_UNAVAILABLE', `Validation failed: fresh NFL.com data unavailable (content-type "${result.contentType}" for ${url})`);
        }
        if (typeof result.body !== 'string' || !/<html/i.test(result.body) || !/<table/i.test(result.body)) {
            throw new NflEligibilityError('NFL_UNAVAILABLE', `Validation failed: fresh NFL.com data unavailable (response is not an HTML page with tables for ${url})`);
        }
        return result;
    }

    /**
     * Months (newest first) of the reserve-list to search for a season.
     * Reserve/Injured placements for a season happen from July (camp) through
     * the following February; in-season we stop at the current month.
     */
    monthsToSearch(season) {
        const now = this.now();
        const months = [];
        const push = (y, m) => months.push({ year: y, month: m });
        const inSeason = now.getUTCFullYear() === season;
        const currentMonth = now.getUTCMonth() + 1;
        if (inSeason) {
            for (let m = Math.max(currentMonth, 7); m >= 7; m--) push(season, m);
        } else if (now.getUTCFullYear() > season) {
            const end = now.getUTCFullYear() === season + 1 ? Math.min(currentMonth, 2) : 2;
            for (let m = end; m >= 1; m--) push(season + 1, m);
            for (let m = 12; m >= 7; m--) push(season, m);
        } else {
            for (let m = 12; m >= 7; m--) push(season, m);
        }
        return months;
    }

    /**
     * The gate. Resolves with evidence when eligible; throws
     * NflEligibilityError otherwise. Never consults anything but NFL.com.
     *
     * @param {object} p
     * @param {string} p.playerName full name as stored in nfl_players
     * @param {string} p.team NFL team (any code/nickname; WSH -> WAS)
     * @param {number} p.season
     * @param {number} p.week
     */
    async checkIrEligibility({ playerName, team, season, week }) {
        const checkedAt = new Date().toISOString();
        const sources = [];
        const player = { name: playerName, team: normalizeTeamCode(team) };
        const base = { player, season, week, checkedAt, sources, source: 'nfl.com' };
        const fail = (code, reason, extra = {}) =>
            new NflEligibilityError(code, reason, { eligible: false, code, reason, ...base, ...extra });

        if (!playerName || !normalizeName(playerName)) {
            throw fail('NFL_UNAVAILABLE', 'Validation failed: fresh NFL.com data unavailable (player name missing)');
        }
        if (!player.team) {
            throw fail('NFL_UNAVAILABLE', `Validation failed: fresh NFL.com data unavailable (unknown NFL team "${team}" for ${playerName})`);
        }
        if (!Number.isInteger(season) || !Number.isInteger(week) || week < 1 || week > 18) {
            throw fail('NFL_UNAVAILABLE', `Validation failed: fresh NFL.com data unavailable (invalid season/week ${season}/${week})`);
        }
        const wanted = normalizeName(playerName);
        const teamCode = player.team;
        const label = `${playerName} (${teamCode})`;

        // ---- 1. Official injury report: Game Status must be exactly "Out"
        const injuryUrl = NflRosterEligibilityService.injuryReportUrl(season, week);
        const injuryPage = await this.fetchNflPage(injuryUrl).catch(e => { throw fail(e.code, e.message); });
        sources.push(injuryUrl);
        let injury;
        try {
            injury = parseInjuryReport(injuryPage.body, { season, week });
        } catch (e) {
            throw fail(e.code || 'NFL_UNAVAILABLE', e.message);
        }
        const injuryRows = (injury.teams[teamCode] || []).filter(r => normalizeName(r.name) === wanted);
        if (injuryRows.length > 1) {
            throw fail('NFL_UNAVAILABLE', `Validation failed: fresh NFL.com data unavailable (injury report lists ${injuryRows.length} ${teamCode} players named ${playerName}; ambiguous)`);
        }
        let injuryObserved;
        if (injuryRows.length === 1) {
            const row = injuryRows[0];
            const status = String(row.gameStatus || '').trim();
            if (status.toLowerCase() === 'out') {
                return {
                    eligible: true,
                    code: 'OUT_ON_INJURY_REPORT',
                    reason: `NFL.com Week ${week} injury report lists ${label} with Game Status "Out"`,
                    observedStatus: `Game Status: ${status}`,
                    injuryReport: { listed: true, gameStatus: status, practiceStatus: row.practiceStatus, injuries: row.injuries },
                    ...base
                };
            }
            injuryObserved = `Game Status: ${status ? `"${status}"` : 'blank'}${row.practiceStatus ? `; Practice: ${row.practiceStatus}` : ''}`;
        } else {
            injuryObserved = 'not listed';
        }

        // ---- 2. Current roster page: Status must be a Reserve/Injured code (RES or RSR)
        const rosterUrl = NflRosterEligibilityService.rosterUrl(teamCode);
        const rosterPage = await this.fetchNflPage(rosterUrl).catch(e => { throw fail(e.code, e.message, { injuryReport: { observed: injuryObserved } }); });
        sources.push(rosterUrl);
        let roster;
        try {
            roster = parseTeamRoster(rosterPage.body, { teamCode, season });
        } catch (e) {
            throw fail(e.code || 'NFL_UNAVAILABLE', e.message, { injuryReport: { observed: injuryObserved } });
        }
        const rosterRows = roster.players.filter(p => normalizeName(p.name) === wanted);
        const observedSoFar = (rosterNote) => `injury report: ${injuryObserved}; ${TEAM_FULL_NAMES[teamCode]} roster: ${rosterNote}`;
        if (rosterRows.length > 1) {
            throw fail('NFL_UNAVAILABLE', `Validation failed: fresh NFL.com data unavailable (${TEAM_FULL_NAMES[teamCode]} roster lists ${rosterRows.length} players named ${playerName}; ambiguous)`);
        }
        if (rosterRows.length === 0) {
            const observedStatus = observedSoFar('not on roster');
            throw fail('NFL_INELIGIBLE', `IR move not allowed: NFL.com does not list ${label} as Out or on Reserve/Injured (observed ${observedStatus})`, { observedStatus });
        }
        const rosterRow = rosterRows[0];
        const rosterStatus = String(rosterRow.status || '').trim();
        const statusClass = classifyRosterStatus(rosterStatus);
        const statusNote = `Status "${rosterStatus || 'blank'}"${statusClass.code ? ` (${statusClass.meaning})` : ''}`;
        if (statusClass.kind === 'unknown') {
            // A code this module cannot read is neither "injured" nor "not
            // injured" - refuse as unavailable so it is reviewed, not ruled on.
            const observedStatus = observedSoFar(`${statusNote}: ${statusClass.meaning}`);
            throw fail('NFL_UNAVAILABLE', `Validation failed: fresh NFL.com data unavailable (${TEAM_FULL_NAMES[teamCode]} roster shows ${label} with ${statusClass.code ? 'unrecognised' : 'a blank'} Status "${rosterStatus}"; cannot tell whether it is Reserve/Injured)`, { observedStatus, roster: { status: rosterStatus, slug: rosterRow.slug, position: rosterRow.position } });
        }
        if (statusClass.kind !== 'reserve_injured') {
            const observedStatus = observedSoFar(`${statusNote}, not Reserve/Injured`);
            throw fail('NFL_INELIGIBLE', `IR move not allowed: NFL.com does not list ${label} as Out or on Reserve/Injured (observed ${observedStatus})`, { observedStatus, roster: { status: rosterStatus, slug: rosterRow.slug, position: rosterRow.position } });
        }
        const reserveNote = observedSoFar(statusNote);
        const rosterEvidence = { status: rosterStatus, meaning: statusClass.meaning, slug: rosterRow.slug, position: rosterRow.position };

        // ---- 3. Corroborate RES/RSR with an official Reserve/Injured transaction
        const teamSlug = TEAM_SLUGS[teamCode];
        const searched = [];
        for (const { year, month } of this.monthsToSearch(season)) {
            let url = NflRosterEligibilityService.reserveListUrl(year, month);
            const seenSignatures = new Set();
            for (let page = 1; ; page++) {
                if (page > this.maxTransactionPages) {
                    throw fail('NFL_UNAVAILABLE', `Validation failed: fresh NFL.com data unavailable (reserve-list ${year}/${month} exceeded ${this.maxTransactionPages} pages)`, { observedStatus: reserveNote, roster: rosterEvidence });
                }
                const pageResult = await this.fetchNflPage(url).catch(e => { throw fail(e.code, e.message, { observedStatus: reserveNote, roster: rosterEvidence }); });
                sources.push(url);
                let parsed;
                try {
                    parsed = parseReserveTransactions(pageResult.body, { year });
                } catch (e) {
                    throw fail(e.code || 'NFL_UNAVAILABLE', e.message, { observedStatus: reserveNote, roster: rosterEvidence });
                }

                // Fail closed when a 200 response cannot be the page we asked
                // for. NFL.com's CDN keys these pages on the path alone, so a
                // cached copy of a different page of the same month comes back
                // with HTTP 200 and parses cleanly; accepting it would skip
                // transactions and wrongly deny an eligible player. A page
                // whose own "Next Page" link is the cursor just requested, or
                // that repeats a page already seen in this walk, is such a
                // copy.
                const requestedCursor = cursorOf(url);
                const signature = pageSignature(parsed);
                const selfReferential = requestedCursor !== null && cursorOf(parsed.nextPath) === requestedCursor;
                if (selfReferential || seenSignatures.has(signature)) {
                    throw fail('NFL_UNAVAILABLE',
                        `Validation failed: fresh NFL.com data unavailable (reserve-list ${year}/${String(month).padStart(2, '0')} page ${page} came back as a copy of another page; cursor "${requestedCursor}" was not honoured)`,
                        { observedStatus: reserveNote, roster: rosterEvidence });
                }
                seenSignatures.add(signature);
                const byName = parsed.rows.filter(r =>
                    normalizeName(r.name) === wanted &&
                    (r.toSlug === teamSlug || r.fromSlug === teamSlug) &&
                    /^reserve\s*\/\s*injured\b/i.test(r.transaction));
                const candidates = rosterRow.slug
                    ? byName.filter(r => !r.playerSlug || r.playerSlug === rosterRow.slug)
                    : byName;
                if (byName.length && !candidates.length) {
                    throw fail('NFL_UNAVAILABLE', `Validation failed: fresh NFL.com data unavailable (Reserve/Injured transaction for a different ${playerName} on ${teamCode}; ambiguous)`, { observedStatus: reserveNote, roster: rosterEvidence });
                }
                if (candidates.length) {
                    const tx = candidates[0];
                    const observedStatus = `roster ${statusNote}; Reserve/Injured transaction ${tx.date}/${year}`;
                    const injuryReport = { observed: injuryObserved };
                    if (injuryObserved === 'not listed') {
                        injuryReport.note = 'players on Reserve/Injured are not carried on the weekly injury report';
                    }
                    return {
                        eligible: true,
                        code: 'RESERVE_INJURED',
                        reason: `NFL.com lists ${label} as ${statusClass.code} (${statusClass.meaning}) on the ${TEAM_FULL_NAMES[teamCode]} roster with a Reserve/Injured transaction dated ${tx.date}/${year}`,
                        observedStatus,
                        injuryReport,
                        roster: rosterEvidence,
                        transaction: { date: `${tx.date}/${year}`, transaction: tx.transaction, team: tx.toSlug || tx.fromSlug, page: url },
                        ...base
                    };
                }
                if (!parsed.nextPath) break;
                url = `${NFL_ORIGIN}${parsed.nextPath}`;
            }
            searched.push(`${year}-${String(month).padStart(2, '0')}`);
        }

        const observedStatus = observedSoFar(`${statusNote} but no Reserve/Injured transaction found (${searched.join(', ')})`);
        throw fail('NFL_INELIGIBLE', `IR move not allowed: NFL.com does not list ${label} as Out or on Reserve/Injured (observed ${observedStatus})`, { observedStatus, roster: rosterEvidence });
    }
}

module.exports = NflRosterEligibilityService;
module.exports.NflRosterEligibilityService = NflRosterEligibilityService;
module.exports.NflEligibilityError = NflEligibilityError;
module.exports.parseInjuryReport = parseInjuryReport;
module.exports.parseTeamRoster = parseTeamRoster;
module.exports.parseReserveTransactions = parseReserveTransactions;
module.exports.normalizeName = normalizeName;
module.exports.classifyRosterStatus = classifyRosterStatus;
module.exports.ROSTER_STATUS = ROSTER_STATUS;
module.exports.decodeEntities = decodeEntities;
module.exports.TEAM_SLUGS = TEAM_SLUGS;
module.exports.SLUG_TO_CODE = SLUG_TO_CODE;
module.exports.TEAM_FULL_NAMES = TEAM_FULL_NAMES;
module.exports.defaultFetchPage = defaultFetchPage;
module.exports.cacheKeyHeaders = cacheKeyHeaders;
module.exports.cursorOf = cursorOf;
module.exports.pageSignature = pageSignature;
