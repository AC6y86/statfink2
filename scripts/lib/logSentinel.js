'use strict';

/**
 * Log sentinel helpers (pure, testable). scripts/log-sentinel.js is the
 * pm2 cron wrapper; this module knows nothing about where state lives.
 *
 * Two log formats exist under ~/.pm2/logs (docs/CRON.md "Log sentinel"):
 *   main app (statfink2, no pm2 time prefix):  [ISO] LEVEL: message {obj}
 *   every cron app (`time: true`):             YYYY-MM-DDTHH:mm:ss: [ISO] message
 * pm2 prefixes EVERY line of a cron app, so a pretty-printed object arrives
 * as seven prefixed lines; the main app's objects arrive as bare lines.
 *
 * Pipeline per file: readNewText (byte cursor, whole lines only) ->
 * splitEntries (multi-line entries) -> levelOf -> fingerprint (stable id
 * across ids, paths and timestamps) -> updateHistory (hourly buckets, 7 d)
 * -> classify (new / known / spiking) -> summarize (status colour).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HISTORY_DAYS = 7;
const MINUTE_KEEP_MS = 70 * 60 * 1000; // minute buckets: enough for a sliding hour + the 10 min pass
const MAX_BYTES_PER_PASS = 5 * 1024 * 1024;
const FP_TEXT_MAX = 140;
const SAMPLE_MAX = 500;
/** Hours of sentinel observation before a spike can be judged (no past = no spike). */
const MIN_HOURS_FOR_SPIKE = 6;
const NEW_WINDOW_MS = DAY_MS;

/** statfink2-live-continuous-out-1.log -> { job: 'live-continuous', stream: 'out', pmId: 1 }; statfink2-error-0.log -> server/error. */
const FILE_RE = /^statfink2(?:-([a-z0-9-]+?))?-(out|error)(?:-(\d+))?\.log$/;
const ISO_START_RE = /^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]\s?/;
const PM2_PREFIX_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}): /;
const CONTINUATION_RE = /^(\s|[}\])]|at\s)/;

// ---------- files ----------

function parseLogName(name) {
    if (name.includes('__') || name.endsWith('.gz')) return null;
    const m = FILE_RE.exec(name);
    if (!m) return null;
    const job = m[1] || 'server';
    // Never read our own output: the sentinel prints the shapes it found, and
    // scanning that would re-report every one of them as a brand-new error.
    if (job === 'log-sentinel') return null;
    return { name, job, stream: m[2], pmId: m[3] != null ? Number(m[3]) : null };
}

/** Current (unrotated) statfink2 log files in `dir`, sorted by name. */
function listLogFiles(dir) {
    let names;
    try {
        names = fs.readdirSync(dir);
    } catch (_) {
        return [];
    }
    return names.map(parseLogName).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name))
        .map(f => ({ ...f, file: path.join(dir, f.name) }));
}

// ---------- cursor reads ----------

/**
 * Bytes appended to `file` since `cursor` ({offset, inode}), whole lines only:
 * a trailing partial line stays unread until its newline lands. A file shorter
 * than the offset (pm2-logrotate truncated it) or with a new inode restarts at
 * 0. At most `maxBytes` per call; the cursor advances past what was returned
 * (`capped` says there is more). Never throws: an unreadable file yields no text.
 */
function readNewText(file, cursor = null, { maxBytes = MAX_BYTES_PER_PASS } = {}) {
    let st;
    try {
        st = fs.statSync(file);
    } catch (_) {
        return { text: '', cursor: cursor || { offset: 0, inode: null }, rotated: false, capped: false, error: 'unreadable' };
    }
    let offset = cursor && Number.isFinite(cursor.offset) && cursor.offset >= 0 ? cursor.offset : 0;
    let rotated = false;
    if (offset > st.size || (cursor && cursor.inode != null && st.ino && cursor.inode !== st.ino)) {
        offset = 0;
        rotated = true;
    }
    const avail = st.size - offset;
    if (avail <= 0) return { text: '', cursor: { offset, inode: st.ino || null }, rotated, capped: false };

    const len = Math.min(avail, maxBytes);
    const buf = Buffer.alloc(len);
    let n = 0;
    let fd = null;
    try {
        fd = fs.openSync(file, 'r');
        n = fs.readSync(fd, buf, 0, len, offset);
    } catch (_) {
        return { text: '', cursor: { offset, inode: st.ino || null }, rotated, capped: false, error: 'unreadable' };
    } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
    }
    const capped = avail > len;
    let chunk = buf.subarray(0, n);
    const lastNl = chunk.lastIndexOf(0x0a);
    if (lastNl < 0) {
        // No complete line yet. A capped read with no newline is one pathological line: skip it rather than stall.
        if (!capped) return { text: '', cursor: { offset, inode: st.ino || null }, rotated, capped };
        return { text: '', cursor: { offset: offset + n, inode: st.ino || null }, rotated, capped };
    }
    chunk = chunk.subarray(0, lastNl + 1);
    return { text: chunk.toString('utf8'), cursor: { offset: offset + chunk.length, inode: st.ino || null }, rotated, capped };
}

// ---------- entries ----------

/** ISO without a zone (pm2's prefix) is the server's local clock, which is UTC on this box. */
function normalizeTs(ts) {
    if (!ts) return null;
    const s = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(ts) ? ts : `${ts}Z`;
    return Number.isNaN(Date.parse(s)) ? null : s;
}

/**
 * Split raw log text into entries { ts, lines, text, lead }.
 * Main app: an entry starts at a `[ISO]` line; bare lines attach to it.
 * Cron apps: every line carries `TS: `; the entry starts where the remainder
 * begins with `[ISO]`, or where a non-continuation line falls in a different
 * pm2 second from the previous entry (so "Response data: {" and its object
 * stay with the "Live update failed" line that produced them).
 * A leading chunk with no start line (the tail of an entry cut by the cursor,
 * or plain output) is an entry with ts null (pm2 ts when present) and lead=true.
 */
function splitEntries(text) {
    const entries = [];
    let current = null;
    const push = (line, ts, pm2Ts, lead) => {
        current = { ts, pm2Ts, lines: [line], lead };
        entries.push(current);
    };
    const lines = String(text || '').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) {
        const pm2 = PM2_PREFIX_RE.exec(line);
        const rest = pm2 ? line.slice(pm2[0].length) : line;
        const iso = ISO_START_RE.exec(rest);
        if (iso) {
            push(line, normalizeTs(iso[1]), pm2 ? normalizeTs(pm2[1]) : null, false);
            continue;
        }
        if (pm2) {
            const pm2Ts = normalizeTs(pm2[1]);
            const continuation = CONTINUATION_RE.test(rest) || (current && current.pm2Ts && current.pm2Ts === pm2Ts);
            if (current && continuation) current.lines.push(line);
            else push(line, pm2Ts, pm2Ts, !current);
            continue;
        }
        if (current) current.lines.push(line);
        else push(line, null, null, true);
    }
    return entries.map(e => ({ ts: e.ts, lines: e.lines, text: e.lines.join('\n'), lead: Boolean(e.lead) }));
}

/**
 * A leading entry whose first line looks like the middle of an object or a
 * stack ("  error: ...", "}", "at ...") is the tail of an entry the previous
 * pass already counted. A bare crash dump ("/path/file.js:12", "Error: x")
 * is not a tail and must be kept.
 */
function isTail(entry) {
    if (!entry || !entry.lead) return false;
    return CONTINUATION_RE.test(stripPrefixes(entry.lines ? entry.lines[0] : entry.text));
}

function stripPrefixes(line) {
    let s = String(line || '');
    const pm2 = PM2_PREFIX_RE.exec(s);
    if (pm2) s = s.slice(pm2[0].length);
    const iso = ISO_START_RE.exec(s);
    if (iso) s = s.slice(iso[0].length);
    return s;
}

/**
 * 'error' | 'warn' | 'info'. An explicit level on the first line wins
 * (INFO:/WARN:/ERROR:), then error markers anywhere in the entry (error,
 * failed, failure), then the stream (stderr of a cron app is an error), else info.
 */
function levelOf(entry, stream = 'out') {
    const first = stripPrefixes(entry.lines ? entry.lines[0] : entry.text);
    if (/^\s*(WARN|WARNING):/i.test(first)) return 'warn';
    if (/^\s*ERROR:/i.test(first)) return 'error';
    if (/^\s*(INFO|DEBUG):/i.test(first)) return 'info';
    const text = entry.text || '';
    if (/\bERROR:|\bError:|\berror\b|\bfail(?:ed|ure)\b/i.test(text)) return 'error';
    if (/\bWARN:|\bWARNING\b/i.test(text)) return 'warn';
    return stream === 'error' ? 'error' : 'info';
}

/**
 * Stable shape of an entry from its first line: prefixes stripped, lowercase,
 * absolute paths -> /…, hex/uuid (>= 8, at least one letter) -> H, integers -> N,
 * quoted strings -> "…", whitespace collapsed, 140 chars. id = sha1 first 10.
 */
function fingerprint(entry) {
    let s = stripPrefixes(entry.lines ? entry.lines[0] : String(entry.text || '').split('\n')[0]).toLowerCase();
    s = s.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '"…"');
    s = s.replace(/(?:\/[\w.@~-]+){2,}\/?/g, '/…');
    s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, 'H');
    s = s.replace(/(?<![a-z0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{8,}(?![a-z0-9])/g, 'H');
    s = s.replace(/(?<![a-z0-9])\d+(?:\.\d+)?(?![a-z0-9])/g, 'N');
    s = s.replace(/\s+/g, ' ').trim();
    if (s.length > FP_TEXT_MAX) s = s.slice(0, FP_TEXT_MAX);
    const id = crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
    return { id, text: s };
}

// ---------- history (hourly buckets, 7 days) ----------

const hourKey = ms => new Date(ms).toISOString().slice(0, 13);   // YYYY-MM-DDTHH
const minuteKey = ms => new Date(ms).toISOString().slice(0, 16); // YYYY-MM-DDTHH:mm

/**
 * Record one occurrence of `fpId` at `ts` (ms or ISO). history[fpId] =
 * { firstSeen, lastSeen, buckets: {hour: n}, minutes: {minute: n} }; buckets
 * older than 7 days and minutes older than 70 min are pruned relative to `now`.
 */
function updateHistory(history, fpId, ts, { now = Date.now(), count = 1 } = {}) {
    const ms = typeof ts === 'number' ? ts : Date.parse(ts);
    const at = Number.isNaN(ms) || ms == null ? now : ms;
    const h = history[fpId] || (history[fpId] = { firstSeen: null, lastSeen: null, buckets: {}, minutes: {} });
    if (!h.buckets) h.buckets = {};
    if (!h.minutes) h.minutes = {};
    const iso = new Date(at).toISOString();
    if (!h.firstSeen || iso < h.firstSeen) h.firstSeen = iso;
    if (!h.lastSeen || iso > h.lastSeen) h.lastSeen = iso;
    if (now - at < HISTORY_DAYS * DAY_MS) {
        const hk = hourKey(at);
        h.buckets[hk] = (h.buckets[hk] || 0) + count;
    }
    if (now - at < MINUTE_KEEP_MS) {
        const mk = minuteKey(at);
        h.minutes[mk] = (h.minutes[mk] || 0) + count;
    }
    pruneHistoryEntry(h, now);
    return h;
}

function pruneHistoryEntry(h, now = Date.now()) {
    const hourCut = hourKey(now - HISTORY_DAYS * DAY_MS);
    for (const k of Object.keys(h.buckets || {})) if (k < hourCut) delete h.buckets[k];
    const minCut = minuteKey(now - MINUTE_KEEP_MS);
    for (const k of Object.keys(h.minutes || {})) if (k < minCut) delete h.minutes[k];
    return h;
}

/** Drop fingerprints not seen for 7 days (their buckets are empty anyway). */
function pruneHistory(history, now = Date.now()) {
    for (const [id, h] of Object.entries(history)) {
        pruneHistoryEntry(h, now);
        const last = h.lastSeen ? Date.parse(h.lastSeen) : NaN;
        if (Number.isNaN(last) || now - last > HISTORY_DAYS * DAY_MS) delete history[id];
    }
    return history;
}

const sumSince = (map, cut) => Object.entries(map || {}).reduce((n, [k, v]) => (k >= cut ? n + v : n), 0);

/** { count10m, count1h, count24h, count7d } from a history entry. */
function countsOf(h, now = Date.now()) {
    if (!h) return { count10m: 0, count1h: 0, count24h: 0, count7d: 0 };
    return {
        count10m: sumSince(h.minutes, minuteKey(now - 10 * 60 * 1000)),
        count1h: sumSince(h.minutes, minuteKey(now - HOUR_MS)),
        count24h: sumSince(h.buckets, hourKey(now - DAY_MS)),
        count7d: sumSince(h.buckets, hourKey(now - HISTORY_DAYS * DAY_MS))
    };
}

// ---------- known noise ----------

/**
 * known = { shipped: [{id, pattern, note}], acked: { [fpId]: {text, ackedAt, by} } }.
 * Shipped entries match by regex over the fingerprint text (ids survive small
 * edits); acked entries match by id. Returns { known, via } where via is
 * 'shipped:<id>' | 'acked' | null.
 */
function matchKnown(fp, known = {}) {
    const acked = known.acked && typeof known.acked === 'object' ? known.acked : {};
    if (acked[fp.id]) return { known: true, via: 'acked' };
    for (const e of Array.isArray(known.shipped) ? known.shipped : []) {
        if (!e || !e.pattern) continue;
        let re;
        try { re = e.pattern instanceof RegExp ? e.pattern : new RegExp(e.pattern, 'i'); } catch (_) { continue; }
        if (re.test(fp.text)) return { known: true, via: `shipped:${e.id || e.pattern}` };
    }
    return { known: false, via: null };
}

/**
 * Flags for one fingerprint. new = first seen < 24 h ago and not known.
 * spiking = count in the last hour > max(50, 10 x its 7-day hourly average),
 * judged only once the sentinel has watched it for MIN_HOURS_FOR_SPIKE
 * completed hours (observedSince = the sentinel's first run), never for a
 * new fingerprint (new already colours the page).
 */
function classify({ fp, history, known, now = Date.now(), observedSince = null }) {
    const h = history || null;
    const k = matchKnown(fp, known || {});
    const first = h && h.firstSeen ? Date.parse(h.firstSeen) : now;
    const isNew = !k.known && now - first < NEW_WINDOW_MS;
    const counts = countsOf(h, now);
    const since = Math.max(first, observedSince != null ? (typeof observedSince === 'number' ? observedSince : Date.parse(observedSince)) || 0 : 0);
    const hoursObserved = Math.min(HISTORY_DAYS * 24, Math.floor((now - since) / HOUR_MS));
    const completed = h ? sumSince(h.buckets, hourKey(now - HISTORY_DAYS * DAY_MS)) - (h.buckets[hourKey(now)] || 0) : 0;
    const avg = hoursObserved > 0 ? completed / hoursObserved : 0;
    const threshold = Math.max(50, 10 * avg);
    const spiking = !isNew && hoursObserved >= MIN_HOURS_FOR_SPIKE && counts.count1h > threshold;
    return { new: isNew, known: k.known, knownVia: k.via, spiking, spikeThreshold: Math.round(threshold), hourlyAvg: Math.round(avg * 10) / 10, ...counts };
}

/**
 * Status colour for the run. Warning ONLY for a new (unknown) shape or a
 * spiking one: a status colour is a call to action.
 */
function summarize(fps, { firstRun = false } = {}) {
    const list = Array.isArray(fps) ? fps : [];
    const newCount = list.filter(f => f.new).length;
    const spikingCount = list.filter(f => f.spiking).length;
    const knownList = list.filter(f => f.known);
    const knownSuppressed = knownList.length;
    const knownEntries24h = knownList.reduce((n, f) => n + (f.count24h || 0), 0);
    const otherCount = list.length - newCount - knownSuppressed;
    const status = newCount > 0 || spikingCount > 0 ? 'warning' : 'ok';
    const parts = [];
    if (firstRun) parts.push(`first run: ${list.length} existing shape(s) taken as baseline`);
    if (newCount) parts.push(`${newCount} new error shape(s) nobody has seen before`);
    if (spikingCount) parts.push(`${spikingCount} shape(s) spiking`);
    if (!newCount && !spikingCount && !firstRun) parts.push('no new errors');
    if (knownSuppressed) parts.push(`${knownSuppressed} known noise shape(s) suppressed (${knownEntries24h.toLocaleString('en-US')} entries in 24 h)`);
    if (otherCount && !firstRun) parts.push(`${otherCount} older unacknowledged shape(s)`);
    if (!list.length) parts.push('no errors in the pm2 logs');
    return { newCount, spikingCount, knownSuppressed, knownEntries24h, status, summary: parts.join('; ') };
}

/** new -> spiking -> known -> the rest; within a group most recent first. */
function sortFingerprints(list) {
    const rank = f => (f.new ? 0 : f.spiking ? 1 : f.known ? 3 : 2);
    return [...list].sort((a, b) => rank(a) - rank(b) || String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
}

module.exports = {
    FILE_RE, MAX_BYTES_PER_PASS, FP_TEXT_MAX, SAMPLE_MAX, HISTORY_DAYS, MIN_HOURS_FOR_SPIKE, NEW_WINDOW_MS,
    parseLogName, listLogFiles, readNewText, splitEntries, isTail, stripPrefixes, levelOf, fingerprint,
    updateHistory, pruneHistory, countsOf, hourKey, minuteKey, matchKnown, classify, summarize, sortFingerprints
};
