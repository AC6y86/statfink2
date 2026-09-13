/**
 * Shared helpers for the live-scoring watchdog log.
 *
 * The watchdog (scripts/live-watchdog.js) appends one JSON line per check to
 * logs/watchdog/live-YYYY-MM-DD.jsonl and mirrors the last line to
 * logs/watchdog/live-latest.json. The notifier (scripts/watchdog-notifier.js)
 * reads those files from a saved byte cursor. Anything else (the admin
 * dashboard, a jq one-liner, a Claude Code loop) can read the same files.
 *
 * Every line carries top-level `ts`, `status`, `severity` and `summary`; a
 * reader can act on those alone. See docs/CRON.md "Live Scoring Watchdog".
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '../..');
const WATCHDOG_DIR = path.join(REPO, 'logs/watchdog');
const LATEST_FILE = path.join(WATCHDOG_DIR, 'live-latest.json');
const NOTIFIER_STATE_FILE = path.join(WATCHDOG_DIR, 'notifier-state.json');
const MAINTENANCE_LOCK = path.join(REPO, 'logs/maintenance.lock');
const LOG_FILE_RE = /^live-(\d{4}-\d{2}-\d{2})\.jsonl$/;

function dayFileName(date = new Date()) {
    return `live-${date.toISOString().slice(0, 10)}.jsonl`;
}

function ensureDir(dir = WATCHDOG_DIR) {
    fs.mkdirSync(dir, { recursive: true });
}

/** Write JSON to `file` via a temp file + rename so readers never see a torn write. */
function writeJsonAtomic(file, obj) {
    ensureDir(path.dirname(file));
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
}

function readJson(file, fallback = null) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
        return fallback;
    }
}

/** Append one check entry to today's file and refresh live-latest.json. */
function appendEntry(entry, { dir = WATCHDOG_DIR, now = new Date() } = {}) {
    ensureDir(dir);
    const file = path.join(dir, dayFileName(now));
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    writeJsonAtomic(path.join(dir, 'live-latest.json'), entry);
    return file;
}

function readLatest(dir = WATCHDOG_DIR) {
    return readJson(path.join(dir, 'live-latest.json'), null);
}

/** Daily log files in chronological order (names only). */
function listLogFiles(dir = WATCHDOG_DIR) {
    let names;
    try {
        names = fs.readdirSync(dir);
    } catch (_) {
        return [];
    }
    return names.filter(n => LOG_FILE_RE.test(n)).sort();
}

/**
 * Read complete JSON lines written since `cursor` ({file, offset}) across
 * all daily files. A trailing partial line (no newline yet) is left for the
 * next read. Returns { lines, cursor }. With no cursor, starts at the
 * beginning of the newest file.
 */
function readLinesSince(cursor, dir = WATCHDOG_DIR) {
    const files = listLogFiles(dir);
    if (files.length === 0) {
        return { lines: [], cursor: cursor || null };
    }

    let startIdx;
    let offset;
    if (cursor && cursor.file && files.includes(cursor.file)) {
        startIdx = files.indexOf(cursor.file);
        offset = cursor.offset || 0;
    } else if (cursor && cursor.file) {
        // The cursor's file was pruned or never existed: resume with the
        // first file after it, or the newest if none is newer.
        startIdx = files.findIndex(f => f > cursor.file);
        if (startIdx < 0) startIdx = files.length - 1;
        offset = 0;
    } else {
        startIdx = files.length - 1;
        offset = 0;
    }

    const lines = [];
    let newCursor = { file: files[startIdx], offset };
    for (let i = startIdx; i < files.length; i++) {
        const file = files[i];
        const from = i === startIdx ? offset : 0;
        const full = path.join(dir, file);
        let buf;
        try {
            buf = fs.readFileSync(full);
        } catch (_) {
            continue;
        }
        if (from > buf.length) {
            // File was truncated/rewritten: start over on it
            newCursor = { file, offset: 0 };
            continue;
        }
        let consumed = from;
        let text = buf.slice(from).toString('utf8');
        const lastNl = text.lastIndexOf('\n');
        if (lastNl < 0) {
            newCursor = { file, offset: consumed };
            continue;
        }
        text = text.slice(0, lastNl + 1);
        consumed += Buffer.byteLength(text, 'utf8');
        for (const raw of text.split('\n')) {
            if (!raw.trim()) continue;
            try {
                lines.push(JSON.parse(raw));
            } catch (_) {
                // Malformed line (interrupted write): skip it
            }
        }
        newCursor = { file, offset: consumed };
    }
    return { lines, cursor: newCursor };
}

/** Delete daily files older than `days`. */
function pruneOldLogs(days = 30, dir = WATCHDOG_DIR, now = new Date()) {
    const cutoff = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
    const removed = [];
    for (const name of listLogFiles(dir)) {
        const day = name.match(LOG_FILE_RE)[1];
        if (day < cutoff) {
            try {
                fs.unlinkSync(path.join(dir, name));
                removed.push(name);
            } catch (_) { /* best effort */ }
        }
    }
    return removed;
}

/** Age of logs/maintenance.lock in seconds, or null when absent. */
function maintenanceLockAgeSec(lockFile = MAINTENANCE_LOCK, now = Date.now()) {
    try {
        const stat = fs.statSync(lockFile);
        return Math.max(0, Math.floor((now - stat.mtimeMs) / 1000));
    } catch (_) {
        return null;
    }
}

function writeMaintenanceLock(reason, lockFile = MAINTENANCE_LOCK) {
    ensureDir(path.dirname(lockFile));
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, reason, startedAt: new Date().toISOString() }));
}

function removeMaintenanceLock(lockFile = MAINTENANCE_LOCK) {
    try {
        fs.unlinkSync(lockFile);
    } catch (_) { /* already gone */ }
}

module.exports = {
    REPO,
    WATCHDOG_DIR,
    LATEST_FILE,
    NOTIFIER_STATE_FILE,
    MAINTENANCE_LOCK,
    dayFileName,
    ensureDir,
    writeJsonAtomic,
    readJson,
    appendEntry,
    readLatest,
    listLogFiles,
    readLinesSince,
    pruneOldLogs,
    maintenanceLockAgeSec,
    writeMaintenanceLock,
    removeMaintenanceLock
};
