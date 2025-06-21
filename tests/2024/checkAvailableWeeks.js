#!/usr/bin/env node

const XLSX = require('xlsx');
const path = require('path');

// Load Excel file
const excelPath = path.join(__dirname, 'PFL 2024.xlsx');
const workbook = XLSX.readFile(excelPath);

console.log('=== AVAILABLE WEEK SHEETS ===\n');

// Find all week sheets
const weekSheets = [];
for (let week = 1; week <= 17; week++) {
    const sheetName = `Week ${week}`;
    if (workbook.Sheets[sheetName]) {
        weekSheets.push(week);
        console.log(`✅ Week ${week}: Sheet exists`);
    } else {
        console.log(`❌ Week ${week}: Sheet NOT found`);
    }
}

console.log(`\nTotal available weeks: ${weekSheets.length}`);
console.log(`Available weeks: ${weekSheets.join(', ')}`);

console.log('\n=== ALL SHEET NAMES ===');
console.log(workbook.SheetNames.join(', '));