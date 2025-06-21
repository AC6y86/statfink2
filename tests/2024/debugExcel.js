#!/usr/bin/env node

const XLSX = require('xlsx');
const path = require('path');

// Load Excel file
const excelPath = path.join(__dirname, 'PFL 2024.xlsx');
const workbook = XLSX.readFile(excelPath);

// Look at Week 1 structure
const worksheet = workbook.Sheets['Week 1'];
const data = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

console.log('=== WEEK 1 STRUCTURE DEBUG ===\n');

// Show first 40 rows to understand structure
for (let i = 0; i < Math.min(40, data.length); i++) {
    const row = data[i];
    const rowNum = i + 1;
    
    // Show first column and a few team columns
    console.log(`Row ${rowNum}: [${row[0]}] [${row[1]}] [${row[2]}] [${row[3]}] [${row[4]}]`);
    
    // If first column looks like a position, highlight it
    if (row[0] && typeof row[0] === 'string') {
        const firstCell = row[0].toString().trim().toUpperCase();
        if (['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'D/ST', 'DEF'].includes(firstCell)) {
            console.log(`  ^^^ POSITION HEADER: ${firstCell} ^^^`);
        }
    }
}

console.log('\n=== TEAM HEADERS (Row 1) ===');
const teamRow = data[0];
for (let i = 0; i < teamRow.length; i++) {
    if (teamRow[i]) {
        console.log(`Column ${i}: "${teamRow[i]}"`);
    }
}