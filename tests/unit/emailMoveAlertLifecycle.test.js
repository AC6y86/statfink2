const fs = require('fs');
const os = require('os');
const path = require('path');
const { projectEmailMoveAlert: project } = require('../../server/services/emailMoveAlertLifecycle');
const Health = require('../../server/services/healthCheckService');
const stamp = '2026-09-30T12:00:00.000Z';
const item = (id, status, emailId='mail1') => ({ id, status, emailId, createdAt: stamp, email: { from: 'Dan <dan@example.com>' }, parse: { summary: 'Corrected supplemental move', questions_for_commissioner: [] } });
const alert = { id: 'a', source: 'email-moves', timestamp: stamp, severity: 'warning', message: 'Email move from Dan <dan@example.com> needs review: Old IR interpretation', acknowledged: false };

test.each(['approved','rejected'])('legacy %s notice resolves without rewriting original evidence', status => {
    const a = project(alert, [item('p',status)]);
    expect(a.acknowledged).toBe(true);
    expect(a.automaticallyResolved).toBe(true);
    expect(a.originalAlert.message).toBe(alert.message);
    expect(alert.acknowledged).toBe(false);
});
test('compound email remains open until every proposal is resolved', () => {
    const rows = [item('p1','approved'),item('p2','pending')];
    const a = project({...alert,emailId:'mail1',pendingItemIds:['p1','p2']},rows);
    expect(a.acknowledged).toBe(false);
    expect(a.severity).toBe('info');
    rows[1].status='rejected';
    expect(project({...alert,emailId:'mail1'},rows).acknowledged).toBe(true);
});
test('corrected pending requests lose stale IR questions but remain visible', () => {
    const a=project(alert,[item('p','pending')]);
    expect(a.message).toContain('awaiting approval');expect(a.message).not.toContain('Old IR');
    expect(a.details).toEqual([]);expect(a.acknowledged).toBe(false);
});
test.each(['needs_review','failed'])('%s stays a warning', status => {
    const a=project(alert,[item('p',status)]);expect(a.severity).toBe('warning');expect(a.acknowledged).toBe(false);
});
test('ambiguous legacy matches, distant timestamps, unrelated alerts and missing explicit members stay untouched', () => {
    expect(project(alert,[item('p','approved'),item('q','approved','mail2')])).toEqual(alert);
    expect(project(alert,[{...item('p','approved'),createdAt:'2026-09-29T12:00:00Z'}])).toEqual(alert);
    const unrelated={...alert,source:'live-watchdog'};expect(project(unrelated,[item('p','approved')])).toEqual(unrelated);
    const missing={...alert,emailId:'mail1',pendingItemIds:['p','missing']};expect(project(missing,[item('p','approved')])).toEqual(missing);
});
test('commissioner notices are never retired as executed moves', () => {
    expect(project({...alert,emailId:'mail1'},[{...item('p','notice'),kind:'commissioner_invalidation'}]).acknowledged).toBe(false);
});
test('service filtering and counters use lifecycle state and retain on-disk audit history', async () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pfl-alert-lifecycle-'));
    const alertsFile=path.join(dir,'alerts.json'),pendingMovesFile=path.join(dir,'moves.json');
    fs.writeFileSync(alertsFile,JSON.stringify([alert]));fs.writeFileSync(pendingMovesFile,JSON.stringify({items:[item('p','approved')]}));
    const svc=new Health({}, {alertsFile,pendingMovesFile});
    expect(await svc.getAlerts({unacknowledgedOnly:true})).toEqual([]);
    expect((await svc.getAlerts())[0].automaticallyResolved).toBe(true);
    expect(JSON.parse(fs.readFileSync(alertsFile))[0].acknowledged).toBe(false);
    fs.writeFileSync(pendingMovesFile,'bad');expect((await svc.getAlerts({unacknowledgedOnly:true})).length).toBe(1);
});
test('new notices persist stable email/item IDs and do not dedupe different emails', async () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pfl-alert-links-'));
    const svc=new Health({}, {alertsFile:path.join(dir,'alerts.json'),pendingMovesFile:path.join(dir,'missing')});
    await svc.recordAlert('info','email-moves','same',null,{emailId:'e1',pendingItemIds:['p1']});
    await svc.recordAlert('info','email-moves','same',null,{emailId:'e2',pendingItemIds:['p2']});
    const rows=await svc.loadAlerts();expect(rows).toHaveLength(2);expect(rows[0].pendingItemIds).toEqual(['p1']);
});
