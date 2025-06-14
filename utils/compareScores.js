#!/usr/bin/env node

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const dbPath = path.join(__dirname, '../fantasy_football.db');
const excelPath = path.join(__dirname, 'PFL 2024.xlsx');

class ScoreComparison {
    constructor() {
        this.db = new sqlite3.Database(dbPath);
        this.mismatches = [];
    }

    // Load Excel spreadsheet data
    async loadSpreadsheetData() {
        if (!fs.existsSync(excelPath)) {
            throw new Error(`Excel file not found: ${excelPath}`);
        }

        console.log('📋 Loading Excel spreadsheet data...');
        
        const workbook = XLSX.readFile(excelPath);
        const playerScores = {};
        
        // Get week stats sheets
        const sheetNames = workbook.SheetNames;
        const weekSheets = sheetNames.filter(name => 
            name.toLowerCase().includes('week') && name.toLowerCase().includes('stats')
        );
        
        console.log(`📊 Found ${weekSheets.length} week sheets`);
        
        for (const sheetName of weekSheets) {
            const weekMatch = sheetName.match(/week\s*(\d+)/i);
            if (!weekMatch) continue;
            
            const weekNumber = parseInt(weekMatch[1]);
            const worksheet = workbook.Sheets[sheetName];
            const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
            
            if (data.length === 0) continue;
            
            // Find header row with owner names
            let headerRow = null;
            let headerRowIndex = -1;
            
            for (let i = 0; i < Math.min(5, data.length); i++) {
                const row = data[i];
                if (row && row.length > 10) {
                    const potentialOwners = row.filter(cell => 
                        cell && typeof cell === 'string' && 
                        cell.length > 1 && cell.length < 10 &&
                        !cell.toLowerCase().includes('pts')
                    );
                    
                    if (potentialOwners.length >= 5) {
                        headerRow = row;
                        headerRowIndex = i;
                        break;
                    }
                }
            }
            
            if (!headerRow) continue;
            
            // Extract owner columns (Pattern: Position, Owner1, PTS, Owner2, PTS, etc.)
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
            
            // Process data rows to extract player scores
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
                    
                    // Parse player name (remove team info in parentheses)
                    let playerName = String(playerCell).trim();
                    const parenIndex = playerName.indexOf('(');
                    if (parenIndex > 0) {
                        playerName = playerName.substring(0, parenIndex).trim();
                    }
                    
                    // Skip team names, position headers, and short names
                    if (playerName.length < 3 || 
                        ['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'Defense'].includes(playerName) ||
                        (playerName.endsWith('s') && playerName.length < 8)) {
                        continue;
                    }
                    
                    // Parse points (handle asterisks for started players and X for no play)
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
                    }
                }
            }
        }
        
        console.log(`📊 Loaded scores for ${Object.keys(playerScores).length} player-owner combinations\n`);
        return playerScores;
    }

    // Normalize player names for matching
    normalizePlayerName(name) {
        return name.toLowerCase()
                  .replace(/\*/g, '')
                  .replace(/[.,]/g, '')
                  .replace(/\s+/g, ' ')
                  .replace(/\bjr\.?\b/g, 'jr')
                  .replace(/\bsr\.?\b/g, 'sr')
                  .replace(/\biii\b/g, 'iii')
                  .replace(/\bii\b/g, 'ii')
                  .trim();
    }

    // Find matching player in database
    async findDatabasePlayer(playerName) {
        return new Promise((resolve, reject) => {
            const normalizedTarget = this.normalizePlayerName(playerName);
            
            // Try exact match first
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

    // Get database fantasy points for specific player and week
    async getDatabaseScore(playerName, week, season = 2024) {
        return new Promise((resolve, reject) => {
            this.db.get(`
                SELECT 
                    player_name,
                    week,
                    season,
                    fantasy_points as database_score
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

    // Compare database scores vs spreadsheet scores
    async compareScores(spreadsheetData) {
        console.log('🔍 Comparing database vs spreadsheet scores...\n');
        
        const comparisons = [];
        let foundCount = 0;
        let notFoundCount = 0;
        
        for (const [key, playerData] of Object.entries(spreadsheetData)) {
            const { playerName, owner, weeks } = playerData;
            
            // Find matching player in database
            const dbPlayerName = await this.findDatabasePlayer(playerName);
            
            if (!dbPlayerName) {
                notFoundCount++;
                continue;
            }
            
            foundCount++;
            
            // Compare each week
            for (const [weekKey, weekData] of Object.entries(weeks)) {
                const weekNumber = parseInt(weekKey.replace('week', ''));
                const spreadsheetScore = weekData.score;
                const wasStarted = weekData.started;
                
                // Get database score
                const dbResult = await this.getDatabaseScore(dbPlayerName, weekNumber);
                
                if (!dbResult) {
                    continue; // No database stats for this player/week
                }
                
                const databaseScore = dbResult.database_score || 0;
                const difference = Math.abs(spreadsheetScore - databaseScore);
                
                const comparison = {
                    player: playerName,
                    db_player: dbPlayerName,
                    owner: owner,
                    week: weekNumber,
                    spreadsheet_score: spreadsheetScore,
                    database_score: databaseScore,
                    difference: difference,
                    was_started: wasStarted
                };
                
                // Check for mismatches (more than 0.1 point difference)
                if (difference > 0.1) {
                    this.mismatches.push({
                        ...comparison,
                        spreadsheet_vs_database_diff: spreadsheetScore - databaseScore
                    });
                }
                
                comparisons.push(comparison);
            }
        }
        
        console.log(`📊 Player matching: ${foundCount} found, ${notFoundCount} not found in database`);
        return comparisons;
    }

    // Print mismatch report
    printMismatches() {
        console.log('\n' + '='.repeat(80));
        console.log('📊 DATABASE vs SPREADSHEET SCORE MISMATCHES');
        console.log('='.repeat(80));
        
        if (this.mismatches.length === 0) {
            console.log('✅ No mismatches found! Database scores perfectly match spreadsheet.');
            return;
        }
        
        console.log(`\n❌ Found ${this.mismatches.length} scoring mismatches:\n`);
        
        // Sort by week number
        const sortedMismatches = this.mismatches.sort((a, b) => a.week - b.week);
        
        // Print all mismatches
        sortedMismatches.forEach((mismatch, index) => {
            const diff = mismatch.spreadsheet_vs_database_diff;
            const diffStr = diff > 0 ? `+${diff.toFixed(1)}` : `${diff.toFixed(1)}`;
            const startedStr = mismatch.was_started ? '(Started)' : '(Bench)';
            
            console.log(`${index + 1}. ${mismatch.player} (${mismatch.owner}) Week ${mismatch.week} ${startedStr}`);
            console.log(`   Spreadsheet: ${mismatch.spreadsheet_score} | Database: ${mismatch.database_score} | Diff: ${diffStr}`);
            console.log('');
        });
        
        // Print statistics
        const avgDifference = this.mismatches.reduce((sum, m) => sum + Math.abs(m.difference), 0) / this.mismatches.length;
        const maxDifference = Math.max(...this.mismatches.map(m => Math.abs(m.difference)));
        
        console.log('='.repeat(80));
        console.log('📈 MISMATCH STATISTICS:');
        console.log(`  Total mismatches: ${this.mismatches.length}`);
        console.log(`  Average difference: ${avgDifference.toFixed(2)} points`);
        console.log(`  Maximum difference: ${maxDifference.toFixed(2)} points`);
        
        // Count by difference ranges
        const ranges = {
            'Small (0.1-1.0)': this.mismatches.filter(m => m.difference >= 0.1 && m.difference <= 1.0).length,
            'Medium (1.1-3.0)': this.mismatches.filter(m => m.difference > 1.0 && m.difference <= 3.0).length,
            'Large (3.1-10.0)': this.mismatches.filter(m => m.difference > 3.0 && m.difference <= 10.0).length,
            'Very Large (>10.0)': this.mismatches.filter(m => m.difference > 10.0).length
        };
        
        console.log('\n📊 DIFFERENCE RANGES:');
        Object.entries(ranges).forEach(([range, count]) => {
            if (count > 0) {
                console.log(`  ${range}: ${count} mismatches`);
            }
        });
        console.log('='.repeat(80));
    }

    // Main execution
    async run() {
        try {
            console.log('🏈 Starting Database vs Spreadsheet Score Comparison...\n');
            
            // Load spreadsheet data
            const spreadsheetData = await this.loadSpreadsheetData();
            
            // Compare scores
            const comparisons = await this.compareScores(spreadsheetData);
            
            // Print mismatches
            this.printMismatches();
            
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
    const comparison = new ScoreComparison();
    await comparison.run();
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = { ScoreComparison };