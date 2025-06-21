#!/usr/bin/env python3
"""
Copy roster data from statfinkv1_2024.db to statfink_2024.db
Only copies team, player, and weekly roster information - no stats or points
"""

import sqlite3
import sys
from datetime import datetime

def generate_player_id(name, position, team):
    """Generate Tank01-compatible player ID from name, position, and team"""
    # Clean and normalize the player name
    clean_name = name.lower().strip()
    # Remove common suffixes
    for suffix in [' jr.', ' jr', ' sr.', ' sr', ' iii', ' ii', ' iv', ' v']:
        clean_name = clean_name.replace(suffix, '')
    
    # Replace spaces and special characters
    clean_name = clean_name.replace(' ', '_').replace("'", '').replace('-', '_')
    
    # Normalize team abbreviations
    team_abbr = team.lower().strip()
    position_abbr = position.lower().strip()
    
    return f"{clean_name}_{position_abbr}_{team_abbr}"

def copy_teams(source_conn, target_conn):
    """Copy team data from source to target"""
    print("Copying teams...")
    
    # Clear existing teams in target
    target_conn.execute("DELETE FROM teams")
    
    # Copy teams from source
    teams = source_conn.execute("""
        SELECT team_id, owner_name, team_name 
        FROM teams 
        ORDER BY team_id
    """).fetchall()
    
    for team in teams:
        team_id, owner_name, team_name = team
        # Handle null team_name
        if not team_name:
            team_name = f"{owner_name}'s Team"
            
        target_conn.execute("""
            INSERT INTO teams (team_id, owner_name, team_name, total_points, wins, losses, ties)
            VALUES (?, ?, ?, 0, 0, 0, 0)
        """, (team_id, owner_name, team_name))
    
    print(f"  Copied {len(teams)} teams")
    return len(teams)

def copy_players(source_conn, target_conn):
    """Copy player data from source to target with generated IDs"""
    print("Copying players...")
    
    # Clear existing players in target
    target_conn.execute("DELETE FROM nfl_players")
    
    # Get unique players from source
    players = source_conn.execute("""
        SELECT DISTINCT player_name, position, nfl_team 
        FROM players 
        ORDER BY position, player_name
    """).fetchall()
    
    player_mapping = {}
    
    for player in players:
        player_name, position, nfl_team = player
        player_id = generate_player_id(player_name, position, nfl_team)
        
        # Store mapping for later use
        player_mapping[(player_name, position, nfl_team)] = player_id
        
        try:
            target_conn.execute("""
                INSERT INTO nfl_players (player_id, name, position, team, bye_week)
                VALUES (?, ?, ?, ?, NULL)
            """, (player_id, player_name, position, nfl_team))
        except sqlite3.IntegrityError:
            # Player already exists (duplicate ID from different source entries)
            print(f"  Warning: Duplicate player ID {player_id} for {player_name}")
    
    print(f"  Copied {len(players)} unique players")
    return player_mapping

def copy_weekly_rosters(source_conn, target_conn, player_mapping):
    """Copy weekly roster data for all weeks"""
    print("Copying weekly rosters...")
    
    # Clear existing weekly rosters in target
    target_conn.execute("DELETE FROM weekly_rosters")
    
    # Get all weekly roster data
    rosters = source_conn.execute("""
        SELECT DISTINCT wpp.week, wpp.team_id, p.player_name, p.position, p.nfl_team
        FROM weekly_player_performance wpp
        JOIN players p ON wpp.player_id = p.player_id
        ORDER BY wpp.week, wpp.team_id, p.position, p.player_name
    """).fetchall()
    
    roster_count = 0
    week_counts = {}
    
    for roster in rosters:
        week, team_id, player_name, position, nfl_team = roster
        
        # Get player_id from mapping
        player_key = (player_name, position, nfl_team)
        if player_key not in player_mapping:
            print(f"  Warning: Player not found in mapping: {player_name} ({position}, {nfl_team})")
            continue
            
        player_id = player_mapping[player_key]
        
        # Insert into weekly_rosters (all as starters since source doesn't distinguish)
        try:
            target_conn.execute("""
                INSERT INTO weekly_rosters 
                (team_id, player_id, week, season, roster_position, 
                 player_name, player_position, player_team)
                VALUES (?, ?, ?, 2024, 'starter', ?, ?, ?)
            """, (team_id, player_id, week, player_name, position, nfl_team))
            
            roster_count += 1
            week_counts[week] = week_counts.get(week, 0) + 1
            
        except sqlite3.IntegrityError as e:
            print(f"  Warning: Duplicate roster entry for team {team_id}, player {player_id}, week {week}")
    
    print(f"  Copied {roster_count} roster entries")
    print("  Roster counts by week:")
    for week in sorted(week_counts.keys()):
        print(f"    Week {week}: {week_counts[week]} roster spots")
    
    return roster_count

def create_tank01_mapping_table(target_conn):
    """Create a table for mapping our IDs to Tank01 player IDs"""
    print("Creating Tank01 player mapping table...")
    
    target_conn.execute("""
        CREATE TABLE IF NOT EXISTS tank01_player_mapping (
            our_player_id VARCHAR(50) PRIMARY KEY,
            tank01_player_id VARCHAR(50) NOT NULL,
            player_name VARCHAR(100) NOT NULL,
            last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (our_player_id) REFERENCES nfl_players(player_id)
        )
    """)
    
    target_conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_tank01_mapping_tank01id 
        ON tank01_player_mapping(tank01_player_id)
    """)
    
    print("  Created tank01_player_mapping table")

def validate_data(source_conn, target_conn):
    """Validate the copied data"""
    print("\nValidating data...")
    
    # Check team counts
    source_teams = source_conn.execute("SELECT COUNT(*) FROM teams").fetchone()[0]
    target_teams = target_conn.execute("SELECT COUNT(*) FROM teams").fetchone()[0]
    print(f"  Teams - Source: {source_teams}, Target: {target_teams}")
    
    # Check player counts
    source_players = source_conn.execute("SELECT COUNT(*) FROM (SELECT DISTINCT player_name, position, nfl_team FROM players)").fetchone()[0]
    target_players = target_conn.execute("SELECT COUNT(*) FROM nfl_players").fetchone()[0]
    print(f"  Players - Source: {source_players}, Target: {target_players}")
    
    # Check weekly roster counts
    source_rosters = source_conn.execute("SELECT COUNT(*) FROM weekly_player_performance").fetchone()[0]
    target_rosters = target_conn.execute("SELECT COUNT(*) FROM weekly_rosters").fetchone()[0]
    print(f"  Weekly Rosters - Source: {source_rosters}, Target: {target_rosters}")
    
    # Check weeks coverage
    source_weeks = source_conn.execute("SELECT COUNT(DISTINCT week) FROM weekly_player_performance").fetchone()[0]
    target_weeks = target_conn.execute("SELECT COUNT(DISTINCT week) FROM weekly_rosters").fetchone()[0]
    print(f"  Weeks with data - Source: {source_weeks}, Target: {target_weeks}")
    
    return True

def main():
    source_db = "/home/joepaley/projects/statfink2/tests/2024/statfinkv1_2024.db"
    target_db = "/home/joepaley/projects/statfink2/tests/2024/statfink_2024.db"
    
    print(f"Copying roster data from {source_db} to {target_db}")
    print(f"Started at: {datetime.now()}")
    
    try:
        # Connect to databases
        source_conn = sqlite3.connect(source_db)
        target_conn = sqlite3.connect(target_db)
        
        # Start transaction on target
        target_conn.execute("BEGIN TRANSACTION")
        
        # Copy data
        copy_teams(source_conn, target_conn)
        player_mapping = copy_players(source_conn, target_conn)
        copy_weekly_rosters(source_conn, target_conn, player_mapping)
        create_tank01_mapping_table(target_conn)
        
        # Validate
        validate_data(source_conn, target_conn)
        
        # Commit changes
        target_conn.commit()
        print("\nAll changes committed successfully!")
        
    except Exception as e:
        print(f"\nError occurred: {e}")
        target_conn.rollback()
        print("Changes rolled back")
        sys.exit(1)
        
    finally:
        source_conn.close()
        target_conn.close()
    
    print(f"\nCompleted at: {datetime.now()}")

if __name__ == "__main__":
    main()