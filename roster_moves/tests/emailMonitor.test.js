const GmailRosterMonitor = require('../emailMonitor');
const { positiveEmails, negativeEmails, edgeCases } = require('./testEmails');
const { mockPlayers, mockOwners, createEmailContent } = require('./mockData');

describe('GmailRosterMonitor - Email Parsing', () => {
  let monitor;

  beforeEach(() => {
    monitor = new GmailRosterMonitor();
  });

  describe('Positive Examples - Should Detect Roster Moves', () => {
    test('should parse simple add/drop combo', () => {
      const email = createEmailContent(
        positiveEmails.addDropCombo.from,
        positiveEmails.addDropCombo.subject,
        positiveEmails.addDropCombo.date,
        positiveEmails.addDropCombo.body
      );
      
      const result = monitor.parseRosterMove(email, mockPlayers, mockOwners);
      
      expect(result).toBeDefined();
      expect(result.owner.owner_name).toBe('Joe');
      expect(result.actions.adds).toHaveLength(2);
      expect(result.actions.drops).toHaveLength(2);
      expect(result.actions.adds[0].name).toBe('Joe Flacco');
      expect(result.actions.adds[1].name).toBe('Michael Carter');
      expect(result.actions.drops[0].name).toBe('Tank Dell');
      expect(result.actions.drops[1].name).toBe('David Montgomery');
    });

    test('should parse simple add with corresponding drop', () => {
      const email = createEmailContent(
        positiveEmails.simpleAddWithDrop.from,
        positiveEmails.simpleAddWithDrop.subject,
        positiveEmails.simpleAddWithDrop.date,
        positiveEmails.simpleAddWithDrop.body
      );
      
      const result = monitor.parseRosterMove(email, mockPlayers, mockOwners);
      
      expect(result).toBeDefined();
      expect(result.actions.adds).toHaveLength(1);
      expect(result.actions.drops).toHaveLength(1);
      expect(result.actions.adds[0].name).toBe('Adam Thielen');
      expect(result.actions.drops[0].name).toBe('Marvin Harrison Jr');
    });

    test('should parse IR activation with drop', () => {
      const email = createEmailContent(
        positiveEmails.irActivation.from,
        positiveEmails.irActivation.subject,
        positiveEmails.irActivation.date,
        positiveEmails.irActivation.body
      );
      
      const result = monitor.parseRosterMove(email, mockPlayers, mockOwners);
      
      expect(result).toBeDefined();
      expect(result.owner.owner_name).toBe('Bruce');
      expect(result.actions.fromIR).toHaveLength(1);
      expect(result.actions.drops).toHaveLength(1);
      expect(result.actions.fromIR[0].name).toBe('Harrison Butker');
      expect(result.actions.drops[0].name).toBe('Spencer Shrader');
    });

    test('should parse HTML email with multiple actions', () => {
      const email = createEmailContent(
        positiveEmails.multipleActions.from,
        positiveEmails.multipleActions.subject,
        positiveEmails.multipleActions.date,
        positiveEmails.multipleActions.body
      );
      
      const result = monitor.parseRosterMove(email, mockPlayers, mockOwners);
      
      expect(result).toBeDefined();
      expect(result.owner.owner_name).toBe('Matt');
      expect(result.actions.fromIR).toHaveLength(1);
      expect(result.actions.drops).toHaveLength(2);
      expect(result.actions.adds).toHaveLength(1);
      expect(result.actions.fromIR[0].name).toBe('Isiah Pacheco');
      expect(result.actions.adds[0].name).toBe('Tommy DeVito');
    });

    test('should handle "pick up" as two words', () => {
      const email = createEmailContent(
        positiveEmails.pickupTwoWords.from,
        positiveEmails.pickupTwoWords.subject,
        positiveEmails.pickupTwoWords.date,
        positiveEmails.pickupTwoWords.body
      );
      
      const result = monitor.parseRosterMove(email, mockPlayers, mockOwners);
      
      expect(result).toBeDefined();
      expect(result.actions.adds).toHaveLength(1);
      expect(result.actions.drops).toHaveLength(1);
      expect(result.actions.adds[0].name).toBe('Jake Bates');
      expect(result.actions.drops[0].name).toBe('Austin Seibert');
    });

    test('should handle alternative phrasing (release/acquire)', () => {
      const email = createEmailContent(
        positiveEmails.releasePlayer.from,
        positiveEmails.releasePlayer.subject,
        positiveEmails.releasePlayer.date,
        positiveEmails.releasePlayer.body
      );
      
      const result = monitor.parseRosterMove(email, mockPlayers, mockOwners);
      
      expect(result).toBeDefined();
      expect(result.actions.adds).toHaveLength(1);
      expect(result.actions.drops).toHaveLength(1);
      expect(result.actions.adds[0].name).toBe('Ameer Abdullah');
      expect(result.actions.drops[0].name).toBe('Gardner Minshew');
    });
  });

  describe('Negative Examples - Should NOT Detect Roster Moves', () => {
    test('should not parse score update as roster move', () => {
      const email = createEmailContent(
        negativeEmails.scoreUpdate.from,
        negativeEmails.scoreUpdate.subject,
        negativeEmails.scoreUpdate.date,
        negativeEmails.scoreUpdate.body
      );
      
      const result = monitor.parseRosterMove(email, mockPlayers, mockOwners);
      
      expect(result).toBeNull();
    });

    test('should not parse trade discussion as roster move', () => {
      const email = createEmailContent(
        negativeEmails.tradeDiscussion.from,
        negativeEmails.tradeDiscussion.subject,
        negativeEmails.tradeDiscussion.date,
        negativeEmails.tradeDiscussion.body
      );
      
      const result = monitor.parseRosterMove(email, mockPlayers, mockOwners);
      
      expect(result).toBeNull();
    });

    test('should not parse injury report as roster move', () => {
      const email = createEmailContent(
        negativeEmails.injuryReport.from,
        negativeEmails.injuryReport.subject,
        negativeEmails.injuryReport.date,
        negativeEmails.injuryReport.body
      );
      
      const result = monitor.parseRosterMove(email, mockPlayers, mockOwners);
      
      expect(result).toBeNull();
    });

    test('should not parse waiver discussion as roster move', () => {
      const email = createEmailContent(
        negativeEmails.waiverDiscussion.from,
        negativeEmails.waiverDiscussion.subject,
        negativeEmails.waiverDiscussion.date,
        negativeEmails.waiverDiscussion.body
      );
      
      const result = monitor.parseRosterMove(email, mockPlayers, mockOwners);
      
      expect(result).toBeNull();
    });

    test('should not parse player analysis as roster move', () => {
      const email = createEmailContent(
        negativeEmails.playerAnalysis.from,
        negativeEmails.playerAnalysis.subject,
        negativeEmails.playerAnalysis.date,
        negativeEmails.playerAnalysis.body
      );
      
      const result = monitor.parseRosterMove(email, mockPlayers, mockOwners);
      
      expect(result).toBeNull();
    });

    test('should not parse past pickup mention as current roster move', () => {
      const email = createEmailContent(
        negativeEmails.pastPickupMention.from,
        negativeEmails.pastPickupMention.subject,
        negativeEmails.pastPickupMention.date,
        negativeEmails.pastPickupMention.body
      );
      
      const result = monitor.parseRosterMove(email, mockPlayers, mockOwners);
      
      expect(result).toBeNull();
    });
  });

  describe('Edge Cases', () => {
    test('should handle misspelled player names', () => {
      const email = createEmailContent(
        edgeCases.misspelledName.from,
        edgeCases.misspelledName.subject,
        edgeCases.misspelledName.date,
        edgeCases.misspelledName.body
      );
      
      const result = monitor.parseRosterMove(email, mockPlayers, mockOwners);
      
      expect(result).toBeDefined();
      expect(result.actions.adds).toHaveLength(1);
      // Should match Bryan Robinson even though Brian Robinson exists
      expect(result.actions.adds[0].name).toBe('Bryan Robinson');
    });

    test('should parse mixed content (moves + discussion)', () => {
      const email = createEmailContent(
        edgeCases.mixedContent.from,
        edgeCases.mixedContent.subject,
        edgeCases.mixedContent.date,
        edgeCases.mixedContent.body
      );
      
      const result = monitor.parseRosterMove(email, mockPlayers, mockOwners);
      
      expect(result).toBeDefined();
      expect(result.actions.adds).toHaveLength(1);
      expect(result.actions.drops).toHaveLength(1);
      expect(result.actions.adds[0].name).toBe('Gardner Minshew');
      expect(result.actions.drops[0].name).toBe('Zach Wilson');
    });

    test('should handle CAPS formatting', () => {
      const email = createEmailContent(
        edgeCases.mixedFormats.from,
        edgeCases.mixedFormats.subject,
        edgeCases.mixedFormats.date,
        edgeCases.mixedFormats.body
      );
      
      const result = monitor.parseRosterMove(email, mockPlayers, mockOwners);
      
      expect(result).toBeDefined();
      expect(result.actions.adds).toHaveLength(1);
      expect(result.actions.drops).toHaveLength(1);
      expect(result.actions.toIR).toHaveLength(1);
      expect(result.actions.adds[0].name).toBe('Justin Herbert');
      expect(result.actions.drops[0].name).toBe('Mac Jones');
      expect(result.actions.toIR[0].name).toBe('Cooper Kupp');
    });

    test('should handle conditional moves based on injury status', () => {
      const email = createEmailContent(
        edgeCases.conditionalMove.from,
        edgeCases.conditionalMove.subject,
        edgeCases.conditionalMove.date,
        edgeCases.conditionalMove.body
      );
      
      const result = monitor.parseRosterMove(email, mockPlayers, mockOwners);
      
      expect(result).toBeDefined();
      expect(result.actions.adds).toHaveLength(1);
      expect(result.actions.drops).toHaveLength(1);
      expect(result.actions.adds[0].name).toBe('Curtis Samuel');
      expect(result.actions.drops[0].name).toBe('Tank Dell');
    });
  });

  describe('Quote Removal - extractLatestMessage', () => {
    test('should remove "On ... wrote:" quotes', () => {
      const body = "I'll drop Player A\n\nOn Mon, Jan 1, 2025 at 10:00 AM Joe wrote:\n> Previous message content";
      const result = monitor.extractLatestMessage(body);
      
      expect(result).toBe("I'll drop Player A");
      expect(result).not.toContain('Previous message');
    });

    test('should remove forwarded message headers', () => {
      const body = "Add Player B\n\n---------- Forwarded message ---------\nFrom: Someone\nOriginal content";
      const result = monitor.extractLatestMessage(body);
      
      expect(result).toBe("Add Player B");
      expect(result).not.toContain('Forwarded');
    });

    test('should remove email reply indicators', () => {
      const body = "Pick up Player C\n\n> On previous email\n> More quoted text";
      const result = monitor.extractLatestMessage(body);
      
      expect(result).toBe("Pick up Player C");
      expect(result).not.toContain('>');
    });

    test('should handle email thread from real example', () => {
      const result = monitor.extractLatestMessage(positiveEmails.threadWithQuote.body);
      
      // Should only get content before "On Sat, Dec 7..."
      expect(result).toContain("I'll drop Cedric Tillman");
      expect(result).toContain("Elijah Moore Browns WR");
      expect(result).not.toContain("Looking at options");
      expect(result).not.toContain("Tank Dell is out for the season");
    });
  });

  describe('Player Matching - findPlayer', () => {
    test('should find player by exact name match', () => {
      const player = monitor.findPlayer('Joe Flacco', mockPlayers);
      expect(player).toBeDefined();
      expect(player.name).toBe('Joe Flacco');
    });

    test('should find player by last name only', () => {
      const player = monitor.findPlayer('Flacco', mockPlayers);
      expect(player).toBeDefined();
      expect(player.name).toBe('Joe Flacco');
    });

    test('should find player by partial match', () => {
      const player = monitor.findPlayer('McCaffrey', mockPlayers);
      expect(player).toBeDefined();
      expect(player.name).toBe('Christian McCaffrey');
    });

    test('should handle case insensitive matching', () => {
      const player = monitor.findPlayer('joe flacco', mockPlayers);
      expect(player).toBeDefined();
      expect(player.name).toBe('Joe Flacco');
    });

    test('should return null for non-existent player', () => {
      const player = monitor.findPlayer('Fake Player', mockPlayers);
      expect(player).toBeNull();
    });
  });

  describe('Deduplication', () => {
    test('should remove duplicate players within same action type', () => {
      const duplicateBody = "Add Joe Flacco, add Joe Flacco again, also add Joe Flacco";
      const email = createEmailContent(
        'test@example.com',
        'Test',
        'Mon, 1 Jan 2025 10:00:00 -0800',
        duplicateBody
      );
      
      const result = monitor.parseRosterMove(email, mockPlayers, mockOwners);
      
      if (result) {
        // Should only have one Joe Flacco despite being mentioned 3 times
        expect(result.actions.adds).toHaveLength(1);
        expect(result.actions.adds[0].name).toBe('Joe Flacco');
      }
    });

    test('should allow same player in different action types', () => {
      const body = "Drop Harrison Butker and then bring back Harrison Butker from IR";
      const email = createEmailContent(
        'bruce@example.com',
        'IR Move',
        'Mon, 1 Jan 2025 10:00:00 -0800',
        body
      );
      
      const result = monitor.parseRosterMove(email, mockPlayers, mockOwners);
      
      if (result) {
        expect(result.actions.drops).toHaveLength(1);
        expect(result.actions.fromIR).toHaveLength(1);
        expect(result.actions.drops[0].name).toBe('Harrison Butker');
        expect(result.actions.fromIR[0].name).toBe('Harrison Butker');
      }
    });
  });
});