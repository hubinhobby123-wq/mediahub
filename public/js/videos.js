let videoPackageId = null;
let videoUnitId = null;
let videoWorkFilter = 'all';
let videoBatchGroup = '';
let videoDetailsOpen = false;
let videoSelectedJobId = null;
const videoKindLabel = kind => ({full:'完整版',clip:'切片',platform_variant:'完整适配版'}[kind] || kind);
const videoStatus = { prepared: '待投递', draft_running: '保存草稿中', delivery_running: '非公开投递中，请勿重传', draft_saved: '草稿已保存，待核查作品', private_saved: '仅自己可见已保存，尚未公开', remote_ready: '待审核批准', approved: '已批准，等待排期', manual_due: '已到点，需后台发布', agent_due: '已到点，等待浏览器Agent接力', release_running: '公开操作中，请勿重复操作', awaiting_public: '已提交，等待平台审核/公开确认', public: '已确认公开', uncertain: '结果不确定，需核查', cancelled: '已取消' };
const videoReleaseLabel = j => j.status==='public' ? '已公开，保留原记录（不重复发布）' : j.mode==='browser_agent_release' ? '浏览器Agent定时接力（依赖Codex在线，不是MediaHub常驻执行）' : j.mode==='browser_auto' ? 'MediaHub常驻自动公开（须已验证账号会话和适配器）' : j.mode==='youtube_api' ? 'YouTube API 自动公开' : '人工/原生定时跟踪（到点需后台操作）';
const beijingTime = iso => iso ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)) : '尚不能计算';
function beijingInputNow() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0,16); }
async function videoAction(fn) { try { await fn(); } catch(e) { toast(e.message, 'err'); } }
async function renderVideos() {
  const data = await API.get('/api/videos');
  const activePackages=data.packages.filter(x=>(x.lifecycle?.state||'active')==='active');
  const p = data.packages.find(x => x.id === videoPackageId) || activePackages.at(-1);
  const readonly=p&&(p.lifecycle?.state||'active')!=='active';
  videoPackageId = p?.id;
  const u = p?.units.find(x => x.unit_id === videoUnitId) || p?.units[0];
  videoUnitId = u?.unit_id;
  $('#app').innerHTML = `<div class="page-head"><div><h1>发布中心</h1><p class="muted">北京时间 · 完整版确认公开后 ≥3小时 · 此后每条 ≥2小时 · 国内/海外独立</p></div><div><button class="btn" id="video-refresh">刷新状态</button> <button class="btn" id="video-import">导入视频成品包</button></div></div>
    ${workspaceTabs('video')}
    <div class="video-notice">审阅所选账号的作品与设置 → 批准发布计划 → 查看排期与实际公开结果。${readonly?'此内容已归档或在回收站，当前只读。':'自动能力未验收的平台会明确显示人工处理。'}</div>
    <details><summary>非公开投递能力（已接通与待验证分开）</summary>${Object.entries(data.deliveryCapabilities||{}).map(([id,c])=>`<p>${esc(id)}：${esc(c.label)} · ${esc(c.verification)} — ${esc(c.note)}</p>`).join('')}</details>
    ${p ? `<label class="field">成品包<select id="video-package">${[...activePackages,...readonly?[p]:[]].map(x => `<option value="${esc(x.id)}" ${x.id===p.id?'selected':''}>${esc(x.title)} · ${esc(x.revision)}</option>`).join('')}</select></label>
      <section id="video-workbench" class="video-workbench" aria-label="视频审阅工作台"></section>
      <div class="video-board ${videoDetailsOpen?'open':''}" role="region" aria-label="作品审阅详情"><aside class="video-list"><button class="btn" id="video-close-detail">收起详情</button>${p.units.map(x => `<button class="video-unit ${x.unit_id===u.unit_id?'selected':''}" data-unit="${esc(x.unit_id)}"><span>${esc(videoKindLabel(x.kind))} · ${esc(x.release_group)} · ${esc(x.language)}</span><strong>${esc(x.copy.title)}</strong><small>${x.targets.map(t => esc(t.platform+'/'+t.surface)).join('、')} · ${Number(x.media?.duration || 0).toFixed(1)}秒</small></button>`).join('')}</aside><section class="video-detail" id="video-detail"></section></div>
      <details class="video-coverage"><summary>其他平台覆盖情况（未制作/延期不会自动分发）</summary>${p.coverage.filter(x=>x.status!=='local_output').map(x=>`<p>${esc(x.platform+'/'+x.surface)}：${esc(x.status)} — ${esc(x.reason)}</p>`).join('')}</details>` : '<div class="empty"><b>尚未导入视频成品包</b><p>选择索引指向的 video-handoff.json，不要选择单个视频或英文配音测试索引。</p></div>'}`;
  $('#video-refresh').onclick = () => videoAction(renderVideos);
  $('#video-import').onclick = () => {
    const m = openModal({ title: '导入视频成品包（不上传）', body: '<label class="field">video-handoff.json 的绝对路径<input id="video-manifest" placeholder="E:\\\\example\\\\delivery\\video-handoff.json"></label><p class="muted">读取平台专版并校验所有素材；不复制大视频、不修改剪辑文件。</p>', footer: '<button class="btn" data-close>取消</button><button class="btn primary" id="video-do-import">校验并导入</button>' });
    $('#video-do-import',m.el).onclick = () => videoAction(async () => { const b=$('#video-do-import',m.el); b.disabled=true; try { const result=await API.post('/api/videos/import',{manifestPath:$('#video-manifest',m.el).value.trim()}); videoPackageId=result.id;videoUnitId=null;m.close();await renderVideos();toast('已导入，尚未上传或授权公开'); } finally { b.disabled=false; } });
  };
  if (!p) return;
  renderVideoWorkbench(data,p);
  $('#video-open-detail').onclick=()=>{videoDetailsOpen=true;videoSelectedJobId=null;videoAction(renderVideos);};
  $('#video-package').onchange = e => {videoPackageId=e.target.value;videoUnitId=null;videoDetailsOpen=false;videoSelectedJobId=null;videoAction(renderVideos);};
  $('#video-close-detail').onclick=()=>{videoDetailsOpen=false;videoAction(renderVideos);};
  $$('[data-unit]').forEach(b => {b.onclick=()=>{videoUnitId=b.dataset.unit;videoSelectedJobId=null;videoAction(renderVideos);};});
  const jobs = data.jobs.filter(j=>j.packageId===p.id&&j.unitId===u.unit_id&&(!videoSelectedJobId||j.id===videoSelectedJobId));
  const asset = kind=>`/api/videos/packages/${encodeURIComponent(p.id)}/units/${encodeURIComponent(u.unit_id)}/artifacts/${kind}`;
  $('#video-detail').innerHTML = `<h2>${esc(u.copy.title)}</h2><div class="video-preview"><video controls preload="metadata" src="${asset('video')}" poster="${asset('cover')}"></video><img alt="平台专版封面" src="${asset('cover')}"></div>
    <div class="video-copy"><p>${esc(u.copy.description).replace(/\n/g,'<br>')}</p><p>${u.copy.tags.map(t=>esc('#'+t)).join(' ')}</p><button class="btn" id="video-copy-text">复制发布文案</button> <button class="btn" id="video-copy-paths">复制素材路径</button></div>
    <details><summary>素材与审核注意事项（含人工验收及权利）</summary><p>完整人工观看：${esc(u.qc?.human_full_playback||'未记录')}</p>${[...(u.qc?.unresolved||[]),...(u.rights_notes||[]),...(u.declaration_notes||[])].map(n=>`<p>${esc(n)}</p>`).join('')}<pre>${esc(Object.entries(u.artifacts).map(([k,a])=>k+': '+a.absolutePath).join('\n'))}</pre></details>
    <h3>选择投递账号</h3><div class="video-bind"><select id="video-group"><option value="">全部账号组</option>${data.accountGroups.map(g=>`<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}</select><select id="video-account"></select>${u.kind!=='full'?`<select id="video-anchor" aria-label="完整版锚点账号"><option value="">请选择完整版锚点</option>${data.jobs.filter(j=>j.packageId===p.id&&j.unitId===u.release_intent.depends_on_full_unit&&j.status!=='cancelled').map(j=>`<option value="${esc(j.id)}" ${data.jobs.filter(x=>x.packageId===p.id&&x.unitId===u.release_intent.depends_on_full_unit&&x.status!=='cancelled').length===1?'selected':''}>完整版：${esc(j.platformId)} / ${esc(j.account.name)}</option>`).join('')}</select>`:''}<button class="btn primary" id="video-bind">绑定本作品</button></div><p class="muted">绑定不等于上传；同一平台可逐条绑定切片。一个作品可绑定多个真实账号。</p><div id="video-jobs"></div>`;
  const platforms = u.targets.map(t=>({wechat_channels:'shipinhao',tencent:'shipinhao',tiktok:'tiktok_global',x:'twitter'}[t.platform]||t.platform));
  const refreshAccounts=()=>{ const g=data.accountGroups.find(x=>x.id===$('#video-group').value); const accounts=data.accounts.filter(a=>platforms.includes(a.platformId)&&(!g||g.accountIds.includes(a.id))); $('#video-account').innerHTML='<option value="">请选择具体平台账号</option>'+accounts.map(a=>`<option value="${esc(a.id)}">${esc(a.platformId)} · ${esc(a.name)} · 会话 ${esc(a.runtimeAccount||'OAuth')}</option>`).join(''); };
  refreshAccounts();$('#video-group').onchange=refreshAccounts;
  $('#video-bind').onclick=()=>videoAction(async()=>{const a=data.accounts.find(x=>x.id===$('#video-account').value);if(!a)throw Error('请选择账号');if(u.kind!=='full'&&!$('#video-anchor').value)throw Error('请选择完整版锚点');await API.post('/api/videos/bind',{packageId:p.id,unitId:u.unit_id,platformId:a.platformId,accountId:a.id,anchorJobId:$('#video-anchor')?.value});await renderVideos();toast('已绑定，尚未上传');});
  $('#video-copy-text').onclick=()=>videoAction(async()=>{await copyText(u.copy.title+'\n\n'+u.copy.description+'\n\n'+u.copy.tags.map(t=>'#'+t).join(' '));toast('发布文案已复制');});
  $('#video-copy-paths').onclick=()=>videoAction(async()=>{await copyText(Object.entries(u.artifacts).map(([k,a])=>k+': '+a.absolutePath).join('\n'));toast('素材路径已复制');});
  $('#video-jobs').innerHTML=jobs.map(j=>`<article class="video-job"><h3>${esc(j.platformId)} · ${esc(j.account.name)} <span>${esc(videoStatus[j.status]||j.status)}</span></h3><p>${esc(j.timing.reason)} · 最早：${esc(beijingTime(j.timing.due))}</p>${j.error?`<p class="danger">${esc(j.error)}</p>`:''}<p>远端作品：${esc(j.remote?.id||'尚未登记')} ${j.remote?.url?`<a href="${esc(j.remote.url)}" target="_blank" rel="noopener">打开已登记作品</a>`:''} ${j.publicUrl?`<a href="${esc(j.publicUrl)}" target="_blank" rel="noopener">查看已公开作品</a>`:''}</p><p class="muted">投递通道：${esc(data.deliveryCapabilities?.[j.platformId]?.label||'未接入')}。${j.delivery?.evidence?.browserSession?`草稿所在浏览器：${esc(j.delivery.evidence.browserSession)}。`:''}${esc((j.delivery?.evidence?.warnings||[]).join('；'))}</p>
    <p><strong>公开方式：</strong>${esc(videoReleaseLabel(j))}</p><p class="muted">常驻通道：${j.autoReleaseReady?'账号与适配器已就绪':'未完成真实通道验证，不能承诺无人值守'}。${j.releaseAuthorization?'本作品已有单独公开授权；异常、协议或验证码仍需处理。':'尚无浏览器自动公开授权。'}</p>
    <div class="video-buttons">${window.mediahubDesktop?`<button class="btn primary" data-video-action="workspace" data-job="${esc(j.id)}">${j.workbench.reviewExact?'应用内审阅':'应用内查看作品列表'}</button>`:`<a class="btn primary" href="${esc(j.workbench.reviewUrl)}" target="_blank" rel="noopener">${j.workbench.reviewExact?'打开审阅':'进入管理列表定位作品'}</a>`}${j.workbench.canApprove?`<button class="btn" data-video-action="approve" data-job="${esc(j.id)}">审阅完成，批准发布计划</button>`:''}</div>
    ${j.workbench.previewWarning?`<p class="video-preview-warning">预览提示（不等于投递失败）：${esc(j.workbench.previewWarning)}</p>`:''}
    ${(j.attempts||[]).length?`<details><summary>投稿历史：当前采用作品与保留的旧作品</summary>${j.attempts.map(a=>`<p><strong>${a.id===j.activeAttemptId?'当前采用':'保留历史'}</strong> · ${esc(a.remote.state)} · ${esc(a.remote.id)} <a href="${esc(a.remote.url)}" target="_blank" rel="noopener">打开对应作品</a></p>`).join('')}<p class="muted">新公开作品不会覆盖旧私密作品的真实状态；这里的历史记录不触发重传或删除。</p></details>`:''}
    <details class="video-job-tools"><summary>状态登记与技术操作</summary><div class="video-buttons"><a class="btn" href="${esc(data.creators[j.platformId])}" target="_blank" rel="noopener">平台首页</a>${j.status==='prepared'&&data.deliveryCapabilities?.[j.platformId]?.route==='draft_cli'&&data.deliveryCapabilities?.[j.platformId]?.available?`<button class="btn" data-video-action="draft" data-job="${esc(j.id)}">上传至草稿（不公开）</button>`:''}${!['draft_running','delivery_running','release_running','awaiting_public','public','cancelled'].includes(j.status)?`<button class="btn" data-video-action="reconcile" data-job="${esc(j.id)}">同步已存在的草稿/私密作品</button><button class="btn" data-video-action="remote" data-job="${esc(j.id)}">其他远端引用/原生定时登记</button>`:''}${j.platformId==='youtube'&&j.remote&&j.status!=='cancelled'?`<button class="btn" data-video-action="inspect" data-job="${esc(j.id)}">检查实际公开状态</button>`:''}${j.remote&&!['public','cancelled'].includes(j.status)?`<button class="btn" data-video-action="public" data-job="${esc(j.id)}">人工确认已公开</button>`:''}${!['draft_running','delivery_running','release_running','awaiting_public','public','cancelled'].includes(j.status)?`<button class="btn" data-video-action="cancel" data-job="${esc(j.id)}">取消本地计划</button>`:''}</div>
    ${j.status==='prepared'&&data.deliveryCapabilities?.[j.platformId]?.route==='youtube_private'?`<button class="btn" data-video-action="deliver" data-job="${esc(j.id)}">上传为仅自己可见（需OAuth）</button>`:''}${j.status==='prepared'&&data.deliveryCapabilities?.[j.platformId]?.route==='browser_agent'?`<button class="btn" data-video-action="agent" data-job="${esc(j.id)}">复制 Agent 投递指令（浏览器协助）</button>`:''}
    <p class="muted">${esc(videoReleaseLabel(j))}。打开后台后请核对账号，普通浏览器入口不保证切换到本记录会话。策略“相关热点/符合资格时原创/如实AI声明”不等于已实际开启；以页面回查证据为准。</p><pre>${esc(JSON.stringify({remote:j.remote,evidence:j.delivery?.evidence,recheck:j.delivery?.recheckFailure,reconciliations:j.reconciliations,releaseAuthorization:j.releaseAuthorization,release:j.release,publicEvidence:j.publicEvidence},null,2))}</pre></details></article>`).join('')||'<p class="muted">尚未绑定账号。</p>';
  $$('[data-video-action]').forEach(b=>{b.onclick=()=>videoAction(async()=>{
    const j=jobs.find(x=>x.id===b.dataset.job);const action=b.dataset.videoAction;const url='/api/videos/jobs/'+j.id+'/';
    if(action==='workspace'){await window.mediahubDesktop.openAccount(j.account.id,j.workbench.reviewUrl);return;}
    if(action==='agent'){await copyText(`请读取 video-publisher Skill，通过 MediaHub 为任务 ${j.id}（${j.platformId} / ${j.account.name} / ${u.copy.title}）执行首次非公开投递。优先保存草稿；没有可靠草稿时，允许仅自己可见私密发布，不允许公开、不公开列出或定时公开。先调用 mediahub_video_browser_begin(allowPrivate=true)，实际核对账号和平台已有作品，使用返回的专版素材。遇到登录、验证码、协议、声明停下请我操作。保存后重新打开核查，调用 mediahub_video_browser_finish 回填真实证据；不确定时调用 browser_block，绝不重复上传。不替我批准公开。`);toast('指令已复制，请交给具备浏览器操作能力的Agent；本按钮没有上传');return;}
    if(action==='deliver'){if(!await confirmDialog('把当前YouTube专版上传为仅自己可见的私享视频，不公开，不使用不公开列出。需已配置OAuth；结果不确定禁止重传。'))return;b.disabled=true;try{await API.post(url+'deliver',{allowPrivate:true});await renderVideos();}finally{b.disabled=false;}return;}
    if(action==='draft'||action==='cancel') {if(!await confirmDialog(action==='draft'?'只把当前平台专版上传到所选账号草稿箱，不公开发布。遇到验证码请手工完成。':'取消本地计划不会撤销平台原生定时，请另外检查平台。'))return;b.disabled=true;try{await API.post(url+action,{});await renderVideos();}finally{b.disabled=false;}return;}
    if(action==='inspect'){await API.post(url+'inspect',{});await renderVideos();return;}
    let body='',submit='',payload;
    if(action==='reconcile'){body=`<p>只登记平台里已经存在的 ${esc(j.account.name)} / ${esc(u.copy.title)}，不会上传。复制准确编辑或作品链接，系统提取ID；不要填写管理列表。私密须为仅自己可见。</p><label class="field">准确作品链接<input id="vj-url" value="${esc(j.remote?.url||'')}"></label><label class="field">状态<select id="vj-state"><option value="draft">平台草稿</option><option value="private" ${j.remote?.state==='private'?'selected':''}>仅自己可见</option></select></label><label class="field">实际账号UID或可见昵称<input id="vj-owner" placeholder="优先UID；不可见时记录用户确认的登录昵称"></label><label class="field">核查证据<textarea id="vj-evidence" placeholder="准确标题、视频/封面、可见性标记及核查位置"></textarea></label><label class="field">预览问题（可选，不会触发重传）<input id="vj-preview"></label><label><input type="checkbox" id="vj-owner-ok"> 已核对作品与所选账号</label><br><label><input type="checkbox" id="vj-state-ok"> 已核对真实草稿或仅自己可见状态</label>`;submit='同步非公开结果（不上传）';payload=el=>({url:$('#vj-url',el).value.trim(),state:$('#vj-state',el).value,observedAccountId:$('#vj-owner',el).value.trim(),evidence:$('#vj-evidence',el).value.trim(),previewWarning:$('#vj-preview',el).value.trim(),ownerConfirmed:$('#vj-owner-ok',el).checked,visibilityConfirmed:$('#vj-state-ok',el).checked});}
    if(action==='remote'){body=`<p>请在后台核对账号 ${esc(j.account.name)} 和本作品，复制准确作品ID及链接。不是账号主页。没有准确引用时不要编造；本地浏览器草稿可能只能在原浏览器恢复。</p><label class="field">作品ID<input id="vj-id" value="${esc(j.remote?.id||'')}"></label><label class="field">作品/草稿链接<input id="vj-url" value="${esc(j.remote?.url||'')}"></label><label class="field">状态<select id="vj-state"><option value="draft">平台草稿</option><option value="private" ${j.remote?.state==='private'?'selected':''}>私密／私享（仅自己可见）</option><option value="native_scheduled">已设平台原生定时（仅跟踪）</option></select></label><p>修改引用会撤销原审批；结果不确定时必须先在平台核查，不能重新上传。</p>`;submit='登记已核查作品';payload=el=>({id:$('#vj-id',el).value.trim(),url:$('#vj-url',el).value.trim(),state:$('#vj-state',el).value});}
    if(action==='approve'){body=`<p>批准 ${esc(j.account.name)} / ${esc(u.copy.title)} / 远端 ${esc(j.remote.id)}。执行公开同一作品，不重传或覆盖后台精修。</p><label class="field">最早发布时间（北京时间）<input id="vj-date" type="datetime-local" value="${beijingInputNow()}"></label><label class="field">执行方式<select id="vj-mode"><option value="manual">人工/原生定时跟踪（到点需后台操作）</option>${j.platformId==='youtube'&&j.remote.state==='private'?'<option value="youtube_api">YouTube API 自动公开（需 OAuth 编辑权限）</option>':''}<option value="browser_auto" ${j.autoReleaseReady?'':'disabled'}>MediaHub常驻自动公开${j.autoReleaseReady?'':'（会话/适配器未验证）'}</option></select></label><label><input type="checkbox" id="vj-reviewed"> 我已完整观看并在所选账号后台审阅此准确作品</label><br><label><input type="checkbox" id="vj-rights"> 已处理素材权利及审核风险；可原创时已按资格与协议开启</label><br><label><input type="checkbox" id="vj-declarations"> 已核对相关话题、平台AI声明及适用设置，不是盲选全部选项</label><p>自动方式选择并批准后就是本作品的到期公开授权，无需到点再批准；新协议/验证码除外。最低间隔3小时/2小时不可绕过；前序未公开会阻塞后续。</p>`;submit='批准本作品及发布计划';payload=el=>({reviewed:$('#vj-reviewed',el).checked,rightsConfirmed:$('#vj-rights',el).checked,declarationsConfirmed:$('#vj-declarations',el).checked,notBefore:$('#vj-date',el).value+':00+08:00',mode:$('#vj-mode',el).value});}
    if(action==='public'){body=`<p>仅在确认 ${esc(j.account.name)} 的准确作品 ${esc(j.remote.id)} 已实际公开可观看后填写；提交后从当前核查时间保守起算间隔。</p><label class="field">公开作品链接<input id="vj-url" value="${esc(j.remote.url)}"></label><label class="field">平台显示公开时间（北京时间）<input id="vj-date" type="datetime-local" value="${beijingInputNow()}"></label><label><input type="checkbox" id="vj-confirmed"> 已核对账号、作品ID和实际公开页面</label>`;submit='确认实际公开';payload=el=>({confirmed:$('#vj-confirmed',el).checked,url:$('#vj-url',el).value.trim(),publishedAt:$('#vj-date',el).value+':00+08:00'});}
    const m=openModal({title:submit,body,footer:`<button class="btn" data-close>取消</button><button class="btn primary" id="vj-submit">${esc(submit)}</button>`});
    $('#vj-submit',m.el).onclick=()=>videoAction(async()=>{const s=$('#vj-submit',m.el);s.disabled=true;try{await API.post(url+action,payload(m.el));m.close();await renderVideos();}finally{s.disabled=false;}});
  });});
  if(readonly){$$('.video-bind,.video-job button[data-video-action]').forEach(el=>el.hidden=true);}
  if(videoDetailsOpen)$('#video-detail').scrollIntoView({behavior:'smooth',block:'start'});
}

function videoBatchPrompt(p, plan) {
  const browser=plan.items.filter(i=>i.disposition==='browser').map(i=>i.jobId);
  return `请使用 video-publisher Skill，读取 MediaHub 成品包 ${p.id} 的工作台和 mediahub_video_batch_plan（账号组 ${plan.accountGroupId||'按已绑定账号'}）。任务范围仅限这些浏览器候选jobId：${browser.join('、')||'无；本次没有浏览器投递任务'}，不要扩大到账号组其他作品。重新检查状态，只处理首次待投递作品；已保存、异常、运行中和取消记录全部跳过。允许上传匹配平台专版，优先草稿；小红书使用仅自己可见，其他无可靠草稿时允许仅自己可见，绝不公开、不公开列出或定时公开。先核对实际登录账号及已有作品，再逐条 browser_begin → 实际上传/核查 → browser_finish；浏览器不可用时明确报告，不用旧公开CLI。登录、验证码、协议、声明需我操作。已有作品只用 reconcile_nonpublic 同步真实引用和可见性，预览失败不等于上传失败，不重传。不替我批准公开，保留后台修改。`;
}
function renderVideoWorkbench(data,p) {
  const jobs=data.jobs.filter(j=>j.packageId===p.id);
  const filters={all:'全部',delivery:'待投递',review:'待审阅',release:'待公开',check:'需核查',public:'已公开',cancelled:'已取消'};
  const visible=jobs.filter(j=>videoWorkFilter==='all'||j.workbench.category===videoWorkFilter);
  const title=j=>p.units.find(u=>u.unit_id===j.unitId)?.copy.title||j.unitId;
  $('#video-workbench').innerHTML=`<div class="video-workbench-head"><div><h2>${esc(p.title)} <small class="muted">${esc(p.revision)}</small></h2><p class="muted">${jobs.filter(j=>j.status==='public').length} / ${jobs.length} 条已公开 · ${jobs.filter(j=>j.workbench.category==='review').length} 条待审阅</p></div><div class="library-actions"><button class="btn" id="video-open-detail">查看专版 / 绑定账号</button><button class="btn" id="video-batch" ${(p.lifecycle?.state||'active')!=='active'?'disabled':''}>按账号组准备投递</button></div></div>
    <div class="video-filters" role="group" aria-label="筛选作品状态">${Object.entries(filters).map(([key,label])=>`<button class="btn ${key===videoWorkFilter?'primary':''}" data-work-filter="${key}" aria-pressed="${key===videoWorkFilter}">${label} ${key==='all'?jobs.length:jobs.filter(j=>j.workbench.category===key).length}</button>`).join('')}</div>
    <div class="video-review-rows">${visible.map(j=>`<article class="video-review-row"><div><strong>${esc(title(j))}</strong><p>${esc(getPlatformById(j.platformId)?.name||j.platformId)} / ${esc(j.account.name)} · ${esc(videoStatus[j.status]||j.status)}</p><small>${esc(j.timing.reason)}${j.timing.due?' · 北京时间 '+esc(beijingTime(j.timing.due)):''}</small><small>${j.status==='public'?'已公开':j.autoReleaseReady||j.mode==='youtube_api'?'自动通道':j.mode==='browser_agent_release'?'需要浏览器协助':'人工发布'}${j.remote?.state==='private'&&j.status!=='public'?' · 仅自己可见':''}</small>${j.error?`<small class="danger">${esc(j.error)}</small>`:''}</div><div class="video-row-actions">${j.status==='public'?`<a class="btn primary" href="${esc(j.publicUrl||j.workbench.reviewUrl)}" target="_blank" rel="noopener">查看作品</a>`:''}<button class="btn ${j.status==='public'?'':'primary'}" data-work-unit="${esc(j.unitId)}" data-work-job="${esc(j.id)}">${j.workbench.category==='check'?'处理问题':j.workbench.category==='release'?'查看计划':j.workbench.canApprove?'审阅并批准':'查看详情'}</button></div></article>`).join('')||'<p class="muted">这个筛选下暂无任务，可查看专版并绑定账号。</p>'}</div>
    <p class="muted">先优化设置并审阅准确作品 → 批准公开计划 → 对应执行器到期处理并核验真实公开。人工方式仍需后台操作；浏览器Agent接力依赖Codex在线；常驻自动须有已验证通道。前序未公开不会跳过或一起补发。</p>`;
  $$('[data-work-filter]').forEach(b=>b.onclick=()=>{videoWorkFilter=b.dataset.workFilter;renderVideoWorkbench(data,p);});
  $$('[data-work-unit]').forEach(b=>b.onclick=()=>{videoUnitId=b.dataset.workUnit;videoSelectedJobId=b.dataset.workJob;videoDetailsOpen=true;videoAction(renderVideos);});
  $('#video-batch').onclick=()=>openVideoBatch(data,p);
}
function openVideoBatch(data,p) {
  const m=openModal({title:'账号组批量准备（先看清单，不上传）',body:`<label class="field">账号组<select id="vb-group"><option value="">全部已绑定任务（不新增绑定）</option>${data.accountGroups.map(g=>`<option value="${esc(g.id)}" ${g.id===videoBatchGroup?'selected':''}>${esc(g.name)}</option>`).join('')}</select></label><p class="muted">每条专版明确选择账号；完整版必须先绑定，多个完整版账号的锚点请在单条中指定。留空表示跳过该平台。不改源文件，不覆盖平台修改。${data.accountGroups.length?'':'尚未建立账号组，可先看现有任务清单；需要按组准备时到账号管理建立分组。'}</p><div id="vb-selections"></div>`,footer:'<button class="btn" data-close>取消</button><button class="btn" id="vb-plan">查看已绑定任务清单</button><button class="btn primary" id="vb-prepare">按选择绑定并查看清单</button>'});
  const refresh=()=>{
    videoBatchGroup=$('#vb-group',m.el).value;
    const group=data.accountGroups.find(g=>g.id===videoBatchGroup);
    $('#vb-prepare',m.el).disabled=!group;
    const rows=p.units.flatMap(u=>[...new Set(u.targets.map(t=>({wechat_channels:'shipinhao',tencent:'shipinhao',tiktok:'tiktok_global',x:'twitter'}[t.platform]||t.platform)))].map(platform=>({u,platform})));
    $('#vb-selections',m.el).innerHTML=rows.map(({u,platform})=>{
      const accounts=data.accounts.filter(a=>a.platformId===platform&&group?.accountIds.includes(a.id));
      return `<label class="field">${esc(videoKindLabel(u.kind))} · ${esc(platform)} · ${esc(u.copy.title)}<select data-batch-unit="${esc(u.unit_id)}"><option value="">不绑定此项</option>${accounts.map(a=>`<option value="${esc(a.id)}" ${accounts.length===1?'selected':''}>${esc(a.name)} / ${esc(a.runtimeAccount||'OAuth')}</option>`).join('')}</select></label>`;
    }).join('');
  }; refresh();$('#vb-group',m.el).onchange=refresh;
  const plan=async prepare=>{
    const group=$('#vb-group',m.el).value;if(prepare&&!group)throw Error('请选择账号组');
    const selections=$$('[data-batch-unit]',m.el).filter(s=>s.value).map(s=>({unitId:s.dataset.batchUnit,accountId:s.value}));
    const result=await API.post('/api/videos/batch/'+(prepare?'prepare':'plan'),{packageId:p.id,accountGroupId:group||undefined,...(prepare?{selections}:{})});
    m.close();await renderVideos();showVideoBatchPlan(p,result);
  };
  $('#vb-plan',m.el).onclick=()=>videoAction(()=>plan(false));
  $('#vb-prepare',m.el).onclick=()=>videoAction(()=>plan(true));
}
function showVideoBatchPlan(p,plan) {
  const label={ready:'可直接首次投递',browser:'浏览器Agent待办',manual:'人工通道',skip:'防重跳过',saved:'已保存',error:'失败/需处理'};
  const renderRows=items=>items.map(i=>`<p><strong>${esc(i.platformId)} / ${esc(i.account.name)}</strong> · ${esc(label[i.disposition]||i.disposition)}<br>${esc(p.units.find(u=>u.unit_id===i.unitId)?.copy.title||i.unitId)}<br><small>${esc(i.reason||i.status)}</small></p>`).join('')||'<p>没有匹配任务。</p>';
  const m=openModal({title:'批次清单：不公开、不重传',body:`<p>可直接执行 ${plan.counts.ready} · 浏览器待办 ${plan.counts.browser} · 人工 ${plan.counts.manual} · 跳过 ${plan.counts.skip}</p><div id="vb-results">${renderRows(plan.items)}</div><p class="muted">复制指令不会上传。直接执行按钮只处理已接通的草稿/API通道，浏览器任务由Agent实际操作。已有结果与不确定记录绝不重传。</p>`,footer:`<button class="btn" data-close>关闭</button><button class="btn" id="vb-copy">复制浏览器Agent投递指令</button><button class="btn primary" id="vb-deliver" ${plan.counts.ready?'':'disabled'}>确认本批次首次非公开投递</button>`});
  $('#vb-copy',m.el).onclick=()=>videoAction(async()=>{if(!await copyText(videoBatchPrompt(p,plan)))throw Error('复制失败，请检查剪贴板权限');toast('指令已复制，尚未上传');});
  $('#vb-deliver',m.el).onclick=()=>videoAction(async()=>{
    const b=$('#vb-deliver',m.el);b.disabled=true;
    try {
      const result=await API.post('/api/videos/batch/deliver',{packageId:p.id,accountGroupId:plan.accountGroupId,jobIds:plan.items.filter(i=>i.disposition==='ready').map(i=>i.jobId),confirmed:true,allowPrivate:true});
      $('#vb-results',m.el).innerHTML=renderRows(result.results);await renderVideos();toast('本批次已返回逐条结果；未公开');
    } catch(e) { b.disabled=false;throw e; }
  });
}
