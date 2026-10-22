# Scheduler Configuration (CRON)

This document describes the automated scheduling implementation for StatFink2's scheduled tasks using PM2's built-in cron functionality.

## A Week in the Life (in-season timeline)

All times UTC (server timezone). In-season ET = UTC−4/−5. NFL game windows in UTC: TNF ≈ Fri 00:20–04:00, Sunday 17:00–04:00 Mon, MNF ≈ Tue 00:15–04:30.

```
CONTINUOUS (24/7, all season)
  statfink2                 web app + all internal endpoints (port 8000)
  statfink2-live-continuous every 60s -> POST /api/internal/scheduler/live
                            during games: sync live scores/stats, re-mark scoring
                            lineups + matchup totals; once ALL games are final:
                            defensive bonuses -> DST points -> final lineups
                            (no-ops quickly when nothing is live)
  statfink2-email-poller    every ~2min: Gmail -> parse roster-move emails ->
                            queue moves for commissioner approval
  statfink2-watchdog        every 2min: GET /api/internal/health/live, PLUS
                            script-side probes of the PUBLIC site
                            (https://peninsulafootball.com: reachable, right
                            week, sync-status fresh during games, TLS days) and
                            live scores vs the ESPN scoreboard, plus network-
                            path diagnostics (VM resolver, gateway DNS
                            192.168.1.1, public DNS 1.1.1.1/9.9.9.9, TCP, TLS) ->
                            appends one JSON line to logs/watchdog/live-*.jsonl
                            (public self-probe failed = status
                            public_path_unreachable: warning when it is the
                            VM's own DNS, critical past DNS -> email; it is
                            not proof of an external outage)
                            (observes only: "should stats be flowing? are they?")
  statfink2-watchdog-notifier  every 5min (cron): reads that log, opens an
                            incident after 2 bad checks, dashboard alert +
                            email on critical (hourly reminders, recovery mail)
  statfink2-log-sentinel    every 10min (cron): byte-cursor scan of the pm2
                            logs, errors grouped by fingerprint; /admin/status
                            turns yellow only for an error shape never seen
                            before (or a known one spiking). Known noise:
                            server/config/knownLogNoise.json or "It's noise"
                            on the page. Never emails.
  statfink2-live-review     every 5min (cron) but only DURING game windows:
                            builds the TD dossier for in-progress / just-final
                            games and has the local Qwen vote on every defensive
                            TD and safety; "confirmed" / "under review" /
                            "miscredit suspected" on /admin/status within
                            minutes; disagreements become questions for the
                            06:00 Double Check. On a watchdog escalation it
                            writes a plain-English diagnosis for the page and
                            the critical email. Read-only; never emails.

EVERY DAY
  06:00  statfink2-doublecheck-daily  Double Check of the latest week with a
                                   Final game (every player vs ESPN, lineups/
                                   matchups re-derived, every TD + safety
                                   classified, one check per historical bug
                                   class). Read-only, ~25 s. Skips the audit
                                   when nothing changed. Open questions go to
                                   Claude Opus (doublecheck-reconcile.js);
                                   verdicts on /admin/status. Never emails.
  12:00  statfink2-nightly-tests   fast suite + 2024/2025 golden scoring
                                   regression (~3 min) run against a COPY of
                                   the league DB (sqlite .backup); services stay
                                   up, the official record is never rewritten.
                                   Never emails; a failure turns /admin/status red.
         (13:00 daily validation also runs Schedule Integrity - internal
          shape + kickoffs vs the ESPN scoreboard cached by the Double
          Check - and Clock Sanity - NTP, UTC, game_time text vs epoch.)
  13:00  statfink2-daily           backup DB FIRST, then sync week games,
                                   players/injuries, weekly report, FULL
                                   health validation (no ESPN scrape) ->
                                   logs/status/validation.json; when the week is
                                   complete also logs/weekly-validation-latest.json
                                   (the recap gate). Failed checks -> dashboard
                                   alerts (deduped). Never emails; "ADVANCE THE
                                   WEEK" shows on /admin/status.

TUESDAY (the week rollover)
  ~04:30  MNF ends; live-continuous marks the last games Final and applies
          defensive bonuses within a few minutes
  06:00   doublecheck-daily audits the now-complete week (as every day)
  12:00   nightly tests (as every day)
  13:00   daily update validates the COMPLETED week and writes
          logs/weekly-validation-latest.json
  ~05:00  statfink2-recap-setup (every 30 min, exits at once until every game
          of the week is Final) sees the completed week and has headless claude
          propose 10 recap themes never used or proposed this season ->
          recaps/{season}/data/weekNN-themes.json. Nothing is generated.
  REVIEW  /admin Recaps: read the themes, remove any, add your own, then press
          Generate (needs the 13:00 validation of the week to be PASS/WARN).
          That runs scripts/weekly-recap-run.js --season --week: one recap per
          theme, fact-checked, written to recaps/{season}/. Never a cron.
  MANUAL  (optional) hold the week on /admin/thisweek ("Hold the advance") if
          something needs a ruling; release it when done.

WEDNESDAY
  15:00   statfink2-weekly-advance  (8am PDT) the weekly update: standings ->
          advance current_week -> copy rosters to the new week (guarded: refuses
          if any team != 19 active players), then re-validates the completed
          week so the standings checks bite. Runs ONLY when the completed week's
          validation is PASS; WARN/FAIL/missing or a hold => warning on
          /admin/status and nothing changes. Retries Thursday 15:00 UTC (~9 h
          before kickoff). "Advance now" on /admin/thisweek is the manual
          override at any time.

  *** DEADLINE: the advance MUST have happened before Thursday night kickoff
  (~Fri 00:20 UTC). Live updates poll games for current_week - if the week
  hasn't advanced, Thursday's stats are not collected. The daily "Week Advance
  Deadline" check turns critical (and the notifier emails) when <24 h remain. ***

WED-SAT   roster-move emails processed continuously against the new week;
          daily update + nightly tests as every day

The advance was manual from July to September 2026 (validation gated it, a
human pulled the trigger). Since 2026-09-15 it is automatic on Wednesday so the
league gets a full day to review; validation still gates it and the hold file
(logs/HOLD-ADVANCE, set from /admin/thisweek) stops it.

Offseason: everything still runs; live updates and validation no-op ("no games"),
every job still writes its status file, nightly tests keep guarding scoring.

## Verification status and email policy (since 2026-09-13)

One page: **/admin/status** (`GET /api/admin/status`, `server/services/jobStatusService.js`)
shows every job with its last run, cadence and "next expected"; a job silent past its
cadence + grace turns red ("not running"), and so does an app pm2 reports as
`errored` (or an always-on app that is `stopped`). Every job writes `logs/status/<job>.json`
via `scripts/lib/jobStatus.js` on every fire, including skips. The page also shows
live scoring, the Double Check (findings, defensive scores, open questions + Claude's
verdicts + your rulings), the daily validation checks, recaps, and the alerts list.

**Email = watchdog-notifier only** (site down, live scoring stalled during games,
week not advanced while games are live, watchdog dead). Nothing else emails: the
daily update, nightly tests, Double Check and recaps are dashboard-only. Alerts
(`logs/health-alerts.json`) are recorded only for FAILED validation checks and are
deduped (a repeat within 24 h bumps `count`). The notifier's own email health
(`lastEmailError`) is on the status page - in July-Sept 2026 every email failed
with `invalid_grant` for six weeks and nobody noticed because the failure signal
was itself an email.


**Double Check** (docs/DOUBLECHECK.md). Its deterministic layer is automatic:
`statfink2-doublecheck-daily` (06:00 UTC, `scripts/doublecheck-daily.js`)
audits the most recent week that has a Final game — every rostered player vs
ESPN, lineups/matchups re-derived from the rubric, every TD classified, one
check per historical bug class — skips when the set of final games, scores
and standings presence has not changed (state in logs/doublecheck-daily-state.json),
and emails ONLY on FAIL or a result flip. The morning after the manual weekly
update it re-audits the previous week with standings present, so the deferred
standings checks resolve on their own. weekly-validate runs the same layer on
Tuesday (in place of the retired jest tests/verification suite) and its
always-sent email carries the summary; `HealthCheckService.runValidation`
keeps running as the cheap dashboard/alert layer. The LLM audit layer stays
manual: `node scripts/doublecheck-data.js <season> <week>`, work the units per
the runbook, `node scripts/doublecheck-finalize.js <season> <week> --email`.
Manual daily run: `node scripts/doublecheck-daily.js --force [--week N] [--no-email]`.
```

## Current Implementation Status ✅

StatFink2 uses **PM2 cron jobs** for all scheduled tasks. The configuration is active and running in production.

**Server Timezone**: UTC (all cron times are in UTC)

### Active Scheduled Tasks:

1. **Daily Updates** - Runs at 1pm UTC (6am PDT / 5am PST)
2. **Live Game Updates** - Runs continuously (every minute, 24/7)
3. **Email Roster-Move Poller** - Runs continuously (polls Gmail every 2 minutes)
4. **Nightly Regression Tests** - Runs at 12pm UTC (5am PDT / 4am PST)
5. **Weekly Validation** - Runs Tuesdays at 10am UTC (3am PDT / 2am PST)
6. **Weekly Recaps** - Runs Tuesdays at 10:30am UTC, 30 min after validation
7. **Weekly Updates** - ⚠️ Currently DISABLED (cron commented out in `ecosystem.config.js`); run manually after reviewing the weekly validation report
8. **Live Scoring Watchdog** - Runs continuously (checks every 2 minutes, logs only)
9. **Watchdog Notifier** - Runs every 5 minutes (reads the watchdog log, alerts/emails)

## How It Works

### 1. Daily Update
- **PM2 Process**: `statfink2-daily`
- **Schedule**: `0 13 * * *` (1pm UTC = 6am PDT / 5am PST, before every kickoff window)
- **Script**: `/scripts/daily-update.js`
- **Functions**:
  - Updates NFL game schedule for the current week
  - Backs up database to `/home/joepaley/backups/`
  - Syncs NFL player rosters and injury statuses

### 2. Live Game Updates (Continuous)
- **PM2 Process**: `statfink2-live-continuous`
- **Schedule**: Runs continuously (every minute, 24/7)
- **Script**: `/scripts/live-update-continuous.js`
- **Functions**:
  - Updates live game scores during active games
  - Calculates defensive bonuses when all games complete
  - Automatically detects when games are in progress

### 3. Email Roster-Move Poller (Continuous)
- **PM2 Process**: `statfink2-email-poller`
- **Schedule**: Runs continuously (polls Gmail every 2 minutes)
- **Script**: `/scripts/roster-email-poller.js`
- **Functions**:
  - Forwards new roster-move emails to the server, which parses them and
    queues moves for commissioner approval
  - See `docs/EMAIL_ROSTER_MOVES.md` for the full system

### 4. Nightly Regression Tests
- **PM2 Process**: `statfink2-nightly-tests`
- **Schedule**: `0 12 * * *` (12pm UTC = 5am PDT / 4am PST)
- **Script**: `/scripts/nightly-test-run.js`
- **Functions**:
  - Stops the DB-writing services, runs the fast suite plus the 2024+2025
    scoring regression suites, restarts the services
  - Emails joe.paley@gmail.com (from peninsula.football.mailer@gmail.com)
    ONLY if a suite fails; green runs are silent
  - Requires the Gmail token to have the gmail.send scope
    (`node roster_moves/authSetup.js` re-authorizes if missing)

### 5. Weekly Validation
- **PM2 Process**: `statfink2-weekly-validate`
- **Schedule**: `0 10 * * 2` (10am UTC Tuesday = 3am PDT / 2am PST, after Monday night finals; must finish before the 12pm UTC nightly tests stop the server)
- **Script**: `/scripts/weekly-validate.js`
- **Functions**:
  - Runs the full health validation of the current (just-completed, not-yet-advanced)
    week via `POST /api/internal/health/validate`
  - Runs the deep ESPN verification suite (`tests/verification/`, read-only)
  - Writes `logs/weekly-validation-latest.json` (+ capped history) — shown on
    the admin dashboard's "Weekly Validation" panel
  - ALWAYS emails joe.paley@gmail.com a PASS/WARN/FAIL summary (offseason weeks
    send a one-line SKIPPED email; `SEND_OFFSEASON_EMAIL` in the script disables that)
- **Manual run**: `node scripts/weekly-validate.js [--week N] [--season Y] [--no-email] [--skip-verification]`
- **Workflow**: review the emailed report, then run the weekly update manually to advance the week

### 6. Recap themes + recaps (on demand)
- **PM2 Process**: `statfink2-recap-setup`
- **Schedule**: `*/30 * * * *` — exits `skipped` in a second unless the current
  week (or, right after an advance, the previous week) has every game Final,
  no recaps and no themes file yet
- **Script**: `/scripts/recap-setup.js`
- **Functions**:
  - Asks headless claude (`claude -p`, sonnet, no tools) for 10 themes not used
    or proposed this season (`scripts/recap-styles-used.js <season>` + earlier
    `weekNN-themes.json` files are the exclusion list; it resets each season)
  - Writes `recaps/{season}/data/week{NN}-themes.json`; status in
    `logs/status/recap-setup.json` (warning if claude could not propose — add
    themes by hand on /admin Recaps or press "Suggest more")
- **Recaps are generated only from /admin Recaps** ("Generate" button →
  `POST /api/admin/recaps/:season/:week/generate` → `scripts/weekly-recap-run.js
  --season Y --week N`, ~10-30 min, one recap per theme). There is no recap cron.
  - Gate: `logs/weekly-validation-latest.json` must be PASS/WARN for that week
    (the 13:00 daily writes it once the week is complete; `scripts/weekly-validate.js`
    does it on demand)
  - Drives the `/recap` slash command headlessly (`claude -p "/recap S W --auto"`,
    restricted tool allowlist, 30-min timeout): data digest → season storylines →
    the reviewed themes (or, with no themes file, 10 self-picked styles) → one
    narrator agent per theme → fact-check with one automatic regeneration of failures
  - DB is only ever read (read-only, via `scripts/recap-data.js`); writes only
    `recaps/{season}/` and `logs/`; never commits to git — new recap files wait
    for a manual commit
  - Writes `logs/weekly-recaps-latest.json` (+ capped history) — shown on the
    admin **Recaps** tab, where each recap can be read and turned into a Gmail
    draft (league mailer account; requires the gmail.compose scope —
    `node roster_moves/authSetup.js` re-authorizes if missing)
  - Never emails; the Recaps tab and /admin/status show the run
- **One recap, with feedback**: in the reader, "Give feedback and run again" →
  `POST /api/admin/recaps/:season/:week/:slug/regenerate {feedback}` →
  `scripts/recap-regenerate.js --season --week --slug --feedback`: one narrator
  agent for that style with the feedback quoted in its prompt (plus the digest,
  storylines and the previous version), one fact-check of that draft, then the
  draft replaces the file atomically (old version kept in
  `logs/recap-regenerate/{season}-week{NN}-{slug}/previous.md`), the week's
  fact-check report gets the new verdict and the recap's stale rating is dropped.
  Progress in `logs/status/recap-regenerate.json` (the reader polls
  `GET .../:slug/regenerate` and reopens the recap when done). One generation at
  a time: Generate and the rewrite refuse each other with 409.
- **Manual runs**: `node scripts/recap-setup.js [--season Y --week N] [--force] [--dry-run]`,
  `node scripts/weekly-recap-run.js --season Y --week N [--force] [--force-regenerate] [--dry-run]`,
  `node scripts/recap-regenerate.js --season Y --week N --slug S --feedback "..." [--dry-run]`

### 7. Weekly advance (automatic since 2026-09-15)
- **PM2 Process**: `statfink2-weekly-advance`
- **Schedule**: `0 15 * * 3,4` — Wednesday 15:00 UTC (8am PDT / 7am PST), retry
  Thursday 15:00 UTC (~9 h before kickoff)
- **Script**: `/scripts/weekly-advance.js`
- **Functions**:
  - Reads league settings + `logs/weekly-validation-latest.json`; advances ONLY
    when that validation is for the current week and PASS
  - `POST /api/internal/scheduler/weekly`: standings → advance `current_week` →
    copy rosters (refuses unless every team has exactly 19 active players; the
    server also refuses while any game is not Final) → full re-validation of
    the completed week
  - Writes `logs/status/weekly-advance.json`: ok (advanced), warning (held:
    validation WARN/FAIL/missing, or `logs/HOLD-ADVANCE`), critical (update ran
    with errors / server unreachable). Every non-ok state is a call to action
    on /admin/status; the daily Week Advance Deadline check still emails <24 h out
- **Hold**: "Hold the advance" on /admin/thisweek (or `node scripts/weekly-advance.js
  --hold "reason"` / `--release`) writes/removes `logs/HOLD-ADVANCE`. The manual
  "Advance now" button ignores the hold.
- **Manual run**: `node scripts/weekly-advance.js [--dry-run] [--force]` or
  `curl -X POST http://localhost:8000/api/admin/scheduler/weekly` (from a trusted socket)

### 8. Live Scoring Watchdog (Continuous) + Notifier

External agents: read `WATCHDOG.md` in the repo root (one file, three rules, runbook).

Two processes, one log. Health is judged from **data freshness against expected
activity**, never from the live endpoint's HTTP status (`performLiveGameUpdate`
answers 200 even when every Tank01 call failed).

- **PM2 Process**: `statfink2-watchdog` (always on) — `scripts/live-watchdog.js`
  - Every 2 min: `GET /api/internal/health/live` → `HealthCheckService.checkLiveScoring()`
  - Appends ONE JSON line per check to `logs/watchdog/live-YYYY-MM-DD.jsonl`
    (30-day retention) and rewrites `logs/watchdog/live-latest.json` (admin
    dashboard → Status → Live Scoring Watchdog). Healthy checks are logged
    too, so a silent log is itself a signal.
  - Never decides, alerts or emails.
- **PM2 Process**: `statfink2-watchdog-notifier` (cron `*/5 * * * *`) — `scripts/watchdog-notifier.js`
  - Reads new lines from a saved byte cursor (`logs/watchdog/notifier-state.json`)
  - Opens an incident after **2 consecutive bad lines** (~4 min); a single
    Tank01 hiccup never pages. First `ok`/`idle` line closes it.
  - Every transition → dashboard alert (`POST /api/internal/health/alert`).
    **Critical** → email joe.paley@gmail.com, re-sent hourly while open, once
    on recovery with the duration. Warnings → dashboard only.
  - No log line for 15 min (and no `logs/maintenance.lock`) → `watchdog_dead`
    critical incident: the dead-man's switch.
  - `node scripts/watchdog-notifier.js --dry-run` prints decisions without
    sending or saving; `--no-email` posts dashboard alerts only.

**Log line shape** (every line has `ts`, `status`, `severity`, `summary`; a
reader can act on those alone):

```json
{"ts":"2026-09-20T18:07:02.000Z","status":"stalled","severity":"critical",
 "week":2,"season":2026,"expectedGames":9,"gamesInProgress":7,"loopAgeSec":412,
 "signals":[{"name":"loop_heartbeat","ok":false,"severity":"critical",
             "detail":"last_live_update 412s ago (limit 180s) - statfink2-live-continuous is not ticking"}, ...],
 "summary":"last_live_update 412s ago ...; 7 of 9 in-progress game(s) not updated in 300s: ...",
 "maintenance":false,"durationMs":84}
```

| `status` | meaning | severity |
|---|---|---|
| `ok` | games in the live window and data is moving | ok |
| `idle` | no games in the window (kickoff within −4h…+15m), loop ticking | ok |
| `stalled` | loop heartbeat stale, an in-progress game not rewritten in 5 min, or a game still `Scheduled` 0-0 20 min after kickoff | critical (warning when idle) |
| `degraded` | stats not flowing / matchup totals inconsistent / swallowed sub-step errors / low disk | warning (disk: critical) |
| `misconfigured` | a game is live in a week ≠ `current_week` — **advance the week** | critical |
| `server_down` | the server did not answer (written by the watchdog itself) | critical |
| `public_path_unreachable` | the server answers but the watchdog's self-probe of the public hostname failed; `publicPathLayer` + the `dns_system`/`dns_gateway`/`dns_public`/`tcp_public`/`tls_public` signals say which layer (see `WATCHDOG.md`). Not proof of an external outage; replaces `site_down` (older lines and an incident opened before the rename keep that name and are handled alike). `misconfigured` and `stalled` outrank it (server/utils/liveRollup.js) | warning (VM DNS), critical (TCP / TLS / HTTP) |
| `maintenance` | `logs/maintenance.lock` exists (nightly tests); warning if older than 30 min | ok |

`scripts/nightly-test-run.js` writes `logs/maintenance.lock` while it has the
live services stopped, so the 12:00 UTC test window never pages.

Quick reads:
```bash
tail -1 logs/watchdog/live-$(date -u +%F).jsonl | node -e 'const l=JSON.parse(require("fs").readFileSync(0));console.log(l.ts,l.status,l.severity,"-",l.summary)'
grep -hv '"severity":"ok"' logs/watchdog/live-*.jsonl | cut -c1-200      # every bad check
node scripts/live-watchdog.js --once          # one check, printed, also logged
node scripts/watchdog-notifier.js --dry-run   # what the notifier would do now
```

## Admin access paths

Who gets into `/admin` (dashboard, `/admin/m` phone portal, `/api/admin/*`)
is decided by **which socket the request arrived on** (`server/auth/trust.js`),
never by an IP parsed from headers.

| Path | Listener | Password? |
|---|---|---|
| `https://peninsulafootball.com/admin` (internet) | nginx → `127.0.0.1:8000` | yes (login page, 2h session) |
| `https://statfink.tail22ba0f.ts.net/admin/m` (tailnet) | `tailscale serve` → `127.0.0.1:8001` | **no** — tailnet identity; pinned to `TAILSCALE_ADMIN_LOGINS` in `.env` |
| `http://127.0.0.1:8000/api/...` (cron scripts on the box) | direct loopback, no `X-Forwarded-For` | no, `/api/*` only |

One-time host setup for the tailnet path (persists across reboots):
```bash
tailscale serve --bg http://127.0.0.1:8001
tailscale serve status
```
Port 8001 is bound to loopback only, so nothing outside the box can reach it
except through Tailscale. `helm/*.html` is no longer served as bare static
files (`/dashboard.html` used to be public); pages come only from their
guarded routes. `/api/database` (raw SELECT) now requires admin auth too.

**The admin app** (`helm/admin/`, served at `/admin/<area>`) is one
responsive page: This week (timeline, needs-you queue, live scoring, weekly
validation, alerts, jobs), Roster moves (email queue, manual move form,
roster, player search), Scoring & data (sync, tests, database), Recaps,
Settings. Below 700px the sidebar becomes a bottom nav, so phones switch
automatically; Add to Home Screen gives an app icon
(`helm/mobile.webmanifest`). Destructive actions are two-tap. It calls only
the pre-existing `/api/admin/*` endpoints; areas are ES modules under
`helm/admin/js/areas/`. The old single-file dashboard is kept at
`/admin/legacy`; old `#tab` links and `/admin/m` redirect into the app.

**Public → tailnet hand-off**: the login page (and the app, via a banner)
fetches `https://<TAILSCALE_HOSTNAME>/tailnet-ping` with a 1.5 s timeout.
Only a tailnet device can reach that host, so if it answers the browser is
sent to the password-free tailnet URL; `/login?stay=1` skips the probe.

## Current PM2 Configuration

The scheduled tasks are configured in `/home/joepaley/statfink2/ecosystem.config.js` (the file itself is the source of truth). Nine PM2 apps are defined:

| Process | Type | Schedule (UTC) |
|---------|------|----------------|
| `statfink2` | Main server, always on | — |
| `statfink2-daily` | Cron | `0 13 * * *` (1pm UTC = 6am PDT) |
| `statfink2-live-continuous` | Always on | every minute, 24/7 |
| `statfink2-email-poller` | Always on | polls Gmail every 2 minutes |
| `statfink2-watchdog` | Always on | checks live scoring every 2 minutes, logs only |
| `statfink2-watchdog-notifier` | Cron | `*/5 * * * *` (reads the watchdog log, alerts/emails) |
| `statfink2-nightly-tests` | Cron | `0 12 * * *` (12pm UTC = 5am PDT) |
| `statfink2-doublecheck-daily` | Cron | `0 6 * * *` (6am UTC daily) |
| `statfink2-live-review` | Cron | `*/5 * * * *` (work only during game windows) |
| `statfink2-log-sentinel` | Cron | `*/10 * * * *` |
| `statfink2-recap-setup` | Cron | `*/30 * * * *` (proposes recap themes once the week is final) |
| `statfink2-weekly-advance` | Cron | `0 15 * * 3,4` (Wed 15:00 UTC = 8am PDT, retry Thu) |

## Monitoring Commands

### Check Status of All Processes:
```bash
pm2 list
```

### View Logs for Specific Tasks:
```bash
# Main application logs
pm2 logs statfink2

# Daily update logs
pm2 logs statfink2-daily

# Live update logs
pm2 logs statfink2-live-continuous

# Email poller logs
pm2 logs statfink2-email-poller

# Live scoring watchdog + notifier
pm2 logs statfink2-watchdog
pm2 logs statfink2-watchdog-notifier

# Nightly test logs
pm2 logs statfink2-nightly-tests

# Weekly advance logs
pm2 logs statfink2-weekly-advance

# All logs
pm2 logs
```

### Monitor Real-time Status:
```bash
pm2 monit
```

### Check Cron Status:
```bash
pm2 describe statfink2-daily    # Shows next execution time
pm2 describe statfink2-weekly-advance   # Shows last run time
```

## Manual Execution

You can manually trigger any scheduled task in two ways:

### Option 1: Direct Script Execution
```bash
# Daily update
node /home/joepaley/statfink2/scripts/daily-update.js

# Live update (continuous process - normally runs automatically)
node /home/joepaley/statfink2/scripts/live-update-continuous.js

# Weekly advance (gated on validation PASS; --force to override, --dry-run to look)
node /home/joepaley/statfink2/scripts/weekly-advance.js --dry-run
```

### Option 2: API Endpoints

```bash
# Daily update
curl -X POST http://localhost:8000/api/admin/scheduler/daily

# Live update  
curl -X POST http://localhost:8000/api/admin/scheduler/live

# Weekly update
curl -X POST http://localhost:8000/api/admin/scheduler/weekly

# Check scheduler status
curl http://localhost:8000/api/admin/scheduler/status
```

## PM2 Management

### Restart a Specific Task:
```bash
pm2 restart statfink2-daily
pm2 restart statfink2-weekly-advance
```

### Stop a Task Temporarily:
```bash
pm2 stop statfink2-live-continuous
```

### Start a Stopped Task:
```bash
pm2 start statfink2-live-continuous
```

### Update Configuration:
After modifying `ecosystem.config.js`:
```bash
pm2 reload ecosystem.config.js --update-env
pm2 save
```

## Timezone Considerations

- **Server runs in UTC timezone**
- All cron times in ecosystem.config.js are in UTC
- Conversions (PDT = UTC−7, PST = UTC−8):
  - Daily update: 1pm UTC = 6am PDT / 5am PST
  - Nightly tests: 12pm UTC = 5am PDT / 4am PST
  - Live updates run continuously, no time windows needed
- NFL game times are typically in ET
- The server tracks timestamps to prevent duplicate runs

⚠️ Note: some inline comments in `ecosystem.config.js` still say "10am UTC = 3am PDT" — the cron expression has been moved several times without updating the comments. The expressions above are what actually runs.

## Error Handling

The scheduler service includes:
- Prevention of concurrent runs (using in-progress flags)
- Timestamp tracking in the database
- Detailed logging of all operations
- Individual error handling for each sub-task
- Automatic restart on failure (for main app only)

## Database Backups

Daily backups are created as part of the daily update (1pm UTC = 6am PDT) and stored in `/home/joepaley/backups/` with the format:
```
fantasy_football_YYYY-MM-DD.db
```

Pruning is automated — after each backup, the retention policy keeps the last 14 daily backups plus the first backup of each month. See `docs/BACKUPS.md` for details and restore procedures.

## Troubleshooting

### Common Issues and Solutions:

1. **Cron job not running**: 
   ```bash
   pm2 describe statfink2-daily  # Check next execution time
   pm2 logs statfink2-daily --lines 50  # Check recent logs
   ```

2. **API timeouts**: 
   - Check if main app is running: `pm2 list`
   - Restart if needed: `pm2 restart statfink2`

3. **Duplicate runs**: 
   - The scheduler service prevents this automatically
   - Check logs: `pm2 logs statfink2-weekly-advance`

4. **Missing dependencies**: 
   ```bash
   cd /home/joepaley/statfink2
   npm install
   pm2 restart all
   ```

5. **PM2 not starting on boot**:
   ```bash
   pm2 startup  # Follow the instructions provided
   pm2 save
   ```

## Key Features

- All tasks managed through PM2 (no system cron needed)
- Live game updates run continuously (every minute, 24/7)
- Weekly update checks hourly but only runs when games complete
- All operations logged with timestamps
- State maintained in database to track last run times
- Manual trigger available via scripts or API

## Repair path after a confirmed scoring finding

1. Fix the logic (parser / extractor / scorer), with a test. Never edit the database.
2. `node scripts/recalc-week.js <season> <week> [--standings]` — recalculates that
   one week from the cached boxscores (wipe -> resync -> points -> bonuses when
   complete -> lineups/matchup totals -> standings on request). Refuses blessed
   seasons without `--allow-blessed` and refuses while games are in progress
   without `--force` (SQLite has one writer: the live loop).
3. `node scripts/doublecheck-daily.js --force --week <week>` to verify; the
   finding should be gone from /admin/status.

## Local Qwen (live play review)

`scripts/live-review.js` calls an OpenAI-compatible endpoint from `.env`
(`QWEN_BASE_URL`, `QWEN_MODEL`; no key). Since 2026-09-27 this is OrcaRouter
(`Qwen3.8-Flash-Next-Uncensored-oQ6e-mtp`) on Rosie's Mac Studio, served by
oMLX on loopback 11235 and published privately via Tailscale TCP 8081.
The base URL is `http://rosies-mac-studio.tail22ba0f.ts.net:8081/v1`.
The live-review PM2 environment is pinned to the same values; after changing
`.env`, refresh that job with the matching variables and `--update-env`, then
`pm2 save` (do not restart scoring). The replay CLI loads the same `.env`.
The older model remains on TCP 8080 / loopback 11234 for other consumers. Requests
carry `chat_template_kwargs: {enable_thinking: false}` so Qwen3 answers with
JSON only. Check from this box: `node scripts/lib/qwenClient.js --ping`.
If the Mac is asleep or off, the reviewer records `qwen: null`, the page says
"Qwen unreachable" as info, and nothing else changes - the deterministic
layer never depends on it.


### Roster intake repairs and commissioner ruling notes (2026-09-30)

- Fixed reply stripping: the old unanchored `On ... wrote:` regex could match the `on` inside Keyon and truncate Joe's Sadiq request. Headers now require a word boundary/whitespace and date/weekday prefix; folded Gmail headers are supported. Latest-body content stays separate from quoted historical moves.
- Dan (configured address wdochse@gmail.com) can issue `move_invalidation` parser results with a verbatim current-body ruling quote and no executable moves. Other senders and invented quotes fail closed. Passes, turn-order messages, hypotheticals and general draft rules are not invalidation notes.
- Queue stores these as kind `commissioner_invalidation`, status `notice`, deduplicated by Gmail ID. Admin Moves displays a separate Commissioner rulings card with exact quote, sender, date and source email. Notices do not reject, undo, approve or execute transactions, and cannot be approved as a move.
- Joe's source email1a0f07fd07bcc303 restored in existing queue itempm-1790741437936-7 with audit originals. Demarcus Robinson3043116 -> Kenyon Sadiq5083315, supplemental per Joe's Sep29 Pacific instruction. Read-only central validator passes; pending for commissioner approval. No roster/score DB writes.
- Tests:8 new regression failures demonstrated before repair; all76 focused tests passed after, and all981 fast unit/integration tests passed. Actual parser smoke fixtures distinguished a Dan invalidation from a pass with zero proposed moves. Only web and email-poller restarted. Browser navigation verification was blocked by browser policy; live API and served module verification are separate.
- Backups: /tmp/pfl-roster-repair-20260930-before/ and /tmp/pfl-pending-before-Joe-repair-20260930.json. No repository commit; existing worktree edits preserved.
