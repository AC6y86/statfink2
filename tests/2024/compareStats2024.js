const sqlite3 = require('sqlite3').verbose();
const path = require('path');

class StatsComparator {
    constructor() {
        // Current database with imported stats
        this.currentDbPath = path.join(__dirname, '../../fantasy_football.db');
        // Reference database with manually calculated stats
        this.referenceDbPath = path.join(__dirname, 'statfinkv1_2024.db');
        
        this.currentDb = null;
        this.referenceDb = null;
        this.mismatches = [];
    }

    async initialize() {
        return new Promise((resolve, reject) => {
            // Open current database
            this.currentDb = new sqlite3.Database(this.currentDbPath, (err) => {
                if (err) {
                    console.error('Error opening current database:', err);
                    reject(err);
                    return;
                }
                
                // Open reference database
                this.referenceDb = new sqlite3.Database(this.referenceDbPath, (err) => {
                    if (err) {
                        console.error('Error opening reference database:', err);
                        reject(err);
                        return;
                    }
                    
                    console.log('Both databases opened successfully');
                    resolve();
                });
            });
        });
    }

    async getStatsFromCurrent(rosterPlayersOnly = false) {
        return new Promise((resolve, reject) => {
            let query;
            if (rosterPlayersOnly) {
                // Only get stats for players who were on fantasy rosters
                query = `
                    SELECT 
                        MIN(ps.player_id) as player_id,
                        ps.player_name,
                        ps.week,
                        ps.season,
                        ps.position,
                        ps.team,
                        MAX(ps.passing_yards) as passing_yards,
                        MAX(ps.passing_tds) as passing_tds,
                        MAX(ps.interceptions) as interceptions,
                        MAX(ps.rushing_yards) as rushing_yards,
                        MAX(ps.rushing_tds) as rushing_tds,
                        MAX(ps.receiving_yards) as receiving_yards,
                        MAX(ps.receiving_tds) as receiving_tds,
                        MAX(ps.receptions) as receptions,
                        MAX(ps.fumbles) as fumbles,
                        MAX(ps.sacks) as sacks,
                        MAX(ps.def_interceptions) as def_interceptions,
                        MAX(ps.fumbles_recovered) as fumbles_recovered,
                        MAX(ps.def_touchdowns) as def_touchdowns,
                        MAX(ps.points_allowed) as points_allowed,
                        MAX(ps.yards_allowed) as yards_allowed,
                        MAX(ps.field_goals_made) as field_goals_made,
                        MAX(ps.field_goals_attempted) as field_goals_attempted,
                        MAX(ps.extra_points_made) as extra_points_made,
                        MAX(ps.extra_points_attempted) as extra_points_attempted,
                        MAX(ps.fantasy_points) as fantasy_points
                    FROM player_stats ps
                    WHERE ps.season = 2024
                    AND EXISTS (
                        SELECT 1 FROM weekly_rosters wr 
                        WHERE wr.season = ps.season 
                        AND wr.week = ps.week
                        AND (
                            -- Non-defense: match by exact name
                            (ps.position != 'DEF' AND wr.player_name = ps.player_name)
                            OR
                            -- Defense: both must be defenses (let normalization handle name matching)
                            (ps.position = 'DEF' AND wr.player_position = 'DEF')
                        )
                    )
                    GROUP BY ps.player_name, ps.week, ps.season, ps.position, ps.team
                    ORDER BY ps.week, ps.player_name
                `;
            } else {
                query = `
                    SELECT 
                        player_id,
                        player_name,
                        week,
                        season,
                        position,
                        team,
                        passing_yards,
                        passing_tds,
                        interceptions,
                        rushing_yards,
                        rushing_tds,
                        receiving_yards,
                        receiving_tds,
                        receptions,
                        fumbles,
                        sacks,
                        def_interceptions,
                        fumbles_recovered,
                        def_touchdowns,
                        points_allowed,
                        yards_allowed,
                        field_goals_made,
                        field_goals_attempted,
                        extra_points_made,
                        extra_points_attempted,
                        fantasy_points
                    FROM player_stats
                    WHERE season = 2024
                    ORDER BY week, player_name
                `;
            }
            
            this.currentDb.all(query, [], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    async getStatsFromReference() {
        return new Promise((resolve, reject) => {
            // The reference database has a different structure
            // It stores only fantasy_points in weekly_player_performance table
            const query = `
                SELECT 
                    p.player_name,
                    p.position,
                    p.nfl_team as team,
                    wpp.week,
                    wpp.fantasy_points,
                    wpp.player_id
                FROM weekly_player_performance wpp
                JOIN players p ON wpp.player_id = p.player_id
                ORDER BY wpp.week, p.player_name
            `;
            
            this.referenceDb.all(query, [], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    console.log(`Found ${rows.length} performance records in reference database`);
                    resolve(rows);
                }
            });
        });
    }

    normalizePlayerName(name, position = null) {
        // Remove common suffixes and normalize the name for matching
        let normalized = name
            .replace(/\s+(Jr\.?|Sr\.?|III|II|IV|V)$/i, '')
            .replace(/\s+Defense$/i, '')
            .replace(/\s+DEF$/i, '')
            .trim()
            .toLowerCase();
        
        // Special handling for defenses - convert abbreviations to full names
        if (position === 'DEF' || position === 'DST' || normalized.includes('defense')) {
            const teamMap = {
                'ari': 'cardinals', 'atl': 'falcons', 'bal': 'ravens', 'buf': 'bills',
                'car': 'panthers', 'chi': 'bears', 'cin': 'bengals', 'cle': 'browns',
                'dal': 'cowboys', 'den': 'broncos', 'det': 'lions', 'gb': 'packers',
                'hou': 'texans', 'ind': 'colts', 'jax': 'jaguars', 'kc': 'chiefs',
                'lac': 'chargers', 'lar': 'rams', 'lv': 'raiders', 'mia': 'dolphins',
                'min': 'vikings', 'ne': 'patriots', 'no': 'saints', 'nyg': 'giants',
                'nyj': 'jets', 'phi': 'eagles', 'pit': 'steelers', 'sea': 'seahawks',
                'sf': '49ers', 'tb': 'buccaneers', 'ten': 'titans', 'was': 'commanders',
                'wsh': 'commanders'
            };
            
            // Extract team abbreviation and convert to full name
            const teamAbbr = normalized.replace(/\s*defense\s*/, '').toLowerCase();
            if (teamMap[teamAbbr]) {
                normalized = teamMap[teamAbbr];
            }
        }
        
        return normalized;
    }

    normalizeStats(stats) {
        // Normalize stat values to handle nulls and ensure consistent comparison
        return {
            passing_yards: stats.passing_yards || 0,
            passing_tds: stats.passing_tds || 0,
            interceptions: stats.interceptions || 0,
            rushing_yards: stats.rushing_yards || 0,
            rushing_tds: stats.rushing_tds || 0,
            receiving_yards: stats.receiving_yards || 0,
            receiving_tds: stats.receiving_tds || 0,
            receptions: stats.receptions || 0,
            fumbles: stats.fumbles || 0,
            sacks: stats.sacks || 0,
            def_interceptions: stats.def_interceptions || 0,
            fumbles_recovered: stats.fumbles_recovered || 0,
            def_touchdowns: stats.def_touchdowns || 0,
            points_allowed: stats.points_allowed || 0,
            yards_allowed: stats.yards_allowed || 0,
            field_goals_made: stats.field_goals_made || 0,
            field_goals_attempted: stats.field_goals_attempted || 0,
            extra_points_made: stats.extra_points_made || 0,
            extra_points_attempted: stats.extra_points_attempted || 0,
            fantasy_points: stats.fantasy_points || 0
        };
    }

    compareStats(current, reference) {
        const currentNorm = this.normalizeStats(current);
        const referenceNorm = this.normalizeStats(reference);
        
        const statKeys = Object.keys(currentNorm);
        const differences = {};
        let hasDifference = false;
        
        for (const key of statKeys) {
            if (currentNorm[key] !== referenceNorm[key]) {
                differences[key] = {
                    current: currentNorm[key],
                    reference: referenceNorm[key],
                    diff: currentNorm[key] - referenceNorm[key]
                };
                hasDifference = true;
            }
        }
        
        return hasDifference ? differences : null;
    }

    async compareAllStats(rosterPlayersOnly = false) {
        try {
            console.log('Loading stats from current database...');
            if (rosterPlayersOnly) {
                console.log('Filtering to only players on fantasy rosters...');
            }
            const currentStats = await this.getStatsFromCurrent(rosterPlayersOnly);
            console.log(`Loaded ${currentStats.length} stat records from current database`);
            
            console.log('\nLoading stats from reference database...');
            const referenceStats = await this.getStatsFromReference();
            console.log(`Loaded ${referenceStats.length} stat records from reference database`);
            
            // Create lookup map for reference stats by player name and week
            // Since the reference DB uses different player IDs, we'll match by name
            const referenceMap = new Map();
            const referenceMapNormalized = new Map();
            referenceStats.forEach(stat => {
                const key = `${stat.player_name.toLowerCase()}_${stat.week}`;
                referenceMap.set(key, stat);
                
                // Also create normalized name map for fuzzy matching
                const normalizedKey = `${this.normalizePlayerName(stat.player_name, stat.position)}_${stat.week}`;
                referenceMapNormalized.set(normalizedKey, stat);
            });
            
            // Compare each current stat with reference
            let totalComparisons = 0;
            let totalMismatches = 0;
            let totalMatches = 0;
            let notFoundInReference = 0;
            
            for (const currentStat of currentStats) {
                // For roster players, include 0 points (they might have points in reference)
                // For all players mode, skip 0 points to reduce noise
                if (rosterPlayersOnly) {
                    // Include all roster players, even with 0 points
                } else {
                    // Skip if no fantasy points or zero points in current (likely didn't play)
                    if (!currentStat.fantasy_points || currentStat.fantasy_points === 0) {
                        continue;
                    }
                }
                
                const key = `${currentStat.player_name.toLowerCase()}_${currentStat.week}`;
                let referenceStat = referenceMap.get(key);
                
                // If not found, try normalized name matching
                if (!referenceStat) {
                    const normalizedKey = `${this.normalizePlayerName(currentStat.player_name, currentStat.position)}_${currentStat.week}`;
                    referenceStat = referenceMapNormalized.get(normalizedKey);
                }
                
                if (!referenceStat) {
                    // Try alternate matching for special cases like defenses
                    let altKey = null;
                    if (currentStat.position === 'DEF' || currentStat.position === 'DST') {
                        // Try team name variations for defenses
                        const teamName = currentStat.player_name.replace(' Defense', '').replace(' DEF', '');
                        altKey = `${teamName.toLowerCase()}_${currentStat.week}`;
                    }
                    
                    const altReferenceStat = altKey ? referenceMap.get(altKey) : null;
                    
                    if (!altReferenceStat) {
                        // Player/week combination not found in reference
                        this.mismatches.push({
                            week: currentStat.week,
                            player_id: currentStat.player_id,
                            player_name: currentStat.player_name,
                            position: currentStat.position,
                            team: currentStat.team,
                            issue: 'NOT_IN_REFERENCE',
                            current_fantasy_points: currentStat.fantasy_points,
                            reference_fantasy_points: null
                        });
                        notFoundInReference++;
                    } else {
                        totalComparisons++;
                        // Compare fantasy points
                        const currentPoints = Math.round(currentStat.fantasy_points * 10) / 10;
                        const referencePoints = Math.round(altReferenceStat.fantasy_points * 10) / 10;
                        
                        if (Math.abs(currentPoints - referencePoints) > 0.1) {
                            this.mismatches.push({
                                week: currentStat.week,
                                player_id: currentStat.player_id,
                                player_name: currentStat.player_name,
                                position: currentStat.position,
                                team: currentStat.team,
                                issue: 'FANTASY_POINTS_MISMATCH',
                                current_fantasy_points: currentPoints,
                                reference_fantasy_points: referencePoints,
                                difference: currentPoints - referencePoints
                            });
                            totalMismatches++;
                        } else {
                            totalMatches++;
                        }
                    }
                } else {
                    totalComparisons++;
                    // Compare fantasy points
                    const currentPoints = Math.round(currentStat.fantasy_points * 10) / 10;
                    const referencePoints = Math.round(referenceStat.fantasy_points * 10) / 10;
                    
                    if (Math.abs(currentPoints - referencePoints) > 0.1) {
                        this.mismatches.push({
                            week: currentStat.week,
                            player_id: currentStat.player_id,
                            player_name: currentStat.player_name,
                            position: currentStat.position,
                            team: currentStat.team,
                            issue: 'FANTASY_POINTS_MISMATCH',
                            current_fantasy_points: currentPoints,
                            reference_fantasy_points: referencePoints,
                            difference: currentPoints - referencePoints
                        });
                        totalMismatches++;
                    } else {
                        totalMatches++;
                    }
                }
            }
            
            // Sort mismatches by week, then by player name
            this.mismatches.sort((a, b) => {
                if (a.week !== b.week) return a.week - b.week;
                return a.player_name.localeCompare(b.player_name);
            });
            
            // Print results
            console.log('\n=== COMPARISON RESULTS ===');
            console.log(`Total player-week records${rosterPlayersOnly ? ' (including 0 points)' : ' with fantasy points'}: ${rosterPlayersOnly ? currentStats.length : currentStats.filter(s => s.fantasy_points > 0).length}`);
            console.log(`Players not found in reference database: ${notFoundInReference}`);
            console.log(`Total comparisons made (found in both DBs): ${totalComparisons}`);
            console.log(`Total matches: ${totalMatches}`);
            console.log(`Total fantasy point mismatches: ${totalMismatches}`);
            if (totalComparisons > 0) {
                console.log(`Match rate (for found players): ${(totalMatches / totalComparisons * 100).toFixed(2)}%`);
            }
            
            // Show week coverage
            const statsToAnalyze = rosterPlayersOnly ? currentStats : currentStats.filter(s => s.fantasy_points > 0);
            const weeksWithData = [...new Set(statsToAnalyze.map(s => s.week))].sort((a, b) => a - b);
            console.log(`\nWeeks analyzed: ${weeksWithData.join(', ')}`);
            
            // Show weeks with mismatches
            const weeksWithMismatches = [...new Set(this.mismatches.map(m => m.week))].sort((a, b) => a - b);
            if (weeksWithMismatches.length > 0) {
                console.log(`Weeks with mismatches: ${weeksWithMismatches.join(', ')}`);
            }
            
            if (this.mismatches.length > 0) {
                console.log('\n=== MISMATCHES BY WEEK ===\n');
                
                let currentWeek = -1;
                this.mismatches.forEach(mismatch => {
                    if (mismatch.week !== currentWeek) {
                        currentWeek = mismatch.week;
                        console.log(`\n--- WEEK ${currentWeek} ---`);
                    }
                    
                    console.log(`\n${mismatch.player_name} (${mismatch.position}, ${mismatch.team})`);
                    
                    if (mismatch.issue === 'NOT_IN_REFERENCE') {
                        console.log('  Issue: Not found in reference database');
                        console.log(`  Current fantasy points: ${mismatch.current_fantasy_points}`);
                    } else if (mismatch.issue === 'FANTASY_POINTS_MISMATCH') {
                        console.log(`  Fantasy points: current=${mismatch.current_fantasy_points}, reference=${mismatch.reference_fantasy_points}, diff=${mismatch.difference.toFixed(1)}`);
                    }
                });
                
                // Summary of mismatches by type
                const notInRef = this.mismatches.filter(m => m.issue === 'NOT_IN_REFERENCE').length;
                const pointsMismatch = this.mismatches.filter(m => m.issue === 'FANTASY_POINTS_MISMATCH').length;
                
                console.log('\n=== SUMMARY ===');
                console.log(`Player-week combinations not found in reference: ${notInRef}`);
                console.log(`Fantasy points mismatches (calculation differences): ${pointsMismatch}`);
                
                if (pointsMismatch > 0) {
                    console.log('\n=== FANTASY POINT MISMATCHES ONLY ===');
                    this.mismatches
                        .filter(m => m.issue === 'FANTASY_POINTS_MISMATCH')
                        .forEach(mismatch => {
                            console.log(`${mismatch.player_name} (Week ${mismatch.week}): current=${mismatch.current_fantasy_points}, reference=${mismatch.reference_fantasy_points}, diff=${mismatch.difference.toFixed(1)}`);
                        });
                }
            } else {
                console.log('\nNo mismatches found! All fantasy points match perfectly for players in both databases.');
            }
            
        } catch (error) {
            console.error('Error during comparison:', error);
        }
    }

    async close() {
        return new Promise((resolve) => {
            if (this.currentDb) {
                this.currentDb.close(() => {
                    if (this.referenceDb) {
                        this.referenceDb.close(() => {
                            resolve();
                        });
                    } else {
                        resolve();
                    }
                });
            } else {
                resolve();
            }
        });
    }
}

// Run the comparison
async function main() {
    const comparator = new StatsComparator();
    
    // Check command line arguments
    const args = process.argv.slice(2);
    const allPlayers = args.includes('--all-players') || args.includes('-a');
    const rosterPlayersOnly = !allPlayers; // Default to roster-only
    
    try {
        console.log('Starting 2024 stats comparison...');
        if (rosterPlayersOnly) {
            console.log('Mode: Comparing only players on fantasy rosters (default)');
            console.log('(Use --all-players or -a to compare all players)\n');
        } else {
            console.log('Mode: Comparing all players with stats\n');
        }
        
        await comparator.initialize();
        await comparator.compareAllStats(rosterPlayersOnly);
    } catch (error) {
        console.error('Fatal error:', error);
    } finally {
        await comparator.close();
        console.log('\nComparison complete.');
    }
}

// Execute
main().catch(console.error);