const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve('.tmp-video-tests-' + crypto.randomUUID());
process.env.DATA_DIR = path.join(root, 'store');
process.env.UPLOAD_DIR = path.join(root, 'uploads');
process.env.MEDIAHUB_VIDEO_CONFIG = path.join(root, 'test-video-config.json');
const { digest, loadHandoff, parseCopy } = require('../server/videoHandoff.cjs');
const { createVideoService } = require('../server/videoService');
const { createYoutubeLifecycle } = require('../server/adapters/video-release');
const hour = 3600000;
let seq = 0;
function fixture(options = {}) {
  let time = Date.parse('2026-10-04T00:00:00Z');
  const units = [
    ['full','full','bilibili','domestic'],['clip1','clip',options.draftPlatform||'douyin','domestic'],['clip2','clip',options.draftPlatform||'douyin','domestic'],['fullEn','full','youtube','overseas'],['clipEn','clip','youtube','overseas'],
  ].map(([id,kind,platform,group])=>({ unit_id:id,revision:'r1',kind,release_group:group,language:group==='domestic'?'zh-CN':'en',production_status:'ready_for_review',targets:[{platform,surface:kind==='full'?'long_form':'short_video'}],release_intent:{depends_on_full_unit:kind==='clip'?(group==='domestic'?'full':'fullEn'):null},artifacts:{video:{path:id+'.mp4',sha256:digest('video')},cover:{path:id+'.jpg',sha256:digest('cover')},copy:{path:id+'.md',sha256:digest('# final\n\nBody\n\n标签建议：#tag\n\n## 适配理由\nnot upload')}} }));
  const dir = path.join(root,String(++seq));fs.mkdirSync(dir,{recursive:true});
  for(const u of units)for(const [k,a]of Object.entries(u.artifacts))fs.writeFileSync(path.join(dir,a.path),k==='video'?'video':k==='cover'?'cover':'# final\n\nBody\n\n标签建议：#tag\n\n## 适配理由\nnot upload');
  const manifest=path.join(dir,'video-handoff.json');fs.writeFileSync(manifest,JSON.stringify({schema_version:'video-handoff/v1-draft',package_id:'test',package_revision:'r1',content_id:'c',units}));
  const storage={db:{videoPackages:[],videoJobs:[],accountGroups:[],accounts:[{id:'b',name:'B',platformId:'bilibili',runtimeAccount:'default'},{id:'d',name:'D',platformId:options.draftPlatform||'douyin',runtimeAccount:'first'},{id:'d2',name:'alias',platformId:options.draftPlatform||'douyin',runtimeAccount:'first'},{id:'y',name:'Y',platformId:'youtube'}]},DATA_DIR:path.join(dir,'data'),save(){},nextId:()=>crypto.randomUUID()};
  const service=createVideoService({storage,clock:()=>time,...options});
  return {dir,manifest,storage,service,setTime:t=>time=t,now:()=>time};
}
const approve = (service,j,now,mode='manual')=>service.approve(j.id,{reviewed:true,rightsConfirmed:true,declarationsConfirmed:true,notBefore:new Date(now).toISOString(),mode});
async function releaseFixture(options={}) {
  const f=fixture(options),s=f.service,p=await s.importPackage(f.manifest);
  const b=s.bind({packageId:p.id,unitId:'full',platformId:'bilibili',accountId:'b'});
  const j=s.bind({packageId:p.id,unitId:'clip1',platformId:'douyin',accountId:'d'});
  remote(s,b);await approve(s,b,f.now());publicAt(s,b,f.now());
  s.setRemote(j.id,{id:'123456',url:'https://creator.douyin.com/creator-micro/content/post/video?mid=123456&enter_from=edit_item',state:'private'});
  await approve(s,j,f.now());
  return {...f,s,p,j,b};
}
function observation(j,patch={}) {return {remoteId:j.remote.id,observedAccountId:'actual-owner',ownerConfirmed:true,state:'private',nativeScheduled:false,evidence:'exact work and account inspected',contentFingerprint:'reviewed-copy',...patch};}
function agentGrant(s,j,patch={}) {return s.authorizeAgentRelease(j.id,{confirmed:true,authorization:'explicit public release of this exact reviewed work',observedAccountId:'actual-owner',...patch});}
function remote(s,j) {s.setRemote(j.id,{id:j.platformId==='youtube'?'abcdefghijk':j.unitId,url:j.platformId==='youtube'?'https://www.youtube.com/watch?v=abcdefghijk':j.platformId==='bilibili'?'https://www.bilibili.com/video/BVtest':'https://www.douyin.com/video/123456',state:j.platformId==='youtube'?'private':'draft'});}
function publicAt(s,j,now){s.markPublic(j.id,{confirmed:true,url:j.remote.url,publishedAt:new Date(now).toISOString()});}
test.after(()=>{if(!root.startsWith(path.resolve('.')+path.sep)||!path.basename(root).startsWith('.tmp-video-tests-'))throw Error('unsafe test cleanup');fs.rmSync(root,{recursive:true,force:true});});
test('final copy excludes adaptation/review instructions',()=>assert.deepEqual(parseCopy('# title\n\nBody\n标签建议：#a #b\n## 内部说明\nsecret'),{title:'title',description:'Body',tags:['a','b']}));
test('purged handoff version cannot silently reimport or regain an executable job',async()=>{
  const f=fixture(),p=await f.service.importPackage(f.manifest);
  f.storage.now=()=>new Date(f.now()).toISOString();
  require('../server/contentLifecycle').createContentLifecycle(f.storage).purge('video',p.id,{confirmed:true});
  await assert.rejects(f.service.importPackage(f.manifest),/已彻底删除/);assert.equal(f.storage.db.videoJobs.length,0);assert.equal(f.storage.db.videoPackages.length,0);
});
test('archived/recycled video packages reject binding and delivery; restored cancelled work stays cancelled',async()=>{
  const f=fixture(),s=f.service,p=await s.importPackage(f.manifest),j=s.bind({packageId:p.id,unitId:'full',platformId:'bilibili',accountId:'b'});
  p.lifecycle={state:'trashed'};j.status='cancelled';
  assert.throws(()=>s.bind({packageId:p.id,unitId:'full',platformId:'bilibili',accountId:'b'}),/先恢复/);
  await assert.rejects(s.uploadDraft(j.id),/先恢复/);await assert.rejects(s.importPackage(f.manifest),/回收站/);
  p.lifecycle={state:'active'};await s.tick();assert.equal(j.status,'cancelled');
});
test('adopt a verified separate public attempt while retaining old private ID and stable observation',async()=>{
  const f=fixture({draftPlatform:'kuaishou'}),s=f.service,p=await s.importPackage(f.manifest);
  s.bind({packageId:p.id,unitId:'full',platformId:'bilibili',accountId:'b'});
  const j=s.bind({packageId:p.id,unitId:'clip1',platformId:'kuaishou',accountId:'d'});
  s.setRemote(j.id,{id:'old-work',url:'https://cp.kuaishou.com/article/edit/video?workId=old-work',state:'private'});
  const proof={confirmed:true,previousRemoteId:'old-work',remoteId:'new-work',url:'https://cp.kuaishou.com/article/edit/video?workId=new-work',state:'public',visibility:'public',reviewStatus:'passed',reopened:true,nativeScheduled:false,ownerConfirmed:true,observedAccountId:'actual-owner',evidence:'new work reopened; old private preserved',authorization:'explicit new upload public grant',evidenceSource:'local verified log',observedAt:new Date(f.now()).toISOString()};
  assert.throws(()=>s.adoptPublicAttempt(j.id,{...proof,url:'https://cp.kuaishou.com/article/edit/video?workId=wrong'}),/必须匹配/);
  s.adoptPublicAttempt(j.id,proof);assert.equal(j.status,'public');assert.equal(j.attempts[0].remote.id,'old-work');assert.equal(j.attempts[0].remote.state,'private');assert.equal(j.remote.id,'new-work');
  assert.throws(()=>s.adoptPublicAttempt(j.id,proof),/不可替换/);assert.equal(j.publicObservedAt,proof.observedAt);
});
test('immutable import, wrong account refusal, duplicate aliases, same-platform multiple clips',async()=>{
  const f=fixture();const p=await f.service.importPackage(f.manifest);assert.equal((await f.service.importPackage(f.manifest)).id,p.id);
  const b=f.service.bind({packageId:p.id,unitId:'full',platformId:'bilibili',accountId:'b'});
  assert.throws(()=>f.service.bind({packageId:p.id,unitId:'clip1',platformId:'douyin',accountId:'b'}),/不匹配/);
  const d=f.service.bind({packageId:p.id,unitId:'clip1',platformId:'douyin',accountId:'d'});
  assert.equal(f.service.bind({packageId:p.id,unitId:'clip1',platformId:'douyin',accountId:'d2'}).id,d.id);
  assert.notEqual(f.service.bind({packageId:p.id,unitId:'clip2',platformId:'douyin',accountId:'d'}).id,d.id);
  assert.equal(d.anchorJobId,b.id);fs.appendFileSync(p.units[1].artifacts.video.absolutePath,'changed');
  await assert.rejects(f.service.importPackage(f.manifest),/校验失败/);
});
test('3h after full, 2h actual observation spacing, late release and independent overseas',async()=>{
  const f=fixture(),s=f.service,p=await s.importPackage(f.manifest);
  const b=s.bind({packageId:p.id,unitId:'full',platformId:'bilibili',accountId:'b'});
  const c1=s.bind({packageId:p.id,unitId:'clip1',platformId:'douyin',accountId:'d'}),c2=s.bind({packageId:p.id,unitId:'clip2',platformId:'douyin',accountId:'d'});
  const y=s.bind({packageId:p.id,unitId:'fullEn',platformId:'youtube',accountId:'y'});
  for(const j of [b,c1,c2,y]){remote(s,j);await approve(s,j,f.now());}
  assert.equal(s.timing(c1).due,null);publicAt(s,b,f.now());
  assert.equal(Date.parse(s.timing(c1).due),f.now()+3*hour);assert.equal(s.timing(c2).due,null);
  assert.equal(Date.parse(s.timing(y).due),f.now());
  f.setTime(f.now()+8*hour);await s.tick();assert.equal(c1.status,'manual_due');assert.equal(c2.status,'approved');
  publicAt(s,c1,f.now());assert.equal(Date.parse(s.timing(c2).due),f.now()+2*hour);
  f.setTime(f.now()+hour);await s.tick();assert.equal(c2.status,'approved');
  f.setTime(f.now()+hour);await s.tick();assert.equal(c2.status,'manual_due');
});
test('approval must be human confirmed; remote change and account change invalidate; recovery never retries',async()=>{
  const f=fixture(),s=f.service,p=await s.importPackage(f.manifest),j=s.bind({packageId:p.id,unitId:'full',platformId:'bilibili',accountId:'b'});
  remote(s,j);await assert.rejects(s.approve(j.id,{reviewed:false,notBefore:new Date(f.now()).toISOString()}),/需要确认/);
  await approve(s,j,f.now());s.setRemote(j.id,{id:'new',url:j.remote.url,state:'draft'});assert.equal(j.approval,null);
  await approve(s,j,f.now());f.storage.db.accounts[0].runtimeAccount='changed';await s.tick();assert.equal(j.status,'uncertain');
  j.status='release_running';s.recover();assert.equal(j.status,'uncertain');await s.tick();assert.equal(j.status,'uncertain');
});
test('cancellation, manifest changes and future public timestamps fail closed',async()=>{
  const f=fixture(),s=f.service,p=await s.importPackage(f.manifest),j=s.bind({packageId:p.id,unitId:'full',platformId:'bilibili',accountId:'b'});
  remote(s,j);assert.throws(()=>publicAt(s,j,f.now()+hour),/未来/);
  fs.appendFileSync(f.manifest,'\n');await assert.rejects(approve(s,j,f.now()),/清单已改变/);
  s.cancel(j.id);assert.equal(j.status,'cancelled');await assert.rejects(approve(s,j,f.now()),/先在平台/);
});
test('YouTube lifecycle checks owner and changes only status preserving declarations, never snippet',async()=>{
  const calls=[];let visible='private';let wrong=false;
  const life=createYoutubeLifecycle({getToken:async()=> 'mock',httpJSON:async(url,options)=>{
    calls.push({url,options});if(url.includes('channels?'))return{status:200,data:{items:[{id:'mine'}]}};
    if(options.method==='PUT'){visible='public';return{status:200,data:{id:'abcdefghijk'}};}
    return{status:200,data:{items:[{id:'abcdefghijk',snippet:{channelId:wrong?'other':'mine',title:'Reviewed backend title'},status:{privacyStatus:visible,uploadStatus:'processed',containsSyntheticMedia:true,selfDeclaredMadeForKids:false,embeddable:false}}]}};
  }});
  const result=await life.release({id:'y'},{id:'abcdefghijk'});assert.equal(result.state,'public');
  const update=JSON.parse(calls.find(c=>c.options.method==='PUT').options.body);assert.equal(update.snippet,undefined);assert.equal(update.status.containsSyntheticMedia,true);assert.equal(update.status.embeddable,false);
  wrong=true;await assert.rejects(life.release({id:'y'},{id:'abcdefghijk'}),/不属于/);
});
test('YouTube public visibility alone is not proof when video processing is incomplete',async()=>{
  const life=createYoutubeLifecycle({getToken:async()=> 'mock',httpJSON:async url=>({status:200,data:url.includes('channels?')?{items:[{id:'mine'}]}:{items:[{snippet:{channelId:'mine'},status:{privacyStatus:'public',uploadStatus:'uploaded'}}]}})});
  assert.equal((await life.inspect({id:'y'},{id:'abcdefghijk'})).state,'processing_or_unavailable');
});

test('browser delivery locks duplicate uploads, requires evidence, permits only authorized private, no public approval',async()=>{
  const f=fixture(),s=f.service,p=await s.importPackage(f.manifest),j=s.bind({packageId:p.id,unitId:'full',platformId:'bilibili',accountId:'b'});
  const lease=await s.beginBrowserDelivery(j.id,{});
  await assert.rejects(s.beginBrowserDelivery(j.id,{}),/首次/);
  assert.throws(()=>s.cancel(j.id),/远端操作/);
  assert.throws(()=>s.setRemote(j.id,{id:'test',url:'https://member.bilibili.com/test',state:'draft'}),/执行中/);
  const data={leaseId:lease.leaseId,state:'draft',observedAccountId:'verified-uid',videoSha256:p.units[0].artifacts.video.sha256,evidence:'Saved and reopened exact title/video in draft list',browserSession:'Edge account profile'};
  assert.throws(()=>s.finishBrowserDelivery(j.id,{...data,state:'public'}),/只接受草稿/);
  assert.throws(()=>s.finishBrowserDelivery(j.id,{...data,state:'unlisted'}),/只接受草稿/);
  assert.throws(()=>s.finishBrowserDelivery(j.id,{...data,state:'private'}),/没有授权/);
  assert.throws(()=>s.finishBrowserDelivery(j.id,{...data,videoSha256:'wrong'}),/缺少实际/);
  s.finishBrowserDelivery(j.id,data);assert.equal(j.status,'draft_saved');assert.equal(j.remote,null);assert.equal(j.approval,null);
  await assert.rejects(s.beginBrowserDelivery(j.id,{}),/首次/);
});

test('nonpublic YouTube defaults refuse private, persists ID on uncertainty, never approves public',async()=>{
  const f=fixture({privateUploader:async(a,u,{onUploaded})=>{await onUploaded('abcdefghijk');throw Error('private state uncertain');}}),s=f.service,p=await s.importPackage(f.manifest),j=s.bind({packageId:p.id,unitId:'fullEn',platformId:'youtube',accountId:'y'});
  await assert.rejects(s.deliverNonPublic(j.id),/明确授权/);assert.equal(j.status,'prepared');
  await assert.rejects(s.deliverNonPublic(j.id,{allowPrivate:true}),/uncertain/);assert.equal(j.status,'uncertain');assert.equal(j.delivery.candidateRemoteId,'abcdefghijk');assert.equal(j.approval,null);
  await assert.rejects(s.deliverNonPublic(j.id,{allowPrivate:true}),/首次/);
});

test('failed post-save browser recheck preserves evidence and exact work, blocks uploads and clears approval',async()=>{
  const f=fixture(),s=f.service,p=await s.importPackage(f.manifest),j=s.bind({packageId:p.id,unitId:'full',platformId:'bilibili',accountId:'b'});
  assert.throws(()=>s.blockBrowserDelivery(j.id,{invalidateSavedEvidence:true,reason:'not uploaded'}),/无效/);
  const lease=await s.beginBrowserDelivery(j.id,{allowPrivate:true});
  assert.throws(()=>s.blockBrowserDelivery(j.id,{leaseId:'wrong',reason:'bad'}),/无效/);
  s.finishBrowserDelivery(j.id,{leaseId:lease.leaseId,state:'private',observedAccountId:'uid',videoSha256:p.units[0].artifacts.video.sha256,remoteId:'saved',url:'https://member.bilibili.com/saved',evidence:'initial private verified',browserSession:'test'});
  const savedRemote={...j.remote},savedEvidence={...j.delivery.evidence};
  assert.throws(()=>s.blockBrowserDelivery(j.id,{reason:'media cannot restore'}),/无效/);
  assert.throws(()=>s.blockBrowserDelivery(j.id,{invalidateSavedEvidence:true,reason:''}),/无效/);
  s.blockBrowserDelivery(j.id,{invalidateSavedEvidence:true,reason:'media cannot restore'});
  assert.equal(j.status,'uncertain');assert.equal(j.approval,null);assert.deepEqual(j.remote,savedRemote);assert.deepEqual(j.delivery.evidence,savedEvidence);assert.equal(j.delivery.recheckFailure.previousStatus,'private_saved');
  await assert.rejects(s.beginBrowserDelivery(j.id,{}),/首次/);await s.tick();assert.equal(j.status,'uncertain');
});

test('successful private delivery is not public and needs separate human review',async()=>{
  const f=fixture({privateUploader:async()=>({id:'abcdefghijk',url:'https://www.youtube.com/watch?v=abcdefghijk',state:'private',warnings:[]})}),s=f.service,p=await s.importPackage(f.manifest),j=s.bind({packageId:p.id,unitId:'fullEn',platformId:'youtube',accountId:'y'});
  await s.deliverNonPublic(j.id,{allowPrivate:true});assert.equal(j.status,'private_saved');assert.equal(j.remote.state,'private');assert.equal(j.publicObservedAt,undefined);assert.equal(j.approval,null);assert.equal(s.timing(j).due,null);
  j.status='delivery_running';s.recover();assert.equal(j.status,'uncertain');
});

test('missing OAuth before any upload keeps task prepared, not uncertain',async()=>{
  const uploader=async()=>{throw Error('must not upload');};uploader.preflight=async()=>{throw Error('OAuth not configured');};
  const f=fixture({privateUploader:uploader}),p=await f.service.importPackage(f.manifest),j=f.service.bind({packageId:p.id,unitId:'fullEn',platformId:'youtube',accountId:'y'});
  await assert.rejects(f.service.deliverNonPublic(j.id,{allowPrivate:true}),/OAuth/);assert.equal(j.status,'prepared');assert.equal(j.delivery,undefined);
});

test('YouTube private uploader ignores legacy public privacy preference and verifies exact owner/state',async()=>{
  const f=fixture(),p=await f.service.importPackage(f.manifest);const u=p.units[3];let metadata;let uploadedId;
  const {createPrivateUploader}=require('../server/adapters/video-private');
  const uploader=createPrivateUploader({getToken:async()=> 'mock',httpJSON:async(url)=>({status:200,data:url.includes('channels?')?{items:[{id:'mine'}]}:{items:[{id:'abcdefghijk',snippet:{channelId:'mine'},status:{privacyStatus:'private',uploadStatus:'uploaded'}}]}}),request:async(url,opt)=>{
    if(url.includes('uploadType=resumable')){metadata=JSON.parse(opt.body);return{ok:true,headers:{get:()=> 'https://www.googleapis.com/upload/session'}};}
    if(opt.method==='PUT'){for await(const chunk of opt.body){};return{ok:true,json:async()=>({id:'abcdefghijk'})};}
    return{ok:false};
  }});
  const result=await uploader({credentials:{privacy:'public'}},u,{onUploaded:id=>uploadedId=id});
  assert.equal(metadata.status.privacyStatus,'private');assert.equal(metadata.status.publishAt,undefined);assert.equal(metadata.status.selfDeclaredMadeForKids,undefined);assert.equal(result.state,'private');assert.equal(uploadedId,'abcdefghijk');assert.equal(result.warnings.length,1);
});

test('batch preparation validates every selection and dependency before binding; group and aliases stay scoped',async()=>{
  const f=fixture(),s=f.service,p=await s.importPackage(f.manifest);
  f.storage.db.accountGroups.push({id:'g',accountIds:['b','d','d2']});
  const selections=[{unitId:'clip1',accountId:'d'},{unitId:'full',accountId:'b'}];
  assert.throws(()=>s.prepareBatch({packageId:p.id,accountGroupId:'g',selections:[...selections,{unitId:'fullEn',accountId:'y'}]}),/不匹配/);
  assert.equal(f.storage.db.videoJobs.length,0);
  assert.throws(()=>s.prepareBatch({packageId:p.id,accountGroupId:'g',selections:[selections[0]]}),/锚点/);
  const plan=s.prepareBatch({packageId:p.id,accountGroupId:'g',selections});assert.equal(plan.items.length,2);assert.equal(plan.counts.browser,2);assert.equal(plan.counts.ready,0);
  assert.equal(s.prepareBatch({packageId:p.id,accountGroupId:'g',selections}).items.length,2);assert.equal(f.storage.db.videoJobs.length,2);
  assert.throws(()=>s.planBatch({packageId:p.id,accountGroupId:'missing'}),/不存在/);
  const y=s.bind({packageId:p.id,unitId:'fullEn',platformId:'youtube',accountId:'y'});
  assert.equal(s.planBatch({packageId:p.id,accountGroupId:'g',jobIds:[y.id]}).items.length,0);
  assert.throws(()=>s.prepareBatch({packageId:p.id,accountGroupId:'g',selections:[{unitId:'full',accountId:'d'}]}),/不匹配/);
});

test('batch direct delivery is sequential and never uploads browser/saved/uncertain/running/cancelled records',async()=>{
  const calls=[];
  const f=fixture({draftPlatform:'shipinhao',cli:async args=>{calls.push(args[0]);return args[0]==='prepare-handoff'?{runDirectory:'test-run'}:args[0]==='preflight'?{ok:true}:{results:{tencent:{status:'success'}}};}}),s=f.service,p=await s.importPackage(f.manifest);
  const b=s.bind({packageId:p.id,unitId:'full',platformId:'bilibili',accountId:'b'}),d=s.bind({packageId:p.id,unitId:'clip1',platformId:'shipinhao',accountId:'d'}),d2=s.bind({packageId:p.id,unitId:'clip2',platformId:'shipinhao',accountId:'d'});
  d2.status='uncertain';const ids=[b.id,d.id,d2.id];
  await assert.rejects(s.deliverBatch({packageId:p.id,jobIds:ids}),/确认/);assert.equal(calls.length,0);
  const result=await s.deliverBatch({packageId:p.id,jobIds:ids,confirmed:true});assert.deepEqual(calls,['prepare-handoff','preflight','publish']);
  assert.deepEqual(result.results.map(r=>r.disposition),['browser','saved','skip']);assert.equal(b.status,'prepared');assert.equal(d.approval,null);
  for(const status of ['draft_saved','private_saved','uncertain','delivery_running','draft_running','cancelled','approved','public']) {d.status=status;const again=await s.deliverBatch({packageId:p.id,jobIds:[d.id],confirmed:true});assert.equal(again.results[0].disposition,'skip');}
  assert.equal(calls.length,3);
});

test('reconcile exact private/draft evidence does not reupload, preserves history and isolates preview warning',async()=>{
  const f=fixture(),s=f.service,p=await s.importPackage(f.manifest),j=s.bind({packageId:p.id,unitId:'full',platformId:'bilibili',accountId:'b'});
  j.status='uncertain';j.error='old preview failure';j.delivery={route:'browser_agent',recheckFailure:{reason:'preview failed',previousStatus:'draft_saved'}};
  const value={url:'https://member.bilibili.com/platform/upload/video/frame?type=draft&draftId=12345',state:'draft',ownerConfirmed:true,visibilityConfirmed:true,observedAccountId:'uid-b',evidence:'exact draft title/owner/media checked',previewWarning:'browser playback needs manual review'};
  assert.throws(()=>s.reconcile(j.id,{...value,ownerConfirmed:false}),/必须核对/);
  assert.throws(()=>s.reconcile(j.id,{...value,url:'https://member.bilibili.com/platform/home'}),/准确/);
  assert.throws(()=>s.reconcile(j.id,{...value,id:'other'}),/一致/);
  assert.throws(()=>s.reconcile(j.id,{...value,state:'public'}),/只接受/);
  assert.throws(()=>s.reconcile(j.id,{...value,url:'https://evil.test/publish/update?id=12345'}),/HTTPS/);
  s.reconcile(j.id,value);assert.equal(j.status,'draft_saved');assert.equal(j.remote.id,'12345');assert.equal(j.approval,null);assert.equal(j.error,null);assert.equal(j.reconciliations[0].previousError,'old preview failure');assert.ok(j.delivery.recheckFailure.resolvedAt);
  assert.equal(s.snapshot().jobs[0].workbench.previewWarning,value.previewWarning);assert.equal(s.snapshot().jobs[0].workbench.canApprove,true);assert.equal(s.timing(j).due,null);
  await assert.rejects(s.beginBrowserDelivery(j.id,{}),/首次/);
  await assert.rejects(s.approve(j.id,{reviewed:false}),/需要确认/);await approve(s,j,f.now());assert.equal(j.status,'approved');
  assert.throws(()=>s.reconcile(j.id,{...value,url:value.url.replace('12345','99999')}),/不同作品/);
  j.status='delivery_running';assert.throws(()=>s.reconcile(j.id,value),/不能登记/);
});

test('exact references and honest list fallbacks are distinct; XHS private is not public approval',()=>{
  const {referenceId,project,category}=require('../server/videoWorkbench.cjs'),{capability}=require('../server/videoDelivery.cjs');
  const url='https://creator.xiaohongshu.com/publish/update?id=abcdef1234567890abcdef12&noteType=video';
  assert.equal(referenceId('xiaohongshu',url),'abcdef1234567890abcdef12');assert.equal(referenceId('xiaohongshu','https://creator.xiaohongshu.com/new/note-manager'),null);
  const saved=project({status:'private_saved',platformId:'xiaohongshu',remote:{url}},{});assert.equal(saved.reviewUrl,url);assert.equal(saved.reviewExact,true);assert.equal(saved.canApprove,true);assert.equal(saved.category,'review');
  const draft=project({status:'draft_saved',platformId:'douyin'}, {douyin:'https://creator.douyin.com/'});assert.equal(draft.reviewExact,false);assert.equal(draft.canApprove,false);
  assert.equal(category({status:'manual_due'}),'release');assert.equal(category({status:'uncertain'}),'check');assert.equal(capability('xiaohongshu').preferredState,'private');
  assert.equal(project({status:'public',platformId:'bilibili',remote:{url:'https://member.bilibili.com/platform/upload/video/frame?draftId=1'},publicUrl:'https://www.bilibili.com/video/BVtest'},{}).reviewUrl,'https://www.bilibili.com/video/BVtest');
});

test('complete platform variants retain identity, require correct full anchor and preserve actual-public 3h/2h gates',async()=>{
  const f=fixture(),s=f.service;
  const input=JSON.parse(fs.readFileSync(f.manifest,'utf8'));input.units[1].kind='platform_variant';input.units[2].kind='platform_variant';
  fs.writeFileSync(f.manifest,JSON.stringify(input));const p=await s.importPackage(f.manifest);
  assert.equal(p.units[1].kind,'platform_variant');
  assert.throws(()=>s.bind({packageId:p.id,unitId:'clip1',platformId:'douyin',accountId:'d'}),/完整版/);
  f.storage.db.accountGroups.push({id:'g',accountIds:['b','d']});
  s.prepareBatch({packageId:p.id,accountGroupId:'g',selections:[{unitId:'clip1',accountId:'d'},{unitId:'clip2',accountId:'d'},{unitId:'full',accountId:'b'}]});
  const [b,c1,c2]=f.storage.db.videoJobs;
  for(const j of [b,c1,c2]){remote(s,j);await approve(s,j,f.now());}
  assert.equal(s.timing(c1).due,null);publicAt(s,b,f.now());assert.equal(Date.parse(s.timing(c1).due),f.now()+3*hour);assert.equal(s.timing(c2).due,null);
  f.setTime(f.now()+4*hour);publicAt(s,c1,f.now());assert.equal(Date.parse(s.timing(c2).due),f.now()+2*hour);
  input.units[1].release_intent.depends_on_full_unit='fullEn';fs.writeFileSync(f.manifest,JSON.stringify(input));await assert.rejects(loadHandoff(f.manifest),/同组同语言/);
  input.units[1].release_intent.depends_on_full_unit=null;fs.writeFileSync(f.manifest,JSON.stringify(input));await assert.rejects(loadHandoff(f.manifest),/锚点/);
});

test('CLI draft submission can fail independent readback without losing evidence or allowing a reupload',async()=>{
  const calls=[];
  const f=fixture({draftPlatform:'shipinhao',cli:async args=>{calls.push(args[0]);return args[0]==='prepare-handoff'?{runDirectory:'test-run'}:args[0]==='preflight'?{ok:true}:{results:{tencent:{status:'success',draftOnly:true}}};}}),s=f.service,p=await s.importPackage(f.manifest);
  s.bind({packageId:p.id,unitId:'full',platformId:'bilibili',accountId:'b'});
  const j=s.bind({packageId:p.id,unitId:'clip1',platformId:'shipinhao',accountId:'d'});
  assert.throws(()=>s.blockBrowserDelivery(j.id,{invalidateSavedEvidence:true,reason:'not submitted'}),/无效/);
  await s.uploadDraft(j.id);const evidence={...j.draftEvidence};
  assert.throws(()=>s.blockBrowserDelivery(j.id,{reason:'not found'}),/无效/);
  s.blockBrowserDelivery(j.id,{invalidateSavedEvidence:true,reason:'Logged-in creator readback did not expose the submitted draft'});
  assert.equal(j.status,'uncertain');assert.equal(j.approval,null);assert.deepEqual(j.draftEvidence,evidence);
  assert.equal(j.delivery.route,'draft_cli');assert.equal(j.delivery.recheckFailure.previousStatus,'draft_saved');
  await assert.rejects(s.uploadDraft(j.id),/首次/);await s.tick();assert.equal(j.status,'uncertain');assert.deepEqual(calls,['prepare-handoff','preflight','publish']);
});

test('Douyin legacy CLI is blocked before side effects; browser route stays experimental and uncertain cannot retry',async()=>{
  let calls=0;
  const f=fixture({cli:async()=>{calls++;throw Error('must never spawn');}}),s=f.service,p=await s.importPackage(f.manifest);
  s.bind({packageId:p.id,unitId:'full',platformId:'bilibili',accountId:'b'});
  const j=s.bind({packageId:p.id,unitId:'clip1',platformId:'douyin',accountId:'d'});
  await assert.rejects(s.uploadDraft(j.id),/已停用/);
  assert.equal(calls,0);assert.equal(j.status,'prepared');
  const cap=s.snapshot().deliveryCapabilities.douyin;
  assert.equal(cap.route,'browser_agent');assert.equal(cap.verification,'experimental_reopen_required');
  const plan=s.planBatch({packageId:p.id,jobIds:[j.id]});assert.equal(plan.counts.ready,0);assert.equal(plan.counts.browser,1);
  await s.deliverBatch({packageId:p.id,jobIds:[j.id],confirmed:true});assert.equal(calls,0);assert.equal(j.status,'prepared');
  const lease=await s.beginBrowserDelivery(j.id,{allowPrivate:false});
  s.blockBrowserDelivery(j.id,{leaseId:lease.leaseId,reason:'local staging cannot be reopened'});
  assert.equal(j.status,'uncertain');assert.equal(j.approval,null);
  await assert.rejects(s.beginBrowserDelivery(j.id,{}),/首次/);
  await assert.rejects(s.uploadDraft(j.id),/首次/);await s.tick();assert.equal(j.status,'uncertain');assert.equal(calls,0);
});

test('scoped legacy Douyin private recovery preserves history, locks duplicates, and never approves public',async()=>{
  const f=fixture(),s=f.service,p=await s.importPackage(f.manifest);
  s.bind({packageId:p.id,unitId:'full',platformId:'bilibili',accountId:'b'});
  const j=s.bind({packageId:p.id,unitId:'clip1',platformId:'douyin',accountId:'d'});
  j.status='uncertain';j.error='local staging not recovered';j.draftEvidence={status:'success',url:'upload-only'};
  j.delivery={route:'draft_cli',recheckFailure:{reason:j.error}};
  const recovery={confirmed:true,privateOnly:true,ownerConfirmed:true,priorWorkChecked:true,previousError:j.error,observedAccountId:'actual-owner',evidence:'fresh owner/library/restore checked',authorization:'explicit scoped private permission'};
  for(const patch of [{confirmed:false},{privateOnly:false},{ownerConfirmed:false},{priorWorkChecked:false},{previousError:'stale'},{authorization:''}]){
    await assert.rejects(s.beginBrowserDelivery(j.id,{allowPrivate:true,recovery:{...recovery,...patch}}),/禁止自动重传/);
    assert.equal(j.status,'uncertain');assert.equal(j.deliveryHistory,undefined);
  }
  j.remote={id:'known'};await assert.rejects(s.beginBrowserDelivery(j.id,{allowPrivate:true,recovery}),/禁止自动重传/);j.remote=null;
  j.delivery.candidateRemoteId='possible';await assert.rejects(s.beginBrowserDelivery(j.id,{allowPrivate:true,recovery}),/禁止自动重传/);delete j.delivery.candidateRemoteId;
  const oldDelivery=structuredClone(j.delivery),oldEvidence=structuredClone(j.draftEvidence);
  const lease=await s.beginBrowserDelivery(j.id,{allowPrivate:true,recovery});
  assert.equal(j.deliveryHistory.length,1);assert.deepEqual(j.deliveryHistory[0].delivery,oldDelivery);assert.deepEqual(j.deliveryHistory[0].draftEvidence,oldEvidence);
  await assert.rejects(s.beginBrowserDelivery(j.id,{allowPrivate:true,recovery}),/禁止自动重传/);
  const finish={leaseId:lease.leaseId,state:'private',observedAccountId:'actual-owner',videoSha256:p.units[1].artifacts.video.sha256,remoteId:'123456789',url:'https://www.douyin.com/video/123456789',evidence:'exact private work reopened',browserSession:'durable browser'};
  assert.throws(()=>s.finishBrowserDelivery(j.id,{...finish,state:'draft'}),/恢复仅允许/);
  assert.throws(()=>s.finishBrowserDelivery(j.id,{...finish,state:'public'}),/只接受草稿/);
  s.finishBrowserDelivery(j.id,finish);assert.equal(j.status,'private_saved');assert.equal(j.approval,null);assert.equal(j.publicObservedAt,undefined);assert.equal(j.deliveryHistory.length,1);
});

test('public grant cannot come from upload permission; preserves review and validates policy',async()=>{
  const {s,j}=await releaseFixture();const prior=structuredClone(j.approval);
  assert.throws(()=>agentGrant(s,j,{confirmed:false}),/明确公开授权/);
  assert.throws(()=>agentGrant(s,j,{settings:{topics:'anything_hot'}}),/不相关热点/);
  assert.equal(j.mode,'manual');assert.equal(j.releaseAuthorization,undefined);
  agentGrant(s,j);assert.equal(j.mode,'browser_agent_release');assert.equal(j.approval.approvedAt,prior.approvedAt);
  assert.equal(j.releaseHistory[0].previous.mode,'manual');
});
test('agent execution cannot start early, wrong owner/work, unknown native schedule, or twice',async()=>{
  const {s,j,setTime,now}=await releaseFixture();agentGrant(s,j);
  await assert.rejects(s.beginBrowserRelease(j.id,observation(j)),/尚未到期/);
  setTime(now()+3*hour);await s.tick();assert.equal(j.status,'agent_due');
  for(const patch of [{observedAccountId:'wrong'},{remoteId:'wrong'},{nativeScheduled:true},{nativeScheduled:undefined}]) await assert.rejects(s.beginBrowserRelease(j.id,observation(j,patch)),/账号|准确作品|双调度/);
  const leases=await Promise.allSettled([s.beginBrowserRelease(j.id,observation(j)),s.beginBrowserRelease(j.id,observation(j))]);
  assert.equal(leases.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(j.status,'release_running');assert.equal(s.snapshot().jobs.find(x=>x.id===j.id).release.leaseId,undefined);
  assert.throws(()=>s.cancel(j.id),/远端操作/);
});
test('submission journal is required; pending audit blocks next work; no automatic retry',async()=>{
  const {s,j,p,setTime,now}=await releaseFixture();agentGrant(s,j);setTime(now()+3*hour);
  const next=s.bind({packageId:p.id,unitId:'clip2',platformId:'douyin',accountId:'d'});remote(s,next);await approve(s,next,now());
  const l=await s.beginBrowserRelease(j.id,observation(j));
  assert.throws(()=>s.finishBrowserRelease(j.id,{...observation(j),leaseId:l.leaseId}),/尚未登记提交/);
  s.submittingBrowserRelease(j.id,{leaseId:l.leaseId});
  assert.throws(()=>s.submittingBrowserRelease(j.id,{leaseId:l.leaseId}),/执行锁/);
  s.finishBrowserRelease(j.id,{...observation(j,{state:'pending_review'}),leaseId:l.leaseId});
  assert.equal(j.status,'awaiting_public');assert.equal(j.publicObservedAt,undefined);assert.equal(s.timing(next).due,null);
  await s.tick();assert.equal(j.status,'awaiting_public');
  await assert.rejects(s.beginBrowserRelease(j.id,observation(j)),/已有公开操作/);
});
test('public evidence must be reopened and passed; timestamps remain stable and drive 2h interval',async()=>{
  const {s,j,p,setTime,now}=await releaseFixture();agentGrant(s,j);setTime(now()+3*hour);
  const l=await s.beginBrowserRelease(j.id,observation(j));s.submittingBrowserRelease(j.id,{leaseId:l.leaseId});
  const evidence={...observation(j,{state:'public',visibility:'public',reviewStatus:'passed',reopened:true}),url:'https://www.douyin.com/video/123456',leaseId:l.leaseId};
  for(const patch of [{reviewStatus:'pending'},{visibility:'private'},{reopened:false},{remoteId:'123457'},{url:'https://www.douyin.com/video/123457'}]) assert.throws(()=>s.finishBrowserRelease(j.id,{...evidence,...patch}),/公开确认|准确作品|不一致/);
  s.finishBrowserRelease(j.id,evidence);const at=j.publicObservedAt;
  assert.equal(j.status,'public');assert.equal(j.publicEvidence.type,'browser_agent');assert.equal(j.release.leaseId,undefined);
  const next=s.bind({packageId:p.id,unitId:'clip2',platformId:'douyin',accountId:'d'});remote(s,next);await approve(s,next,now());
  assert.equal(Date.parse(s.timing(next).due),now()+2*hour);
  setTime(now()+hour);s.observeBrowserPublic(j.id,evidence);assert.equal(j.publicObservedAt,at);
});
test('changed approval/content and restart after submit fail closed; read-only reconciliation remains possible',async()=>{
  const {s,j,setTime,now}=await releaseFixture();agentGrant(s,j,{contentFingerprint:'reviewed-copy'});setTime(now()+3*hour);
  await assert.rejects(s.beginBrowserRelease(j.id,observation(j,{contentFingerprint:'changed'})),/内容已变/);
  const l=await s.beginBrowserRelease(j.id,observation(j));s.submittingBrowserRelease(j.id,{leaseId:l.leaseId});s.recover();
  assert.equal(j.status,'uncertain');await s.tick();assert.equal(j.status,'uncertain');
  await assert.rejects(s.beginBrowserRelease(j.id,observation(j)),/已有公开操作/);
  s.observeBrowserPublic(j.id,{...observation(j,{state:'public',visibility:'public',reviewStatus:'passed',reopened:true}),url:j.remote.url});assert.equal(j.status,'public');
});
test('resident browser mode is disabled without verified adapter and session',async()=>{
  const {s,j}=await releaseFixture();j.status='private_saved';j.approval=null;
  await assert.rejects(approve(s,j,Date.now(),'browser_auto'),/尚未验证/);assert.equal(j.status,'private_saved');
});
test('resident worker rechecks content/owner, submits once, only reads pending audit, and spacing advances on public',async()=>{
  let state='private',calls=0,changed=false;
  const driver={ready:()=>true,inspect:async(a,j)=>observation(j,{state,contentFingerprint:changed?'changed':'reviewed-copy',...(state==='public'?{visibility:'public',reviewStatus:'passed',reopened:true,url:j.remote.url}:{})}),release:async(a,j)=>{calls++;state='pending_review';return observation(j,{state});}};
  const {s,j,setTime,now}=await releaseFixture({browserRelease:driver});j.status='private_saved';j.approval=null;
  await approve(s,j,now(),'browser_auto');setTime(now()+3*hour);await s.tick();assert.equal(calls,1);assert.equal(j.status,'awaiting_public');
  await s.tick();assert.equal(calls,1);assert.equal(j.publicObservedAt,undefined);
  state='public';await s.tick();assert.equal(calls,1);assert.equal(j.status,'public');assert.equal(j.publicEvidence.type,'browser_auto');
});
test('resident worker refuses edits after review and never calls release',async()=>{
  let changed=false,calls=0;
  const driver={ready:()=>true,inspect:async(a,j)=>observation(j,{contentFingerprint:changed?'changed':'reviewed-copy'}),release:async()=>{calls++;throw Error('must not call');}};
  const {s,j,setTime,now}=await releaseFixture({browserRelease:driver});j.status='private_saved';j.approval=null;
  await approve(s,j,now(),'browser_auto');changed=true;setTime(now()+3*hour);await s.tick();assert.equal(calls,0);assert.equal(j.status,'uncertain');
});
test('legacy general Douyin task cannot bypass the disabled draft route',()=>{
  const {getPlatform}=require('../server/platforms'),{getAdapter}=require('../server/adapters');
  assert.equal(getPlatform('douyin').draftSupport.video,'unsupported');
  assert.equal(getAdapter(getPlatform('douyin'),'video','save_draft'),require('../server/adapters/unsupported'));
});
