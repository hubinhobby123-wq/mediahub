const crypto = require('crypto');
const store = require('./store');
const { getPlatform } = require('./platforms');
const engine = require('./engine');

function normTags(tags) {
  if (Array.isArray(tags)) return tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 20);
  if (typeof tags === 'string') return tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean).slice(0, 20);
  return [];
}

function cleanOverride(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const key of ['title', 'desc', 'body', 'bodyFile', 'bodyFormat', 'coverPath']) {
    if (input[key] !== undefined && input[key] !== null && String(input[key]).trim()) out[key] = String(input[key]).trim();
  }
  const tags = normTags(input.tags);
  if (tags.length) out.tags = tags;
  return Object.keys(out).length ? out : null;
}

function keyFor(content, account, operation, version) {
  const identity = content.revisionId || content.skillBundle?.bundleId || `${content.id}:${content.updatedAt}`;
  const versionId = version?.bodySha256 || version?.metadataSha256 || content.updatedAt || '';
  // 账号别名不是实际会话。将运行身份纳入幂等键，避免两个头条号互相吞掉任务。
  const runtimeIdentity = account.runtimeAccount || account.id;
  return crypto.createHash('sha256').update(`${identity}|${versionId}|${account.platformId}|${runtimeIdentity}|${operation}`).digest('hex');
}

function findDuplicate(idempotencyKey) {
  const active = new Set(['pending', 'running', 'success', 'uncertain', 'needs_user_action', 'skipped_duplicate']);
  for (const task of store.db.tasks) {
    const target = task.targets.find((item) => item.idempotencyKey === idempotencyKey && active.has(item.status));
    if (target) return { task, target };
  }
  for(const entry of store.db.deletionLedger||[])for(const record of entry.records||[]){
    const target=record.targets?.find(item=>item.idempotencyKey===idempotencyKey&&active.has(item.status));
    if(target)return {task:{id:record.id},target};
  }
  return null;
}

function createDistribution({ contentId, accountIds = [], platformIds = [], base = {}, overrides = {}, scheduleAt = null, operation = 'save_draft', allowDuplicate = false }) {
  try {require('./contentLifecycle').createContentLifecycle().requireActive('content',contentId);} catch(e) {return {ok:false,error:e.message};}
  if (operation !== 'save_draft') return { ok: false, error: '当前版本只支持 save_draft（保存草稿）' };
  const content = store.db.contents.find((item) => item.id === contentId);
  if (!content) return { ok: false, error: '内容不存在，请先在内容库创建或导入适配包' };
  const ids = [...new Set(accountIds || [])];
  for (const platformId of [...new Set(platformIds || [])]) {
    const accounts = store.db.accounts.filter((account) => account.platformId === platformId);
    const defaults = accounts.filter((account) => account.isDefault);
    for (const account of (defaults.length ? defaults : accounts)) if (!ids.includes(account.id)) ids.push(account.id);
  }
  if (!ids.length) return { ok: false, error: '请至少选择一个分发账号或平台' };

  const targets = [];
  for (const accountId of ids) {
    const account = store.db.accounts.find((item) => item.id === accountId);
    if (!account) return { ok: false, error: '选择的账号不存在或已被删除' };
    const platform = getPlatform(account.platformId);
    if (!platform) return { ok: false, error: `未知平台：${account.platformId}` };
    if (!platform.capabilities.includes(content.type)) return { ok: false, error: `「${platform.name}」不支持${content.type === 'video' ? '视频' : '图文'}内容` };
    const skillPlatform = platform.skillPlatform || platform.id;
    const version = content.platformVersions?.[skillPlatform] || content.platformVersions?.[platform.id] || null;
    const idempotencyKey = keyFor(content, account, operation, version);
    const duplicate = allowDuplicate ? null : findDuplicate(idempotencyKey);
    targets.push({
      id: store.nextId(), accountId: account.id, platformId: platform.id, accountName: account.name,
      accountSnapshot: { id: account.id, name: account.name, platformId: account.platformId, runtimeAccount: account.runtimeAccount || '', identity: account.identity || '' },
      status: duplicate ? 'skipped_duplicate' : 'pending',
      message: duplicate ? `已存在相同内容版本的任务：${duplicate.task.id}` : '',
      duplicateOfTaskId: duplicate?.task.id || null,
      idempotencyKey, operation, externalId: '', evidence: null, retryable: false,
      logs: [], attempts: 0, startedAt: null, finishedAt: duplicate ? store.now() : null,
    });
  }

  const platformOverrides = {};
  for (const target of targets) {
    const override = cleanOverride(overrides?.[target.platformId]);
    if (override) platformOverrides[target.platformId] = override;
  }
  const task = {
    id: store.nextId(), contentId: content.id, operation,
    contentSnapshot: JSON.parse(JSON.stringify({ id: content.id, revisionId: content.revisionId || content.updatedAt, type: content.type, subtype: content.subtype, title: content.title, desc: content.desc, tags: content.tags, body: content.body, videoFile: content.videoFile, coverFile: content.coverFile, images: content.images, platformVersions: content.platformVersions, skillBundle: content.skillBundle })),
    base: { title: base.title !== undefined ? String(base.title).trim() : undefined, desc: base.desc !== undefined ? String(base.desc).trim() : undefined, tags: normTags(base.tags) },
    overrides: platformOverrides, targets, status: 'queued', scheduledAt: null, createdAt: store.now(), finishedAt: null,
  };
  if (scheduleAt) {
    const date = new Date(scheduleAt);
    if (Number.isNaN(date.getTime())) return { ok: false, error: '定时时间无效' };
    task.scheduledAt = date.toISOString();
    if (date.getTime() > Date.now()) task.status = 'scheduled';
  }
  store.db.tasks.push(task);
  store.save();
  if (task.status === 'queued') engine.enqueue(task.id);
  return { ok: true, task };
}

module.exports = { createDistribution, keyFor };
