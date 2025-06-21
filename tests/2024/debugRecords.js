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

console.log('=== RECORD DEBUGGING ===\n');
console.log('Looking for record data in Week 1...\n');

// Look for record-like data in rows 30-50
for (let rowIdx = 30; rowIdx < Math.min(data.length, 50); rowIdx++) {
    const row = data[rowIdx];
    if (!row || row.length === 0) continue;

    const firstCell = row[0];
    if (!firstCell) continue;

    const cellStr = firstCell.toString().trim();
    
    // Check if this might be a record row
    if (/^[0-9]/.test(cellStr) || cellStr.includes('-') || cellStr.includes('Win') || cellStr.includes('Loss')) {
        console.log(`Row ${rowIdx + 1}: "${cellStr}"`);
        
        // Show what's in each team column for this row
        teams.forEach(team => {
            const cell = row[team.col];
            if (cell && cell !== '') {
                console.log(`  ${team.name}: "${cell}"`);
            }
        });
        console.log('');
    }
}

console.log('=== Raw rows 30-40 for reference ===');
for (let i = 30; i < 40 && i < data.length; i++) {
    const row = data[i];
    console.log(`Row ${i + 1}:`, row.slice(0, 5)); // Show first 5 columns
}