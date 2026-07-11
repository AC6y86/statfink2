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
| Admin endpoints | `server/routes/admin.js` (`/api/admin/pending-moves`) | List (`GET ?status=`), approve (`POST /:id/approve`), reject (`POST /:id/reject`). |
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

## Setup

### 1. Owner mapping — `roster_moves/owners.json` (gitignored)

Maps sender email → fantasy team. Copy `roster_moves/owners.json.example` and fill
in real addresses:

```json
{
  "joe.paley@gmail.com": { "teamId": 5, "ownerName": "Joe" }
}
```

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
| Approval shows `failed` | Execution threw (e.g. roster changed since the email — player already dropped, IR minimum not met). The error message is stored on the item. |
| Parse takes minutes / times out | Headless Claude call; 120s timeout per attempt, up to 2 attempts. Check `claude` is installed and logged in on the server. |
| Same email parsed twice | Shouldn't happen — server dedups by Gmail message ID. The poller intentionally re-sends on partial failure; the server ignores duplicates. |

## Tests

### Automated (part of `npm test` — no DB writes, no network, no real Claude)

- `tests/unit/emailMoveParsingService.test.js` — prompt assembly, schema
  validation + retry, unknown sender, banter, hallucinated-ID detection,
  markdown-fence tolerance, nickname matching.
- `tests/unit/pendingMovesService.test.js` — enqueue/dry-run routing, dedup,
  approve/reject/fail transitions, multi-move emails.
- `tests/unit/validateRosterMove.test.js` — supplemental/IR-return/trade rules,
  3-week IR minimum.
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
