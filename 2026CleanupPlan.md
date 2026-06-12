# StatFink2 Reliability Hardening Plan (2026 Season Prep)

## Context

The goal of this project is fully hands-off automated fantasy football scoring. Analysis of the weekly lifecycle found the core pipeline works (Tank01 API → player_stats → fantasy points → scoring players → matchup scores), but failures are **silent**: everything logs to console/pm2 only, week advancement is manual (cron disabled), several season values are hardcoded to 2024/2025 and will break in 2026, and there is no automated validation that a completed week's data is correct. Evidence the silence is real: daily backups stopped Jan 23 → Jun 12 (machine off all offseason) and nothing flagged it.

**Decisions:** alerts go to **logs + the admin dashboard** (no external services). **Re-enable the weekly advancement cron** with safeguards.

### How the system works each week (verified)

- **Daily 3am PDT** (`ecosystem.config.js:30` → `scripts/daily-update.js` → `SchedulerService.performDailyUpdate()` at `server/services/schedulerService.js:63`): sync game schedule, backup DB to `/home/joepaley/backups/`, sync players/injuries, write weekly report JSON.
- **Every 60s** (`scripts/live-update-continuous.js` → `performLiveGameUpdate()` at `schedulerService.js:308`): update live scores, recalc the 13 scoring players per 19-player roster, recalc matchup scores; when all games final, apply DST points/yards-allowed bonuses.
- **Weekly (currently MANUAL)** (`performWeeklyUpdate()` at `schedulerService.js:184`): verify all games complete → standings → increment `league_settings.current_week` → copy 12×19 rosters to next week. Cron commented out at `ecosystem.config.js:52`.

### Verified fragility points

1. **No alerting** — errors collected into `results.errors` but `performDailyUpdate` still reports success; `daily-update.js` just `process.exit(1)`.
2. **Hardcoded seasons** — `admin.js:358` (`const currentSeason = 2024; // TODO`), `admin.js:751` (rejects seasons > 2025), `tank01Service.js:551` (fallback `{currentWeek: 1, season: 2024}`), `league.js:250,263,275`, defaults in `seasonRecalculationOrchestrator.js:19` / `testRunnerService.js`.
3. **Week advancement manual** — weekly cron disabled.
4. **No end-of-week validation** — 19-player invariant only checked inside roster-move transactions; no check that active players have stat rows; `tests/validateEndOfWeek.test.js` exists but excluded from `npm test`.
5. **Silent scoring failures** — `scoringPlayParserService.js:63` returns `[]` on parse error (loses DST scoring plays — historically the buggiest area, see `docs/DEFENSIVE_SCORING.md`); `individualPlayerScoringService.js:32` logs-and-continues on player-not-found with fragile LIKE name matching.
6. **Backups unbounded & undocumented** — 150 files / 7.3GB in `/home/joepaley/backups/`, no pruning, no restore doc; backup runs *after* the first DB-mutating sync step.
7. **Ambiguous API results** — `tank01Service.getPlayerStats` returns `{}` for both "no games this week" and some failure paths.

Rosters themselves verified healthy: all 12 teams have exactly 19 active players in week 18/2025.

### Empirical fragility (from commit history — 129 of 245 commits are fixes)

1. **DST/defensive scoring is the #1 historical bug source**: ~15+ fix commits in two clusters (June 2025: fumble recovery categorization, lateral plays, blocked returns, parser scope bugs; September 2025: DST not updating live, defensive scoring missing from team totals, points-allowed bug when opponent scores 0). `scoringService.js` 10 fix commits, `scoringPlayParserService.js` 9, `dstManagementService.js` 5. → DST observability is promoted to P0 (see P0-1 check 6).
2. **Weekly update once advanced into a week with NO rosters** (commit f327966, Sep 23 2025: "week 4 had no rosters after weekly update ran") — the exact failure the 228-row assertion in P1-1 prevents. The weekly cron was disabled Sep 9 and never re-enabled.
3. **Team-code/ID mismatches recur**: Washington WSH-vs-WAS fixed twice 16 days apart (Sep 5, Sep 21), "player ID mismatches" Sep 6. → team-code consistency check added to P0-1.
4. **Season start is the danger window**: dense Sep 5–23 firefight cluster, stable after week 3 — raises the value of the rollover script (P1-2) and running validation drills against 2025 data before week 1.

### Test suite critique

195 tests pass in ~32s; existing unit tests are decent quality (mocked DB, real scoring-rule assertions). But coverage is **inverted relative to risk**:
- **Zero tests** for the most-fixed code: `scoringPlayParserService` (9 fix commits), `schedulerService` (11 fix commits, incl. the week-4-no-rosters incident), `scoringPlayersService` (the 13-of-19 selection — core scoring correctness), `fantasyPointsCalculationService`, `teamScoreService`, `individualPlayerScoringService`. Meanwhile low-risk UI/mock-display behavior is heavily tested.
- **Data-quality tests never run**: `tests/verification/` (player-matching, stats-accuracy, stats-completeness, data-reconciliation), `validateEndOfWeek`, `compareStats2024/2025` are excluded from `npm test` and not executed by any cron. They are operational checks miscategorized as tests — healthCheckService (P0-1) becomes their runner.
- **No regression tests for past production bugs**: the June 2025 DST parser cluster (fumble recovery, laterals, blocked returns), points-allowed-0 bug, and WSH/WAS fixes locked in no fixtures.
- **No failure-path tests**: API errors, partial responses, malformed boxscores.

Raw material exists: 585 real Tank01 boxscore responses cached in the `tank01_cache` table (read-only extraction), including the known DST bug games listed in `docs/DEFENSIVE_SCORING.md`.

---

## P0 — Before 2026 season

### P0-1: Health/alert service + admin dashboard surfacing

**New** `server/services/healthCheckService.js`:
- `recordAlert(severity, source, message)` — appends to `logs/health-alerts.json` (JSON file, NOT a new DB table) and `logError`. Keep last ~200 alerts, with an `acknowledged` flag.
- `runValidation(week, season)` — read-only checks reusing existing logic:
  1. Roster invariant: 12 teams × 19 active — reuse `teamScoreService.verifyRosterCompleteness()` (`teamScoreService.js:159`)
  2. Stats completeness: every active rostered player has a `player_stats` row for a completed week (SQL join; warn-level)
  3. End-of-week suite: call `testRunnerService.runValidateEndOfWeekTest(week, season)` (already runs `validateEndOfWeek.test.js` in-process, read-only)
  4. Matchup consistency: matchup scores == sum of scoring players' points
  5. Freshness: `last_daily_update` < 26h old; newest backup file < 48h old (skip both checks in offseason — no games scheduled)
  6. **DST sanity** (promoted from P2 — #1 historical bug source): for each completed game, flag a boxscore that yielded zero parsed scoring plays despite a non-zero final score (catches `scoringPlayParserService.js:63` swallowing errors); flag any drafted DST with games played but no points/yards-allowed recorded; verify defensive bonus totals were applied once all games are final
  7. **Team-code consistency** (recurring WSH/WAS-class bugs): every team code in `player_stats`/`weekly_rosters`/`nfl_games` for the week exists in the canonical NFL team list; alert on unknown or mismatched codes

**Wiring:**
- End of `performDailyUpdate()`: run light checks (1, 2, 5); any `results.errors` → `recordAlert`.
- End of `performWeeklyUpdate()`: full validation of the just-completed week.
- `scripts/live-update-continuous.js`: alert after 15 consecutive failures (counter, reset on success), plus a "recovered" entry.
- New endpoints in `server/routes/admin.js`: `GET /api/admin/health/alerts`, `POST /api/admin/health/alerts/ack`, `POST /api/admin/health/validate` (manual run).

**Dashboard:** add an alerts panel to the existing **Status tab** in `helm/dashboard.html` (the `system-status` section at line ~942): unacknowledged-alert count badge on the tab, list with severity/timestamp/message, acknowledge button, and a "Run Validation Now" button.

### P0-2: Kill hardcoded seasons (single source of truth)

`league_settings.season_year` is already the runtime source of truth — fix the stragglers:
- `server/routes/admin.js:358` → read from league_settings
- `server/routes/admin.js:751-754` → upper bound from settings (or current year + 1), not literal 2025
- `server/services/tank01Service.js:551` → fallback uses configured season
- `server/routes/league.js:250,263,275` → settings-driven
- `seasonRecalculationOrchestrator.js:19`, `testRunnerService.js` → require explicit season param or read settings

Verify with `grep -rn "2024\|2025" server/` — remaining hits should only be legitimately historical (route names, mock parsing).

### P0-3: Backup retention, ordering, restore doc

- **Reorder** `performDailyUpdate()` so backup runs **first** (before game-schedule sync mutates the DB) — every backup then captures pre-sync state; recovery from a botched sync = restore + re-run.
- Add pruning in `backupDatabase()` (`schedulerService.js:493`): keep last 14 dailies + first backup of each month; match only `fantasy_football_YYYY-MM-DD.db` filenames; log what was pruned and record an info alert.
- **New** `docs/BACKUPS.md`: restore procedure (stop pm2, copy backup over `fantasy_football.db`, delete `-wal`/`-shm`, `pm2 restart statfink2`, run validation), retention policy, `PRAGMA integrity_check` verification.

### P0-4: Regression test pack for the historically buggy core

Targets the inverted coverage. All tests use fixtures / mocked DB — never write to the real database.

- **DST parser regression tests** (`tests/unit/scoringPlayParser.test.js`): extract real boxscores from `tank01_cache` (read-only, one-time script in /tmp) into `tests/fixtures/boxscores/`, prioritizing the known bug games from `docs/DEFENSIVE_SCORING.md` (blocked returns: CHI wk1, NYG wk6, SEA wk12, TB wk17 2024) plus games with defensive fumble TDs, laterals, and pick-sixes. Assert `categorizePlayType` classifications match known-correct outcomes. Add malformed-boxscore cases asserting errors are **surfaced, not swallowed** (pairs with P0-1 check 6).
- **Scoring-player selection tests** (`tests/unit/scoringPlayersService.test.js`): constructed 19-player rosters → assert exactly 1 QB + 4 RB + 4 WR/TE + 1 K + 1 Bonus + 2 DST selected, DST chosen by points-allowed and yards-allowed, tie handling.
- **Scheduler tests** (`tests/unit/schedulerService.test.js`, mocked DB): `performWeeklyUpdate` does not advance when games incomplete; rosters copied on advance; 228-row assertion fires on shortfall (regression for commit f327966); error aggregation populates `results.errors`.
- **Policy going forward**: every production bug fix adds a fixture-based regression test; new boxscore oddities get their fixture extracted from `tank01_cache` while it's still cached.

These land **alongside** the features they protect: parser tests before/with P0-1 check 6, scheduler tests with P1-1.

## P1 — Before week 1

### P1-1: Re-enable weekly cron with safeguards

- Uncomment `cron_restart: '0 11 * * 2'` at `ecosystem.config.js:52`. Existing protections stay (24h dedup, all-games-complete gate, week-18 cap).
- In `performWeeklyUpdate()`, **before** `advanceWeek()`: run full `healthCheckService.runValidation()` on the completed week. Validation failure → do NOT advance, record critical alert, leave state for manual review.
- Offseason guard: no `nfl_games` rows for current week/season → exit quietly.
- After `copyRostersToNextWeek`: assert exactly 228 active roster rows exist for the new week (12×19); on mismatch, record a critical alert and roll the advance back (this exact failure happened in production — commit f327966, week 4 advanced with no rosters).
- Record an info alert on successful advance ("Advanced to week N") so the dashboard shows it happened.

### P1-2: Season rollover script for 2026

**New** `scripts/season-rollover.js` (`--dry-run` default, `--execute` to apply): verify Tank01 API key works → set `league_settings` to season 2026 / week 1 → player sync → sanity checks (player count, 32 DSTs, week-1 schedule syncs) → run validation → print remaining manual checklist (draft rosters: 19/team, `pm2 save`). Update `docs/SEASON_RESTART.md` to reference it. Depends on P0-2.

### P1-3: Cheap liveness depth

- Extend `GET /health` (`server/app.js:163`) with scheduler timestamps + `stale: true` if daily update > 26h old (offseason-aware).
- `pm2 install pm2-logrotate` so pm2 logs don't grow unbounded over a season.

## P2 — During season, as time allows

### P2-1: Remaining silent-failure visibility (DST boxscore check moved to P0-1 check 6)

- `individualPlayerScoringService.js`: collect unmatched player names per run and surface the list as a warning alert, instead of one buried logWarn per play. Keep the LIKE matcher as-is unless 2026 shows real misses.
- `tank01Service.getPlayerStats`: distinguish "no games" (`{noGames: true}` or null) from failure; audit the 2–3 call sites.

### P2-2: Misc hygiene

- Move hardcoded internal token `'statfink-internal-cron'` (`internal.js:28` + 3 scripts) to `.env`.

## Deliberately excluded

- Fully transactional multi-step syncs — backup-first ordering + validation + alerts gives most of the safety for a fraction of the work; re-running sync is the established recovery path.
- New DB tables (alerts live in `logs/health-alerts.json`) — needs explicit permission; can migrate later if preferred.
- Rewriting player name-matching — observability first (P2-1), rewrite only if real misses appear.

## Verification

- `npm test` after each step. New unit tests for healthCheckService use fixtures/in-memory data — never write to the real DB.
- Run `POST /api/admin/health/validate` against the real 2025 DB for weeks 1–18 — all should pass (read-only).
- Weekly-cron safeguards: test against a **copy of the DB in /tmp**: offseason state (no-op), incomplete week (holds + alert), complete week (advances, 228 rows copied).
- Backup pruning: unit test against a /tmp dir of fake filenames; dry-run logging first; one real restore drill to a /tmp copy.
- Dashboard: load `/admin/dashboard#status`, confirm alerts panel renders, ack works; screenshot via `scripts/take_screenshots.js`.
- Rollover script: `--dry-run` against live DB; `--execute` against a /tmp copy only.
- New regression tests (P0-4) run as part of `npm test` and must stay in the fast suite (fixture-based, no network, no real DB).
- Sequencing: P0-1 (+P0-4 parser tests) → P0-2 → P0-3 → P1-2 → P1-1 (+P0-4 scheduler tests; cron last, after validation proven on 2025 data) → P1-3 → P2.
