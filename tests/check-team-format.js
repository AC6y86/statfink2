// Test to check what's actually matching the regex
const testStrings = [
    "Matthew Stafford   Rams",
    "Patrick Mahomes   Chiefs", 
    "Austin Ekeler   Commanders",
    "Bears   DEF",
    "Bryce Young   Panthers\n203-1-0, 8 yds"
];

console.log("Testing playerInfo strings against /[A-Z]{2,3}/:\n");

testStrings.forEach(str => {
    const matches = str.match(/[A-Z]{2,3}/g);
    console.log(`String: "${str}"`);
    console.log(`Matches: ${matches ? matches.join(', ') : 'none'}`);
    console.log(`Test passes: ${/[A-Z]{2,3}/.test(str)}\n`);
});

// More specific test for team abbreviation at end of player name
console.log("\nTesting for team abbreviation pattern (space followed by 2-3 uppercase):");
testStrings.forEach(str => {
    const teamAbbrevPattern = /\s+[A-Z]{2,3}$/m;
    console.log(`String: "${str}"`);
    console.log(`Has team abbreviation: ${teamAbbrevPattern.test(str)}`);
});