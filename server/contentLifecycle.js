const store = require('./store');
const crypto = require('node:crypto');

const BLOCKED_VIDEO = new Set(['draft_running', 'delivery_running', 'release_running', 'awaiting_public', 'uncertain']);
const TERMINAL_VIDEO = new Set(['public', 'cancelled']);
const TERMINAL_TASK = new Set(['success', 'failed', 'unsupported', 'skipped', 'simulated', 'cancelled']);
function createContentLifecycle(storage = store) {
  const db = () => storage.db;
  function record(kind, id) {
    if (!['content', 'video'].includes(kind)) throw Error('内容类型不存在');
    const item = (kind === 'video' ? db().videoPackages : db().contents).find(x => x.id === id);
    if (!item) throw Error('内容不存在');
    return item;
  }
  function state(item) { return item.lifecycle?.state || 'active'; }
  function requireActive(kind, id) {
    const item = record(kind, id);
    if (state(item) !== 'active') throw Error('内容已归档或在回收站，请先恢复并重新选择发布计划');
    return item;
  }
  function impact(kind, id) {
    const item = record(kind, id);
    const tasks = kind === 'video' ? db().videoJobs.filter(x => x.packageId === id) : db().tasks.filter(x => x.contentId === id);
    const blocked = [], cancellable = [];
    for (const t of tasks) {
      const pending = kind === 'video' ? !TERMINAL_VIDEO.has(t.status) : !TERMINAL_TASK.has(t.status) || (t.status !== 'cancelled' && t.targets?.some(x => x.retryable || x.status==='pending'));
      const unknown = kind === 'video' ? BLOCKED_VIDEO.has(t.status) || t.remote?.state === 'native_scheduled' : t.status === 'running' || t.targets?.some(x => ['running', 'uncertain'].includes(x.status) || x.evidence?.nativeScheduled === true);
      if (unknown) blocked.push({ id:t.id, status:t.status, reason:kind === 'video' && t.remote?.state === 'native_scheduled' ? '平台原生定时须先核查并撤销' : '执行中或远端结果待核查' });
      else if (pending) cancellable.push({ id:t.id, status:t.status });
    }
    return { kind, id, title:item.title, state:state(item), units:kind === 'video' ? item.units.length : 1, tasks:tasks.length,
      publicCount:kind === 'video' ? tasks.filter(x => x.status === 'public').length : 0,
      blocked, cancellable, canArchive:!blocked.length && !cancellable.length };
  }
  function change(kind, id, action, { cancelPending = false } = {}) {
    const item = record(kind, id), before = state(item), at = storage.now();
    if (!['archive','trash','restore'].includes(action)) throw Error('未知整理动作');
    if ((action === 'trash' && before === 'trashed') || (action === 'archive' && before === 'archived') || (action === 'restore' && before === 'active')) return {ok:true, impact:impact(kind,id)};
    if (action === 'archive' && before === 'trashed') throw Error('回收站内容请先恢复');
    const check = impact(kind, id);
    if (action !== 'restore') {
      if (check.blocked.length) throw Error('无法整理：' + check.blocked.map(x => x.reason + '（' + x.id + '）').join('；'));
      if (action === 'archive' && check.cancellable.length) throw Error('仍有未完成计划，请先完成或取消再归档');
      if (check.cancellable.length && cancelPending !== true) throw Error('存在未完成计划，请明确选择取消这些计划后移入回收站');
      for (const ref of check.cancellable) {
        const task = (kind === 'video' ? db().videoJobs : db().tasks).find(x => x.id === ref.id);
        task.status = 'cancelled'; task.cancelledAt = at; task.cancelReason = '内容移入回收站';
        if (kind === 'video') { task.approval = null; task.releaseAuthorization = null; }
        else { task.finishedAt = at; for (const target of task.targets || []) if (['pending','failed','needs_user_action'].includes(target.status)) {target.status='cancelled'; target.retryable=false;} }
      }
    }
    item.lifecycle = { state:action === 'restore' ? 'active' : action === 'archive' ? 'archived' : 'trashed', changedAt:at };
    item.lifecycleHistory ||= [];
    item.lifecycleHistory.push({ at, before, action, cancelledTaskIds:action === 'trash' ? check.cancellable.map(x=>x.id) : [] });
    storage.save();
    return {ok:true, impact:impact(kind,id)};
  }
  function retirementCheck(j) {
    const p=db().videoPackages.find(x=>x.id===j.packageId);
    if(!p || !db().videoPackages.some(x=>x.packageId===p.packageId&&x.revision!==p.revision&&String(x.importedAt||'')>String(p.importedAt||''))) return '没有更新版本替代此任务';
    if(j.status!=='uncertain'||j.error!=='已导入新成品版本，旧版需重新审阅；平台原生定时请人工撤销') return '并非可统一关闭的旧版待办';
    if(j.approval||j.releaseAuthorization||j.release||j.remote?.state==='native_scheduled'||j.nativeScheduled===true) return '仍有授权、公开执行或平台原生定时，需核查';
    return null;
  }
  function cleanupPreview() {
    return {items:db().videoJobs.filter(j=>j.status==='uncertain').map(j=>({id:j.id,packageId:j.packageId,platformId:j.platformId,title:db().videoPackages.find(p=>p.id===j.packageId)?.title||j.unitId,eligible:!retirementCheck(j),reason:retirementCheck(j)}))};
  }
  function closeOld({jobIds,confirmed=false}={}) {
    if(confirmed!==true||!Array.isArray(jobIds)||!jobIds.length||jobIds.length>100) throw Error('需确认并明确选择1至100条旧版待办');
    const at=storage.now();
    const results=[...new Set(jobIds)].map(id=>{
      const j=db().videoJobs.find(x=>x.id===id);
      if(!j)return {id,ok:false,error:'任务不存在'};
      if(j.status==='cancelled'&&j.retirement)return {id,ok:true,alreadyClosed:true};
      const error=retirementCheck(j);if(error)return {id,ok:false,error};
      j.retirement={at,previousStatus:j.status,previousError:j.error,remote:structuredClone(j.remote||null),reason:'用户明确关闭被新版替代的本地旧计划；未核查、删除或改变远端作品'};
      j.status='cancelled';j.cancelledAt=at;j.cancelReason=j.retirement.reason;j.error=null;j.approval=null;j.releaseAuthorization=null;
      return {id,ok:true};
    });
    storage.save();return {results};
  }
  function purge(kind,id,{confirmed=false,cancelPending=false}={}) {
    if(confirmed!==true)throw Error('彻底删除不可从回收站恢复，必须明确确认');
    const item=record(kind,id), check=impact(kind,id);
    if(check.blocked.length)throw Error('不能彻底删除：'+check.blocked.map(x=>x.reason+'（'+x.id+'）').join('；'));
    if(check.cancellable.length&&cancelPending!==true)throw Error('需明确取消尚未提交的本地计划后才能彻底删除');
    // Never lose an external dependency merely because its anchor was deleted.
    const related=kind==='video'?db().videoJobs.filter(j=>j.packageId===id):db().tasks.filter(t=>t.contentId===id);
    const ids=new Set(related.map(j=>j.id));
    if(kind==='video'&&db().videoJobs.some(j=>!ids.has(j.id)&&ids.has(j.anchorJobId)&&!TERMINAL_VIDEO.has(j.status)))throw Error('其它未完成任务仍依赖此完整版，不能彻底删除');
    const before=structuredClone(db());
    const backupPath=storage.backupBeforePurge?.()||null;
    const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value||null)).digest('hex');
    const at=storage.now();
    const entries=related.map(j=>kind==='video'?{id:j.id,deliveryKey:j.deliveryKey,platformId:j.platformId,accountId:j.account?.id,status:j.status,remote:j.remote||null,publicUrl:j.publicUrl||null,publicObservedAt:j.publicObservedAt||null,evidenceHash:hash(j.publicEvidence||j.delivery?.evidence),retirement:j.retirement||null,attempts:(j.attempts||[]).map(a=>({id:a.id,remote:a.remote,status:a.status,observedAt:a.observedAt}))}:{id:j.id,operation:j.operation,status:j.status,targets:(j.targets||[]).map(t=>({idempotencyKey:t.idempotencyKey,accountId:t.accountId,platformId:t.platformId,status:t.status,externalId:t.externalId||null}))});
    try {
      // Existing retry timers may still hold object references after array removal.
      for(const ref of check.cancellable){const task=related.find(t=>t.id===ref.id);task.status='cancelled';task.cancelledAt=at;task.approval=null;task.releaseAuthorization=null;for(const target of task.targets||[]){target.retryable=false;if(['pending','failed','needs_user_action'].includes(target.status))target.status='cancelled';}}
      db().deletionLedger ||= [];
      db().deletionLedger.push({kind,id,at,bundleId:item.skillBundle?.bundleId||null,packageId:item.packageId||null,revision:item.revision||null,manifestHash:item.manifestHash||null,sourceHash:item.skillBundle?.source?.sha256||null,artifactHashes:kind==='video'?item.units.flatMap(u=>Object.values(u.artifacts||{}).map(a=>a.sha256)):[],records:entries,backupPath,cancelledLocalTaskIds:check.cancellable.map(j=>j.id)});
      if(kind==='video'){db().videoJobs=db().videoJobs.filter(j=>j.packageId!==id);db().videoPackages=db().videoPackages.filter(p=>p.id!==id);}
      else {db().tasks=db().tasks.filter(t=>t.contentId!==id);db().contents=db().contents.filter(c=>c.id!==id);}
      storage.save();
    } catch(e){for(const key of Object.keys(db()))delete db()[key];Object.assign(db(),before);throw e;}
    return {ok:true,kind,id,removedTasks:related.length,preservedFiles:true,preservedRemoteWorks:true,backupPath};
  }
  function list({ scope = 'active', type = '', query = '', platform = '', groupId = '' } = {}) {
    if (!['active','archived','trashed','all'].includes(scope)) throw Error('未知内容库范围');
    const group = groupId ? db().accountGroups.find(g=>g.id===groupId) : null;
    const rows = [
      ...db().contents.map(c => ({key:'content:'+c.id,kind:'content',id:c.id,type:c.type,title:c.title,revision:c.revisionId||'',logicalId:c.skillBundle?.bundleId||c.id,at:c.updatedAt||c.createdAt,platforms:Object.keys(c.platformVersions||{}),source:c.skillBundle?.source?.path||c.videoFile?.absolutePath||null,item:c})),
      ...db().videoPackages.map(p => ({key:'video:'+p.id,kind:'video',id:p.id,type:'video',title:p.title,revision:p.revision,logicalId:p.packageId,at:p.importedAt,platforms:[...new Set(p.units.flatMap(u=>u.targets.map(t=>t.platform)))],source:p.manifestPath||p.sourcePath||null,item:p}))
    ];
    for (const row of rows) {row.state=state(row.item);row.impact=impact(row.kind,row.id);}
    const counts = Object.fromEntries(['active','archived','trashed'].map(s=>[s,rows.filter(r=>r.state===s).length]));
    const filtered=rows.filter(r=>(scope==='all'||r.state===scope)&&(!type||r.type===type)&&(!query||r.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()))&&(!platform||r.platforms.includes(platform))&&(!groupId||group&& (r.kind==='video'?db().videoJobs.some(j=>j.packageId===r.id&&group.accountIds.includes(j.account.id)):db().tasks.some(t=>t.contentId===r.id&&t.targets.some(x=>group.accountIds.includes(x.accountId))))));
    return {items:filtered.sort((a,b)=>String(b.at||'').localeCompare(String(a.at||''))),counts};
  }
  return {record,state,requireActive,impact,change,list,cleanupPreview,closeOld,purge};
}
module.exports = {createContentLifecycle};
