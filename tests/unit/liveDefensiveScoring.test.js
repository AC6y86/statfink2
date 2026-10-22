const SchedulerService = require('../../server/services/schedulerService');
const NFLGamesService = require('../../server/services/nflGamesService');
const DSTManagementService = require('../../server/services/dstManagementService');
const ScoringService = require('../../server/services/scoringService');
const FantasyPointsCalculationService = require('../../server/services/fantasyPointsCalculationService');
const ScoringPlayersService = require('../../server/services/scoringPlayersService');

jest.mock('../../server/utils/errorHandler', () => ({ logInfo: jest.fn(), logWarn: jest.fn(), logError: jest.fn() }));

// Real production pipeline, in-memory adapter only: never opens a database.
function harness() {
    const game = { game_id: '20260927_LAR@DEN', week: 3, season: 2026,
        home_team: 'DEN', away_team: 'LAR', home_score: 30, away_score: 26 };
    const box = { gameID: game.game_id, home: 'DEN', away: 'LAR', homePts: '30', awayPts: '26',
        teamIDHome: '10', teamIDAway: '19', gameStatus: 'Completed',
        DST: { home: { ydsAllowed: '482' }, away: { ydsAllowed: '257' } },
        scoringPlays: [{ score: 'Talanoa Hufanga 66 Yd Interception Return (Wil Lutz Kick)',
            scoreType: 'TD', scorePeriod: 'Q4', scoreTime: '4:49', team: 'DEN', teamID: '10' }] };
    const stats = [
        { stat_id: 1, player_id: 'QB1', position: 'QB', fantasy_points: 10 },
        { stat_id: 2, player_id: 'DEF_DEN', position: 'DST', fantasy_points: 0, points_allowed: 26, yards_allowed: 482 },
        { stat_id: 3, player_id: 'DEF_SF', position: 'DST', fantasy_points: 0, points_allowed: 30, yards_allowed: 300 },
        { stat_id: 4, player_id: 'QB2', position: 'QB', fantasy_points: 6 },
        // Must not be recalculated by a current-week live tick, even at week end.
        { stat_id: 5, player_id: 'DEF_DEN', position: 'DST', fantasy_points: 7, def_int_return_tds: 1, week: 2 },
        { stat_id: 6, player_id: 'DEF_DEN', position: 'DST', fantasy_points: 7, def_int_return_tds: 1, season: 2025 }
    ].map(s => ({ week: 3, season: 2026, def_points_bonus: 0, def_yards_bonus: 0, ...s }));
    const rosters = stats.slice(0,4).map(s => ({player_id:s.player_id, player_position:s.position, team_id:s.player_id==='QB2'?2:1, is_scoring:0}));
    const matchup = { matchup_id: 1, team1_id: 1, team2_id: 2 };
    const denver = () => stats.find(s => s.stat_id === 2);
    const writes = [];
    let complete = false;
    const db = {
        getSchedulerTimestamps: async () => ({}), updateSchedulerTimestamp: async () => {},
        async get(sql, a=[]) {
            if(sql.includes('FROM league_settings')) return {current_week:3,season_year:2026};
            if(sql.includes('COUNT(*) as total_games')) return {total_games:16,completed_games:complete?16:15,scheduled_games:complete?0:1,live_games:0};
            if(sql.includes('FROM nfl_games')) return game;
            if(sql.includes('SUM(ps.fantasy_points)')) return {total:rosters.filter(r=>r.team_id===a[0]&&r.is_scoring).reduce((n,r)=>n+(stats.find(s=>s.player_id===r.player_id&&s.week===3&&s.season===2026)?.fantasy_points||0),0)};
            throw Error('Unexpected get: '+sql);
        },
        async all(sql,a=[]) {
            if(sql.includes('FROM teams')) return [{team_id:1},{team_id:2}];
            if(sql.includes('FROM nfl_games')) return [game];
            if(sql.includes('FROM weekly_rosters')&&!sql.includes('FROM player_stats')) return rosters.filter(r=>r.team_id===a[0]).map(r=>({...stats.find(s=>s.player_id===r.player_id&&s.week===3&&s.season===2026),...r})).sort((x,y)=>y.fantasy_points-x.fantasy_points);
            if(sql.includes('FROM matchups')) return [matchup];
            if(sql.includes('FROM player_stats')) {
                let found=stats.filter(s=>s.season===a[0]);
                if(sql.includes('ps.week = ?')) found=found.filter(s=>s.week===a[1]);
                if(sql.includes("p.position = 'DST'")) found=found.filter(s=>s.position==='DST');
                return found.map(s=>({...s}));
            }
            throw Error('Unexpected all: '+sql);
        },
        async run(sql,a=[]) {
            sql=sql.replace(/\s+/g,' ').trim();
            if(sql.startsWith('UPDATE nfl_games')) return {changes:1};
            if(sql.startsWith('INSERT OR REPLACE INTO player_stats')) {
                const cols=sql.match(/player_stats \((.*?)\) VALUES/)[1].split(',').map(s=>s.trim());
                const row=Object.fromEntries(cols.map((k,i)=>[k,a[i]]));
                let old=stats.find(s=>s.player_id===row.player_id&&s.week===row.week&&s.season===row.season);
                if(!old) {old={stat_id:stats.length+1,position:'DST'};stats.push(old);}
                Object.assign(old,row,{def_points_bonus:0,def_yards_bonus:0});
            } else if(sql.startsWith('UPDATE player_stats SET fantasy_points')) {
                const row=stats.find(s=>s.stat_id===a[1]);
                writes.push(row.stat_id);row.fantasy_points=a[0];
            } else if(sql.startsWith('UPDATE weekly_rosters')) {
                if(sql.includes('is_scoring = 0')) rosters.filter(r=>r.team_id===a[0]).forEach(r=>{r.is_scoring=0;r.scoring_slot=null;});
                else {const row=rosters.find(r=>r.team_id===a[1]&&r.player_id===a[2]);row.is_scoring=1;row.scoring_slot=a[0];}
            } else if(sql.startsWith('UPDATE matchups')) {
                matchup.team1_scoring_points=a[0];matchup.team2_scoring_points=a[1];
            } else throw Error('Unexpected run: '+sql);
            return {changes:1};
        }
    };
    const tank = {getNFLBoxScore:async()=>box, getPlayerList:async()=>[]};
    const scoring = new ScoringService(db);
    // Isolate orchestration of the bonus gate; historical suites cover award/tie math.
    const bonuses = jest.spyOn(scoring,'calculateDefensiveBonuses').mockImplementation(async()=>{
        denver().def_points_bonus=2.5; return {success:true};
    });
    const nfl = new NFLGamesService(db,tank,scoring,new DSTManagementService(db,tank));
    const points = new FantasyPointsCalculationService(db,scoring);
    const lineup = new ScoringPlayersService(db);
    const scheduler = new SchedulerService(db,nfl,null,scoring,null,null,lineup,null,points);
    return {stats,box,matchup,denver,bonuses,writes,points,lineup,scheduler,setComplete:()=>{complete=true;}};
}

describe('Live defensive scoring before the week is complete',()=>{
    test('credits a parsed interception TD in the same live matchup update without weekly bonuses',async()=>{
        const h=harness(); const r=await h.scheduler.performLiveGameUpdate();
        expect(r.success).toBe(true);expect(r.results.errors).toEqual([]);
        expect(h.denver().def_int_return_tds).toBe(1);
        expect(h.denver().fantasy_points).toBe(8);
        expect(h.matchup.team1_scoring_points).toBe(18);
        expect(h.matchup.team2_scoring_points).toBe(6);
        expect(h.bonuses).not.toHaveBeenCalled();
    });
    test('a repeated boxscore refresh neither wipes nor doubles touchdown credit',async()=>{
        const h=harness();h.denver().fantasy_points=8;
        await h.scheduler.performLiveGameUpdate();await h.scheduler.performLiveGameUpdate();
        expect(h.denver().fantasy_points).toBe(8);expect(h.matchup.team1_scoring_points).toBe(18);
    });
    test('removing a corrected-away touchdown removes its live credit',async()=>{
        const h=harness();await h.scheduler.performLiveGameUpdate();
        expect(h.denver().fantasy_points).toBe(8);
        h.box.scoringPlays=[];await h.scheduler.performLiveGameUpdate();
        expect(h.denver().fantasy_points).toBe(0);expect(h.matchup.team1_scoring_points).toBe(10);
    });
    test('when the week ends, adds the awarded bonus once and keeps prior weeks/seasons untouched',async()=>{
        const h=harness();h.setComplete();
        await h.scheduler.performLiveGameUpdate();await h.scheduler.performLiveGameUpdate();
        expect(h.denver().fantasy_points).toBe(10.5);expect(h.matchup.team1_scoring_points).toBe(20.5);
        expect(h.bonuses).toHaveBeenCalledTimes(2);
        expect(h.stats.find(s=>s.stat_id===5).fantasy_points).toBe(7);
        expect(h.stats.find(s=>s.stat_id===6).fantasy_points).toBe(7);
        expect(h.writes).not.toContain(5);expect(h.writes).not.toContain(6);
    });
    test('also converts already-ingested fumble TDs, blocked-return TDs and safeties',async()=>{
        const h=harness();const sf=h.stats.find(s=>s.player_id==='DEF_SF');
        Object.assign(sf,{def_fumble_return_tds:1,def_blocked_return_tds:1,safeties:1});
        await h.scheduler.performLiveGameUpdate();
        expect(sf.fantasy_points).toBe(18);expect(h.matchup.team1_scoring_points).toBe(36);
    });
});
