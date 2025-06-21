#!/usr/bin/env python3
"""
Parse MATCHUPS_2024.md and insert into the matchups table
"""

import sqlite3
import re
from datetime import datetime

def parse_matchups_file():
    """Parse the matchups file and return structured data"""
    
    with open('/home/joepaley/projects/statfink2/docs/MATCHUPS_2024.md', 'r') as f:
        content = f.read()
    
    matchups = {}
    current_week = None
    
    for line in content.strip().split('\n'):
        line = line.strip()
        if not line:
            continue
            
        # Check for week header
        week_match = re.match(r'Week (\d+):', line)
        if week_match:
            current_week = int(week_match.group(1))
            continue
        
        # Parse matchups for current week
        if current_week and 'vs' in line:
            # Split by commas and parse each matchup
            matchup_pairs = line.split(',')
            week_matchups = []
            
            for pair in matchup_pairs:
                pair = pair.strip()
                # Match pattern like "1 vs 2" or "11 vs 12"
                match = re.match(r'(\d+)\s+vs\s+(\d+)', pair)
                if match:
                    team1 = int(match.group(1))
                    team2 = int(match.group(2))
                    week_matchups.append((team1, team2))
            
            if week_matchups:
                matchups[current_week] = week_matchups
    
    return matchups

def insert_matchups_to_db(matchups):
    """Insert matchups into the database"""
    
    db_path = "/home/joepaley/projects/statfink2/fantasy_football.db"
    
    try:
        conn = sqlite3.connect(db_path)
        
        # Clear existing 2024 matchups
        conn.execute("DELETE FROM matchups WHERE season = 2024")
        print("Cleared existing 2024 matchups")
        
        # Insert new matchups
        total_inserted = 0
        
        for week, week_matchups in sorted(matchups.items()):
            print(f"\nWeek {week}:")
            
            for team1, team2 in week_matchups:
                # Insert matchup
                conn.execute("""
                    INSERT INTO matchups (week, season, team1_id, team2_id, team1_points, team2_points, is_complete)
                    VALUES (?, 2024, ?, ?, 0, 0, 0)
                """, (week, team1, team2))
                
                print(f"  {team1} vs {team2}")
                total_inserted += 1
        
        # Commit changes
        conn.commit()
        print(f"\n✅ Successfully inserted {total_inserted} matchups for 2024 season")
        
        # Validate
        count = conn.execute("SELECT COUNT(*) FROM matchups WHERE season = 2024").fetchone()[0]
        weeks = conn.execute("SELECT COUNT(DISTINCT week) FROM matchups WHERE season = 2024").fetchone()[0]
        
        print(f"📊 Validation: {count} total matchups across {weeks} weeks")
        
        # Show summary
        print(f"\n📈 Matchups per week:")
        week_counts = conn.execute("""
            SELECT week, COUNT(*) as matchup_count
            FROM matchups 
            WHERE season = 2024 
            GROUP BY week 
            ORDER BY week
        """).fetchall()
        
        for week, count in week_counts:
            print(f"  Week {week}: {count} matchups")
        
    except Exception as e:
        print(f"❌ Error: {e}")
        conn.rollback()
    finally:
        conn.close()

def main():
    print("🏈 Parsing 2024 Fantasy Football Matchups")
    print("=" * 50)
    
    # Parse the file
    matchups = parse_matchups_file()
    
    print(f"📁 Parsed {len(matchups)} weeks of matchups")
    
    # Show what we found
    for week in sorted(matchups.keys()):
        week_matchups = matchups[week]
        print(f"Week {week}: {len(week_matchups)} matchups")
        
        # Check for issues
        teams_used = set()
        for team1, team2 in week_matchups:
            if team1 in teams_used or team2 in teams_used:
                print(f"  ⚠️  Warning: Team appears multiple times in Week {week}")
            teams_used.add(team1)
            teams_used.add(team2)
        
        if len(teams_used) != 12:
            print(f"  ⚠️  Warning: Week {week} has {len(teams_used)} teams (expected 12)")
    
    print("\n" + "=" * 50)
    
    # Insert into database
    insert_matchups_to_db(matchups)

if __name__ == "__main__":
    main()