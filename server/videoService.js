const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const store = require('./store');
const handoff = require('./videoHandoff.cjs');
const { createYoutubeLifecycle } = require('./adapters/video-release');
const { lastJsonObject } = require('./adapters/skill-publisher');
const { defaultRuntimeAccount } = require('./loginService');
const crypto = require('node:crypto');
const { capability, checkObservedState } = require('./videoDelivery.cjs');
const { createPrivateUploader } = require('./adapters/video-private');
const workbench = require('./videoWorkbench.cjs');
const releaseContract = require('./videoRelease.cjs');
const POLICY = Object.freeze({ timezone: 'Asia/Shanghai', fullDelayHours: 3, itemGapHours: 2 });
const CREATORS = {
  bilibili: 'https://member.bilibili.com/platform/home', douyin: 'https://creator.douyin.com/',
  kuaishou: 'https://cp.kuaishou.com/', xiaohongshu: 'https://creator.xiaohongshu.com/',
  shipinhao: 'https://channels.weixin.qq.com/', toutiao: 'https://mp.toutiao.com/',
  xigua: 'https://studio.ixigua.com/', baijiahao: 'https://baijiahao.baidu.com/',
  zhihu: 'https://www.zhihu.com/creator', weibo: 'https://weibo.com/',
  youtube: 'https://studio.youtube.com/', tiktok_global: 'https://www.tiktok.com/tiktokstudio',
  instagram: 'https://www.instagram.com/', facebook: 'https://business.facebook.com/',
  twitter: 'https://x.com/', linkedin: 'https://www.linkedin.com/', threads: 'https://www.threads.net/', pinterest: 'https://www.pinterest.com/',
};
const PUBLIC_HOSTS = {
  bilibili: ['bilibili.com', 'b23.tv'], douyin: ['douyin.com'], kuaishou: ['kuaishou.com'], xiaohongshu: ['xiaohongshu.com', 'xhslink.com'],
  youtube: ['youtube.com', 'youtu.be'], shipinhao: ['weixin.qq.com'], toutiao: ['toutiao.com'], xigua: ['ixigua.com'],
  baijiahao: ['baidu.com'], zhihu: ['zhihu.com'], weibo: ['weibo.com', 'weibo.cn'], tiktok_global: ['tiktok.com'],
  instagram: ['instagram.com'], facebook: ['facebook.com', 'fb.watch'], twitter: ['x.com', 'twitter.com'], linkedin: ['linkedin.com'], threads: ['threads.net', 'threads.com'], pinterest: ['pinterest.com'],
};
function safeUrl(value, platform) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || !(PUBLIC_HOSTS[platform] || []).some(h => u.hostname === h || u.hostname.endsWith('.' + h))) throw new Error('请输入所选平台的HTTPS作品链接');
  return u.href;
}
function identity(a) { return { id: a.id, name: a.name, platformId: a.platformId, runtimeAccount: a.runtimeAccount || defaultRuntimeAccount(a.platformId) || null }; }
function runCli(args) {
  return new Promise((resolve, reject) => {
    const node = process.env.MEDIAHUB_SKILL_NODE || process.execPath;
    const script = process.env.MEDIAHUB_VIDEO_SCRIPT || '';
    if (!script) return reject(new Error('请先配置 MEDIAHUB_VIDEO_SCRIPT'));
    const child = spawn(node, [script, ...args], { shell: false, windowsHide: true });
    let output = ''; let errors = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('草稿操作超时；远端可能已保存，禁止自动重试')); }, 35 * 60 * 1000);
    child.stdout.on('data', c => { output += c; }); child.stderr.on('data', c => { errors += c; });
    child.once('error', e => { clearTimeout(timeout); reject(e); });
    child.once('close', code => { clearTimeout(timeout); const result = lastJsonObject(output); if (code === 0 && result) resolve(result); else reject(new Error(errors.slice(-800) || '草稿操作未获得确认；请核查平台')); });
  });
}
function createVideoService({ storage = store, clock = () => Date.now(), youtube = createYoutubeLifecycle(), cli = runCli, privateUploader = createPrivateUploader(), browserRelease = null } = {}) {
  let busy = false;
  const db = () => storage.db;
  const lifecycle = require('./contentLifecycle').createContentLifecycle(storage);
  function activeJob(id) { const j=job(id); lifecycle.requireActive('video',j.packageId); return j; }
  function job(id) { const j = db().videoJobs.find(x => x.id === id); if (!j) throw new Error('投递记录不存在'); return j; }
  function pkg(id) { const p = db().videoPackages.find(x => x.id === id); if (!p) throw new Error('成品包不存在'); return p; }
  function unit(j) { const u = pkg(j.packageId).units.find(x => x.unit_id === j.unitId); if (!u) throw new Error('作品不存在'); return u; }
  function account(j) {
    const a = db().accounts.find(x => x.id === j.account.id);
    if (!a || handoff.digest(identity(a)) !== handoff.digest(j.account)) throw new Error('账号身份已改变，需要重新绑定并审核');
    return a;
  }
  function seal(j) { const value = { packageHash: pkg(j.packageId).manifestHash, unitId: j.unitId, account: j.account, remote: j.remote, notBefore: j.notBefore, anchorJobId: j.anchorJobId, mode: j.mode, order: j.order, policy: POLICY }; if (j.releaseAuthorization) value.releaseAuthorization = j.releaseAuthorization; return handoff.digest(value); }
  function groupJobs(j) { return db().videoJobs.filter(x => x.packageId === j.packageId && x.group === j.group && x.language === j.language && x.status !== 'cancelled').sort((a,b) => a.order - b.order); }
  function timing(j) {
    let due = new Date(j.notBefore || 0).getTime(); const u = unit(j);
    if (!j.approval || j.approval.seal !== seal(j)) return { due: null, reason: '等待本作品审核批准' };
    if (u.kind !== 'full') {
      const anchor = db().videoJobs.find(x => x.id === j.anchorJobId);
      if (!anchor?.publicObservedAt || anchor.status !== 'public') return { due: null, reason: '等待完整版真实公开' };
      due = Math.max(due, Date.parse(anchor.publicObservedAt) + POLICY.fullDelayHours * 3600000);
      const previous = groupJobs(j).filter(x => x.order < j.order && unit(x).kind !== 'full');
      if (previous.some(x => x.status !== 'public')) return { due: null, reason: '等待前序切片公开（未批准、异常和人工待办均不跳过）' };
    }
    const publicTimes = groupJobs(j).filter(x => x.id !== j.id && x.publicObservedAt).map(x => Date.parse(x.publicObservedAt));
    if (publicTimes.length) due = Math.max(due, Math.max(...publicTimes) + POLICY.itemGapHours * 3600000);
    return { due: new Date(due).toISOString(), reason: due > clock() ? '等待间隔/指定时间' : j.mode === 'manual' ? '已到时间，需在平台后台发布' : j.mode === 'browser_agent_release' ? '到期，等待浏览器Agent接力（需Codex在线）' : '可自动执行' };
  }
  async function importPackage(manifestPath) {
    const parsed = await handoff.loadHandoff(manifestPath);
    if(db().deletionLedger?.some(x=>x.kind==='video'&&x.packageId===parsed.packageId&&x.revision===parsed.revision)) throw Error('此成品版本已彻底删除；防重账本阻止重新投递，请交付明确的新版本');
    const old = db().videoPackages.find(p => p.packageId === parsed.packageId && p.revision === parsed.revision);
    if (old) { if (old.manifestHash !== parsed.manifestHash) throw new Error('相同包版本的清单已变，请递增版本后导入'); if(lifecycle.state(old)!=='active')throw Error('该版本已归档或在回收站，请从内容库恢复；恢复不会重新执行任务'); return old; }
    const p = { ...parsed, id: storage.nextId(), importedAt: new Date(clock()).toISOString(), policy: { ...POLICY } };
    const previousIds = db().videoPackages.filter(x => x.packageId === p.packageId && x.revision !== p.revision).map(x => x.id);
    for (const j of db().videoJobs) if (previousIds.includes(j.packageId) && !['public','cancelled'].includes(j.status)) {
      j.approval = null;
      if (!['draft_running','delivery_running','release_running','awaiting_public'].includes(j.status)) j.status = 'uncertain';
      j.error = '已导入新成品版本，旧版需重新审阅；平台原生定时请人工撤销';
    }
    db().videoPackages.push(p); storage.save(); return p;
  }
  function bind({ packageId, unitId, platformId, accountId, anchorJobId }) {
    lifecycle.requireActive('video',packageId);
    const p = pkg(packageId); const u = p.units.find(x => x.unit_id === unitId);
    const a = db().accounts.find(x => x.id === accountId);
    if (!u || !a || a.platformId !== platformId || !u.targets.some(t => handoff.platformId(t.platform) === platformId)) throw new Error('作品、平台或账号不匹配');
    if (!CREATORS[platformId]) throw new Error('该平台尚未配置后台入口');
    // Browser-based sessions need a real runtime identity, never infer from display names.
    const runtime = identity(a).runtimeAccount;
    if (['douyin','shipinhao'].includes(platformId) && !runtime) throw new Error('账号缺少运行时会话名，请在账号管理设置对应会话后绑定');
    const key = [p.packageId, p.revision, u.unit_id, u.revision, platformId, runtime || a.id].join('|');
    const existing = db().videoJobs.find(x => x.deliveryKey === key);
    if (existing) return existing;
    let anchor = null;
    if (u.kind !== 'full') {
      const anchors = db().videoJobs.filter(x => x.packageId === p.id && x.unitId === u.release_intent.depends_on_full_unit && x.status !== 'cancelled');
      anchor = anchorJobId ? anchors.find(x => x.id === anchorJobId) : anchors.length === 1 ? anchors[0] : null;
      if (!anchor) throw new Error('请先绑定完整版账号；多账号完整版需明确锚点');
    }
    const j = { id: storage.nextId(), packageId: p.id, unitId, platformId, account: identity(a), deliveryKey: key, anchorJobId: anchor?.id || null, group: u.release_group, language: u.language, order: Math.max(0, ...db().videoJobs.filter(x => x.packageId === p.id).map(x => x.order)) + 1, status: 'prepared', mode: 'manual', createdAt: new Date(clock()).toISOString(), remote: null, approval: null };
    db().videoJobs.push(j); storage.save(); return j;
  }
  function setRemote(id, value) {
    const j = activeJob(id); account(j);
    if (['draft_running', 'delivery_running', 'release_running', 'awaiting_public', 'public', 'cancelled'].includes(j.status)) throw new Error('执行中/已公开/已取消作品不可换绑远端');
    if (!value.id || !['draft', 'private', 'native_scheduled'].includes(value.state)) throw new Error('需要明确的远端作品ID和状态');
    if (j.platformId === 'youtube' && !/^[\w-]{11}$/.test(value.id)) throw new Error('YouTube视频ID必须为11个字符');
    j.remote = { id: String(value.id), url: safeUrl(value.url, j.platformId), state: value.state, recordedAt: new Date(clock()).toISOString() };
    j.status = 'remote_ready'; j.approval = null; j.error = null; storage.save(); return j;
  }
  function reconcile(id, value) {
    const j = activeJob(id); account(j);
    if (['draft_running','delivery_running','release_running','awaiting_public','public','cancelled'].includes(j.status)) throw new Error('当前状态不能登记非公开结果');
    if (value.ownerConfirmed !== true || value.visibilityConfirmed !== true || !String(value.evidence || '').trim() || !String(value.observedAccountId || '').trim()) throw new Error('必须核对作品所属账号、真实可见性并记录证据');
    checkObservedState(value.state, true);
    const url = safeUrl(value.url, j.platformId), extracted = workbench.referenceId(j.platformId, url);
    const remoteId = String(value.id || extracted || '').trim();
    if (!remoteId || !extracted || extracted !== remoteId) throw new Error('需要可解析且与作品ID一致的准确编辑/作品链接，不接受主页或管理列表');
    if (j.remote && j.remote.id !== remoteId) throw new Error('已登记不同作品，不能通过复核替换；请逐条人工核查');
    const at = new Date(clock()).toISOString();
    j.remote = { id: remoteId, url, state: value.state, recordedAt: at };
    j.reconciliations ||= [];
    j.reconciliations.push({ at, previousStatus: j.status, previousError: j.error || null, observedAccountId: String(value.observedAccountId), evidence: String(value.evidence), browserSession: String(value.browserSession || '人工后台核查'), remoteId });
    if (j.delivery?.recheckFailure) j.delivery.recheckFailure.resolvedAt = at;
    j.preview = { warning: String(value.previewWarning || ''), checkedAt: at };
    j.status = value.state === 'private' ? 'private_saved' : 'draft_saved';
    j.error = null; j.approval = null; storage.save(); return j;
  }
  function planBatch({ packageId, accountGroupId, jobIds } = {}) {
    pkg(packageId);
    const group = accountGroupId ? db().accountGroups.find(g => g.id === accountGroupId) : null;
    if (accountGroupId && !group) throw new Error('账号组不存在');
    if (jobIds && (!Array.isArray(jobIds) || !jobIds.length || jobIds.length > 100 || jobIds.some(id => job(id).packageId !== packageId))) throw new Error('批次作品必须属于所选成品包，最多100条');
    const jobs = db().videoJobs.filter(j => j.packageId === packageId && (!group || group.accountIds.includes(j.account.id)) && (!jobIds || jobIds.includes(j.id))).sort((a,b)=>a.order-b.order);
    const items = workbench.batchPlan(jobs, capability);
    for (const item of items) { try { account(job(item.jobId)); } catch (e) { item.disposition = 'skip'; item.reason = e.message; } }
    return { packageId, accountGroupId: accountGroupId || null, items, counts: Object.fromEntries(['ready','browser','manual','skip'].map(s=>[s,items.filter(i=>i.disposition===s).length])) };
  }
  function prepareBatch({ packageId, accountGroupId, selections }) {
    lifecycle.requireActive('video',packageId);
    const p = pkg(packageId), group = db().accountGroups.find(g=>g.id===accountGroupId);
    if (!group || !Array.isArray(selections) || !selections.length || selections.length > 100) throw new Error('请选择账号组和1至100个明确的作品/账号组合');
    const rows = selections.map(r => {
      const u=p.units.find(x=>x.unit_id===r.unitId), a=db().accounts.find(x=>x.id===r.accountId);
      if (!u || !a || !group.accountIds.includes(a.id) || !u.targets.some(t=>handoff.platformId(t.platform)===a.platformId) || !CREATORS[a.platformId]) throw new Error('批次作品/平台/账号组不匹配');
      if (['douyin','shipinhao'].includes(a.platformId) && !identity(a).runtimeAccount) throw new Error('账号缺少运行时会话名');
      return { ...r, u, a };
    }).sort((a,b)=>(a.u.kind==='full'?0:1)-(b.u.kind==='full'?0:1));
    // Validate all dependencies before writing any binding. Multiple full accounts must be disambiguated.
    for (const r of rows.filter(r=>r.u.kind!=='full')) {
      const fullId=r.u.release_intent.depends_on_full_unit;
      const existing=db().videoJobs.filter(j=>j.packageId===p.id&&j.unitId===fullId&&j.status!=='cancelled');
      const selected=rows.filter(x=>x.u.unit_id===fullId);
      const choices=new Set([...existing.map(j=>j.account.id),...selected.map(x=>x.a.id)]);
      if (r.anchorJobId ? !existing.some(j=>j.id===r.anchorJobId) : r.anchorAccountId ? !choices.has(r.anchorAccountId) : choices.size!==1) throw new Error('切片需要唯一完整版锚点；多个完整版账号请在单条绑定中明确锚点');
    }
    const results=[];
    for (const r of rows) {
      let anchorJobId=r.anchorJobId;
      if (r.anchorAccountId) anchorJobId=db().videoJobs.find(j=>j.packageId===p.id&&j.unitId===r.u.release_intent.depends_on_full_unit&&j.account.id===r.anchorAccountId&&j.status!=='cancelled')?.id;
      const j=bind({packageId:p.id,unitId:r.u.unit_id,platformId:r.a.platformId,accountId:r.a.id,anchorJobId});
      results.push(j.id);
    }
    return planBatch({packageId:p.id,accountGroupId,jobIds:[...new Set(results)]});
  }
  async function deliverBatch(value) {
    if (value.confirmed !== true || !Array.isArray(value.jobIds) || !value.jobIds.length) throw new Error('请明确确认本批次首次非公开投递');
    const plan=planBatch(value), results=[];
    for (const item of plan.items) {
      // Re-read just before each side effect: concurrent UI/Agent action may already have claimed it.
      const fresh=planBatch({...value,jobIds:[item.jobId]}).items[0];
      if (!fresh) { results.push({...item,disposition:'skip',reason:'账号组范围已变化，请刷新核查'}); continue; }
      if (fresh.disposition !== 'ready') { results.push(fresh); continue; }
      try { const j=await deliverNonPublic(item.jobId,{allowPrivate:value.allowPrivate===true}); results.push({...fresh,disposition:'saved',status:j.status}); }
      catch(e) { results.push({...fresh,disposition:'error',status:job(item.jobId).status,reason:e.message}); }
    }
    return { ...plan, results };
  }
  async function approve(id, { reviewed, rightsConfirmed, declarationsConfirmed, notBefore, mode = 'manual', releaseOptions }) {
    const j = activeJob(id); account(j);
    if (!['remote_ready','draft_saved','private_saved'].includes(j.status) || !j.remote) throw new Error('先在平台后台检查准确作品，再登记远端引用');
    const priorStatus = j.status;
    const priorSeal = seal(j);
    if (reviewed !== true || rightsConfirmed !== true || declarationsConfirmed !== true) throw new Error('需要确认完整审阅、素材权利及平台声明');
    if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(notBefore || '') || !Number.isFinite(Date.parse(notBefore))) throw new Error('排期必须包含明确时区');
    if (!['manual', 'youtube_api', 'browser_auto'].includes(mode) || (mode === 'youtube_api' && (j.platformId !== 'youtube' || j.remote.state !== 'private'))) throw new Error('该作品没有经过接入的自动公开通道，使用人工/原生定时跟踪');
    let browserObservation;
    if (mode === 'browser_auto') {
      if (!browserRelease?.ready?.(account(j), j) || j.remote.state !== 'private') throw Error('常驻自动发布会话/适配器尚未验证，不能启用');
      browserObservation = releaseContract.validateObservation(j, await browserRelease.inspect(account(j), j));
      if (browserObservation.state !== 'private' || !browserObservation.contentFingerprint) throw Error('需要准确私密作品及审阅内容指纹');
    }
    await handoff.verifyAssets(pkg(j.packageId), unit(j));
    if (mode === 'youtube_api') { const remote = await youtube.inspect(account(j), j.remote); if (remote.state !== 'private' || remote.video.status.publishAt) throw new Error('仅支持未设置原生定时的私享视频'); }
    if (j.status !== priorStatus || seal(j) !== priorSeal) throw new Error('作品状态已改变，请刷新后重新审核');
    j.notBefore = new Date(notBefore).toISOString(); j.mode = mode;
    if (mode === 'browser_auto') j.releaseAuthorization = {kind:'resident', at:new Date(clock()).toISOString(), observedAccountId:browserObservation.observedAccountId, contentFingerprint:browserObservation.contentFingerprint, settings:releaseContract.settings(releaseOptions)};
    else delete j.releaseAuthorization;
    j.approval = { approvedAt: new Date(clock()).toISOString(), reviewed: true, rightsConfirmed: true, declarationsConfirmed: true, seal: seal(j) };
    j.status = 'approved'; storage.save(); return j;
  }
  function cancel(id) {
    const j = job(id);
    if (['draft_running', 'delivery_running', 'release_running', 'awaiting_public', 'public','uncertain'].includes(j.status) || j.remote?.state==='native_scheduled') throw new Error('远端操作执行中、结果待核查或平台原生定时，需先检查平台；不能以本地取消保证撤回');
    j.status = 'cancelled'; j.approval = null; storage.save(); return j;
  }
  function markPublic(id, { url, confirmed, publishedAt }) {
    const j = job(id); account(j);
    if (j.status==='release_running') throw Error('公开执行锁持有中，请用执行结果接口回写');
    if (confirmed !== true || !j.remote || j.status === 'cancelled') throw new Error('需要核对本账号准确作品确已公开');
    const publicUrl = safeUrl(url, j.platformId);
    if (!publishedAt || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(publishedAt) || !Number.isFinite(Date.parse(publishedAt)) || Date.parse(publishedAt) > clock()) throw new Error('公开时间必须带时区且不在未来');
    j.publicObservedAt ||= new Date(clock()).toISOString(); // Never backdate or reset spacing on repeated confirmation.
    j.reportedPublishedAt = new Date(publishedAt).toISOString(); j.publicUrl = publicUrl;
    j.publicEvidence = { type: 'human_confirmed', remoteId: j.remote.id, accountId: j.account.id };
    j.status = 'public'; storage.save(); return j;
  }
  // Explicit grant for a reviewed manual job; never silently upgrades old schedules.
  function authorizeAgentRelease(id, value) {
    const j = activeJob(id); account(j);
    if (!releaseContract.PLATFORMS.has(j.platformId) || j.mode!=='manual' || !['approved','manual_due'].includes(j.status) || j.remote?.state !== 'private' || j.approval?.seal !== seal(j)) throw Error('需要已审阅、审批仍有效的准确私密人工跟踪作品；不能覆盖已有自动执行器');
    if (value.confirmed !== true || !String(value.authorization || '').trim() || !String(value.observedAccountId || '').trim()) throw Error('需要本作品明确公开授权和已核实账号');
    const prior = {mode:j.mode, approval:structuredClone(j.approval)};
    j.releaseAuthorization = {kind:'agent', at:new Date(clock()).toISOString(), authorization:String(value.authorization), observedAccountId:String(value.observedAccountId), contentFingerprint:value.contentFingerprint || null, settings:releaseContract.settings(value.settings)};
    j.mode = 'browser_agent_release'; j.status = 'approved';
    j.approval = {...j.approval, seal:seal(j)};
    j.releaseHistory ||= []; j.releaseHistory.push({at:new Date(clock()).toISOString(), type:'explicit_public_grant', previous:prior});
    storage.save(); return j;
  }
  async function beginBrowserRelease(id, value) {
    const j = activeJob(id); account(j);
    if (!['approved','agent_due'].includes(j.status) || j.mode !== 'browser_agent_release' || j.releaseAuthorization?.kind !== 'agent') throw Error('缺少有效单作品浏览器公开授权，或已有公开操作');
    const priorSeal = seal(j), t = timing(j);
    if (!t.due || Date.parse(t.due) > clock()) throw Error('尚未到期或等待前序实际公开，禁止提前发布');
    const observation = releaseContract.validateObservation(j, value, {expectedOwner:j.releaseAuthorization.observedAccountId});
    if (observation.state === 'public') throw Error('作品已经公开，请只读登记，不要再次提交');
    if (observation.state !== 'private') throw Error('审核/处理尚未结束，仅允许只读核查');
    if (j.releaseAuthorization.contentFingerprint && observation.contentFingerprint !== j.releaseAuthorization.contentFingerprint) throw Error('审阅后内容已变，需要重新审阅');
    await handoff.verifyAssets(pkg(j.packageId), unit(j));
    if (!['approved','agent_due'].includes(j.status) || seal(j) !== priorSeal || j.approval?.seal !== priorSeal) throw Error('审批或任务状态已经变化');
    j.release = {route:'browser_agent', leaseId:releaseContract.lease(), stage:'claimed', startedAt:new Date(clock()).toISOString(), seal:priorSeal, before:observation};
    j.status='release_running'; storage.save();
    return {jobId:j.id, leaseId:j.release.leaseId, remote:structuredClone(j.remote), account:structuredClone(j.account), policy:POLICY, settings:j.releaseAuthorization.settings};
  }
  function submittingBrowserRelease(id, value) {
    const j=activeJob(id); account(j);
    if (j.status !== 'release_running' || !j.release?.leaseId || j.release.leaseId !== value.leaseId || j.release.stage !== 'claimed' || j.release.seal !== seal(j) || j.approval?.seal !== seal(j)) throw Error('公开执行锁/审批无效，禁止提交');
    const t=timing(j); if (!t.due || Date.parse(t.due)>clock()) throw Error('间隔条件变化，禁止提交');
    j.release.stage='submitted'; j.release.submittedAt=new Date(clock()).toISOString(); storage.save(); return {jobId:id, stage:'submitted'};
  }
  function recordBrowserPublic(j, observation, value) {
    const url=safeUrl(value.url,j.platformId);
    // A precise public/editor reference must agree with the already-approved work.
    if (workbench.referenceId(j.platformId,url) !== j.remote.id) throw Error('公开证据链接与准确作品ID不一致');
    j.publicObservedAt ||= new Date(clock()).toISOString(); j.publicUrl=url; j.status='public'; j.error=null;
    j.publicEvidence={type:j.mode==='browser_auto'?'browser_auto':'browser_agent', ...observation, verifiedAt:new Date(clock()).toISOString(), accountId:j.account.id};
    if (j.release) {delete j.release.leaseId; j.release.stage='verified_public';}
    storage.save(); return j;
  }
  function finishBrowserRelease(id, value) {
    const j=job(id); account(j);
    if (j.status!=='release_running' || !j.release?.leaseId || j.release.leaseId!==value.leaseId || j.release.stage!=='submitted') throw Error('公开执行凭据无效或尚未登记提交');
    const observation=releaseContract.validateObservation(j,value,{expectedOwner:j.releaseAuthorization.observedAccountId});
    if (observation.state==='public') return recordBrowserPublic(j,observation,value);
    if (observation.state!=='pending_review') throw Error('提交后仍私密或结果不明，停止并核查，不可重复提交');
    j.status='awaiting_public'; j.release.after=observation; delete j.release.leaseId; storage.save(); return j;
  }
  function observeBrowserPublic(id, value) {
    const j=job(id); account(j);
    if (!['browser_agent_release','browser_auto'].includes(j.mode) || !j.releaseAuthorization || !['approved','agent_due','awaiting_public','uncertain','public'].includes(j.status)) throw Error('此任务没有可回查的公开授权');
    const observation=releaseContract.validateObservation(j,value,{expectedOwner:j.releaseAuthorization.observedAccountId,requirePublic:true});
    return recordBrowserPublic(j,observation,value);
  }
  function blockBrowserRelease(id, value) {
    const j=job(id);
    if (j.status!=='release_running' || !j.release?.leaseId || value.leaseId!==j.release.leaseId || !String(value.reason || '').trim()) throw Error('公开执行凭据或具体阻塞原因无效');
    j.status='uncertain'; j.error=String(value.reason); delete j.release.leaseId; storage.save(); return j;
  }
  async function inspect(id) {
    const j = job(id);
    if (j.platformId !== 'youtube' || !j.remote || j.status === 'cancelled') throw new Error('此平台暂需人工核对公开状态');
    const result = await youtube.inspect(account(j), j.remote);
    if (result.state === 'public') {
      j.publicObservedAt ||= new Date(clock()).toISOString(); j.status = 'public'; j.publicUrl = result.url;
      j.publicEvidence = { type: 'youtube_api', remoteId: j.remote.id, accountId: j.account.id };
      storage.save();
    }
    return { state: result.state, job: j };
  }
  async function uploadDraft(id) {
    activeJob(id);
    const j = job(id); const a = account(j);
    if (j.status !== 'prepared') throw new Error('只允许首次保存草稿；不确定结果不可重试');
    if (capability(j.platformId).route !== 'draft_cli' || !capability(j.platformId).available) throw new Error('此平台的自动草稿通道未验证或已停用，请先核查已有结果，使用浏览器协助；未上传');
    await handoff.verifyAssets(pkg(j.packageId), unit(j));
    if (j.status !== 'prepared') throw new Error('已有操作正在进行');
    const platform = j.platformId === 'shipinhao' ? 'tencent' : j.platformId;
    j.status = 'draft_running'; storage.save();
    try {
      const config = process.env.MEDIAHUB_VIDEO_CONFIG || '';
      if (!config) throw new Error('请先配置 MEDIAHUB_VIDEO_CONFIG');
      const runRoot = path.join(storage.DATA_DIR, 'video-runs');
      const prepared = await cli(['prepare-handoff', '--manifest', pkg(j.packageId).manifestPath, '--unit', j.unitId, '--platform', platform, '--account', j.account.runtimeAccount, '--run-root', runRoot, '--config', config]);
      j.runDirectory = prepared.runDirectory; storage.save();
      const preflight = await cli(['preflight', '--run-dir', j.runDirectory, '--platforms', platform, '--config', config]);
      if (!preflight.ok) throw new Error('账号预检未通过，请登录后人工核查');
      const result = await cli(['publish', '--run-dir', j.runDirectory, '--platforms', platform, '--config', config]);
      if (result.results?.[platform]?.status !== 'success') throw new Error('未获得真实草稿保存证据');
      j.status = 'draft_saved'; j.draftEvidence = result.results[platform]; storage.save(); return j;
    } catch (e) { j.status = 'uncertain'; j.error = e.message; storage.save(); throw e; }
  }
  async function deliverNonPublic(id, { allowPrivate = false } = {}) {
    activeJob(id);
    const j = job(id), cap = capability(j.platformId);
    if (cap.route === 'draft_cli') return uploadDraft(id);
    if (j.status !== 'prepared') throw new Error('只允许首次投递；已保存或不确定结果不可重传');
    if (cap.route !== 'youtube_private') throw new Error('此平台需浏览器Agent实际核查；尚无已验证的自动上传器');
    if (allowPrivate !== true) throw new Error('YouTube使用私享上传，需明确授权本次私密发布');
    account(j); await handoff.verifyAssets(pkg(j.packageId), unit(j));
    if (privateUploader.preflight) await privateUploader.preflight(account(j));
    if (j.status !== 'prepared') throw new Error('已有投递正在执行');
    j.status = 'delivery_running'; j.delivery = { allowPrivate: true, route: cap.route, startedAt: new Date(clock()).toISOString() }; storage.save();
    try {
      const evidence = await privateUploader(account(j), unit(j), { onUploaded: async remoteId => { j.delivery.candidateRemoteId = remoteId; storage.save(); } });
      checkObservedState(evidence.state, true);
      if (!evidence.id || evidence.state !== 'private') throw new Error('未确认准确私享作品，停止');
      j.remote = { id: evidence.id, url: safeUrl(evidence.url, j.platformId), state: 'private', recordedAt: new Date(clock()).toISOString() };
      j.status = 'private_saved'; j.delivery.evidence = evidence; j.approval = null; storage.save(); return j;
    } catch (e) { j.status = 'uncertain'; j.error = e.message; storage.save(); throw e; }
  }
  async function beginBrowserDelivery(id, { allowPrivate = false, recovery = null } = {}) {
    activeJob(id);
    const j = job(id); account(j);
    const priorStatus = j.status, priorError = j.error;
    // A scoped human recovery decision is distinct from an automatic retry.
    // Only the legacy Douyin local-stage failure without a known remote work qualifies.
    const recovering = j.status === 'uncertain' && j.platformId === 'douyin' &&
      j.delivery?.route === 'draft_cli' && j.draftEvidence?.status === 'success' &&
      j.delivery?.recheckFailure && !j.remote && !j.delivery?.candidateRemoteId &&
      allowPrivate === true && recovery?.confirmed === true && recovery.privateOnly === true &&
      recovery.ownerConfirmed === true && recovery.priorWorkChecked === true &&
      recovery.previousError === priorError && recovery.observedAccountId &&
      recovery.evidence && recovery.authorization;
    if (j.status !== 'prepared' && !recovering) throw new Error('只允许首次浏览器投递或已核查、明确授权的抖音旧暂存恢复；禁止自动重传');
    if (capability(j.platformId).route !== 'browser_agent') throw new Error('该平台不是浏览器协助通道');
    await handoff.verifyAssets(pkg(j.packageId), unit(j));
    if (j.status !== priorStatus || j.error !== priorError) throw new Error('已有投递正在执行或原状态已改变');
    if (recovering) {
      j.deliveryHistory ||= [];
      j.deliveryHistory.push({ at: new Date(clock()).toISOString(), status: priorStatus,
        error: priorError, draftEvidence: structuredClone(j.draftEvidence), delivery: structuredClone(j.delivery),
        decision: { type: 'authorized_legacy_douyin_private_recovery', observedAccountId: String(recovery.observedAccountId),
          evidence: String(recovery.evidence), authorization: String(recovery.authorization), privateOnly: true } });
    }
    j.status = 'delivery_running';
    j.approval = null;
    j.delivery = { route: 'browser_agent', allowPrivate: allowPrivate === true, privateOnly: Boolean(recovering), leaseId: crypto.randomUUID(), startedAt: new Date(clock()).toISOString() }; storage.save();
    return { jobId: j.id, leaseId: j.delivery.leaseId, account: j.account, creatorUrl: CREATORS[j.platformId], unit: unit(j), allowPrivate: j.delivery.allowPrivate, instruction: '先核对实际账号与已有草稿；优先草稿，只在allowPrivate=true且提交前后均确认仅自己可见时私密发布。遇到登录、验证码、协议或声明停下请用户操作。不确定不得重试。' };
  }
  function finishBrowserDelivery(id, { leaseId, state, observedAccountId, videoSha256, remoteId, url, evidence, browserSession, warnings = [] }) {
    const j = job(id); account(j);
    if (j.status !== 'delivery_running' || j.delivery?.route !== 'browser_agent' || j.delivery.leaseId !== leaseId) throw new Error('浏览器投递凭据无效或任务不在执行中');
    checkObservedState(state, j.delivery.allowPrivate);
    if (j.delivery.privateOnly && state !== 'private') throw new Error('本次恢复仅允许仅自己可见，不可登记为其他状态');
    if (!observedAccountId || videoSha256 !== unit(j).artifacts.video.sha256 || !evidence || !browserSession) throw new Error('缺少实际账号、素材哈希、重新打开确认或浏览器会话证据');
    if (state === 'private' && (!remoteId || !url)) throw new Error('私密发布必须有准确作品引用及仅自己可见证据');
    if ((remoteId && !url) || (url && !remoteId)) throw new Error('作品ID与准确链接必须同时登记');
    j.remote = remoteId ? { id: String(remoteId), url: safeUrl(url, j.platformId), state, recordedAt: new Date(clock()).toISOString() } : null;
    j.delivery.evidence = { state, observedAccountId: String(observedAccountId), videoSha256, evidence, browserSession, warnings, verifiedAt: new Date(clock()).toISOString() };
    delete j.delivery.leaseId; j.status = state === 'private' ? 'private_saved' : 'draft_saved'; j.approval = null; j.error = null; storage.save(); return j;
  }
  function blockBrowserDelivery(id, { leaseId, reason, invalidateSavedEvidence = false }) {
    const j = job(id);
    const activeLease = j.status === 'delivery_running' && j.delivery?.leaseId && j.delivery.leaseId === leaseId;
    const failedRecheck = invalidateSavedEvidence === true && !leaseId && reason &&
      (['draft_saved', 'private_saved'].includes(j.status) && j.delivery?.route === 'browser_agent' ||
       j.status === 'draft_saved' && ['douyin', 'shipinhao'].includes(j.platformId) && j.draftEvidence?.status === 'success');
    if (!activeLease && !failedRecheck) throw new Error('浏览器投递凭据无效；已保存结果仅可明确报告复核失败，不能解锁重传');
    if (failedRecheck) {
      j.delivery ||= { route: 'draft_cli' };
      j.delivery.recheckFailure = { reason: String(reason), at: new Date(clock()).toISOString(), previousStatus: j.status };
    }
    // Keep uncertain even for a blocked upload; do not silently unlock for retries.
    j.status = 'uncertain'; j.approval = null; j.error = String(reason || '浏览器投递中断，先核查平台再处理'); delete j.delivery.leaseId; storage.save(); return j;
  }
  async function tick() {
    if (busy) return; busy = true;
    try {
      for (const j of db().videoJobs) {
        if (lifecycle.state(pkg(j.packageId))!=='active') continue;
        if (j.status === 'awaiting_public' && j.platformId === 'youtube') { try { await inspect(j.id); } catch (e) { j.error = e.message; storage.save(); } }
        if (j.status === 'awaiting_public' && j.mode==='browser_auto' && browserRelease) { try { const result=await browserRelease.inspect(account(j),j); const observed=releaseContract.validateObservation(j,result,{expectedOwner:j.releaseAuthorization.observedAccountId}); if(observed.state==='public') recordBrowserPublic(j,observed,result); } catch(e) {j.error=e.message;storage.save();} }
        if (!['approved', 'manual_due'].includes(j.status)) continue;
        const t = timing(j); if (!t.due || Date.parse(t.due) > clock()) continue;
        try { account(j); } catch (e) { j.status = 'uncertain'; j.error = e.message; storage.save(); continue; }
        if (j.mode === 'manual') { j.status = 'manual_due'; storage.save(); continue; }
        if (j.mode === 'browser_agent_release') { j.status='agent_due'; storage.save(); continue; }
        j.status = 'release_running'; storage.save(); // Persist before the irreversible external side effect.
        try {
          await handoff.verifyAssets(pkg(j.packageId), unit(j));
          let result;
          if (j.mode==='browser_auto') {
            if (!browserRelease?.ready?.(account(j),j)) throw Error('常驻发布会话/通道未就绪');
            const inspected=await browserRelease.inspect(account(j),j);
            const before=releaseContract.validateObservation(j,inspected,{expectedOwner:j.releaseAuthorization.observedAccountId});
            if (before.state==='public') {recordBrowserPublic(j,before,inspected);continue;}
            if (before.state!=='private' || before.contentFingerprint!==j.releaseAuthorization.contentFingerprint) throw Error('作品不是已批准的私密内容，需要重新核查');
            if (j.approval?.seal!==seal(j)) throw Error('审批失效，禁止提交');
            const t=timing(j);if(!t.due || Date.parse(t.due)>clock())throw Error('间隔条件已变，禁止提交');
            j.release={route:'browser_auto',stage:'submitted',startedAt:new Date(clock()).toISOString(),before};storage.save();
            result=await browserRelease.release(account(j),j);
            const observation=releaseContract.validateObservation(j,result,{expectedOwner:j.releaseAuthorization.observedAccountId});
            if(observation.state==='public'){recordBrowserPublic(j,observation,result);continue;}
            if(observation.state!=='pending_review')throw Error('提交后结果未知，禁止重试');
          } else {
            if (j.mode!=='youtube_api') throw Error('未知公开通道，禁止降级');
            result = await youtube.release(account(j), j.remote);
          }
          if (result.state === 'public') { j.publicObservedAt = new Date(clock()).toISOString(); j.status = 'public'; j.publicUrl = result.url; j.publicEvidence = { type: 'youtube_api', remoteId: j.remote.id, accountId: j.account.id }; }
          else j.status = 'awaiting_public';
        } catch (e) { j.status = 'uncertain'; j.error = e.message; }
        storage.save();
      }
    } finally { busy = false; }
  }
  function recover() { for (const j of db().videoJobs) if (['draft_running', 'delivery_running', 'release_running'].includes(j.status)) { j.status = 'uncertain'; j.error = '进程中断，先检查远端结果；禁止自动重试'; } storage.save(); }
  function adoptPublicAttempt(id,value) {
    const j=job(id); account(j);
    if (['draft_running','delivery_running','release_running','awaiting_public','uncertain','public'].includes(j.status)) throw Error('当前任务不可替换投稿结果，需先核查已有执行');
    if (!j.remote || value.previousRemoteId!==j.remote.id || value.confirmed!==true || !String(value.authorization||'').trim() || !String(value.evidenceSource||'').trim()) throw Error('需要准确旧作品、独立重新投稿授权及证据来源');
    const url=safeUrl(value.url,j.platformId);
    if (!value.remoteId || value.remoteId===j.remote.id || workbench.referenceId(j.platformId,url)!==value.remoteId) throw Error('新投稿ID和准确作品链接必须匹配且不同于旧作品');
    if (!value.observedAt || !Number.isFinite(Date.parse(value.observedAt)) || Date.parse(value.observedAt)>clock()) throw Error('核验时间无效或在未来');
    const expectedOwner=j.releaseAuthorization?.observedAccountId||null;
    const observation=releaseContract.validateObservation({...j,remote:{id:value.remoteId}},value,{requirePublic:true,expectedOwner});
    const at=new Date(clock()).toISOString();
    j.attempts ||= [];
    j.attempts.push({id:storage.nextId(),remote:structuredClone(j.remote),status:'retained',previousTaskStatus:j.status,evidence:j.publicEvidence||j.reconciliations?.at(-1)||j.delivery?.evidence||null,retainedAt:at});
    const adopted={id:storage.nextId(),remote:{id:value.remoteId,url,state:'public'},status:'public',authorization:String(value.authorization),observation,observedAt:new Date(value.observedAt).toISOString(),evidenceSource:String(value.evidenceSource),adoptedAt:at};
    j.attempts.push(adopted); j.activeAttemptId=adopted.id;
    j.remote=adopted.remote;j.publicUrl=url;j.publicObservedAt=adopted.observedAt;
    j.publicEvidence={type:'adopted_verified_attempt',...observation,evidenceSource:adopted.evidenceSource,verifiedAt:adopted.observedAt,accountId:j.account.id};
    j.approval=null;j.releaseAuthorization=null;j.release=null;j.status='public';j.error=null;
    storage.save();return j;
  }
  function snapshot() { return { policy: POLICY, releaseSettings:releaseContract.POLICY, creators: CREATORS, deliveryCapabilities: Object.fromEntries(Object.keys(CREATORS).map(p => [p, capability(p)])), packages: db().videoPackages, jobs: db().videoJobs.map(j => { const value = { ...j, autoReleaseReady:Boolean(browserRelease?.ready?.(db().accounts.find(a=>a.id===j.account.id),j)), workbench: workbench.project(j, CREATORS), timing: j.status === 'public' ? { due: null, reason: '已确认公开' } : timing(j) }; if (value.delivery) { value.delivery = { ...value.delivery }; delete value.delivery.leaseId; } if(value.release){value.release={...value.release};delete value.release.leaseId;} return value; }), accounts: db().accounts.map(identity), accountGroups: db().accountGroups }; }
  return { importPackage, bind, setRemote, reconcile, planBatch, prepareBatch, deliverBatch, approve, cancel, markPublic, inspect, uploadDraft, deliverNonPublic, beginBrowserDelivery, finishBrowserDelivery, blockBrowserDelivery, authorizeAgentRelease, beginBrowserRelease, submittingBrowserRelease, finishBrowserRelease, observeBrowserPublic, blockBrowserRelease, adoptPublicAttempt, tick, recover, snapshot, timing, pkg, job };
}
module.exports = { createVideoService, POLICY, CREATORS, safeUrl };
