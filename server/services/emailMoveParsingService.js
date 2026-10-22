const { spawn } = require('child_process');
const { envWithClaude } = require('../../scripts/lib/claudeHeadless');
const fs = require('fs').promises;
const path = require('path');
const { logInfo, logError, logWarn } = require('../utils/errorHandler');

/**
 * JSON schema the parser must follow. Included verbatim in the prompt and
 * validated server-side (headless claude does not enforce schemas).
 */
const ROSTER_MOVE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'sender_team_id', 'summary', 'questions_for_commissioner', 'moves'],
    properties: {
        status: { type: 'string', enum: ['parsed', 'ambiguous', 'not_a_roster_move', 'move_invalidation'] },
        sender_team_id: { type: ['integer', 'null'] },
        summary: { type: 'string' },
        invalidation_quote: { type: 'string' },
        questions_for_commissioner: { type: 'array', items: { type: 'string' } },
        moves: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['move_type', 'team_id', 'drop_player_id', 'drop_player_name', 'drop_quote',
                    'add_player_id', 'add_player_name', 'add_quote',
                    'partner_team_id', 'partner_player_id', 'partner_player_name',
                    'confidence', 'notes'],
                properties: {
                    move_type: { type: 'string', enum: ['ir', 'supplemental', 'ir_return', 'trade'] },
                    team_id: { type: 'integer' },
                    drop_player_id: { type: ['string', 'null'] },
                    drop_player_name: { type: ['string', 'null'] },
                    drop_quote: { type: 'string' },
                    add_player_id: { type: ['string', 'null'] },
                    add_player_name: { type: ['string', 'null'] },
                    add_quote: { type: 'string' },
                    partner_team_id: { type: ['integer', 'null'] },
                    partner_player_id: { type: ['string', 'null'] },
                    partner_player_name: { type: ['string', 'null'] },
                    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                    notes: { type: 'string' }
                }
            }
        }
    }
};

const PARSER_INSTRUCTIONS = `You are parsing a fantasy football roster-move email for the PFL league commissioner.

LEAGUE MODEL:
- 12 teams, each with exactly 19 ACTIVE players at all times, plus any number of players on injured reserve (IR).
- Every move is a paired drop+add that keeps the active roster at 19.
- Move types:
  - "ir" (THE DEFAULT): the dropped player goes to this team's IR; the added player is a free agent filling the active spot. A plain drop+add request with no other context is an "ir" move - owners usually don't say "IR" explicitly.
  - "supplemental": the dropped player leaves the team entirely; the added player is a free agent. Use ONLY when the email explicitly signals it: the word "supplemental" (or "supp") in the subject or body, or the message is clearly part of a supplemental-draft thread (e.g. a reply chain started with "the supplemental draft has started").
  - "ir_return": the ADDED player is coming back from this team's own IR (they must have been on IR for 3+ weeks); the DROPPED player leaves the team entirely. Requires explicit return-from-IR language.
  - "trade": player-for-player between two teams (rare).

YOUR TASK: read the email and produce ONLY a JSON object following the schema below. No prose, no markdown fences, no explanation - the JSON object only.

RULES:
1. NEVER GUESS. If you cannot determine the exact players or move type with confidence, set status to "ambiguous" and explain what is unclear in questions_for_commissioner. An ambiguous result is a GOOD outcome; a wrong guess is the worst outcome.
2. Not every email is a move request. Banter ("great pickup last week!"), hypotheticals ("I'm thinking about dropping X", "should I pick up Y?"), questions, retrospective mentions, and trash talk are status "not_a_roster_move".
3. Dropped players must come from the sender's CURRENT ROSTER (provided below), OR be explicitly acquired in an EARLIER trade in this same email. Preserve execution order: trade first, then IR/drop of the received player. Do not omit or collapse the later action because ownership has not changed yet. For ordinary moves added players must be free agents from the FULL PLAYER LIST, or for ir_return from the sender's IR. For trades the incoming player belongs to the partner team, NOT the free-agent pool; set add_player_id/name and partner_player_id/name to that SAME incoming player and partner_team_id to the other owner's team. Use exact player_id strings.
4. For every drop and add, include the VERBATIM phrase from the email you inferred it from (drop_quote / add_quote).
5. Multiple moves in one email become multiple entries in moves[]. If the pairing of multiple drops and adds is unclear, return "ambiguous".
6. Resolve nicknames and abbreviations using the player list (e.g. "Hollywood Brown" = Marquise Brown), but only when unambiguous for the position/team context.
7. team_id must be the sender's team, unless the sender is listed as authorized to act for other teams (see "SENDER MAY ALSO ACT FOR" below) and the email clearly names that owner or team - then team_id is the delegated team and its roster (provided below) is the one to drop from. A move for any other team is "ambiguous". For trades, partner_* fields identify the other team and player; otherwise set them to null.
8. confidence: "high" only when the email is explicit; "medium" when mild inference was needed; "low" when you inferred substantially.
9. Move type defaults to "ir". Do NOT classify a move as "supplemental" just because the email says "drop" without injury language - only an explicit supplemental signal (see move types above) makes it supplemental. Choosing "ir" for a plain drop+add needs no confidence penalty; it is the league's normal case.

10. An explicit ruling by Dan Ochse <wdochse@gmail.com> that a proposed roster move is invalid, disallowed, unavailable, or must be undone is status "move_invalidation", moves=[], with invalidation_quote containing the VERBATIM ruling from the newest email body. Summarize who/which move and the stated reason when supplied; never invent a target. This is an informational admin note, not permission to undo or reject a roster transaction. A pass, "you're up", draft-order/rules announcement, question, hypothetical, or quoted older ruling is NOT an invalidation. Other senders cannot issue Dan's ruling. Return not_a_roster_move for ordinary commentary. invalidation_quote is required only for move_invalidation; omit it otherwise.

OUTPUT JSON SCHEMA (follow required fields exactly):
`;

/**
 * Default parser backend: headless Claude Code. Runs under the commissioner's
 * Claude subscription (no API key, no metered spend). Always passes an
 * explicit --model so it never falls through to the CLI's session default.
 */
class HeadlessClaudeBackend {
    constructor({ model = process.env.ROSTER_PARSER_MODEL || 'opus', timeoutMs = 120000 } = {}) {
        this.model = model;
        this.timeoutMs = timeoutMs;
    }

    async run(prompt) {
        return new Promise((resolve, reject) => {
            const proc = spawn('claude', [
                '-p',
                '--output-format', 'json',
                '--model', this.model,
                '--max-turns', '1'
            ], { env: envWithClaude(), stdio: ['pipe', 'pipe', 'pipe'] });

            let stdout = '';
            let stderr = '';
            const timer = setTimeout(() => {
                proc.kill('SIGKILL');
                reject(new Error(`claude -p timed out after ${this.timeoutMs}ms`));
            }, this.timeoutMs);

            proc.stdout.on('data', d => { stdout += d; });
            proc.stderr.on('data', d => { stderr += d; });
            proc.on('error', err => { clearTimeout(timer); reject(err); });
            proc.on('close', code => {
                clearTimeout(timer);
                if (code !== 0) {
                    return reject(new Error(`claude -p exited ${code}: ${stderr.slice(0, 500)}`));
                }
                try {
                    const envelope = JSON.parse(stdout);
                    if (envelope.is_error) {
                        return reject(new Error(`claude -p error result: ${String(envelope.result).slice(0, 500)}`));
                    }
                    resolve(envelope.result ?? '');
                } catch (e) {
                    reject(new Error(`claude -p produced unparseable envelope: ${stdout.slice(0, 300)}`));
                }
            });

            proc.stdin.write(prompt);
            proc.stdin.end();
        });
    }
}

class EmailMoveParsingService {
    constructor(db, { parserBackend = null, ownersFile = null } = {}) {
        this.db = db;
        this.backend = parserBackend || new HeadlessClaudeBackend();
        this.ownersFile = ownersFile || path.join(__dirname, '../../roster_moves/owners.json');
    }

    async loadOwners() {
        try {
            return JSON.parse(await fs.readFile(this.ownersFile, 'utf8'));
        } catch (error) {
            logWarn(`Could not load owners mapping from ${this.ownersFile}`, { error: error.message });
            return {};
        }
    }

    /**
     * Resolve a From: header to an owner entry. Returns
     * { email, teamId, ownerName, actsFor } or null for unknown senders.
     * actsFor lists other team_ids this sender may submit moves for
     * (owners.json "actsFor": [11]); empty for everyone else.
     */
    async resolveSender(fromHeader) {
        const owners = await this.loadOwners();
        const match = (fromHeader || '').match(/[\w.+-]+@[\w.-]+/);
        const address = match ? match[0].toLowerCase() : null;
        if (!address) return null;
        const entry = Object.entries(owners).find(([email]) => email.toLowerCase() === address);
        if (!entry) return null;
        const actsFor = (Array.isArray(entry[1].actsFor) ? entry[1].actsFor : [])
            .map(Number).filter(id => Number.isInteger(id) && id !== entry[1].teamId);
        return { email: address, teamId: entry[1].teamId, ownerName: entry[1].ownerName, actsFor };
    }

    /** team_ids this sender may submit moves for: their own plus any delegations. */
    allowedTeamIds(sender) {
        return [sender.teamId, ...(sender.actsFor || [])];
    }

    /** Active roster + IR (with weeks on IR) for one team in one week. */
    async loadTeamRoster(teamId, week, season) {
        const roster = await this.db.all(`
            SELECT player_id, player_name, player_position, player_team
            FROM weekly_rosters
            WHERE team_id = ? AND week = ? AND season = ? AND roster_position = 'active'
            ORDER BY player_position, player_name
        `, [teamId, week, season]);

        const irList = await this.db.all(`
            SELECT wr.player_id, wr.player_name, wr.player_position, wr.player_team,
                   (SELECT ? - MAX(rm.week) FROM roster_moves rm
                    WHERE rm.team_id = wr.team_id AND rm.dropped_player_id = wr.player_id
                      AND rm.move_type = 'ir' AND rm.season = ?) as weeks_on_ir
            FROM weekly_rosters wr
            WHERE wr.team_id = ? AND wr.week = ? AND wr.season = ?
              AND wr.roster_position = 'injured_reserve'
        `, [week, season, teamId, week, season]);

        return { roster, irList };
    }

    async buildContext(sender) {
        const settings = await this.db.get(
            'SELECT current_week, season_year FROM league_settings WHERE league_id = 1'
        );
        const { current_week: week, season_year: season } = settings;

        const { roster, irList } = await this.loadTeamRoster(sender.teamId, week, season);

        // Deterministic order so repeated parses see identical context
        const players = await this.db.all(`
            SELECT player_id, name, position, team FROM nfl_players ORDER BY player_id
        `);

        const teams = await this.db.all('SELECT team_id, team_name, owner_name FROM teams ORDER BY team_id');

        // Teams this sender is authorized to act for (owners.json actsFor)
        const delegated = [];
        for (const teamId of sender.actsFor || []) {
            const team = teams.find(t => t.team_id === teamId);
            const rosters = await this.loadTeamRoster(teamId, week, season);
            delegated.push({ teamId, teamName: team?.team_name || `team ${teamId}`, ownerName: team?.owner_name || '?', ...rosters });
        }

        const leagueRosters = await this.db.all(`
            SELECT team_id, player_id, player_name, roster_position
            FROM weekly_rosters WHERE week = ? AND season = ? ORDER BY team_id, player_id
        `, [week, season]);
        return { week, season, roster, irList, players, teams, delegated, leagueRosters };
    }

    formatRoster(roster) {
        return roster.map(p => `${p.player_id}|${p.player_name}|${p.player_position}|${p.player_team}`).join('\n') || '(none)';
    }

    formatIr(irList) {
        return irList.length
            ? irList.map(p =>
                `${p.player_id}|${p.player_name}|${p.player_position}|${p.player_team}|on IR ${p.weeks_on_ir ?? '?'} week(s)`
              ).join('\n')
            : '(none)';
    }

    buildPrompt(email, sender, context) {
        const playerList = context.players
            .map(p => `${p.player_id}|${p.name}|${p.position}|${p.team}`)
            .join('\n');
        const rosterList = this.formatRoster(context.roster);
        const irLines = this.formatIr(context.irList);
        const delegatedSections = (context.delegated || []).map(d => [
            `\nSENDER MAY ALSO ACT FOR: ${d.ownerName} (${d.teamName}) - team_id ${d.teamId}. Use this team_id only when the email clearly refers to ${d.ownerName}'s team.`,
            `${d.ownerName.toUpperCase()}'S ACTIVE ROSTER (player_id|name|pos|nfl_team):\n${this.formatRoster(d.roster)}`,
            `${d.ownerName.toUpperCase()}'S INJURED RESERVE:\n${this.formatIr(d.irList)}`
        ].join('\n'));
        const teamList = context.teams
            .map(t => `${t.team_id}|${t.team_name}|${t.owner_name}`)
            .join('\n');

        return [
            PARSER_INSTRUCTIONS,
            JSON.stringify(ROSTER_MOVE_SCHEMA, null, 1),
            `\nCURRENT WEEK: ${context.week}, SEASON: ${context.season}`,
            `\nLEAGUE TEAMS (team_id|team_name|owner):\n${teamList}`,
            `\nCURRENT LEAGUE OWNERSHIP (team_id|player_id|name|status):\n${(context.leagueRosters || []).map(p => `${p.team_id}|${p.player_id}|${p.player_name}|${p.roster_position}`).join('\n')}`,
            `\nSENDER: ${sender.ownerName} <${sender.email}> - team_id ${sender.teamId}`,
            `\nSENDER'S ACTIVE ROSTER (player_id|name|pos|nfl_team):\n${rosterList}`,
            `\nSENDER'S INJURED RESERVE:\n${irLines}`,
            ...delegatedSections,
            `\nFULL NFL PLAYER LIST (player_id|name|pos|nfl_team):\n${playerList}`,
            `\nTHE EMAIL:\nFrom: ${email.from}\nSubject: ${email.subject}\nDate: ${email.date}\n\n${email.body}`,
            `\nRespond with the JSON object only.`
        ].join('\n');
    }

    /**
     * Minimal validator for ROSTER_MOVE_SCHEMA (headless claude cannot
     * enforce schemas server-side, so we check here).
     */
    validateAgainstSchema(parsed) {
        const errors = [];
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return ['Result is not a JSON object'];
        }
        if (!['parsed', 'ambiguous', 'not_a_roster_move', 'move_invalidation'].includes(parsed.status)) {
            errors.push(`Invalid status: ${parsed.status}`);
        }
        if (typeof parsed.summary !== 'string') errors.push('summary must be a string');
        if (!Array.isArray(parsed.questions_for_commissioner)) errors.push('questions_for_commissioner must be an array');
        if (!Array.isArray(parsed.moves)) {
            errors.push('moves must be an array');
            return errors;
        }
        if (parsed.status === 'move_invalidation') {
            if (parsed.moves.length) errors.push('An invalidation note cannot execute moves');
            if (typeof parsed.invalidation_quote !== 'string' || !parsed.invalidation_quote.trim()) {
                errors.push('Invalidation requires a verbatim ruling quote');
            }
        }
        for (const [i, m] of parsed.moves.entries()) {
            if (!['ir', 'supplemental', 'ir_return', 'trade'].includes(m?.move_type)) {
                errors.push(`moves[${i}].move_type invalid: ${m?.move_type}`);
            }
            if (!Number.isInteger(m?.team_id)) errors.push(`moves[${i}].team_id must be an integer`);
            if (!['high', 'medium', 'low'].includes(m?.confidence)) errors.push(`moves[${i}].confidence invalid`);
            if (typeof m?.drop_quote !== 'string' || typeof m?.add_quote !== 'string') {
                errors.push(`moves[${i}] missing verbatim drop_quote/add_quote`);
            }
        }
        return errors;
    }

    /** Strip markdown fences if the model wrapped the JSON despite instructions. */
    extractJson(text) {
        let t = String(text).trim();
        const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (fence) t = fence[1].trim();
        return JSON.parse(t);
    }

    plausiblyMatches(dbName, claimedName) {
        const norm = s => String(s || '').toLowerCase().replace(/[^a-z\s]/g, '').trim();
        const a = norm(dbName);
        const b = norm(claimedName);
        if (!a || !b) return false;
        if (a.includes(b) || b.includes(a)) return true;
        const lastA = a.split(/\s+/).pop();
        const lastB = b.split(/\s+/).pop();
        return lastA === lastB;
    }

    /**
     * Verify Claude's player IDs against the DB and the sender's identity.
     * Any mismatch demotes the move (confidence -> low, which routes the
     * queue item to needs_review). Never silently trust an ID.
     */
    async crossValidate(parsed, sender) {
        for (const move of parsed.moves || []) {
            const problems = [];

            const allowed = this.allowedTeamIds(sender);
            if (!allowed.includes(move.team_id)) {
                problems.push(allowed.length > 1
                    ? `team_id ${move.team_id} is not the sender's team ${sender.teamId} or a team they act for (${sender.actsFor.join(', ')})`
                    : `team_id ${move.team_id} does not match sender's team ${sender.teamId}`);
            }

            for (const side of ['drop', 'add']) {
                const id = move[`${side}_player_id`];
                const claimedName = move[`${side}_player_name`];
                if (!id) {
                    problems.push(`missing ${side}_player_id`);
                    continue;
                }
                const dbPlayer = await this.db.get(
                    'SELECT player_id, name FROM nfl_players WHERE player_id = ?', [id]
                );
                if (!dbPlayer) {
                    problems.push(`${side}_player_id ${id} not found in player table`);
                } else if (!this.plausiblyMatches(dbPlayer.name, claimedName)) {
                    problems.push(`${side} name mismatch: id ${id} is "${dbPlayer.name}" but parser said "${claimedName}"`);
                }
            }

            if (move.move_type === 'trade') {
                if (!Number.isInteger(move.partner_team_id) || move.partner_team_id === move.team_id) {
                    problems.push('trade must name a different partner_team_id');
                }
                if (!move.partner_player_id || move.add_player_id !== move.partner_player_id) {
                    problems.push('trade add_player_id must match incoming partner_player_id');
                }
                const partner = await this.db.get(
                    'SELECT player_id, name FROM nfl_players WHERE player_id = ?', [move.partner_player_id]
                );
                if (!partner) problems.push(`partner_player_id ${move.partner_player_id} not found`);
                else if (!this.plausiblyMatches(partner.name, move.partner_player_name)) {
                    problems.push('trade partner player name does not match its ID');
                }
            }

            if (problems.length > 0) {
                move.confidence = 'low';
                move.notes = [move.notes, `CROSS-VALIDATION: ${problems.join('; ')}`].filter(Boolean).join(' | ');
                logWarn('Email move failed cross-validation', { problems });
            }
        }
        return parsed;
    }

    /**
     * Parse one email into a structured, cross-validated move proposal.
     * email: { gmailMessageId, from, subject, date, body }
     */
    async parseEmail(email) {
        const sender = await this.resolveSender(email.from);
        if (!sender) {
            return { status: 'unknown_sender', sender_team_id: null, summary: `Unknown sender: ${email.from}`, questions_for_commissioner: [], moves: [] };
        }

        const context = await this.buildContext(sender);
        const prompt = this.buildPrompt(email, sender, context);

        let lastError = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
            const raw = await this.backend.run(
                attempt === 1 ? prompt : `${prompt}\n\nREMINDER: your previous output was not valid JSON for the schema (${lastError}). Output ONLY the JSON object.`
            );
            try {
                const parsed = this.extractJson(raw);
                const schemaErrors = this.validateAgainstSchema(parsed);
                if (schemaErrors.length > 0) {
                    lastError = schemaErrors.join('; ');
                    logWarn(`Parse attempt ${attempt} failed schema validation`, { schemaErrors });
                    continue;
                }
                if (parsed.status === 'move_invalidation') {
                    if (sender.email !== 'wdochse@gmail.com' ||
                        !email.body.includes(parsed.invalidation_quote.trim())) {
                        throw new Error('Invalidation must quote Dan’s current email verbatim');
                    }
                    return { ...parsed, sender_team_id: sender.teamId };
                }
                const result = await this.crossValidate(parsed, sender);
                logInfo(`Parsed email ${email.gmailMessageId}: ${result.status}, ${result.moves.length} move(s)`);
                return result;
            } catch (error) {
                lastError = error.message;
                logWarn(`Parse attempt ${attempt} produced invalid JSON`, { error: error.message });
            }
        }

        // Both attempts malformed: surface as ambiguous, never guess
        return {
            status: 'ambiguous',
            sender_team_id: sender.teamId,
            summary: 'Parser could not produce valid structured output for this email',
            questions_for_commissioner: [`Automatic parsing failed (${lastError}) - handle this email manually`],
            moves: []
        };
    }
}

module.exports = EmailMoveParsingService;
module.exports.ROSTER_MOVE_SCHEMA = ROSTER_MOVE_SCHEMA;
module.exports.PARSER_INSTRUCTIONS = PARSER_INSTRUCTIONS;
module.exports.HeadlessClaudeBackend = HeadlessClaudeBackend;
