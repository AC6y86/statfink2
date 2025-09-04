// Real email examples from the Gmail account
// These are actual emails that have been processed

const positiveEmails = {
  // Simple add/drop combo
  addDropCombo: {
    from: "Joe Paley <peninsula.football.mailer@gmail.com>",
    subject: "Re: Week 17 Scores", 
    date: "Sun, 5 Jan 2025 09:26:13 -0800",
    body: "I'll drop Tank Dell and pick up Joe Flacco.  Will it help my score?  No.\r\nWill it be fun?  Maybe.\r\nAlso drop David Montgomery and pick up Michael Carter Ari RB."
  },

  // Simple add with corresponding drop
  simpleAddWithDrop: {
    from: "Pete <pete@example.com>",
    subject: "Roster Move",
    date: "Fri, 3 Jan 2025 11:15:16 -0800", 
    body: "I'll pick up Adam Thielen and drop Marvin Harrison Jr"
  },

  // IR activation with drop
  irActivation: {
    from: "Bruce <bruce@example.com>",
    subject: "Re: Week 14",
    date: "Sat, 14 Dec 2024 18:10:03 -0500",
    body: "I'll bring back Harrison Butker K KC and drop Spencer Shrader K KC"
  },

  // Simple add/drop
  simpleAddDrop: {
    from: "Joe Paley <peninsula.football.mailer@gmail.com>",
    subject: "Week 17 Roster Moves",
    date: "Wed, 25 Dec 2024 16:26:36 -0800",
    body: "I'll add Kendre Miller and drop Tank Dell"
  },

  // Multiple drops and IR activation
  multipleActions: {
    from: "Matt <matt@example.com>",
    subject: "Re: Week 11 Scores",
    date: "Sun, 24 Nov 2024 00:55:03 -0800",
    body: "<html><head><meta http-equiv=\"content-type\" content=\"text/html; charset=utf-8\"></head><body dir=\"auto\">Bring back Pacheco, drop Daniel jones<div><br></div><div>Drop Chris olave pick up Tommy devito&nbsp;<br><div dir=\"ltr\"></div></div></body></html>"
  },

  // Alternative phrasing - "pick up" as two words
  pickupTwoWords: {
    from: "Sean <sean@example.com>",
    subject: "Re: Week 12 Scores",
    date: "Sun, 1 Dec 2024 12:12:39 -0800",
    body: "I'll drop Austin Seibert and pick up Jake Bates Detroit kicker"
  },

  // Using "release" instead of drop
  releasePlayer: {
    from: "Sean <sean@example.com>",
    subject: "Roster Move",
    date: "Mon, 1 Jan 2025 10:00:00 -0800",
    body: "I'll release Gardner Minshew and acquire Ameer Abdullah RB Raiders"
  },

  // Email thread with quoted content (should only parse latest)
  threadWithQuote: {
    from: "Joe Paley <peninsula.football.mailer@gmail.com>",
    subject: "Re: IR Move",
    date: "Sat, 7 Dec 2024 18:53:06 -0800",
    body: "I'll drop Cedric Tillman and pick up Gus Edwards.\r\n\r\nScratch that, I'll take Elijah Moore Browns WR.\r\n\r\nOn Sat, Dec 7, 2024 at 6:45 PM Joe Paley wrote:\r\n> Looking at options for my IR slot\r\n> Tank Dell is out for the season"
  }
};

const negativeEmails = {
  // Score update mentioning players but no moves
  scoreUpdate: {
    from: "Joe Paley <peninsula.football.mailer@gmail.com>",
    subject: "Week 16 Final Scores",
    date: "Mon, 30 Dec 2024 11:00:00 -0800",
    body: "Week 16 is in the books! Congrats to Aaron for the weekly win.\r\n\r\nTop scorers:\r\n- Josh Allen: 38.5 pts\r\n- CeeDee Lamb: 28.2 pts\r\n- Travis Kelce: 24.1 pts\r\n\r\nSean maintains his overall lead with 1902 points."
  },

  // Trade discussion without execution
  tradeDiscussion: {
    from: "Mike <mike@example.com>",
    subject: "Trade Proposal",
    date: "Tue, 15 Dec 2024 14:30:00 -0800",
    body: "Would you consider trading Josh Allen for Lamar Jackson and a WR? I think Allen has been great but Lamar might have easier matchups coming up."
  },

  // Injury report without IR move
  injuryReport: {
    from: "Cal <cal@example.com>",
    subject: "Injury Update",
    date: "Wed, 20 Nov 2024 09:15:00 -0800",
    body: "Just saw that Tank Dell is questionable for this week. Also, David Montgomery is dealing with a knee issue. Might need to monitor before Sunday's games."
  },

  // General league discussion
  leagueDiscussion: {
    from: "Pete <pete@example.com>",
    subject: "Playoff Picture",
    date: "Thu, 5 Dec 2024 16:00:00 -0800",
    body: "Looking at the standings, it's going to be a tight race for the playoffs. Sean and Aaron are locked in, but spots 3-6 are still up for grabs. Joe and Chris are tied at 1717 points!"
  },

  // Waiver priority discussion
  waiverDiscussion: {
    from: "Eli <eli@example.com>",
    subject: "Waiver Order",
    date: "Wed, 11 Dec 2024 08:00:00 -0800",
    body: "What's our waiver priority right now? I'm thinking about maybe claiming Jerome Ford but want to make sure I understand the order first."
  },

  // Player analysis without moves
  playerAnalysis: {
    from: "Mitch <mitch@example.com>",
    subject: "RB Rankings ROS",
    date: "Fri, 13 Dec 2024 12:00:00 -0800",
    body: "Here's how I'd rank the RBs for rest of season:\r\n1. Christian McCaffrey\r\n2. Austin Ekeler\r\n3. Tony Pollard\r\n4. Breece Hall\r\n\r\nThoughts? I think McCaffrey is a lock for #1 if healthy."
  },

  // Email with standings/roster count
  standingsEmail: {
    from: "Joe Paley <peninsula.football.mailer@gmail.com>",
    subject: "Re: Week 17 Scores",
    date: "Mon, 6 Jan 2025 11:28:37 -0800",
    body: "Minor update on the scoring.  After reviewing the scores today, I somehow\r\ndid not count one of the weeks (Week 16) in the cumulative scoring.\r\n\r\nTeam Overall Points\r\nSean 2066\r\nAaron 2050.17\r\nChris 1837\r\nJoe 1822.17"
  },

  // Mentioning a past pickup but not making a move
  pastPickupMention: {
    from: "Joe Paley <peninsula.football.mailer@gmail.com>",
    subject: "Week 17 Scores",
    date: "Fri, 3 Jan 2025 11:15:16 -0800",
    body: "Congrats to Pete for the Week 17 win!  That pickup of Adam Thielen really\r\npaid off.  I thought Aaron had a chance to pass up Sean, but Sean had a\r\nstrong finish to the week thanks to Jered Goff."
  }
};

const edgeCases = {
  // Misspelled player name
  misspelledName: {
    from: "Dan <dan@example.com>",
    subject: "Roster Move",
    date: "Sun, 10 Nov 2024 09:33:35 -0800",
    body: "Add Bryan Robinson RB Commanders" // Bryan vs Brian
  },

  // Defense/ST variations
  defenseVariations: {
    from: "Chris <chris@example.com>",
    subject: "Week 15 Moves",
    date: "Tue, 17 Dec 2024 10:00:00 -0800",
    body: "Drop 49ers D and pick up Buffalo DST"
  },

  // Nickname usage
  nicknameUsage: {
    from: "Aaron <aaron@example.com>",
    subject: "Add",
    date: "Wed, 18 Dec 2024 11:00:00 -0800",
    body: "Pick up OBJ" // Odell Beckham Jr
  },

  // Multiple formats in one email
  mixedFormats: {
    from: "Cal <cal@example.com>",
    subject: "Moves",
    date: "Thu, 19 Dec 2024 12:00:00 -0800",
    body: "I'll add Justin Herbert\r\nDrop Mac Jones\r\n\r\nAlso place on IR Cooper Kupp"
  },

  // Forwarded email
  forwardedEmail: {
    from: "Sean <sean@example.com>",
    subject: "Fwd: Roster moves",
    date: "Fri, 20 Dec 2024 13:00:00 -0800",
    body: "---------- Forwarded message ---------\r\nFrom: Sean <sean@example.com>\r\nDate: Fri, Dec 20, 2024 at 12:55 PM\r\nSubject: Roster moves\r\n\r\nDrop Russell Wilson and add Justin Fields"
  },

  // Email with both moves and non-moves
  mixedContent: {
    from: "Bruce <bruce@example.com>",
    subject: "Week 16 Update",
    date: "Sat, 21 Dec 2024 14:00:00 -0800",
    body: "Great week everyone! Josh Allen killed it with 38 points.\r\n\r\nFor my roster moves:\r\nDrop Zach Wilson and pick up Gardner Minshew\r\n\r\nAlso, can someone explain the tiebreaker rules?"
  },

  // Conditional move based on injury (SHOULD be detected - common pattern)
  conditionalMove: {
    from: "Matt <matt@example.com>",
    subject: "Roster move",
    date: "Sun, 22 Dec 2024 15:00:00 -0800",
    body: "If Tank Dell is ruled out, I'll drop him and pick up Curtis Samuel"
  },

  // Move with team clarification
  teamClarification: {
    from: "Mike <mike@example.com>",
    subject: "Add",
    date: "Mon, 23 Dec 2024 16:00:00 -0800",
    body: "Pick up Michael Thomas (not the Saints one, the new guy on the Rams)"
  }
};

module.exports = {
  positiveEmails,
  negativeEmails,
  edgeCases
};