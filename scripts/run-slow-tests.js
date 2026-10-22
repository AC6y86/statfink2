#!/usr/bin/env node
/**
 * Run the slow (golden-record) test suite against a COPY of the league database.
 *
 *   npm run test:integration:slow            (= node scripts/run-slow-tests.js)
 *   node scripts/run-slow-tests.js [jest args...]
 *
 * The 2024/2025 recalculation tests rewrite every stat row of those seasons.
 * They must never do that to fantasy_football.db, so this wrapper takes a
 * consistent sqlite .backup into logs/nightly/, exports STATFINK_SLOW_DB
 * (honoured by tests/setup.js and the comparators), runs jest, and deletes the
 * copy. The recalc tests refuse to run without STATFINK_SLOW_DB.
 */
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const COPY = path.join(REPO, 'logs/nightly', `fantasy_football.db.slowtests-${process.pid}`);
const extra = process.argv.slice(2);

function rm(f) { try { fs.unlinkSync(f); } catch (_) { /* absent */ } }

fs.mkdirSync(path.dirname(COPY), { recursive: true });
execSync(`sqlite3 "${path.join(REPO, 'fantasy_football.db')}" ".backup '${COPY}'"`, { stdio: 'pipe', timeout: 300000 });
console.log(`[run-slow-tests] database copy: ${COPY} (${(fs.statSync(COPY).size / 1e6).toFixed(0)} MB)`);
const args = ['jest', '--config', 'jest.config.slow.js', 'recalculateAndVerify2024', 'compareStats2024', 'recalculateAndVerify2025', 'compareStats2025baseline', '--testTimeout=900000', ...extra];
const res = spawnSync('npx', args, { cwd: REPO, stdio: 'inherit', env: { ...process.env, STATFINK_SLOW_DB: COPY } });
for (const f of [COPY, `${COPY}-wal`, `${COPY}-shm`]) rm(f);
process.exit(res.status === null ? 1 : res.status);
