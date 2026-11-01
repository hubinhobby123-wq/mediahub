// 页面视图：总览 / 内容库 / 账号管理 / 发布任务（含各弹窗）
// 依赖：api.js（API, state, uploadFile）、ui.js（$, $$, esc, openModal 等）

const getPlatformById = (id) => state.platforms.find((p) => p.id === id);

// 轻量本地富文本编辑器：数据仍保存为 Markdown，避免把 HTML 或平台专有格式写进内容库。
function markdownToEditor(markdown) {
  return esc(String(markdown || '')).split(/\n{2,}/).map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`).join('') || '<p><br></p>';
}
function editorToMarkdown(element) {
  if (!element) return '';
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
    const tag = node.nodeName.toLowerCase();
    const text = [...node.childNodes].map(walk).join('');
    if (tag === 'br') return '\n';
    if (tag === 'strong' || tag === 'b') return `**${text}**`;
    if (tag === 'em' || tag === 'i') return `*${text}*`;
    if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${text}\n\n`;
    if (tag === 'li') return `- ${text.trim()}\n`;
    if (tag === 'p' || tag === 'div') return `${text}\n\n`;
    return text;
  };
  return [...element.childNodes].map(walk).join('').replace(/\n{3,}/g, '\n\n').trim();
}

// ============ 分发工作台（首页） ============
const wb = { contentId: null, accounts: new Set() };

async function renderLegacyWorkbench() {
  const app = $('#app');
  app.innerHTML = '<div class="loading">加载中…</div>';
  const [contents, accounts, sum, tasks] = await Promise.all([
    API.get('/api/contents'),
    API.get('/api/accounts'),
    API.get('/api/summary'),
    API.get('/api/tasks'),
  ]);
  state.accounts = accounts;

  // 清理失效的勾选状态，并按所选内容类型剔除不兼容平台的账号
  const validIds = new Set(accounts.map((a) => a.id));
  wb.accounts = new Set([...wb.accounts].filter((x) => validIds.has(x)));
  const sel = contents.find((c) => c.id === wb.contentId) || null;
  wb.contentId = sel ? sel.id : null;
  if (sel) pruneIncompatible(sel, accounts);

  const recent = tasks.slice(0, 5);

  app.innerHTML = `
    ${pageHead('分发工作台', '选择内容 → 勾选平台账号 → 一键分发到各平台草稿箱', `
      <button class="btn" id="wb-new">＋ 新建内容</button>
      <a class="btn" href="#/accounts">账号管理</a>`)}
    <div class="stat-grid">
      <div class="card stat-card"><div class="stat-num">${sum.contents}</div><div class="stat-label">内容库作品</div></div>
      <div class="card stat-card"><div class="stat-num">${sum.accounts}<small>（有效 ${sum.accountsActive}）</small></div><div class="stat-label">平台账号</div></div>
      <div class="card stat-card"><div class="stat-num">${sum.tasksActive}</div><div class="stat-label">进行中 / 排期任务</div></div>
      <div class="card stat-card"><div class="stat-num">${sum.targetsSuccess}<small>（失败 ${sum.targetsFailed}）</small></div><div class="stat-label">累计分发成功</div></div>
    </div>

    <div class="step-title">① 选择内容</div>
    <div class="wb-strip">
      ${contents.map((c) => {
        const on = c.id === wb.contentId;
        const thumb = c.coverFile || (c.images && c.images[0]);
        return `<div class="wb-tile ${on ? 'on' : ''}" data-wbc="${c.id}" title="${esc(c.title)}">
          <div class="wbt-thumb">${thumb ? `<img src="${fileUrl(thumb)}" loading="lazy">` : `<span>${c.type === 'video' ? '🎬' : '📄'}</span>`}</div>
          <span class="wbt-flag">${typeBadge(c.type)}</span>
          <div class="wbt-title">${esc(c.title)}</div>
        </div>`;
      }).join('')}
      <div class="wb-tile wb-add" data-wbnew>
        <div class="wbt-thumb"><span>＋</span></div>
        <div class="wbt-title muted">新建内容</div>
      </div>
    </div>

    <div class="step-title">② 勾选要分发的平台账号
      <span class="muted" style="font-weight:400;font-size:12px;">（可在此直接添加 / 验证 / 编辑各平台账号）</span>
    </div>
    ${!sel ? '<div class="notice">👆 请先在上方选择一个内容，再勾选账号分发。</div>' : ''}
    <div class="plat-grid">${state.platforms.map((p) => wbPlatCard(p, sel, accounts)).join('')}</div>

    <div class="step-title">③ 发布设置（可选）</div>
    <div class="card" style="padding:16px 18px;" id="wb-settings">${wbSettingsHtml(sel)}</div>

    <div class="wb-bar card">
      <b id="wb-count">已选 0 个账号</b>
      <span class="muted" style="font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${sel ? `将分发「${esc(sel.title)}」` : '未选择内容'}</span>
      <span class="flex1"></span>
      <button class="btn primary" id="wb-go" disabled>🚀 创建分发任务</button>
    </div>

    <div class="section-title">最近任务</div>
    <div class="card table-wrap">${recent.length ? `<table class="list">
      <thead><tr><th>任务</th><th>状态</th><th>进度</th><th>创建时间</th></tr></thead>
      <tbody>${recent.map((t) => `
        <tr class="clickable" data-task="${t.id}">
          <td class="td-title"><b>${esc(t.title)}</b></td>
          <td>${statusBadge(t.status)}</td>
          <td class="muted">${t.successCount}/${t.targetCount}${t.failedCount ? `（失败 ${t.failedCount}）` : ''}</td>
          <td class="muted">${fmtTime(t.createdAt)}</td>
        </tr>`).join('')}</tbody>
    </table>` : '<div class="empty" style="padding:24px;">暂无分发任务</div>'}</div>
  `;

  function pruneIncompatible(content, accs) {
    for (const a of accs) {
      const p = getPlatformById(a.platformId);
      if (wb.accounts.has(a.id) && p && (!p.capabilities.includes(content.type) || p.draftSupport?.[content.type] === 'unsupported')) wb.accounts.delete(a.id);
    }
  }
  function refreshWbBar() {
    const n = wb.accounts.size;
    const cnt = $('#wb-count');
    if (cnt) cnt.textContent = `已选 ${n} 个账号`;
    const go = $('#wb-go');
    if (go) go.disabled = !sel || n === 0;
  }
  function refreshWbOverrides() {
    const box = $('#wb-ovs');
    if (!box) return;
    if (!sel) { box.innerHTML = ''; return; }
    const pids = new Set(
      [...wb.accounts].map((id) => { const a = accounts.find((x) => x.id === id); return a && a.platformId; }).filter(Boolean)
    );
    box.innerHTML = state.platforms
      .filter((p) => pids.has(p.id))
      .map((p) => `
        <details class="plat-ov" style="margin-top:10px;">
          <summary>定制「${esc(p.name)}」的发布信息</summary>
          <div class="ov-fields">
            <input data-wbov="title:${p.id}" placeholder="标题（留空用统一设置）">
            <input data-wbov="desc:${p.id}" placeholder="简介 / 摘要（留空用统一设置）">
            <input data-wbov="tags:${p.id}" placeholder="话题标签，逗号分隔（留空用统一设置）">
          </div>
        </details>`)
      .join('');
  }

  $('#wb-new').addEventListener('click', () => contentModal(null));
  $('[data-wbnew]').addEventListener('click', () => contentModal(null));
  $$('[data-wbc]', app).forEach((t) =>
    t.addEventListener('click', () => {
      wb.contentId = t.dataset.wbc;
      renderWorkbench();
    })
  );
  $$('input[data-wbacc]', app).forEach((cb) =>
    cb.addEventListener('change', () => {
      if (cb.checked) wb.accounts.add(cb.dataset.wbacc);
      else wb.accounts.delete(cb.dataset.wbacc);
      refreshWbBar();
      refreshWbOverrides();
    })
  );
  $$('[data-wbselall]', app).forEach((a) =>
    a.addEventListener('click', () => {
      const boxes = $$(`input[data-wbacc][data-pid="${a.dataset.wbselall}"]:not(:disabled)`, app);
      const allOn = boxes.length > 0 && boxes.every((b) => b.checked);
      boxes.forEach((b) => {
        b.checked = !allOn;
        if (b.checked) wb.accounts.add(b.dataset.wbacc);
        else wb.accounts.delete(b.dataset.wbacc);
      });
      refreshWbBar();
      refreshWbOverrides();
    })
  );
  $$('[data-wb-verify]', app).forEach((b) =>
    b.addEventListener('click', async () => {
      b.textContent = '验证中…';
      try {
        const r = await API.post(`/api/accounts/${b.dataset.wbVerify}/verify`);
        toast(r.ok ? `✅ ${r.message}` : `❌ ${r.message}`, r.ok ? 'ok' : 'err');
      } catch (e) { toast(e.message, 'err'); }
      renderWorkbench();
    })
  );
  $$('[data-wb-edit]', app).forEach((b) =>
    b.addEventListener('click', () => accountModal(accounts.find((x) => x.id === b.dataset.wbEdit)))
  );
  $$('[data-wb-add]', app).forEach((b) =>
    b.addEventListener('click', () => accountModal(null, b.dataset.wbAdd))
  );
  $$('tr[data-task]', app).forEach((tr) =>
    tr.addEventListener('click', () => (location.hash = `#/tasks/${tr.dataset.task}`))
  );

  $('#wb-go').addEventListener('click', async () => {
    const btn = $('#wb-go');
    btn.disabled = true;
    btn.textContent = '创建中…';
    const overrides = {};
    $$('[data-wbov]', app).forEach((i) => {
      const [k, pid] = i.dataset.wbov.split(':');
      const v = i.value.trim();
      if (v) (overrides[pid] = overrides[pid] || {})[k] = v;
    });
    let scheduleAt = null;
    const sv = $('#wb-schedule') && $('#wb-schedule').value;
    if (sv) {
      const d = new Date(sv);
      if (isNaN(d.getTime()) || d.getTime() <= Date.now()) {
        toast('排期时间需晚于当前时间', 'err');
        btn.disabled = false;
        btn.textContent = '🚀 创建分发任务';
        return;
      }
      scheduleAt = d.toISOString();
    }
    try {
      const task = await API.post('/api/tasks', {
        contentId: wb.contentId,
        accountIds: [...wb.accounts],
        base: {
          title: $('#wb-title') ? $('#wb-title').value : undefined,
          desc: $('#wb-desc') ? $('#wb-desc').value : undefined,
          tags: $('#wb-tags') ? $('#wb-tags').value : undefined,
        },
        overrides,
        scheduleAt,
      });
      toast(scheduleAt ? '任务已排期，到期自动执行' : '任务已创建，正在分发');
      location.hash = `#/tasks/${task.id}`;
    } catch (e) {
      toast(e.message, 'err');
      btn.disabled = false;
      btn.textContent = '🚀 创建分发任务';
    }
  });

  refreshWbBar();
  refreshWbOverrides();
  bindTitleCounter('wb-title', app);
}

function wbPlatCard(p, sel, accounts) {
  const accs = accounts.filter((a) => a.platformId === p.id);
  const incompatible = sel && !p.capabilities.includes(sel.type);
  const unsupported = sel && p.draftSupport?.[sel.type] === 'unsupported';
  const disabled = !sel || incompatible || unsupported;
  const note = !sel ? '先在上方选择内容' : incompatible ? `不支持${sel.type === 'video' ? '视频' : '图文'}内容` : unsupported ? '没有安全、已验证的草稿通道' : '';
  return `
    <div class="card plat-card ${disabled ? 'disabled' : ''}">
      <div class="pc-head">${platformChip(p)}${modeBadge(p)}<span class="flex1"></span>${capBadges(p)}</div>
      <div class="pc-hint">${esc(p.hint)}${note ? ` <b style="color:var(--orange);">${note}</b>` : ''}</div>
      <div class="pc-accounts">
        ${accs.length ? accs.map((a) => `
          <div class="acc-row">
            <label class="acc-chk"><input type="checkbox" data-wbacc="${a.id}" data-pid="${p.id}" ${wb.accounts.has(a.id) ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span class="dot ${dotClass(a.status)}"></span>${esc(a.name)}</label>
            <span class="flex1"></span>
            <div class="acc-acts">
              <a class="link" data-wb-verify="${a.id}">验证</a>
              <a class="link" data-wb-edit="${a.id}">编辑</a>
            </div>
          </div>`).join('') : '<div class="muted pc-empty">暂无账号</div>'}
      </div>
      <div style="display:flex;gap:10px;align-items:center;">
        ${accs.length && !disabled ? `<a class="link" data-wbselall="${p.id}">全选本平台</a>` : ''}
        <span class="flex1"></span>
        <button class="btn ghost sm" data-wb-add="${p.id}">＋ 添加账号</button>
      </div>
    </div>`;
}

function wbSettingsHtml(sel) {
  if (!sel) return '<div class="muted" style="font-size:13px;">选择内容后，可在这里设置统一的标题 / 简介 / 话题、各平台定制信息与定时时间。</div>';
  return `
    <div class="wb-set-grid">
      <div class="field"><label class="f-label">本次发布标题</label><input id="wb-title" maxlength="200" value="${esc(sel.title)}"></div>
      <div class="field"><label class="f-label">简介 / 摘要</label><input id="wb-desc" value="${esc(sel.desc || '')}"></div>
      <div class="field"><label class="f-label">话题标签</label><input id="wb-tags" value="${esc((sel.tags || []).join(','))}" placeholder="多个用逗号分隔"></div>
      <div class="field"><label class="f-label">定时分发（可选）</label><input type="datetime-local" id="wb-schedule"></div>
      <div style="grid-column:1/-1;" data-limit-for="wb-title">
        <span class="limit-label">各平台标题字数上限：</span>${state.platforms.map((p) => `<span data-limit="${p.limits.title}" class="lim-chip" title="${esc(p.name)}">${esc(p.letter)}<i>${p.limits.title}</i></span>`).join('')}
      </div>
    </div>
    <div id="wb-ovs"></div>
    <div class="f-hint">勾选账号后，可按平台定制不同的标题 / 简介 / 话题（留空用统一设置）；定时留空则立即分发。</div>`;
}

// ============ 内容库 ============
async function renderLegacyContents() {
  const app = $('#app');
  app.innerHTML = '<div class="loading">加载中…</div>';
  const contents = await API.get('/api/contents');

  app.innerHTML = `
    ${pageHead('内容库', '统一管理待分发的视频与图文作品', `<button class="btn" id="btn-import-bundle">导入已适配内容</button><button class="btn primary" id="btn-new-content">＋ 手工新建</button>`)}
    ${contents.length ? `<div class="content-grid">${contents.map(contentCard).join('')}</div>`
      : `<div class="empty"><div class="ico">🗂️</div><b>内容库还是空的</b><p>上传一个视频，或写一篇图文，然后一键分发到所有平台</p><button class="btn primary" id="btn-empty-new">＋ 手工新建</button></div>`}
  `;

  $('#btn-new-content') && $('#btn-new-content').addEventListener('click', () => contentModal(null));
  $('#btn-import-bundle') && $('#btn-import-bundle').addEventListener('click', importBundleModal);
  $('#btn-empty-new') && $('#btn-empty-new').addEventListener('click', () => contentModal(null));
  $$('[data-act]', app).forEach((btn) => {
    const c = contents.find((x) => x.id === btn.dataset.id);
    btn.addEventListener('click', async () => {
      if (btn.dataset.act === 'publish') publishModal(c);
      if (btn.dataset.act === 'edit') contentModal(c);
      if (btn.dataset.act === 'del') {
        const ok = await confirmDialog(`确定删除内容「<b>${esc(c.title)}</b>」？<br/>已创建的分发任务会保留其内容快照，不受影响。`, '删除');
        if (!ok) return;
        try { await API.del('/api/contents/' + c.id); toast('已删除'); renderContents(); }
        catch (e) { toast(e.message, 'err'); }
      }
    });
  });
}

function importBundleModal() {
  const m = openModal({
    title: '导入已适配内容',
    body: `<div class="field"><label class="f-label">mediahub-bundle.json 的本机绝对路径 <i class="req">*</i></label><input id="bundle-path" placeholder="例如 E:\\\\example\\mediahub-bundle.json"><div class="f-hint">只接受由 article-publisher 或 video-publisher 生成且已校验的平台版本；重复导入不会创建副本。</div></div>`,
    footer: `<button class="btn" data-close>取消</button><button class="btn primary" id="bundle-import">导入</button>`,
  });
  $('#bundle-import', m.el).addEventListener('click', async () => {
    const bundlePath = $('#bundle-path', m.el).value.trim();
    if (!bundlePath) return toast('请填写适配包绝对路径', 'err');
    try {
      const result = await API.post('/api/bundles/import', { bundlePath });
      m.close();
      toast(result.requiresRestore ? '此内容已归档或在回收站，请从相应视图恢复' : result.created ? '已适配内容已导入' : '该内容已经导入');
      renderContents();
    } catch (error) { toast(error.message, 'err'); }
  });
}

function contentCard(c) {
  const thumbSrc = c.coverFile || (c.images && c.images[0]);
  const thumb = thumbSrc
    ? `<img src="${fileUrl(thumbSrc)}" alt="" loading="lazy">`
    : `<span class="thumb-ico">${c.type === 'video' ? '🎬' : '📄'}</span>`;
  const meta = [
    c.skillBundle ? 'Skill 已校验版本' : '',
    fmtTime(c.updatedAt),
    c.type === 'video' && c.videoFile ? fmtSize(c.videoFile.size) : '',
    c.images && c.images.length ? `${c.images.length} 张配图` : '',
  ].filter(Boolean).join(' · ');
  return `
    <div class="card content-card">
      <div class="thumb">${thumb}<span class="type-flag">${typeBadge(c.type)}</span></div>
      <div class="cc-body">
        <div class="cc-title" data-act="edit" data-id="${c.id}" title="打开并编辑">${esc(c.title)}</div>
        <div class="cc-meta"><span>${meta}</span>${c.tags && c.tags.length ? `<span class="cc-tags"># ${esc(c.tags.join(' #'))}</span>` : ''}</div>
      </div>
      <div class="cc-actions">
        <button class="btn primary sm" data-act="publish" data-id="${c.id}">🚀 分发</button>
        <button class="btn sm" data-act="edit" data-id="${c.id}">编辑</button>
        <button class="btn sm danger" data-act="del" data-id="${c.id}">删除</button>
      </div>
    </div>`;
}

// ---------- 新建 / 编辑内容弹窗 ----------
function contentModal(existing, presetType) {
  const isEdit = !!existing;
  const draft = {
    type: existing ? existing.type : presetType || 'video',
    video: existing ? existing.videoFile : null,
    cover: existing ? existing.coverFile : null,
    images: existing ? [...(existing.images || [])] : [],
  };

  const m = openModal({
    title: isEdit ? '编辑内容' : '手工新建内容',
    wide: true,
    body: `
      <div class="seg" id="c-type">
        <button data-t="video">🎬 视频</button>
        <button data-t="article">📄 图文</button>
      </div>
      <div id="c-form"></div>`,
    footer: `
      <button class="btn" data-close>取消</button>
      <button class="btn primary" id="c-save">${isEdit ? '保存修改' : '创建内容'}</button>`,
  });
  const el = m.el;
  $$('.seg button', el).forEach((b) => {
    b.classList.toggle('on', b.dataset.t === draft.type);
    b.addEventListener('click', () => {
      draft.type = b.dataset.t;
      $$('.seg button', el).forEach((x) => x.classList.toggle('on', x === b));
      renderForm(true);
    });
  });

  function renderForm(keepValues) {
    const prev = keepValues ? readForm() : {};
    $('#c-form', el).innerHTML = `
      ${draft.type === 'video' ? `
        <div class="field"><label class="f-label">视频文件 <i class="req">*</i></label>
          <div id="c-video-box"></div>
          <input type="file" id="c-video-input" accept="video/*,.mkv,.flv,.ts,.wmv" hidden>
          <div class="f-hint">支持 mp4 / mov / avi / mkv 等常见格式，单个文件不超过 2.5GB</div>
        </div>` : `
        <div class="field"><label class="f-label">正文</label>
          <div class="editor-toolbar"><button type="button" data-editor-cmd="bold">加粗</button><button type="button" data-editor-cmd="italic">斜体</button><button type="button" data-editor-cmd="insertUnorderedList">列表</button><button type="button" data-editor-cmd="formatBlock:h2">小标题</button></div>
          <div id="c-body" class="rich-editor" contenteditable="true" data-placeholder="直接输入正文；支持常用加粗、斜体、列表和小标题。">${markdownToEditor(prev.body ?? (existing ? existing.body : ''))}</div>
          <div class="f-hint">保存为可分发的 Markdown 稿件；保存不会分发。</div>
        </div>
        <div class="field"><label class="f-label">配图（最多 9 张）</label>
          <div class="img-grid" id="c-imgs"></div>
          <input type="file" id="c-imgs-input" accept="image/*" multiple hidden>
        </div>`}
      <div class="field"><label class="f-label">封面图（公众号草稿必需；视频平台建议设置）</label>
        <div class="img-grid" id="c-cover-box"></div>
        <input type="file" id="c-cover-input" accept="image/*" hidden>
      </div>
      ${titleField('c-title', prev.title ?? (existing ? existing.title : ''), state.platforms)}
      <div class="field"><label class="f-label">简介 / 摘要</label>
        <textarea id="c-desc" rows="2" placeholder="用于视频简介或图文摘要">${esc(prev.desc ?? (existing ? existing.desc : ''))}</textarea>
      </div>
      <div class="field"><label class="f-label">话题标签</label>
        <input id="c-tags" placeholder="多个用逗号分隔，如：美食,探店,vlog" value="${esc(prev.tags ?? (existing ? (existing.tags || []).join(',') : ''))}">
      </div>`;
    bindForm();
    if (draft.type === 'video') renderVideoBox();
    renderCoverBox();
    if (draft.type === 'article') renderImgs();
  }

  function readForm() {
    const g = (id) => $(id, el);
    return {
      title: g('#c-title') ? g('#c-title').value : undefined,
      desc: g('#c-desc') ? g('#c-desc').value : undefined,
      tags: g('#c-tags') ? g('#c-tags').value : undefined,
      body: g('#c-body') ? editorToMarkdown(g('#c-body')) : undefined,
    };
  }

  function bindForm() {
    bindTitleCounter('c-title', el);
    $$('[data-editor-cmd]', el).forEach((button) => button.addEventListener('click', () => {
      const [command, value] = button.dataset.editorCmd.split(':');
      $('#c-body', el)?.focus(); document.execCommand(command, false, value || null);
    }));
    const videoInput = $('#c-video-input', el);
    if (videoInput) {
      videoInput.addEventListener('change', () => {
        if (videoInput.files[0]) pickVideo(videoInput.files[0]);
        videoInput.value = '';
      });
    }
    const coverInput = $('#c-cover-input', el);
    coverInput.addEventListener('change', async () => {
      const f = coverInput.files[0];
      coverInput.value = '';
      if (!f) return;
      try { draft.cover = await uploadFile(f, null); renderCoverBox(); }
      catch (e) { toast(e.message, 'err'); }
    });
    const imgsInput = $('#c-imgs-input', el);
    if (imgsInput) {
      imgsInput.addEventListener('change', async () => {
        const files = [...imgsInput.files];
        imgsInput.value = '';
        for (const f of files) {
          if (draft.images.length >= 9) { toast('最多 9 张配图', 'err'); break; }
          try { draft.images.push(await uploadFile(f, null)); } catch (e) { toast(e.message, 'err'); }
        }
        renderImgs();
      });
    }
  }

  function renderVideoBox(mode = draft.video ? 'done' : 'empty', percent = 0) {
    const box = $('#c-video-box', el);
    if (mode === 'uploading') {
      box.innerHTML = `<div class="file-chip"><span class="flex1">正在上传…</span><span class="progress"><i style="width:${percent}%"></i></span></div>`;
      return;
    }
    if (mode === 'done' && draft.video) {
      box.innerHTML = `<div class="file-chip">🎬<span class="flex1">${esc(draft.video.name)}</span><span class="muted">${fmtSize(draft.video.size)}</span><span class="x" id="c-video-del">移除</span></div>`;
      $('#c-video-del', box).addEventListener('click', () => { draft.video = null; renderVideoBox(); });
      return;
    }
    box.innerHTML = `<div class="upload-box" id="c-video-pick">点击选择视频文件</div>`;
    $('#c-video-pick', box).addEventListener('click', () => $('#c-video-input', el).click());
  }

  async function pickVideo(f) {
    renderVideoBox('uploading', 0);
    try {
      draft.video = await uploadFile(f, (p) => renderVideoBox('uploading', p));
      renderVideoBox();
    } catch (e) {
      draft.video = null;
      renderVideoBox();
      toast(e.message, 'err');
    }
  }

  function renderCoverBox() {
    const box = $('#c-cover-box', el);
    box.innerHTML = draft.cover
      ? `<div class="img-cell cover-flag"><img src="${fileUrl(draft.cover)}"><span class="x" id="c-cover-del">✕</span></div>
         <div class="img-add" id="c-cover-add">＋</div>`
      : `<div class="img-add" id="c-cover-add" style="width:120px;height:96px;">＋ 设置封面</div>`;
    $('#c-cover-add', box).addEventListener('click', () => $('#c-cover-input', el).click());
    const del = $('#c-cover-del', box);
    if (del) del.addEventListener('click', () => { draft.cover = null; renderCoverBox(); });
  }

  function renderImgs() {
    const box = $('#c-imgs', el);
    box.innerHTML = draft.images
      .map((img, i) => `<div class="img-cell"><img src="${fileUrl(img)}"><span class="x" data-img-del="${i}">✕</span></div>`)
      .join('') + (draft.images.length < 9 ? `<div class="img-add" id="c-imgs-add">＋</div>` : '');
    $('#c-imgs-add', box) && $('#c-imgs-add', box).addEventListener('click', () => $('#c-imgs-input', el).click());
    $$('[data-img-del]', box).forEach((x) =>
      x.addEventListener('click', () => { draft.images.splice(Number(x.dataset.imgDel), 1); renderImgs(); })
    );
  }

  renderForm(false);

  $('#c-save', el).addEventListener('click', async () => {
    const payload = {
      type: draft.type,
      title: $('#c-title', el).value,
      desc: $('#c-desc', el).value,
      tags: $('#c-tags', el).value,
      body: draft.type === 'article' ? editorToMarkdown($('#c-body', el)) : '',
      videoFileId: draft.video ? draft.video.id : null,
      coverFileId: draft.cover ? draft.cover.id : null,
      imageFileIds: draft.images.map((i) => i.id),
    };
    if (!payload.title.trim()) { toast('请填写标题', 'err'); return; }
    if (draft.type === 'video' && !draft.video) { toast('请上传视频文件', 'err'); return; }
    const btn = $('#c-save', el);
    btn.disabled = true;
    try {
      if (isEdit) await API.patch('/api/contents/' + existing.id, payload);
      else await API.post('/api/contents', payload);
      m.close();
      toast(isEdit ? '内容已更新' : '内容已创建，可以点击「分发」发布到各平台');
      if (state.route === 'contents') renderContents();
      else render();
    } catch (e) {
      toast(e.message, 'err');
      btn.disabled = false;
    }
  });
}

// ============ 一键分发弹窗 ============
async function publishModal(content) {
  // 账号列表实时拉取，避免在内容库/总览页打开时使用过期数据
  const loaded = await Promise.all([API.get('/api/accounts'), API.get('/api/account-groups')]);
  state.accounts = loaded[0];
  const accountGroups = loaded[1];
  const compat = state.platforms.filter((p) => p.capabilities.includes(content.type) && p.draftSupport?.[content.type] !== 'unsupported');
  const groups = compat.map((p) => ({ platform: p, accounts: state.accounts.filter((a) => a.platformId === p.id) }));
  const anyAccount = groups.some((g) => g.accounts.length);

  if (!anyAccount) {
    const m = openModal({
      title: '一键分发',
      body: `<div class="empty" style="padding:30px 0;"><div class="ico">📭</div><b>还没有可分发的账号</b><p>请先到「账号管理」添加要分发的平台账号</p><a class="btn primary" href="#/accounts" data-close>去添加账号</a></div>`,
    });
    return;
  }

  const m = openModal({
    title: '一键分发',
    wide: true,
    body: `
      <div class="pub-content-line">${typeBadge(content.type)}<b>${esc(content.title)}</b></div>
      ${accountGroups.length ? `<div class="field"><label class="f-label">账号组（可选）</label><select id="pub-group"><option value="">手动选择账号</option>${accountGroups.map((group) => `<option value="${group.id}">${esc(group.name)}</option>`).join('')}</select><div class="f-hint">选择分组后会自动勾选其中兼容的账号，仍可手动取消。</div></div>` : ''}
      <div class="field"><label class="f-label">本次发布标题</label>
        <input id="pub-title" maxlength="100" value="${esc(content.title)}"></div>
      <div class="field"><label class="f-label">简介 / 摘要</label>
        <textarea id="pub-desc" rows="2">${esc(content.desc || '')}</textarea></div>
      <div class="field"><label class="f-label">话题标签</label>
        <input id="pub-tags" value="${esc((content.tags || []).join(','))}" placeholder="多个用逗号分隔"></div>
      <div class="field"><label class="f-label">选择分发账号</label>
        ${groups.map((g) => `
          <div class="plat-sel">
            <div class="ps-head">
              ${platformChip(g.platform)} ${modeBadge(g.platform)}
              <span class="flex1"></span>
              ${g.accounts.length
                ? `<a class="link" data-selall="${g.platform.id}">全选本平台</a>`
                : `<span class="muted" style="font-size:12px;">暂无账号，<a class="link" href="#/accounts" data-close>去添加</a></span>`}
            </div>
            ${g.accounts.length ? `<div class="ps-accounts">${g.accounts.map((a) => `
              <label class="acc-chk"><input type="checkbox" data-acc="${a.id}" data-pid="${g.platform.id}">
                <span class="dot ${dotClass(a.status)}"></span>${esc(a.name)}${a.status === 'invalid' ? ' <span class="muted">(失效)</span>' : ''}
              </label>`).join('')}</div>` : ''}
          </div>`).join('')}
      </div>
      <div class="field"><label class="f-label">平台定制（可选）</label>
        ${groups.filter((g) => g.accounts.length).map((g) => `
          <div class="plat-ov" data-ovbox="${g.platform.id}" hidden>
            <details><summary>定制「${esc(g.platform.name)}」的发布信息</summary>
              <div class="ov-fields">
                <input data-ov="title:${g.platform.id}" placeholder="标题（留空使用上方基础信息）">
                <textarea data-ov="desc:${g.platform.id}" rows="2" placeholder="简介 / 摘要（留空使用上方基础信息）"></textarea>
                <input data-ov="tags:${g.platform.id}" placeholder="话题标签，逗号分隔（留空使用上方基础信息）">
              </div>
            </details>
          </div>`).join('')}
        <div class="f-hint">不同平台可以使用不同的标题 / 简介 / 话题，留空则统一使用基础信息。</div>
      </div>
      <div class="field"><label class="f-label">定时保存草稿（可选）</label>
        <input type="datetime-local" id="pub-schedule">
        <div class="f-hint">留空立即保存平台草稿；到达设定时间后保存草稿，正式公开需另外审阅发布。</div>
      </div>`,
    footer: `
      <span id="pub-count" class="muted" style="margin-right:auto;">已选 0 个账号</span>
      <button class="btn" data-close>取消</button>
      <button class="btn primary" id="pub-submit">创建草稿任务</button>`,
  });
  const el = m.el;

  $('#pub-group', el)?.addEventListener('change', (event) => {
    const group = accountGroups.find((item) => item.id === event.target.value);
    if (!group) return;
    const selected = new Set(group.accountIds || []);
    $$('input[data-acc]', el).forEach((box) => { box.checked = selected.has(box.dataset.acc); });
    refreshPub();
  });

  function refreshPub() {
    const checked = $$('input[data-acc]:checked', el);
    $('#pub-count', el).textContent = `已选 ${checked.length} 个账号`;
    const pids = new Set(checked.map((b) => b.dataset.pid));
    $$('[data-ovbox]', el).forEach((b) => (b.hidden = !pids.has(b.dataset.ovbox)));
    $('#pub-submit', el).disabled = checked.length === 0;
  }
  el.addEventListener('change', (e) => { if (e.target.matches('input[data-acc]')) refreshPub(); });
  $$('[data-selall]', el).forEach((a) =>
    a.addEventListener('click', () => {
      const boxes = $$(`input[data-pid="${a.dataset.selall}"]`, el);
      const allOn = boxes.every((b) => b.checked);
      boxes.forEach((b) => (b.checked = !allOn));
      refreshPub();
    })
  );
  refreshPub();

  $('#pub-submit', el).addEventListener('click', async () => {
    const accountIds = $$('input[data-acc]:checked', el).map((b) => b.dataset.acc);
    if (!accountIds.length) { toast('请至少选择一个账号', 'err'); return; }
    const base = {
      title: $('#pub-title', el).value,
      desc: $('#pub-desc', el).value,
      tags: $('#pub-tags', el).value,
    };
    const overrides = {};
    $$('[data-ov]', el).forEach((inp) => {
      const [key, pid] = inp.dataset.ov.split(':');
      const v = inp.value.trim();
      if (!v) return;
      (overrides[pid] = overrides[pid] || {})[key] = v;
    });
    let scheduleAt = null;
    const sv = $('#pub-schedule', el).value;
    if (sv) {
      const d = new Date(sv);
      if (isNaN(d.getTime()) || d.getTime() <= Date.now()) { toast('排期时间需晚于当前时间', 'err'); return; }
      scheduleAt = d.toISOString();
    }
    const btn = $('#pub-submit', el);
    btn.disabled = true;
    btn.textContent = '创建中…';
    try {
      const task = await API.post('/api/tasks', { contentId: content.id, base, overrides, accountIds, scheduleAt });
      m.close();
      toast(scheduleAt ? '已排期，到时保存平台草稿' : '草稿任务已创建，正在执行');
      if (location.hash === `#/tasks/${task.id}`) render();
      else location.hash = `#/tasks/${task.id}`;
    } catch (e) {
      toast(e.message, 'err');
      btn.disabled = false;
      btn.textContent = '创建分发任务';
    }
  });
}

// ============ 账号管理 ============
let accountManagementGroups = [];
document.addEventListener('click', event => {
  document.querySelectorAll('.account-more[open]').forEach(menu => { if(!menu.contains(event.target))menu.open=false; });
});
document.addEventListener('keydown', event => {
  if(event.key==='Escape')document.querySelectorAll('.account-more[open]').forEach(menu=>menu.open=false);
});
async function renderAccounts() {
  const app = $('#app');
  app.innerHTML = '<div class="loading">加载中…</div>';
  const loaded = await Promise.all([API.get('/api/accounts'), API.get('/api/account-groups')]);
  state.accounts = loaded[0];
  const accountGroups = loaded[1];
  accountManagementGroups = accountGroups;
  const connected = state.platforms.filter(p => state.accounts.some(a => a.platformId === p.id));
  const others = state.platforms.filter(p => !connected.includes(p));

  app.innerHTML = `
    <div class="accounts-page">
    ${pageHead('账号管理', `${state.accounts.length} 个账号 · ${connected.length} 个平台 · ${accountGroups.length} 个分组`, `<button class="btn" id="btn-manage-groups">管理分组</button><button class="btn primary" id="btn-add-account">添加账号</button>`)}
    <div class="accounts-toolbar"><label class="accounts-search"><span>查找账号</span><input id="account-search" type="search" placeholder="输入账号名或平台名称" /></label><label class="accounts-group-filter"><span>账号分组</span><select id="account-group-filter"><option value="">全部分组</option><option value="__ungrouped">未分组</option>${accountGroups.map(g=>`<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}</select></label></div>
    <p class="accounts-help">点击“打开平台”登录或查看后台。工具会话的检查结果仅供参考，应用内登录以平台页面为准。</p>
    <div class="accounts-connected">${connected.map(platCard).join('') || '<div class="card accounts-empty">还没有账号，点击右上角“添加账号”开始。</div>'}</div>
    <p id="account-no-match" class="accounts-empty" hidden>没有匹配的账号，请更换关键词或分组。</p>
    <details class="accounts-other"><summary>添加其他平台 <span>${others.length} 个可选平台</span></summary><div class="accounts-other-list">${others.map(platCard).join('')}</div></details>
    </div>
  `;

  const filterAccounts = () => {
    const query = $('#account-search').value.trim().toLowerCase();
    const groupId = $('#account-group-filter').value;
    let visible = 0;
    $$('.accounts-connected .account-platform', app).forEach(section => {
      let count=0;
      $$('.acc-row',section).forEach(row=>{
        const account=state.accounts.find(a=>a.id===row.dataset.accountRow);
        const groups=accountGroups.filter(g=>(g.accountIds||[]).includes(account.id));
        const matchesGroup=!groupId || (groupId==='__ungrouped' ? !groups.length : groups.some(g=>g.id===groupId));
        row.hidden=!(matchesGroup && row.dataset.search.includes(query));
        if(!row.hidden)count++;
      });
      section.hidden=!count;visible+=count;
    });
    $('#account-no-match').hidden=Boolean(visible)||!state.accounts.length;
  };
  $('#account-search').oninput=filterAccounts;
  $('#account-group-filter').onchange=filterAccounts;

  $('#btn-add-account').addEventListener('click', () => accountModal(null));
  $$('[data-platform-open]', app).forEach(b => b.onclick = async () => {
    try { await window.mediahubDesktop.openAccount(b.dataset.platformOpen); }
    catch(e) { toast(e.message, 'err'); }
  });
  $('#btn-manage-groups').addEventListener('click', () => accountGroupsModal(accountGroups));
  $$('[data-add]', app).forEach((b) => b.addEventListener('click', () => accountModal(null, b.dataset.add)));
  $$('[data-verify]', app).forEach((b) =>
    b.addEventListener('click', async () => {
      b.textContent = '检查中…';
      try {
        const r = await API.post(`/api/accounts/${b.dataset.verify}/verify`);
        toast(r.ok ? `✅ ${r.message}` : `❌ ${r.message}`, r.ok ? 'ok' : 'err');
      } catch (e) { toast(e.message, 'err'); }
      renderAccounts();
    })
  );
  $$('[data-login]', app).forEach((b) =>
    b.addEventListener('click', () => beginAccountLogin(state.accounts.find((a) => a.id === b.dataset.login)))
  );
  $$('[data-acc-edit]', app).forEach((b) =>
    b.addEventListener('click', () => accountModal(state.accounts.find((a) => a.id === b.dataset.accEdit)))
  );
  $$('[data-acc-del]', app).forEach((b) =>
    b.addEventListener('click', async () => {
      const acc = state.accounts.find((a) => a.id === b.dataset.accDel);
      const ok = await confirmDialog(`确定删除账号「<b>${esc(acc.name)}</b>」？`, '删除');
      if (!ok) return;
      try { await API.del('/api/accounts/' + acc.id); toast('已删除'); renderAccounts(); }
      catch (e) { toast(e.message, 'err'); }
    })
  );
}

function accountGroupsModal(initialGroups) {
  let groups = initialGroups;
  const m = openModal({ title: '账号分组', wide: true, body: '<div id="group-list" class="loading">加载中…</div>', footer: '<button class="btn" data-close>关闭</button><button class="btn primary" id="group-new">＋ 新建分组</button>' });
  const renderGroups = () => {
    $('#group-list', m.el).innerHTML = groups.length ? groups.map((group) => `<div class="card" style="padding:12px;margin-bottom:10px;"><b>${esc(group.name)}</b><div class="muted" style="margin:6px 0">${(group.accountIds || []).map((id) => state.accounts.find((a) => a.id === id)?.name).filter(Boolean).map(esc).join('、') || '尚未添加账号'}</div><a class="link" data-group-edit="${group.id}">编辑</a> <a class="link danger" data-group-del="${group.id}">删除</a></div>`).join('') : '<div class="empty" style="padding:22px">还没有账号组</div>';
    $$('[data-group-edit]', m.el).forEach((button) => button.addEventListener('click', () => edit(groups.find((group) => group.id === button.dataset.groupEdit))));
    $$('[data-group-del]', m.el).forEach((button) => button.addEventListener('click', async () => { await API.del(`/api/account-groups/${button.dataset.groupDel}`); groups = await API.get('/api/account-groups'); renderGroups(); }));
  };
  const edit = (group) => {
    const dialog = openModal({ title: group ? '编辑账号组' : '新建账号组', body: `<div class="field"><label class="f-label">分组名称</label><input id="group-name" value="${esc(group?.name || '')}"></div><div class="field"><label class="f-label">包含账号</label>${state.accounts.map((account) => `<label class="acc-chk"><input type="checkbox" data-group-account="${account.id}" ${(group?.accountIds || []).includes(account.id) ? 'checked' : ''}>${esc(account.name)} · ${esc(getPlatformById(account.platformId)?.name || account.platformId)}</label>`).join('<br>')}</div>`, footer: '<button class="btn" data-close>取消</button><button class="btn primary" id="group-save">保存</button>' });
    $('#group-save', dialog.el).addEventListener('click', async () => { const name = $('#group-name', dialog.el).value.trim(); const accountIds = $$('[data-group-account]:checked', dialog.el).map((box) => box.dataset.groupAccount); if (!name) return toast('请填写分组名称', 'err'); if (group) await API.patch(`/api/account-groups/${group.id}`, { name, accountIds }); else await API.post('/api/account-groups', { name, accountIds }); dialog.close(); groups = await API.get('/api/account-groups'); renderGroups(); });
  };
  $('#group-new', m.el).addEventListener('click', () => edit(null)); renderGroups();
}

function accRow(a) {
  const stMap = { active: ['green', '已登录'], runtime_check: ['gray', '执行时检查'], action_required: ['amber', '需人工确认'], invalid: ['red', '未登录/已过期'], unavailable: ['red', '工具不可用'], unverified: ['gray', '未检查'], unsupported: ['gray', '未接入'] };
  const st = stMap[a.status] || ['gray', a.status];
  const platform = getPlatformById(a.platformId);
  const login = platform.loginConsole || {};
  const info = a.lastVerifyMessage
    ? `${a.lastVerifyMessage} · ${fmtTime(a.lastVerifiedAt)}`
    : `${st[1]}${a.lastVerifiedAt ? ' · ' + fmtTime(a.lastVerifiedAt) : ''}`;
  const groups=accountManagementGroups.filter(g=>(g.accountIds||[]).includes(a.id));
  const embedded=Boolean(window.mediahubDesktop && ['bilibili','douyin','kuaishou','xiaohongshu','shipinhao','toutiao','baijiahao','wechat','zhihu','csdn','youtube'].includes(a.platformId));
  return `
    <div class="acc-row" data-account-row="${esc(a.id)}" data-search="${esc((a.name+' '+platform.name).toLowerCase())}">
      <div class="acc-info"><b>${esc(a.name)}</b><div class="account-groups">${groups.length?groups.map(g=>`<span>${esc(g.name)}</span>`).join(''):'<span class="account-ungrouped">未分组</span>'}</div></div>
      <div class="account-session"><span class="account-status"><span class="dot ${st[0]}"></span>工具会话：${esc(st[1])}</span><small>${a.lastVerifiedAt?'检查于 '+esc(fmtTime(a.lastVerifiedAt)):'尚无检查记录'}</small></div>
      <div class="acc-acts">
        ${embedded ? `<button class="btn sm account-open" data-platform-open="${esc(a.id)}">打开平台</button>` : login.canLogin ? `<button class="btn sm" data-login="${esc(a.id)}">登录账号</button>` : ''}
        <details class="account-more"><summary>更多</summary><div class="account-menu">
        ${login.canCheck ? `<button class="btn sm" data-verify="${esc(a.id)}">检查工具会话</button>` : ''}
        ${embedded && login.canLogin ? `<button class="btn sm" data-login="${esc(a.id)}">工具通道登录</button>` : ''}
        <button class="btn sm" data-acc-edit="${esc(a.id)}">编辑账号</button>
        <details class="account-info-details"><summary>查看检查详情</summary><p>${esc(info)}</p><p>${esc(login.methodLabel || '登录方式未配置')}${a.runtimeAccount ? ' · 本地身份 '+esc(a.runtimeAccount):''}</p></details>
        <button class="btn sm danger" data-acc-del="${esc(a.id)}">删除账号</button>
        </div></details>
      </div>
    </div>`;
}

function platCard(p) {
  const accs = state.accounts.filter((a) => a.platformId === p.id);
  return `
    <section class="card account-platform">
      <header class="account-platform-head"><div>${platformChip(p)}<span class="account-count">${accs.length} 个账号</span></div><button class="btn ghost sm" data-add="${esc(p.id)}">添加账号</button></header>
      ${accs.length ? `<div class="account-column-labels"><span>账号 / 分组</span><span>工具会话状态</span><span>操作</span></div><div class="pc-accounts">${accs.map(accRow).join('')}</div>` : ''}
      <details class="account-platform-info"><summary>平台能力与登录说明</summary><div>${modeBadge(p)} ${capBadges(p)}<p>${esc(p.hint)}</p><p>工具登录方式：${esc(p.loginConsole?.methodLabel || '未配置')}</p></div></details>
    </section>`;
}

// ---------- 添加 / 编辑账号弹窗 ----------
function accountModal(existing, presetPlatformId) {
  const isEdit = !!existing;
  let pid = existing ? existing.platformId : presetPlatformId || state.platforms[0].id;

  const m = openModal({
    title: isEdit ? '编辑账号' : '添加账号',
    body: `
      <div class="field"><label class="f-label">平台</label>
        <select id="a-platform" ${isEdit ? 'disabled' : ''}>
          ${state.platforms.map((p) => {
            const modeText = p.mode === 'skill' ? 'Skill 草稿通道' : p.mode === 'official-api' ? '非草稿 API' : '暂未接入';
            return `<option value="${p.id}" ${p.id === pid ? 'selected' : ''}>${esc(p.name)}（${modeText}）</option>`;
          }).join('')}
        </select>
      </div>
      <div class="field"><label class="f-label">账号名称 <i class="req">*</i></label>
        <input id="a-name" placeholder="如：主号 · 美食频道" value="${isEdit ? esc(existing.name) : ''}"><div class="f-hint">这是 MediaHub 中显示的名称，不是登录账号或密码。</div></div>
      <div id="a-runtime"></div>
      <div id="a-creds"></div>
      <div class="f-hint" id="a-hint"></div>`,
    footer: `
      <button class="btn" data-close>取消</button>
      <button class="btn primary" id="a-save">${isEdit ? '保存' : '添加并验证'}</button>`,
  });
  const el = m.el;

  function renderCreds() {
    const p = getPlatformById(pid);
    const login = p.loginConsole || {};
    $('#a-hint', el).textContent = `${login.instructions || ''} ${p.hint || ''}`.trim();
    $('#a-runtime', el).innerHTML = login.runtimeAccount
      ? `<div class="field"><label class="f-label">本地登录身份</label><input id="a-runtime-name" value="${esc(isEdit ? (existing.runtimeAccount || login.runtimeAccount) : login.runtimeAccount)}" placeholder="default"><div class="f-hint">对应发布工具保存的浏览器会话；通常保持 default 即可。</div></div>`
      : '';
    $('#a-creds', el).innerHTML = (p.credentialFields || []).map((f) =>
      f.type === 'textarea'
        ? `<div class="field"><label class="f-label">${esc(f.label)}</label>
            <textarea data-cred="${f.key}" rows="4" placeholder="${isEdit ? '留空保持不变' : esc(f.placeholder || '')}"></textarea></div>`
        : `<div class="field"><label class="f-label">${esc(f.label)}</label>
            <input data-cred="${f.key}" placeholder="${isEdit ? '留空保持不变' : esc(f.placeholder || '')}"
              autocomplete="off"></div>`
    ).join('');
  }
  if (!isEdit) $('#a-platform', el).addEventListener('change', (e) => { pid = e.target.value; renderCreds(); });
  renderCreds();

  $('#a-save', el).addEventListener('click', async () => {
    const name = $('#a-name', el).value.trim();
    if (!name) { toast('请填写账号名称', 'err'); return; }
    const credentials = {};
    $$('[data-cred]', el).forEach((i) => (credentials[i.dataset.cred] = i.value));
    const btn = $('#a-save', el);
    btn.disabled = true;
    try {
      const runtimeAccount = $('#a-runtime-name', el)?.value.trim();
      const acc = isEdit
        ? await API.patch('/api/accounts/' + existing.id, { name, credentials, runtimeAccount })
        : await API.post('/api/accounts', { platformId: pid, name, credentials, runtimeAccount });
      m.close();
      toast('账号已保存，可在账号卡片中检查登录或去登录');
      if (state.route === 'accounts') renderAccounts();
      else render();
    } catch (e) {
      toast(e.message, 'err');
      btn.disabled = false;
    }
  });
}

async function checkAccountLogin(account, button) {
  if (button) { button.disabled = true; button.textContent = '检查中…'; }
  try {
    const result = await API.post(`/api/accounts/${account.id}/verify`);
    toast(result.message, result.ok ? 'ok' : 'err');
    if (state.route === 'accounts') renderAccounts();
    return result;
  } catch (error) {
    toast(error.message, 'err');
    if (button) { button.disabled = false; button.textContent = '我已完成，检查登录'; }
    return null;
  }
}

async function beginAccountLogin(account) {
  if (!account) return;
  try {
    const result = await API.post(`/api/accounts/${account.id}/login`);
    if (result.externalUrl) window.open(result.externalUrl, '_blank', 'noopener');
    if (result.kind === 'external' || result.kind === 'external-terminal') {
      const m = openModal({
        title: `${esc(account.name)} · 完成登录`,
        body: `<div class="login-guide"><b>${esc(result.message)}</b><p>完成扫码、验证码或平台确认后，回到这里继续检查。</p></div>`,
        footer: `<button class="btn" data-close>稍后检查</button><button class="btn primary" id="login-check-now">我已完成，检查登录</button>`,
      });
      $('#login-check-now', m.el).addEventListener('click', () => checkAccountLogin(account, $('#login-check-now', m.el)));
      return;
    }
    showLoginSession(account, result.session);
  } catch (error) { toast(error.message, 'err'); }
}

function showLoginSession(account, session) {
  const m = openModal({
    title: `${esc(account.name)} · 平台登录`,
    body: `<div class="login-session"><div class="login-status" id="login-session-status">${esc(session.message)}</div><div class="qr-stage" id="login-qr-stage"><span>二维码准备中…</span></div><div class="f-hint">二维码由本机登录工具生成，不经过 MediaHub 服务器。不要关闭应用，扫码后等待状态自动更新。</div></div>`,
    footer: `<button class="btn" data-close>关闭</button><button class="btn primary" id="login-check-now">我已完成，检查登录</button>`,
  });
  const status = $('#login-session-status', m.el);
  const qrStage = $('#login-qr-stage', m.el);
  const checkButton = $('#login-check-now', m.el);
  checkButton.addEventListener('click', () => checkAccountLogin(account, checkButton));
  let qrShown = false;
  const poll = async () => {
    if (!m.el.isConnected) return;
    try {
      const current = await API.get(`/api/account-logins/${session.id}`);
      status.textContent = current.message;
      if (current.qrAvailable && !qrShown) {
        qrShown = true;
        qrStage.innerHTML = `<img src="/api/account-logins/${session.id}/qrcode?t=${Date.now()}" alt="平台登录二维码"><span>请扫码登录</span>`;
      }
      if (['success', 'failed', 'expired'].includes(current.status)) {
        qrStage.classList.add(current.status === 'success' ? 'login-ok' : 'login-failed');
        if (current.status === 'success') qrStage.innerHTML = '<b>登录成功</b>';
        if (state.route === 'accounts') renderAccounts();
        return;
      }
      setTimeout(poll, 1200);
    } catch (error) { status.textContent = error.message; }
  };
  poll();
}

// ============ 发布任务列表 ============
async function renderTasks() {
  const app = $('#app');
  app.innerHTML = '<div class="loading">加载中…</div>';
  const tasks = await API.get('/api/tasks');

  app.innerHTML = `
    ${pageHead('发布中心', '图文与历史草稿任务；草稿保存成功后仍需审阅与正式发布')}
    ${workspaceTabs('article')}
    ${tasks.length ? `<div class="card table-wrap"><table class="list">
      <thead><tr><th>任务</th><th>状态</th><th>分发进度</th><th>创建时间</th><th style="width:90px;"></th></tr></thead>
      <tbody>${tasks.map((t) => `
        <tr class="clickable" data-task="${t.id}">
          <td class="td-title"><b>${esc(t.title)}</b><span class="muted">${typeBadge(t.type)} ${t.platforms.map((pid) => platformChip(getPlatformById(pid), true)).join(' ')}</span></td>
          <td>${statusBadge(t.status)}</td>
          <td class="muted">${t.successCount}/${t.targetCount} 成功${t.failedCount ? `，${t.failedCount} 失败` : ''}</td>
          <td class="muted">${fmtTime(t.createdAt)}</td>
          <td><a class="link" data-view="${t.id}">查看详情</a></td>
        </tr>`).join('')}</tbody>
    </table></div>`
      : `<div class="empty"><div class="ico">🚀</div><b>还没有分发任务</b><p>到「内容库」选择一个作品，点击「分发」即可创建</p><a class="btn primary" href="#/contents">去内容库</a></div>`}
  `;

  $$('tr[data-task]', app).forEach((tr) =>
    tr.addEventListener('click', (e) => {
      if (e.target.closest('[data-view]')) return;
      location.hash = `#/tasks/${tr.dataset.task}`;
    })
  );
  $$('[data-view]', app).forEach((a) => a.addEventListener('click', () => (location.hash = `#/tasks/${a.dataset.view}`)));
  if (tasks.some((t) => ['queued', 'running'].includes(t.status))) setPoll(renderTasks, 4000);
}

// ============ 任务详情 ============
const expandedLogs = new Set();

async function renderTaskDetail(id) {
  const app = $('#app');
  let t;
  try {
    t = await API.get('/api/tasks/' + id);
  } catch (e) {
    app.innerHTML = pageHead('任务详情') + `<div class="empty"><div class="ico">🕳️</div><b>任务不存在</b><p>可能已被删除</p><a class="btn" href="#/tasks">返回任务列表</a></div>`;
    return;
  }
  const snap = t.contentSnapshot || {};
  const hasFailed = t.targets.some((x) => x.status === 'failed');
  const isActive = t.status === 'running' || t.targets.some((x) => ['pending', 'running'].includes(x.status));

  app.innerHTML = `
    <div style="margin-bottom:12px;"><a class="link" href="#/tasks">← 返回任务列表</a></div>
    ${pageHead(
      esc((t.base && t.base.title) || snap.title || '未命名'),
      `任务 ID：${t.id}`,
      `<button class="btn" id="td-del">归档执行记录</button>
       ${hasFailed ? `<button class="btn danger" id="td-retry">重试失败项</button>` : ''}
       ${t.status === 'scheduled' ? `<button class="btn primary" id="td-run">立即执行</button>` : ''}`
    )}
    <div class="card task-meta">
      <div class="item"><div class="k">任务状态</div><div class="v">${statusBadge(t.status)}</div></div>
      <div class="item"><div class="k">内容类型</div><div class="v">${typeBadge(snap.type)} ${snap.type === 'video' ? esc(snap.videoFile ? snap.videoFile.name : '') : ''}</div></div>
      <div class="item"><div class="k">分发进度</div><div class="v">${t.targets.filter((x) => x.status === 'success').length}/${t.targets.length} 成功${t.targets.some((x) => x.status === 'failed') ? `，${t.targets.filter((x) => x.status === 'failed').length} 失败` : ''}</div></div>
      <div class="item"><div class="k">创建时间</div><div class="v">${fmtTime(t.createdAt)}</div></div>
      ${t.scheduledAt ? `<div class="item"><div class="k">排期时间</div><div class="v">${fmtTime(t.scheduledAt)}</div></div>` : ''}
      ${t.finishedAt ? `<div class="item"><div class="k">完成时间</div><div class="v">${fmtTime(t.finishedAt)}</div></div>` : ''}
      ${snap.tags && snap.tags.length ? `<div class="item"><div class="k">话题标签</div><div class="v">${esc(snap.tags.join('、'))}</div></div>` : ''}
    </div>

    <div class="section-title">分发目标</div>
    <div class="card table-wrap"><table class="list">
      <thead><tr><th>平台</th><th>账号</th><th>状态</th><th>结果</th><th>耗时</th><th style="width:70px;"></th></tr></thead>
      <tbody>${t.targets.map((x) => {
        const cost = x.startedAt && x.finishedAt ? Math.max(1, Math.round((new Date(x.finishedAt) - new Date(x.startedAt)) / 100) / 10) + 's' : '—';
        return `
        <tr>
          <td>${platformChip(getPlatformById(x.platformId))}</td>
          <td>${esc(x.accountName)}</td>
          <td>${statusBadge(x.status)}</td>
          <td style="max-width:300px;">
            <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(x.message)}">${esc(x.message || '—')}</div>
            ${x.externalId ? `<span class="ext-id">ID: ${esc(x.externalId)}</span>` : ''}
          </td>
          <td class="muted">${cost}</td>
          <td><a class="link" data-log="${x.id}">${expandedLogs.has(x.id) ? '收起日志' : '日志'}</a></td>
        </tr>
        ${expandedLogs.has(x.id) ? `<tr><td colspan="6" class="target-log"><pre>${esc((x.logs || []).join('\n')) || '暂无日志'}</pre></td></tr>` : ''}`;
      }).join('')}</tbody>
    </table></div>
  `;

  $$('[data-log]', app).forEach((a) =>
    a.addEventListener('click', () => {
      const lid = a.dataset.log;
      expandedLogs.has(lid) ? expandedLogs.delete(lid) : expandedLogs.add(lid);
      renderTaskDetail(id);
    })
  );
  $('#td-retry') && $('#td-retry').addEventListener('click', async () => {
    try {
      const r = await API.post(`/api/tasks/${id}/retry`);
      toast(`已重新提交 ${r.retried} 个失败目标`);
      renderTaskDetail(id);
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#td-run') && $('#td-run').addEventListener('click', async () => {
    try { await API.post(`/api/tasks/${id}/run`); toast('已开始执行'); renderTaskDetail(id); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#td-del') && $('#td-del').addEventListener('click', async () => {
    const ok = await confirmDialog('归档这条已结束的执行记录？历史仍会保留；未结束的任务不能归档。', '归档');
    if (!ok) return;
    try { await API.del('/api/tasks/' + id); toast('执行记录已归档，历史保留'); location.hash = '#/tasks'; }
    catch (e) { toast(e.message, 'err'); }
  });

  if (isActive) setPoll(() => renderTaskDetail(id), 2500);
}

// ============ AI · 自动化 ============
async function renderAi() {
  const app = $('#app');
  const [settings] = await Promise.all([API.get('/api/settings')]);
  const mcpUrl = `${location.origin}/mcp`;
  const mcpCfg = [
    '{',
    '  "mcpServers": {',
    '    "mediahub": {',
    '      "type": "http",',
    `      "url": "${mcpUrl}"`,
    '    }',
    '  }',
    '}',
  ].join('\n');
  const cliExamples = [
    'cd mediahub',
    'node cli.js platforms                                  # 查看所有平台',
    'node cli.js accounts add --platform douyin --name 主号  # 添加账号',
    'node cli.js contents create-video --file D:\\videos\\demo.mp4 --title 周末探店 --tags 探店,vlog',
    'node cli.js publish --content <内容ID> --platform douyin,kuaishou --wait',
    'node cli.js tasks get --id <任务ID>',
    '# 所有命令都可加 --json，输出机器可读 JSON，方便 Agent 解析',
  ].join('\n');
  const apiExamples = [
    '# 平台目录',
    `curl ${location.origin}/api/platforms`,
    '',
    '# 创建分发任务（把内容发到指定账号草稿箱）',
    `curl -X POST ${location.origin}/api/tasks -H "Content-Type: application/json" \\`,
    `  -d '{"contentId":"<内容ID>","accountIds":["<账号ID>"]}'`,
    '',
    '# 查询任务结果',
    `curl ${location.origin}/api/tasks/<任务ID>`,
  ].join('\n');
  const tools = [
    ['mediahub_list_platforms', '列出全部分发平台与能力'],
    ['mediahub_list_accounts', '列出已添加的平台账号'],
    ['mediahub_list_contents', '列出内容库作品'],
    ['mediahub_import_bundle', '导入两个 Skill 生成并校验的适配包'],
    ['mediahub_create_video_content', '用本地视频文件创建视频内容（filePath 传绝对路径）'],
    ['mediahub_create_article_content', '创建图文内容（正文 + 可选配图）'],
    ['mediahub_publish', '把内容分发到指定账号（accountIds 或 platformIds）'],
    ['mediahub_task_status', '查询任务状态与各平台执行日志'],
    ['mediahub_list_tasks', '列出分发任务'],
  ];

  app.innerHTML = `
    ${pageHead('AI · 自动化', '让 AI Agent（ZCode / Claude / Cursor 等）帮你完成内容分发')}
    <div class="notice">🤖 <span>三种方式都连接<b>本地服务</b>（保持应用运行即可），只监听本机、无需注册任何云端服务。AI Agent 接入推荐 <b>MCP</b>；脚本和终端场景用 <b>CLI</b>；自定义集成直接调 <b>REST API</b>。</span></div>

    <div class="ai-sec card" style="padding:16px 18px;">
      <div class="section-title" style="margin-top:0;">分发设置</div>
      <div class="wb-set-grid">
        <div class="field"><label class="f-label">失败自动重试（次数）</label>
          <select id="st-retry">
            <option value="0" ${settings.autoRetry ? '' : 'selected'}>关闭（手动重试）</option>
            <option value="1" ${settings.autoRetry == 1 ? 'selected' : ''}>自动重试 1 次</option>
            <option value="2" ${settings.autoRetry == 2 ? 'selected' : ''}>自动重试 2 次</option>
            <option value="3" ${settings.autoRetry == 3 ? 'selected' : ''}>自动重试 3 次</option>
          </select>
          <div class="f-hint">失败后约 1 分钟起指数间隔自动重试。</div>
        </div>
        <div class="field"><label class="f-label">单目标执行超时（秒，0 为不限）</label>
          <input id="st-timeout" type="number" min="0" max="3600" value="${settings.targetTimeoutSec || 0}">
          <div class="f-hint">防止个别平台卡住整个任务队列，浏览器自动化类建议设 300。</div>
        </div>
        <div style="grid-column:1/-1;" class="field"><label class="f-label">完成通知 Webhook（可选）</label>
          <input id="st-webhook" placeholder="https://（钉钉/飞书/企业微信机器人 或 自建接收端）" value="${esc(settings.notifyWebhook || '')}">
          <div class="f-hint">任务结束后 POST 一段 JSON（含状态、成功数、失败详情）到该地址。</div>
        </div>
      </div>
      <button class="btn sm primary" id="st-save">保存设置</button>
    </div>

    <div class="ai-sec">
      <div class="section-title">方式一 · MCP 服务器（Agent 推荐接入）</div>
      <p class="muted" style="margin-bottom:10px;font-size:13px;">端点（Streamable HTTP，无状态、免鉴钥）：<code>${mcpUrl}</code></p>
      <div class="code-block" id="cp-mcp">${esc(mcpCfg)}</div>
      <div style="margin-top:8px;"><button class="btn sm" data-copy="cp-mcp">复制 MCP 配置</button></div>
      <div class="card table-wrap" style="margin-top:14px;"><table class="list">
        <thead><tr><th style="width:310px;">工具名</th><th>说明</th></tr></thead>
        <tbody>${tools.map((t) => `<tr><td><code>${t[0]}</code></td><td class="muted">${t[1]}</td></tr>`).join('')}</tbody>
      </table></div>
    </div>

    <div class="ai-sec">
      <div class="section-title">方式二 · 命令行 CLI</div>
      <div class="code-block" id="cp-cli">${esc(cliExamples)}</div>
      <div style="margin-top:8px;"><button class="btn sm" data-copy="cp-cli">复制示例</button></div>
    </div>

    <div class="ai-sec">
      <div class="section-title">方式三 · REST API</div>
      <div class="code-block" id="cp-api">${esc(apiExamples)}</div>
      <div style="margin-top:8px;"><button class="btn sm" data-copy="cp-api">复制示例</button></div>
      <p class="muted" style="font-size:12.5px;margin-top:10px;">完整接口见仓库 README；上传素材用 <code>POST /api/upload</code>（multipart）。</p>
    </div>
  `;

  $$('[data-copy]', app).forEach((b) =>
    b.addEventListener('click', async () => {
      const ok = await copyText($('#' + b.dataset.copy).textContent);
      toast(ok ? '已复制到剪贴板' : '复制失败，请手动选择复制', ok ? 'ok' : 'err');
    })
  );

  $('#st-save').addEventListener('click', async () => {
    try {
      await API.patch('/api/settings', {
        autoRetry: Number($('#st-retry').value),
        targetTimeoutSec: Number($('#st-timeout').value) || 0,
        notifyWebhook: $('#st-webhook').value,
      });
      toast('设置已保存');
    } catch (e) {
      toast(e.message, 'err');
    }
  });
}
