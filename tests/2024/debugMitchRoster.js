#!/usr/bin/env node

const XLSX = require('xlsx');
const path = require('path');

// Load Excel file
const excelPath = path.join(__dirname, 'PFL 2024.xlsx');
const workbook = XLSX.readFile(excelPath);

// Team mapping
const teamMapping = {
    'Mitch': 1, 'Cal': 2, 'Eli': 3, 'Chris': 4, 'Mike': 5, 'Joe': 6,
    'Dan': 7, 'Aaron': 8, 'Sean': 9, 'Matt': 10, 'Bruce': 11, 'Pete': 12
};

// Look at Week 1 structure focusing on Mitch (column 1)
const worksheet = workbook.Sheets['Week 1'];
const data = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

console.log('=== MITCH ROSTER ANALYSIS (Column 1) ===\n');

// Find Mitch's column
let mitchCol = -1;
for (let i = 0; i < data[0].length; i++) {
    if (data[0][i] === 'Mitch') {
        mitchCol = i;
        break;
    }
}

console.log(`Mitch is in column ${mitchCol}`);

let currentPosition = null;
const mitchRoster = [];

for (let rowIdx = 1; rowIdx < data.length; rowIdx++) {
    const row = data[rowIdx];
    const firstCell = row[0];
    const mitchCell = row[mitchCol];
    
    // Check for position header
    if (firstCell && typeof firstCell === 'string') {
        const posHeader = firstCell.trim().toUpperCase();
        if (['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'D/ST', 'DEF'].includes(posHeader)) {
            currentPosition = posHeader === 'D/ST' || posHeader === 'DST' ? 'DEF' : posHeader;
            console.log(`\n=== ${currentPosition} SECTION ===`);
        }
    }
    
    // Check Mitch's cell
    if (mitchCell && mitchCell !== '' && typeof mitchCell === 'string') {
        const cellStr = mitchCell.toString().trim();
        
        // Skip numeric values and obvious non-players
        if (!/^\d*\.?\d+$/.test(cellStr) && 
            !cellStr.includes('=') && 
            cellStr !== 'PTS' && 
            cellStr.length >= 3 &&
            // Skip summary rows (stop parsing when we hit weekly summary data)
            !(cellStr.includes('WK.') || cellStr.includes('CUM') || 
              /^\d+-\d+$/.test(cellStr) || // Match "0-1", "1-0" pattern
              (cellStr.includes('(') && /\d+\.?\d*/.test(cellStr)) || // Match "Cal(104.5)" pattern
              ['Loss', 'Win', 'Week'].includes(cellStr))) {
            
            console.log(`Row ${rowIdx + 1}: "${mitchCell}" (Position: ${currentPosition || 'UNKNOWN'})`);
            
            if (currentPosition) {
                mitchRoster.push({
                    position: currentPosition,
                    player: mitchCell,
                    row: rowIdx + 1
                });
            }
        }
    }
}

console.log(`\n=== MITCH TOTAL ROSTER ===`);
console.log(`Total players found: ${mitchRoster.length}`);

// Group by position
const byPosition = {};
mitchRoster.forEach(player => {
    if (!byPosition[player.position]) {
        byPosition[player.position] = [];
    }
    byPosition[player.position].push(player.player);
});

Object.keys(byPosition).forEach(pos => {
    console.log(`${pos}: ${byPosition[pos].length} players`);
    byPosition[pos].forEach(player => {
        console.log(`  - ${player}`);
    });
});

console.log(`\nExpected: 19 players total`);
console.log(`Found: ${mitchRoster.length} players`);
console.log(`Missing: ${19 - mitchRoster.length} players`);