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

                // Set up automatic token refresh handler
                oAuth2Client.on('tokens', (tokens) => {
                    if (tokens.refresh_token) {
                        // Save the new refresh token
                        logInfo('Received new refresh token, updating stored token');
                        const updatedToken = { ...token, ...tokens };
                        fs.writeFileSync(sheetsTokenPath, JSON.stringify(updatedToken, null, 2));
                    }
                });
            } else {
                throw new Error('No authentication token found. Please run authentication setup.');
            }

            this.auth = oAuth2Client;
            this.tokenPath = sheetsTokenPath;
            this.sheets = google.sheets({ version: 'v4', auth: this.auth });

            logInfo('Google Sheets API initialized successfully');
            return true;
        } catch (error) {
            logError('Failed to initialize Google Sheets API:', error);
            throw error;
        }
    }

    /**
     * Handle API errors with better error messages
     */
    handleApiError(error, context = 'Google Sheets API') {
        if (error.response && error.response.data && error.response.data.error) {
            const apiError = error.response.data.error;

            // Handle invalid_grant errors specifically
            if (apiError === 'invalid_grant' || (typeof apiError === 'object' && apiError.message && apiError.message.includes('invalid_grant'))) {
                const helpMessage = 'Authentication token expired or revoked. Please re-authenticate by running: node utils/setupGoogleSheetsAuth.js';
                logError('invalid_grant error - token needs refresh:', helpMessage);
                throw new Error(helpMessage);
            }
        }

        // Re-throw original error with context
        throw new Error(`${context} error: ${error.message}`);
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
                                    columnCount: 30
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
            this.handleApiError(error, 'Get or create tab');
        }
    }

    /**
     * Write weekly data to Google Sheets (new format with 2 tabs)
     */
    async writeWeeklyData(spreadsheetId, weekNumber, season, standingsData, gridData) {
        try {
            // Tab 1: Week X - Detailed player grid
            await this.writeWeekTab(spreadsheetId, weekNumber, season, gridData);
            
            // Tab 2: Week X Summary - Simple three-table view
            await this.writeSummaryTab(spreadsheetId, weekNumber, season, gridData);
            
            logInfo(`Successfully wrote Week ${weekNumber} data to Google Sheet`);
            return true;
        } catch (error) {
            logError('Error writing weekly data:', error);
            throw error;
        }
    }

    /**
     * Write Tab 1: "Week X" - Detailed player grid
     */
    async writeWeekTab(spreadsheetId, weekNumber, season, gridData) {
        const tabName = `Week ${weekNumber}`;
        await this.getOrCreateTab(spreadsheetId, tabName);
        
        const rows = [];
        const { teams, teamRosters } = gridData;
        
        // Header row: Empty | Owner1 | PTS | Owner2 | PTS | ...
        const headerRow = [''];
        teams.forEach(team => {
            headerRow.push(team.owner_name, 'PTS');
        });
        rows.push(headerRow);
        
        // Helper to format points
        const formatPoints = (player) => {
            if (!player) return '';
            // Show 'X' for players who didn't play
            if (!player.didPlay) return 'X';
            // Format points - whole numbers without decimal, others with .1
            const pointStr = player.points % 1 === 0 ? 
                player.points.toString() : 
                player.points.toFixed(1);
            // Add asterisk for scoring players
            return player.isScoring ? `*${pointStr}` : pointStr;
        };
        
        // QB Section (4 rows max to accommodate all teams)
        const maxQBs = 4;
        for (let i = 0; i < maxQBs; i++) {
            const row = ['QB'];
            teams.forEach(team => {
                const roster = teamRosters[team.team_id];
                const player = roster.QB[i];
                if (player) {
                    row.push(player.name, formatPoints(player));
                } else {
                    row.push('', '');
                }
            });
            rows.push(row);
        }
        
        // Empty separator rows between QB and RB (3-4 rows)
        for (let i = 0; i < 4; i++) {
            rows.push(Array(headerRow.length).fill(''));
        }
        
        // RB Section (7 rows max to accommodate all teams)
        const maxRBs = 7;
        for (let i = 0; i < maxRBs; i++) {
            const row = ['RB'];
            teams.forEach(team => {
                const roster = teamRosters[team.team_id];
                const player = roster.RB[i];
                if (player) {
                    row.push(player.name, formatPoints(player));
                } else {
                    row.push('', '');
                }
            });
            rows.push(row);
        }
        
        // Empty separator rows between RB and WR (3-4 rows)
        for (let i = 0; i < 4; i++) {
            rows.push(Array(headerRow.length).fill(''));
        }
        
        // WR Section (includes TEs) (8 rows max for future-proofing)
        const maxWRs = 8;
        for (let i = 0; i < maxWRs; i++) {
            const row = ['WR'];
            teams.forEach(team => {
                const roster = teamRosters[team.team_id];
                const player = roster.WR[i];
                if (player) {
                    // Note position if it's a TE mixed in WR section
                    row.push(player.name, formatPoints(player));
                } else {
                    row.push('', '');
                }
            });
            rows.push(row);
        }
        
        // Empty separator rows between WR and K (2 rows)
        for (let i = 0; i < 2; i++) {
            rows.push(Array(headerRow.length).fill(''));
        }
        
        // K Section (1-2 rows)
        const maxKs = 2;
        for (let i = 0; i < maxKs; i++) {
            const row = ['K'];
            teams.forEach(team => {
                const roster = teamRosters[team.team_id];
                const player = roster.K[i];
                if (player) {
                    row.push(player.name, formatPoints(player));
                } else {
                    row.push('', '');
                }
            });
            rows.push(row);
        }
        
        // Empty separator row between K and DEF (1 row)
        rows.push(Array(headerRow.length).fill(''));
        
        // DEF Section (1-2 rows)
        const maxDEFs = 2;
        for (let i = 0; i < maxDEFs; i++) {
            const row = ['DEF'];
            teams.forEach(team => {
                const roster = teamRosters[team.team_id];
                const player = roster.DST[i];
                if (player) {
                    // Defense names should just be team name (e.g., "Chiefs", "49ers")
                    row.push(player.name, formatPoints(player));
                } else {
                    row.push('', '');
                }
            });
            rows.push(row);
        }
        
        // Empty separator row between DEF and summary (1 row)
        rows.push(Array(headerRow.length).fill(''));
        
        // Summary rows
        // WK. row
        const wkRow = ['WK.'];
        teams.forEach(team => {
            wkRow.push(team.weeklyPoints ? team.weeklyPoints.toFixed(1) : '0', '');
        });
        rows.push(wkRow);
        
        // CUM row
        const cumRow = ['CUM'];
        teams.forEach(team => {
            const cumPoints = team.cumulativePoints || 0;
            const displayPoints = cumPoints % 1 === 0 ? cumPoints.toString() : cumPoints.toFixed(2);
            cumRow.push(displayPoints, '');
        });
        rows.push(cumRow);
        
        // Opponent(Score) row
        const oppRow = [''];
        teams.forEach(team => {
            const oppDisplay = team.opponent ? 
                `${team.opponent}(${team.opponentScore ? team.opponentScore.toFixed(1) : '0'})` : '';
            oppRow.push(oppDisplay, '');
        });
        rows.push(oppRow);
        
        // Win/Loss row
        const resultRow = [''];
        teams.forEach(team => {
            resultRow.push(team.weekResult || '', '');
        });
        rows.push(resultRow);
        
        // Record row
        const recordRow = [''];
        teams.forEach(team => {
            recordRow.push(team.record || '0-0', '');
        });
        rows.push(recordRow);
        
        // Write to sheet
        try {
            await this.sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `${tabName}!A1`,
                valueInputOption: 'RAW',
                resource: { values: rows }
            });

            // Apply basic formatting
            await this.applyWeekTabFormatting(spreadsheetId, tabName);
        } catch (error) {
            this.handleApiError(error, 'Write week tab data');
        }
    }

    /**
     * Write Tab 2: "Week X Summary" - Simple three-table view
     */
    async writeSummaryTab(spreadsheetId, weekNumber, season, gridData) {
        const tabName = `Week ${weekNumber} Summary`;
        await this.getOrCreateTab(spreadsheetId, tabName);
        
        const rows = [];
        const { teams } = gridData;
        
        // Start with empty row (per spec)
        rows.push([]);
        
        // Headers for three tables - exactly as specified
        rows.push([
            'Team', 'Points This Week', '',
            'Team', 'Overall Points', '',
            'Standings', ''
        ]);
        
        // Sort teams for each table
        // Table 1: Weekly points (highest to lowest)
        const weeklySort = [...teams].sort((a, b) => 
            (b.weeklyPoints || 0) - (a.weeklyPoints || 0)
        );
        
        // Table 2: Overall/cumulative points (highest to lowest)
        const overallSort = [...teams].sort((a, b) => 
            (b.cumulativePoints || 0) - (a.cumulativePoints || 0)
        );
        
        // Table 3: Standings by win-loss record (best record first)
        const standingsSort = [...teams].sort((a, b) => {
            const aWins = a.wins || 0;
            const bWins = b.wins || 0;
            const aLosses = a.losses || 0;
            const bLosses = b.losses || 0;
            
            // Sort by wins first
            if (aWins !== bWins) return bWins - aWins;
            // Then by fewer losses
            if (aLosses !== bLosses) return aLosses - bLosses;
            // Tiebreaker: cumulative points
            return (b.cumulativePoints || 0) - (a.cumulativePoints || 0);
        });
        
        // Add 12 data rows (one for each team)
        for (let i = 0; i < 12; i++) {
            const weekTeam = weeklySort[i];
            const overallTeam = overallSort[i];
            const standingTeam = standingsSort[i];
            
            rows.push([
                // Column 1-2: Weekly points ranking
                weekTeam ? weekTeam.owner_name : '',
                weekTeam ? (weekTeam.weeklyPoints || 0).toFixed(1) : '',
                '', // Empty column for spacing
                // Column 4-5: Overall points ranking
                overallTeam ? overallTeam.owner_name : '',
                overallTeam ? 
                    (overallTeam.cumulativePoints != null ? 
                        (overallTeam.cumulativePoints % 1 === 0 ? 
                            overallTeam.cumulativePoints.toString() : 
                            overallTeam.cumulativePoints.toFixed(2)) : '0') : '',
                '', // Empty column for spacing
                // Column 7-8: Standings (Win-Loss record)
                standingTeam ? standingTeam.owner_name : '',
                standingTeam ? (standingTeam.record || '0-0') : ''
            ]);
        }
        
        // Write to sheet
        try {
            await this.sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `${tabName}!A1`,
                valueInputOption: 'RAW',
                resource: { values: rows }
            });

            // Apply basic formatting
            await this.applySummaryTabFormatting(spreadsheetId, tabName);
        } catch (error) {
            this.handleApiError(error, 'Write summary tab data');
        }
    }

    /**
     * Apply formatting to Week tab
     */
    async applyWeekTabFormatting(spreadsheetId, tabName) {
        try {
            const response = await this.sheets.spreadsheets.get({
                spreadsheetId,
                fields: 'sheets.properties'
            });
            
            const sheet = response.data.sheets.find(s => s.properties.title === tabName);
            if (!sheet) return;
            
            const sheetId = sheet.properties.sheetId;
            
            const requests = [
                // Bold header row
                {
                    repeatCell: {
                        range: {
                            sheetId,
                            startRowIndex: 0,
                            endRowIndex: 1
                        },
                        cell: {
                            userEnteredFormat: {
                                textFormat: {
                                    bold: true
                                },
                                horizontalAlignment: 'CENTER'
                            }
                        },
                        fields: 'userEnteredFormat(textFormat,horizontalAlignment)'
                    }
                },
                // Auto-resize columns
                {
                    autoResizeDimensions: {
                        dimensions: {
                            sheetId,
                            dimension: 'COLUMNS',
                            startIndex: 0,
                            endIndex: 26
                        }
                    }
                }
            ];
            
            await this.sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                resource: { requests }
            });
            
            logInfo('Applied formatting to Week tab');
        } catch (error) {
            logError('Error applying Week tab formatting:', error);
            // Non-critical error, continue
        }
    }

    /**
     * Apply formatting to Summary tab
     */
    async applySummaryTabFormatting(spreadsheetId, tabName) {
        try {
            const response = await this.sheets.spreadsheets.get({
                spreadsheetId,
                fields: 'sheets.properties'
            });
            
            const sheet = response.data.sheets.find(s => s.properties.title === tabName);
            if (!sheet) return;
            
            const sheetId = sheet.properties.sheetId;
            
            const requests = [
                // Bold header row
                {
                    repeatCell: {
                        range: {
                            sheetId,
                            startRowIndex: 1,
                            endRowIndex: 2
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
                            endIndex: 8
                        }
                    }
                }
            ];
            
            await this.sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                resource: { requests }
            });
            
            logInfo('Applied formatting to Summary tab');
        } catch (error) {
            logError('Error applying Summary tab formatting:', error);
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