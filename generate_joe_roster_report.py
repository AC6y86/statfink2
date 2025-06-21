#!/usr/bin/env python3
"""
Generate a comprehensive report of Joe's 2024 fantasy roster by week
"""

import sqlite3

def generate_joe_roster_report():
    db_path = "/home/joepaley/projects/statfink2/fantasy_football.db"
    
    try:
        conn = sqlite3.connect(db_path)
        
        print("# Joe's 2024 Fantasy Football Season")
        print("## Team: Joe's Team (ID: 6)")
        print()
        
        # Get roster for each week
        for week in range(1, 18):
            print(f"## Week {week}")
            
            # Get starters for this week
            starters = conn.execute("""
                SELECT player_name, player_position, player_team
                FROM weekly_rosters 
                WHERE team_id = 6 AND season = 2024 AND week = ? AND roster_position = 'starter'
                ORDER BY 
                    CASE player_position 
                        WHEN 'QB' THEN 1 
                        WHEN 'RB' THEN 2 
                        WHEN 'WR' THEN 3 
                        WHEN 'TE' THEN 4 
                        WHEN 'K' THEN 5
                        WHEN 'DEF' THEN 6
                        ELSE 7 
                    END,
                    player_name
            """, (week,)).fetchall()
            
            if not starters:
                print("No roster data available")
                print()
                continue
            
            # Group by position
            positions = {}
            for player_name, position, team in starters:
                if position not in positions:
                    positions[position] = []
                positions[position].append(f"{player_name} ({team})")
            
            # Display by position
            position_order = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']
            for pos in position_order:
                if pos in positions:
                    players = ', '.join(positions[pos])
                    print(f"**{pos}:** {players}")
            
            # Show any other positions
            for pos in positions:
                if pos not in position_order:
                    players = ', '.join(positions[pos])
                    print(f"**{pos}:** {players}")
            
            print()
        
        # Summary statistics
        print("## Season Summary")
        
        # Total roster changes
        total_players = conn.execute("""
            SELECT COUNT(DISTINCT player_id) as unique_players
            FROM weekly_rosters 
            WHERE team_id = 6 AND season = 2024 AND roster_position = 'starter'
        """).fetchone()[0]
        
        print(f"- **Total unique players used:** {total_players}")
        
        # Most used players
        print("- **Most frequently used players:**")
        frequent_players = conn.execute("""
            SELECT player_name, player_position, COUNT(*) as weeks_started
            FROM weekly_rosters 
            WHERE team_id = 6 AND season = 2024 AND roster_position = 'starter'
            GROUP BY player_name, player_position
            HAVING COUNT(*) >= 10
            ORDER BY COUNT(*) DESC, player_name
        """).fetchall()
        
        for player_name, position, weeks in frequent_players:
            print(f"  - {player_name} ({position}): {weeks} weeks")
        
        if not frequent_players:
            print("  - None (no players started 10+ weeks)")
        
        print()
        
        # Key roster changes
        print("- **Notable roster changes by week:**")
        
        prev_roster = set()
        for week in range(1, 18):
            current_roster = set()
            
            starters = conn.execute("""
                SELECT player_name, player_position
                FROM weekly_rosters 
                WHERE team_id = 6 AND season = 2024 AND week = ? AND roster_position = 'starter'
            """, (week,)).fetchall()
            
            for player_name, position in starters:
                current_roster.add((player_name, position))
            
            if prev_roster:
                added = current_roster - prev_roster
                dropped = prev_roster - current_roster
                
                if added or dropped:
                    changes = []
                    if added:
                        for name, pos in added:
                            changes.append(f"+{name} ({pos})")
                    if dropped:
                        for name, pos in dropped:
                            changes.append(f"-{name} ({pos})")
                    
                    if changes:
                        print(f"  - Week {week}: {', '.join(changes)}")
            
            prev_roster = current_roster.copy()
        
    except Exception as e:
        print(f"Error: {e}")
    finally:
        conn.close()

if __name__ == "__main__":
    generate_joe_roster_report()