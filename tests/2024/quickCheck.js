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

console.log('Teams found:', teams.map(t => `${t.name}(col ${t.col})`).join(', '));

// Quick count for each team
teams.forEach(team => {
    let playerCount = 0;
    
    for (let rowIdx = 1; rowIdx < data.length; rowIdx++) {
        const row = data[rowIdx];
        const cell = row[team.col];
        
        if (cell && typeof cell === 'string' && cell !== '' && 
            !cell.includes('=') && cell !== 'PTS' && cell.length >= 3 &&
            !/^\d*\.?\d+$/.test(cell.trim()) &&
            !(cell.includes('WK.') || cell.includes('CUM') || 
              /^\d+-\d+$/.test(cell) || 
              /^[A-Za-z]+\(\d+\.?\d*\)$/.test(cell) || 
              ['Loss', 'Win', 'Week'].includes(cell))) {
            playerCount++;
        }
    }
    
    console.log(`${team.name}: ${playerCount} players`);
});