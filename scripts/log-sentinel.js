#!/usr/bin/env node

/**
 * Log sentinel (pm2 cron: statfink2-log-sentinel, every 10 minutes).
 *
 * Reads the CURRENT pm2 log files (~/.pm2/logs/statfink2*-{out,error}*.log,
 * never the rotated __date files) from saved byte cursors, groups every
 * error/warn entry by a normalised fingerprint and answers one question for
 * /admin/status: did an error shape nobody has seen before appear, or is a
 * known one suddenly flooding? Everything else is counted and listed, never
 * coloured. Known noise: server/config/knownLogNoise.json (shipped, regex)
 * and logs/log-sentinel/known.json (acknowledged from the page by id).
 *
 * Writes (all under logs/log-sentinel/ unless --out):
 *   state.json   { cursors: { [file]: {offset, inode} }, history: { [fpId]: {...} }, observedSince }
 *   latest.json  { ts, scanned, fingerprints (new -> spiking -> known), summary, firstRun }
 * and logs/status/log-sentinel.json via scripts/lib/jobStatus.js.
 *
 * First run ever: every existing fingerprint is baseline (firstSeen seeded
 * 25 h back) so old noise never pages. Never throws out of main.
 *
 * Usage: node scripts/log-sentinel.js [--once] [--dir <pm2 logs dir>] [--dry-run] [--out <dir>]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const ls = require('./lib/logSentinel');
const { writeJsonAtomic, readJson } = require('./lib/watchdogLog');
const { writeJobStatus } = require('./lib/jobStatus');

const JOB = 'log-sentinel';
const REPO = path.join(__dirname, '..');
const DEFAULT_OUT = path.join(REPO, 'logs/log-sentinel');
const DEFAULT_LOG_DIR = path.join(os.homedir(), '.pm2/logs');
const KNOWN_NOISE_FILE = path.join(REPO, 'server/config/knownLogNoise.json');
const MAX_FINGERPRINTS = 200;
const HOUR_MS = 3600 * 1000;

function parseArgs(argv) {
    const opts = { once: false, dryRun: false, quiet: false, dir: DEFAULT_LOG_DIR, out: DEFAULT_OUT };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--once') opts.once = true;
        else if (a === '--dry-run') opts.dryRun = true;
        else if (a === '--quiet') opts.quiet = true; // in-process runs (the Clear-all-warnings button): never narrate into the host's log
        else if (a === '--dir') opts.dir = path.resolve(argv[++i] || '');
        else if (a === '--out') opts.out = path.resolve(argv[++i] || '');
        else if (a === '--help' || a === '-h') opts.help = true;
        else throw new Error(`unknown argument ${a}`);
    }
    return opts;
}

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

/** Shipped regex entries + page-acked ids -> the `known` shape classify() expects. */
function loadKnown({ noiseFile = KNOWN_NOISE_FILE, ackFile }) {
    const shipped = readJson(noiseFile, null);
    const acked = readJson(ackFile, null);
    return {
        shipped: shipped && Array.isArray(shipped.entries) ? shipped.entries : [],
        acked: acked && typeof acked === 'object' && !Array.isArray(acked) ? acked : {}
    };
}

/**
 * One pass. Pure over its inputs apart from reading the log files; returns
 * { state, latest, status } and leaves writing to main().
 */
function scan({ dir, state, known, now = Date.now() }) {
    const firstRun = !state.observedSince;
    const observedSince = state.observedSince || new Date(now).toISOString();
    const cursors = state.cursors && typeof state.cursors === 'object' ? state.cursors : {};
    const history = state.history && typeof state.history === 'object' ? state.history : {};
    const meta = state.meta && typeof state.meta === 'object' ? state.meta : {};
    const scanned = [];
    const touched = new Set();
    let entriesSeen = 0;

    for (const f of ls.listLogFiles(dir)) {
        const before = cursors[f.name] || null;
        const res = ls.readNewText(f.file, before);
        cursors[f.name] = res.cursor;
        const bytes = res.text ? Buffer.byteLength(res.text, 'utf8') : 0;
        scanned.push({ file: f.name, job: f.job, stream: f.stream, bytes, rotated: Boolean(res.rotated), capped: Boolean(res.capped), ...(res.error ? { error: res.error } : {}) });
        if (!res.text) continue;
        const startedMidFile = Boolean(before && before.offset > 0 && !res.rotated);
        for (const entry of ls.splitEntries(res.text)) {
            if (startedMidFile && ls.isTail(entry)) continue;
            const level = ls.levelOf(entry, f.stream);
            if (level === 'info') continue;
            entriesSeen++;
            const fp = ls.fingerprint(entry);
            const ts = entry.ts ? Date.parse(entry.ts) : now;
            const at = Number.isNaN(ts) ? now : ts;
            const isNewToHistory = !history[fp.id];
            ls.updateHistory(history, fp.id, at, { now });
            if (firstRun && isNewToHistory) {
                // Baseline: nothing that already exists on disk is "new"
                const seeded = new Date(Math.min(at, now - 25 * HOUR_MS)).toISOString();
                if (history[fp.id].firstSeen > seeded) history[fp.id].firstSeen = seeded;
            }
            meta[fp.id] = { text: fp.text, job: f.job, level, sample: entry.text.slice(0, ls.SAMPLE_MAX) };
            touched.add(fp.id);
        }
    }

    ls.pruneHistory(history, now);
    for (const id of Object.keys(meta)) if (!history[id]) delete meta[id];

    const fingerprints = Object.entries(history).map(([id, h]) => {
        const m = meta[id] || {};
        const fp = { id, text: m.text || '' };
        const c = ls.classify({ fp, history: h, known, now, observedSince });
        return {
            id, job: m.job || null, level: m.level || 'error', fingerprint: fp.text,
            count10m: c.count10m, count1h: c.count1h, count24h: c.count24h, count7d: c.count7d,
            firstSeen: h.firstSeen, lastSeen: h.lastSeen, sample: m.sample || '',
            // A warn-level line is something the code chose not to treat as an error; it is counted, listed and
            // spike-checked but never colours the page as "new" - only a never-seen ERROR shape is a call to action.
            known: c.known, knownVia: c.knownVia, new: c.new && (m.level || 'error') !== 'warn', spiking: c.spiking, spikeThreshold: c.spikeThreshold, hourlyAvg: c.hourlyAvg
        };
    });
    const sorted = ls.sortFingerprints(fingerprints).slice(0, MAX_FINGERPRINTS);
    const summary = ls.summarize(fingerprints, { firstRun });

    const latest = { ts: new Date(now).toISOString(), firstRun, observedSince, scanned, entriesSeen, fingerprints: sorted, summary };
    const nextState = { observedSince, updatedAt: latest.ts, cursors, history, meta };
    return { state: nextState, latest, summary };
}

async function main(argv = process.argv) {
    const started = Date.now();
    let opts;
    try {
        opts = parseArgs(argv);
    } catch (error) {
        console.error(error.message);
        return 2;
    }
    if (opts.help) {
        console.log('usage: node scripts/log-sentinel.js [--once] [--dir <pm2 logs dir>] [--dry-run] [--quiet] [--out <dir>]');
        return 0;
    }
    const stateFile = path.join(opts.out, 'state.json');
    const latestFile = path.join(opts.out, 'latest.json');
    const ackFile = path.join(opts.out, 'known.json');

    const state = readJson(stateFile, null) || {};
    const known = loadKnown({ ackFile });
    const { state: nextState, latest, summary } = scan({ dir: opts.dir, state, known, now: Date.now() });

    const withBytes = latest.scanned.filter(s => s.bytes > 0);
    if (!opts.quiet) {
        log(`${latest.scanned.length} file(s), ${withBytes.length} with new bytes, ${latest.entriesSeen} error/warn entries; ${summary.summary}`);
        for (const f of latest.fingerprints.filter(x => x.new || x.spiking)) {
            log(`  ${f.new ? 'NEW' : 'SPIKING'} [${f.job}/${f.level}] ${f.fingerprint} (10m ${f.count10m}, 24h ${f.count24h})`);
        }
    }

    if (opts.dryRun) {
        if (!opts.quiet) log('dry run: nothing written');
        return 0;
    }
    writeJsonAtomic(stateFile, nextState);
    writeJsonAtomic(latestFile, latest);
    writeJobStatus(JOB, {
        status: summary.status, summary: summary.summary, durationMs: Date.now() - started, link: '/admin/status#log-errors',
        details: {
            newCount: summary.newCount, spikingCount: summary.spikingCount, knownSuppressed: summary.knownSuppressed,
            knownEntries24h: summary.knownEntries24h, fingerprints: latest.fingerprints.length, filesScanned: latest.scanned.length,
            bytesRead: latest.scanned.reduce((n, s) => n + s.bytes, 0), firstRun: latest.firstRun, dir: opts.dir
        }
    });
    return 0;
}

if (require.main === module) {
    main().then(code => { process.exitCode = code; }).catch(error => {
        const msg = `log sentinel crashed: ${error && error.message ? error.message : error}`;
        console.error(`[${new Date().toISOString()}] ${msg}`);
        writeJobStatus(JOB, { status: 'warning', summary: msg, link: '/admin/status#log-errors' });
        process.exitCode = 1;
    });
}

module.exports = { main, scan, loadKnown, parseArgs, JOB, DEFAULT_LOG_DIR, DEFAULT_OUT, KNOWN_NOISE_FILE, MAX_FINGERPRINTS };
