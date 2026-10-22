const fs=require('fs'),os=require('os'),path=require('path');
const {attachRulings}=require('../../server/services/moveRulingLinks');
const Pending=require('../../server/services/pendingMovesService');
const move={id:'m1',threadId:'t',status:'rejected',email:{from:'Sean Lowenthal <sean@example.com>',date:'2026-09-30T14:00:00Z'},move:{add_player_name:'Austin Ekeler'}};
const note={id:'n1',kind:'commissioner_invalidation',status:'notice',threadId:'t',email:{date:'2026-09-30T14:01:00Z',body:'Sean cannot pick up Austin Ekeler; he was not dropped.'}};
test('unambiguous original body links a ruling to the affected move, including rejected moves',()=>{
    const r=attachRulings([move,note]);expect(r[0].commissionerRulings[0].id).toBe('n1');expect(r[1].relatedItemIds).toEqual(['m1']);expect(move.commissionerRulings).toBeUndefined();
});
test('generic or ambiguous body does not invent a move target',()=>{
    expect(attachRulings([move,{...note,email:{...note.email,body:'Invalid move'}}])[1].relatedItemIds).toEqual([]);
    expect(attachRulings([move,{...move,id:'m2'},note])[2].relatedItemIds).toEqual([]);
});
test('explicit links preserve informational user reports without changing either decision',()=>{
    const r=attachRulings([move,{...note,source:{kind:'user_report'},relatedItemIds:['m1'],email:null}]);expect(r[0].status).toBe('rejected');expect(r[0].commissionerRulings[0].source.kind).toBe('user_report');
});
test('manual association persists target without executing, preserves source and rejects absent targets',async()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pfl-ruling-link-')),queueFile=path.join(dir,'queue.json');
    fs.writeFileSync(queueFile,JSON.stringify({items:[move,note],processedEmails:[]}));const svc=new Pending({}, {queueFile});
    await expect(svc.linkRuling('n1','unknown')).rejects.toThrow('not found');await svc.linkRuling('n1','m1');
    const rows=await svc.getItems({status:'rejected'});expect(rows[0].status).toBe('rejected');expect(rows[0].commissionerRulings[0].email.body).toBe(note.email.body);expect(rows[0].commissionerRulings[0].relatedItemIds).toEqual(['m1']);
});
