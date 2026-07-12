/**
 * Guards team-code canonicalization.
 *
 * The WSH/WAS-and-nickname class of bug has been fixed three times (Sep 2025
 * twice, Jul 2026) because five independent team-code maps drifted apart.
 * These tests pin a single source of truth in server/utils/teamMappings.js
 * and require every consumer to agree with it.
 */

const {
    getTeamAbbreviation,
    CANONICAL_TEAM_CODES
} = require('../../server/utils/teamMappings');
const { normalizeTeamCode } = require('../../server/utils/teamNormalization');
const PlayerSyncService = require('../../server/services/playerSyncService');
const { NFL_TEAMS } = require('../../server/utils/nfl/teamDefenses');

const CANONICAL = ['ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE',
    'DAL', 'DEN', 'DET', 'GB', 'HOU', 'IND', 'JAX', 'KC',
    'LAC', 'LAR', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG',
    'NYJ', 'PHI', 'PIT', 'SEA', 'SF', 'TB', 'TEN', 'WAS'];

const NICKNAMES = {
    '49ers': 'SF', 'Bears': 'CHI', 'Bengals': 'CIN', 'Bills': 'BUF',
    'Broncos': 'DEN', 'Browns': 'CLE', 'Buccaneers': 'TB', 'Cardinals': 'ARI',
    'Chargers': 'LAC', 'Chiefs': 'KC', 'Colts': 'IND', 'Commanders': 'WAS',
    'Cowboys': 'DAL', 'Dolphins': 'MIA', 'Eagles': 'PHI', 'Falcons': 'ATL',
    'Giants': 'NYG', 'Jaguars': 'JAX', 'Jets': 'NYJ', 'Lions': 'DET',
    'Packers': 'GB', 'Panthers': 'CAR', 'Patriots': 'NE', 'Raiders': 'LV',
    'Rams': 'LAR', 'Ravens': 'BAL', 'Saints': 'NO', 'Seahawks': 'SEA',
    'Steelers': 'PIT', 'Texans': 'HOU', 'Titans': 'TEN', 'Vikings': 'MIN'
};

const ALT_CODES = { WSH: 'WAS', GNB: 'GB', KAN: 'KC', JAC: 'JAX' };

describe('Canonical team codes (single source of truth)', () => {
    test('teamMappings exports the canonical 32-team code set', () => {
        expect(CANONICAL_TEAM_CODES).toBeDefined();
        expect([...CANONICAL_TEAM_CODES].sort()).toEqual([...CANONICAL].sort());
    });

    test('getTeamAbbreviation maps every nickname to its canonical code', () => {
        for (const [nickname, code] of Object.entries(NICKNAMES)) {
            expect(getTeamAbbreviation(nickname)).toBe(code);
        }
    });

    test('getTeamAbbreviation maps alternate codes (WSH/GNB/KAN/JAC) to canonical', () => {
        for (const [alt, code] of Object.entries(ALT_CODES)) {
            expect(getTeamAbbreviation(alt)).toBe(code);
        }
    });

    test('getTeamAbbreviation passes canonical codes through unchanged', () => {
        for (const code of CANONICAL) {
            expect(getTeamAbbreviation(code)).toBe(code);
        }
    });

    test('normalizeTeamCode agrees with the canonical mapping', () => {
        expect(normalizeTeamCode('WSH')).toBe('WAS');
        expect(normalizeTeamCode('Commanders')).toBe('WAS');
        expect(normalizeTeamCode('was')).toBe('WAS');
        for (const code of CANONICAL) {
            expect(normalizeTeamCode(code)).toBe(code);
        }
    });

    test('playerSyncService.normalizeTeam handles every nickname (the recurring leak)', () => {
        const sync = new PlayerSyncService(null, null);
        for (const [nickname, code] of Object.entries(NICKNAMES)) {
            expect(sync.normalizeTeam(nickname)).toBe(code);
        }
        expect(sync.normalizeTeam('WSH')).toBe('WAS');
        expect(sync.normalizeTeam('KANSAS CITY')).toBe('KC');
    });

    test('teamDefenses NFL_TEAMS abbreviations are all canonical', () => {
        const abbvs = NFL_TEAMS.map(t => t.abbv);
        expect(abbvs).toHaveLength(32);
        for (const abbv of abbvs) {
            expect(CANONICAL).toContain(abbv);
        }
    });
});
