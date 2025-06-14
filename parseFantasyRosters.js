#!/usr/bin/env node

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
require('dotenv').config();

// Database path
const dbPath = path.join(__dirname, 'fantasy_football.db');

class FantasyRosterComparison {
    constructor() {
        this.db = new sqlite3.Database(dbPath);
        this.scoringMismatches = [];
        this.playerNameMismatches = [];
        this.ownerNames = [];
    }

    // Parse the fantasy roster format Excel file
    async loadFantasyRosterData(filePath) {
        if (!fs.existsSync(filePath)) {
            throw new Error(`Spreadsheet file not found: ${filePath}`);
        }
        
        console.log('📋 Loading fantasy roster data from Excel...');
        
        const workbook = XLSX.readFile(filePath);
        const playerScores = {};
        
        // Get week stats sheets
        const sheetNames = workbook.SheetNames;
        const weekSheets = sheetNames.filter(name => 
            name.toLowerCase().includes('week') && name.toLowerCase().includes('stats')
        );
        
        console.log(`📊 Found ${weekSheets.length} week sheets: ${weekSheets.join(', ')}`);
        
        for (const sheetName of weekSheets) {
            // Extract week number
            const weekMatch = sheetName.match(/week\s*(\d+)/i);
            if (!weekMatch) continue;
            
            const weekNumber = parseInt(weekMatch[1]);
            console.log(`  📋 Processing ${sheetName} (Week ${weekNumber})...`);
            
            const worksheet = workbook.Sheets[sheetName];
            const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
            
            if (data.length === 0) continue;
            
            // Find header row with owner names
            let headerRow = null;
            let headerRowIndex = -1;
            
            for (let i = 0; i < Math.min(5, data.length); i++) {
                const row = data[i];
                if (row && row.length > 10) {
                    // Look for owner names in header
                    const potentialOwners = row.filter(cell => 
                        cell && typeof cell === 'string' && 
                        cell.length > 1 && cell.length < 10 &&
                        !cell.toLowerCase().includes('pts') &&
                        !cell.toLowerCase().includes('point')
                    );
                    
                    if (potentialOwners.length >= 5) {
                        headerRow = row;
                        headerRowIndex = i;
                        break;
                    }
                }
            }
            
            if (!headerRow) {
                console.warn(`⚠️  Could not find header row in ${sheetName}`);
                continue;
            }
            
            // Extract owner names and their column positions
            // Pattern: Empty, Owner1, PTS, Owner2, PTS, Owner3, PTS, etc.
            const ownerColumns = [];
            for (let col = 1; col < headerRow.length; col += 2) {
                const ownerCell = headerRow[col];
                const ptsCell = headerRow[col + 1];
                
                if (ownerCell && typeof ownerCell === 'string' && 
                    ownerCell.length > 1 && ownerCell.length < 10 &&
                    !ownerCell.toLowerCase().includes('pts') &&
                    ptsCell && String(ptsCell).toLowerCase().includes('pts')) {
                    
                    ownerColumns.push({
                        name: ownerCell,
                        playerCol: col,
                        pointsCol: col + 1
                    });
                }
            }
            
            if (this.ownerNames.length === 0) {
                this.ownerNames = ownerColumns.map(o => o.name);
            }
            
            console.log(`  👥 Found ${ownerColumns.length} owners: ${ownerColumns.map(o => o.name).join(', ')}`);
            
            // Process data rows to extract player scores
            let playersProcessed = 0;
            
            for (let rowIndex = headerRowIndex + 1; rowIndex < data.length; rowIndex++) {
                const row = data[rowIndex];
                if (!row || row.length === 0) continue;
                
                // Skip position headers and empty rows
                const firstCell = String(row[0] || '').trim();
                if (firstCell === 'QB' || firstCell === 'RB' || firstCell === 'WR' || 
                    firstCell === 'TE' || firstCell === 'K' || firstCell === 'DST' ||
                    firstCell === 'Defense' || row.every(cell => !cell)) {
                    continue;
                }
                
                // Process each owner's player in this row
                for (const owner of ownerColumns) {
                    const playerCell = row[owner.playerCol];
                    const pointsCell = row[owner.pointsCol];
                    
                    if (!playerCell || !pointsCell) continue;
                    
                    // Parse player name (remove team info)
                    let playerName = String(playerCell).trim();
                    const parenIndex = playerName.indexOf('(');
                    if (parenIndex > 0) {
                        playerName = playerName.substring(0, parenIndex).trim();
                    }
                    
                    // Skip if this looks like a team name or position header
                    if (playerName.length < 3 || 
                        ['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'Defense'].includes(playerName) ||
                        playerName.endsWith('s') && playerName.length < 8) { // Skip team names like "Chiefs", "Ravens"
                        continue;
                    }
                    
                    // Parse points (handle asterisks and X)
                    let points = String(pointsCell).trim();
                    const wasStarted = points.startsWith('*');
                    points = points.replace(/\*/g, '').trim();
                    
                    if (points === 'X' || points === '' || isNaN(parseFloat(points))) {
                        continue; // Skip non-numeric scores
                    }
                    
                    const score = parseFloat(points);
                    
                    if (playerName && !isNaN(score)) {
                        const key = `${playerName}_${owner.name}`;
                        if (!playerScores[key]) {
                            playerScores[key] = {
                                playerName: playerName,
                                owner: owner.name,
                                weeks: {}
                            };
                        }
                        playerScores[key].weeks[`week${weekNumber}`] = {
                            score: score,
                            started: wasStarted
                        };
                        playersProcessed++;
                    }
                }
            }
            
            console.log(`  ✅ Processed ${playersProcessed} player-owner combinations from ${sheetName}`);
        }
        
        const totalEntries = Object.keys(playerScores).length;
        console.log(`📊 Loaded scores for ${totalEntries} player-owner combinations\n`);
        
        // Show sample data
        if (totalEntries > 0) {
            const sampleKey = Object.keys(playerScores)[0];
            const sample = playerScores[sampleKey];
            console.log(`📋 Sample data for ${sample.playerName} (${sample.owner}):`, sample.weeks);
            console.log('');
        }
        
        return playerScores;
    }

    // PFL Scoring System Implementation (same as before)
    calculatePFLScore(stats) {
        let score = 0;
        
        // Passing yards bonuses
        if (stats.passing_yards >= 400) score += 15;
        else if (stats.passing_yards >= 325) score += 12;
        else if (stats.passing_yards >= 250) score += 9;  // Per SCORING_SYSTEM.md
        else if (stats.passing_yards >= 175) score += 6;
        
        // Rushing yards bonuses
        if (stats.rushing_yards >= 200) score += 15;
        else if (stats.rushing_yards >= 150) score += 12;
        else if (stats.rushing_yards >= 100) score += 9;
        else if (stats.rushing_yards >= 75) score += 6;
        
        // Receiving yards bonuses
        if (stats.receiving_yards >= 200) score += 15;
        else if (stats.receiving_yards >= 150) score += 12;
        else if (stats.receiving_yards >= 100) score += 9;
        else if (stats.receiving_yards >= 75) score += 6;
        
        // Touchdowns - PFL rules are correct here
        score += (stats.passing_tds || 0) * 5;   // Touchdown pass (5 points per PFL rules)
        score += (stats.rushing_tds || 0) * 8;   // Touchdown scored  
        score += (stats.receiving_tds || 0) * 8; // Touchdown scored
        
        // Kicker scoring
        score += (stats.field_goals_made || 0) * 2;
        score += (stats.extra_points_made || 0) * 0.5;
        
        return Math.round(score * 100) / 100;
    }

    // Helper function to normalize player names for matching
    normalizePlayerName(name) {
        return name.toLowerCase()
                  .replace(/\*/g, '')               // Remove asterisks
                  .replace(/[.,]/g, '')             // Remove periods and commas
                  .replace(/\s+/g, ' ')             // Normalize whitespace
                  .replace(/\bjr\.?\b/g, 'jr')      // Normalize Jr/Jr.
                  .replace(/\bsr\.?\b/g, 'sr')      // Normalize Sr/Sr.
                  .replace(/\biii\b/g, 'iii')       // Normalize III
                  .replace(/\bii\b/g, 'ii')         // Normalize II
                  .trim();
    }

    // Find matching player in database
    async findDatabasePlayer(playerName) {
        return new Promise((resolve, reject) => {
            const normalizedTarget = this.normalizePlayerName(playerName);
            
            // First try exact match
            this.db.get(
                'SELECT DISTINCT player_name FROM player_stats WHERE LOWER(player_name) = ? LIMIT 1',
                [normalizedTarget],
                (err, row) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    
                    if (row) {
                        resolve(row.player_name);
                        return;
                    }
                    
                    // Try partial match on last name
                    const lastName = normalizedTarget.split(' ').pop();
                    this.db.get(
                        'SELECT DISTINCT player_name FROM player_stats WHERE LOWER(player_name) LIKE ? LIMIT 1',
                        [`%${lastName}%`],
                        (err, row) => {
                            if (err) {
                                reject(err);
                            } else {
                                resolve(row ? row.player_name : null);
                            }
                        }
                    );
                }
            );
        });
    }

    // Get database stats for specific player and week
    async getDatabasePlayerStats(playerName, week, season = 2024) {
        return new Promise((resolve, reject) => {
            this.db.get(`
                SELECT 
                    player_name,
                    week,
                    season,
                    passing_yards,
                    passing_tds,
                    rushing_yards,
                    rushing_tds,
                    receiving_yards,
                    receiving_tds,
                    receptions,
                    field_goals_made,
                    extra_points_made,
                    fantasy_points as tank01_score
                FROM player_stats 
                WHERE player_name = ? AND week = ? AND season = ?
            `, [playerName, week, season], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });
    }

    // Compare individual player scores
    async comparePlayerScores(fantasyData) {
        console.log('🔍 Comparing individual player scores...\n');
        
        const comparisons = [];
        const mismatches = [];
        
        for (const [key, playerData] of Object.entries(fantasyData)) {
            const { playerName, owner, weeks } = playerData;
            
            // Find matching player in database
            const dbPlayerName = await this.findDatabasePlayer(playerName);
            
            if (!dbPlayerName) {
                console.log(`⚠️  Could not find ${playerName} in database`);
                continue;
            }
            
            // Compare each week
            for (const [weekKey, weekData] of Object.entries(weeks)) {
                const weekNumber = parseInt(weekKey.replace('week', ''));
                const spreadsheetScore = weekData.score;
                const wasStarted = weekData.started;
                
                // Get database stats
                const dbStats = await this.getDatabasePlayerStats(dbPlayerName, weekNumber);
                
                if (!dbStats) {
                    console.log(`⚠️  No database stats for ${dbPlayerName} Week ${weekNumber}`);
                    continue;
                }
                
                // Calculate PFL score
                const calculatedPFLScore = this.calculatePFLScore(dbStats);
                const tank01Score = dbStats.tank01_score || 0;
                
                const comparison = {
                    player: playerName,
                    db_player: dbPlayerName,
                    owner: owner,
                    week: weekNumber,
                    spreadsheet_score: spreadsheetScore,
                    tank01_score: tank01Score,
                    calculated_pfl_score: calculatedPFLScore,
                    was_started: wasStarted,
                    stats: {
                        passing_yards: dbStats.passing_yards,
                        passing_tds: dbStats.passing_tds,
                        rushing_yards: dbStats.rushing_yards,
                        rushing_tds: dbStats.rushing_tds,
                        receiving_yards: dbStats.receiving_yards,
                        receiving_tds: dbStats.receiving_tds,
                        field_goals_made: dbStats.field_goals_made,
                        extra_points_made: dbStats.extra_points_made
                    }
                };
                
                // Check for mismatches
                const spreadsheetVsTank01 = Math.abs(spreadsheetScore - tank01Score) > 0.1;
                const spreadsheetVsPFL = Math.abs(spreadsheetScore - calculatedPFLScore) > 0.1;
                const tank01VsPFL = Math.abs(tank01Score - calculatedPFLScore) > 0.1;
                
                if (spreadsheetVsTank01 || spreadsheetVsPFL || tank01VsPFL) {
                    mismatches.push({
                        ...comparison,
                        spreadsheet_vs_tank01_diff: spreadsheetScore - tank01Score,
                        spreadsheet_vs_pfl_diff: spreadsheetScore - calculatedPFLScore,
                        tank01_vs_pfl_diff: tank01Score - calculatedPFLScore
                    });
                }
                
                comparisons.push(comparison);
            }
        }
        
        this.scoringMismatches = mismatches;
        return comparisons;
    }

    // Generate mismatch report
    generateMismatchReport() {
        console.log('\n📊 FANTASY SCORING COMPARISON REPORT\n');
        console.log('='.repeat(80));
        
        if (this.scoringMismatches.length === 0) {
            console.log('✅ No scoring mismatches found!');
            return;
        }
        
        console.log(`❌ Found ${this.scoringMismatches.length} scoring mismatches:\n`);
        
        // Group by type of mismatch
        const spreadsheetVsTank01 = this.scoringMismatches.filter(m => Math.abs(m.spreadsheet_vs_tank01_diff) > 0.1);
        const spreadsheetVsPFL = this.scoringMismatches.filter(m => Math.abs(m.spreadsheet_vs_pfl_diff) > 0.1);
        const tank01VsPFL = this.scoringMismatches.filter(m => Math.abs(m.tank01_vs_pfl_diff) > 0.1);
        
        if (spreadsheetVsTank01.length > 0) {
            console.log(`📋 Spreadsheet vs Tank01 Mismatches (${spreadsheetVsTank01.length}):`);
            spreadsheetVsTank01.slice(0, 10).forEach(mismatch => {
                console.log(`  ${mismatch.player} (${mismatch.owner}) Week ${mismatch.week}:`);
                console.log(`    Spreadsheet: ${mismatch.spreadsheet_score} | Tank01: ${mismatch.tank01_score} | Diff: ${mismatch.spreadsheet_vs_tank01_diff.toFixed(2)}`);
                console.log(`    Started: ${mismatch.was_started ? 'Yes' : 'No'}`);
                console.log('');
            });
            if (spreadsheetVsTank01.length > 10) {
                console.log(`    ... and ${spreadsheetVsTank01.length - 10} more\n`);
            }
        }
        
        if (spreadsheetVsPFL.length > 0) {
            console.log(`🏈 Spreadsheet vs PFL Calculation Mismatches (${spreadsheetVsPFL.length}):`);
            spreadsheetVsPFL.slice(0, 10).forEach(mismatch => {
                console.log(`  ${mismatch.player} (${mismatch.owner}) Week ${mismatch.week}:`);
                console.log(`    Spreadsheet: ${mismatch.spreadsheet_score} | PFL Calc: ${mismatch.calculated_pfl_score} | Diff: ${mismatch.spreadsheet_vs_pfl_diff.toFixed(2)}`);
                console.log(`    Stats: Pass ${mismatch.stats.passing_yards}y/${mismatch.stats.passing_tds}td, Rush ${mismatch.stats.rushing_yards}y/${mismatch.stats.rushing_tds}td, Rec ${mismatch.stats.receiving_yards}y/${mismatch.stats.receiving_tds}td`);
                console.log('');
            });
            if (spreadsheetVsPFL.length > 10) {
                console.log(`    ... and ${spreadsheetVsPFL.length - 10} more\n`);
            }
        }
    }

    // Export detailed results to CSV
    exportToCSV(filename = 'fantasy_scoring_comparison.csv') {
        if (this.scoringMismatches.length === 0) {
            console.log('No mismatches to export');
            return;
        }
        
        const headers = [
            'player', 'owner', 'week', 'was_started',
            'spreadsheet_score', 'tank01_score', 'calculated_pfl_score',
            'spreadsheet_vs_tank01_diff', 'spreadsheet_vs_pfl_diff', 'tank01_vs_pfl_diff',
            'passing_yards', 'passing_tds', 'rushing_yards', 'rushing_tds',
            'receiving_yards', 'receiving_tds', 'field_goals_made', 'extra_points_made'
        ];
        
        const csvRows = [headers.join(',')];
        
        this.scoringMismatches.forEach(mismatch => {
            const row = [
                mismatch.player,
                mismatch.owner,
                mismatch.week,
                mismatch.was_started,
                mismatch.spreadsheet_score,
                mismatch.tank01_score,
                mismatch.calculated_pfl_score,
                mismatch.spreadsheet_vs_tank01_diff.toFixed(2),
                mismatch.spreadsheet_vs_pfl_diff.toFixed(2),
                mismatch.tank01_vs_pfl_diff.toFixed(2),
                mismatch.stats.passing_yards,
                mismatch.stats.passing_tds,
                mismatch.stats.rushing_yards,
                mismatch.stats.rushing_tds,
                mismatch.stats.receiving_yards,
                mismatch.stats.receiving_tds,
                mismatch.stats.field_goals_made,
                mismatch.stats.extra_points_made
            ];
            csvRows.push(row.join(','));
        });
        
        fs.writeFileSync(filename, csvRows.join('\n'));
        console.log(`📁 Exported ${this.scoringMismatches.length} mismatches to ${filename}`);
    }

    // Main execution
    async run(excelPath) {
        try {
            console.log('🏈 Starting Fantasy Roster Scoring Comparison...\n');
            
            // Load fantasy roster data
            const fantasyData = await this.loadFantasyRosterData(excelPath);
            
            // Compare scores
            const comparisons = await this.comparePlayerScores(fantasyData);
            
            // Generate report
            this.generateMismatchReport();
            
            // Export to CSV
            this.exportToCSV();
            
            console.log(`\n✅ Comparison complete! Analyzed ${comparisons.length} player-week records.`);
            
        } catch (error) {
            console.error('❌ Error during comparison:', error);
        } finally {
            this.db.close();
        }
    }
}

// Main execution
async function main() {
    const excelPath = process.argv[2] || '/Users/joepaley/projects/statfink2/unused/PFL 2024.xlsx';
    const comparison = new FantasyRosterComparison();
    await comparison.run(excelPath);
}

if (require.main === module) {
    main();
}

module.exports = { FantasyRosterComparison };