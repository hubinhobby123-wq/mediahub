// Local cleanup never submits or deletes anything on a publishing platform.
const renderContentsBeforeCleanup = renderContents;
renderContents = async function () {
  await renderContentsBeforeCleanup();
  const bar=$('.library-batch'); if(!bar)return;
  const batch=document.createElement('button');batch.className='btn danger';batch.textContent='彻底删除所选';
  batch.onclick=()=>videoAction(()=>purgeLibraryItems([...libraryView.selection.values()]));bar.append(batch);
  if(libraryView.scope==='trashed'){
    const empty=document.createElement('button');empty.className='btn danger';empty.textContent='清空回收站';
    empty.onclick=()=>videoAction(async()=>{const all=await API.get('/api/library?scope=trashed');await purgeLibraryItems(all.items);});bar.append(empty);
  }
  $$('.library-item[data-library-key]').forEach(row=>{
    const key=row.dataset.libraryKey,split=key.indexOf(':');
    const button=document.createElement('button');button.className='btn danger';button.textContent='彻底删除';
    button.onclick=()=>videoAction(()=>purgeLibraryItems([{kind:key.slice(0,split),id:key.slice(split+1)}]));
    $('.library-actions',row).append(button);
  });
};
async function purgeLibraryItems(items){
  if(!items.length){toast('请先选择需要彻底删除的内容');return;}
  if(items.length>100)throw Error('单次最多100条，请分批选择');
  const checks=await Promise.all(items.map(r=>API.get(`/api/library/${r.kind}/${r.id}/impact`)));
  const eligible=checks.filter(c=>!c.blocked.length),pending=eligible.reduce((n,c)=>n+c.cancellable.length,0);
  const blocked=checks.filter(c=>c.blocked.length);
  const m=openModal({title:'彻底删除 MediaHub 本地内容',body:`<p class="danger">将移除内容及日常任务记录，不能从回收站恢复。原文件、平台作品、账号不删除；保留最小防重账本和独立备份。</p><p>共 ${items.length} 条内容、${checks.reduce((n,c)=>n+c.units,0)} 个专版/材料。</p>${checks.map(c=>`<p>${esc(c.title)} · ${c.tasks} 条任务 · ${c.publicCount} 条已确认公开记录${c.blocked.length?' · 阻止：'+esc(c.blocked.map(x=>x.reason).join('；')):''}</p>`).join('')}${blocked.length?`<p class="danger">${blocked.length} 条将被阻止，不会强制删除。旧版待办可先在工作台一键关闭；其它未知结果仍需核查。</p>`:''}${pending?`<label><input type="checkbox" id="purge-cancel"> 同时取消可处理内容的 ${pending} 条尚未提交本地计划</label>`:''}`,footer:`<button class="btn" data-close>取消</button><button class="btn danger" id="purge-confirm" ${eligible.length?'':'disabled'}>确认彻底删除 ${eligible.length} 条可处理内容</button>`});
  $('#purge-confirm',m.el).onclick=()=>videoAction(async()=>{
    const button=$('#purge-confirm',m.el);button.disabled=true;
    try{
      if(pending&&!$('#purge-cancel',m.el).checked)throw Error('请明确确认取消尚未提交的计划');
      const result=await API.post('/api/library/batch',{action:'purge',items:items.map(r=>({kind:r.kind,id:r.id})),confirmed:true,cancelPending:$('#purge-cancel',m.el)?.checked===true});
      m.close();libraryView.selection.clear();await renderContents();
      const failed=result.results.filter(r=>!r.ok);toast(`已彻底删除 ${result.results.length-failed.length} 条${failed.length?'，'+failed.length+' 条被阻止':''}`);
      if(failed.length)openModal({title:'未删除的内容',body:failed.map(r=>`<p>${esc(checks.find(c=>c.id===r.id&&c.kind===r.kind)?.title||r.id)}：${esc(r.error)}</p>`).join(''),footer:'<button class="btn" data-close>关闭</button>'});
    }finally{button.disabled=false;}
  });
}
const renderWorkbenchBeforeCleanup = renderWorkbench;
renderWorkbench = async function () {
  await renderWorkbenchBeforeCleanup();
  const preview=await API.get('/api/library/cleanup-preview');
  const eligible=preview.items.filter(x=>x.eligible);
  const section=$('.workspace-section');if(!section)return;
  const button=document.createElement('button');button.className='btn';button.textContent=`一键处理旧版待办（${eligible.length}）`;button.disabled=!eligible.length;
  button.onclick=()=>{
    const m=openModal({title:'统一关闭旧版本地待办',body:`<p>关闭 ${eligible.length} 条已被新版替代的本地计划。不重新上传、不更改平台作品、不把未知结果标成已公开。</p>${eligible.map(x=>`<p>${esc(x.title)} / ${esc(x.platformId)}</p>`).join('')}<p class="muted">原错误及远端引用保留在历史证据中。登录、验证码、平台审核或原生定时问题不在此按钮的自动处理范围内。</p>`,footer:'<button class="btn" data-close>取消</button><button class="btn primary" id="close-old-confirm">确认统一关闭旧版待办</button>'});
    $('#close-old-confirm',m.el).onclick=()=>videoAction(async()=>{const b=$('#close-old-confirm',m.el);b.disabled=true;try{const result=await API.post('/api/library/close-old',{jobIds:eligible.map(x=>x.id),confirmed:true});m.close();await renderWorkbench();const failed=result.results.filter(x=>!x.ok);toast(`已关闭 ${result.results.length-failed.length} 条旧版待办${failed.length?'，'+failed.length+' 条需核查':''}`);if(failed.length)openModal({title:'不能自动处理的待办',body:failed.map(x=>`<p>${esc(x.id)}：${esc(x.error)}</p>`).join(''),footer:'<button class="btn" data-close>关闭</button>'});}finally{b.disabled=false;}});
  };
  section.insertBefore(button,section.children[1]||null);
};
