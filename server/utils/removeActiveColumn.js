const DatabaseManager = require('../database/database');
const { logInfo, logError } = require('./errorHandler');

async function removeActiveColumn() {
    const db = new DatabaseManager();
    
    try {
        // Wait a moment for database to initialize
        await new Promise(resolve => setTimeout(resolve, 100));
        logInfo('Database initialized for migration');
        
        // Check if column exists
        const tableInfo = await db.all("PRAGMA table_info(nfl_players)");
        const hasActiveColumn = tableInfo.some(col => col.name === 'is_active');
        
        if (!hasActiveColumn) {
            logInfo('is_active column does not exist, no migration needed');
            return;
        }
        
        logInfo('Removing is_active column from nfl_players table...');
        
        // SQLite doesn't support DROP COLUMN directly, so we need to recreate the table
        await db.run('BEGIN TRANSACTION');
        
        // Disable foreign key constraints temporarily
        await db.run('PRAGMA foreign_keys = OFF');
        
        // Create new table without is_active column
        await db.run(`
            CREATE TABLE nfl_players_new (
                player_id VARCHAR(50) PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                position VARCHAR(10) NOT NULL,
                team VARCHAR(10) NOT NULL,
                bye_week INTEGER,
                last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Copy data from old table (excluding is_active)
        await db.run(`
            INSERT INTO nfl_players_new (player_id, name, position, team, bye_week, last_updated)
            SELECT player_id, name, position, team, bye_week, last_updated
            FROM nfl_players
        `);
        
        // Drop old table
        await db.run('DROP TABLE nfl_players');
        
        // Rename new table
        await db.run('ALTER TABLE nfl_players_new RENAME TO nfl_players');
        
        // Recreate index without is_active
        await db.run('CREATE INDEX IF NOT EXISTS idx_nfl_players_position ON nfl_players(position)');
        
        // Re-enable foreign key constraints
        await db.run('PRAGMA foreign_keys = ON');
        
        await db.run('COMMIT');
        
        logInfo('Successfully removed is_active column from nfl_players table');
        
    } catch (error) {
        try {
            await db.run('ROLLBACK');
        } catch (rollbackError) {
            // Rollback might fail if no transaction is active
        }
        logError('Failed to remove is_active column', error);
        throw error;
    } finally {
        db.close();
    }
}

// Run migration if called directly
if (require.main === module) {
    removeActiveColumn()
        .then(() => {
            console.log('Migration completed successfully');
            process.exit(0);
        })
        .catch(error => {
            console.error('Migration failed:', error.message);
            process.exit(1);
        });
}

module.exports = removeActiveColumn;