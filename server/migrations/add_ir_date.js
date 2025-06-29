// Migration to add ir_date column to weekly_rosters table
const DatabaseManager = require('../database/database');

async function runMigration() {
    const db = new DatabaseManager();
    
    try {
        // Check if column already exists
        const tableInfo = await db.all(`PRAGMA table_info(weekly_rosters)`);
        const columnExists = tableInfo.some(col => col.name === 'ir_date');
        
        if (columnExists) {
            console.log('ir_date column already exists');
            return;
        }
        
        // Add the column
        await db.run(`ALTER TABLE weekly_rosters ADD COLUMN ir_date DATETIME DEFAULT NULL`);
        console.log('Successfully added ir_date column to weekly_rosters table');
        
        // Update existing IR players with current date
        await db.run(`
            UPDATE weekly_rosters 
            SET ir_date = CURRENT_TIMESTAMP 
            WHERE roster_position = 'injured_reserve' AND ir_date IS NULL
        `);
        console.log('Updated existing IR players with current date');
        
    } catch (error) {
        console.error('Migration failed:', error);
        throw error;
    }
}

// Run the migration
if (require.main === module) {
    runMigration()
        .then(() => {
            console.log('Migration completed successfully');
            process.exit(0);
        })
        .catch(err => {
            console.error('Migration failed:', err);
            process.exit(1);
        });
}

module.exports = runMigration;