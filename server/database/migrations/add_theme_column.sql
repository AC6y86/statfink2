-- Add theme column to league_settings table
-- Default to 'plain' which represents the current look
ALTER TABLE league_settings ADD COLUMN theme VARCHAR(20) DEFAULT 'plain';
