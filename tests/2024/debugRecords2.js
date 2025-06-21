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

console.log('Teams and their columns:');
teams.forEach(team => {
    console.log(`${team.name}: column ${team.col}`);
});

console.log('\nLooking specifically at row 37 (record row):');
const recordRow = data[36]; // 0-indexed
console.log('Full row:', recordRow);

teams.forEach(team => {
    const cell = recordRow[team.col];
    console.log(`${team.name} (col ${team.col}): "${cell}"`);
    
    if (cell && typeof cell === 'string') {
        const recordMatch = cell.match(/^(\d+)-(\d+)(-(\d+))?$/);
        if (recordMatch) {
            console.log(`  -> MATCHED RECORD: ${recordMatch[1]}-${recordMatch[2]}`);
        }
    }
});