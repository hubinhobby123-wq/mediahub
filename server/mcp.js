// MCP（Model Context Protocol）服务器：无状态 Streamable HTTP，端点 /mcp
// 让 ZCode / Claude 等 AI Agent 用标准协议调用内容分发能力，无需任何云端依赖。
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const { PLATFORMS } = require('./platforms');
const { createDistribution } = require('./taskService');
const engine = require('./engine');
const { importBundle } = require('./bundles');

const PROTOCOL = '2025-06-18';
const router = express.Router();

// 可选鉴权：设置环境变量 MEDIAHUB_TOKEN 后，MCP 调用须带 Authorization: Bearer <token> 或 x-mediahub-token
router.use((req, res, next) => {
  const expected = process.env.MEDIAHUB_TOKEN;
  if (!expected) return next();
  const got = String(req.headers['x-mediahub-token'] || '').replace(/^Bearer\s+/i, '');
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (got === expected || auth === expected) return next();
  return res.status(401).json({ error: '未授权：缺少或错误的 MEDIAHUB_TOKEN' });
});

const ALLOWED_EXT = new Set([
  '.mp4', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.m4v', '.webm', '.ts',
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp',
]);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.m4v', '.webm', '.ts']);

function normTags(tags) {
  if (typeof tags === 'string') return tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(tags)) return tags.map((s) => String(s).trim()).filter(Boolean);
  return [];
}

// 把 Agent 提供的本地文件收进素材库（复制而非移动）
function ingestFile(absPath) {
  if (!absPath || typeof absPath !== 'string') throw new Error('缺少文件路径');
  const ext = path.extname(absPath).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) throw new Error(`不支持的文件格式：${ext || '未知'}`);
  if (!fs.existsSync(absPath)) throw new Error(`文件不存在：${absPath}`);
  const destName = Date.now().toString(36) + '-' + crypto.randomBytes(5).toString('hex') + ext;
  fs.copyFileSync(absPath, path.join(store.UPLOAD_DIR, destName));
  const stat = fs.statSync(absPath);
  const isVideo = VIDEO_EXT.has(ext);
  const rec = {
    id: store.nextId(),
    name: path.basename(absPath),
    path: 'uploads/' + destName,
    size: stat.size,
    mime: isVideo ? 'video/mp4' : 'image/jpeg',
    kind: isVideo ? 'video' : 'image',
    createdAt: store.now(),
  };
  store.db.files.push(rec);
  store.save();
  return rec;
}

function fileRef(rec) {
  return rec ? { id: rec.id, name: rec.name, path: rec.path, size: rec.size, mime: rec.mime } : null;
}

function createContentRecord({ type, title, desc, tags, body, videoRec, coverRec, imageRecs }) {
  if (!title || !String(title).trim()) throw new Error('标题不能为空');
  if (type === 'video' && !videoRec) throw new Error('视频内容需要提供视频文件（filePath）');
  const rec = {
    id: store.nextId(),
    type,
    title: String(title).trim(),
    desc: String(desc || ''),
    tags: normTags(tags).slice(0, 20),
    body: String(body || ''),
    videoFile: fileRef(videoRec),
    coverFile: fileRef(coverRec),
    images: (imageRecs || []).slice(0, 9).map(fileRef),
    createdAt: store.now(),
    updatedAt: store.now(),
  };
  store.db.contents.push(rec);
  store.save();
  return rec;
}

const TOOLS = [
  {
    name: 'mediahub_video_batch_plan', description: '只读生成成品包/账号组批量投递清单，区分可执行、浏览器待办、人工和防重跳过；不上传',
    inputSchema: {type:'object',properties:{packageId:{type:'string'},accountGroupId:{type:'string'},jobIds:{type:'array',items:{type:'string'}}},required:['packageId']},
    run: a => require('./videoRoutes').service.planBatch(a),
  },
  {
    name: 'mediahub_video_batch_prepare', description: '按明确账号组和作品/账号选择批量绑定；先完整版后切片，多个锚点需指定。不上传不公开。',
    inputSchema: {type:'object',properties:{packageId:{type:'string'},accountGroupId:{type:'string'},selections:{type:'array',items:{type:'object',properties:{unitId:{type:'string'},accountId:{type:'string'},anchorJobId:{type:'string'},anchorAccountId:{type:'string'}},required:['unitId','accountId']}}},required:['packageId','accountGroupId','selections']},
    run: a => require('./videoRoutes').service.prepareBatch(a),
  },
  {
    name: 'mediahub_video_batch_deliver', description: '用户授权上传后，顺序执行明确jobIds的已接通草稿/API私密通道。浏览器任务仅返回待办，Agent须实际操作；已保存/异常/执行中均跳过，绝不公开。',
    inputSchema: {type:'object',properties:{packageId:{type:'string'},accountGroupId:{type:'string'},jobIds:{type:'array',items:{type:'string'}},confirmed:{type:'boolean'},allowPrivate:{type:'boolean'}},required:['packageId','jobIds','confirmed']},
    run: a => require('./videoRoutes').service.deliverBatch(a),
  },
  {
    name: 'mediahub_video_reconcile_nonpublic', description: '只登记已经存在的准确草稿/私密作品，不上传。不确定记录必须先实际核对账号、作品与可见性；保留旧失败证据，预览告警单独记录，不批准公开。',
    inputSchema: {type:'object',properties:{jobId:{type:'string'},id:{type:'string'},url:{type:'string'},state:{type:'string',enum:['draft','private']},ownerConfirmed:{type:'boolean'},visibilityConfirmed:{type:'boolean'},observedAccountId:{type:'string'},evidence:{type:'string'},browserSession:{type:'string'},previewWarning:{type:'string'}},required:['jobId','url','state','ownerConfirmed','visibilityConfirmed','observedAccountId','evidence']},
    run: a => require('./videoRoutes').service.reconcile(a.jobId,a),
  },
  {
    name: 'mediahub_video_board', description: '查看平台专版视频、投递记录及北京时间3h/2h依赖排期；不公开发布',
    inputSchema: { type: 'object', properties: {} },
    run: () => require('./videoRoutes').service.snapshot(),
  },
  {
    name: 'mediahub_import_video_handoff', description: '校验并导入video-handoff.json平台专版成品包；不上传、不批准、不调用旧单视频分发',
    inputSchema: { type: 'object', properties: { manifestPath: { type: 'string' } }, required: ['manifestPath'] },
    run: a => require('./videoRoutes').service.importPackage(a.manifestPath),
  },
  {
    name: 'mediahub_bind_video_unit', description: '将特定unit绑定明确账号；先完整版后切片；不上传不公开',
    inputSchema: { type: 'object', properties: { packageId: {type:'string'}, unitId: {type:'string'}, platformId: {type:'string'}, accountId: {type:'string'}, anchorJobId: {type:'string'} }, required: ['packageId','unitId','platformId','accountId'] },
    run: a => require('./videoRoutes').service.bind(a),
  },
  {
    name: 'mediahub_video_save_draft', description: '仅首次保存绑定作品的草稿；需用户授权上传；目前仅安全适配器douyin/shipinhao；不确定结果不可重试',
    inputSchema: {type:'object',properties:{jobId:{type:'string'}},required:['jobId']},
    run: a => require('./videoRoutes').service.uploadDraft(a.jobId),
  },
  {
    name: 'mediahub_video_deliver_nonpublic', description: '首次投递平台专版：优先草稿；allowPrivate=true才允许已接入的YouTube私享上传。绝不公开或unlisted；浏览器通道需另用begin/finish。需用户授权上传。',
    inputSchema: {type:'object',properties:{jobId:{type:'string'},allowPrivate:{type:'boolean',default:false}},required:['jobId']},
    run: a => require('./videoRoutes').service.deliverNonPublic(a.jobId, a),
  },
  {
    name: 'mediahub_video_browser_begin', description: '锁定B站/快手/小红书首次浏览器投递，返回素材及leaseId；本工具不上传。Agent需实际核查账号/条款，优先草稿，授权后才私密。',
    inputSchema: {type:'object',properties:{jobId:{type:'string'},allowPrivate:{type:'boolean',default:false}},required:['jobId']},
    run: a => require('./videoRoutes').service.beginBrowserDelivery(a.jobId, a),
  },
  {
    name: 'mediahub_video_browser_finish', description: '仅在平台重新打开实际草稿或核查仅自己可见后回填；不是审核批准，不是公开证据。没有准确ID时草稿只记保存证据，不伪造链接。',
    inputSchema: {type:'object',properties:{jobId:{type:'string'},leaseId:{type:'string'},state:{type:'string',enum:['draft','private']},observedAccountId:{type:'string'},videoSha256:{type:'string'},remoteId:{type:'string'},url:{type:'string'},evidence:{type:'string'},browserSession:{type:'string'},warnings:{type:'array',items:{type:'string'}}},required:['jobId','leaseId','state','observedAccountId','videoSha256','evidence','browserSession']},
    run: a => require('./videoRoutes').service.finishBrowserDelivery(a.jobId, a),
  },
  {
    name: 'mediahub_video_browser_block', description: '浏览器投递失败或需用户接手时保留不确定状态，禁止自动重传。投递中必须leaseId；已完成浏览器投递或安全CLI草稿的后台复核失败时可不传leaseId并明确invalidateSavedEvidence=true，保留原证据/作品引用，不解锁。',
    inputSchema: {type:'object',properties:{jobId:{type:'string'},leaseId:{type:'string'},reason:{type:'string'},invalidateSavedEvidence:{type:'boolean',default:false}},required:['jobId','reason']},
    run: a => require('./videoRoutes').service.blockBrowserDelivery(a.jobId, a),
  },
  {
    name: 'mediahub_video_inspect_public', description: '只读核查YouTube现存作品的真实公开状态；不执行公开操作',
    inputSchema: {type:'object',properties:{jobId:{type:'string'}},required:['jobId']},
    run: a => require('./videoRoutes').service.inspect(a.jobId),
  },
  {
    name: 'mediahub_list_platforms',
    description: '列出所有支持的分发平台（含平台 ID、名称、支持的内容类型、接入模式）',
    inputSchema: { type: 'object', properties: {} },
    run: () => PLATFORMS.map((p) => ({ id: p.id, name: p.name, capabilities: p.capabilities, mode: p.mode, draftSupport: p.draftSupport, hint: p.hint })),
  },
  {
    name: 'mediahub_import_bundle',
    description: '导入 article-publisher 或 video-publisher 生成并已校验的 mediahub-bundle.json；使用本机绝对路径',
    inputSchema: {
      type: 'object',
      properties: { bundlePath: { type: 'string', description: 'mediahub-bundle.json 的本机绝对路径' } },
      required: ['bundlePath'],
    },
    run: (a) => {
      const result = importBundle(a.bundlePath);
      return { contentId: result.content.id, title: result.content.title, type: result.content.type, created: result.created, platforms: Object.keys(result.content.platformVersions || {}) };
    },
  },
  {
    name: 'mediahub_list_accounts',
    description: '列出已添加的平台账号（含账号 ID、所属平台、验证状态）',
    inputSchema: { type: 'object', properties: {} },
    run: () => store.db.accounts.map((a) => ({ id: a.id, platform: a.platformId, name: a.name, status: a.status })),
  },
  {
    name: 'mediahub_list_contents',
    description: '列出内容库中的所有作品',
    inputSchema: { type: 'object', properties: {} },
    run: () => store.db.contents.map((c) => ({ id: c.id, type: c.type, title: c.title, createdAt: c.createdAt })),
  },
  {
    name: 'mediahub_create_video_content',
    description: '用本地视频文件创建视频内容。filePath/coverPath 传本机绝对路径，服务会复制进素材库',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '内容标题' },
        filePath: { type: 'string', description: '视频文件的绝对路径' },
        coverPath: { type: 'string', description: '封面图绝对路径（可选）' },
        desc: { type: 'string', description: '简介（可选）' },
        tags: { type: 'array', items: { type: 'string' }, description: '话题标签（可选）' },
      },
      required: ['title', 'filePath'],
    },
    run: (a) => {
      const videoRec = ingestFile(a.filePath);
      const coverRec = a.coverPath ? ingestFile(a.coverPath) : null;
      const rec = createContentRecord({
        type: 'video', title: a.title, desc: a.desc, tags: a.tags,
        videoRec, coverRec,
      });
      return { contentId: rec.id, title: rec.title };
    },
  },
  {
    name: 'mediahub_create_article_content',
    description: '创建图文内容（正文文本，可选封面与配图）',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string', description: '正文（纯文本，空行分段）' },
        coverPath: { type: 'string', description: '封面图绝对路径（可选，公众号必需）' },
        imagePaths: { type: 'array', items: { type: 'string' }, description: '配图绝对路径，最多 9 张（可选）' },
        desc: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'body'],
    },
    run: (a) => {
      const coverRec = a.coverPath ? ingestFile(a.coverPath) : null;
      const imageRecs = (a.imagePaths || []).map((p) => ingestFile(p));
      const rec = createContentRecord({
        type: 'article', title: a.title, desc: a.desc, tags: a.tags, body: a.body,
        coverRec, imageRecs,
      });
      return { contentId: rec.id, title: rec.title };
    },
  },
  {
    name: 'mediahub_get_content',
    description: '查看某个内容的完整信息（标题、正文、标签、素材文件名等）',
    inputSchema: {
      type: 'object',
      properties: { contentId: { type: 'string' } },
      required: ['contentId'],
    },
    run: (a) => {
      const c = store.db.contents.find((x) => x.id === a.contentId);
      if (!c) throw new Error('内容不存在：' + a.contentId);
      return {
        id: c.id,
        type: c.type,
        title: c.title,
        desc: c.desc,
        tags: c.tags,
        body: c.body,
        video: c.videoFile && c.videoFile.name,
        cover: c.coverFile && c.coverFile.name,
        images: (c.images || []).map((i) => i.name),
        createdAt: c.createdAt,
      };
    },
  },
  {
    name: 'mediahub_publish',
    description: '把内容分发到指定账号的草稿箱。accountIds 与 platformIds 至少给一个；platformIds 会自动包含该平台下全部账号',
    inputSchema: {
      type: 'object',
      properties: {
        contentId: { type: 'string' },
        accountIds: { type: 'array', items: { type: 'string' } },
        platformIds: { type: 'array', items: { type: 'string' }, description: '平台 ID 列表（便捷方式）' },
        title: { type: 'string', description: '覆盖标题（可选）' },
        desc: { type: 'string', description: '覆盖简介（可选）' },
        tags: { type: 'array', items: { type: 'string' } },
        scheduleAt: { type: 'string', description: 'ISO 8601 定时时间，留空立即执行（可选）' },
        overrides: { type: 'object', description: '按平台 ID 提供标题、简介、标签、正文文件等覆盖值' },
        allowDuplicate: { type: 'boolean', description: '明确允许重复提交同一内容版本（默认 false）' },
      },
      required: ['contentId'],
    },
    run: (a) => {
      const r = createDistribution({
        contentId: a.contentId,
        accountIds: a.accountIds || [],
        platformIds: a.platformIds || [],
        base: { title: a.title, desc: a.desc, tags: a.tags },
        overrides: a.overrides || {},
        scheduleAt: a.scheduleAt || null,
        operation: 'save_draft',
        allowDuplicate: a.allowDuplicate === true,
      });
      if (!r.ok) throw new Error(r.error);
      return {
        taskId: r.task.id,
        status: r.task.status,
        targets: r.task.targets.map((t) => ({ platform: t.platformId, account: t.accountName, status: t.status })),
        hint: r.task.status === 'queued' ? '任务已进入队列，可用 mediahub_task_status 查询进度' : '任务已排期',
      };
    },
  },
  {
    name: 'mediahub_task_status',
    description: '查询分发任务状态，可包含每个平台目标的执行日志；waitSeconds>0 时会等到任务完成或超时再返回',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        includeLogs: { type: 'boolean', description: '是否返回日志（默认 false）' },
        waitSeconds: { type: 'number', description: '等待任务完成的最长秒数（0~120，默认 0 不等待）' },
      },
      required: ['taskId'],
    },
    run: async (a) => {
      const waitMs = Math.max(0, Math.min(120, Number(a.waitSeconds) || 0)) * 1000;
      const deadline = Date.now() + waitMs;
      let t = null;
      for (;;) {
        t = store.db.tasks.find((x) => x.id === a.taskId);
        if (!t) throw new Error('任务不存在：' + a.taskId);
        const busy = ['queued', 'running'].includes(t.status) || t.targets.some((x) => ['pending', 'running'].includes(x.status));
        if (!busy || Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      return {
        taskId: t.id,
        title: (t.base && t.base.title) || (t.contentSnapshot && t.contentSnapshot.title),
        status: t.status,
        scheduledAt: t.scheduledAt,
        finishedAt: t.finishedAt,
        targets: t.targets.map((x) => ({
          platform: x.platformId,
          account: x.accountName,
          status: x.status,
          message: x.message,
          externalId: x.externalId || undefined,
          evidence: x.evidence || undefined,
          logs: a.includeLogs ? (x.logs || []).slice(-20) : undefined,
        })),
      };
    },
  },
  {
    name: 'mediahub_retry_task',
    description: '重试某个分发任务中失败的平台目标',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
    },
    run: (a) => {
      const t = store.db.tasks.find((x) => x.id === a.taskId);
      if (!t) throw new Error('任务不存在：' + a.taskId);
      const failed = t.targets.filter((x) => x.status === 'failed');
      if (!failed.length) throw new Error('该任务没有失败的分发目标');
      engine.retryTargets(t, failed);
      return { retried: failed.length, taskId: t.id, hint: '可用 mediahub_task_status 查询进度' };
    },
  },
  {
    name: 'mediahub_list_tasks',
    description: '列出分发任务（新的在前）',
    inputSchema: { type: 'object', properties: {} },
    run: () =>
      [...store.db.tasks]
        .sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1))
        .map((t) => ({
          id: t.id,
          title: (t.base && t.base.title) || (t.contentSnapshot && t.contentSnapshot.title),
          status: t.status,
          createdAt: t.createdAt,
          success: t.targets.filter((x) => x.status === 'success').length,
          total: t.targets.length,
        })),
  },
];

// ---------- JSON-RPC 2.0 ----------
function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
    return rpcError(null, -32600, '无效的 JSON-RPC 请求');
  }
  switch (msg.method) {
    case 'initialize':
      return rpcResult(msg.id, {
        protocolVersion: (msg.params && msg.params.protocolVersion) || PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'mediahub', version: '0.2.0', title: 'MediaHub 自媒体分发工作台' },
        instructions: '通过 mediahub_* 工具管理内容并分发到各平台草稿箱。',
      });
    case 'ping':
      return rpcResult(msg.id, {});
    case 'tools/list':
      return rpcResult(msg.id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case 'tools/call': {
      const name = msg.params && msg.params.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return rpcError(msg.id, -32602, '未知工具：' + name);
      try {
        const out = await tool.run((msg.params && msg.params.arguments) || {});
        const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
        return rpcResult(msg.id, { content: [{ type: 'text', text }] });
      } catch (e) {
        // 工具执行失败按 MCP 规范返回 isError，而不是协议错误
        return rpcResult(msg.id, { content: [{ type: 'text', text: '错误：' + (e.message || e) }], isError: true });
      }
    }
    default:
      // 通知（无 id）静默接收；未知方法且带 id 才报错
      if (msg.id === undefined || msg.id === null) return null;
      return rpcError(msg.id, -32601, '未知方法：' + msg.method);
  }
}

router.post('/', async (req, res, next) => {
  try {
    const body = req.body;
    const isBatch = Array.isArray(body);
    const msgs = isBatch ? body : [body];
    const out = [];
    for (const m of msgs) {
      const r = await handleMessage(m);
      if (r) out.push(r);
    }
    if (isBatch) return res.json(out);
    if (!out.length) return res.status(202).end(); // 纯通知
    res.json(out[0]);
  } catch (e) {
    next(e);
  }
});

// 无状态实现：不提供 SSE 通道与会话
router.get('/', (req, res) => res.status(405).json({ error: 'MCP 无状态端点，仅支持 POST' }));
router.delete('/', (req, res) => res.status(405).end());

module.exports = router;
