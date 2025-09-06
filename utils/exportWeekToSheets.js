#!/usr/bin/env node

/**
 * Command-line tool to export weekly standings to Google Sheets
 * 
 * Usage:
 *   node exportWeekToSheets.js --sheet-id YOUR_SHEET_ID --week 8 --season 2025
 *   node exportWeekToSheets.js --sheet-id YOUR_SHEET_ID --all --season 2025
 *   node exportWeekToSheets.js --sheet-url "https://docs.google.com/spreadsheets/d/..." --week 8
 */

const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// Add server directory to require paths
require('module').Module._nodeModulePaths = function(from) {
    const paths = [];
    let current = from;
    while (current !== '/') {
        paths.push(path.join(current, 'node_modules'));
        current = path.dirname(current);
    }
    return paths;
};

// Import services
const GoogleSheetsExportService = require('../server/services/googleSheetsExportService');
const StandingsExportService = require('../server/services/standingsExportService');
const DatabaseManager = require('../server/database/database');

// Parse command line arguments
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        sheetId: null,
        week: null,
        season: new Date().getFullYear(),
        all: false,
        help: false
    };
    
    for (let i = 0; i < args.length; i++) {
        switch(args[i]) {
            case '--sheet-id':
            case '-s':
                options.sheetId = args[++i];
                break;
            case '--sheet-url':
            case '-u':
                options.sheetId = args[++i];
                break;
            case '--week':
            case '-w':
                options.week = parseInt(args[++i]);
                break;
            case '--season':
            case '-y':
                options.season = parseInt(args[++i]);
                break;
            case '--all':
            case '-a':
                options.all = true;
                break;
            case '--help':
            case '-h':
                options.help = true;
                break;
        }
    }
    
    return options;
}

function showHelp() {
    console.log(`
Google Sheets Export Tool for StatFink

Usage:
  node exportWeekToSheets.js [options]

Options:
  --sheet-id, -s ID      Google Sheets ID (required)
  --sheet-url, -u URL    Google Sheets URL (alternative to --sheet-id)
  --week, -w NUMBER      Week number to export (1-18)
  --season, -y YEAR      Season year (default: current year)
  --all, -a              Export all completed weeks
  --help, -h             Show this help message

Examples:
  Export single week:
    node exportWeekToSheets.js --sheet-id 1abc...xyz --week 8 --season 2025
  
  Export all weeks:
    node exportWeekToSheets.js --sheet-id 1abc...xyz --all --season 2025
  
  Using sheet URL:
    node exportWeekToSheets.js --sheet-url "https://docs.google.com/spreadsheets/d/1abc...xyz/edit" --week 8
`);
}

async function main() {
    const options = parseArgs();
    
    if (options.help) {
        showHelp();
        process.exit(0);
    }
    
    if (!options.sheetId) {
        console.error('Error: Google Sheets ID or URL is required');
        console.error('Use --help for usage information');
        process.exit(1);
    }
    
    if (!options.all && !options.week) {
        console.error('Error: Either --week or --all must be specified');
        console.error('Use --help for usage information');
        process.exit(1);
    }
    
    console.log('Starting Google Sheets export...');
    console.log(`Season: ${options.season}`);
    
    let db;
    
    try {
        // Initialize database
        console.log('Connecting to database...');
        db = new DatabaseManager();
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for DB init
        
        // Initialize services
        console.log('Initializing Google Sheets service...');
        const googleSheets = new GoogleSheetsExportService();
        await googleSheets.initialize();
        
        const exportService = new StandingsExportService(db);
        
        // Extract spreadsheet ID
        const spreadsheetId = googleSheets.extractSpreadsheetId(options.sheetId);
        console.log(`Spreadsheet ID: ${spreadsheetId}`);
        
        if (options.all) {
            // Export all completed weeks
            console.log('Getting list of completed weeks...');
            const weeks = await exportService.getCompletedWeeks(options.season);
            
            if (weeks.length === 0) {
                console.error(`No completed weeks found for season ${options.season}`);
                process.exit(1);
            }
            
            console.log(`Found ${weeks.length} completed weeks: ${weeks.join(', ')}`);
            
            for (const week of weeks) {
                console.log(`\nExporting Week ${week}...`);
                const exportData = await exportService.getWeeklyExportData(week, options.season);
                const gridData = await exportService.getRosteredPlayersGrid(week, options.season);
                
                // Verify data
                console.log(`  - Teams: ${exportData.teams.length}`);
                console.log(`  - Matchups: ${exportData.matchups.length}`);
                console.log(`  - Players: ${gridData.playerCount}`);
                
                await googleSheets.writeWeeklyData(spreadsheetId, week, options.season, exportData, gridData);
                console.log(`  ✓ Week ${week} exported successfully`);
            }
            
            console.log(`\n✓ All ${weeks.length} weeks exported successfully!`);
        } else {
            // Export single week
            console.log(`Exporting Week ${options.week}...`);
            const exportData = await exportService.getWeeklyExportData(options.week, options.season);
            const gridData = await exportService.getRosteredPlayersGrid(options.week, options.season);
            
            // Verify data
            console.log(`  - Teams: ${exportData.teams.length}`);
            console.log(`  - Matchups: ${exportData.matchups.length}`);
            console.log(`  - Players: ${gridData.playerCount}`);
            
            // Check for roster issues
            for (const team of exportData.teams) {
                if (team.roster.length !== 19) {
                    console.warn(`  ⚠ Warning: ${team.team_name} has ${team.roster.length} players (expected 19)`);
                }
            }
            
            await googleSheets.writeWeeklyData(spreadsheetId, options.week, options.season, exportData, gridData);
            console.log(`\n✓ Week ${options.week} exported successfully!`);
        }
        
        console.log(`\nView your spreadsheet at:`);
        console.log(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);
        
    } catch (error) {
        console.error('\n❌ Export failed:', error.message);
        if (error.stack) {
            console.error('\nStack trace:');
            console.error(error.stack);
        }
        process.exit(1);
    } finally {
        if (db && db.db) {
            db.db.close();
        }
    }
}

// Run the tool
main().catch(error => {
    console.error('Unexpected error:', error);
    process.exit(1);
});