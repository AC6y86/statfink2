---
argument-hint: [season] [week-number]
description: Generate 10 creative weekly recap styles for fantasy football
---

Generate 10 creative and varied weekly fantasy football recaps for season $1, week $2.

## Step 1: Generate the data digest (gate)

```bash
mkdir -p recaps/$1/data
node scripts/recap-data.js $1 $2
```

- If the script refuses (validation not PASS/WARN for this week, or roster
  invariant violated), show me its exact message and STOP. Only re-run with
  `--force` if I explicitly accept generating from unvalidated data (normal
  for re-recapping older, already-blessed weeks).
- Compute the zero-padded week once: `WEEK` = week number padded to 2 digits
  (e.g. 3 → 03). All paths below use it.
- The digest lands at `recaps/$1/data/week{WEEK}-digest.md`. Read it — you
  need its contents for Steps 2 and 3.

## Step 2: Update the season storylines file

Read `recaps/$1/storylines.md` (if it doesn't exist, start from the template
below). Using the digest you just read, update it: refresh the synopsis and
arcs with this week's developments, prune arcs tagged resolved, add at most
1-2 new arcs if the week genuinely started one. **Hard budget: 800 words.**
Then:

- Write the updated file to `recaps/$1/storylines.md`
- Copy it to `recaps/$1/data/week{WEEK}-storylines.md` (the historical snapshot)

Template sections:
- **Season So Far** — 3-5 sentence synopsis
- **Active Arcs** — max 8 named arcs, 1-2 sentences each, tagged (rising),
  (steady), or (resolved); prune resolved arcs next week
- **Rivalries & Revenge Games** — prior-meeting results relevant to recent or
  upcoming matchups
- **Last Week's Headlines** — 3-5 callback-worthy bullets
- **Next Week Watch** — stakes of upcoming matchups

## Step 3: Pick 10 creative styles (avoiding repeats)

Read `recaps/$1/styles-ledger.md` (if missing, derive it from the filenames in
`recaps/$1/`). Pick 10 diverse, entertaining styles that do NOT repeat or
nearly duplicate anything in the ledger. Example flavors (pick varied ones):
Las Vegas boxing announcer, Morgan Freeman narration, Howard Cosell, film noir
detective, David Attenborough, WWE announcer, 1920s radio, Tarantino dialogue,
robot from the future, pirate captain, gospel preacher, British royal
correspondent, Agatha Christie, courtroom drama, cooking competition.

Display the 10 styles as a numbered list and ask me if I'd like to change any
before generating. **Wait for my approval or edits.**

## Step 4: Generate all recaps in parallel

Once approved, spawn 10 `weekly-standings-narrator` agents in parallel (a
SINGLE message with 10 Task calls). Each agent's prompt must contain exactly:

- Season $1, week $2, and its one style (plus the style slug: lowercase,
  hyphens)
- The absolute path to the digest: `recaps/$1/data/week{WEEK}-digest.md`
- The absolute path to the storylines file: `recaps/$1/storylines.md`
- The output path: `recaps/$1/$1-week{WEEK}-{style-slug}-style.md`
- This contract, verbatim: "The digest is your ONLY source of scores, records,
  standings, and player stats. Copy numbers verbatim. Do not query the
  database or invent statistics."

## Step 5: Fact-check pass

After all 10 agents finish, spawn ONE `recap-fact-checker` agent with the
digest path, the storylines snapshot path
(`recaps/$1/data/week{WEEK}-storylines.md`), the 10 recap paths, and the
report output path `recaps/$1/data/week{WEEK}-factcheck.md`. Read its report:

- If every recap is PASS: continue.
- If any recap FAILs: show me the discrepancy table for the failing recaps and
  offer to regenerate just those styles (re-spawn those narrators with the
  same prompt plus "Your previous attempt contained these factual errors,
  which you must not repeat: ...").

## Step 6: Bookkeeping and summary

- Regenerate `recaps/$1/styles-ledger.md` and `recaps/$1/INDEX.md` from the
  filenames now present in `recaps/$1/` (both files are always derivable from
  filenames — self-healing).
- Summarize: the 10 recap files, the fact-check verdict, and the updated
  storylines path.
