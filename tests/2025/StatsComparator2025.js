const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const expectedStats = require('./week1_2025_expected_stats');

class StatsComparator2025 {
    constructor() {
        // Current database with imported stats
        this.dbPath = path.join(__dirname, '../../fantasy_football.db');
        this.db = null;
        this.mismatches = [];
        this.teamMismatches = [];
    }

    async initialize() {
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    console.error('Error opening database:', err);
                    reject(err);
                    return;
                }
                console.log('Database opened successfully');
                resolve();
            });
        });
    }

    normalizePlayerName(name) {
        if (!name) return '';
        // Remove Jr., Sr., III, etc. and normalize spaces
        return name
            .replace(/\s+(Jr\.|Sr\.|III|II|IV)$/i, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    normalizeDefenseName(name, team) {
        if (!name) return '';

        // Handle defense/DST variations
        if (name.toLowerCase().includes('defense') ||
            name.toLowerCase().includes('dst') ||
            team.toLowerCase().includes('defense')) {
            // Extract team name from various formats
            const teamName = name.replace(/\s*(Defense|DST|DEF)$/i, '').trim();
            return teamName.toLowerCase();
        }

        return name.toLowerCase();
    }

    async getWeek1StatsFromDatabase() {
        return new Promise((resolve, reject) => {
            const query = `
                SELECT
                    wr.team_id,
                    wr.player_id,
                    wr.player_name,
                    wr.player_position as position,
                    wr.player_team as team,
                    COALESCE(ps.fantasy_points, 0) as fantasy_points,
                    wr.roster_position
                FROM weekly_rosters wr
                LEFT JOIN player_stats ps ON
                    wr.player_id = ps.player_id
                    AND wr.week = ps.week
                    AND wr.season = ps.season
                WHERE wr.season = 2025
                AND wr.week = 1
                AND wr.roster_position = 'active'
                ORDER BY wr.team_id, wr.player_position, wr.player_name
            `;

            this.db.all(query, [], (err, rows) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(rows);
            });
        });
    }

    async getTeamMappings() {
        return new Promise((resolve, reject) => {
            const query = `
                SELECT team_id, owner_name
                FROM teams
                ORDER BY team_id
            `;

            this.db.all(query, [], (err, rows) => {
                if (err) {
                    reject(err);
                    return;
                }
                const mapping = {};
                rows.forEach(row => {
                    mapping[row.team_id] = row.owner_name;
                });
                resolve(mapping);
            });
        });
    }

    // Helper to check if positions are equivalent (TE and WR are interchangeable)
    arePositionsEquivalent(pos1, pos2) {
        const p1 = pos1?.toUpperCase();
        const p2 = pos2?.toUpperCase();

        // Exact match
        if (p1 === p2) return true;

        // TE and WR are considered equivalent
        if ((p1 === 'TE' || p1 === 'WR') && (p2 === 'TE' || p2 === 'WR')) {
            return true;
        }

        // DEF and DST are equivalent
        if ((p1 === 'DEF' || p1 === 'DST') && (p2 === 'DEF' || p2 === 'DST')) {
            return true;
        }

        return false;
    }

    findMatchingPlayer(dbPlayer, expectedPlayers) {
        const dbNameNorm = this.normalizePlayerName(dbPlayer.player_name);
        const dbPosition = dbPlayer.position?.toUpperCase();

        // Special handling for defenses
        if (dbPosition === 'DEF' || dbPosition === 'DST') {
            const dbDefNorm = this.normalizeDefenseName(dbPlayer.player_name, dbPlayer.team);

            for (const expPlayer of expectedPlayers) {
                if (expPlayer.position === 'DEF' || expPlayer.position === 'DST') {
                    const expDefNorm = this.normalizeDefenseName(expPlayer.name, expPlayer.team);

                    // Check if team names match
                    if (dbDefNorm.includes(expDefNorm) || expDefNorm.includes(dbDefNorm) ||
                        dbPlayer.team?.toLowerCase() === expPlayer.team?.toLowerCase()) {
                        return expPlayer;
                    }
                }
            }
        }

        // Regular player matching
        for (const expPlayer of expectedPlayers) {
            const expNameNorm = this.normalizePlayerName(expPlayer.name);
            const expPosition = expPlayer.position?.toUpperCase();

            // Match by normalized name and position (considering TE/WR equivalence)
            if (dbNameNorm === expNameNorm && this.arePositionsEquivalent(dbPosition, expPosition)) {
                return expPlayer;
            }

            // Fallback: match by last name and position if unique
            const dbLastName = dbNameNorm.split(' ').pop();
            const expLastName = expNameNorm.split(' ').pop();
            if (dbLastName === expLastName && this.arePositionsEquivalent(dbPosition, expPosition)) {
                // Check if this is unique
                const sameLastNameCount = expectedPlayers.filter(p =>
                    this.normalizePlayerName(p.name).split(' ').pop() === dbLastName &&
                    this.arePositionsEquivalent(p.position, dbPosition)
                ).length;

                if (sameLastNameCount === 1) {
                    return expPlayer;
                }
            }
        }

        return null;
    }

    async compareWeek1Stats() {
        try {
            const dbStats = await this.getWeek1StatsFromDatabase();
            const teamMappings = await this.getTeamMappings();
            const expected = expectedStats.teams;

            // Group database stats by team
            const dbStatsByTeam = {};
            dbStats.forEach(stat => {
                const ownerName = teamMappings[stat.team_id];
                if (!dbStatsByTeam[ownerName]) {
                    dbStatsByTeam[ownerName] = [];
                }
                dbStatsByTeam[ownerName].push(stat);
            });

            // Compare each team
            for (const [ownerName, expectedTeam] of Object.entries(expected)) {
                const dbTeamStats = dbStatsByTeam[ownerName] || [];

                console.log(`\n📊 Checking ${ownerName}'s team...`);

                // Check player count
                if (dbTeamStats.length !== 19) {
                    console.error(`  ❌ Player count mismatch: Expected 19, found ${dbTeamStats.length}`);
                    this.teamMismatches.push({
                        owner: ownerName,
                        issue: 'player_count',
                        expected: 19,
                        actual: dbTeamStats.length
                    });
                }

                // Track matched players to find missing ones
                const matchedExpectedPlayers = new Set();
                let teamTotal = 0;

                // Check each database player
                for (const dbPlayer of dbTeamStats) {
                    const matchedPlayer = this.findMatchingPlayer(dbPlayer, expectedTeam.players);

                    if (!matchedPlayer) {
                        console.error(`  ⚠️ Unexpected player in roster: ${dbPlayer.player_name} (${dbPlayer.position})`);
                        this.mismatches.push({
                            owner: ownerName,
                            player: dbPlayer.player_name,
                            position: dbPlayer.position,
                            issue: 'unexpected_player',
                            dbPoints: dbPlayer.fantasy_points
                        });
                        teamTotal += dbPlayer.fantasy_points;
                    } else {
                        matchedExpectedPlayers.add(matchedPlayer);
                        teamTotal += dbPlayer.fantasy_points;

                        // Compare points with tolerance
                        const dbPoints = Math.round(dbPlayer.fantasy_points * 10) / 10;
                        const expPoints = matchedPlayer.points;
                        const diff = Math.abs(dbPoints - expPoints);

                        if (diff > 0.1) {
                            console.error(`  ❌ ${dbPlayer.player_name}: ${dbPoints} (expected ${expPoints})`);
                            this.mismatches.push({
                                owner: ownerName,
                                player: dbPlayer.player_name,
                                position: dbPlayer.position,
                                team: dbPlayer.team,
                                dbPoints: dbPoints,
                                expectedPoints: expPoints,
                                difference: diff
                            });
                        }
                    }
                }

                // Check for missing expected players
                for (const expPlayer of expectedTeam.players) {
                    if (!matchedExpectedPlayers.has(expPlayer)) {
                        console.error(`  ⚠️ Missing expected player: ${expPlayer.name} (${expPlayer.position})`);
                        this.mismatches.push({
                            owner: ownerName,
                            player: expPlayer.name,
                            position: expPlayer.position,
                            issue: 'missing_player',
                            expectedPoints: expPlayer.points
                        });
                    }
                }

                // Check team total
                teamTotal = Math.round(teamTotal * 10) / 10;
                const expectedTotal = expectedTeam.total;
                const totalDiff = Math.abs(teamTotal - expectedTotal);

                if (totalDiff > 0.1) {
                    console.error(`  ❌ Team total: ${teamTotal} (expected ${expectedTotal})`);
                    this.teamMismatches.push({
                        owner: ownerName,
                        issue: 'total_mismatch',
                        actual: teamTotal,
                        expected: expectedTotal,
                        difference: totalDiff
                    });
                } else {
                    console.log(`  ✅ Team total: ${teamTotal} ✓`);
                }
            }

        } catch (error) {
            console.error('Error during comparison:', error);
            throw error;
        }
    }

    generateReport() {
        console.log('\n' + '='.repeat(60));
        console.log('📋 WEEK 1 2025 STATS VERIFICATION REPORT');
        console.log('='.repeat(60));

        if (this.mismatches.length === 0 && this.teamMismatches.length === 0) {
            console.log('\n✅ All stats match expected values!');
            console.log('   - All 12 teams verified');
            console.log('   - All player scores match within tolerance (0.1)');
            console.log('   - All team totals correct');
        } else {
            console.log(`\n⚠️ Found ${this.mismatches.length} player mismatches`);
            console.log(`⚠️ Found ${this.teamMismatches.length} team-level issues`);

            // Group mismatches by type
            const byIssueType = {};
            this.mismatches.forEach(m => {
                const type = m.issue || 'points_mismatch';
                if (!byIssueType[type]) byIssueType[type] = [];
                byIssueType[type].push(m);
            });

            // Report each type
            if (byIssueType.points_mismatch) {
                console.log(`\n📊 Points Mismatches (${byIssueType.points_mismatch.length}):`);
                byIssueType.points_mismatch.forEach(m => {
                    console.log(`   ${m.owner} - ${m.player}: ${m.dbPoints} vs ${m.expectedPoints} (diff: ${m.difference.toFixed(1)})`);
                });
            }

            if (byIssueType.missing_player) {
                console.log(`\n❓ Missing Players (${byIssueType.missing_player.length}):`);
                byIssueType.missing_player.forEach(m => {
                    console.log(`   ${m.owner} - ${m.player} (${m.position})`);
                });
            }

            if (byIssueType.unexpected_player) {
                console.log(`\n⚠️ Unexpected Players (${byIssueType.unexpected_player.length}):`);
                byIssueType.unexpected_player.forEach(m => {
                    console.log(`   ${m.owner} - ${m.player} (${m.position})`);
                });
            }

            // Team issues
            if (this.teamMismatches.length > 0) {
                console.log('\n🏈 Team-Level Issues:');
                this.teamMismatches.forEach(m => {
                    if (m.issue === 'player_count') {
                        console.log(`   ${m.owner}: ${m.actual} players (expected ${m.expected})`);
                    } else if (m.issue === 'total_mismatch') {
                        console.log(`   ${m.owner}: Total ${m.actual} vs ${m.expected} (diff: ${m.difference.toFixed(1)})`);
                    }
                });
            }
        }

        console.log('\n' + '='.repeat(60));
    }

    async close() {
        return new Promise((resolve) => {
            if (this.db) {
                this.db.close((err) => {
                    if (err) {
                        console.error('Error closing database:', err);
                    }
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }
}

// Export for testing
module.exports = StatsComparator2025;

// Run if executed directly
if (require.main === module) {
    const comparator = new StatsComparator2025();

    (async () => {
        try {
            await comparator.initialize();
            await comparator.compareWeek1Stats();
            comparator.generateReport();
        } catch (error) {
            console.error('Fatal error:', error);
            process.exit(1);
        } finally {
            await comparator.close();
        }
    })();
}