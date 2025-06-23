const DSTManagementService = require('../../server/services/dstManagementService');
const { logInfo, logError, logWarn } = require('../../server/utils/errorHandler');

// Mock the error handler
jest.mock('../../server/utils/errorHandler', () => ({
    logInfo: jest.fn(),
    logError: jest.fn(),
    logWarn: jest.fn()
}));

// Mock the team defenses module
jest.mock('../../server/utils/nfl/teamDefenses', () => ({
    addTeamDefenses: jest.fn()
}));

// Mock the Database module
jest.mock('../../server/database/database', () => {
    return jest.fn().mockImplementation(() => ({
        close: jest.fn()
    }));
});

describe('DSTManagementService', () => {
    let service;
    let mockDb;

    beforeEach(() => {
        jest.clearAllMocks();
        
        mockDb = {
            get: jest.fn(),
            all: jest.fn(),
            run: jest.fn().mockReturnValue({ changes: 0 })
        };
        
        service = new DSTManagementService(mockDb);
    });

    describe('ensureDSTPlayersExist', () => {
        test('should do nothing when 32 DST players exist', async () => {
            mockDb.get.mockResolvedValue({ count: 32 });
            
            await service.ensureDSTPlayersExist();
            
            expect(logInfo).toHaveBeenCalledWith('🛡️ Ensuring DST players exist...');
            expect(logInfo).toHaveBeenCalledWith('  ✓ Found 32 DST players (correct count)');
        });

        test('should add team defenses when no DST players exist', async () => {
            mockDb.get.mockResolvedValue({ count: 0 });
            const { addTeamDefenses } = require('../../server/utils/nfl/teamDefenses');
            
            await service.ensureDSTPlayersExist();
            
            expect(logInfo).toHaveBeenCalledWith('  ⚠️ No DST players found. Running team defenses setup...');
            expect(addTeamDefenses).toHaveBeenCalled();
            expect(logInfo).toHaveBeenCalledWith('  ✓ Team defenses added');
        });

        test('should warn when less than 32 DST players exist', async () => {
            mockDb.get.mockResolvedValue({ count: 25 });
            
            await service.ensureDSTPlayersExist();
            
            expect(logInfo).toHaveBeenCalledWith('  ⚠️ Found only 25 DST players, expected 32');
        });

        test('should update Defense positions to DST', async () => {
            mockDb.get.mockResolvedValue({ count: 32 });
            mockDb.run.mockResolvedValue({ changes: 5 });
            
            await service.ensureDSTPlayersExist();
            
            expect(mockDb.run).toHaveBeenCalledWith(
                'UPDATE nfl_players SET position = ? WHERE position = ?',
                ['DST', 'Defense']
            );
            expect(logInfo).toHaveBeenCalledWith('  ✓ Updated 5 Defense positions to DST');
        });
    });

    describe('cleanupDSTDuplicates', () => {
        test('should remove various duplicate DST formats', async () => {
            const mockResults = [
                { changes: 3 }, // xxxdefense_xxx_dst format
                { changes: 2 }, // team='DST' entries
                { changes: 1 }, // other duplicates
                { changes: 4 }  // non-standard entries
            ];
            
            mockDb.run.mockResolvedValueOnce(mockResults[0])
                     .mockResolvedValueOnce(mockResults[1])
                     .mockResolvedValueOnce(mockResults[2])
                     .mockResolvedValueOnce(mockResults[3]);
            
            await service.cleanupDSTDuplicates();
            
            expect(mockDb.run).toHaveBeenCalledTimes(4);
            expect(logInfo).toHaveBeenCalledWith('    ✓ Removed 3 xxxdefense_xxx_dst entries');
            expect(logInfo).toHaveBeenCalledWith('    ✓ Removed 2 entries with team=\'DST\'');
            expect(logInfo).toHaveBeenCalledWith('    ✓ Removed 1 other duplicate entries');
            expect(logInfo).toHaveBeenCalledWith('    ✓ Removed 4 non-standard DST entries');
        });

        test('should report no duplicates when none found', async () => {
            mockDb.run.mockResolvedValue({ changes: 0 });
            
            await service.cleanupDSTDuplicates();
            
            expect(logInfo).toHaveBeenCalledWith('    ✓ No duplicates found');
        });
    });

    describe('processDSTStats', () => {
        const mockDstData = {
            away: {
                sacks: 3,
                defensiveInterceptions: 2,
                fumblesRecovered: 1,
                defTD: 1,
                safeties: 0
            },
            home: {
                sacks: 2,
                defensiveInterceptions: 1,
                fumblesRecovered: 0,
                defTD: 0,
                safeties: 0
            }
        };

        const mockGame = {
            away: 'NYG',
            home: 'DAL',
            teamIDHome: 'DAL',
            teamIDAway: 'NYG',
            homePts: 21,
            awayPts: 17
        };

        test('should process both home and away DST stats', async () => {
            await service.processDSTStats(mockDstData, mockGame, 1, 'game123', 2024);
            
            // Should insert stats for both teams
            expect(mockDb.run).toHaveBeenCalledTimes(2);
            
            // Verify away DST insertion (NYG defense allowed home team's 21 points)
            const awayCall = mockDb.run.mock.calls[0];
            expect(awayCall[1][0]).toBe('DEF_NYG'); // player_id
            expect(awayCall[1][19]).toBe(21); // points_allowed
            
            // Verify home DST insertion (DAL defense allowed away team's 17 points)
            const homeCall = mockDb.run.mock.calls[1];
            expect(homeCall[1][0]).toBe('DEF_DAL'); // player_id
            expect(homeCall[1][19]).toBe(17); // points_allowed
        });

        test('should handle missing DST data gracefully', async () => {
            await service.processDSTStats({}, mockGame, 1, 'game123', 2024);
            
            // Should not insert any stats
            expect(mockDb.run).not.toHaveBeenCalled();
        });
    });

    describe('insertDSTStats', () => {
        test('should insert DST stats with correct values', async () => {
            const dstData = {
                sacks: 3,
                defensiveInterceptions: 2,
                fumblesRecovered: 1,
                defTD: 1,
                safeties: 0
            };
            
            await service.insertDSTStats('DEF_NYG', 1, 'game123', dstData, 21, 350, 2024);
            
            expect(mockDb.run).toHaveBeenCalledTimes(1);
            const args = mockDb.run.mock.calls[0][1];
            
            // Verify key fields
            expect(args[0]).toBe('DEF_NYG'); // player_id
            expect(args[1]).toBe(1); // week
            expect(args[2]).toBe(2024); // season
            expect(args[14]).toBe(3); // sacks
            expect(args[15]).toBe(2); // def_interceptions
            expect(args[16]).toBe(1); // fumbles_recovered
            expect(args[17]).toBe(1); // def_touchdowns
            expect(args[19]).toBe(21); // points_allowed
            expect(args[20]).toBe(350); // yards_allowed
        });

        test('should handle database errors gracefully', async () => {
            mockDb.run.mockRejectedValue(new Error('Database error'));
            
            await service.insertDSTStats('DEF_NYG', 1, 'game123', {}, 21, 350, 2024);
            
            expect(logWarn).toHaveBeenCalledWith(
                'Failed to insert stats for player DEF_NYG:',
                'Database error'
            );
        });
    });
});