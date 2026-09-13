# Watching statfink2 live scoring — guide for an external agent

This file is the complete contract for any agent, script, or person who wants
to know whether statfink2's live fantasy scoring is healthy right now. You do
not need to understand fantasy football, the scoring pipeline, or the eight
internal signals. You need to read one file and apply three rules.

## The one file

```
/home/joepaley/statfink2/logs/watchdog/live-latest.json
```

Rewritten atomically every 2 minutes by the `statfink2-watchdog` pm2 process.
It is always a single JSON object. Example:

```json
{
  "ts": "2026-09-20T18:07:02.037Z",
  "status": "stalled",
  "severity": "critical",
  "summary": "last_live_update 412s ago (limit 180s) - statfink2-live-continuous is not ticking; 7 of 9 in-progress game(s) not updated in 300s: ...",
  "week": 2,
  "season": 2026,
  "expectedGames": 9,
  "gamesInProgress": 7,
  "loopAgeSec": 412,
  "maintenance": false,
  "signals": [
    { "name": "expected_activity", "ok": true,  "detail": "9 game(s) in the live window" },
    { "name": "week_match",        "ok": true },
    { "name": "loop_heartbeat",    "ok": false, "severity": "critical", "detail": "last_live_update 412s ago (limit 180s) - statfink2-live-continuous is not ticking" },
    { "name": "game_freshness",    "ok": false, "severity": "critical", "detail": "7 of 9 in-progress game(s) not updated in 300s: ..." },
    { "name": "stats_flow",        "ok": true,  "detail": "player_stats written 40s ago" },
    { "name": "matchup_totals",    "ok": true,  "detail": "All 6 matchups match their scoring players' point sums" },
    { "name": "live_errors",       "ok": true },
    { "name": "disk_free",         "ok": true,  "detail": "50.4 GB free" }
  ],
  "durationMs": 84
}
```

Four fields matter. Everything else is for a human debugging.

| field | type | meaning |
|---|---|---|
| `ts` | ISO-8601 UTC | when this check ran |
| `status` | string | what is going on (table below) |
| `severity` | `ok` \| `warning` \| `critical` | how bad |
| `summary` | string | one sentence, human readable, safe to forward verbatim |

## The three rules

1. **`severity` is `ok`** → healthy. Do nothing. (`status` will be `ok`, `idle`, or `maintenance`.)
2. **`severity` is `warning` or `critical`** → something is wrong. `status` says what, `summary` says why. Treat `critical` as page-worthy and `warning` as dashboard-worthy.
3. **`ts` is older than 15 minutes** and `/home/joepaley/statfink2/logs/maintenance.lock` does not exist → the watchdog itself is dead. That is critical too. If the lock file exists, the nightly test run has the services stopped on purpose; wait.

Apply hysteresis before paging: require the same bad verdict on **two consecutive reads** (about 4 minutes apart). A single bad line can be a 30-second Tank01 cache hiccup. The built-in notifier uses exactly this rule.

## Status values

| `status` | meaning | severity |
|---|---|---|
| `ok` | NFL games are in the live window and scoring data is moving | ok |
| `idle` | no games in the window (kickoff within −4h…+15m); loop is ticking | ok |
| `maintenance` | nightly tests have the services stopped (`logs/maintenance.lock`) | ok (warning if the lock is older than 30 min) |
| `stalled` | the live loop is not ticking, an in-progress game has not been rewritten in 5 min, or a game is still `Scheduled` 0-0 twenty minutes after kickoff | **critical** during games, warning when idle |
| `degraded` | game status moves but player stats do not, matchup totals disagree with lineups, the last update swallowed errors, or free disk under 2 GB | warning (disk: critical) |
| `misconfigured` | a game is live in an NFL week that is not `current_week` — the week was not advanced, and its stats are silently not being collected | **critical** |
| `server_down` | the statfink2 server did not answer at all | **critical** |

## Where else to look

- **History**: `/home/joepaley/statfink2/logs/watchdog/live-YYYY-MM-DD.jsonl` — every check, one JSON object per line, same shape as above, 30 days kept. Healthy checks are logged too, so gaps in the file are meaningful.
- **Is someone already on it?** `/home/joepaley/statfink2/logs/watchdog/notifier-state.json` is written by the built-in notifier (`statfink2-watchdog-notifier`, every 5 min). If `incident` is non-null, an incident is already open; `incident.emails` says how many emails have gone to Joe, `incident.since` when it started. Use it to avoid double-paging. `lastRunAt` older than 30 min means the notifier is dead.
- **Over HTTP, from the box**: `curl -s http://localhost:8000/api/admin/health/live-watchdog` returns `{ "data": { "latest": <the file above>, "notifier": <notifier-state> } }`. Localhost needs no login. From another machine this route requires an admin session.
- **Dashboard**: `/admin/dashboard` → Status tab → "Live Scoring Watchdog".

## Reading it

Same box, shell:

```bash
cat /home/joepaley/statfink2/logs/watchdog/live-latest.json
```

Same box, node one-liner that prints the verdict and exits 0 (healthy), 1 (warning), 2 (critical or stale):

```bash
node -e '
const f="/home/joepaley/statfink2/logs/watchdog/live-latest.json";
const l=JSON.parse(require("fs").readFileSync(f));
const lock=require("fs").existsSync("/home/joepaley/statfink2/logs/maintenance.lock");
const ageMin=(Date.now()-Date.parse(l.ts))/60000;
let sev=l.severity;
if(ageMin>15&&!lock) sev="critical", l.summary=`watchdog silent for ${ageMin.toFixed(0)}m`;
console.log(sev, l.status, "-", l.summary);
process.exit(sev==="ok"?0:sev==="warning"?1:2);
'
```

Another machine:

```bash
ssh joepaley@<statfink host> cat /home/joepaley/statfink2/logs/watchdog/live-latest.json
```

Every bad check today:

```bash
grep -hv '"severity":"ok"' /home/joepaley/statfink2/logs/watchdog/live-$(date -u +%F).jsonl
```

## What to do about each status

Only act if you have been told you may restart things. Otherwise report the
`summary` to Joe (joe.paley@gmail.com) and stop.

| `status` | look at | fix |
|---|---|---|
| `server_down` | `pm2 logs statfink2 --lines 100` | `pm2 restart statfink2` |
| `stalled` | `pm2 logs statfink2-live-continuous --lines 50`, then `pm2 logs statfink2 --lines 200` for Tank01 errors or quota | `pm2 restart statfink2-live-continuous`; if Tank01 is the problem there is no local fix, tell Joe |
| `misconfigured` | the `week_match` signal names the weeks | a human must advance the week from the admin dashboard (weekly update). Do not do this yourself |
| `degraded` | the failing signal's `detail`; `curl -s localhost:8000/health` for Tank01 request counts | `disk_free` failing: `pm2 flush`; otherwise report |
| watchdog silent | `pm2 logs statfink2-watchdog --lines 50` | `pm2 restart statfink2-watchdog` |
| `maintenance` older than 30 min | `pm2 logs statfink2-nightly-tests --lines 50` | `rm logs/maintenance.lock && pm2 start statfink2 statfink2-live-continuous statfink2-email-poller` |

## Do not

- Do not write to any file under `logs/watchdog/`; two writers would corrupt the notifier's cursor.
- Do not write to `fantasy_football.db`. It is the league's official record.
- Do not run `npm start` while pm2 is up.
- Do not treat `stalled` while `expectedGames` is 0 as an emergency. Off-hours restarts cause it; it clears itself in a minute.
- Do not page on one bad line. Two in a row.

## When games happen (all UTC)

Thursday night ≈ Fri 00:20–04:00. Sunday 17:00 → Mon 04:00. Monday night ≈ Tue 00:15–04:30. Outside these windows `idle` is the expected status. Full timeline in `docs/CRON.md`, "A Week in the Life".
