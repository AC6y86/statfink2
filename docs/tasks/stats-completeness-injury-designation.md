# Task: stop the daily "Stats Completeness" check from warning on injured players

Self-contained brief. Everything you need is in this file and the repo at
`/home/joepaley/statfink2`. Do not rely on any chat history.

## 1. Background

The daily update (`scripts/daily-update.js`, pm2 process `statfink2-daily`,
runs 13:00 UTC) finishes by calling
`healthCheckService.runValidation(week, season, { mode: 'light' })`.
Light mode runs three checks; one is **Stats Completeness**
(`checkStatsCompleteness` in `server/services/healthCheckService.js`).

Original behaviour: list every `weekly_rosters` row with
`roster_position = 'active'` whose NFL team has a `nfl_games` row with
`status LIKE 'Final%'` for that week, and no matching `player_stats` row.
Any non-empty list produced `status: 'warning'`, which `runValidation`
records as a warning alert in `logs/health-alerts.json`. The helm admin
page (`helm/admin/js/areas/thisweek.js`) then shows
"N alerts unacknowledged · newest: validation:Stats Completeness".

Why that is noise: the stats sync writes a zero-point `player_stats` row
for every player who dressed, even with no production. A *missing* row
therefore means ESPN never listed the player in the box score, which is
almost always an inactive/injured scratch. Example, week 1 of 2026:
Zach Charbonnet (SEA, Out), TreVeyon Henderson (NE, Out),
De'Zhaun Stribling (SF, Questionable, hurt in-game) all triggered the
warning. Owner's rule: **expected outcomes must not be warnings.**

The `nfl_players` table has an `injury_designation` column
(values seen: `Out`, `Doubtful`, `Questionable`, `Injured Reserve`,
`Injured Reserve - Designated to Return`, or empty/NULL).

## 2. Required behaviour

In `checkStatsCompleteness(week, season)`:

1. Keep the existing query, but `LEFT JOIN nfl_players np ON
   np.player_id = wr.player_id` and select `np.injury_designation`.
2. Split the missing players into:
   - **expected**: `injury_designation` is a non-empty string after trim.
   - **unexplained**: designation NULL or empty.
3. Return `status: 'warning'` only when `unexplained.length > 0`.
   Otherwise return `status: 'passed'` (even if `expected` is non-empty).
4. `message`:
   - nobody missing: `All active players with completed games have stat rows`
   - only expected missing: `<n> active player(s) with completed games have no stat row, all carry an injury designation (expected)`
   - some unexplained: `<n> active player(s) with completed games have no stat row and no injury designation` plus, if any expected, ` (<m> more are injured/out, expected)`
5. `details`: unexplained players first (max 15), formatted
   `Name (POS, TEAM) on fantasy team <team_id>`, then expected players
   (max 15) with ` - <designation>, expected` appended.
6. Do not change `runValidation`, `recordAlert`, or the full-mode suite.
   Full mode already skips this check because the End-of-Week Suite does
   its own ESPN classification.

## 3. Tests

Add a `describe` block to `tests/unit/healthCheckService.test.js` that
mocks `db.all` (return the supplied rows when the SQL contains
`FROM weekly_rosters wr`, otherwise `[]`) and covers:

- no rows → `passed`, `details` is `[]`
- rows all with designations → `passed`, message matches `/expected/`,
  details entries end in `- Out, expected` style
- mix of NULL, `''`, and `Out` → `warning`, message counts 2 unexplained
  and 1 expected, unexplained listed before expected

Run:

```
cd /home/joepaley/statfink2
npx jest tests/unit/healthCheckService.test.js
```

Expected: all tests pass (13 as of this writing, 3 of them new).

## 4. Verify against the real database (read-only)

```
cd /home/joepaley/statfink2
node -e "
const Database=require('./server/database/database');
const H=require('./server/services/healthCheckService');
(async()=>{const db=new Database();
const h=new H(db,{alertsFile:'/tmp/hc-scratch-alerts.json'});
console.log(JSON.stringify(await h.checkStatsCompleteness(1,2026),null,1));
await db.close();})();
"
```

Expected for week 1/2026: `"status": "passed"` and three details lines
ending in `expected`. Passing a scratch `alertsFile` keeps the real
`logs/health-alerts.json` untouched. Do not run `runValidation` with
`recordAlerts` on, and do not write to `fantasy_football.db`.

## 5. Current state of the repo (as of 2026-09-13)

The change described above **has already been applied** to
`server/services/healthCheckService.js` and the tests have been added.
Your job is to confirm sections 3 and 4 hold. If they do not, fix the
code to match section 2. If they do, nothing in those files needs editing.

## 6. Follow-up steps, in order

1. **Do not restart `statfink2` or `statfink2-live-continuous` while NFL
   games are in progress** (Sunday/Monday/Thursday game windows). The
   daily job is its own pm2 process and already loads the new code.
   The main server only needs a restart so the admin "run validation"
   button uses the new logic. When no game is live:
   `pm2 restart statfink2`
2. Acknowledge the two stale alerts either from the helm This Week card
   ("Ack all") or by POSTing to the admin alerts acknowledge route in
   `server/routes/admin.js` (search for `acknowledgeAlerts`).
3. Commit **only** these two files. The working tree has other
   uncommitted work (helm/admin, auth, ecosystem) that belongs to a
   separate change. Never `git add -A`. Never commit
   `fantasy_football.db`.

```
cd /home/joepaley/statfink2
git add server/services/healthCheckService.js tests/unit/healthCheckService.test.js docs/tasks/stats-completeness-injury-designation.md
git commit -m "Stats Completeness: treat injury-designated players as expected, warn only on undesignated gaps"
```

## 7. Gotchas

- `nfl_games.status` can be `Final/OT`; always compare with `LIKE 'Final%'`.
- Washington's canonical code is `WAS` (Tank01 emits `WSH`).
- `player_id` in `weekly_rosters` and `nfl_players` are strings.
- Do not raise the check back to `warning` for `Questionable` players;
  the owner accepted that a Questionable player with no box-score entry
  is an expected scratch.
