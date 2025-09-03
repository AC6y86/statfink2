const fs = require('fs').promises;
const path = require('path');
const { google } = require('googleapis');
const sqlite3 = require('sqlite3').verbose();
const { authorize } = require('./authSetup');

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const TOKEN_PATH = path.join(__dirname, 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const ROSTER_MOVES_LOG = path.join(__dirname, 'roster_moves_log.json');
const LAST_CHECK_FILE = path.join(__dirname, 'last_check.json');

class GmailRosterMonitor {
  constructor() {
    this.auth = null;
    this.gmail = null;
    this.db = null;
  }

  async initialize() {
    this.auth = await authorize();
    this.gmail = google.gmail({ version: 'v1', auth: this.auth });
    this.db = new sqlite3.Database('../fantasy_football.db', sqlite3.OPEN_READONLY);
    console.log('Gmail Roster Monitor initialized');
  }

  async getLastCheckTime() {
    try {
      const content = await fs.readFile(LAST_CHECK_FILE);
      const data = JSON.parse(content);
      return data.lastCheck || null;
    } catch (err) {
      return null;
    }
  }

  async saveLastCheckTime() {
    const now = new Date().toISOString();
    await fs.writeFile(LAST_CHECK_FILE, JSON.stringify({ lastCheck: now }));
  }

  async getRecentEmails() {
    const lastCheck = await this.getLastCheckTime();
    let query = 'is:unread';
    
    if (lastCheck) {
      const date = new Date(lastCheck);
      const dateStr = `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
      query = `after:${dateStr} `;
    }

    try {
      const res = await this.gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 50
      });

      const messages = res.data.messages || [];
      console.log(`Found ${messages.length} new messages to check`);
      
      const emailDetails = [];
      for (const message of messages) {
        const msg = await this.gmail.users.messages.get({
          userId: 'me',
          id: message.id
        });
        emailDetails.push(msg.data);
      }
      
      return emailDetails;
    } catch (error) {
      console.error('Error fetching emails:', error);
      return [];
    }
  }

  extractEmailContent(message) {
    const headers = message.payload.headers;
    const from = headers.find(h => h.name === 'From')?.value || '';
    const subject = headers.find(h => h.name === 'Subject')?.value || '';
    const date = headers.find(h => h.name === 'Date')?.value || '';
    
    let body = '';
    
    function extractText(part) {
      if (part.body && part.body.data) {
        const buff = Buffer.from(part.body.data, 'base64');
        return buff.toString('utf-8');
      }
      if (part.parts) {
        return part.parts.map(extractText).join('\n');
      }
      return '';
    }
    
    body = extractText(message.payload);
    
    return {
      id: message.id,
      from,
      subject,
      date,
      body: body.substring(0, 5000)
    };
  }

  extractLatestMessage(body) {
    // Common patterns that indicate quoted/forwarded content
    const quotePatterns = [
      /On .+? wrote:/i,
      /-----\s*Original Message\s*-----/i,
      /----------\s*Forwarded message\s*---------/i,
      /From:\s*[^\n]+\nSent:/i,
      /From:\s*[^\n]+\nDate:/i,
      /_{10,}/,
      /On\s+\w+,\s+\w+\s+\d+,\s+\d{4}/i,
      /\n>\s+/,
      /wrote:\n/i,
      /\n\s*---+\s*\n/
    ];
    
    let earliestQuoteIndex = body.length;
    
    for (const pattern of quotePatterns) {
      const match = body.match(pattern);
      if (match && match.index < earliestQuoteIndex) {
        earliestQuoteIndex = match.index;
      }
    }
    
    // Return only the content before any quotes
    return body.substring(0, earliestQuoteIndex).trim();
  }

  async getAllPlayers() {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT player_id, name, position, team FROM nfl_players`,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  async getTeamOwners() {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT team_id, team_name, owner_name FROM teams`,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  parseRosterMove(emailContent, players, owners) {
    const { from, subject, body } = emailContent;
    
    // Extract only the latest message, excluding quoted text
    const latestBody = this.extractLatestMessage(body);
    
    const owner = owners.find(o => 
      from.toLowerCase().includes(o.owner_name.toLowerCase()) ||
      latestBody.toLowerCase().includes(o.team_name.toLowerCase())
    );
    
    if (!owner) {
      return null;
    }
    
    const actions = {
      adds: [],
      drops: [],
      toIR: [],
      fromIR: []
    };
    
    // Helper function to deduplicate players by player_id
    const deduplicatePlayers = (playerArray) => {
      const seen = new Set();
      return playerArray.filter(player => {
        if (seen.has(player.player_id)) {
          return false;
        }
        seen.add(player.player_id);
        return true;
      });
    };
    
    const addMatches = latestBody.matchAll(/(?:add|pickup|pick up|claim|acquire)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?(?:\s+[A-Z][a-z]+)?)/gi);
    for (const match of addMatches) {
      const playerName = match[1].trim();
      const player = this.findPlayer(playerName, players);
      if (player) {
        actions.adds.push(player);
      }
    }
    
    const dropMatches = latestBody.matchAll(/(?:drop|release|cut|waive)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?(?:\s+[A-Z][a-z]+)?)/gi);
    for (const match of dropMatches) {
      const playerName = match[1].trim();
      const player = this.findPlayer(playerName, players);
      if (player) {
        actions.drops.push(player);
      }
    }
    
    const irMatches = latestBody.matchAll(/(?:IR|injured reserve|place on IR)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?(?:\s+[A-Z][a-z]+)?)/gi);
    for (const match of irMatches) {
      const playerName = match[1].trim();
      const player = this.findPlayer(playerName, players);
      if (player) {
        actions.toIR.push(player);
      }
    }
    
    const activateMatches = latestBody.matchAll(/(?:activate|bring back|return from IR)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?(?:\s+[A-Z][a-z]+)?)/gi);
    for (const match of activateMatches) {
      const playerName = match[1].trim();
      const player = this.findPlayer(playerName, players);
      if (player) {
        actions.fromIR.push(player);
      }
    }
    
    // Deduplicate players in each action type
    actions.adds = deduplicatePlayers(actions.adds);
    actions.drops = deduplicatePlayers(actions.drops);
    actions.toIR = deduplicatePlayers(actions.toIR);
    actions.fromIR = deduplicatePlayers(actions.fromIR);
    
    const hasActions = actions.adds.length > 0 || actions.drops.length > 0 || 
                      actions.toIR.length > 0 || actions.fromIR.length > 0;
    
    if (!hasActions) {
      return null;
    }
    
    return {
      emailId: emailContent.id,
      date: emailContent.date,
      from: emailContent.from,
      subject: emailContent.subject,
      owner: {
        team_id: owner.team_id,
        team_name: owner.team_name,
        owner_name: owner.owner_name
      },
      actions,
      rawText: latestBody.substring(0, 1000)
    };
  }

  findPlayer(searchName, players) {
    searchName = searchName.toLowerCase().trim();
    
    const exactMatch = players.find(p => 
      p.name.toLowerCase() === searchName
    );
    if (exactMatch) return exactMatch;
    
    const lastNameMatch = players.find(p => {
      const lastName = p.name.split(' ').pop().toLowerCase();
      return lastName === searchName.split(' ').pop().toLowerCase();
    });
    if (lastNameMatch) return lastNameMatch;
    
    const partialMatch = players.find(p => 
      p.name.toLowerCase().includes(searchName) || 
      searchName.includes(p.name.toLowerCase())
    );
    
    return partialMatch || null;
  }

  async logRosterMove(rosterMove) {
    try {
      let existingMoves = [];
      try {
        const content = await fs.readFile(ROSTER_MOVES_LOG);
        existingMoves = JSON.parse(content);
      } catch (err) {
      }
      
      const exists = existingMoves.some(m => m.emailId === rosterMove.emailId);
      if (!exists) {
        existingMoves.push(rosterMove);
        await fs.writeFile(ROSTER_MOVES_LOG, JSON.stringify(existingMoves, null, 2));
        
        console.log('\n=== NEW ROSTER MOVE DETECTED ===');
        console.log(`Owner: ${rosterMove.owner.owner_name} (${rosterMove.owner.team_name})`);
        console.log(`Date: ${rosterMove.date}`);
        console.log(`Subject: ${rosterMove.subject}`);
        
        if (rosterMove.actions.adds.length > 0) {
          console.log('ADDS:');
          rosterMove.actions.adds.forEach(p => 
            console.log(`  - ${p.name} (${p.position}, ${p.team})`));
        }
        
        if (rosterMove.actions.drops.length > 0) {
          console.log('DROPS:');
          rosterMove.actions.drops.forEach(p => 
            console.log(`  - ${p.name} (${p.position}, ${p.team})`));
        }
        
        if (rosterMove.actions.toIR.length > 0) {
          console.log('TO IR:');
          rosterMove.actions.toIR.forEach(p => 
            console.log(`  - ${p.name} (${p.position}, ${p.team})`));
        }
        
        if (rosterMove.actions.fromIR.length > 0) {
          console.log('FROM IR:');
          rosterMove.actions.fromIR.forEach(p => 
            console.log(`  - ${p.name} (${p.position}, ${p.team})`));
        }
        
        console.log('================================\n');
      }
    } catch (error) {
      console.error('Error logging roster move:', error);
    }
  }

  async processEmails() {
    const emails = await this.getRecentEmails();
    const players = await this.getAllPlayers();
    const owners = await this.getTeamOwners();
    
    let moveCount = 0;
    for (const email of emails) {
      const content = this.extractEmailContent(email);
      const rosterMove = this.parseRosterMove(content, players, owners);
      
      if (rosterMove) {
        await this.logRosterMove(rosterMove);
        moveCount++;
      }
    }
    
    await this.saveLastCheckTime();
    console.log(`Processed ${emails.length} emails, found ${moveCount} roster moves`);
  }

  async close() {
    if (this.db) {
      this.db.close();
    }
  }
}

async function main() {
  const monitor = new GmailRosterMonitor();
  
  try {
    await monitor.initialize();
    await monitor.processEmails();
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await monitor.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = GmailRosterMonitor;