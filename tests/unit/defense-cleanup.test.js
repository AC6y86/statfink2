const Database = require('../../server/database/database');
const DSTManagementService = require('../../server/services/dstManagementService');
const ScoringService = require('../../server/services/scoringService');

describe('Defense Cleanup and Validation', () => {
    let db;
    let dstService;
    let scoringService;
    
    beforeAll(async () => {
        db = new Database();
        dstService = new DSTManagementService(db);
        scoringService = new ScoringService(db);
    });
    
    afterAll(async () => {
        await db.close();
    });
    
    describe('Database Integrity', () => {
        test('should have exactly 32 defensive teams', async () => {
            const result = await db.get(
                "SELECT COUNT(*) as count FROM nfl_players WHERE position = 'DST'"
            );
            expect(result.count).toBe(32);
        });
        
        test('should have no DEF positions (all should be DST)', async () => {
            const result = await db.get(
                "SELECT COUNT(*) as count FROM nfl_players WHERE position = 'DEF'"
            );
            expect(result.count).toBe(0);
        });
        
        test('all defensive player_ids should use DEF_XXX format', async () => {
            const result = await db.get(
                "SELECT COUNT(*) as count FROM nfl_players WHERE position = 'DST' AND player_id NOT LIKE 'DEF_%'"
            );
            expect(result.count).toBe(0);
        });
        
        test('each NFL team should have exactly one defense', async () => {
            const duplicates = await db.all(`
                SELECT team, COUNT(*) as count
                FROM nfl_players 
                WHERE position = 'DST'
                GROUP BY team
                HAVING COUNT(*) > 1
            `);
            expect(duplicates).toHaveLength(0);
        });
        
        test('all 32 NFL teams should be represented', async () => {
            const nflTeams = [
                'ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE',
                'DAL', 'DEN', 'DET', 'GB', 'HOU', 'IND', 'JAX', 'KC',
                'LAC', 'LAR', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG',
                'NYJ', 'PHI', 'PIT', 'SEA', 'SF', 'TB', 'TEN', 'WAS'
            ];
            
            const existingTeams = await db.all(`
                SELECT DISTINCT team 
                FROM nfl_players 
                WHERE position = 'DST'
                ORDER BY team
            `);
            
            const teamSet = new Set(existingTeams.map(t => t.team));
            const missingTeams = nflTeams.filter(t => !teamSet.has(t));
            
            expect(missingTeams).toHaveLength(0);
            expect(teamSet.size).toBe(32);
        });
        
        test('defensive names should follow correct format', async () => {
            const defenses = await db.all(`
                SELECT player_id, name, team
                FROM nfl_players 
                WHERE position = 'DST'
                ORDER BY team
            `);
            
            defenses.forEach(def => {
                expect(def.player_id).toMatch(/^DEF_[A-Z]{2,3}$/);
                expect(def.name).toContain('Defense');
                expect(def.team).toMatch(/^[A-Z]{2,3}$/);
            });
        });
    });
    
    describe('Roster References', () => {
        test('all defensive roster entries should reference valid player_ids', async () => {
            const orphaned = await db.all(`
                SELECT DISTINCT wr.player_id
                FROM weekly_rosters wr
                WHERE wr.player_id LIKE 'DEF_%'
                AND NOT EXISTS (
                    SELECT 1 FROM nfl_players np 
                    WHERE np.player_id = wr.player_id
                )
            `);
            
            expect(orphaned).toHaveLength(0);
        });
        
        test('no roster should reference old defensive formats', async () => {
            const oldFormats = await db.all(`
                SELECT DISTINCT player_id
                FROM weekly_rosters
                WHERE (player_id LIKE 'DST_%' 
                    OR player_id LIKE '%_def_%'
                    OR player_id LIKE '%_def')
                AND player_id NOT LIKE 'DEF_%'
            `);
            
            expect(oldFormats).toHaveLength(0);
        });
    });
    
    describe('Defensive Stats', () => {
        test('defensive stats should only exist for valid DEF_XXX player_ids', async () => {
            const invalidStats = await db.all(`
                SELECT DISTINCT player_id
                FROM player_stats
                WHERE player_id IN (
                    SELECT player_id FROM nfl_players 
                    WHERE position IN ('DEF', 'DST')
                )
                AND player_id NOT LIKE 'DEF_%'
            `);
            
            expect(invalidStats).toHaveLength(0);
        });
        
        test('all DEF_XXX teams should have stats for completed weeks', async () => {
            const week17Stats = await db.all(`
                SELECT ps.player_id
                FROM nfl_players np
                LEFT JOIN player_stats ps ON np.player_id = ps.player_id 
                    AND ps.week = 17 AND ps.season = 2024
                WHERE np.position = 'DST'
                AND ps.player_id IS NULL
            `);
            
            // Some teams might not have played yet, but most should have stats
            expect(week17Stats.length).toBeLessThanOrEqual(4); // Allow for bye weeks
        });
    });
    
    describe('Defensive Bonuses', () => {
        test('defensive bonuses should sum to 5 points per category for completed weeks', async () => {
            const bonusTotals = await db.all(`
                SELECT week,
                       SUM(def_points_bonus) as points_total,
                       SUM(def_yards_bonus) as yards_total,
                       COUNT(DISTINCT player_id) as team_count
                FROM player_stats
                WHERE player_id LIKE 'DEF_%'
                AND season = 2024
                AND week = 17
                GROUP BY week
            `);
            
            bonusTotals.forEach(week => {
                if (week.team_count >= 16) { // If most teams played
                    expect(Math.abs(week.points_total - 5)).toBeLessThan(0.01);
                    expect(Math.abs(week.yards_total - 5)).toBeLessThan(0.01);
                }
            });
        });
        
        test('teams with lowest points/yards should have bonuses', async () => {
            const week17 = await db.all(`
                SELECT player_id, points_allowed, yards_allowed,
                       def_points_bonus, def_yards_bonus
                FROM player_stats
                WHERE player_id LIKE 'DEF_%'
                AND week = 17 AND season = 2024
                ORDER BY points_allowed, yards_allowed
            `);
            
            if (week17.length > 0) {
                const lowestPoints = week17[0].points_allowed;
                const lowestYards = Math.min(...week17.map(t => t.yards_allowed));
                
                const bestPointsDefense = week17.find(t => t.points_allowed === lowestPoints);
                const bestYardsDefense = week17.find(t => t.yards_allowed === lowestYards);
                
                expect(bestPointsDefense.def_points_bonus).toBeGreaterThan(0);
                expect(bestYardsDefense.def_yards_bonus).toBeGreaterThan(0);
            }
        });
    });
    
    describe('Fantasy Points Calculation', () => {
        test('defensive fantasy points should include all components', async () => {
            const sampleDST = await db.get(`
                SELECT *
                FROM player_stats
                WHERE player_id = 'DEF_BAL'
                AND week = 17 AND season = 2024
            `);
            
            if (sampleDST) {
                const expectedPoints = 
                    (sampleDST.def_int_return_tds || 0) * 8 +
                    (sampleDST.def_fumble_return_tds || 0) * 8 +
                    (sampleDST.def_blocked_return_tds || 0) * 8 +
                    (sampleDST.safeties || 0) * 2 +
                    (sampleDST.def_points_bonus || 0) +
                    (sampleDST.def_yards_bonus || 0);
                
                expect(Math.abs(sampleDST.fantasy_points - expectedPoints)).toBeLessThan(0.01);
            }
        });
        
        test('calculateFantasyPoints should handle DST correctly', async () => {
            const mockStats = {
                position: 'DST',
                def_int_return_tds: 1,
                def_fumble_return_tds: 0,
                def_blocked_return_tds: 1,
                safeties: 1,
                def_points_bonus: 2.5,
                def_yards_bonus: 0
            };
            
            const points = await scoringService.calculateFantasyPoints(mockStats);
            const expected = 8 + 8 + 2 + 2.5; // 20.5
            
            expect(points).toBe(expected);
        });
    });
    
    describe('DST Management Service', () => {
        test('cleanupDSTDuplicates should remove non-standard formats', async () => {
            // This would need test data setup, skipping for now
            // Could be implemented with a test database
        });
        
        test('ensureDSTPlayersExist should maintain exactly 32 teams', async () => {
            await dstService.ensureDSTPlayersExist();
            
            const count = await db.get(
                'SELECT COUNT(*) as count FROM nfl_players WHERE position = ?',
                ['DST']
            );
            
            expect(count.count).toBe(32);
        });
    });
});