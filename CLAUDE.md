# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Always start by saying a random slang name for me.

## What this is

StatFink2 is the scoring engine and website for the Peninsula Football League (PFL), a 12-owner fantasy football league with custom scoring. It is the league's official scorer: the SQLite database is the official record of seasons, and scoring correctness is the top priority.

## League rules (do not violate, do not invent)

- Scoring rules are in docs/SCORING_SYSTEM.md. Do not make up scoring rules; when a play is ambiguous, follow "Defensive Touchdowns — Exact Award Logic" there and get a commissioner ruling if still unclear.
- 12 owners, 19 players per team each week. A team with fewer than 19 in a week is an error.
- A player is either Active or on Injured Reserve — there is no "starter"/"bench".
- IR: a player must stay on IR at least 3 weeks before he can be brought back.
- Season context: 2024 (17 weeks) and 2025 (18 weeks) are complete, blessed seasons protected by regression tests.

## Hard rules

- Never fix stats by changing the database — fix the sync/scoring logic instead, then recalculate.
- Never make new .db files or tables without permission.
- Never write to the database from tests.
- Do not check in code without asking. When committing, include fantasy_football.db (it is the official record; stored via git LFS).
- After manually updating stats for a past season, always run the season's recalc script (utils/recalculate2024season.js or utils/recalculate2025season.js).
- Place all temporary files, debug scripts, and one-time migration scripts in /tmp.

## Pre-authorized (no need to ask)

- Run npm test / test suites
- Create or modify files in /tmp
- Read from fantasypros.com and nfl.com
- Write recaps into /recaps

## Commands

```bash
npm run test:fast              # unit + fast integration (~30s) — run before any commit
npm run test:integration:slow  # 2024+2025 golden scoring regression, recalculated in a COPY of the DB (scripts/run-slow-tests.js; ~3 min)
npm run test:all               # fast + all slow projects (browser, verification — some have known failures)
npx jest tests/unit/foo.test.js --maxWorkers=2       # single fast test file
npx jest --config jest.config.slow.js <pattern>      # single slow test (slow files are allowlisted in jest.config.slow.js and ignored in jest.config.js — new slow tests must be wired into BOTH)
npm run baseline:2025          # re-bless the 2025 golden baseline (scoring-ruling act — see below)
node utils/recalculate2024season.js   # full 2024 recalc from cached boxscores (offline)
node utils/recalculate2025season.js   # full 2025 recalc (18 weeks)
node scripts/take_screenshots.js      # browser screenshots of the site
node scripts/doublecheck-data.js <season> <week>   # Double Check: read-only extraction + ESPN pull + rubric recompute -> logs/doublecheck/<season>/week<NN>/
node scripts/doublecheck-finalize.js <season> <week>   # apply rulings/verdicts, write report.md + logs/doublecheck-latest.json
node scripts/qwen-replay.js --season 2025 [--tag v2 --classes ... --sample 15]   # ask local Qwen every past TD/safety, score vs the calibrated script + known errors (read-only)
node scripts/recalc-week.js <season> <week> [--standings]   # recalc ONE current-season week from cache after a scoring fix (guards: blessed seasons, games in progress)
```

## Double Check (manual, LLM-run deep audit)

`docs/DOUBLECHECK.md` describes the pipeline: `scripts/doublecheck-data.js` (read-only DB snapshot + ESPN JSON + independent rubric/lineup recompute + touchdown dossier with three-vote possession (ESPN drive, gamebook prose, play text) + per-game score reconciliation + one named check per historical bug class in scripts/lib/doublecheckChecks.js) → `questions.json` for the plays the rules cannot decide → `scripts/doublecheck-reconcile.js` (Claude Opus via `claude -p`, strict JSON verdicts) → `scripts/doublecheck-finalize.js` (rulings > verdicts > script; report.md + logs/doublecheck-latest.json). It runs daily at 06:00 UTC (`statfink2-doublecheck-daily`); verdicts and your rulings live on `/admin/status` (`POST /api/admin/doublecheck/ruling`). `HealthCheckService.runValidation` stays as the cheap in-server layer (run FULL daily, no ESPN scrape) and the Double Check is the authority when they disagree. Everything is read-only; findings say which logic to fix and which recalc to run. The independent rubric (scripts/lib/doublecheckRubric.js) must never import the production scoring services (tests/unit/doublecheckTripwire.test.js); `npm run test:integration:slow` also proves it agrees with the 2024/2025 record row for row. Calibration: the pre-correction backup `backup_data/fantasy_football_pre-2025-recalc-2026-07-11.db` must reproduce the 2025 corrections in docs/DEFENSIVE_SCORING.md (tests/integration/doublecheckCalibration.test.js, opt-in with DOUBLECHECK_CALIBRATION=1).

## Server management

- Production runs under pm2 (see ecosystem.config.js and docs/CRON.md): `statfink2` (web app, port 8000), `statfink2-live-continuous` (per-minute live scoring), `statfink2-email-poller` (email roster moves), `statfink2-daily` (13:00 UTC: backup, sync, FULL validation; writes logs/weekly-validation-latest.json when the week is complete - the recap gate; the weekly update itself is manual), `statfink2-doublecheck-daily` (06:00 UTC: Double Check of the most recent week with a final game, read-only; open questions go to Claude Opus via scripts/doublecheck-reconcile.js; never emails), `statfink2-nightly-tests` (daily regression run; never emails), `statfink2-watchdog` (observes live scoring every 2 min, writes one JSON line per check to logs/watchdog/, never alerts), `statfink2-watchdog-notifier` (every 5 min reads that log, opens/closes incidents, posts dashboard alerts, emails on critical - the ONLY thing that emails), `statfink2-log-sentinel` (every 10 min: pm2 log error fingerprints; yellow only for a never-seen error shape; known noise in server/config/knownLogNoise.json), and `statfink2-live-review` (every 5 min during game windows only: local Qwen votes on every defensive TD / safety as it happens; disagreements become Double Check questions; writes a diagnosis when the watchdog escalates; `QWEN_BASE_URL`/`QWEN_MODEL` in .env, see docs/CRON.md "Local Qwen"). **Verification status page: `/admin/status`** (every job's last run vs cadence and pm2 state, live scoring incl. public-site and ESPN-score probes, Double Check findings/questions/rulings, live play review, validation checks incl. Schedule Integrity and Clock Sanity, log errors, alerts). Every job writes `logs/status/<job>.json` via `scripts/lib/jobStatus.js`. Policy: email only when the site is down or live scoring is dead during games; everything else is dashboard-only; alerts only for FAILED checks, deduped. See docs/CRON.md "Verification status and email policy".
- Restart the server with `pm2 restart statfink2`. NEVER run `npm start` while pm2 is running.
- Admin auth: password on the public host; password-free on the loopback-only Tailscale listener (127.0.0.1:8001 via `tailscale serve`) and for bare localhost `/api/*` calls — decided by socket in server/auth/trust.js, never by req.ip. `helm/*.html` is not served statically; add pages via guarded routes. The admin UI is the responsive app in helm/admin/ (`/admin/<area>`, ES modules per area, existing `/api/admin/*` endpoints only); the old dashboard.html lives at `/admin/legacy`. See docs/CRON.md "Admin access paths".
- Development: `npm run dev` (nodemon) — stop pm2 first (`pm2 stop statfink2`).
- SQLite means one writer: full-season recalcs contend with the live services (SQLITE_BUSY). Stop `statfink2`, `statfink2-live-continuous`, and `statfink2-email-poller` before a full-season recalc of the LIVE database, restart after. The nightly golden regression avoids this entirely: scripts/nightly-test-run.js copies the DB (`sqlite3 .backup`) and runs the slow suite with `STATFINK_SLOW_DB=<copy>` (tests/setup.js + the comparators honour it), so the official record is never rewritten by a test.

## Architecture — the scoring pipeline

Express app (server/app.js) + SQLite (fantasy_football.db, WAL mode). All NFL data comes from the Tank01 API via server/services/tank01Service.js, which caches responses in the tank01_cache table; completed-game boxscores are cached permanently, so full-season recalculations run offline. A boxscore that just turned Completed is quarantined (15 min, refetched once, must have its scoring plays reach the final score) before it becomes permanent — Tank01 flips the status before its play list settles.

Scoring flows through these services (server/services/):

1. **statsExtractionService** maps Tank01 boxscore player stats into `player_stats` rows (one per player-week; `game_id` links to `nfl_games`).
2. **scoringPlayParserService** parses each game's scoring-play text into typed plays (return TDs, defensive TDs, offensive fumble recoveries, safeties). Fumble recoveries are ambiguous in text; the parser disambiguates using player positions loaded from the Tank01 player list (`setPlayerPositions`). Name extraction must survive hyphens, apostrophes, and compound play prose.
3. **individualPlayerScoringService** credits individual players from parsed plays (20-pt return TDs, 8-pt offensive fumble-recovery TDs into rushing_tds). Player lookup requires evidence the player was in that game (player_stats.game_id) — never match on nfl_players.team, which is only the CURRENT team and breaks historical recalcs.
4. **dstManagementService** writes DST rows with the defensive TD breakdown from the parser.
   Rule fixes that would change a blessed season are season-gated in **server/config/scoringRulesets.js** (`rulesFor(season)`; 2024/2025 keep legacy behaviour, 2026+ get the fixes; an omitted season means legacy). Callers must pass `{ season }` to `parseScoringPlays`. Known errors deliberately left in blessed seasons are registered in **server/config/knownScoringErrors.json** (the Double Check reports them as INFO "KNOWN"; tests assert the rows still read as registered) — see docs/DEFENSIVE_SCORING.md §7.
5. **scoringService.calculateFantasyPoints** is the single authority converting a stats row into fantasy points; **fantasyPointsCalculationService** applies it season-wide, and defensive least-points/least-yards bonuses (5 pts, split on ties) are computed across rostered DSTs.
6. **scoringPlayersService** selects each team's official scoring lineup (weekly_rosters.is_scoring / scoring_slot) and is the SOLE writer of matchups.team1/2_scoring_points. (teamScoreService's full-roster overwrite was removed from the recalc — do not reintroduce it.)
7. **standingsService** accumulates weekly_standings from matchup scoring points.
8. **seasonRecalculationOrchestrator** runs the whole pipeline for a season (delete → resync from cache → scoring plays → points → bonuses → lineups → standings). utils/recalculate202Xseason.js are thin wrappers.

Note: nfl_players contains only draftable positions (QB/RB/WR/TE/FB/K/DST). Defensive players are absent by design; a return TD by a CB is credited to no one (documented limitation).

## Golden-record regression tests (the scoring safety net)

Any scoring change must pass BOTH seasons: `npm run test:integration:slow` copies the DB, recalculates 2024 and 2025 from cache in the copy (never in fantasy_football.db - the recalc tests refuse to run without STATFINK_SLOW_DB) and diffs every rostered player-week against:
- **2024**: tests/2024/statfinkv1_2024.db — the official record, corrected for 3 documented scorekeeping errors (docs/DEFENSIVE_SCORING.md "2024 Official-Record Corrections").
- **2025**: tests/2025/baseline_2025_fantasy_points.json — the blessed record, corrected for 16 ESPN-verified errors (docs/DEFENSIVE_SCORING.md "2025 Official-Record Corrections").

These tests should ALWAYS pass. A mismatch means a real scoring-logic bug — fix the logic, never the baselines or the tests. If a scoring change is INTENTIONAL (commissioner ruling), re-bless with `npm run baseline:2025` and commit the JSON diff (it shows exactly which player-weeks changed); reference-DB edits require explicit permission.

## Key data tables

`player_stats` (per player-week stats + fantasy_points), `nfl_players`, `nfl_games`, `weekly_rosters` (fantasy rosters; is_scoring marks the official lineup), `matchups` (scoring_points are the official team scores the site displays), `weekly_standings`, `teams` (the 12 owners), `tank01_cache`, `league_settings`.
