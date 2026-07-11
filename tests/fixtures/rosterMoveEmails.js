/**
 * Email fixtures for the email-driven roster move pipeline tests.
 * Bodies follow the real formats from the league's email history.
 * Canned parser responses mirror what the production prompt+schema produce
 * (refined against real 2025 emails in the Phase A eval).
 */

const OWNERS = {
    'joe.paley@gmail.com': { teamId: 5, ownerName: 'Joe' },
    'chris@example.com': { teamId: 1, ownerName: 'Chris' },
    'mitch@example.com': { teamId: 2, ownerName: 'Mitch' }
};

function email(id, from, subject, body) {
    return { gmailMessageId: id, threadId: `t-${id}`, from, subject, date: '2026-06-12T12:00:00Z', body };
}

const EMAILS = {
    simpleSupplemental: email('e1', 'chris@example.com', 'move',
        "I'll drop Tank Dell and pick up Joe Flacco."),
    irReturn: email('e2', 'chris@example.com', 'IR return',
        "I'll bring back Harrison Butker from IR and drop Spencer Shrader."),
    irPlacement: email('e3', 'chris@example.com', 'IR',
        'Put Tank Dell on IR and add Michael Carter please.'),
    twoMoves: email('e4', 'chris@example.com', 'two moves',
        "Drop Tank Dell and pick up Joe Flacco. Also drop David Montgomery and pick up Michael Carter."),
    banter: email('e5', 'chris@example.com', 'nice one',
        'That Flacco pickup last week really paid off, great move!'),
    hypothetical: email('e6', 'chris@example.com', 'thinking',
        "I'm thinking about dropping Tank Dell, maybe for Flacco. What do you think?"),
    unknownSender: email('e7', 'stranger@nowhere.com', 'move',
        "I'll drop Tank Dell and pick up Joe Flacco."),
    nickname: email('e8', 'chris@example.com', 'wr move',
        'Drop Tank Dell, grab Hollywood Brown.'),
    quotedThread: email('e9', 'chris@example.com', 'Re: moves',
        "Yes confirmed, drop Tank Dell for Joe Flacco.\n\nOn Tue, Jun 9, Joe wrote:\n> Did you want to make that move?\n> I'll drop somebody else entirely"),
    trade: email('e10', 'chris@example.com', 'trade',
        "Mitch and I agreed to a trade: my Tank Dell for his David Montgomery.")
};

/** Canned parser outputs keyed by fixture name (what the backend mock returns). */
const CANNED_RESPONSES = {
    simpleSupplemental: {
        status: 'parsed', sender_team_id: 1,
        summary: 'Drop Tank Dell, add Joe Flacco (supplemental)',
        questions_for_commissioner: [],
        moves: [{
            move_type: 'supplemental', team_id: 1,
            drop_player_id: 'P_DELL', drop_player_name: 'Tank Dell', drop_quote: "I'll drop Tank Dell",
            add_player_id: 'P_FLACCO', add_player_name: 'Joe Flacco', add_quote: 'pick up Joe Flacco',
            partner_team_id: null, partner_player_id: null, partner_player_name: null,
            confidence: 'high', notes: ''
        }]
    },
    banter: {
        status: 'not_a_roster_move', sender_team_id: 1,
        summary: 'Compliment about a past pickup, no move requested',
        questions_for_commissioner: [], moves: []
    },
    hypothetical: {
        status: 'not_a_roster_move', sender_team_id: 1,
        summary: 'Owner is considering a move and asking for advice, not requesting one',
        questions_for_commissioner: [], moves: []
    }
};

module.exports = { OWNERS, EMAILS, CANNED_RESPONSES };
