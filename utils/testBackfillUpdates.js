#!/usr/bin/env node

const { Backfill2024Stats } = require('./backfill2024Stats');

/**
 * Test the updated backfill script on a small sample
 * to verify DST stats and defensive stats are imported correctly
 */

class BackfillTester {
    constructor() {
        this.backfiller = new Backfill2024Stats();
    }

    async run() {
        console.log('🧪 Testing Updated Backfill Script...\n');

        try {
            // Prepare database (add missing columns)
            await this.backfiller.prepareDatabase();
            
            // Test on Week 1, 2024 - just one week for verification
            console.log('📅 Testing Week 1, 2024...');
            await this.backfiller.processWeek(1, 2024);
            
            // Verify the results
            await this.verifyResults();
            
            console.log('\n🎉 Backfill test completed successfully!');
            
        } catch (error) {
            console.error('❌ Test failed:', error.message);
            throw error;
        } finally {
            this.backfiller.db.close();
        }
    }

    async verifyResults() {
        console.log('\n🔍 Verifying imported data...');
        
        return new Promise((resolve, reject) => {
            // Check for DST records
            this.backfiller.db.all(`
                SELECT player_name, team, position, sacks, def_interceptions, def_touchdowns, 
                       points_allowed, yards_allowed, fumbles_recovered, safeties
                FROM player_stats 
                WHERE week = 1 AND season = 2024 AND position = 'DEF'
                ORDER BY team
            `, [], (err, dstRows) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                console.log(`✅ Found ${dstRows.length} DST records`);
                if (dstRows.length > 0) {
                    console.log('   Sample DST records:');
                    dstRows.slice(0, 3).forEach(row => {
                        console.log(`   - ${row.player_name}: ${row.sacks} sacks, ${row.def_interceptions} INTs, ${row.points_allowed} pts allowed`);
                    });
                }
                
                // Check for individual defensive stats
                this.backfiller.db.all(`
                    SELECT player_name, team, position, sacks, def_interceptions, def_touchdowns, return_tds
                    FROM player_stats 
                    WHERE week = 1 AND season = 2024 AND position != 'DEF' 
                    AND (sacks > 0 OR def_interceptions > 0 OR def_touchdowns > 0 OR return_tds > 0)
                    ORDER BY sacks DESC, def_interceptions DESC
                    LIMIT 10
                `, [], (err, defRows) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    
                    console.log(`✅ Found ${defRows.length} individual players with defensive stats`);
                    if (defRows.length > 0) {
                        console.log('   Sample individual defensive stats:');
                        defRows.forEach(row => {
                            const stats = [];
                            if (row.sacks > 0) stats.push(`${row.sacks} sacks`);
                            if (row.def_interceptions > 0) stats.push(`${row.def_interceptions} INTs`);
                            if (row.def_touchdowns > 0) stats.push(`${row.def_touchdowns} def TDs`);
                            if (row.return_tds > 0) stats.push(`${row.return_tds} return TDs`);
                            console.log(`   - ${row.player_name} (${row.position}): ${stats.join(', ')}`);
                        });
                    }
                    
                    // Check total stats imported
                    this.backfiller.db.get(`
                        SELECT COUNT(*) as total_stats, 
                               SUM(CASE WHEN position = 'DEF' THEN 1 ELSE 0 END) as dst_stats,
                               SUM(CASE WHEN sacks > 0 OR def_interceptions > 0 THEN 1 ELSE 0 END) as players_with_def_stats
                        FROM player_stats 
                        WHERE week = 1 AND season = 2024
                    `, [], (err, summary) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        
                        console.log(`\n📊 Week 1 Import Summary:`);
                        console.log(`   Total player records: ${summary.total_stats}`);
                        console.log(`   DST records: ${summary.dst_stats}`);
                        console.log(`   Players with defensive stats: ${summary.players_with_def_stats}`);
                        
                        resolve();
                    });
                });
            });
        });
    }
}

// Main execution
async function main() {
    const tester = new BackfillTester();
    
    try {
        await tester.run();
    } catch (error) {
        console.error('❌ Fatal error:', error.message);
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    main();
}

module.exports = { BackfillTester };