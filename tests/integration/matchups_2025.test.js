const DatabaseManager = require('../../server/database/database');

describe('2025 Season Matchups - Weeks 1-12', () => {
    let db;
    
    // Expected matchups from MATCHUPS_SIMPLE.md
    const expectedMatchups = {
        1: [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11, 12]],
        2: [[1, 4], [3, 6], [5, 8], [7, 10], [9, 12], [11, 2]],
        3: [[1, 6], [3, 8], [5, 10], [7, 12], [9, 2], [11, 4]],
        4: [[1, 8], [3, 10], [5, 12], [7, 2], [9, 4], [11, 6]],
        5: [[1, 10], [3, 12], [5, 2], [7, 4], [9, 6], [11, 8]],
        6: [[1, 12], [3, 2], [5, 4], [7, 6], [9, 8], [11, 10]],
        7: [[1, 3], [2, 4], [5, 11], [6, 8], [7, 9], [10, 12]],
        8: [[1, 5], [2, 12], [7, 11], [8, 4], [9, 3], [10, 6]],
        9: [[1, 9], [2, 6], [3, 11], [4, 12], [5, 7], [8, 10]],
        10: [[1, 7], [2, 8], [3, 5], [4, 10], [6, 12], [9, 11]],
        11: [[1, 11], [2, 10], [3, 7], [4, 6], [5, 9], [8, 12]],
        12: [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11, 12]]
    };
    
    // Team names for reference
    const teamNames = {
        1: 'Chris',
        2: 'Mitch',
        3: 'Dan',
        4: 'Pete',
        5: 'Joe',
        6: 'Aaron',
        7: 'Cal',
        8: 'Bruce',
        9: 'Mike',
        10: 'Sean',
        11: 'Eli',
        12: 'Matt'
    };
    
    beforeAll(async () => {
        db = new DatabaseManager();
        // Wait for database to be ready
        await new Promise(resolve => setTimeout(resolve, 100));
    });
    
    afterAll(async () => {
        if (db) {
            await db.close();
        }
    });
    
    // Helper function to normalize matchup pairs for comparison
    function normalizeMatchup(team1, team2) {
        return [Math.min(team1, team2), Math.max(team1, team2)];
    }
    
    // Helper function to check if two matchup arrays are equivalent
    function matchupsEqual(actual, expected) {
        if (actual.length !== expected.length) return false;
        
        const actualNormalized = actual.map(m => normalizeMatchup(m[0], m[1])).sort();
        const expectedNormalized = expected.map(m => normalizeMatchup(m[0], m[1])).sort();
        
        return JSON.stringify(actualNormalized) === JSON.stringify(expectedNormalized);
    }
    
    // Test each week individually
    for (let week = 1; week <= 12; week++) {
        test(`Week ${week} has correct matchups`, async () => {
            // Get actual matchups from database
            const actualMatchups = await db.all(
                `SELECT team1_id, team2_id 
                 FROM matchups 
                 WHERE season = 2025 AND week = ? 
                 ORDER BY team1_id, team2_id`,
                [week]
            );
            
            // Extract team IDs
            const actualPairs = actualMatchups.map(m => [m.team1_id, m.team2_id]);
            
            // Check count
            expect(actualPairs.length).toBe(6);
            
            // Check matchups match expected
            const expected = expectedMatchups[week];
            expect(matchupsEqual(actualPairs, expected)).toBe(true);
            
            // Verify all teams play exactly once
            const teamsPlaying = new Set();
            actualPairs.forEach(([team1, team2]) => {
                teamsPlaying.add(team1);
                teamsPlaying.add(team2);
            });
            expect(teamsPlaying.size).toBe(12);
            
            // Verify no duplicate matchups within the week
            const matchupStrings = actualPairs.map(m => normalizeMatchup(m[0], m[1]).join('-'));
            const uniqueMatchups = new Set(matchupStrings);
            expect(uniqueMatchups.size).toBe(6);
        });
    }
    
    test('All weeks 1-12 have exactly 6 matchups', async () => {
        const result = await db.get(
            `SELECT COUNT(*) as total, COUNT(DISTINCT week) as weeks 
             FROM matchups 
             WHERE season = 2025 AND week BETWEEN 1 AND 12`
        );
        
        expect(result.weeks).toBe(12);
        expect(result.total).toBe(72); // 6 matchups * 12 weeks
    });
    
    test('Every team plays every other team exactly once in weeks 1-11', async () => {
        const matchups = await db.all(
            `SELECT team1_id, team2_id 
             FROM matchups 
             WHERE season = 2025 AND week BETWEEN 1 AND 11 
             ORDER BY team1_id, team2_id`
        );
        
        // Create a map to track who played who
        const playedAgainst = {};
        for (let i = 1; i <= 12; i++) {
            playedAgainst[i] = new Set();
        }
        
        matchups.forEach(({ team1_id, team2_id }) => {
            playedAgainst[team1_id].add(team2_id);
            playedAgainst[team2_id].add(team1_id);
        });
        
        // Each team should have played exactly 11 other teams
        for (let i = 1; i <= 12; i++) {
            expect(playedAgainst[i].size).toBe(11);
            // Should not have played themselves
            expect(playedAgainst[i].has(i)).toBe(false);
        }
    });
    
    test('Week 12 is a repeat of Week 1', async () => {
        const week1 = await db.all(
            `SELECT team1_id, team2_id 
             FROM matchups 
             WHERE season = 2025 AND week = 1 
             ORDER BY team1_id, team2_id`
        );
        
        const week12 = await db.all(
            `SELECT team1_id, team2_id 
             FROM matchups 
             WHERE season = 2025 AND week = 12 
             ORDER BY team1_id, team2_id`
        );
        
        const week1Pairs = week1.map(m => [m.team1_id, m.team2_id]);
        const week12Pairs = week12.map(m => [m.team1_id, m.team2_id]);
        
        expect(matchupsEqual(week1Pairs, week12Pairs)).toBe(true);
    });
    
    test('Display Week 1 matchups with team names', async () => {
        const week1 = await db.all(
            `SELECT m.team1_id, m.team2_id, t1.team_name as team1_name, t2.team_name as team2_name
             FROM matchups m
             JOIN teams t1 ON m.team1_id = t1.team_id
             JOIN teams t2 ON m.team2_id = t2.team_id
             WHERE m.season = 2025 AND m.week = 1 
             ORDER BY m.team1_id`
        );
        
        console.log('\n=== Week 1 Matchups ===');
        week1.forEach(m => {
            console.log(`${m.team1_name} (${m.team1_id}) vs ${m.team2_name} (${m.team2_id})`);
        });
        
        // Verify specific Week 1 matchups
        const week1Names = week1.map(m => `${m.team1_id} vs ${m.team2_id}`);
        expect(week1Names).toContain('1 vs 2');  // Chris vs Mitch
        expect(week1Names).toContain('3 vs 4');  // Dan vs Pete
        expect(week1Names).toContain('5 vs 6');  // Joe vs Aaron
        expect(week1Names).toContain('7 vs 8');  // Cal vs Bruce
        expect(week1Names).toContain('9 vs 10'); // Mike vs Sean
        expect(week1Names).toContain('11 vs 12'); // Eli vs Matt
    });
});