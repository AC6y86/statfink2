---
argument-hint: [season] [week-number]
description: Generate 10 creative weekly recap styles for fantasy football
---

Generate 10 creative and varied weekly fantasy football recaps for season $1, week $2.

## Step 1: Pick 10 Creative Styles
First, pick 10 diverse, entertaining recap styles. Examples include (but pick varied ones):
- Las Vegas boxing announcer
- Morgan Freeman narration
- ESPN SportsCenter anchor
- Howard Cosell sports commentary
- Joe Rogan podcast host
- Shakespearean drama
- Film noir detective
- David Attenborough nature documentary
- WWE wrestling announcer
- 1920s radio broadcaster
- Tarantino movie dialogue
- Robot from the future
- Pirate captain
- Southern gospel preacher
- British royal correspondent

Make sure to pick 10 DIFFERENT and creative styles that would be entertaining and distinct from each other.

## Step 2: Show Styles and Get Approval
Display the 10 styles you've chosen as a numbered list and ask me if I'd like to change any of them before generating the recaps. Wait for my approval or requested changes.

## Step 3: Generate All Recaps in Parallel
Once approved, spawn 10 `weekly-standings-narrator` agents in parallel (use a SINGLE message with 10 Task tool calls).

For each agent:
- Specify the season ($1) and week ($2)
- Specify the specific style for that agent
- Have the agent save its output to: `recaps/$1-week$2-{style-slug}-style.md` where {style-slug} is a URL-friendly version of the style name (lowercase, hyphens instead of spaces)

Ensure the `recaps/` directory exists before spawning the agents.
