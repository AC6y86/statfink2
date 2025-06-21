-- Migration: Drop fantasy_rosters table
-- Date: 2025-06-21
-- Description: Remove fantasy_rosters table after migrating to weekly_rosters

-- Drop the index first
DROP INDEX IF EXISTS idx_fantasy_rosters_team;

-- Drop the table
DROP TABLE IF EXISTS fantasy_rosters;

-- Remove fantasy_rosters references from schema.sql
-- Note: This will need to be done manually in schema.sql