const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { logInfo, logError } = require('../utils/errorHandler');

class GoogleSheetsExportService {
    constructor() {
        this.sheets = null;
        this.auth = null;
    }

    async initialize() {
        try {
            // Check for sheets-specific token first (with proper scopes)
            const sheetsTokenPath = path.join(__dirname, '../config/sheets-token.json');
            const rosterMovesCredsPath = path.join(__dirname, '../../roster_moves/credentials.json');
            const rosterMovesTokenPath = path.join(__dirname, '../../roster_moves/token.json');
            
            let credentials, token;
            
            // Load credentials from roster_moves
            if (fs.existsSync(rosterMovesCredsPath)) {
                credentials = JSON.parse(fs.readFileSync(rosterMovesCredsPath, 'utf8'));
            } else {
                throw new Error('Google credentials not found. Please set up authentication.');
            }
            
            // Check for sheets token with proper scopes
            if (fs.existsSync(sheetsTokenPath)) {
                token = JSON.parse(fs.readFileSync(sheetsTokenPath, 'utf8'));
                logInfo('Using Google Sheets token with spreadsheet scopes');
            } else if (fs.existsSync(rosterMovesTokenPath)) {
                // Fall back to roster_moves token (might not have sheets scope)
                token = JSON.parse(fs.readFileSync(rosterMovesTokenPath, 'utf8'));
                logInfo('Using Google token from roster_moves (may lack spreadsheet access)');
                
                // Check if token has spreadsheet scope
                if (!token.scope || !token.scope.includes('spreadsheets')) {
                    throw new Error('Token lacks Google Sheets access. Please run: node utils/setupGoogleSheetsAuth.js');
                }
            } else {
                throw new Error('No authentication token found. Please run: node utils/setupGoogleSheetsAuth.js');
            }

            // Create OAuth2 client
            const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
            const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
            
            if (token) {
                oAuth2Client.setCredentials(token);
            } else {
                throw new Error('No authentication token found. Please run authentication setup.');
            }

            this.auth = oAuth2Client;
            this.sheets = google.sheets({ version: 'v4', auth: this.auth });
            
            logInfo('Google Sheets API initialized successfully');
            return true;
        } catch (error) {
            logError('Failed to initialize Google Sheets API:', error);
            throw error;
        }
    }

    /**
     * Get or create a sheet tab
     */
    async getOrCreateTab(spreadsheetId, tabName) {
        try {
            // Get all sheets in the spreadsheet
            const response = await this.sheets.spreadsheets.get({
                spreadsheetId,
                fields: 'sheets.properties'
            });
            
            const sheets = response.data.sheets || [];
            const existingSheet = sheets.find(s => s.properties.title === tabName);
            
            if (existingSheet) {
                logInfo(`Tab "${tabName}" already exists, will update it`);
                // Clear the existing sheet
                await this.sheets.spreadsheets.values.clear({
                    spreadsheetId,
                    range: `${tabName}!A1:Z1000`
                });
                return existingSheet.properties.sheetId;
            }
            
            // Create new sheet
            const addSheetResponse = await this.sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                resource: {
                    requests: [{
                        addSheet: {
                            properties: {
                                title: tabName,
                                gridProperties: {
                                    rowCount: 500,
                                    columnCount: 26
                                }
                            }
                        }
                    }]
                }
            });
            
            const newSheetId = addSheetResponse.data.replies[0].addSheet.properties.sheetId;
            logInfo(`Created new tab "${tabName}"`);
            return newSheetId;
        } catch (error) {
            logError('Error creating tab:', error);
            throw error;
        }
    }

    /**
     * Write weekly standings data to sheet tabs (creates 2 tabs per week)
     */
    async writeWeeklyData(spreadsheetId, weekNumber, season, standingsData, gridData) {
        try {
            // Create two tabs for the week
            await this.writeStatsTab(spreadsheetId, weekNumber, season, gridData);
            await this.writeSummaryTab(spreadsheetId, weekNumber, season, standingsData);
            
            logInfo(`Successfully wrote Week ${weekNumber} data to Google Sheet`);
            return true;
        } catch (error) {
            logError('Error writing weekly data:', error);
            throw error;
        }
    }

    /**
     * Write the stats tab (Week X Stats) - Grid format with all rostered players
     */
    async writeStatsTab(spreadsheetId, weekNumber, season, gridData) {
        const tabName = `Week ${weekNumber} Stats`;
        await this.getOrCreateTab(spreadsheetId, tabName);
        
        const rows = [];
        
        // Header
        rows.push([`WEEK ${weekNumber} STATS`]);
        rows.push([]);
        
        // Column headers: Player | Team | Pos | Owner1 | Owner2 | ... | Owner12
        const headerRow = ['Player', 'Team', 'Pos'];
        gridData.teams.forEach(owner => headerRow.push(owner));
        rows.push(headerRow);
        
        // Process each position group
        const positions = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
        
        positions.forEach(position => {
            const players = gridData.positionGroups[position] || [];
            
            players.forEach(player => {
                const row = [
                    player.name,
                    player.nfl_team || '-',
                    position === 'DST' ? 'D' : position
                ];
                
                // Add points for each owner column
                gridData.teams.forEach(owner => {
                    if (player.owner_name === owner) {
                        // This player belongs to this owner
                        let pointsDisplay = '';
                        if (player.fantasyPoints === 0) {
                            pointsDisplay = 'X';
                        } else {
                            // Add asterisk for scoring players
                            const prefix = player.isScoring ? '*' : '';
                            pointsDisplay = prefix + player.fantasyPoints.toFixed(1);
                        }
                        row.push(pointsDisplay);
                    } else {
                        // Empty cell for other owners
                        row.push('');
                    }
                });
                
                rows.push(row);
            });
            
            // Add empty row between position groups (except after last)
            if (position !== 'DST' && players.length > 0) {
                rows.push([]);
            }
        });
        
        // Write to sheet
        await this.sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${tabName}!A1`,
            valueInputOption: 'RAW',
            resource: { values: rows }
        });
        
        // Apply formatting
        await this.applyStatsFormatting(spreadsheetId, tabName);
    }

    /**
     * Write the summary tab (Week X Summary) - League Standings format
     */
    async writeSummaryTab(spreadsheetId, weekNumber, season, standingsData) {
        const tabName = `Week ${weekNumber} Summary`;
        await this.getOrCreateTab(spreadsheetId, tabName);
        
        const rows = [];
        
        // Header
        rows.push([`WEEK ${weekNumber} LEAGUE STANDINGS`]);
        rows.push([]);
        
        // Sort teams for each table
        const teams = standingsData.teams;
        
        // Create three side-by-side tables
        // Headers for all three tables
        rows.push([
            'CUMULATIVE POINTS', '', '', '',
            'WEEK POINTS', '', '', '',
            'STANDINGS', '', '', ''
        ]);
        rows.push([
            'Rank', 'Team', 'Owner', 'Points', '',
            'Rank', 'Team', 'Owner', 'Points', '',
            'Rank', 'Team', 'Owner', 'Record'
        ]);
        
        // Sort teams for each category
        const cumulativeSort = [...teams].sort((a, b) => 
            (b.cumulativePoints || 0) - (a.cumulativePoints || 0)
        );
        
        const weeklySort = [...teams].sort((a, b) => 
            (b.weeklyPoints || 0) - (a.weeklyPoints || 0)
        );
        
        const standingsSort = [...teams].sort((a, b) => {
            const aWins = a.wins || 0;
            const bWins = b.wins || 0;
            if (aWins !== bWins) return bWins - aWins;
            return (b.cumulativePoints || 0) - (a.cumulativePoints || 0);
        });
        
        // Add data rows (12 teams)
        for (let i = 0; i < 12; i++) {
            const cumTeam = cumulativeSort[i];
            const weekTeam = weeklySort[i];
            const standTeam = standingsSort[i];
            
            rows.push([
                // Cumulative Points column
                i + 1,
                cumTeam ? cumTeam.team_name : '',
                cumTeam ? cumTeam.owner_name : '',
                cumTeam ? (cumTeam.cumulativePoints || 0).toFixed(1) : '',
                '',
                // Week Points column
                i + 1,
                weekTeam ? weekTeam.team_name : '',
                weekTeam ? weekTeam.owner_name : '',
                weekTeam ? (weekTeam.weeklyPoints || 0).toFixed(1) : '',
                '',
                // Standings column
                i + 1,
                standTeam ? standTeam.team_name : '',
                standTeam ? standTeam.owner_name : '',
                standTeam ? `${standTeam.wins || 0}-${standTeam.losses || 0}${(standTeam.ties || 0) > 0 ? `-${standTeam.ties}` : ''}` : ''
            ]);
        }
        
        // Add some space
        rows.push([]);
        rows.push([]);
        rows.push([]);
        
        // Add matchup results section
        rows.push(['WEEK ' + weekNumber + ' MATCHUP RESULTS']);
        rows.push(['Team 1', '', 'Score', 'Team 2', '', 'Score', 'Winner']);
        
        standingsData.matchups.forEach(matchup => {
            const winner = matchup.team1_points > matchup.team2_points ? matchup.team1_name :
                         matchup.team1_points < matchup.team2_points ? matchup.team2_name : 'TIE';
            rows.push([
                matchup.team1_name,
                '',
                (matchup.team1_points || 0).toFixed(1),
                matchup.team2_name,
                '',
                (matchup.team2_points || 0).toFixed(1),
                winner
            ]);
        });
        
        // Add detailed rosters section
        rows.push([]);
        rows.push([]);
        rows.push(['TEAM ROSTERS']);
        rows.push([]);
        
        // Display teams in 3 columns format (4 rows of 3 teams)
        const rosterTeams = [...teams].sort((a, b) => {
            const aWins = a.wins || 0;
            const bWins = b.wins || 0;
            if (aWins !== bWins) return bWins - aWins;
            return (b.weeklyPoints || 0) - (a.weeklyPoints || 0);
        });
        
        for (let i = 0; i < rosterTeams.length; i += 3) {
            const teamGroup = rosterTeams.slice(i, i + 3);
            
            // Team headers
            const teamHeaderRow = [];
            teamGroup.forEach(team => {
                teamHeaderRow.push(
                    team.team_name,
                    `${team.wins || 0}-${team.losses || 0}`,
                    (team.weeklyPoints || 0).toFixed(1)
                );
                teamHeaderRow.push(''); // Separator
            });
            rows.push(teamHeaderRow);
            
            // Column headers
            const headerRow = [];
            teamGroup.forEach(team => {
                headerRow.push('Player', 'Pos', 'Pts');
                headerRow.push(''); // Separator
            });
            rows.push(headerRow);
            
            // Player rows (19 players each)
            for (let playerIdx = 0; playerIdx < 19; playerIdx++) {
                const playerRow = [];
                teamGroup.forEach(team => {
                    const player = team.roster[playerIdx];
                    if (player) {
                        let position = player.position;
                        if (position === 'Defense' || position === 'DST') {
                            position = 'D';
                        }
                        if (player.status === 'IR') {
                            position = `IR-${position}`;
                        }
                        
                        // Mark scoring players with asterisk
                        const playerName = player.isScoring ? `*${player.name}` : player.name;
                        
                        playerRow.push(
                            playerName,
                            position,
                            (player.fantasyPoints || 0).toFixed(1)
                        );
                    } else {
                        playerRow.push('', '', '');
                    }
                    playerRow.push(''); // Separator
                });
                rows.push(playerRow);
            }
            
            // Total row
            const totalRow = [];
            teamGroup.forEach(team => {
                const total = team.roster.reduce((sum, p) => sum + (p.fantasyPoints || 0), 0);
                const scoringTotal = team.roster
                    .filter(p => p.isScoring)
                    .reduce((sum, p) => sum + (p.fantasyPoints || 0), 0);
                totalRow.push('TOTAL', '', total.toFixed(1));
                totalRow.push(''); // Separator
            });
            rows.push(totalRow);
            
            // Scoring total row
            const scoringRow = [];
            teamGroup.forEach(team => {
                const scoringTotal = team.roster
                    .filter(p => p.isScoring)
                    .reduce((sum, p) => sum + (p.fantasyPoints || 0), 0);
                scoringRow.push('SCORING', '', scoringTotal.toFixed(1));
                scoringRow.push(''); // Separator
            });
            rows.push(scoringRow);
            
            // Add space between team groups
            rows.push([]);
            rows.push([]);
        }
        
        // Add note about scoring players
        rows.push(['* = Scoring Player']);
        
        // Write to sheet
        await this.sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${tabName}!A1`,
            valueInputOption: 'RAW',
            resource: { values: rows }
        });
        
        // Apply formatting
        await this.applySummaryFormatting(spreadsheetId, tabName);
    }

    /**
     * Apply formatting to the stats tab
     */
    async applyStatsFormatting(spreadsheetId, tabName) {
        try {
            const response = await this.sheets.spreadsheets.get({
                spreadsheetId,
                ranges: [`${tabName}!A1:Z1000`],
                fields: 'sheets(properties,data)'
            });
            
            const sheet = response.data.sheets.find(s => s.properties.title === tabName);
            if (!sheet) return;
            
            const sheetId = sheet.properties.sheetId;
            const requests = [];
            
            // Format header row
            requests.push({
                repeatCell: {
                    range: {
                        sheetId,
                        startRowIndex: 0,
                        endRowIndex: 1
                    },
                    cell: {
                        userEnteredFormat: {
                            textFormat: {
                                fontSize: 14,
                                bold: true
                            },
                            horizontalAlignment: 'CENTER'
                        }
                    },
                    fields: 'userEnteredFormat(textFormat,horizontalAlignment)'
                }
            });
            
            // Format column headers
            requests.push({
                repeatCell: {
                    range: {
                        sheetId,
                        startRowIndex: 2,
                        endRowIndex: 3
                    },
                    cell: {
                        userEnteredFormat: {
                            textFormat: {
                                bold: true
                            },
                            horizontalAlignment: 'CENTER',
                            backgroundColor: {
                                red: 0.95,
                                green: 0.95,
                                blue: 0.95
                            }
                        }
                    },
                    fields: 'userEnteredFormat(textFormat,horizontalAlignment,backgroundColor)'
                }
            });
            
            // Auto-resize columns
            requests.push({
                autoResizeDimensions: {
                    dimensions: {
                        sheetId,
                        dimension: 'COLUMNS',
                        startIndex: 0,
                        endIndex: 15
                    }
                }
            });
            
            if (requests.length > 0) {
                await this.sheets.spreadsheets.batchUpdate({
                    spreadsheetId,
                    resource: { requests }
                });
            }
        } catch (error) {
            logError('Error applying stats formatting:', error);
            // Continue even if formatting fails
        }
    }

    /**
     * Apply formatting to the summary tab
     */
    async applySummaryFormatting(spreadsheetId, tabName) {
        try {
            const response = await this.sheets.spreadsheets.get({
                spreadsheetId,
                fields: 'sheets.properties'
            });
            
            const sheet = response.data.sheets.find(s => s.properties.title === tabName);
            if (!sheet) return;
            
            const sheetId = sheet.properties.sheetId;
            
            const requests = [
                // Bold and larger font for main title
                {
                    repeatCell: {
                        range: {
                            sheetId,
                            startRowIndex: 0,
                            endRowIndex: 1,
                            startColumnIndex: 0,
                            endColumnIndex: 14
                        },
                        cell: {
                            userEnteredFormat: {
                                textFormat: {
                                    fontSize: 16,
                                    bold: true
                                }
                            }
                        },
                        fields: 'userEnteredFormat.textFormat'
                    }
                },
                // Bold section headers (standings tables)
                {
                    repeatCell: {
                        range: {
                            sheetId,
                            startRowIndex: 2,
                            endRowIndex: 3,
                            startColumnIndex: 0,
                            endColumnIndex: 14
                        },
                        cell: {
                            userEnteredFormat: {
                                textFormat: {
                                    bold: true,
                                    fontSize: 12
                                },
                                backgroundColor: {
                                    red: 0.95,
                                    green: 0.95,
                                    blue: 0.95
                                }
                            }
                        },
                        fields: 'userEnteredFormat.textFormat,userEnteredFormat.backgroundColor'
                    }
                },
                // Bold table headers
                {
                    repeatCell: {
                        range: {
                            sheetId,
                            startRowIndex: 3,
                            endRowIndex: 4,
                            startColumnIndex: 0,
                            endColumnIndex: 14
                        },
                        cell: {
                            userEnteredFormat: {
                                textFormat: {
                                    bold: true
                                }
                            }
                        },
                        fields: 'userEnteredFormat.textFormat'
                    }
                },
                // Auto-resize columns
                {
                    autoResizeDimensions: {
                        dimensions: {
                            sheetId,
                            dimension: 'COLUMNS',
                            startIndex: 0,
                            endIndex: 14
                        }
                    }
                }
            ];
            
            await this.sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                resource: { requests }
            });
            
            logInfo('Applied formatting to standings sheet');
        } catch (error) {
            logError('Error applying formatting:', error);
            // Non-critical error, continue
        }
    }


    /**
     * Extract spreadsheet ID from various input formats
     */
    extractSpreadsheetId(input) {
        // If it's already just an ID
        if (!input.includes('/')) {
            return input;
        }
        
        // Extract from Google Sheets URL
        const match = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
        if (match) {
            return match[1];
        }
        
        throw new Error('Invalid Google Sheets URL or ID');
    }
}

module.exports = GoogleSheetsExportService;