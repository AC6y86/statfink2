const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../../helm/admin/js/areas/moves.js'), 'utf8');
function context() {
    const ctx={esc:s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'),pill:(_,s)=>s,ago:()=> 'recently',TYPE_LABELS:{supplemental:'Supplemental'}};
    vm.createContext(ctx);
    vm.runInContext(source.slice(source.indexOf('export function renderCommissionerNote'),source.indexOf('async function renderMoves()')).replace('export function','function'),ctx);
    vm.runInContext(source.slice(source.indexOf('export function describeMove'),source.indexOf('export async function approvePending')).replaceAll('export function','function').replace('export const','const'),ctx);
    return ctx;
}
test('ruling text escapes email content and has no execution actions',()=>{
    const ctx=context();const html=ctx.renderCommissionerNote({parse:{summary:'<script>bad</script>'},email:{from:'Dan',body:'<img onerror=bad>'},rulingQuote:'Move invalid'});
    expect(html).toContain('Commissioner ruling');expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');expect(html).not.toContain('data-action="approve"');
});
test('user report does not claim a direct Dan quote or original email',()=>{
    const html=context().renderCommissionerNote({source:{kind:'user_report',from:'Joe via iMessage',body:'<report>'},rulingQuote:'Dan invalidated a move'});
    expect(html).toContain('not a direct quote from Dan');expect(html).toContain('Original report');expect(html).not.toContain('Original email');
});
test.each(['pending','rejected'])('ruling renders inside its %s move card',status=>{
    const html=context().renderPendingItem({id:'m1',status,move:{team_id:10,move_type:'supplemental',drop_player_name:'Mostert',add_player_name:'Ekeler'},parse:{questions_for_commissioner:[]},commissionerRulings:[{parse:{summary:'Not in dropped pool'},rulingQuote:'Not eligible',email:{from:'Dan'}}]}, {teamName:()=> 'Sean'});
    expect(html).toContain('Mostert');expect(html).toContain('Ekeler');expect(html).toContain('Not in dropped pool');
    if(status==='rejected')expect(html).not.toContain('data-action="approve"');
});
test('Moves page has no standalone general ruling section, and keeps ruled resolved moves',async()=>{
    const ctx=context(),body={innerHTML:''};Object.assign(ctx,{root:{querySelector:()=>body},ctxRef:{teamName:()=> 'Sean'},getData:async()=>({items:[{id:'m1',status:'rejected',move:{team_id:10,drop_player_name:'Mostert',add_player_name:'Ekeler'},commissionerRulings:[{rulingQuote:'Not eligible'}]}]}),card:({title,rows})=>`<section><h2>${title}</h2>${rows}</section>`,renderForm:async()=>{}});
    vm.runInContext(source.slice(source.indexOf('async function renderMoves()'),source.indexOf('\nfunction opt(')),ctx);await ctx.renderMoves();
    expect(body.innerHTML).not.toContain('<h2>Commissioner rulings</h2>');expect(body.innerHTML).toContain('Resolved moves with rulings');expect(body.innerHTML).toContain('Not eligible');
});
