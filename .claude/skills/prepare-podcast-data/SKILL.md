---
name: prepare-podcast-data
description: Prepare the weekly factual data briefing for PFL Live, the Peninsula Football League podcast. Use when asked to prepare podcast data, a podcast briefing, or the PFL Live fact pack for a week.
argument-hint: [season] [week]
---

# Prepare Podcast Data

You are preparing the weekly data briefing for PFL Live, a podcast covering the
Peninsula Football League. The briefing is handed to another AI system that
turns it into the podcast. Your job is to give that system enough verified
fact to find the week's stories, discuss every matchup, compare teams,
reference league history and preview next week.

The reader has no database and cannot check anything. Whatever you write, it
will repeat on air as true.

- Do NOT write podcast dialogue or imitate hosts.
- Do NOT add jokes, stylistic commentary or subjective labels ("fraud", "elite", "lucky").
- Do NOT invent facts, and do not soften a missing fact into a guess.
- Do NOT leave out something noteworthy because it seems small.
- Do NOT give fantasy advice or NFL news. The only NFL information allowed is
  what the league data holds about a rostered player (injury text, bye weeks).
- Do NOT manufacture narrative. Supply the facts a producer can build one from.

## How this league differs from a standard one

The briefing spec was written for a generic fantasy league. PFL is not one,
and the podcast system will assume the generic version unless the briefing
says otherwise. Keep these straight in everything you write:

| Generic term | In the PFL |
|---|---|
| Starters | The **scoring lineup**: 13 slots filled automatically by the highest scorers (1 QB, 4 RB, 4 WR/TE, 1 K, 1 Bonus, 2 Team Defense). |
| Bench | Active players who scored but **did not count**. Every team has 19 active players; a player is Active or on Injured Reserve, nothing else. |
| Start/sit decisions, optimal lineup, lineup efficiency | **Do not exist.** The lineup picks itself, so actual score = optimal score. Never describe an owner as having started, benched or sat a player. |
| Projections, favorites, underdogs | **No projections exist.** "Higher-ranked" and "lower-ranked" entering the week are the only substitutes. |
| Waivers, FAAB | **Do not exist.** Roster moves are IR moves, IR returns, supplemental moves and trades. |
| Standings | Two races: the site order (wins, then cumulative points) and the points race ("PFL Cup"). Say which one you mean. |
| Records in playoff weeks | W-L is frozen after week 12. |

An owner's influence on a result comes through the draft and roster moves, not
lineup choices. Report it that way.

## Step 1: Build the fact pack

```bash
node scripts/podcast-data.js $ARGUMENTS
```

With no arguments it uses the current season and the most recent **complete**
week (every NFL game final, standings written). It reads the database
read-only and writes `podcast/{season}/data/week{NN}-facts.md`.

- If it refuses because the week is not complete, tell me what it said and
  STOP. Re-run with `--allow-incomplete` only if I ask for a partial briefing.
- If it fails for any other reason, show me the error and STOP. Do not
  assemble the briefing by hand from SQL.
- Note the season and week it printed, and compute `WEEK` = the week padded to
  two digits.

## Step 2: Start the briefing from the fact pack

```bash
cp podcast/{season}/data/week{WEEK}-facts.md podcast/{season}/week{WEEK}-briefing.md
```

If a briefing for that week already exists, this replaces it; say so in your
report.

Read the whole briefing file before writing anything. Sections 1-10 and 12-13
arrive complete. Every number in them was computed by the script from the
official record.

**You never retype, round, recompute or "correct" a number the script wrote.**
If a number looks wrong, leave it as it is, finish the briefing, and tell me
which number and why in your summary. The fix belongs in
`scripts/podcast-data.js` or the scoring logic, never in the briefing and never
in the database.

## Step 3: Fill the analyst sections

The file contains `<!-- ANALYST: ... -->` markers. Replace each one using the
Edit tool, then delete the marker.

### Section 9 — extra history (optional)

The script has already listed past points titles, finishes, head-to-head
results, records, streaks, and who drafted this week's top scorers. Add
something only if `podcast/history/` holds a fact the script did not print
that bears on **this week's** results or next week's matchups. At most three
for the whole briefing.

- `draft-YYYY.json`: owner, round, player, position. Say "was drafted by",
  never "was on X's team": a board does not show who held a player all season.
- `season-YYYY.json`: final points standings and a `notes` field.
- Each fact names its source file.

To search the draft boards:

```bash
node -e 'const fs=require("fs"),d="podcast/history";for(const f of fs.readdirSync(d).filter(f=>f.startsWith("draft-")))for(const k of JSON.parse(fs.readFileSync(d+"/"+f)).picks)if(k.player.toLowerCase().includes(process.argv[1].toLowerCase()))console.log(f,"round",k.round,k.owner,k.player)' "Kelce"
```

### Section 11 — story candidates

Write 5 to 10. Each one uses this form:

```markdown
### 1. <Headline: a plain statement of fact>
- **Involved:** <owners and teams>
- **Evidence:** <the statistics, copied exactly from the briefing>
- **Why notable:** <what makes it unusual, stated as a comparison or a rank>
```

Illustration of the form only (invented league, invented numbers):

```markdown
### 1. Owner X is 4-1 while ranking 8th in points
- **Involved:** Owner X (Team X)
- **Evidence:** Record 4-1; points rank 8 of 10; all-play record 18-27; expected wins 2.0.
- **Why notable:** Largest gap between actual and expected wins in the league (+2.0).
```

Rules for the numbers:

- Every number comes from sections 2-10 or 12 of this briefing, unchanged.
  Writing a rank as an ordinal ("8" as "8th") is fine.
- Do not derive numbers of your own: no sums, differences, counts or
  averages. If a story needs a number the briefing lacks, leave the story out
  and name the missing number in your report so the script can supply it.
- "Why notable" must be checkable: a rank, a gap, a first, a record. If the
  only way to say why it matters is an adjective, it is not a story candidate.

Where to look: the extremes in sections 4 and 6, streaks and records in
section 9, the biggest movers in section 10, the closest results, trades and
IR moves in section 7 with their impact, and injuries to players who have
been carrying a team. Cover different owners; do not spend three stories on
one team.

Points that did not count are never evidence that a result could have gone
the other way. They sat outside the scoring slots by rule, and no owner chose
that.

### Section 12 — standings implications (optional)

Replace the marker at the end of section 12 with one list headed
`**Standings implications:**`, one bullet per matchup you have something for.
Include only what follows by arithmetic from section 2 ("a win moves Joe level
on wins with Dan"). No predictions, no likelihoods. Delete the marker whether
or not you add anything. Do not edit the script's own matchup blocks.

If section 12 carries a notice that the next week had already started, leave
the notice in place and write nothing that treats those games as still to come.

### Section 13 — your own notes

Replace the marker with a list headed `**Analyst notes:**`, kept separate from
the script's "Found while generating" list. Note anything you ran into: a
history file that contradicts another, a name you could not match, an
assumption you made. If you made none, delete the marker and add nothing.

## Step 4: Check your work

Both commands must print nothing:

```bash
grep -n "ANALYST" podcast/{season}/week{WEEK}-briefing.md
diff podcast/{season}/data/week{WEEK}-facts.md podcast/{season}/week{WEEK}-briefing.md | grep '^<' | grep -v 'ANALYST' | grep -v '^< *$'
```

The first finds markers you left behind. The second finds any line the script
wrote that you changed or removed; restore it from the fact pack.

Then re-read section 11 against the rest of the file: every number in a story
candidate must appear, identically, in sections 2-10 or 12. Remove any claim
you cannot point to.

## Step 5: Report

Tell me:

- The briefing path, and the season and week it covers.
- The story candidate headlines.
- Everything under "Found while generating" in section 13, in full, then your
  own analyst notes. Lines marked INCONSISTENCY or CONFLICT come first: they
  mean the league data disagrees with itself and I need to look.
- Any number you thought looked wrong, and any number a story needed that the
  briefing did not have.

## Reference

- `docs/SCORING_SYSTEM.md`, `docs/MATCHUPS.md`, `docs/ROSTER.md` — the league rules.
- `podcast/history/README.md` — what the history files cover and how to refresh them.
- The fact pack can be rebuilt for any past week: `node scripts/podcast-data.js 2025 11`.
