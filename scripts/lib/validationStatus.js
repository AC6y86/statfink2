'use strict';

/**
 * Validation status record (the "weekly validation" contract kept for the
 * recap gate and the admin card), now produced by the DAILY update.
 *
 *   buildValidationStatus({ health, completion, doubleCheck, trigger, mode })
 *   writeValidationFiles(status, { weekComplete })
 *     - always:            logs/status/validation.json   (job status contract)
 *     - when weekComplete: logs/weekly-validation-latest.json + history
 *                          (= "the last validated COMPLETED week"; scripts/recap-data.js
 *                          and scripts/weekly-recap-run.js gate on it)
 */

const fs = require('fs');
const path = require('path');
const { writeJobStatus } = require('./jobStatus');

const REPO = path.join(__dirname, '../..');
const LATEST_FILE = path.join(REPO, 'logs/weekly-validation-latest.json');
const HISTORY_FILE = path.join(REPO, 'logs/weekly-validation-history.json');
const DOUBLECHECK_LATEST = path.join(REPO, 'logs/doublecheck-latest.json');
const HISTORY_CAP = 60;

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }

/** The latest Double Check result if it is about this season/week, else null. */
function doubleCheckFor(season, week) {
    const dc = readJson(DOUBLECHECK_LATEST);
    if (!dc || Number(dc.season) !== Number(season) || Number(dc.week) !== Number(week)) return null;
    return { overallStatus: dc.overallStatus, counts: dc.counts, completeness: dc.completeness, runAt: dc.runAt, reportFile: dc.reportFile,
        findings: (dc.findings || []).filter(f => f.severity !== 'INFO') };
}

function computeOverallStatus(health, doubleCheck) {
    if (!health || health.skipped) return 'SKIPPED';
    if (health.overallStatus === 'failed') return 'FAIL';
    if (doubleCheck && (doubleCheck.overallStatus === 'FAIL' || doubleCheck.overallStatus === 'ERROR')) return 'FAIL';
    // WARN only when someone should look: real (non-deferred) check warnings or a
    // double check that found something. An unfinished week is PASS-so-far; its
    // completeness is shown separately (gamesComplete), and deferred checks are counted, not coloured.
    const realWarnings = Array.isArray(health.checks) && health.checks.length
        ? health.checks.filter(c => c.status === 'warning').length
        : (health.summary ? Number(health.summary.warnings) || 0 : 0);
    if (realWarnings > 0 || (doubleCheck && doubleCheck.overallStatus === 'WARN')) return 'WARN';
    return 'PASS';
}

function buildValidationStatus({ health, completion = null, trigger = 'daily', mode = 'full' }) {
    const season = health ? health.season : null;
    const week = health ? health.week : null;
    const doubleCheck = season && week ? doubleCheckFor(season, week) : null;
    const h = health ? { ...health, completion: completion || health.completion || null } : null;
    return {
        schemaVersion: 1,
        runAt: new Date().toISOString(),
        trigger, mode, season, week,
        gamesComplete: completion || (health && health.completion) || null,
        overallStatus: computeOverallStatus(h, doubleCheck),
        healthValidation: health && !health.skipped ? { overallStatus: health.overallStatus, summary: health.summary, checks: health.checks } : null,
        doubleCheck,
        // legacy field kept for the admin card (was the jest verification suite)
        verificationSuite: doubleCheck ? { ran: true, passed: !['FAIL', 'ERROR'].includes(doubleCheck.overallStatus), summaryLine: `Double check ${doubleCheck.overallStatus} — FAIL ${doubleCheck.counts?.FAIL ?? 0}, WARN ${doubleCheck.counts?.WARN ?? 0}`, reports: doubleCheck.reportFile ? [doubleCheck.reportFile] : [], outputTail: '', doubleCheck } : null,
        durationMs: 0, error: null, email: { sent: false, to: null, error: null }
    };
}

const DEFERRED_RE = /deferred|not yet|in progress|games final|until the week|unusual but can be legitimate/i;

/** A warning that only says "wait for the week to finish" is state, not a problem. */
function isDeferredWarning(check) {
    if (!check || check.status !== 'warning') return false;
    const text = `${check.message || ''} ${(check.details || []).map(d => (typeof d === 'string' ? d : JSON.stringify(d))).join(' ')}`;
    const parts = String(check.message || '').split(/,|;/).length;
    // End-of-Week Suite bundles sub-checks: deferred only if every detail line is deferred
    if (Array.isArray(check.details) && check.details.length) return check.details.every(d => DEFERRED_RE.test(typeof d === 'string' ? d : JSON.stringify(d)));
    return DEFERRED_RE.test(text) && parts >= 1;
}

/**
 * Job-status colour for the validation record. Failed checks or a failed
 * double check are critical; real warnings are warnings; warnings that only
 * mean "the week is not over yet" are ok (they stay visible in the panel).
 */
function statusKind(overall, status = null) {
    if (overall === 'FAIL' || overall === 'ERROR') return 'critical';
    if (overall === 'SKIPPED') return 'skipped';
    if (overall === 'WARN') {
        const checks = status && status.healthValidation ? status.healthValidation.checks || [] : [];
        const realWarnings = checks.filter(c => c.status === 'warning' && !isDeferredWarning(c));
        const dcWarn = status && status.doubleCheck && status.doubleCheck.overallStatus === 'WARN';
        return realWarnings.length || dcWarn ? 'warning' : 'ok';
    }
    return 'ok';
}

function writeValidationFiles(status, { weekComplete = false } = {}) {
    const sm = status.healthValidation ? status.healthValidation.summary : null;
    const summary = status.overallStatus === 'SKIPPED' ? 'offseason - no games' :
        `${status.overallStatus} — ${status.season} week ${status.week}${status.gamesComplete ? ` (${status.gamesComplete.completedGames}/${status.gamesComplete.totalGames} final)` : ''}` +
        (sm ? `; checks ${sm.passed} passed, ${sm.failed} failed, ${sm.warnings} warnings${sm.deferred ? `, ${sm.deferred} deferred` : ''}` : '') +
        (status.doubleCheck ? `; double check ${status.doubleCheck.overallStatus}` : '');
    writeJobStatus('validation', {
        status: statusKind(status.overallStatus, status), summary, season: status.season, week: status.week, ts: status.runAt,
        details: { mode: status.mode, trigger: status.trigger, overallStatus: status.overallStatus, gamesComplete: status.gamesComplete,
            healthSummary: sm, checks: status.healthValidation ? status.healthValidation.checks : [], doubleCheck: status.doubleCheck, weekComplete }
    });
    if (!weekComplete) return { latestWritten: false };
    fs.mkdirSync(path.dirname(LATEST_FILE), { recursive: true });
    fs.writeFileSync(LATEST_FILE, JSON.stringify(status, null, 2));
    let history = readJson(HISTORY_FILE);
    if (!Array.isArray(history)) history = [];
    history.push({ runAt: status.runAt, season: status.season, week: status.week, overallStatus: status.overallStatus,
        healthSummary: sm, verificationPassed: status.verificationSuite ? status.verificationSuite.passed : null });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-HISTORY_CAP), null, 2));
    return { latestWritten: true };
}

module.exports = { buildValidationStatus, writeValidationFiles, computeOverallStatus, doubleCheckFor, statusKind, isDeferredWarning, LATEST_FILE, HISTORY_FILE };
