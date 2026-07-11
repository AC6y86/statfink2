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
npm run test:integration:slow  # 2024+2025 full-season scoring regression (recalcs both seasons, ~3-10 min)
npm run test:all               # fast + all slow projects (browser, verification — some have known failures)
npx jest tests/unit/foo.test.js --maxWorkers=2       # single fast test file
npx jest --config jest.config.slow.js <pattern>      # single slow test (slow files are allowlisted in jest.config.slow.js and ignored in jest.config.js — new slow tests must be wired into BOTH)
npm run baseline:2025          # re-bless the 2025 golden baseline (scoring-ruling act — see below)
node utils/recalculate2024season.js   # full 2024 recalc from cached boxscores (offline)
node utils/recalculate2025season.js   # full 2025 recalc (18 weeks)
node scripts/take_screenshots.js      # browser screenshots of the site
```

## Server management

- Production runs under pm2 (see ecosystem.config.js and docs/CRON.md): `statfink2` (web app, port 8000), `statfink2-live-continuous` (per-minute live scoring), `statfink2-email-poller` (email roster moves), `statfink2-daily`, `statfink2-weekly` (disabled; weekly update is manual), `statfink2-weekly-validate` (Tuesday validation of the completed week; always emails joe.paley@gmail.com and feeds the admin dashboard's Weekly Validation panel), and `statfink2-nightly-tests` (daily regression run; emails only on failure).
- Restart the server with `pm2 restart statfink2`. NEVER run `npm start` while pm2 is running.
- Development: `npm run dev` (nodemon) — stop pm2 first (`pm2 stop statfink2`).
- SQLite means one writer: full-season recalcs and the slow test suite contend with the live services (SQLITE_BUSY). Stop `statfink2`, `statfink2-live-continuous`, and `statfink2-email-poller` before recalcs, restart after (scripts/nightly-test-run.js shows the pattern).

## Architecture — the scoring pipeline

Express app (server/app.js) + SQLite (fantasy_football.db, WAL mode). All NFL data comes from the Tank01 API via server/services/tank01Service.js, which caches responses in the tank01_cache table; completed-game boxscores are cached permanently, so full-season recalculations run offline.

Scoring flows through these services (server/services/):

1. **statsExtractionService** maps Tank01 boxscore player stats into `player_stats` rows (one per player-week; `game_id` links to `nfl_games`).
2. **scoringPlayParserService** parses each game's scoring-play text into typed plays (return TDs, defensive TDs, offensive fumble recoveries, safeties). Fumble recoveries are ambiguous in text; the parser disambiguates using player positions loaded from the Tank01 player list (`setPlayerPositions`). Name extraction must survive hyphens, apostrophes, and compound play prose.
3. **individualPlayerScoringService** credits individual players from parsed plays (20-pt return TDs, 8-pt offensive fumble-recovery TDs into rushing_tds). Player lookup requires evidence the player was in that game (player_stats.game_id) — never match on nfl_players.team, which is only the CURRENT team and breaks historical recalcs.
4. **dstManagementService** writes DST rows with the defensive TD breakdown from the parser.
5. **scoringService.calculateFantasyPoints** is the single authority converting a stats row into fantasy points; **fantasyPointsCalculationService** applies it season-wide, and defensive least-points/least-yards bonuses (5 pts, split on ties) are computed across rostered DSTs.
6. **scoringPlayersService** selects each team's official scoring lineup (weekly_rosters.is_scoring / scoring_slot) and is the SOLE writer of matchups.team1/2_scoring_points. (teamScoreService's full-roster overwrite was removed from the recalc — do not reintroduce it.)
7. **standingsService** accumulates weekly_standings from matchup scoring points.
8. **seasonRecalculationOrchestrator** runs the whole pipeline for a season (delete → resync from cache → scoring plays → points → bonuses → lineups → standings). utils/recalculate202Xseason.js are thin wrappers.

Note: nfl_players contains only draftable positions (QB/RB/WR/TE/FB/K/DST). Defensive players are absent by design; a return TD by a CB is credited to no one (documented limitation).

## Golden-record regression tests (the scoring safety net)

Any scoring change must pass BOTH seasons: `npm run test:integration:slow` recalculates 2024 and 2025 from cache and diffs every rostered player-week against:
- **2024**: tests/2024/statfinkv1_2024.db — the official record, corrected for 3 documented scorekeeping errors (docs/DEFENSIVE_SCORING.md "2024 Official-Record Corrections").
- **2025**: tests/2025/baseline_2025_fantasy_points.json — the blessed record, corrected for 16 ESPN-verified errors (docs/DEFENSIVE_SCORING.md "2025 Official-Record Corrections").

These tests should ALWAYS pass. A mismatch means a real scoring-logic bug — fix the logic, never the baselines or the tests. If a scoring change is INTENTIONAL (commissioner ruling), re-bless with `npm run baseline:2025` and commit the JSON diff (it shows exactly which player-weeks changed); reference-DB edits require explicit permission.

## Key data tables

`player_stats` (per player-week stats + fantasy_points), `nfl_players`, `nfl_games`, `weekly_rosters` (fantasy rosters; is_scoring marks the official lineup), `matchups` (scoring_points are the official team scores the site displays), `weekly_standings`, `teams` (the 12 owners), `tank01_cache`, `league_settings`.
