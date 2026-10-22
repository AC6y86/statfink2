const Parser = require('../../server/services/scoringPlayParserService');
const text = 'Eric Saubert 13 Yd pass from Sam Darnold Eric Saubert Fumble Eric Saubert 0 Yd Fumble Recovery (Jason Myers Kick)';
const parse = (score,season) => {
    const p=new Parser();
    const plays=p.parseScoringPlays({scoringPlays:[{score,scoreType:'TD',team:'SEA'}]},'WAS','SEA',{season});
    return {play:plays[0],dst:p.getDefensiveTouchdownBreakdown(plays,'SEA')};
};
describe('Receiver recovers his own fumble after a completed pass',()=>{
    test('2026 Saubert play remains a receiving TD, never a Seattle defensive TD',()=>{
        const {play,dst}=parse(text,2026);
        expect(play.playType).toBe('receiving_td');
        expect(play.playerName).toBe('Eric Saubert');
        expect(dst.def_fumble_return_tds).toBe(0);
    });
    test('does not change an opponent recovery or a genuine defensive return',()=>{
        expect(parse(text.replace('Eric Saubert 0 Yd','Bobby Wagner 13 Yd'),2026).play.playType).toBe('defensive_fumble_return_td');
        expect(parse('Rayshawn Jenkins 102 Yd Fumble Return (Jason Myers Kick)',2026).dst.def_fumble_return_tds).toBe(1);
    });
    test.each([2024,2025,undefined])('preserves the blessed/unspecified season %s',season=>{
        expect(parse(text,season).play.playType).toBe('defensive_fumble_return_td');
    });
});
