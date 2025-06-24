const sqlite3 = require('sqlite3');
const path = require('path');

// Mock sqlite3
jest.mock('sqlite3', () => ({
    verbose: jest.fn().mockReturnThis(),
    Database: jest.fn()
}));

// Import the StatsComparator class
const StatsComparator = require('../2024/StatsComparator');

describe('StatsComparator', () => {
    let comparator;
    let mockCurrentDb;
    let mockReferenceDb;
    
    beforeEach(() => {
        // Clear all mocks
        jest.clearAllMocks();
        
        // Create mock database instances
        mockCurrentDb = {
            all: jest.fn(),
            close: jest.fn((callback) => callback())
        };
        
        mockReferenceDb = {
            all: jest.fn(),
            close: jest.fn((callback) => callback())
        };
        
        // Mock the Database constructor to return our mocked databases
        sqlite3.Database.mockImplementation((path, callback) => {
            if (path.includes('fantasy_football.db')) {
                callback(null); // No error
                return mockCurrentDb;
            } else if (path.includes('statfinkv1_2024.db')) {
                callback(null); // No error
                return mockReferenceDb;
            }
        });
        
        comparator = new StatsComparator();
    });
    
    afterEach(async () => {
        await comparator.close();
    });
    
    describe('initialization', () => {
        test('should initialize both databases successfully', async () => {
            await comparator.initialize();
            
            expect(sqlite3.Database).toHaveBeenCalledTimes(2);
            expect(comparator.currentDb).toBe(mockCurrentDb);
            expect(comparator.referenceDb).toBe(mockReferenceDb);
        });
        
        test('should handle current database error', async () => {
            sqlite3.Database.mockImplementation((path, callback) => {
                if (path.includes('fantasy_football.db')) {
                    callback(new Error('DB Error'));
                    return {
                        close: jest.fn((callback) => callback())
                    };
                }
            });
            
            await expect(comparator.initialize()).rejects.toThrow('DB Error');
        });
    });
    
    describe('compareAllStats - expecting no mismatches', () => {
        beforeEach(async () => {
            await comparator.initialize();
        });
        
        test('should find no mismatches when all fantasy points match for roster players', async () => {
            // Mock current database response (roster players only)
            const currentStats = [
                {
                    player_id: 'JackJu00',
                    player_name: 'Justin Jackson',
                    week: 1,
                    season: 2024,
                    position: 'RB',
                    team: 'LAC',
                    fantasy_points: 15.5
                },
                {
                    player_id: 'BrowAJ00',
                    player_name: 'A.J. Brown',
                    week: 1,
                    season: 2024,
                    position: 'WR',
                    team: 'PHI',
                    fantasy_points: 22.3
                },
                {
                    player_id: 'DEF-BAL',
                    player_name: 'Baltimore Ravens Defense',
                    week: 1,
                    season: 2024,
                    position: 'DEF',
                    team: 'BAL',
                    fantasy_points: 8.0
                }
            ];
            
            // Mock reference database response with matching points
            const referenceStats = [
                {
                    player_name: 'Justin Jackson',
                    position: 'RB',
                    team: 'LAC',
                    week: 1,
                    fantasy_points: 15.5,
                    player_id: 'JackJu00'
                },
                {
                    player_name: 'A.J. Brown',
                    position: 'WR',
                    team: 'PHI',
                    week: 1,
                    fantasy_points: 22.3,
                    player_id: 'BrowAJ00'
                },
                {
                    player_name: 'Ravens',
                    position: 'DST',
                    team: 'BAL',
                    week: 1,
                    fantasy_points: 8.0,
                    player_id: 'DEF-BAL'
                }
            ];
            
            mockCurrentDb.all.mockImplementation((query, params, callback) => {
                callback(null, currentStats);
            });
            
            mockReferenceDb.all.mockImplementation((query, params, callback) => {
                callback(null, referenceStats);
            });
            
            // Spy on console.log to capture output
            const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
            
            await comparator.compareAllStats(true); // roster players only
            
            // Check that no mismatches were found
            expect(comparator.mismatches).toHaveLength(0);
            
            // Verify the success message was logged
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('No mismatches found!')
            );
            
            consoleLogSpy.mockRestore();
        });
        
        test('should handle player name variations correctly', async () => {
            // Test different name formats that should match
            const currentStats = [
                {
                    player_id: 'BrowAm00',
                    player_name: 'Amon-Ra St. Brown',
                    week: 2,
                    season: 2024,
                    position: 'WR',
                    team: 'DET',
                    fantasy_points: 18.7
                },
                {
                    player_id: 'SmitDe00',
                    player_name: 'DeVonta Smith Jr.',
                    week: 2,
                    season: 2024,
                    position: 'WR',
                    team: 'PHI',
                    fantasy_points: 14.2
                }
            ];
            
            const referenceStats = [
                {
                    player_name: 'Amon-Ra St.Brown', // Different spacing
                    position: 'WR',
                    team: 'DET',
                    week: 2,
                    fantasy_points: 18.7,
                    player_id: 'BrowAm00'
                },
                {
                    player_name: 'DeVonta Smith', // No suffix
                    position: 'WR',
                    team: 'PHI',
                    week: 2,
                    fantasy_points: 14.2,
                    player_id: 'SmitDe00'
                }
            ];
            
            mockCurrentDb.all.mockImplementation((query, params, callback) => {
                callback(null, currentStats);
            });
            
            mockReferenceDb.all.mockImplementation((query, params, callback) => {
                callback(null, referenceStats);
            });
            
            await comparator.compareAllStats(false);
            
            // Should find matches despite name variations
            expect(comparator.mismatches).toHaveLength(0);
        });
        
        test('should match defense/DST teams correctly', async () => {
            const currentStats = [
                {
                    player_id: 'DEF-SF',
                    player_name: 'San Francisco 49ers Defense',
                    week: 3,
                    season: 2024,
                    position: 'DEF',
                    team: 'SF',
                    fantasy_points: 12.0
                },
                {
                    player_id: 'DEF-NE',
                    player_name: 'New England Patriots Defense',
                    week: 3,
                    season: 2024,
                    position: 'DEF',
                    team: 'NE',
                    fantasy_points: 5.0
                }
            ];
            
            const referenceStats = [
                {
                    player_name: '49ers',
                    position: 'DST',
                    team: 'SF',
                    week: 3,
                    fantasy_points: 12.0,
                    player_id: 'DEF-SF'
                },
                {
                    player_name: 'Patriots',
                    position: 'DST',
                    team: 'NE',
                    week: 3,
                    fantasy_points: 5.0,
                    player_id: 'DEF-NE'
                }
            ];
            
            mockCurrentDb.all.mockImplementation((query, params, callback) => {
                callback(null, currentStats);
            });
            
            mockReferenceDb.all.mockImplementation((query, params, callback) => {
                callback(null, referenceStats);
            });
            
            await comparator.compareAllStats(false);
            
            expect(comparator.mismatches).toHaveLength(0);
        });
        
        test('should handle rounding correctly (0.1 tolerance)', async () => {
            const currentStats = [
                {
                    player_id: 'MahoPa00',
                    player_name: 'Patrick Mahomes',
                    week: 4,
                    season: 2024,
                    position: 'QB',
                    team: 'KC',
                    fantasy_points: 25.44 // Will round to 25.4
                },
                {
                    player_id: 'AlleJo00',
                    player_name: 'Josh Allen',
                    week: 4,
                    season: 2024,
                    position: 'QB',
                    team: 'BUF',
                    fantasy_points: 28.06 // Will round to 28.1
                }
            ];
            
            const referenceStats = [
                {
                    player_name: 'Patrick Mahomes',
                    position: 'QB',
                    team: 'KC',
                    week: 4,
                    fantasy_points: 25.4,
                    player_id: 'MahoPa00'
                },
                {
                    player_name: 'Josh Allen',
                    position: 'QB',
                    team: 'BUF',
                    week: 4,
                    fantasy_points: 28.1,
                    player_id: 'AlleJo00'
                }
            ];
            
            mockCurrentDb.all.mockImplementation((query, params, callback) => {
                callback(null, currentStats);
            });
            
            mockReferenceDb.all.mockImplementation((query, params, callback) => {
                callback(null, referenceStats);
            });
            
            await comparator.compareAllStats(false);
            
            // Should match within 0.1 tolerance
            expect(comparator.mismatches).toHaveLength(0);
        });
        
        test('should skip players with 0 points in non-roster mode', async () => {
            const currentStats = [
                {
                    player_id: 'JoneDa00',
                    player_name: 'Daniel Jones',
                    week: 5,
                    season: 2024,
                    position: 'QB',
                    team: 'NYG',
                    fantasy_points: 0 // Did not play
                },
                {
                    player_id: 'BurrJo00',
                    player_name: 'Joe Burrow',
                    week: 5,
                    season: 2024,
                    position: 'QB',
                    team: 'CIN',
                    fantasy_points: 21.5
                }
            ];
            
            const referenceStats = [
                // No Daniel Jones entry
                {
                    player_name: 'Joe Burrow',
                    position: 'QB',
                    team: 'CIN',
                    week: 5,
                    fantasy_points: 21.5,
                    player_id: 'BurrJo00'
                }
            ];
            
            mockCurrentDb.all.mockImplementation((query, params, callback) => {
                callback(null, currentStats);
            });
            
            mockReferenceDb.all.mockImplementation((query, params, callback) => {
                callback(null, referenceStats);
            });
            
            await comparator.compareAllStats(false); // non-roster mode
            
            // Should not report mismatch for 0-point player
            expect(comparator.mismatches).toHaveLength(0);
        });
        
        test('should process all 2024 season weeks', async () => {
            // Create stats for multiple weeks
            const weeks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
            const currentStats = [];
            const referenceStats = [];
            
            weeks.forEach(week => {
                const stat = {
                    player_id: 'TestPl00',
                    player_name: 'Test Player',
                    week: week,
                    season: 2024,
                    position: 'RB',
                    team: 'TEST',
                    fantasy_points: 10.0 + week
                };
                currentStats.push(stat);
                
                referenceStats.push({
                    player_name: 'Test Player',
                    position: 'RB',
                    team: 'TEST',
                    week: week,
                    fantasy_points: 10.0 + week,
                    player_id: 'TestPl00'
                });
            });
            
            mockCurrentDb.all.mockImplementation((query, params, callback) => {
                callback(null, currentStats);
            });
            
            mockReferenceDb.all.mockImplementation((query, params, callback) => {
                callback(null, referenceStats);
            });
            
            const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
            
            await comparator.compareAllStats(false);
            
            expect(comparator.mismatches).toHaveLength(0);
            
            // Verify all weeks were analyzed
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining(`Weeks analyzed: ${weeks.join(', ')}`)
            );
            
            consoleLogSpy.mockRestore();
        });
    });
    
    describe('error handling', () => {
        beforeEach(async () => {
            await comparator.initialize();
        });
        
        test('should handle database query errors gracefully', async () => {
            mockCurrentDb.all.mockImplementation((query, params, callback) => {
                callback(new Error('Database query failed'));
            });
            
            const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
            
            await comparator.compareAllStats(false);
            
            expect(consoleErrorSpy).toHaveBeenCalledWith(
                'Error during comparison:',
                expect.any(Error)
            );
            
            consoleErrorSpy.mockRestore();
        });
    });
});