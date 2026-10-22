# Email-Driven Roster Moves

Owners email roster moves to the commissioner's Gmail in plain English. The system
reads the inbox, uses AI to extract a structured move, validates it against league
rules, and queues it for one-click commissioner approval on the roster page.
**Nothing ever executes without commissioner approval.**

## Architecture

```
Gmail inbox
    │  (every 2 min, read-only OAuth)
    ▼
scripts/roster-email-poller.js ──── PM2 process: statfink2-email-poller
    │  POST /api/internal/roster-email
    ▼
server/routes/internal.js ─── dedup check (already processed?)
    │
    ▼
server/services/emailMoveParsingService.js ─── headless Claude parse + cross-validation
    │
    ▼
server/services/pendingMovesService.js ─── dry-run validation, queue as pending / needs_review
    │  stored in roster_moves/pending_moves.json (JSON file, no DB table)
    ▼
helm/dashboard.html "Pending Email Moves" section ─── commissioner approves / rejects
    │  POST /api/admin/pending-moves/:id/approve
    ▼
db.executeRosterMove() / db.executeTrade() ─── re-validates, then executes
```

## Components

| Piece | File | What it does |
|-------|------|--------------|
| Poller | `scripts/roster-email-poller.js` | Polls Gmail every 2 min, strips quoted/forwarded thread content, POSTs each email to the server. Dumb by design — the server owns parsing and dedup, so re-sending an email is always harmless. |
| Parser | `server/services/emailMoveParsingService.js` | Resolves sender → team via `owners.json`, builds a prompt with the sender's roster/IR/full player list, runs headless Claude (`claude -p`), validates the JSON schema (one retry), then cross-validates every player ID against the DB. |
| Queue | `server/services/pendingMovesService.js` | One queue item per proposed move, persisted in `roster_moves/pending_moves.json`. Runs a read-only dry-run (`db.validateRosterMove`) at enqueue and routes to `pending` or `needs_review`. |
| Ingest endpoint | `server/routes/internal.js` (`POST /api/internal/roster-email`) | Localhost-only, requires `X-Internal-Token`. Dedup → parse → enqueue. |
| Admin endpoints | `server/routes/admin.js` (`/api/admin/pending-moves`) | List (`GET ?status=`), approve / retry (`POST /:id/approve`), commissioner override (`POST /:id/override`, body `{ reason }` required), recheck (`POST /:id/recheck`), reject / dismiss (`POST /:id/reject`). |
| UI | `helm/dashboard.html` pending-moves section (Rosters tab) | Shows email, parse summary, questions for the commissioner, validation results; approve/reject buttons; refreshes every 60s. |
| PM2 | `ecosystem.config.js` (`statfink2-email-poller`) | Keeps the poller running. `pm2 start ecosystem.config.js --only statfink2-email-poller` |

## Move types

Every move is a paired drop+add that keeps the active roster at exactly 19:

- **`ir`** (**the default**) — dropped player goes to the team's IR; a free agent
  fills the active spot. A plain "drop X, add Y" email is an IR move — owners
  don't usually say "IR" explicitly.
- **`supplemental`** — dropped player leaves the team entirely; a free agent is
  added. Only when the email explicitly signals it: "supplemental" in the
  subject/body, or a supplemental-draft thread.
- **`ir_return`** — added player comes back from the team's own IR (**must have been
  on IR for 3+ weeks**); the dropped player leaves entirely. Requires explicit
  return-from-IR language.
- **`trade`** — player-for-player between two teams (rare). No dry-run at enqueue;
  validated by `executeTrade()` at approval time.

If the parser misclassifies the type, the commissioner can correct it at
approval time: the pending-move card has an "as [type]" dropdown next to
Approve, and the original type is recorded on the item
(`move.original_move_type`). Trades cannot be converted to/from other types.

## Validation rules that depend on time

The **drop lock**: a player cannot be dropped, placed on IR, or traded away once his
NFL team's game for the current week has kicked off (`nfl_games.game_time_epoch`).
It is judged at the moment the owner asked - the email's `Date:` header - not when
the commissioner approves, so a move mailed Sunday at noon is still good on Monday.
Manual moves from the admin form are judged at execution time unless the request
carries `requestedAt`. Bye weeks and players with no schedule row are never locked.
`db.checkDropLock` is the single implementation; `validateRosterMove`, `executeRosterMove`
and `executeTrade` all take `{ asOf }`.

The **week** those rules are judged in is also the week the owner asked
(`db.weekInEffectAt`: the earliest week whose last game had not ended at `asOf`,
never later than the roster week the move executes on). A move mailed in Week 5
and approved in Week 6 is judged against Week 5's kickoffs and Week 5's injury
report, exactly as its enqueue dry-run was; the item's `validation.asOf` is what
approval re-uses. Without `asOf` the roster week applies (execution-time behaviour).

## IR eligibility: the NFL.com gate

An ordinary `ir` move is allowed only when fresh NFL.com data, fetched at
validation time for the week the owner asked, shows the dropped player is actually hurt
(`server/services/nflRosterEligibilityService.js`, applied by
`db.validateRosterMove` for both email approval and manual execution). Two
routes establish eligibility; everything else is refused:

1. **Weekly injury report** — `nfl.com/injuries/league/<season>/reg<week>`
   lists the player for his team with Game Status exactly `Out`.
2. **NFL Reserve/Injured** — the team roster page shows a Reserve/Injured
   Status code **and** the NFL.com reserve-list transactions pages carry an
   official `Reserve/Injured` transaction for that player and team in the
   season window (July onward). Both are required; the roster code alone is
   never enough. Players already on NFL IR are **not** on the weekly injury
   report, so this is the normal route for them.

Roster Status codes, as NFL.com prints them (classified in `ROSTER_STATUS`):

| Code | Meaning | Gate |
|------|---------|------|
| `RES` | Reserve/Injured | eligible with a Reserve/Injured transaction |
| `RSR` | Reserve/Injured; Designated for Return (the cutdown-day return designation; e.g. James Conner, ARI, 08/30/2026) | eligible with a Reserve/Injured transaction |
| `PUP` | Reserve/Physically Unable to Perform | refused (not Reserve/Injured) |
| `RSN` / `NON` | Reserve/Non-Football Injury or Illness | refused |
| `EXE` | Exempt/Commissioner Permission | refused |
| `SUS`, `RET`, `ACT`, `DEV`, `UDF`, `TRC`, `TRD`, `CUT`, `RLS` | suspended, retired, active, practice squad, transactional | refused |
| anything else / blank | unknown to the validator | **NFL_UNAVAILABLE** (review, not a verdict) |

Refusals come in two codes, both of which block the move: `NFL_INELIGIBLE`
is a definitive "NFL.com says he is not Out / not on Reserve/Injured" with the
observed statuses in the message; `NFL_UNAVAILABLE` means the check could not
be completed (fetch/parsing failure, page identity mismatch, ambiguous name
match, a Status code the validator does not recognise). Recheck from Admin →
Moves ("Recheck NFL.com") or replay with
`node scripts/check-nfl-eligibility.js --name "James Conner" --team ARI --season 2026 --week 4`
(read-only; exit 0 eligible, 2 ineligible, 3 unavailable). Tank01's
`nfl_players.injury_designation` is never consulted by the gate.

### Delayed approval: the enqueue-time evidence fallback (email items only)

NFL.com does not reliably keep a past week's injury report at its own URL: once
Week 6 is current, `/injuries/league/2026/reg5` can come back as the Week 6 page,
which the page-identity check correctly reports as `NFL_UNAVAILABLE`. A move
mailed in Week 5 and approved in Week 6 would then fail closed even though the
intake dry-run, run seconds after the email arrived, saw the player `Out` on the
real Week 5 report. That intake verdict is the evidence of record for such items.

- **Preserved at intake.** When an ordinary `ir` move passes its enqueue dry-run
  with positive NFL.com evidence, an immutable copy is stored on the item as
  `enqueueEvidence` (`asOf`, `checkedAt`, `dropPlayerId`, `teamId`, the full
  `nflEligibility` verdict). It lives beside `validation`, never inside it:
  "Recheck NFL.com" replaces `validation` and never touches `enqueueEvidence`.
- **Offered only by email approval.** `approveItem` passes `enqueueEvidence` to
  `executeRosterMove` for `ir` moves. The admin form never does, so a manual
  move never gets the fallback (it has no intake verdict to fall back on).
- **Accepted only on an incomplete fresh check.** `validateRosterMove` still
  fetches NFL.com fresh at approval. The fallback
  (`DatabaseManager.acceptEnqueueEvidence`) is consulted only when that fetch
  ends `NFL_UNAVAILABLE`. A definitive `NFL_INELIGIBLE` ("he is Active") is
  NFL.com's answer and is never overridden by older evidence.
- **Every identity must match, else refused.** The enqueue verdict must be
  `eligible:true` with an `OUT_ON_INJURY_REPORT` / `RESERVE_INJURED` code, for the
  same season, the same judged week (`db.weekInEffectAt` of the request's
  `asOf`), the same player (name and NFL team, plus `dropPlayerId` when
  recorded), and the request's `asOf` must equal the evidence's `asOf` exactly.
  Any mismatch keeps the `NFL_UNAVAILABLE` refusal; the reason the fallback was
  declined is recorded on the evidence as `enqueueEvidenceRejected`.
- **Audit trail.** An accepted fallback keeps the original verdict and code,
  adds `basis: "enqueue"`, `enqueueCheckedAt` and the `freshCheck` it stood in
  for, and the item records `executionResult.evidenceBasis` (`enqueue`, or
  `enqueue_legacy` below). The Moves page shows "Approved on enqueue-time
  NFL.com evidence" on such items.
- **Legacy items** queued before `enqueueEvidence` existed: their `validation`
  *is* the intake dry-run as long as it has never been rechecked (no
  `recheckCount`), so approval may use it as legacy evidence under the same
  checks. The first recheck of such an item copies that original into
  `enqueueEvidence` (marked `legacy: true`) before overwriting `validation`. An
  item already rechecked without the field has lost its original verdict and
  gets no fallback.

## Parsing safety

The parser is built to never guess:

- **Schema-enforced output** — Claude must return a JSON object matching
  `ROSTER_MOVE_SCHEMA`. Malformed output gets one retry with a reminder; if both
  attempts fail, the email surfaces as `ambiguous` for manual handling.
- **Verbatim quotes** — every drop/add includes the exact phrase from the email it
  was inferred from (`drop_quote` / `add_quote`), shown to the commissioner.
- **Cross-validation** — every player ID Claude returns is checked against
  `nfl_players`; a missing ID, a name that doesn't plausibly match the ID, or a
  team_id that isn't the sender's demotes the move to low confidence.
- **Banter/hypothetical detection** — "great pickup!" or "I'm thinking about
  dropping X" is `not_a_roster_move` and is silently recorded as processed.
- **Routing** — an item goes to `needs_review` (no one-click approve) if the parse
  wasn't clean, confidence is low, or the dry-run validation failed. Ambiguous
  emails with no extractable move still surface one `needs_review` item with the
  parser's questions for the commissioner.
- **Approve-time re-validation** — approval re-runs validation inside
  `executeRosterMove()`, since rosters may have changed since the email arrived.

Item statuses: `pending` → `approved` / `rejected`, or `needs_review` (manual),
or `failed` (approval attempted but execution threw).

- **Failed executions stay open.** A `failed` item is not resolved: it stays on
  the Moves list (and in `pendingCount`) with the execution error, when it was
  attempted and by whom, until the commissioner retries it (Approve again -
  goes through the validator exactly like a first attempt), rechecks it
  (re-routed on the fresh verdict), overrides it, or rejects it (dismiss; the
  failure is kept as `executionResult.lastFailure`). Every attempt is appended
  to `executionAttempts` (`mode`: approve / retry / override).
- **Commissioner override.** A move the validator refuses (failed dry-run or
  failed execution) shows an "Override validation…" button. It is its own
  endpoint (`POST /:id/override`), requires a written reason, applies only to
  the selected item and is refused for a move the validator accepts. Execution
  passes `overrideValidation` to `executeRosterMove` / `executeTrade`, which
  carry the move out and report exactly which checks were set aside; the item
  records `override { reason, by, at, overriddenErrors }` and the roster_moves
  row gets a `notes` line. Never overridable: a player that does not exist, and
  the 19-active roster invariant inside the transaction (the move rolls back).

## Setup

### 1. Owner mapping — `roster_moves/owners.json` (gitignored)

Maps sender email → fantasy team. Copy `roster_moves/owners.json.example` and fill
in real addresses:

```json
{
  "joe.paley@gmail.com": { "teamId": 5, "ownerName": "Joe" },
  "aaron@example.com": { "teamId": 6, "ownerName": "Aaron", "actsFor": [11] }
}
```

Optional `actsFor` lists other team_ids the sender is authorized to submit
moves for (e.g. Aaron sends Eli's moves). The parser then includes each
delegated team's roster and IR in the prompt, tells Claude to use that team_id
only when the email clearly names that owner, and cross-validation accepts it.
A move for any team not in `teamId`/`actsFor` is still demoted to low
confidence (needs review).

Emails from addresses not in this file are **silently ignored** (recorded as
processed with reason `unknown_sender`). All 12 owners must be listed for the
system to serve the whole league.

### 2. Gmail OAuth — `roster_moves/credentials.json` + `token.json` (gitignored)

- `credentials.json`: OAuth2 client from Google Cloud Console (scope: `gmail.readonly`).
- `token.json`: generated by the interactive setup script:

```bash
node roster_moves/authSetup.js
```

The poller never prompts. If the token expires it raises a **critical health
alert** telling you to re-run `authSetup.js`, and keeps retrying harmlessly.

### 3. Headless Claude

The parser spawns `claude -p` (Claude Code CLI) under the commissioner's
subscription — no API key or metered spend. The `claude` binary must be on the
PATH of the server process and logged in.

### 4. Start the poller

```bash
pm2 start ecosystem.config.js --only statfink2-email-poller
pm2 logs statfink2-email-poller
```

## Configuration

| Env var | Default | Used by | Purpose |
|---------|---------|---------|---------|
| `STATFINK_BASE_URL` | `http://localhost:8000` | poller | Server to submit emails to |
| `ROSTER_PARSER_MODEL` | `opus` | parser | Model for `claude -p --model ...` |

Other knobs (constants in code): poll interval 2 min, parse timeout 120s, email
body capped at 5000 chars, 5 consecutive poller failures → critical alert.

## Data files (all in `roster_moves/`, gitignored)

- `pending_moves.json` — the live queue: items + a bounded list of processed
  email IDs (dedup). Safe to inspect; edit only if you know what you're doing.
  Each item's `validation` is the latest dry-run (overwritten by rechecks);
  `enqueueEvidence` is the immutable intake verdict for passing IR moves.
- `last_check.json` — poller's fetch-window cursor. Only advances when every
  submission in a cycle succeeded, so failed emails are retried next cycle.
- `credentials.json`, `token.json` — Gmail OAuth.
- `owners.json` — sender → team mapping.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Critical alert: "Gmail authentication failed" | Token expired/revoked. Run `node roster_moves/authSetup.js`, then check `pm2 logs statfink2-email-poller`. |
| Owner's email never shows up | Their address isn't in `owners.json` (check the exact From: address — matching is on the email address only, case-insensitive). Also check `processedEmails` in `pending_moves.json` for an `unknown_sender` entry. |
| Move stuck in `needs_review` | Expected for ambiguous emails, low confidence, or failed validation — read the parser's `questions_for_commissioner` and handle manually via the roster page. |
| Approval shows `failed` | Execution threw (e.g. roster changed since the email — player already dropped, IR minimum not met). The error message is stored on the item, which stays on the Moves list: retry (Approve), Recheck NFL.com, Override validation (reason required), or Reject to dismiss. |
| Parse takes minutes / times out | Headless Claude call; 120s timeout per attempt, up to 2 attempts. Check `claude` is installed and logged in on the server. |
| Same email parsed twice | Shouldn't happen — server dedups by Gmail message ID. The poller intentionally re-sends on partial failure; the server ignores duplicates. |

## Tests

### Automated (part of `npm test` — no DB writes, no network, no real Claude)

- `tests/unit/emailMoveParsingService.test.js` — prompt assembly, schema
  validation + retry, unknown sender, banter, hallucinated-ID detection,
  markdown-fence tolerance, nickname matching.
- `tests/unit/pendingMovesService.test.js` — enqueue/dry-run routing, dedup,
  approve/reject/fail transitions, multi-move emails, enqueue-evidence
  preservation across rechecks and its hand-off at approval (legacy items too).
- `tests/unit/validateRosterMove.test.js` — supplemental/IR-return/trade rules,
  3-week IR minimum, the NFL.com gate, the week-in-effect regression and the
  enqueue-evidence fallback (allowed only on `NFL_UNAVAILABLE` with matching
  season/week/player/asOf; refused on `NFL_INELIGIBLE` or any mismatch).
- `tests/unit/rosterEmailPoller.test.js` — quote/forward stripping, Gmail
  multipart body decoding, fetch-window advancement, auth/failure alert state
  machine (googleapis and axios mocked).
- `tests/integration/emailRosterMoves.test.js` — the real internal + admin
  routers via supertest: token enforcement, dedup, banter/unknown-sender
  routing, list/approve/reject, double-resolve protection. Real services, fake
  db and Claude backend, tmp queue file.
- Fixtures: `tests/fixtures/rosterMoveEmails.js` (10 sample emails).

The poller script only starts polling when run directly
(`require.main === module`), so tests import its functions without side effects.

### Live parser eval (opt-in, real Claude + real DB, read-only)

```bash
npm run test:parser-eval
```

`scripts/parser-eval.js` generates eval emails from the current real roster
(so expected player IDs are exact) and runs them through the real headless
Claude backend: supplemental, two-move, banter, hypothetical, contradiction,
and quoted-thread cases. Nothing is queued or executed. Each case is one real
`claude -p` call (~5-20s); run it whenever the prompt, schema, or model
changes. Exit code 0 = all passed.

### Manual end-to-end (the only untestable-in-code leg: Gmail itself)

1. Ensure the poller is running: `pm2 list` shows `statfink2-email-poller`.
2. Send a real roster-move email to the commissioner Gmail from a mapped owner
   address.
3. Watch `pm2 logs statfink2-email-poller` — within 2 minutes it should log
   `Queued 1 pending move(s) from ...`.
4. Open the roster page; the move appears under Pending Email Moves.
5. **Reject** it (so the test never touches real rosters) and confirm the item
   shows as rejected in `roster_moves/pending_moves.json`.

### Recovery and ordered requests

- Unknown-sender skips retain the original Gmail ID and sender. The poller
  asks the internal retryable endpoint each cycle, fetching those IDs even
  outside the normal date window once the owner mapping recognizes them.
  Legacy records without sender metadata are fetched once to learn it.
- Queued, approved, rejected, and confirmed non-move messages stay deduplicated.
  Legacy `retry-YYYYMMDD-<Gmail ID>` IDs match the original ID; do not create
  artificial IDs to force a replay.
- Compound trade-then-IR emails retain both proposals in order. The later
  proposal records `dependsOnItemId` and remains in review until the trade
  is approved. Revalidate it afterward to check current eligibility. Neither
  action executes without commissioner approval.
- Recent Gmail results are paginated; a running poll cannot overlap the next
  timer tick. Recovery lookup failures do not advance the email cursor.


### Verification notice lifecycle and move-specific rulings

Email-move alerts now store their source email ID and proposal IDs. Health alert reads project the current queue state: an email is resolved only when all its proposals are approved/rejected; a corrected request still pending approval remains informational, and failed/needs-review requests remain warnings. Original alert files remain unchanged audit history. Legacy alerts can link only by exact sender prefix, a creation timestamp within one second, and a unique email; uncertain matches remain visible. If the queue cannot be read, original alerts remain visible.

Commissioner notes are displayed inside their affected move cards, including approved/rejected cards under “Resolved moves with rulings.” Explicit links are authoritative; automatic linking requires a unique earlier proposal in the same thread whose owner and full added-player name occur in the original ruling body. Unmatched notes require an explicit move selection in Admin → Moves. POST /api/admin/pending-moves/:id/link-ruling with {moveId} attaches a note without approving, rejecting, or undoing anything. User-reported rulings retain their attribution and are never represented as direct Dan emails.
