/**
 * Temp-database helper for tests that need to WRITE.
 *
 * The real fantasy_football.db is the official league record and must never be
 * written by tests (CLAUDE.md hard rule). This creates a throwaway SQLite file
 * in /tmp from schema.sql plus the migrations a fresh DB is missing
 * (is_scoring/scoring_slot columns and the nfl_games table live only in
 * server/database/migrations/).
 *
 * Usage:
 *   const { createTempDb } = require('../helpers/tempDb');
 *   db = await createTempDb('my-test');   // sets DATABASE_PATH before construction
 *   ...
 *   await db.close(); // file is deleted by cleanupTempDb
 */

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '../../server/database/migrations');

async function createTempDb(label) {
    const dbPath = path.join('/tmp', `statfink-test-${label}-${process.pid}-${Date.now()}.db`);
    process.env.DATABASE_PATH = dbPath;

    // Require AFTER setting DATABASE_PATH: the constructor reads the env var.
    const Database = require('../../server/database/database');
    const db = new Database();

    // Wait for async schema initialization to FULLY finish - polling for an
    // early table races the still-running multi-statement exec (schema.sql's
    // last statement is the idx_tank01_cache_historical index).
    await waitFor(async () => {
        const row = await db.get("SELECT name FROM sqlite_master WHERE name = 'idx_tank01_cache_historical'");
        return !!row;
    });

    // Apply the pieces of the migrations a schema.sql-only DB lacks
    await db.run('ALTER TABLE weekly_rosters ADD COLUMN is_scoring INTEGER DEFAULT 0');
    await db.run('ALTER TABLE weekly_rosters ADD COLUMN scoring_slot VARCHAR(20)');
    const nflGamesSql = fs.readFileSync(path.join(MIGRATIONS_DIR, 'add_nfl_games.sql'), 'utf8');
    await new Promise((resolve, reject) =>
        db.db.exec(nflGamesSql, err => (err ? reject(err) : resolve())));
    // game_time_epoch exists in the production DB but in no schema/migration
    // file (ad-hoc drift) - the live-update query needs it
    await db.run('ALTER TABLE nfl_games ADD COLUMN game_time_epoch INTEGER');

    db.__tempPath = dbPath;
    return db;
}

async function cleanupTempDb(db) {
    if (!db) return;
    try {
        await db.close();
    } catch (_) { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
        try {
            fs.unlinkSync(db.__tempPath + suffix);
        } catch (_) { /* missing is fine */ }
    }
}

async function waitFor(cond, timeoutMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            if (await cond()) return;
        } catch (_) { /* not ready */ }
        await new Promise(r => setTimeout(r, 25));
    }
    throw new Error('Timed out waiting for temp DB initialization');
}

module.exports = { createTempDb, cleanupTempDb };
