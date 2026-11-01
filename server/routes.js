const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const store = require('./store');
const { PLATFORMS, getPlatform } = require('./platforms');
const { getAdapter } = require('./adapters');
const engine = require('./engine');
const { createDistribution } = require('./taskService');
const { importBundle } = require('./bundles');
const loginService = require('./loginService');
const lifecycle = require('./contentLifecycle').createContentLifecycle();

const router = express.Router();

// ---------------- 文件上传 ----------------
const VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.m4v', '.webm', '.ts'];
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
const ALLOWED = new Set([...VIDEO_EXTS, ...IMAGE_EXTS]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, store.UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      cb(null, Date.now().toString(36) + '-' + crypto.randomBytes(5).toString('hex') + ext);
    },
  }),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED.has(ext)) return cb(new Error(`不支持的文件格式：${ext || '未知'}（仅支持常见视频/图片格式）`));
    cb(null, true);
  },
  limits: { fileSize: 2.5 * 1024 * 1024 * 1024 },
});

function sanitizeName(name) {
  const base = path.basename(String(name || 'file'));
  return base.slice(0, 120) || 'file';
}

function fileRef(id) {
  if (!id) return null;
  const f = store.db.files.find((x) => x.id === id);
  if (!f) return null;
  return { id: f.id, name: f.name, path: f.path, size: f.size, mime: f.mime };
}

function normTags(tags) {
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
  if (typeof tags === 'string') return tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean).slice(0, 20);
  return [];
}

router.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到文件' });
  const ext = path.extname(req.file.filename).toLowerCase();
  const rec = {
    id: store.nextId(),
    name: sanitizeName(req.file.originalname),
    path: 'uploads/' + path.basename(req.file.path),
    size: req.file.size,
    mime: req.file.mimetype,
    kind: VIDEO_EXTS.includes(ext) ? 'video' : 'image',
    createdAt: store.now(),
  };
  store.db.files.push(rec);
  store.save();
  res.json(rec);
});

// ---------------- 平台 ----------------
router.get('/platforms', (req, res) => res.json(
  PLATFORMS.map((platform) => ({ ...platform, loginConsole: loginService.capabilityForPlatform(platform) }))
));

// ---------------- 账号 ----------------
// 凭据不回显（只返回 hasCredentials 标记），避免本机任意进程读取
router.get('/accounts', (req, res) => {
  res.json(
    store.db.accounts.map(({ credentials, ...rest }) => ({
      ...rest,
      hasCredentials: !!(credentials && Object.keys(credentials).length),
    }))
  );
});

// ---------------- 账号分组 ----------------
router.get('/account-groups', (req, res) => res.json(store.db.accountGroups));

router.post('/account-groups', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: '请填写分组名称' });
  if (store.db.accountGroups.some((group) => group.name === name)) return res.status(409).json({ error: '分组名称已存在' });
  const accountIds = [...new Set(req.body?.accountIds || [])];
  if (accountIds.some((id) => !store.db.accounts.some((account) => account.id === id))) return res.status(400).json({ error: '分组中包含不存在的账号' });
  const group = { id: store.nextId(), name, accountIds, createdAt: store.now(), updatedAt: store.now() };
  store.db.accountGroups.push(group); store.save(); res.status(201).json(group);
});

router.patch('/account-groups/:id', (req, res) => {
  const group = store.db.accountGroups.find((item) => item.id === req.params.id);
  if (!group) return res.status(404).json({ error: '分组不存在' });
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: '分组名称不能为空' });
    if (store.db.accountGroups.some((item) => item.id !== group.id && item.name === name)) return res.status(409).json({ error: '分组名称已存在' });
    group.name = name;
  }
  if (req.body?.accountIds !== undefined) {
    const accountIds = [...new Set(req.body.accountIds || [])];
    if (accountIds.some((id) => !store.db.accounts.some((account) => account.id === id))) return res.status(400).json({ error: '分组中包含不存在的账号' });
    group.accountIds = accountIds;
  }
  group.updatedAt = store.now(); store.save(); res.json(group);
});

router.delete('/account-groups/:id', (req, res) => {
  const index = store.db.accountGroups.findIndex((item) => item.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: '分组不存在' });
  store.db.accountGroups.splice(index, 1); store.save(); res.json({ ok: true });
});

function sanitizeCredentials(platform, credentials) {
  const out = {};
  for (const f of platform.credentialFields || []) {
    const v = credentials ? credentials[f.key] : undefined;
    out[f.key] = v === undefined || v === null ? '' : String(v).trim();
  }
  return out;
}

router.post('/accounts', (req, res) => {
  const { platformId, name, credentials, runtimeAccount } = req.body || {};
  const platform = getPlatform(platformId);
  if (!platform) return res.status(400).json({ error: '平台不存在' });
  if (!name || !String(name).trim()) return res.status(400).json({ error: '请填写账号名称' });
  const effectiveRuntimeAccount = loginService.defaultRuntimeAccount(platformId)
    ? loginService.sanitizeRuntimeAccount(runtimeAccount, loginService.defaultRuntimeAccount(platformId)) : '';
  if (effectiveRuntimeAccount && store.db.accounts.some((item) => item.platformId === platformId && item.runtimeAccount === effectiveRuntimeAccount)) {
    return res.status(409).json({ error: '同一平台的本地登录身份已被其他账号使用；请填写不同的身份名称后再登录' });
  }
  const acc = {
    id: store.nextId(),
    platformId,
    name: String(name).trim(),
    runtimeAccount: effectiveRuntimeAccount,
    credentials: sanitizeCredentials(platform, credentials),
    status: 'unverified',
    lastVerifiedAt: null,
    lastVerifyMessage: '',
    createdAt: store.now(),
  };
  store.db.accounts.push(acc);
  store.save();
  res.json({ ...acc, credentials: undefined });
});

router.patch('/accounts/:id', (req, res) => {
  const acc = store.db.accounts.find((a) => a.id === req.params.id);
  if (!acc) return res.status(404).json({ error: '账号不存在' });
  const platform = getPlatform(acc.platformId);
  const { name, credentials, runtimeAccount } = req.body || {};
  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: '账号名称不能为空' });
    acc.name = String(name).trim();
  }
  if (credentials) {
    // 只覆盖填写了非空值的字段，其余保持不变（凭据不回显，编辑时留空即保留原值）
    const next = { ...(acc.credentials || {}) };
    let changed = false;
    for (const f of platform.credentialFields || []) {
      const v = credentials[f.key];
      if (v !== undefined && String(v).trim() !== '' && String(v).trim() !== next[f.key]) {
        next[f.key] = String(v).trim();
        changed = true;
      }
    }
    if (changed) acc.status = 'unverified';
    acc.credentials = next;
  }
  if (runtimeAccount !== undefined && loginService.defaultRuntimeAccount(acc.platformId)) {
    const nextRuntimeAccount = loginService.sanitizeRuntimeAccount(runtimeAccount, loginService.defaultRuntimeAccount(acc.platformId));
    if (store.db.accounts.some((item) => item.id !== acc.id && item.platformId === acc.platformId && item.runtimeAccount === nextRuntimeAccount)) {
      return res.status(409).json({ error: '同一平台的本地登录身份已被其他账号使用' });
    }
    if (nextRuntimeAccount !== acc.runtimeAccount) acc.status = 'unverified';
    acc.runtimeAccount = nextRuntimeAccount;
  }
  store.save();
  res.json({ ...acc, credentials: undefined, hasCredentials: !!(acc.credentials && Object.keys(acc.credentials).length) });
});

router.delete('/accounts/:id', (req, res) => {
  const i = store.db.accounts.findIndex((a) => a.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: '账号不存在' });
  store.db.accounts.splice(i, 1);
  for (const group of store.db.accountGroups) group.accountIds = (group.accountIds || []).filter((id) => id !== req.params.id);
  store.save();
  res.json({ ok: true });
});

router.post('/accounts/:id/verify', async (req, res, next) => {
  const acc = store.db.accounts.find((a) => a.id === req.params.id);
  if (!acc) return res.status(404).json({ error: '账号不存在' });
  try {
    const platform = getPlatform(acc.platformId);
    const contentType = platform.capabilities.find((type) => platform.adapters?.save_draft?.[type]) || platform.capabilities[0];
    const result = await loginService.checkAccount(
      acc,
      platform,
      () => getAdapter(platform, contentType, 'save_draft').verify(acc)
    );
    acc.status = result.status || (result.ok ? 'active' : 'invalid');
    acc.lastVerifiedAt = store.now();
    acc.lastVerifyMessage = result.message || '';
    store.save();
    res.json({ ok: !!result.ok, status: acc.status, message: acc.lastVerifyMessage });
  } catch (e) {
    next(e);
  }
});

router.post('/accounts/:id/login', (req, res, next) => {
  const acc = store.db.accounts.find((account) => account.id === req.params.id);
  if (!acc) return res.status(404).json({ error: '账号不存在' });
  const platform = getPlatform(acc.platformId);
  try {
    const result = loginService.startLogin(acc, platform, (loginResult) => {
      acc.status = loginResult.status;
      acc.lastVerifiedAt = store.now();
      acc.lastVerifyMessage = loginResult.message;
      store.save();
    });
    if (result.kind === 'unavailable') return res.status(400).json({ error: result.message });
    res.json(result);
  } catch (error) { next(error); }
});

router.get('/account-logins/:id', (req, res) => {
  const job = loginService.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '登录会话不存在或已结束' });
  res.json(job);
});

router.get('/account-logins/:id/qrcode', (req, res) => {
  const qrPath = loginService.getQrPath(req.params.id);
  if (!qrPath) return res.status(404).json({ error: '二维码尚未生成或已过期' });
  res.sendFile(qrPath);
});

// ---------------- 内容库 ----------------
router.get('/contents', (req, res) => res.json(store.db.contents.filter(c=>lifecycle.state(c)==='active')));

router.post('/bundles/import', (req, res, next) => {
  try {
    const result = importBundle(req.body && req.body.bundlePath);
    res.status(result.created ? 201 : 200).json(result);
  } catch (error) { next(error); }
});

router.post('/contents', (req, res) => {
  const b = req.body || {};
  const type = b.type === 'video' ? 'video' : b.type === 'article' ? 'article' : null;
  if (!type) return res.status(400).json({ error: '内容类型不合法' });
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ error: '请填写标题' });
  const videoFile = type === 'video' ? fileRef(b.videoFileId) : null;
  if (type === 'video' && !videoFile) return res.status(400).json({ error: '请上传视频文件' });
  const rec = {
    id: store.nextId(),
    type,
    title,
    desc: String(b.desc || '').trim(),
    tags: normTags(b.tags),
    body: String(b.body || ''),
    videoFile,
    coverFile: fileRef(b.coverFileId),
    images: (Array.isArray(b.imageFileIds) ? b.imageFileIds : []).map(fileRef).filter(Boolean).slice(0, 9),
    revisionId: store.nextId(),
    createdAt: store.now(),
    updatedAt: store.now(),
  };
  store.db.contents.push(rec);
  store.save();
  res.json(rec);
});

router.patch('/contents/:id', (req, res) => {
  const c = store.db.contents.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '内容不存在' });
  if (lifecycle.state(c)!=='active') return res.status(409).json({error:'内容已归档或在回收站，请先恢复'});
  const b = req.body || {};
  if (b.title !== undefined) {
    const t = String(b.title).trim();
    if (!t) return res.status(400).json({ error: '标题不能为空' });
    c.title = t;
  }
  if (b.desc !== undefined) c.desc = String(b.desc).trim();
  if (b.tags !== undefined) c.tags = normTags(b.tags);
  if (b.body !== undefined) c.body = String(b.body);
  if ('videoFileId' in b) {
    const f = fileRef(b.videoFileId);
    if (c.type === 'video' && !f) return res.status(400).json({ error: '请上传视频文件' });
    c.videoFile = f;
  }
  if ('coverFileId' in b) c.coverFile = fileRef(b.coverFileId);
  if ('imageFileIds' in b) {
    c.images = (Array.isArray(b.imageFileIds) ? b.imageFileIds : []).map(fileRef).filter(Boolean).slice(0, 9);
  }
  c.updatedAt = store.now();
  c.revisionId = store.nextId();
  store.save();
  res.json(c);
});

router.delete('/contents/:id', (req, res, next) => {
  try {res.json(lifecycle.change('content',req.params.id,'trash',{cancelPending:req.body?.cancelPending===true}));}
  catch(e) {e.status=409;next(e);}
});

// ---------------- 分发任务 ----------------
function displayTitle(t) {
  return (t.base && t.base.title) || (t.contentSnapshot && t.contentSnapshot.title) || '未命名';
}

function taskSummary(t) {
  return {
    id: t.id,
    title: displayTitle(t),
    type: t.contentSnapshot && t.contentSnapshot.type,
    status: t.status,
    scheduledAt: t.scheduledAt || null,
    createdAt: t.createdAt,
    finishedAt: t.finishedAt || null,
    targetCount: t.targets.length,
    successCount: t.targets.filter((x) => x.status === 'success').length,
    failedCount: t.targets.filter((x) => x.status === 'failed').length,
    attentionCount: t.targets.filter((x) => ['failed', 'uncertain', 'needs_user_action'].includes(x.status)).length,
    unsupportedCount: t.targets.filter((x) => x.status === 'unsupported').length,
    platforms: [...new Set(t.targets.map((x) => x.platformId))],
  };
}

router.get('/tasks', (req, res) => {
  const list = store.db.tasks.filter(t=>t.lifecycle?.state!=='archived').sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
  res.json(list.map(taskSummary));
});

router.get('/tasks/:id', (req, res) => {
  const t = store.db.tasks.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: '任务不存在' });
  res.json(t);
});

router.post('/tasks', (req, res) => {
  const b = req.body || {};
  const r = createDistribution({
    contentId: b.contentId,
    accountIds: b.accountIds,
    platformIds: b.platformIds,
    base: b.base,
    overrides: b.overrides,
    scheduleAt: b.scheduleAt,
    operation: b.operation || 'save_draft',
    allowDuplicate: b.allowDuplicate === true,
  });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json(r.task);
});

router.post('/tasks/:id/retry', (req, res) => {
  const t = store.db.tasks.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: '任务不存在' });
  const failed = t.targets.filter((x) => x.status === 'failed');
  if (!failed.length) return res.status(400).json({ error: '没有失败的分发目标' });
  engine.retryTargets(t, failed);
  res.json({ ok: true, retried: failed.length });
});

router.post('/tasks/:id/run', (req, res) => {
  const t = store.db.tasks.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: '任务不存在' });
  if (t.status !== 'scheduled') return res.status(400).json({ error: '任务不是排期状态' });
  engine.runNow(t);
  res.json({ ok: true });
});

router.delete('/tasks/:id', (req, res) => {
  const i = store.db.tasks.findIndex((x) => x.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: '任务不存在' });
  const task=store.db.tasks[i];
  if (task.status==='running'||task.targets.some(t=>['running','uncertain'].includes(t.status))) return res.status(409).json({error:'任务执行中或结果待核查，请先检查平台'});
  if (['queued','scheduled'].includes(task.status)) return res.status(409).json({error:'任务尚未完成，请从内容库取消计划后整理'});
  task.lifecycle={state:'archived',changedAt:store.now()};
  store.save();
  res.json({ ok: true });
});

// ---------------- 设置（通知 / 自动重试 / 超时） ----------------
router.get('/settings', (req, res) => res.json(store.db.settings));

router.patch('/settings', (req, res) => {
  const b = req.body || {};
  const s = store.db.settings;
  if (b.notifyWebhook !== undefined) s.notifyWebhook = String(b.notifyWebhook || '').trim();
  if (b.autoRetry !== undefined) s.autoRetry = Math.max(0, Math.min(3, Number(b.autoRetry) || 0));
  if (b.targetTimeoutSec !== undefined) s.targetTimeoutSec = Math.max(0, Math.min(3600, Number(b.targetTimeoutSec) || 0));
  store.save();
  res.json(s);
});

// ---------------- 汇总 ----------------
router.get('/summary', (req, res) => {
  const db = store.db;
  const targets = db.tasks.flatMap((t) => t.targets);
  res.json({
    contents: db.contents.length,
    accounts: db.accounts.length,
    accountsActive: db.accounts.filter((a) => a.status === 'active').length,
    tasks: db.tasks.length,
    tasksActive: db.tasks.filter((t) => ['queued', 'running', 'scheduled'].includes(t.status)).length,
    targetsSuccess: targets.filter((t) => t.status === 'success').length,
    targetsFailed: targets.filter((t) => t.status === 'failed').length,
    targetsUncertain: targets.filter((t) => t.status === 'uncertain').length,
    targetsNeedUserAction: targets.filter((t) => t.status === 'needs_user_action').length,
    targetsUnsupported: targets.filter((t) => t.status === 'unsupported').length,
  });
});

module.exports = router;
