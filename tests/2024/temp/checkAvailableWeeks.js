#!/usr/bin/env node

const XLSX = require('xlsx');
const path = require('path');

const excelPath = path.join(__dirname, '../PFL 2024.xlsx');

console.log('📊 Checking all available weeks in Excel file...\n');

const workbook = XLSX.readFile(excelPath);

console.log('All sheets in workbook:');
workbook.SheetNames.forEach((name, index) => {
    console.log(`${index + 1}. ${name}`);
});

console.log('\n=== Week Analysis ===');

// Check for all possible week sheets
const weekSheets = [];
const availableWeeks = [];

for (let week = 1; week <= 18; week++) {
    const sheetName = `Week ${week}`;
    if (workbook.Sheets[sheetName]) {
        weekSheets.push(sheetName);
        availableWeeks.push(week);
        console.log(`✅ Week ${week} - Sheet exists`);
    } else {
        console.log(`❌ Week ${week} - Sheet missing`);
    }
}

console.log(`\nFound ${availableWeeks.length} week sheets: ${availableWeeks.join(', ')}`);

// Check what we're currently extracting
console.log('\n=== Current extraction config ===');
const currentWeeks = [1, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
console.log('Currently extracting weeks:', currentWeeks.join(', '));

const missingFromCurrent = availableWeeks.filter(week => !currentWeeks.includes(week));
const missingFromExcel = currentWeeks.filter(week => !availableWeeks.includes(week));

if (missingFromCurrent.length > 0) {
    console.log('⚠️  Weeks available but not being extracted:', missingFromCurrent.join(', '));
}

if (missingFromExcel.length > 0) {
    console.log('❌ Weeks in config but missing from Excel:', missingFromExcel.join(', '));
}

console.log('\n=== Quick data check for missing weeks ===');
missingFromCurrent.forEach(week => {
    const sheetName = `Week ${week}`;
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
    
    console.log(`\nWeek ${week}:`);
    console.log(`  Rows: ${data.length}`);
    console.log(`  First row: ${JSON.stringify(data[0]?.slice(0, 10))}`);
    
    // Check if it has team names
    const firstRow = data[0] || [];
    const hasTeamNames = ['Mitch', 'Cal', 'Eli'].some(team => firstRow.includes(team));
    console.log(`  Has team names: ${hasTeamNames ? '✅' : '❌'}`);
});