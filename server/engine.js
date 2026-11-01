const fs = require('fs');
const store = require('./store');
const { getPlatform } = require('./platforms');
const { getAdapter } = require('./adapters');

const queue = [];
let running = false;

function enqueue(taskId) { if (!queue.includes(taskId)) queue.push(taskId); drain(); }
function ts() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }

async function drain() {
  if (running) return;
  running = true;
  try { while (queue.length) await runTask(queue.shift()); } finally { running = false; }
}

function readBodyFile(version) {
  if (!version?.bodyFile) return undefined;
  try { return fs.readFileSync(version.bodyFile, 'utf8'); } catch { return undefined; }
}

function resolveFields(task, target, platform) {
  const content = task.contentSnapshot || {};
  const base = task.base || {};
  const override = task.overrides?.[target.platformId] || {};
  const skillPlatform = platform.skillPlatform || platform.id;
  const version = content.platformVersions?.[skillPlatform] || content.platformVersions?.[platform.id] || {};
  return {
    title: override.title || version.title || base.title || content.title || '',
    desc: override.desc || version.description || base.desc || content.desc || '',
    tags: override.tags?.length ? override.tags : version.tags?.length ? version.tags : base.tags?.length ? base.tags : content.tags || [],
    body: override.body || readBodyFile(override) || readBodyFile(version) || content.body || '',
    bodyFile: override.bodyFile || version.bodyFile || null,
    bodyFormat: override.bodyFormat || version.bodyFormat || null,
    coverPath: override.coverPath || version.coverPath || version.coverLandscape || null,
  };
}

function finalStatus(statuses) {
  if (statuses.every((status) => status === 'skipped_duplicate')) return 'skipped';
  if (statuses.every((status) => ['success', 'skipped_duplicate'].includes(status))) return 'success';
  if (statuses.every((status) => status === 'simulated')) return 'simulated';
  if (statuses.every((status) => status === 'unsupported')) return 'unsupported';
  if (statuses.some((status) => status === 'uncertain')) return statuses.some((status) => status === 'success') ? 'partial' : 'uncertain';
  if (statuses.some((status) => status === 'needs_user_action')) return statuses.some((status) => status === 'success') ? 'partial' : 'needs_user_action';
  if (statuses.every((status) => status === 'failed')) return 'failed';
  return 'partial';
}

async function runTask(taskId) {
  const task = store.db.tasks.find((item) => item.id === taskId);
  if (!task) return;
  if (task.status!=='queued' || store.db.contents.find(c=>c.id===task.contentId)?.lifecycle?.state==='trashed') return;
  task.status = 'running';
  store.save();
  for (const target of task.targets) {
    if (target.status !== 'pending') continue;
    await runTarget(task, target);
  }
  task.status = finalStatus(task.targets.map((target) => target.status));
  task.finishedAt = store.now();
  store.save();
  if (!maybeAutoRetry(task)) notify(task);
}

async function runTarget(task, target) {
  const platform = getPlatform(target.platformId);
  target.status = 'running';
  target.startedAt = store.now();
  target.attempts = (target.attempts || 0) + 1;
  target.logs ||= [];
  const logger = (line) => {
    target.logs.push('[' + ts() + '] ' + String(line).slice(0, 1000));
    if (target.logs.length > 200) target.logs.shift();
    store.save();
  };
  logger('开始：' + (platform?.name || target.platformId) + ' / ' + target.accountName + ' / ' + task.operation);
  const controller = new AbortController();
  let timer = null;
  try {
    if (!platform) throw new Error('未知平台：' + target.platformId);
    // 使用创建任务时冻结的身份；账号后来改名、改组或重新绑定不会改变队列里的目标。
    const account = target.accountSnapshot || store.db.accounts.find((item) => item.id === target.accountId);
    if (!account) throw new Error('账号已被删除，无法分发');
    const adapter = getAdapter(platform, task.contentSnapshot.type, task.operation);
    const work = Promise.resolve(adapter.publish({ platform, account, content: task.contentSnapshot, fields: resolveFields(task, target, platform), operation: task.operation, signal: controller.signal, logger, uploadRoot: store.UPLOAD_DIR }));
    const timeoutSec = Number(store.db.settings.targetTimeoutSec) || 0;
    const result = timeoutSec
      ? await Promise.race([work, new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            const error = new Error('执行超时（超过 ' + timeoutSec + ' 秒），结果需要核查');
            error.code = 'TIMEOUT';
            reject(error);
          }, timeoutSec * 1000);
        })])
      : await work;
    target.status = result?.status || (result?.ok ? 'success' : 'failed');
    target.externalId = result?.externalId || '';
    target.evidence = result?.evidence || null;
    target.message = result?.message || (result?.ok ? '成功' : '未知错误');
    target.retryable = result?.retryable === true;
    if (!result?.ok) logger('[' + target.status + '] ' + target.message);
  } catch (error) {
    target.status = ['TIMEOUT', 'ABORTED'].includes(error.code) ? 'uncertain' : 'failed';
    target.retryable = error.retryable === true;
    target.message = error.message || String(error);
    logger('[' + target.status + '] ' + target.message);
  } finally {
    if (timer) clearTimeout(timer);
    target.finishedAt = store.now();
    store.save();
  }
}

function maybeAutoRetry(task) {
  const max = Number(store.db.settings.autoRetry) || 0;
  if (!max) return false;
  const retryable = task.targets.filter((target) => target.status === 'failed' && target.retryable && target.attempts <= max);
  if (!retryable.length) return false;
  const delayMs = 60000 * Math.min(5, Math.max(...retryable.map((target) => target.attempts || 1)));
  setTimeout(() => {
    const current = store.db.tasks.find((item) => item.id === task.id);
    if (current && current.status!=='cancelled' && store.db.contents.find(c=>c.id===current.contentId)?.lifecycle?.state!=='trashed') retryTargets(current, current.targets.filter((target) => retryable.some((item) => item.id === target.id)));
  }, delayMs).unref();
  return true;
}

function retryTargets(task, targets) {
  require('./contentLifecycle').createContentLifecycle().requireActive('content',task.contentId);
  if (task.status==='cancelled') throw Error('已取消任务不能恢复执行，请明确创建新计划');
  for (const target of targets) {
    target.logs ||= [];
    target.logs.push('[' + ts() + '] 用户要求重试；保留此前 ' + (target.attempts || 0) + ' 次记录');
    target.status = 'pending';
    target.message = '';
    target.externalId = '';
    target.evidence = null;
    target.retryable = false;
    target.startedAt = null;
    target.finishedAt = null;
  }
  task.status = 'queued';
  task.finishedAt = null;
  store.save();
  enqueue(task.id);
}

function runNow(task) { require('./contentLifecycle').createContentLifecycle().requireActive('content',task.contentId); if(task.status==='cancelled')throw Error('已取消任务不能执行'); task.status = 'queued'; task.scheduledAt = null; store.save(); enqueue(task.id); }

function recover() {
  for (const task of store.db.tasks) {
    if (!['running', 'queued'].includes(task.status)) continue;
    let hasPending = false;
    for (const target of task.targets) {
      if (target.status === 'running') {
        target.status = 'uncertain';
        target.retryable = false;
        target.finishedAt = store.now();
        target.message = '服务在执行期间中断；请先核查平台草稿，不能自动重传';
        target.logs ||= [];
        target.logs.push('[' + ts() + '] 恢复检查：上次执行中断，标记为 uncertain');
      } else if (target.status === 'pending') hasPending = true;
    }
    task.status = finalStatus(task.targets.map((target) => target.status));
    if (hasPending && !task.targets.some((target) => target.status === 'uncertain')) {
      task.status = 'queued';
      enqueue(task.id);
    } else task.finishedAt = store.now();
  }
  store.save();
}

function startScheduler() {
  setInterval(() => {
    const now = Date.now();
    for (const task of store.db.tasks) if (task.status === 'scheduled' && task.scheduledAt && new Date(task.scheduledAt).getTime() <= now) runNow(task);
  }, 20000).unref();
}

function notify(task) {
  const url = store.db.settings.notifyWebhook;
  if (!url) return;
  const body = JSON.stringify({
    event: 'mediahub.task.finished',
    taskId: task.id,
    title: task.base?.title || task.contentSnapshot?.title || '',
    status: task.status,
    success: task.targets.filter((target) => target.status === 'success').length,
    total: task.targets.length,
    attention: task.targets.filter((target) => ['failed', 'uncertain', 'needs_user_action'].includes(target.status)).map((target) => ({ platform: target.platformId, status: target.status, message: target.message })),
  });
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(10000) }).catch((error) => console.error('[通知失败]', error.message));
}

module.exports = { enqueue, retryTargets, runNow, recover, startScheduler, finalStatus, resolveFields };
