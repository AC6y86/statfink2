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
                // Get stats for players who were on fantasy rosters
                // Now using Tank01 IDs - join on player_id directly
                query = `
                    SELECT 
                        ps.player_id,
                        p.name as player_name,
                        ps.week,
                        ps.season,
                        p.position,
                        p.team,
                        ps.passing_yards,
                        ps.passing_tds,
                        ps.interceptions,
                        ps.rushing_yards,
                        ps.rushing_tds,
                        ps.receiving_yards,
                        ps.receiving_tds,
                        ps.receptions,
                        ps.fumbles,
                        ps.sacks,
                        ps.def_interceptions,
                        ps.fumbles_recovered,
                        ps.def_touchdowns,
                        ps.points_allowed,
                        ps.yards_allowed,
                        ps.field_goals_made,
                        ps.field_goals_attempted,
                        ps.extra_points_made,
                        ps.extra_points_attempted,
                        ps.fantasy_points
                    FROM player_stats ps
                    JOIN nfl_players p ON ps.player_id = p.player_id
                    WHERE ps.season = 2024
                    AND EXISTS (
                        SELECT 1 FROM weekly_rosters wr 
                        WHERE wr.season = ps.season 
                        AND wr.week = ps.week
                        AND wr.player_id = ps.player_id
                    )
                    ORDER BY ps.week, p.name
                `;
            } else {
                query = `
                    SELECT 
                        ps.player_id,
                        p.name as player_name,
                        ps.week,
                        ps.season,
                        p.position,
                        p.team,
                        ps.passing_yards,
                        ps.passing_tds,
                        ps.interceptions,
                        ps.rushing_yards,
                        ps.rushing_tds,
                        ps.receiving_yards,
                        ps.receiving_tds,
                        ps.receptions,
                        ps.fumbles,
                        ps.sacks,
                        ps.def_interceptions,
                        ps.fumbles_recovered,
                        ps.def_touchdowns,
                        ps.points_allowed,
                        ps.yards_allowed,
                        ps.field_goals_made,
                        ps.field_goals_attempted,
                        ps.extra_points_made,
                        ps.extra_points_attempted,
                        ps.fantasy_points
                    FROM player_stats ps
                    JOIN nfl_players p ON ps.player_id = p.player_id
                    WHERE ps.season = 2024
                    ORDER BY ps.week, p.name
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
            .replace(/['']/g, "'") // Normalize apostrophes
            .replace(/\./g, '') // Remove periods
            .trim()
            .toLowerCase();
        
        // Special handling for defenses - extract just the team nickname
        if (position === 'DEF' || position === 'DST' || normalized.includes('defense') || name.includes('Defense')) {
            // Map full team names to nicknames as they appear in reference DB
            const teamMap = {
                'arizona cardinals': 'cardinals',
                'atlanta falcons': 'falcons',
                'baltimore ravens': 'ravens',
                'buffalo bills': 'bills',
                'carolina panthers': 'panthers',
                'chicago bears': 'bears',
                'cincinnati bengals': 'bengals',
                'cleveland browns': 'browns',
                'dallas cowboys': 'cowboys',
                'denver broncos': 'broncos',
                'detroit lions': 'lions',
                'green bay packers': 'packers',
                'houston texans': 'texans',
                'indianapolis colts': 'colts',
                'jacksonville jaguars': 'jaguars',
                'kansas city chiefs': 'chiefs',
                'las vegas raiders': 'raiders',
                'los angeles chargers': 'chargers',
                'los angeles rams': 'rams',
                'miami dolphins': 'dolphins',
                'minnesota vikings': 'vikings',
                'new england patriots': 'patriots',
                'new orleans saints': 'saints',
                'new york giants': 'giants',
                'new york jets': 'jets',
                'philadelphia eagles': 'eagles',
                'pittsburgh steelers': 'steelers',
                'san francisco 49ers': '49ers',
                'seattle seahawks': 'seahawks',
                'tampa bay buccaneers': 'buccaneers',
                'tennessee titans': 'titans',
                'washington commanders': 'commanders'
            };
            
            // Try to find and extract team nickname
            const lowerName = name.toLowerCase();
            for (const [fullTeam, nickname] of Object.entries(teamMap)) {
                if (lowerName.includes(fullTeam)) {
                    return nickname;
                }
            }
            
            // If not found, try to extract just the last word before "defense"
            const words = normalized.split(' ');
            const defenseIndex = words.indexOf('defense');
            if (defenseIndex > 0) {
                return words[defenseIndex - 1];
            }
            
            // For abbreviated names like "ARI", use the existing reverse mapping
            const abbreviationMap = {
                'ari': 'cardinals',
                'atl': 'falcons',
                'bal': 'ravens',
                'buf': 'bills',
                'car': 'panthers',
                'chi': 'bears',
                'cin': 'bengals',
                'cle': 'browns',
                'dal': 'cowboys',
                'den': 'broncos',
                'det': 'lions',
                'gb': 'packers',
                'hou': 'texans',
                'ind': 'colts',
                'jax': 'jaguars',
                'kc': 'chiefs',
                'lac': 'chargers',
                'lar': 'rams',
                'lv': 'raiders',
                'mia': 'dolphins',
                'min': 'vikings',
                'ne': 'patriots',
                'no': 'saints',
                'nyg': 'giants',
                'nyj': 'jets',
                'phi': 'eagles',
                'pit': 'steelers',
                'sea': 'seahawks',
                'sf': '49ers',
                'tb': 'buccaneers',
                'ten': 'titans',
                'was': 'commanders',
                'wsh': 'commanders'
            };
            
            for (const [abbr, nickname] of Object.entries(abbreviationMap)) {
                if (normalized === abbr) {
                    return nickname;
                }
            }
        }
        
        return normalized;
    }
    
    // Create a more flexible name matching function
    createNameVariations(name) {
        const variations = [];
        
        // Base name
        variations.push(name);
        
        // Special handling for defense names
        if (name.includes('Defense')) {
            // Extract just the team nickname
            const teamMap = {
                'Arizona Cardinals Defense': 'Cardinals',
                'Atlanta Falcons Defense': 'Falcons',
                'Baltimore Ravens Defense': 'Ravens',
                'Buffalo Bills Defense': 'Bills',
                'Carolina Panthers Defense': 'Panthers',
                'Chicago Bears Defense': 'Bears',
                'Cincinnati Bengals Defense': 'Bengals',
                'Cleveland Browns Defense': 'Browns',
                'Dallas Cowboys Defense': 'Cowboys',
                'Denver Broncos Defense': 'Broncos',
                'Detroit Lions Defense': 'Lions',
                'Green Bay Packers Defense': 'Packers',
                'Houston Texans Defense': 'Texans',
                'Indianapolis Colts Defense': 'Colts',
                'Jacksonville Jaguars Defense': 'Jaguars',
                'Kansas City Chiefs Defense': 'Chiefs',
                'Las Vegas Raiders Defense': 'Raiders',
                'Los Angeles Chargers Defense': 'Chargers',
                'Los Angeles Rams Defense': 'Rams',
                'Miami Dolphins Defense': 'Dolphins',
                'Minnesota Vikings Defense': 'Vikings',
                'New England Patriots Defense': 'Patriots',
                'New Orleans Saints Defense': 'Saints',
                'New York Giants Defense': 'Giants',
                'New York Jets Defense': 'Jets',
                'Philadelphia Eagles Defense': 'Eagles',
                'Pittsburgh Steelers Defense': 'Steelers',
                'San Francisco 49ers Defense': '49ers',
                'Seattle Seahawks Defense': 'Seahawks',
                'Tampa Bay Buccaneers Defense': 'Buccaneers',
                'Tennessee Titans Defense': 'Titans',
                'Washington Commanders Defense': 'Commanders'
            };
            
            if (teamMap[name]) {
                variations.push(teamMap[name]);
            }
        }
        
        // Remove suffixes
        const withoutSuffix = name.replace(/\s+(Jr\.?|Sr\.?|III|II|IV|V)$/i, '');
        if (withoutSuffix !== name) {
            variations.push(withoutSuffix);
        }
        
        // Remove periods
        const withoutPeriods = name.replace(/\./g, '');
        if (withoutPeriods !== name) {
            variations.push(withoutPeriods);
        }
        
        // Remove apostrophes
        const withoutApostrophes = name.replace(/['']/g, '');
        if (withoutApostrophes !== name) {
            variations.push(withoutApostrophes);
        }
        
        // Handle "St. Brown" vs "St.Brown" specifically
        if (name.includes('St. ')) {
            variations.push(name.replace('St. ', 'St.'));
        }
        if (name.includes('St.')) {
            variations.push(name.replace('St.', 'St. '));
        }
        
        // First name + last name only (for names with middle initials)
        const parts = name.split(/\s+/);
        if (parts.length > 2) {
            // Try first + last
            variations.push(`${parts[0]} ${parts[parts.length - 1]}`);
        }
        
        // Common nickname variations
        const nicknames = {
            'William': 'Will',
            'Robert': 'Rob',
            'Michael': 'Mike',
            'Christopher': 'Chris',
            'Matthew': 'Matt',
            'Joshua': 'Josh',
            'Daniel': 'Dan',
            'Benjamin': 'Ben',
            'Nicholas': 'Nick',
            'Alexander': 'Alex'
        };
        
        for (const [full, nick] of Object.entries(nicknames)) {
            if (name.includes(full)) {
                variations.push(name.replace(full, nick));
            }
            if (name.includes(nick)) {
                variations.push(name.replace(nick, full));
            }
        }
        
        return [...new Set(variations)]; // Remove duplicates
    }

    compareStats(current, reference) {
        const currentNorm = {
            passing_yards: current.passing_yards || 0,
            passing_tds: current.passing_tds || 0,
            interceptions: current.interceptions || 0,
            rushing_yards: current.rushing_yards || 0,
            rushing_tds: current.rushing_tds || 0,
            receiving_yards: current.receiving_yards || 0,
            receiving_tds: current.receiving_tds || 0,
            receptions: current.receptions || 0,
            fumbles: current.fumbles || 0,
            sacks: current.sacks || 0,
            def_interceptions: current.def_interceptions || 0,
            fumbles_recovered: current.fumbles_recovered || 0,
            def_touchdowns: current.def_touchdowns || 0,
            points_allowed: current.points_allowed || 0,
            yards_allowed: current.yards_allowed || 0,
            field_goals_made: current.field_goals_made || 0,
            field_goals_attempted: current.field_goals_attempted || 0,
            extra_points_made: current.extra_points_made || 0,
            extra_points_attempted: current.extra_points_attempted || 0,
            fantasy_points: current.fantasy_points || 0
        };

        const referenceNorm = {
            fantasy_points: reference.fantasy_points || 0
        };
        
        // Only compare fantasy points since reference DB only has that
        if (Math.abs(currentNorm.fantasy_points - referenceNorm.fantasy_points) > 0.1) {
            return {
                fantasy_points: {
                    current: currentNorm.fantasy_points,
                    reference: referenceNorm.fantasy_points,
                    diff: currentNorm.fantasy_points - referenceNorm.fantasy_points
                }
            };
        }
        
        return null;
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
            const referenceMap = new Map();
            const referenceMapNormalized = new Map();
            const referenceMapVariations = new Map();
            
            referenceStats.forEach(stat => {
                const key = `${stat.player_name.toLowerCase()}_${stat.week}`;
                referenceMap.set(key, stat);
                
                // Also create normalized name map for fuzzy matching
                const normalizedKey = `${this.normalizePlayerName(stat.player_name, stat.position)}_${stat.week}`;
                referenceMapNormalized.set(normalizedKey, stat);
                
                // Create variations map
                const variations = this.createNameVariations(stat.player_name);
                variations.forEach(variation => {
                    const varKey = `${variation.toLowerCase()}_${stat.week}`;
                    referenceMapVariations.set(varKey, stat);
                });
            });
            
            // Compare each current stat with reference
            let totalComparisons = 0;
            let totalMismatches = 0;
            let totalMatches = 0;
            let notFoundInReference = 0;
            
            for (const currentStat of currentStats) {
                // For roster players, include 0 points (they might have points in reference)
                // For all players mode, skip 0 points to reduce noise
                if (!rosterPlayersOnly) {
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
                
                // If still not found, try name variations
                if (!referenceStat) {
                    const variations = this.createNameVariations(currentStat.player_name);
                    for (const variation of variations) {
                        const varKey = `${variation.toLowerCase()}_${currentStat.week}`;
                        referenceStat = referenceMapVariations.get(varKey);
                        if (referenceStat) break;
                    }
                }
                
                if (!referenceStat) {
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
            console.log(`Total player-week records${rosterPlayersOnly ? ' (on fantasy rosters)' : ' with fantasy points'}: ${rosterPlayersOnly ? currentStats.length : currentStats.filter(s => s.fantasy_points > 0).length}`);
            console.log(`Players not found in reference database: ${notFoundInReference}`);
            console.log(`Total comparisons made (found in both DBs): ${totalComparisons}`);
            console.log(`Total matches: ${totalMatches}`);
            console.log(`Total fantasy point mismatches: ${totalMismatches}`);
            if (totalComparisons > 0) {
                console.log(`Match rate (for found players): ${(totalMatches / totalComparisons * 100).toFixed(2)}%`);
            }
            
            // Show week coverage
            const weeksWithData = [...new Set(currentStats.map(s => s.week))].sort((a, b) => a - b);
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
                    
                    console.log(`\n${mismatch.player_name} (${mismatch.position}, ${mismatch.team}) [ID: ${mismatch.player_id}]`);
                    
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

module.exports = StatsComparator;