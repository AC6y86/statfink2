# Double Check — the league's independent audit

The Double Check is statfink2's second scorer: a deliberately slow, exhaustive,
read-only re-derivation of one fantasy week from the raw sources (the cached
Tank01 boxscores, ESPN's game summaries with drive data and gamebook prose,
and the rules in `docs/SCORING_SYSTEM.md`), compared row by row with what the
database says. It never writes `fantasy_football.db`; a finding says which
*logic* to fix and which recalc to run.

It runs itself. Nothing here needs an agent or a runbook: the deterministic
pass decides everything it can, what it cannot decide becomes a **question**
with its full evidence, Claude Opus answers the questions, and Joe's rulings
override everything. Results live on **`/admin/status`**.

## Pipeline

```
data ──▶ checks ──▶ questions ──▶ reconcile ──▶ finalize ──▶ status page
```

| step | script | reads | writes |
|---|---|---|---|
| data | `scripts/doublecheck-data.js <season> <week>` | DB (read-only), ESPN (cached under `logs/doublecheck/espn/`) | the workspace `logs/doublecheck/<season>/week<NN>/`: `manifest.json`, `checks.json`, `questions.json`, `league.md`, `games/game-<gameId>.md` |
| checks | `scripts/lib/doublecheckChecks.js` (inside the data script) | the snapshot + the dossiers | `checks.json` `findings[]`, `checklist[]`, `defensiveScores[]`; `questions.json` |
| reconcile | `scripts/doublecheck-reconcile.js <season> <week>` | `questions.json`, `resolutions.json`, `logs/doublecheck/rulings.json` | `resolutions.json` (Opus verdicts), then re-runs finalize |
| finalize | `scripts/doublecheck-finalize.js <season> <week>` | `manifest.json`, `checks.json`, `questions.json`, `resolutions.json`, `rulings.json` | `findings.json`, `report.md`, `logs/doublecheck-latest.json` (+ `doublecheck-history.json`) |
| status page | `GET /api/admin/status` → `/admin/status` | `logs/doublecheck-latest.json`, the workspace's questions/resolutions, `rulings.json` | — (`POST /api/admin/doublecheck/ruling` writes a ruling and re-runs finalize) |

Automatic: `statfink2-doublecheck-daily` (06:00 UTC, `scripts/doublecheck-daily.js`)
audits the most recent week with a Final game (skips when nothing changed),
runs reconcile when the run left open questions, and writes
`logs/status/doublecheck.json` / `reconcile.json` for the status page. It never
emails — the watchdog notifier is the only emailer.

### The data step

`scripts/doublecheck-data.js <season> <week> [--db <path>] [--out <dir>] [--offline] [--no-espn] [--refresh] [--rerun-standings] [--quiet]`

- Snapshots the DB read-only (rosters, stats with their **raw** team codes, games, matchups, standings, Tank01 boxscores and player list from `tank01_cache`).
- Pulls the week's ESPN summaries into the permanent file cache (`--offline` = cache only; `--no-espn` = skip, ESPN-dependent checks DEFER). A Final game must have a *complete* ESPN summary or it is treated as unavailable.
- Recomputes every player's points with the independent rubric (`scripts/lib/doublecheckRubric.js`, which must never import the production scoring code — `tests/unit/doublecheckTripwire.test.js`), re-selects every scoring lineup (`doublecheckLineup.js`), rebuilds every matchup total from the stored lineup and from the ESPN-derived best lineup.
- Builds a **touchdown dossier** per game (`scripts/lib/tdDossier.js`, below) and runs one named check per historical bug class (`doublecheckChecks.js`, table below).
- `--db` audits another database (opened immutable) — the calibration uses the pre-correction 2025 backup. `--rerun-standings` re-extracts offline after the manual weekly update so the standings checks stop deferring.

### The reconcile step

`scripts/doublecheck-reconcile.js <season> <week> [--workspace <dir>] [--model opus] [--dry-run] [--redo] [--quiet]`

For every question with neither a ruling nor a resolution (all of them with
`--redo`) it builds one prompt — the rule text from `docs/SCORING_SYSTEM.md`
"Defensive Touchdowns — Exact Award Logic" verbatim, the award-class table
below, the question's evidence bundle, and a strict JSON schema — and runs
headless `claude -p --output-format json --model opus --max-turns 1` (the same
pattern as the roster-email parser: 120 s timeout, JSON envelope, one retry when
the answer fails validation). A verdict must name one of the question's
options, list the credits that class implies, and carry a confidence
(`certain` / `likely` / `unsure`); credits that contradict the class are
rejected. Verdicts go to `resolutions.json`; then finalize re-applies them.
Exit 1 means a question could not be resolved after the retry (it stays open
on the status page). `--dry-run` builds the prompts and calls nothing.

### The finalize step

`scripts/doublecheck-finalize.js <season> <week> [--workspace <dir>] [--rulings <file>] [--trigger …] [--with-units] [--email] [--quiet]`

Applies **rulings > resolutions** to the findings each question relates to:

| decision | effect on the related findings |
|---|---|
| decided class whose credits are all in the DB | INFO `resolved (…)` — the record is right |
| decided class whose credits are missing from the DB (or an over-credit the class does not explain) | FAIL `CONFIRMED by <ruling|opus>: …` — fix the logic, recalc |
| `unsure` verdict, or no verdict | stays WARN `NEEDS YOUR RULING …`; the question is `open` |

Roll-up: FAIL > INCOMPLETE (any DEFER) > WARN > PASS. Exit 1 on FAIL, 2 when
the workspace is missing. `--with-units` restores the retired LLM-runbook
path (agents/*.md merged with the script findings); it is not used by any job.
`--email` exists for manual use only — no cron path emails.

## Files

| file | writer | shape |
|---|---|---|
| `questions.json` | data | `{ generatedAt, season, week, questions: [ { id, season, week, gameId, playIdx, kind: "td_award_class"\|"finding_review", question, evidence: { tank01Text, espnType, espnText, drive: {team, result, isTurnover, startTeam, endTeam}, gamebook, gamebookParsed, votes: {drive, gamebook, text}, votesAgree, scoringTeam, defendingTeam, scriptAwardClass, scriptReasons, players: [{id, name, pos, team, roles, draftable}], dbCredit, rule }, options: [...], relatedFindingIds: [...] } ] }` — id `<season>-wk<NN>-<gameId>-play-<idx>` |
| `resolutions.json` | reconcile | `{ generatedAt, season, week, model, resolutions: { [questionId]: { questionId, awardClass, credits: [{player_id, column, delta}], confidence, reasoning, model, ts } } }` |
| `logs/doublecheck/rulings.json` | `POST /api/admin/doublecheck/ruling` | `{ [questionId]: { questionId, awardClass, note, by, ts } }` — one file for all seasons; a ruling overrides the resolution |
| `checks.json` | data | `{ generatedAt, season, week, findings[], checklist[], knownErrors: {matched, unmatched}, defensiveScores[], questionIds[] }` |
| `manifest.json` | data | run info, `games[]`, `coverage`, `deferred[]`, `questionCount`, `defensiveScores[]`, `scoreCheck: { checked, mismatches[], games[] }` |
| `findings.json`, `report.md` | finalize | merged findings with decisions attached; the human-readable report (Summary → flips → FAIL → WARN → **Rulings & questions** → **Defensive scores** → Deferred → … → What to fix) |
| `logs/doublecheck-latest.json` | finalize | `{ overallStatus, counts, completeness, findings (FAIL/WARN/DEFER only), questions: [{id, gameId, playIdx, question, resolution, ruling, status: "open"\|"resolved"\|"ruled", …}], defensiveScores, scoreCheck, reportFile, workspace }` — what the status page and the daily job read |

Which questions are raised: every AMBIGUOUS scoring play, every play whose
three possession votes disagree (even when the class was decided by a blocked
kick), every over-credit "may be explained by ambiguous play(s) …" (attached to
that play's question), and every other finding with confidence `needs-ruling`
(a `finding_review` question: CONFIRMED / NOT_AN_ERROR). Games still in
progress raise none — Tank01 and ESPN lag each other and the play settles when
the game is Final.

## Defensive scores: three votes + score reconciliation

Defensive touchdowns and safeties are what matters most, so every one of them
is decided by three independent signals and cross-checked against the final
score.

**The determining question** (`docs/SCORING_SYSTEM.md`): did the ball change
possession on the play, or was the kick blocked? Takeaway / blocked-kick TDs →
Team Defense (8); same-possession TDs → the individual who scored.

**Three votes** on possession, per touchdown:

| vote | source | says `takeaway` when | says `same` when |
|---|---|---|---|
| `drive` | ESPN drive play | `isTurnover` is true | the drive belongs to the scoring team and `isTurnover` is false (a punt return on the punting team's drive: no opinion) |
| `gamebook` | NFL gamebook prose in the ESPN drive play text | `INTERCEPTED by …`, or upper-case `RECOVERED by HST-T.Togiai` (the GSIS convention for a change of possession) with the recovering team = the scoring team | lower-case `recovered by HST-W.Marks` (the offense kept the ball); gamebook team codes ARZ/BLT/CLV/HST/LA… are mapped to the league's codes |
| `text` | the scoring-play texts (Tank01 + ESPN) | "Interception Return", "Recovered Kickoff", muffed kick | "pass from", "Yd Rush/Run"; `return` for a kickoff/punt return (same possession); `blocked` for a blocked kick (not a possession vote — the block decides) |

The award class is definite only when the non-null votes agree. A
disagreement, or no vote at all on a fumble/recovery play, makes the play
`AMBIGUOUS` and raises a question. ESPN's `type.text` ("Fumble Return
Touchdown" for an offensive aborted-snap recovery) is advisory and never votes.
Examples that decide themselves: Togiai (drive + gamebook `takeaway` →
DEF_8_FUMBLE, laterals earlier in the prose notwithstanding), Marks (drive +
gamebook `same` → OFF_RECOVERY), Owens / Davis / Kneeland (blocked →
DEF_8_BLOCKED), Holani's kickoff recovery (text `takeaway` → DEF_8_FUMBLE),
Wright (all three `takeaway` → DEF_8_INT).

**Score reconciliation** (`B9`): for every Final game the scoring plays of
each source separately must reproduce the final score — TD 6 + the try
("(X Kick)" +1 unless failed/blocked/missed, "for Two-Point Conversion" +2,
otherwise 0), FG 3, safety 2; when a source's running score after a play is
plausible for the play kind it wins over the try text (both sources drop the
"(Kick)" now and then). A missing final FG in a cached boxscore shows as
"Tank01 plays sum to 21–21 but the final is 24–21"; a phantom safety shows as
"DEF_SEA is credited with safeties=1 but neither source lists a safety". Each
`games/game-<id>.md` prints the check; `manifest.scoreCheck` summarizes it.

**`defensiveScores`** (checks.json, manifest, latest.json, report, status
page): every play whose award class is DEF_8_* / SAFETY_2, or is AMBIGUOUS with
takeaway/block/safety wording — with its votes, whether they agree, who the DB
credits for it, whether the DB agrees, and its question id (and the decision,
once one exists).

### Award classes

| answer | award class | who is credited |
|---|---|---|
| takeaway (INT / opponent's fumble / muffed punt recovered by the kicking team) returned for TD | `DEF_8_INT` / `DEF_8_FUMBLE` | `DEF_<team>.def_int_return_tds` / `def_fumble_return_tds` +1 (8 pts) |
| blocked punt/FG/XP returned or recovered for TD | `DEF_8_BLOCKED` | `DEF_<team>.def_blocked_return_tds` +1 — never 20 |
| kickoff / punt returned for TD, no block, no turnover | `RETURN_20_KICK` / `RETURN_20_PUNT` | returner `kick_return_tds` / `punt_return_tds` +1 (20 pts); returner not a draftable position ⇒ credited to nobody |
| same possession: pass | `OFF_PASS` | passer `passing_tds` +1, receiver `receiving_tds` +1 |
| same possession: rush | `OFF_RUSH` | rusher `rushing_tds` +1 |
| same possession: own or teammate's fumble recovered in/into the end zone, aborted snap recovered | `OFF_RECOVERY` | recoverer `rushing_tds` +1 (8 pts); DEF gets 0 |
| safety | `SAFETY_2` | `DEF_<team>.safeties` +1 |
| nullified by penalty / not a scoring play | `NOT_A_SCORE` | nobody |

(`AMBIGUOUS` and `NOT_TD` are script-side classes: a question, and FG/XP
covered by the kicker check.)

## Bug-class checklist

One named check per historical bug class (`scripts/lib/doublecheckChecks.js`):
S1 player stats vs ESPN · S2 matchup totals vs ESPN truth · A1 matchup totals
== lineup sums (and standings) · A2 lineup selection · A3 rubric recompute ·
T1 offensive TD / 2-pt credit · B1 fumble-recovery attribution · B2 blocked
kicks never 20 · B3 return TDs credited · B4 ambiguous plays / vote
disagreements · B5 DST points/yards allowed · B6 defensive bonuses · B7 DST
rows present · B8 scoring plays parsed · **B9 score reconciliation** · C1 id
integrity · C2 stats in the right game · C3 nfl_players freshness · **D1 raw
team codes** (a live `WSH` row fails here — the writer is the bug) · D2 DST
composition / duplicates · E1 12×19 · E2 roster_position enum · E3 IR rules ·
E4 closed weeks unchanged · F1 schedule shape · F3/F4 standings · G1–G4 game
status handling · I2 duplicates / legacy columns · I3 freshness · NV signals
that never vary.

Findings that match `server/config/knownScoringErrors.json` (errors
deliberately kept in blessed seasons; see `docs/DEFENSIVE_SCORING.md` §7) are
reported as INFO "KNOWN". Severity: FAIL = the record is wrong (a rostered
player or DST is affected); WARN = probably wrong, needs a look, or affects
nobody rostered; INFO = note; DEFER = not decidable yet (game not final, ESPN
missing, standings not written) ⇒ INCOMPLETE.

## Re-running

| situation | do |
|---|---|
| re-audit a week now | `node scripts/doublecheck-data.js <season> <week> --refresh && node scripts/doublecheck-finalize.js <season> <week>` (or `node scripts/doublecheck-daily.js --force [--week N]`) |
| ask Claude about the open questions (again) | `node scripts/doublecheck-reconcile.js <season> <week>` — `--redo` re-asks the already-resolved ones; `--dry-run` shows the prompts |
| rule on a question | `/admin/status` → "Needs a ruling" (or `POST /api/admin/doublecheck/ruling {questionId, awardClass, note}`); finalize re-runs by itself. To undo, delete the entry from `logs/doublecheck/rulings.json` and re-run finalize |
| after the manual weekly update (standings now present) | `node scripts/doublecheck-data.js <season> <week> --rerun-standings && node scripts/doublecheck-finalize.js <season> <week> --trigger standings-rerun` |
| ESPN was down / a game went final since | `--refresh` without `--offline` |
| calibration (the pre-correction backup must reproduce the documented 2025 corrections; the live record must read clean) | `npm run doublecheck:calibrate` (`tests/integration/doublecheckCalibration.test.js`, opt-in with `DOUBLECHECK_CALIBRATION=1`; needs the ESPN cache for the calibration weeks) |

Tests: `tests/unit/tdDossier.test.js` (fixtures under
`tests/fixtures/doublecheck/td/`: votes, gamebook parsing, score
reconciliation, defensive scores), `doublecheckReconcile.test.js` (prompt,
validator, the loop with a fake `claude`), `doublecheckFinalize.test.js`
(rulings > resolutions), `doublecheckRubric.test.js`, `doublecheckLineup.test.js`,
`doublecheckTripwire.test.js`; slow: `doublecheckRubricAgreement` (the rubric
agrees with the 2024/2025 record row for row) and the calibration.

Reminder for every fix: change the logic, run the season's recalc, re-run the
Double Check. Never edit the database.


### Replaying past seasons through Qwen (`scripts/qwen-replay.js`)

`node scripts/qwen-replay.js --season 2025` asks the local Qwen the exact
question the live review asks, for every touchdown / safety of the weeks whose
ESPN summaries are cached under `logs/doublecheck/espn/<season>/`, and writes
`logs/qwen-replay/<season>/report.md`: agreement with the calibrated script per
award class (the false-dispute rate), whether Qwen picks the proven-correct
award on the plays in `knownScoringErrors.json`, its answer on every AMBIGUOUS
play, latency and rejected answers. Read-only and resumable. After a prompt or
rule-text change, rerun the hard classes with a control sample under a tag and
compare: `--tag v2 --classes AMBIGUOUS,DEF_8_FUMBLE,DEF_8_INT,DEF_8_BLOCKED,RETURN_20_KICK,RETURN_20_PUNT,SAFETY_2,OFF_RECOVERY --sample 15`.
First run (2026-09-14, 798 plays of 2025): 0 disputes on 797 decided plays,
all three catchable registry errors caught, one miss on the week-2 kickoff
recovery fixed by clarifying the kick-recovery rule text (not by a special case).

## Repair path

A confirmed finding is fixed in code, never in the database: fix the parser /
extractor / scorer (with a test), then `node scripts/recalc-week.js <season>
<week>` (one week, from cache; `--standings` if that week's standings were
already written), then `node scripts/doublecheck-daily.js --force --week
<week>` to verify. Blessed seasons (2024/2025) are not recalculated for a
2026 rule fix; their accepted errors live in server/config/knownScoringErrors.json.

## Live play review (during games)

`scripts/live-review.js` runs every 5 minutes but only while a game is in the
live window (or went Final < 90 min ago). It builds the same touchdown dossier
as the daily run for those games (Tank01 boxscore from cache + ESPN partial
summary) and asks the local Qwen (`QWEN_BASE_URL`) for an independent vote on
every defensive TD and safety, using the same evidence bundle and rule text as
the Opus reconciler. Result per play, on `/admin/status`:

| status | meaning |
|---|---|
| `confirmed` | Qwen, the deterministic class and the database agree |
| `under review` | Qwen disagrees with the deterministic class, or the class is AMBIGUOUS — written to the week's `questions.json` with `hints.qwen`; the 06:00 run asks Opus, who sees Qwen's vote as one more opinion |
| `miscredit suspected` | the agreed class is not what the database credited — the daily Double Check confirms it as FAIL once the game is Final |

Files: `logs/live-review/latest.json` (reviews), `state.json` (plays already
voted), `diagnosis.json` (watchdog escalation diagnosis). Qwen unreachable is
informational only.

