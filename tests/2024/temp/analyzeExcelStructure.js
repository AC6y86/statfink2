#!/usr/bin/env node

const XLSX = require('xlsx');
const path = require('path');

const excelPath = path.join(__dirname, '../PFL 2024.xlsx');

console.log('📊 Analyzing Excel structure for fantasy points...\n');

const workbook = XLSX.readFile(excelPath);

// Look at Week 16 sheet structure
const sheetName = 'Week 16';
const worksheet = workbook.Sheets[sheetName];
const data = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

console.log(`=== ${sheetName} Structure ===`);
console.log(`Total rows: ${data.length}`);
console.log(`Total columns: ${data[0] ? data[0].length : 0}`);

// Show first few rows to understand structure
console.log('\nFirst 10 rows:');
for (let i = 0; i < Math.min(10, data.length); i++) {
    const row = data[i];
    console.log(`Row ${i + 1}:`, row.slice(0, 15)); // Show first 15 columns
}

// Look for patterns around team columns
console.log('\n=== Team Header Analysis ===');
const teamRow = data[0];
const teams = ['Mitch', 'Cal', 'Eli', 'Chris', 'Mike', 'Joe', 'Dan', 'Aaron', 'Sean', 'Matt', 'Bruce', 'Pete'];

teams.forEach(teamName => {
    const teamColIndex = teamRow.findIndex(cell => cell === teamName);
    if (teamColIndex !== -1) {
        console.log(`${teamName} is in column ${teamColIndex + 1} (index ${teamColIndex})`);
        // Check the adjacent columns
        const ptsColIndex = teamColIndex + 1;
        if (ptsColIndex < teamRow.length) {
            console.log(`  Next column (${ptsColIndex + 1}): "${teamRow[ptsColIndex]}"`);
            
            // Show some data from this points column
            console.log(`  Sample data from points column:`);
            for (let i = 1; i < Math.min(6, data.length); i++) {
                const row = data[i];
                const ptsValue = row[ptsColIndex];
                if (ptsValue !== undefined && ptsValue !== '') {
                    console.log(`    Row ${i + 1}: ${ptsValue} (type: ${typeof ptsValue})`);
                }
            }
        }
    }
});

// Look for scoring sections
console.log('\n=== Looking for Scoring Sections ===');
for (let rowIdx = 0; rowIdx < data.length; rowIdx++) {
    const row = data[rowIdx];
    const firstCell = row[0];
    if (firstCell && typeof firstCell === 'string') {
        const cellStr = firstCell.trim();
        if (['WK.', 'CUM', 'TOTAL', 'POINTS'].includes(cellStr.toUpperCase()) || 
            cellStr.includes('WEEK') || cellStr.includes('POINT')) {
            console.log(`Row ${rowIdx + 1}: "${cellStr}"`);
            console.log(`  Data:`, row.slice(0, 10));
        }
    }
}

// Look at the actual player data structure
console.log('\n=== Player Data Structure Analysis ===');
console.log('Looking for rows with player names and adjacent point values...');

for (let rowIdx = 1; rowIdx < Math.min(40, data.length); rowIdx++) {
    const row = data[rowIdx];
    
    // Look for Mitch's column (assuming column 0 based on previous output)
    const mitchColIndex = teamRow.findIndex(cell => cell === 'Mitch');
    if (mitchColIndex !== -1) {
        const playerCell = row[mitchColIndex];
        const ptsCell = row[mitchColIndex + 1];
        
        if (playerCell && typeof playerCell === 'string' && playerCell.includes('(')) {
            console.log(`Row ${rowIdx + 1}: Player="${playerCell}" | Points="${ptsCell}" (${typeof ptsCell})`);
        }
    }
}