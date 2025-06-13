const express = require('express');
const router = express.Router();

// Get all table names and their structures
router.get('/tables', async (req, res) => {
    try {
        const db = req.app.locals.db;
        
        // Get all table names
        const tables = await db.all(`
            SELECT name 
            FROM sqlite_master 
            WHERE type='table' 
            AND name NOT LIKE 'sqlite_%'
            ORDER BY name
        `);
        
        // Get structure for each table
        const tableInfo = {};
        for (const table of tables) {
            const columns = await db.all(`PRAGMA table_info(${table.name})`);
            const rowCount = await db.get(`SELECT COUNT(*) as count FROM ${table.name}`);
            
            tableInfo[table.name] = {
                columns: columns,
                rowCount: rowCount.count
            };
        }
        
        res.json({
            success: true,
            data: tableInfo
        });
    } catch (error) {
        console.error('Error getting database tables:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Query a specific table with pagination
router.get('/table/:tableName', async (req, res) => {
    try {
        const { tableName } = req.params;
        const { page = 1, limit = 50, search = '', column = '' } = req.query;
        const offset = (page - 1) * limit;
        
        const db = req.app.locals.db;
        
        // Validate table name exists
        const tableExists = await db.get(`
            SELECT name 
            FROM sqlite_master 
            WHERE type='table' AND name = ?
        `, [tableName]);
        
        if (!tableExists) {
            return res.status(404).json({
                success: false,
                error: 'Table not found'
            });
        }
        
        // Build query with optional search
        let query = `SELECT * FROM ${tableName}`;
        let countQuery = `SELECT COUNT(*) as total FROM ${tableName}`;
        let params = [];
        
        if (search && column) {
            query += ` WHERE ${column} LIKE ?`;
            countQuery += ` WHERE ${column} LIKE ?`;
            params.push(`%${search}%`);
        }
        
        query += ` LIMIT ? OFFSET ?`;
        params.push(parseInt(limit), parseInt(offset));
        
        const [rows, totalResult] = await Promise.all([
            db.all(query, params),
            db.get(countQuery, search && column ? [`%${search}%`] : [])
        ]);
        
        res.json({
            success: true,
            data: {
                rows: rows,
                total: totalResult.total,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(totalResult.total / limit)
            }
        });
    } catch (error) {
        console.error('Error querying table:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Execute custom SQL query (read-only)
router.post('/query', async (req, res) => {
    try {
        const { sql } = req.body;
        
        if (!sql) {
            return res.status(400).json({
                success: false,
                error: 'SQL query is required'
            });
        }
        
        // Basic safety check - only allow SELECT statements
        const trimmedSql = sql.trim().toLowerCase();
        if (!trimmedSql.startsWith('select')) {
            return res.status(400).json({
                success: false,
                error: 'Only SELECT queries are allowed'
            });
        }
        
        const db = req.app.locals.db;
        const rows = await db.all(sql);
        
        res.json({
            success: true,
            data: {
                rows: rows,
                rowCount: rows.length
            }
        });
    } catch (error) {
        console.error('Error executing query:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;