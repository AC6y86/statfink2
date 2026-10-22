---
argument-hint: [season] [week-number] [--auto]
description: Generate the week's persona-style recaps (one per reviewed theme, or 10 self-picked styles)
---

Generate 10 creative and varied weekly fantasy football recaps for season $1, week $2.

If `$3` is `--auto`, run non-interactively (this is how the /admin Recaps
Generate button invokes the command via `scripts/weekly-recap-run.js`): never pause for approval, and
never ask questions — the deviations are marked in Steps 1, 3, and 5 below.

## Step 1: Generate the data digest (gate)

```bash
mkdir -p recaps/$1/data
node scripts/recap-data.js $1 $2
```

- If the script refuses (validation not PASS/WARN for this week, or roster
  invariant violated), show me its exact message and STOP. Only re-run with
  `--force` if I explicitly accept generating from unvalidated data (normal
  for re-recapping older, already-blessed weeks). In `--auto` mode a refusal
  is always terminal: report it verbatim and STOP — never self-apply `--force`.
- Compute the zero-padded week once: `WEEK` = week number padded to 2 digits
  (e.g. 3 → 03). All paths below use it.
- The digest lands at `recaps/$1/data/week{WEEK}-digest.md`. Read it — you
  need its contents for Steps 2 and 3.

## Step 2: Update the season storylines file

Read `recaps/$1/storylines.md` (if it doesn't exist, start from the template
below). Using the digest you just read, update it: refresh the synopsis and
arcs with this week's developments, prune arcs tagged resolved, add at most
1-2 new arcs if the week genuinely started one. **Hard budget: 800 words.**
Standing commissioner rule (Joe, 2026-10-15): preseason/draft grades (letter
grades, draft-recap rankings, "the A-grade team", "the C+ unbeatens") are no
longer relevant — do not add them, and if the file still contains any, remove
them rather than carrying them forward.
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

## Step 3: The styles ("themes")

First look for the commissioner's theme list for this week:
`recaps/$1/data/week{WEEK}-themes.json` (written by `scripts/recap-setup.js`
once the week's games are final and edited on /admin Recaps). If it exists,
its `themes` array IS the list: one recap per entry, using each entry's `name`
as the style and its `slug` verbatim as the file slug. Do not add, drop, or
rename any of them, and do not wait for approval (the list was already
reviewed in the GUI) — go straight to Step 4. "10" below means "one per theme".

Only when there is no themes file: run `node scripts/recap-styles-used.js $1`
— it prints every style slug already used this season. That output is the
exclusion list (it resets each season: prior seasons' styles are fair game
again). Pick 10 diverse, entertaining styles that do NOT repeat or nearly
duplicate anything on it (near-duplicates count: e.g. `walken` vs
`christopher-walken`, or `wwe` vs `wwe-announcer` — a style is a repeat if a
league owner would say "we've done this one already this year"). **Each style
is a particular named person** (Joe's stated preference, 2026-09-15): a real
celebrity, comedian, broadcaster, actor, author or historical figure, or a
specific well-known fictional character — not a broad theme, format or genre
(no "courtroom drama", "film noir", "cooking show"). Vary the mix and favour
people with an unmistakable voice. Example picks: Christopher Walken, Jim
Gaffigan, Howard Cosell, Morgan Freeman, David Attenborough, Nate Bargatze,
Ron Swanson, Gordon Ramsay, Bob Ross, Samuel L. Jackson, Dolly Parton.

Display the 10 styles as a numbered list and ask me if I'd like to change any
before generating. **Wait for my approval or edits.** In `--auto` mode, list
the 10 chosen styles but do NOT wait — proceed straight to Step 4.

## Step 4: Generate all recaps in parallel

Once approved (or straight from the themes file), spawn one
`weekly-standings-narrator` agent per style in parallel (a SINGLE message with
all the Task calls). Each agent's prompt must contain exactly:

- Season $1, week $2, and its one style (plus the style slug: lowercase,
  hyphens)
- The absolute path to the digest: `recaps/$1/data/week{WEEK}-digest.md`
- The absolute path to the storylines file: `recaps/$1/storylines.md`
- The output path: `recaps/$1/$1-week{WEEK}-{style-slug}-style.md`
- This contract, verbatim: "The digest is your ONLY source of scores, records,
  standings, and player stats. Copy numbers verbatim. Do not query the
  database or invent statistics."
- This standing rule, verbatim: "Standing commissioner rule (Joe,
  2026-10-15): never mention, compare against or otherwise use
  preseason/draft grades (letter grades, draft-recap rankings, "the A-grade
  team", "the C+ unbeatens") - they are no longer relevant. If the storylines
  file still contains draft grades, ignore that material entirely and do not
  carry it forward."

## Step 5: Fact-check pass

After all agents finish, spawn ONE `recap-fact-checker` agent with the
digest path, the storylines snapshot path
(`recaps/$1/data/week{WEEK}-storylines.md`), every recap path, and the
report output path `recaps/$1/data/week{WEEK}-factcheck.md`. Also give it
the standing no-draft-grades rule from Step 4 verbatim, and tell it that any
draft-grade mention in a recap is recorded as its own Critical row (Claim =
"Standing rule: no draft grades", Recap says = the offending passage quoted)
and makes that recap a FAIL. Read its report:

- If every recap is PASS: continue.
- If any recap FAILs: show me the discrepancy table for the failing recaps and
  offer to regenerate just those styles (re-spawn those narrators with the
  same prompt plus "Your previous attempt contained these factual errors,
  which you must not repeat: ..."). In `--auto` mode, do the regeneration
  immediately (once, without asking), then re-run the fact-checker on just the
  regenerated recaps so the report at `recaps/$1/data/week{WEEK}-factcheck.md`
  reflects the final files; if a recap still FAILs after one regeneration,
  leave it FAILed and note it in the summary.

## Step 6: Bookkeeping and summary

- Regenerate `recaps/$1/styles-ledger.md` and `recaps/$1/INDEX.md` from the
  filenames now present in `recaps/$1/` (both files are always derivable from
  filenames — self-healing).
- Summarize: the recap files, the fact-check verdict, and the updated
  storylines path.
