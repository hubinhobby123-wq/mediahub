// 模拟联调适配器：不请求真实平台，完整走一遍「校验 -> 提交 -> 生成草稿」流程。
// 用途：先跑通整体分发工作流，真实接入时替换为对应平台的 adapter 即可。
const crypto = require('crypto');

const RULES = {
  douyin: { maxTitle: 55, requireVideo: true },
  kuaishou: { maxTitle: 50, requireVideo: true },
  bilibili: { maxTitle: 80, requireVideo: true },
  shipinhao: { maxTitle: 30, requireVideo: true },
  xiaohongshu: { maxTitle: 20 },
  toutiao: { maxTitle: 30 },
  baijiahao: { maxTitle: 40 },
  zhihu: { maxTitle: 100 },
  weibo: { maxTitle: 30 },
  tiktok_global: { maxTitle: 100, requireVideo: true },
  instagram: { maxTitle: 125, requireVideo: true },
  twitter: { maxTitle: 100 },
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function verify(account) {
  await sleep(200 + Math.random() * 300);
  return { ok: true, status: 'active', message: '验证通过（模拟联调，未请求真实平台）' };
}

async function publish(ctx) {
  const { platform, content, fields, logger } = ctx;
  const rule = RULES[platform.id] || {};
  logger('进入模拟联调通道（不请求真实平台接口）');

  if (content.type === 'video') {
    if (rule.requireVideo && !content.videoFile) throw new Error('该平台要求上传视频文件');
    if (content.videoFile) logger(`校验视频：${content.videoFile.name}（${(content.videoFile.size / 1048576).toFixed(1)} MB）`);
  } else if (!content.body && !(content.images && content.images.length)) {
    throw new Error('图文内容缺少正文和配图，无法发布');
  }

  const title = (fields.title || '').trim();
  if (!title) throw new Error('标题不能为空');
  const maxTitle = (platform.limits && platform.limits.title) || rule.maxTitle;
  if (maxTitle && title.length > maxTitle) {
    logger(`提示：标题 ${title.length} 字，超过该平台建议的 ${maxTitle} 字，实际发布时可能被截断`);
  }
  logger(`提交标题：${title}`);
  if (fields.tags && fields.tags.length) logger(`话题标签：${fields.tags.join(' / ')}`);

  await sleep(600 + Math.random() * 1200);
  const externalId = `sim-${platform.id}-${crypto.randomBytes(4).toString('hex')}`;
  logger(`草稿创建成功，草稿 ID：${externalId}`);
  return { ok: true, status: 'simulated', externalId, message: '模拟流程完成，未请求真实平台' };
}

module.exports = { verify, publish };
