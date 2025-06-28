Daily at 6am:
* Update game schedule
* Backup the fantasy_football.db, copy it to fanatasy_football_{date}.db in /home/joepaley/backups
* Update NFL rosters, including injuries


Once a week when the games for the week end:
* Create Standings page for the week
* Advance the week number (never advance the season number)


Every minute while games are in progress:
* If a game is in progress, update the game scores
* If all games are over, recompute the defensive stats for the week calling ScoringService.calculateDefensiveBonuses()
