// UI 工具：转义、格式化、弹窗、toast、徽标等
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pad(n) { return String(n).padStart(2, '0'); }

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const now = new Date();
  const ymd = d.getFullYear() === now.getFullYear() ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${ymd} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtSize(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function fileUrl(file) { return file ? `/files/${file.id}` : ''; }

function toast(msg, type = '') {
  const root = $('#toast-root');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function openModal({ title, body, footer = '', wide = false }) {
  const root = $('#modal-root');
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal ${wide ? 'modal-wide' : ''}">
      <div class="modal-head"><b>${esc(title)}</b><a class="modal-x" data-close>✕</a></div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>`;
  root.appendChild(mask);
  document.body.style.overflow = 'hidden';
  const close = () => { mask.remove(); document.body.style.overflow = ''; };
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  mask.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  $$('[data-close]', mask).forEach((el) => el.addEventListener('click', close));
  return { el: mask, close };
}

function confirmDialog(text, okText = '确定') {
  return new Promise((resolve) => {
    const m = openModal({
      title: '请确认',
      body: `<p style="font-size:13.5px;line-height:1.7;">${text}</p>`,
      footer: `<button class="btn" data-close>取消</button><button class="btn primary" id="cf-ok">${esc(okText)}</button>`,
    });
    $('#cf-ok', m.el).addEventListener('click', () => { m.close(); resolve(true); });
    m.el.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) resolve(false); });
  });
}

// ---------- 徽标 ----------
const STATUS_MAP = {
  pending: ['b-gray', '待分发'],
  running: ['b-blue', '分发中'],
  success: ['b-green', '成功'],
  failed: ['b-red', '失败'],
  queued: ['b-blue', '排队中'],
  scheduled: ['b-purple', '已排期'],
  partial: ['b-orange', '部分成功'],
  uncertain: ['b-orange', '结果待核查'],
  needs_user_action: ['b-orange', '需要人工处理'],
  unsupported: ['b-gray', '暂不支持'],
  skipped_duplicate: ['b-gray', '已拦截重复'],
  skipped: ['b-gray', '已跳过'],
  simulated: ['b-gray', '仅模拟'],
};

function statusBadge(s) {
  const [cls, text] = STATUS_MAP[s] || ['b-gray', s];
  return `<span class="badge ${cls}">${text}</span>`;
}

function typeBadge(t) {
  return t === 'video' ? '<span class="badge b-blue">视频</span>' : '<span class="badge b-purple">图文</span>';
}

function modeBadge(p) {
  if (p.mode === 'skill') return '<span class="badge b-green">Skill 草稿通道</span>';
  if (p.mode === 'official-api') return '<span class="badge b-orange">官方 API（非草稿）</span>';
  return '<span class="badge b-gray">暂未接入</span>';
}

function capBadges(p) {
  return p.capabilities.map((c) => (c === 'video' ? '<span class="badge b-blue">视频</span>' : '<span class="badge b-purple">图文</span>')).join(' ');
}

function platformChip(p, mini = false) {
  if (!p) return '<span class="muted">未知平台</span>';
  return `<span class="chip ${mini ? 'mini' : ''}"><span class="avatar" style="background:${p.color}">${esc(p.letter)}</span><span class="name">${esc(p.name)}</span></span>`;
}

function dotClass(status) {
  return { active: 'green', invalid: 'red' }[status] || 'gray';
}

function pageHead(title, sub = '', actionsHtml = '') {
  return `<div class="page-head"><div><h1>${title}</h1>${sub ? `<div class="page-sub">${sub}</div>` : ''}</div><div class="page-actions">${actionsHtml}</div></div>`;
}

// 标题输入框 + 平台字数提示（limitsData 为平台数组）
function titleField(inputId, value = '', limitsData = null) {
  const limits = limitsData || state.platforms;
  const chips = limits
    .map((p) => `<span data-limit="${p.limits.title}" class="lim-chip" title="${esc(p.name)}">${esc(p.letter)}<i>${p.limits.title}</i></span>`)
    .join('');
  return `<div class="field"><label class="f-label">标题 <i class="req">*</i></label>
    <input id="${inputId}" maxlength="200" placeholder="输入内容标题" value="${esc(value)}">
    <div class="limit-row" data-limit-for="${inputId}"><span class="limit-label">各平台字数上限：</span>${chips}</div></div>`;
}

function bindTitleCounter(inputId, scope = document) {
  const input = $(`#${inputId}`, scope);
  const row = $(`[data-limit-for="${inputId}"]`, scope);
  if (!input || !row) return;
  const update = () => {
    const n = input.value.length;
    $$('[data-limit]', row).forEach((c) => {
      const max = Number(c.dataset.limit);
      c.classList.toggle('over', n > max);
      c.classList.toggle('near', n <= max && n > max * 0.8);
      $('i', c).textContent = n > max ? `超${n - max}` : max - n;
    });
  };
  input.addEventListener('input', update);
  update();
}
