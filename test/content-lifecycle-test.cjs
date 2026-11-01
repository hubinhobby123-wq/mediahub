const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const crypto=require('node:crypto');
const root=path.resolve('.tmp-lifecycle-'+crypto.randomUUID());
process.env.DATA_DIR=path.join(root,'data');process.env.UPLOAD_DIR=path.join(root,'uploads');
const {createContentLifecycle}=require('../server/contentLifecycle');
test.after(()=>{assert.ok(root.startsWith(path.resolve('.')+path.sep));fs.rmSync(root,{recursive:true,force:true});});
function fixture(){const storage={db:{contents:[{id:'c',type:'article',title:'测试文章',body:'preserved'}],videoPackages:[{id:'p',title:'专版包',units:[{unit_id:'u',targets:[{platform:'kuaishou'}]}],packageId:'logical',revision:'r2'}],tasks:[],videoJobs:[],accountGroups:[]},now:()=>new Date().toISOString(),save(){}};return {storage,s:createContentLifecycle(storage)};}
test('article and video soft-delete/restore preserve payload; restore does not resume cancelled tasks',()=>{
  for(const kind of ['content','video']){const {s,storage}=fixture(),id=kind==='content'?'c':'p';
    const t={id:'t',status:'scheduled',contentId:'c',packageId:'p',targets:[{status:'pending'}],approval:{old:true}};
    (kind==='content'?storage.db.tasks:storage.db.videoJobs).push(t);
    assert.throws(()=>s.change(kind,id,'trash'),/明确选择取消/);
    s.change(kind,id,'trash',{cancelPending:true});assert.equal(t.status,'cancelled');assert.equal(s.list().items.length,1);
    s.change(kind,id,'restore');assert.equal(t.status,'cancelled');assert.equal(s.list().items.length,2);
    assert.equal(storage.db.contents[0].body,'preserved');assert.equal(storage.db.videoPackages[0].units[0].unit_id,'u');
  }
});
test('running, uncertain, audit and native schedule prevent hiding and cancellation',()=>{
  for(const status of ['delivery_running','release_running','awaiting_public','uncertain']){const {s,storage}=fixture();storage.db.videoJobs.push({id:'j',packageId:'p',status});assert.throws(()=>s.change('video','p','trash',{cancelPending:true}),/无法整理/);assert.equal(s.state(storage.db.videoPackages[0]),'active');}
  const {s,storage}=fixture();storage.db.videoJobs.push({id:'j',packageId:'p',status:'approved',remote:{state:'native_scheduled'}});assert.throws(()=>s.change('video','p','archive'),/平台原生定时/);
  storage.db.tasks.push({id:'t',contentId:'c',status:'partial',targets:[{status:'uncertain'}]});assert.throws(()=>s.change('content','c','trash',{cancelPending:true}),/核查/);
});
test('archive terminal content and reject future work until restored',()=>{
  const {s,storage}=fixture();storage.db.videoJobs.push({id:'j',packageId:'p',status:'public',remote:{id:'public-work',state:'private'}});
  s.change('video','p','archive');assert.equal(s.list({scope:'archived'}).items.length,1);assert.throws(()=>s.requireActive('video','p'),/先恢复/);
  s.change('video','p','trash');assert.equal(storage.db.videoJobs[0].status,'public');s.change('video','p','restore');assert.equal(s.requireActive('video','p').id,'p');
});
test('purge removes payload and tasks, keeps minimal remote/public evidence, and requires consent',()=>{
  const {s,storage}=fixture();storage.db.videoJobs.push({id:'j',packageId:'p',status:'public',deliveryKey:'stable',remote:{id:'remote',state:'private'},publicObservedAt:'2026-10-05T13:27:12Z'});
  assert.throws(()=>s.purge('video','p'),/明确确认/);
  const result=s.purge('video','p',{confirmed:true});assert.equal(result.removedTasks,1);
  assert.equal(storage.db.videoPackages.length,0);assert.equal(storage.db.videoJobs.length,0);
  const record=storage.db.deletionLedger[0].records[0];assert.equal(record.remote.id,'remote');assert.equal(record.publicObservedAt,'2026-10-05T13:27:12Z');
  assert.equal(storage.db.contents[0].body,'preserved');assert.throws(()=>s.record('video','p'),/不存在/);
});
test('purge checks pending cancellation, active dependencies and unknown submissions before any mutation',()=>{
  for(const status of ['draft_running','delivery_running','release_running','awaiting_public','uncertain']){
    const {s,storage}=fixture();storage.db.videoJobs.push({id:'j',packageId:'p',status});assert.throws(()=>s.purge('video','p',{confirmed:true,cancelPending:true}),/不能彻底删除/);assert.equal(storage.db.videoPackages.length,1);
  }
  const {s,storage}=fixture();storage.db.tasks.push({id:'t',contentId:'c',status:'scheduled',targets:[{status:'pending'}]});
  const heldReference=storage.db.tasks[0];assert.throws(()=>s.purge('content','c',{confirmed:true}),/取消/);s.purge('content','c',{confirmed:true,cancelPending:true});assert.equal(storage.db.tasks.length,0);assert.equal(heldReference.status,'cancelled');assert.equal(heldReference.targets[0].status,'cancelled');assert.deepEqual(storage.db.deletionLedger[0].cancelledLocalTaskIds,['t']);
  storage.db.videoJobs.push({id:'anchor',packageId:'p',status:'public'},{id:'dependent',packageId:'other',anchorJobId:'anchor',status:'approved'});
  assert.throws(()=>s.purge('video','p',{confirmed:true}),/依赖/);
});
test('one-click old work closure is scoped, preserves unknown evidence, and is idempotent',()=>{
  const {s,storage}=fixture();Object.assign(storage.db.videoPackages[0],{importedAt:'2026-10-01',revision:'r1'});
  storage.db.videoPackages.push({id:'new',packageId:'logical',revision:'r2',importedAt:'2026-10-02',units:[]});
  const old={id:'old',packageId:'p',status:'uncertain',mode:'manual',error:'已导入新成品版本，旧版需重新审阅；平台原生定时请人工撤销',remote:{state:'private',id:'remote'}};
  storage.db.videoJobs.push(old,{...structuredClone(old),id:'native',remote:{state:'native_scheduled'}},{...structuredClone(old),id:'submitted',release:{phase:'submitting'}},{...structuredClone(old),id:'different',error:'未知上传结果'});
  assert.equal(s.cleanupPreview().items.filter(x=>x.eligible).length,1);
  assert.throws(()=>s.closeOld({jobIds:['old']}),/确认/);
  const result=s.closeOld({jobIds:['old','native','submitted','different'],confirmed:true});assert.equal(result.results.filter(x=>x.ok).length,1);
  assert.equal(old.status,'cancelled');assert.equal(old.remote.state,'private');assert.equal(old.retirement.previousStatus,'uncertain');assert.equal(s.closeOld({jobIds:['old'],confirmed:true}).results[0].alreadyClosed,true);
  assert.equal(storage.db.videoJobs.find(x=>x.id==='submitted').status,'uncertain');
});
test('purge fails closed if backup fails; save failure restores the in-memory payload',()=>{
  const {s,storage}=fixture();storage.backupBeforePurge=()=>{throw Error('backup failed');};assert.throws(()=>s.purge('content','c',{confirmed:true}),/backup failed/);assert.equal(storage.db.contents.length,1);
  storage.backupBeforePurge=()=>null;storage.save=()=>{throw Error('save failed');};assert.throws(()=>s.purge('content','c',{confirmed:true}),/save failed/);assert.equal(storage.db.contents[0].body,'preserved');assert.equal(storage.db.deletionLedger,undefined);
});
