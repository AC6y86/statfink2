#!/usr/bin/env node

const XLSX = require('xlsx');
const path = require('path');

// Team mapping
const teamMapping = {
    'Mitch': 1, 'Cal': 2, 'Eli': 3, 'Chris': 4, 'Mike': 5, 'Joe': 6,
    'Dan': 7, 'Aaron': 8, 'Sean': 9, 'Matt': 10, 'Bruce': 11, 'Pete': 12
};

function parsePlayerName(playerText) {
    if (!playerText || playerText === '' || typeof playerText !== 'string') {
        return null;
    }
    
    // Remove leading * (starter indicator) and clean
    let cleanText = playerText.replace(/^\*/, '').trim();
    
    // Extract player name and team - format: "Player Name(TEAM)"
    const match = cleanText.match(/^([^(]+)\(([^)]+)\)/);
    if (match) {
        const playerName = match[1].trim();
        const teamAbbrev = match[2].trim();
        return { 
            name: playerName, 
            team: teamAbbrev,
            isStarter: playerText.startsWith('*')
        };
    }
    
    return null;
}

// Load Excel and test parsing
const excelPath = path.join(__dirname, 'PFL 2024.xlsx');
const workbook = XLSX.readFile(excelPath);
const worksheet = workbook.Sheets['Week 1'];
const data = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

console.log('=== TESTING EXTRACTION LOGIC ON MITCH ===\n');

// Find Mitch's column
let mitchCol = 1; // We know it's column 1

let currentPosition = null;
const mitchPlayers = [];

for (let rowIdx = 1; rowIdx < data.length; rowIdx++) {
    const row = data[rowIdx];
    const firstCell = row[0];
    const mitchCell = row[mitchCol];
    
    // Check for position header
    if (firstCell && typeof firstCell === 'string') {
        const posHeader = firstCell.trim().toUpperCase();
        if (['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'D/ST', 'DEF'].includes(posHeader)) {
            currentPosition = posHeader === 'D/ST' || posHeader === 'DST' ? 'DEF' : posHeader;
            console.log(`\n--- ${currentPosition} SECTION ---`);
        }
    }
    
    if (!currentPosition) continue;

    // Process Mitch's cell using same logic as extraction script
    if (!mitchCell || mitchCell === '') continue;

    // Skip numeric values (scores)
    if (typeof mitchCell === 'number' || (typeof mitchCell === 'string' && /^\d*\.?\d+$/.test(mitchCell.trim()))) {
        continue;
    }

    // Skip obviously non-player data
    const cellStr = mitchCell.toString().trim();
    if (cellStr.includes('=') || cellStr === 'PTS' || cellStr.length < 3) {
        continue;
    }
    
    // Skip summary rows
    if (cellStr.includes('WK.') || cellStr.includes('CUM') || 
        /^\d+-\d+$/.test(cellStr) || // Match "0-1", "1-0" pattern
        /^[A-Za-z]+\(\d+\.?\d*\)$/.test(cellStr) || // Match "Cal(104.5)" pattern more precisely
        ['Loss', 'Win', 'Week'].includes(cellStr)) {
        console.log(`  SKIPPED: "${cellStr}" (summary data)`);
        continue;
    }

    console.log(`Row ${rowIdx + 1}: "${cellStr}"`);

    // Handle DEF specially  
    if (currentPosition === 'DEF') {
        const cleanDEF = cellStr.replace(/^\*/, '').trim();
        console.log(`  DEF check: "${cleanDEF}"`);
        
        const validNFLTeams = [
            'Texans', 'Giants', 'Cowboys', 'Jets', 'Cardinals', 'Falcons', 'Bears', 'Lions', 
            'Ravens', 'Bills', 'Chiefs', 'Patriots', 'Dolphins', 'Seahawks', 'Steelers', 
            'Panthers', 'Bengals', 'Colts', 'Saints', 'Jaguars', 'Browns', 'Broncos', 
            '49ers', 'Eagles', 'Rams', 'Chargers', 'Raiders', 'Vikings', 'Packers', 
            'Titans', 'Buccaneers', 'Commanders'
        ];
        
        if (validNFLTeams.includes(cleanDEF)) {
            console.log(`  VALID DEF: ${cleanDEF}`);
            mitchPlayers.push({
                position: 'DEF',
                playerInfo: { name: cleanDEF, team: 'DEF', isStarter: cellStr.startsWith('*') },
                raw: cellStr
            });
        } else {
            console.log(`  INVALID DEF: ${cleanDEF}`);
        }
        continue;
    }

    // For other positions, require player format
    const playerInfo = parsePlayerName(cellStr);
    if (playerInfo) {
        console.log(`  PARSED: ${playerInfo.name} (${playerInfo.team}) - Starter: ${playerInfo.isStarter}`);
        mitchPlayers.push({
            position: currentPosition,
            playerInfo: playerInfo,
            raw: cellStr
        });
    } else {
        console.log(`  FAILED TO PARSE: "${cellStr}"`);
    }
}

console.log(`\n=== SUMMARY ===`);
console.log(`Total players found: ${mitchPlayers.length}`);
mitchPlayers.forEach((p, i) => {
    console.log(`${i+1}. ${p.position}: ${p.playerInfo.name} (${p.raw})`);
});