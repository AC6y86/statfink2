-- Add division column to teams table
ALTER TABLE teams ADD COLUMN division TEXT DEFAULT '';

-- Update existing teams with their divisions based on team_id
-- Odd team_ids go to 'Odd' division, even team_ids go to 'Even' division
UPDATE teams 
SET division = CASE 
    WHEN team_id % 2 = 1 THEN 'Odd' 
    ELSE 'Even' 
END;