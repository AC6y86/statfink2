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
    { "name": "disk_free",         "ok": true,  "detail": "50.4 GB free" },
    { "name": "public_site",       "ok": true,  "detail": "200 in 41 ms → https://peninsulafootball.com/statfink/2026/2" },
    { "name": "public_api_fresh",  "ok": true,  "detail": "last_sync_time 0s ago" },
    { "name": "tls_cert",          "ok": true,  "detail": "expires in 61 days" },
    { "name": "scores_vs_espn",    "ok": true,  "detail": "7 game(s) match ESPN" }
  ],
  "durationMs": 312
}
```

The first eight signals come from the server (`/api/internal/health/live`);
the rest are measured by the watchdog script itself (`scripts/lib/siteSanity.js`):
the public page (`public_site`, critical when it does not serve
`/statfink/<season>/<week>`), the public API's freshness (`public_api_fresh`,
warning when live and stale), the TLS certificate (`tls_cert`, warning under
14 days, critical under 3) and our scores against ESPN's scoreboard
(`scores_vs_espn`, warning when a game lags ESPN by more than 5 minutes;
`idle` outside game windows). When the server is down the line carries
`server_reachable` plus those instead.

Those public-site probes run ON the statfink VM against its own public
hostname. They are a **self-probe**, not an independent external check: a
dead resolver on the VM makes them fail while every league owner can still
load the site. So every line also carries five network-path diagnostics
(`scripts/lib/netDiag.js`, each bounded by a short timeout, every failure a
`warning`):

| signal | what it proves | default target (env override) |
|---|---|---|
| `dns_system` | the VM's own resolver (systemd-resolved → gateway) can resolve the public hostname — the path fetch, axios and Tank01 use | `PUBLIC_SITE_URL` hostname |
| `dns_gateway` | the LAN gateway answers a DNS query directly | `192.168.1.1` (`WATCHDOG_GATEWAY_DNS`, empty disables) |
| `dns_public` | an independent public resolver answers (ok when any does) | `1.1.1.1,9.9.9.9` (`WATCHDOG_PUBLIC_DNS`) |
| `tcp_public` | a TCP connection to the public address on the site's port opens | first DNS answer (`WATCHDOG_PUBLIC_IP`) |
| `tls_public` | the TLS handshake on that connection, SNI = the hostname, completes (protocol and CN in `detail`) | same |

Timeouts: `WATCHDOG_DNS_TIMEOUT_MS` (2000 per query), `WATCHDOG_CONNECT_TIMEOUT_MS`
(5000 each for TCP and TLS). Details carry hostnames, addresses, latencies
and error codes only. Reading them together: `dns_gateway` failing with
`dns_public` ok = the gateway's resolver is the problem; all three `dns_*`
failing = the VM has no name resolution (Tank01 will fail too); `dns_*` ok but
`tcp_public`/`tls_public` failing = the path past DNS is broken (nginx,
firewall, certificate); everything ok but `public_site` failing = the HTTP
layer (nginx upstream, wrong page).

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
| `degraded` | game status moves but player stats do not, matchup totals disagree with lineups, the last update swallowed errors, free disk under 2 GB, the public API is stale, the TLS certificate is expiring, or our scores lag ESPN | warning (disk, certificate under 3 days: critical) |
| `misconfigured` | a game is live in an NFL week that is not `current_week` — the week was not advanced, and its stats are silently not being collected | **critical** |
| `server_down` | the statfink2 server did not answer at all | **critical** |
| `public_path_unreachable` | the server answers on localhost but the watchdog's own probe of the public hostname failed. This is a self-probe from the VM, **not proof of an external outage**; `publicPathLayer` (`dns` / `tcp` / `tls` / `http` / `unknown`) and the `dns_*`, `tcp_public`, `tls_public` signals say which layer broke. Replaces the former `site_down` (lines written before 2026-10-18 still say `site_down`; treat it the same way). The server's own verdicts (`misconfigured`, `stalled`) always outrank it: a line that is both stalled and self-probe-failed says `stalled` | **warning** when the VM's own resolver cannot resolve the hostname (`dns`: a VM DNS problem); **critical** when the name resolves but TCP / TLS / HTTP fails (nginx, certificate, upstream — confirm from outside) |

## Where else to look

- **History**: `/home/joepaley/statfink2/logs/watchdog/live-YYYY-MM-DD.jsonl` — every check, one JSON object per line, same shape as above, 30 days kept. Healthy checks are logged too, so gaps in the file are meaningful.
- **Is someone already on it?** `/home/joepaley/statfink2/logs/watchdog/notifier-state.json` is written by the built-in notifier (`statfink2-watchdog-notifier`, every 5 min). If `incident` is non-null, an incident is already open; `incident.emails` says how many emails have gone to Joe, `incident.since` when it started. Use it to avoid double-paging. `lastRunAt` older than 30 min means the notifier is dead.
- **Over HTTP, from the box**: `curl -s http://localhost:8000/api/admin/health/live-watchdog` returns `{ "data": { "latest": <the file above>, "notifier": <notifier-state> } }`. Localhost needs no login. From another machine this route requires an admin session.
- **Diagnosis**: `/home/joepaley/statfink2/logs/live-review/diagnosis.json` — when a check is `warning`/`critical`, the live reviewer asks the local Qwen to read the watchdog line plus the pm2 log tails and writes `{ts, severity, diagnosis, suggestedAction}`; shown on `/admin/status` and appended to critical emails while fresh (15 min). It is an opinion, not a signal.
- **Dashboard**: `/admin/status` shows live scoring alongside every other verification job (last run vs cadence, Double Check, validation, alerts); the sidebar footer shows the overall dot on every page. The notifier is the ONLY process that emails; its last email error is on that page too.

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
| `public_path_unreachable` | `publicPathLayer` first. `dns`: `resolvectl status`, `resolvectl query peninsulafootball.com`, `dig @192.168.1.1 peninsulafootball.com`, `dig @1.1.1.1 peninsulafootball.com` — the VM's resolver / gateway, not the site. `tcp`/`tls`/`http`: `curl -I https://peninsulafootball.com`, `sudo -n systemctl status nginx`, `sudo -n certbot certificates`, `pm2 logs statfink2 --lines 100` | `dns`: tell Joe the gateway DNS is failing (the app's Tank01 calls fail with it); nothing is proven about the public site. Otherwise confirm from OUTSIDE the LAN before calling it an outage; if nginx is up and pm2 shows statfink2 online it is certificate / network - tell Joe |
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
