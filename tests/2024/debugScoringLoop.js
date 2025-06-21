#!/usr/bin/env node

const XLSX = require('xlsx');
const path = require('path');

// Team mapping  
const teamMapping = {
    'Mitch': 1, 'Cal': 2, 'Eli': 3, 'Chris': 4, 'Mike': 5, 'Joe': 6,
    'Dan': 7, 'Aaron': 8, 'Sean': 9, 'Matt': 10, 'Bruce': 11, 'Pete': 12
};

// Load Excel file
const excelPath = path.join(__dirname, 'PFL 2024.xlsx');
const workbook = XLSX.readFile(excelPath);
const worksheet = workbook.Sheets['Week 1'];
const data = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

// Find team columns
const teamRow = data[0];
const teams = [];
for (let i = 0; i < teamRow.length; i++) {
    const cell = teamRow[i];
    if (cell && cell !== '' && cell !== 'PTS' && teamMapping[cell]) {
        teams.push({ col: i, name: cell, id: teamMapping[cell] });
    }
}

console.log('=== DEBUGGING SCORING LOOP ===\n');
console.log(`Data length: ${data.length}`);
console.log(`Search range: rows 30-${Math.min(data.length, 50) - 1} (0-indexed)`);

// Look for scoring rows - exactly like in the main script
for (let rowIdx = 30; rowIdx < Math.min(data.length, 50); rowIdx++) {
    const row = data[rowIdx];
    if (!row || row.length === 0) {
        console.log(`Row ${rowIdx}: EMPTY, continuing...`);
        continue;
    }

    const firstCell = row[0];
    const cellStr = firstCell ? firstCell.toString().trim() : '';
    
    console.log(`Row ${rowIdx} (${rowIdx + 1}): firstCell="${cellStr}"`);
    
    // Weekly points row (WK.)
    if (cellStr === 'WK.') {
        console.log(`  -> WEEKLY POINTS ROW FOUND`);
    }
    
    // Cumulative points row (CUM)
    if (cellStr === 'CUM') {
        console.log(`  -> CUMULATIVE POINTS ROW FOUND`);
    }
    
    // Check for records in any team column
    let recordFound = false;
    teams.forEach(team => {
        const cell = row[team.col];
        if (cell && typeof cell === 'string') {
            const recordMatch = cell.match(/^(\d+)-(\d+)(-(\d+))?$/);
            if (recordMatch) {
                console.log(`  -> RECORD FOUND: ${team.name} = "${cell}"`);
                recordFound = true;
            }
        }
    });
    
    if (recordFound) {
        console.log(`  -> RECORD ROW DETECTED`);
    }
    
    // Show some data from key rows
    if (rowIdx >= 35 && rowIdx <= 38) {
        console.log(`    Full row: [${row.slice(0, 5).map(c => `"${c}"`).join(', ')}...]`);
    }
}