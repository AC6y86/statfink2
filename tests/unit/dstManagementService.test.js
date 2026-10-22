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
            expect(awayCall[1][18]).toBe(21); // points_allowed
            
            // Verify home DST insertion (DAL defense allowed away team's 17 points)
            const homeCall = mockDb.run.mock.calls[1];
            expect(homeCall[1][0]).toBe('DEF_DAL'); // player_id
            expect(homeCall[1][18]).toBe(17); // points_allowed
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
            expect(args[13]).toBe(3); // sacks
            expect(args[14]).toBe(2); // def_interceptions
            expect(args[15]).toBe(1); // fumbles_recovered
            expect(args[16]).toBe(0); // def_touchdowns - always 0 per implementation
            expect(args[18]).toBe(21); // points_allowed
            expect(args[19]).toBe(350); // yards_allowed
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
describe('DSTManagementService.resolveSafeties (season-gated)', () => {
    let service;
    beforeEach(() => {
        jest.clearAllMocks();
        service = new DSTManagementService({ get: jest.fn(), all: jest.fn(), run: jest.fn().mockReturnValue({ changes: 0 }) });
    });

    const noSafetyBreakdown = { def_int_return_tds: 0, def_fumble_return_tds: 1, def_blocked_return_tds: 0, safeties: 0 };

    test('2026: parsed scoring plays are authoritative — a phantom Tank01 safety is ignored (SEA wk7 2025 pattern)', () => {
        expect(service.resolveSafeties('DEF_SEA', 7, 2026, { safeties: '1' }, noSafetyBreakdown)).toBe(0);
        expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('DEF_SEA week 7: scoring plays show 0 safeties but Tank01 DST.safeties says 1'));
    });

    test('2026: a parsed safety is kept even when Tank01 says 0', () => {
        expect(service.resolveSafeties('DEF_X', 1, 2026, { safeties: '0' }, { ...noSafetyBreakdown, safeties: 1 })).toBe(1);
    });

    test('2025 (legacy): the || fallback still reaches for Tank01 — blessed record unchanged', () => {
        expect(service.resolveSafeties('DEF_SEA', 7, 2025, { safeties: '1' }, noSafetyBreakdown)).toBe(1);
        expect(logWarn).not.toHaveBeenCalled();
    });

    test('no parsed breakdown: Tank01 is the only source in every season', () => {
        expect(service.resolveSafeties('DEF_X', 1, 2026, { safeties: '2' }, null)).toBe(2);
        expect(service.resolveSafeties('DEF_X', 1, 2025, { safeties: '2' }, null)).toBe(2);
        expect(service.resolveSafeties('DEF_X', 1, 2026, {}, null)).toBe(0);
    });

    test('insertDSTStats writes the resolved value (2026: 0, 2025: 1) into the safeties column', async () => {
        const dstData = { sacks: 1, defensiveInterceptions: 0, fumblesRecovered: 0, defTD: 0, safeties: '1' };
        await service.insertDSTStats('DEF_SEA', 7, 'g', dstData, 19, 300, 2026, noSafetyBreakdown);
        expect(service.db.run.mock.calls[0][1][17]).toBe(0);
        await service.insertDSTStats('DEF_SEA', 7, 'g', dstData, 19, 300, 2025, noSafetyBreakdown);
        expect(service.db.run.mock.calls[1][1][17]).toBe(1);
    });
});


describe('Washington defensive TD through live and cached-game paths', () => {
    test.each([
        ['home', 'WAS', 'WSH'], ['away', 'WAS', 'WSH'],
        ['home', 'WSH', 'WSH'], ['away', 'WSH', 'WSH'],
        ['home', 'WSH', 'WAS'], ['away', 'WAS', 'WAS']
    ])('%s Washington: game %s / scoring play %s retains its interception TD', async (side, gameCode, playCode) => {
        const box = { scoringPlays: [{
            score: 'Kain Medrano 50 Yd Interception Return (Drew Stevens PAT Failed)',
            scorePeriod: 'Q4', scoreTime: '3:57', scoreType: 'TD',
            team: playCode, playerIDs: ['4427984', '5081335']
        }] };
        const db = { run: jest.fn(async () => ({ changes: 1 })) };
        const service = new DSTManagementService(db, {
            getNFLBoxScore: jest.fn(async () => box),
            getPlayerList: jest.fn(async () => [])
        });
        const game = { home: side === 'home' ? gameCode : 'SEA',
            away: side === 'away' ? gameCode : 'SEA',
            homePts: 33, awayPts: 31, teamIDHome: '32', teamIDAway: '29' };
        await service.processDSTStats({ home: {}, away: {} }, game, 3, 'washington-regression', 2026);
        expect(db.run).toHaveBeenCalledTimes(2);
        const rows = db.run.mock.calls.map(([sql, values]) => {
            const columns = sql.match(/player_stats\s*\(([\s\S]*?)\) VALUES/)[1].split(',').map(s => s.trim());
            return Object.fromEntries(columns.map((c, i) => [c, values[i]]));
        });
        expect(rows.find(r => r.player_id === 'DEF_WAS')).toMatchObject({
            def_int_return_tds: 1, def_touchdowns: 1, def_fumble_return_tds: 0
        });
        expect(rows.find(r => r.player_id === 'DEF_SEA')).toMatchObject({
            def_int_return_tds: 0, def_touchdowns: 0
        });
    });
});
