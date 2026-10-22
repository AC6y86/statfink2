'use strict';

/**
 * One status contract for every scheduled job (docs/CRON.md "Verification status").
 *
 *   writeJobStatus('doublecheck', { status: 'ok', summary: '...', season, week, details, durationMs, link })
 *     -> logs/status/doublecheck.json          (atomic; the page and the aggregator read this)
 *     -> logs/status/doublecheck.history.jsonl  (one compact line per run, last 200 kept)
 *   readJobStatus('doublecheck') -> object | null
 *   readAllJobStatus() -> { [job]: object }
 *
 * status: 'ok' | 'warning' | 'critical' | 'skipped' | 'running'
 * Never throws: a status write must not take a job down with it.
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '../..');
const STATUS_DIR = process.env.STATFINK_STATUS_DIR || path.join(REPO, 'logs/status');
const HISTORY_CAP = 200;
const STATUSES = ['ok', 'warning', 'critical', 'skipped', 'running'];

function statusFile(job) { return path.join(STATUS_DIR, `${job}.json`); }
function historyFile(job) { return path.join(STATUS_DIR, `${job}.history.jsonl`); }

function writeJobStatus(job, { status, summary = '', season = null, week = null, details = null, durationMs = null, link = null, ts = null } = {}) {
    try {
        if (!/^[a-z0-9-]+$/.test(String(job))) throw new Error(`bad job name ${job}`);
        const st = STATUSES.includes(status) ? status : 'warning';
        const record = {
            job, ts: ts || new Date().toISOString(), status: st, summary: String(summary || '').slice(0, 500),
            season, week, durationMs, link: link || `/admin/status#${job}`, details: details || {}
        };
        fs.mkdirSync(STATUS_DIR, { recursive: true });
        const tmp = `${statusFile(job)}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
        fs.renameSync(tmp, statusFile(job));
        if (st !== 'running') {
            const line = JSON.stringify({ ts: record.ts, status: st, summary: record.summary, season, week, durationMs });
            let lines = [];
            try { lines = fs.readFileSync(historyFile(job), 'utf8').split('\n').filter(Boolean); } catch (_) { /* first run */ }
            lines.push(line);
            fs.writeFileSync(historyFile(job), lines.slice(-HISTORY_CAP).join('\n') + '\n');
        }
        return record;
    } catch (error) {
        console.error(`[jobStatus] could not write status for ${job}: ${error.message}`);
        return null;
    }
}

function readJobStatus(job) {
    try { return JSON.parse(fs.readFileSync(statusFile(job), 'utf8')); } catch (_) { return null; }
}

function readJobHistory(job, limit = 30) {
    try {
        return fs.readFileSync(historyFile(job), 'utf8').split('\n').filter(Boolean).slice(-limit).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    } catch (_) { return []; }
}

function readAllJobStatus() {
    const out = {};
    let files = [];
    try { files = fs.readdirSync(STATUS_DIR); } catch (_) { return out; }
    for (const f of files) {
        if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
        const job = f.slice(0, -5);
        const rec = readJobStatus(job);
        if (rec) out[job] = rec;
    }
    return out;
}

module.exports = { writeJobStatus, readJobStatus, readJobHistory, readAllJobStatus, STATUS_DIR, STATUSES, HISTORY_CAP };
