const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const store = require('../store');

const DEFAULTS = {
  node: process.execPath,
  articleScript: '',
  articleConfig: '',
  videoScript: '',
  videoConfig: '',
};

function settings() {
  return {
    node: process.env.MEDIAHUB_SKILL_NODE || DEFAULTS.node,
    articleScript: process.env.MEDIAHUB_ARTICLE_SCRIPT || DEFAULTS.articleScript,
    articleConfig: process.env.MEDIAHUB_ARTICLE_CONFIG || DEFAULTS.articleConfig,
    videoScript: process.env.MEDIAHUB_VIDEO_SCRIPT || DEFAULTS.videoScript,
    videoConfig: process.env.MEDIAHUB_VIDEO_CONFIG || DEFAULTS.videoConfig,
  };
}

function lastJsonObject(text) {
  let found = null, depth = 0, start = -1, inString = false, escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') inString = false; continue; }
    if (char === '"') inString = true;
    else if (char === '{') { if (depth === 0) start = i; depth += 1; }
    else if (char === '}' && depth > 0) { depth -= 1; if (depth === 0 && start >= 0) { try { found = JSON.parse(text.slice(start, i + 1)); } catch {} } }
  }
  return found;
}

function run(executable, args, { signal, logger }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true });
    let stdout = '', stderr = '', settled = false;
    const finishReject = (error) => { if (!settled) { settled = true; reject(error); } };
    const abort = () => { child.kill('SIGTERM'); const error = new Error('执行已取消，远端结果需要核查'); error.code = 'ABORTED'; finishReject(error); };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); for (const line of chunk.toString().split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(-6)) logger(line.slice(0, 500)); });
    child.on('error', finishReject);
    child.on('close', (code) => { signal?.removeEventListener('abort', abort); if (!settled) { settled = true; resolve({ code, stdout, stderr }); } });
  });
}

async function verify() { return { ok: true, status: 'runtime_check', message: '账号登录态将在任务执行前由对应 Skill 检查' }; }

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
function copyDirectory(source, destination) { fs.cpSync(source, destination, { recursive: true, force: true }); }

// 每个任务使用自己的运行目录。编辑内容不会反写 Hermes 原始适配包，也不会影响已创建的其他任务。
function materializeArticleRun(ctx, platformId) {
  const safeRevision = String(ctx.content.revisionId || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '_');
  const runRoot = path.join(store.DATA_DIR, 'task-runs', safeRevision);
  const runDirectory = path.join(runRoot, `${platformId}-${crypto.randomUUID()}`);
  const bundle = ctx.content.skillBundle;
  if (bundle?.runDirectory && fs.existsSync(bundle.runDirectory)) {
    fs.mkdirSync(runRoot, { recursive: true });
    copyDirectory(bundle.runDirectory, runDirectory);
  } else {
    fs.mkdirSync(runDirectory, { recursive: true });
    const source = path.join(runDirectory, 'source.md');
    fs.writeFileSync(source, ctx.fields.body || '', 'utf8');
    writeJson(path.join(runDirectory, 'manifest.json'), {
      runDirectory, sourcePath: source, title: ctx.fields.title || ctx.content.title,
      description: ctx.fields.desc || '', tags: ctx.fields.tags || [], platforms: [platformId],
      draftFiles: { [platformId]: path.join(runDirectory, platformId, 'article.md') },
    });
  }
  const manifestPath = path.join(runDirectory, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    const source = path.join(runDirectory, 'source.md');
    if (!fs.existsSync(source)) fs.writeFileSync(source, ctx.fields.body || '', 'utf8');
    writeJson(manifestPath, { runDirectory, sourcePath: source, title: ctx.content.title, description: '', tags: [], platforms: [platformId], draftFiles: {} });
  }
  const manifest = readJson(manifestPath);
  const oldDraft = manifest.draftFiles?.[platformId];
  const draft = oldDraft && bundle?.runDirectory && path.resolve(oldDraft).startsWith(path.resolve(bundle.runDirectory))
    ? path.join(runDirectory, path.relative(bundle.runDirectory, oldDraft))
    : path.join(runDirectory, platformId, 'article.md');
  fs.mkdirSync(path.dirname(draft), { recursive: true });
  fs.writeFileSync(draft, ctx.fields.body || '', 'utf8');
  manifest.runDirectory = runDirectory;
  manifest.title = ctx.fields.title || ctx.content.title;
  manifest.description = ctx.fields.desc || '';
  manifest.tags = ctx.fields.tags || [];
  manifest.platforms = [platformId];
  manifest.draftFiles = { [platformId]: draft };
  writeJson(manifestPath, manifest);
  return runDirectory;
}

function accountConfig(ctx, configPath, isArticle, platformId) {
  const config = readJson(configPath);
  const runtimeAccount = ctx.account.runtimeAccount;
  if (!runtimeAccount) return configPath;
  if (isArticle) {
    if (platformId !== 'toutiao') {
      const defaultAccount = config.toutiaoAccount || 'default';
      if (runtimeAccount !== defaultAccount) throw new Error('此图文通道当前不支持独立账号会话；请使用其默认账号，或通过 Hermes 原 Skill 分发。');
    } else config.toutiaoAccount = runtimeAccount;
  } else {
    config.accounts ||= {};
    config.accounts[platformId] = runtimeAccount;
  }
  const destination = path.join(store.DATA_DIR, 'runtime-configs', `${ctx.account.id}-${platformId}-${crypto.randomUUID()}.json`);
  writeJson(destination, config);
  return destination;
}

async function publish(ctx) {
  if (ctx.operation !== 'save_draft') return { ok: false, status: 'unsupported', retryable: false, message: 'Skill 通道只支持保存草稿' };
  const cfg = settings();
  const isArticle = ctx.content.type === 'article';
  const platformId = ctx.platform.skillPlatform || ctx.platform.id;
  const script = isArticle ? cfg.articleScript : cfg.videoScript;
  let runDirectory = ctx.content.skillBundle?.runDirectory;
  let config = isArticle ? cfg.articleConfig : cfg.videoConfig;
  let temporaryConfig = null;
  try {
    if (isArticle) runDirectory = materializeArticleRun(ctx, platformId);
    if (!runDirectory) return { ok: false, status: 'failed', retryable: false, message: '视频内容缺少经过校验的 Skill 适配包' };
    temporaryConfig = accountConfig(ctx, config, isArticle, platformId);
    config = temporaryConfig;
    ctx.logger(`调用 ${isArticle ? 'article-publisher' : 'video-publisher'}：${platformId} / ${ctx.account.runtimeAccount || '默认账号'}`);
    const result = await run(cfg.node, [script, 'publish', '--run-dir', runDirectory, '--platforms', platformId, '--config', config], { signal: ctx.signal, logger: ctx.logger });
    const payload = lastJsonObject(result.stdout);
    const item = payload?.results?.[platformId];
    if (result.code === 0 && item?.status === 'success') return { ok: true, status: 'success', externalId: item.mediaId || item.url || '', evidence: { resultFile: path.join(runDirectory, 'publish-result.json'), url: item.url || null, mediaId: item.mediaId || null }, message: item.url ? `草稿已确认：${item.url}` : '草稿已确认保存' };
    if (item?.status === 'needs_user_action') return { ok: false, status: 'needs_user_action', retryable: false, message: item.error || '需要登录或人工处理' };
    if (item?.status === 'blocked_no_safe_draft_adapter') return { ok: false, status: 'unsupported', retryable: false, message: item.error || '没有安全草稿适配器' };
    return { ok: false, status: result.code === 0 ? 'uncertain' : 'failed', retryable: false, message: item?.error || result.stderr.trim().slice(-1200) || '未获得草稿保存证据' };
  } finally {
    if (temporaryConfig && temporaryConfig !== (isArticle ? cfg.articleConfig : cfg.videoConfig)) {
      try { fs.unlinkSync(temporaryConfig); } catch {}
    }
  }
}

module.exports = { verify, publish, lastJsonObject };
