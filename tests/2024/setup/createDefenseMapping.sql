-- Create a mapping table for defense names
CREATE TABLE IF NOT EXISTS defense_name_mapping (
    stats_name VARCHAR(50) PRIMARY KEY,
    roster_name VARCHAR(50) NOT NULL
);

-- Insert mappings
INSERT OR REPLACE INTO defense_name_mapping (stats_name, roster_name) VALUES
('ARI Defense', 'Cardinals'),
('ATL Defense', 'Falcons'),
('BAL Defense', 'Ravens'),
('BUF Defense', 'Bills'),
('CAR Defense', 'Panthers'),
('CHI Defense', 'Bears'),
('CIN Defense', 'Bengals'),
('CLE Defense', 'Browns'),
('DAL Defense', 'Cowboys'),
('DEN Defense', 'Broncos'),
('DET Defense', 'Lions'),
('GB Defense', 'Packers'),
('HOU Defense', 'Texans'),
('IND Defense', 'Colts'),
('JAX Defense', 'Jaguars'),
('KC Defense', 'Chiefs'),
('LAC Defense', 'Chargers'),
('LAR Defense', 'Rams'),
('LV Defense', 'Raiders'),
('MIA Defense', 'Dolphins'),
('MIN Defense', 'Vikings'),
('NE Defense', 'Patriots'),
('NO Defense', 'Saints'),
('NYG Defense', 'Giants'),
('NYJ Defense', 'Jets'),
('PHI Defense', 'Eagles'),
('PIT Defense', 'Steelers'),
('SEA Defense', 'Seahawks'),
('SF Defense', '49ers'),
('TB Defense', 'Buccaneers'),
('TEN Defense', 'Titans'),
('WAS Defense', 'Commanders'),
('WSH Defense', 'Commanders');

-- Verify the mapping
SELECT 
    ps.player_name as stats_name,
    dnm.roster_name,
    COUNT(DISTINCT ps.player_id) as player_id_count
FROM player_stats ps
JOIN defense_name_mapping dnm ON ps.player_name = dnm.stats_name
WHERE ps.season = 2024 AND ps.position = 'DEF'
GROUP BY ps.player_name, dnm.roster_name
ORDER BY ps.player_name;