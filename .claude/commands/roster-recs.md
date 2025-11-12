---
argument-hint: [team] [season] [week] [player?] [position?]
description: Get 10 AI agents' roster move recommendations with consensus summary
---

You are tasked with generating comprehensive roster move recommendations by coordinating 10 independent AI agents.

## Parameters
- `$1` (required): Team name
- `$2` (required): Season (e.g., 2025)
- `$3` (required): Week number (e.g., 10)
- `$4` (optional): Player name to drop (if specified, all recommendations must drop this player)
- `$5` (optional): Position to target for adds (QB, RB, WR, TE, K, DEF)

## Step 1: Validate and Setup

First, validate that required parameters are provided:
- If `$1`, `$2`, or `$3` are missing, ask the user to provide them

Create the output directory:
```bash
mkdir -p /tmp/roster-recs-$2-week$3-$(date +%s)
```

Store the directory path for use throughout the command.

## Step 2: Determine Constraint Instructions

Based on the optional parameters, construct constraint instructions for the agents:

**If `$4` (player) is provided:**
- Constraint: "All recommendations MUST include dropping $4"

**If `$5` (position) is provided:**
- Constraint: "All player additions MUST be at the $5 position"

**If both are provided:**
- Constraint: "All recommendations MUST drop $4 and add a player at the $5 position"

**If neither is provided:**
- Constraint: "Analyze the roster and suggest the best player to drop and best position to target based on team needs"

## Step 3: Spawn 10 Roster-Moves Agents in Parallel

Launch 10 `roster-moves` agents in parallel using a SINGLE message with 10 Task tool calls.

For each agent (numbered 1-10):

**Instructions to each agent:**
```
Analyze the roster for team "$1" in season $2, week $3.

Provide exactly 3 distinct roster move recommendations.

Constraints:
{Insert the constraint instructions from Step 2}

For each recommendation, provide:
1. Player to drop (with justification)
2. Player to add (with justification)
3. FantasyPros research supporting the move
4. Expected impact on team performance
5. Risk assessment

Format your response as a structured markdown document with:
- Overview of team's current situation
- Three detailed recommendations (labeled Recommendation 1, 2, 3)
- Each recommendation should be a complete drop/add suggestion

Save your output to: {output_directory}/agent-{N}-recommendations.md

Important: Use web research (FantasyPros) to inform all recommendations. Each recommendation should be meaningfully different from the others.
```

**Key Details:**
- Use the `roster-moves` subagent_type in the Task tool
- Each agent gets a unique number (1-10) and saves to its own file
- All agents receive the same constraints but should provide diverse recommendations
- Specify output file: `{output_directory}/agent-{N}-recommendations.md`

## Step 4: Wait for Completion

After spawning all agents, inform the user:
```
Launched 10 roster analysis agents for {$1} (Season $2, Week $3).
Each agent is researching and will provide 3 roster move recommendations.
This will take a few minutes...
```

The agents will run and save their outputs to the specified directory.

## Step 5: Aggregate and Analyze Results

Once all agents have completed, read all 10 output files and analyze:

1. **Most Frequently Recommended Adds:**
   - Count how many agents recommended each player to add
   - Identify top 5-10 most suggested additions

2. **Most Frequently Recommended Drops:**
   - Count how many agents recommended dropping each player
   - Identify top players suggested for removal

3. **Position Distribution:**
   - Break down recommendations by position (QB, RB, WR, TE, K, DEF)
   - Identify which positions agents prioritized

4. **Consensus Moves:**
   - Highlight any move suggested by 3+ agents (strong consensus)
   - Note moves suggested by only 1-2 agents (divergent opinions)

5. **Common Themes:**
   - Extract common reasoning patterns
   - Note injury concerns, matchup advantages, trend analysis

## Step 6: Generate Consensus Summary

Create a comprehensive summary document at `{output_directory}/consensus-summary.md`:

**Structure:**
```markdown
# Roster Move Recommendations Summary
**Team:** $1
**Season:** $2, Week $3
**Constraints:** {list any player/position constraints}
**Analysis Date:** {current date}

## Executive Summary
{2-3 paragraph overview of key findings}

## Consensus Recommendations (3+ Agent Agreement)
{List moves recommended by multiple agents with vote counts}

### Move 1: Drop [Player X] → Add [Player Y]
- **Support:** X out of 10 agents
- **Rationale:** {Synthesized reasoning}
- **Key Data Points:** {FantasyPros rankings, injury status, etc.}

{Repeat for other consensus moves}

## Diverse Recommendations (1-2 Agent Agreement)
{List interesting alternative suggestions}

## Position Analysis
- **QB:** {Summary of QB recommendations}
- **RB:** {Summary of RB recommendations}
- **WR:** {Summary of WR recommendations}
- **TE:** {Summary of TE recommendations}
- **K:** {Summary of K recommendations}
- **DEF:** {Summary of DEF recommendations}

## Players to Consider Adding
1. {Player name} - {Position} - {X agents recommended} - {Key stats/reasoning}
2. {Player name} - {Position} - {X agents recommended} - {Key stats/reasoning}
{Continue for top 10-15 players}

## Players to Consider Dropping
1. {Player name} - {Position} - {X agents recommended} - {Key reasoning}
2. {Player name} - {Position} - {X agents recommended} - {Key reasoning}
{Continue for top 5-10 players}

## Risk Assessment
{Discuss potential risks with top recommendations}

## Next Steps
{Suggested actions based on the analysis}

---
*Analysis based on recommendations from 10 independent AI agents*
*Individual agent reports available in: {output_directory}/*
```

Save this summary to the output directory.

## Step 7: Present Results to User

Display the consensus summary to the user and provide:
1. Path to the consensus summary file
2. Path to the directory containing all individual agent reports
3. Top 3-5 actionable recommendations

Example output:
```
✅ Analysis complete!

📊 Consensus Summary: /tmp/roster-recs-2025-week10-1699999999/consensus-summary.md

Top Recommendations:
1. Drop [Player X] → Add [Player Y] (7/10 agents agree)
2. Drop [Player A] → Add [Player B] (5/10 agents agree)
3. Drop [Player C] → Add [Player D] (4/10 agents agree)

📁 Individual agent reports: /tmp/roster-recs-2025-week10-1699999999/

Review the consensus summary for detailed analysis and reasoning.
```

## Important Notes

- All 10 agents must be spawned in a SINGLE message (parallel execution)
- Each agent should provide meaningfully different recommendations (different drop/add combos)
- Leverage FantasyPros and other web sources for data-driven decisions
- Respect the constraints: if a player is specified to drop, ALL moves must drop that player
- If a position is specified, ALL additions must be at that position
- The consensus summary should synthesize all recommendations, not just pick one
