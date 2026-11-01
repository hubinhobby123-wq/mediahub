// 微信公众号官方适配器：通过公众平台「草稿箱」API 将图文存入草稿箱
// 流程：access_token -> 封面上传永久素材(add_material) -> 正文配图上传(uploadimg) -> draft/add
const fs = require('fs');
const path = require('path');

const API_BASE = process.env.WECHAT_API_BASE || 'https://api.weixin.qq.com/cgi-bin';
const tokenCache = new Map(); // accountId -> { token, expiresAt }

const ERR_TEXT = {
  40001: 'AppSecret 不正确，或账号无该接口权限',
  40013: 'AppID 不正确',
  42001: 'access_token 已过期',
  45009: '接口调用次数超过当日配额',
  48001: '该账号没有「草稿箱」API 权限（需已认证的订阅号/服务号）',
  53401: '草稿字段超出限制（标题/摘要长度等）',
  53402: '正文存在不符合规范的内容',
  53404: '草稿被判定为无法保存',
};

function wxError(data) {
  if (data && data.errcode) {
    return `${ERR_TEXT[data.errcode] || '微信接口错误'}（errcode=${data.errcode}${data.errmsg ? '，' + data.errmsg : ''}）`;
  }
  return '微信接口返回异常';
}

async function requestJSON(url, options = {}) {
  let res;
  try {
    res = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw new Error(`网络请求失败（${e.message}）。请检查本机网络，以及公众平台后台是否已将本机出口 IP 加入 IP 白名单`);
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`微信接口返回非 JSON 响应（HTTP ${res.status}）`);
  }
  return data;
}

async function getToken(account, force = false) {
  const cred = account.credentials || {};
  if (!cred.appId || !cred.appSecret) throw new Error('该账号未配置 AppID / AppSecret');
  const hit = tokenCache.get(account.id);
  if (!force && hit && hit.expiresAt > Date.now() + 60000) return hit.token;
  const url = `${API_BASE}/token?grant_type=client_credential&appid=${encodeURIComponent(cred.appId)}&secret=${encodeURIComponent(cred.appSecret)}`;
  const data = await requestJSON(url);
  if (!data.access_token) throw new Error(wxError(data));
  tokenCache.set(account.id, {
    token: data.access_token,
    expiresAt: Date.now() + ((data.expires_in || 7200) - 180) * 1000,
  });
  return data.access_token;
}

async function uploadImage(ctx, token, file, permanent) {
  const filePath = path.join(ctx.uploadRoot, path.basename(file.path || ''));
  const buf = await fs.promises.readFile(filePath);
  const form = new FormData();
  form.append('media', new Blob([buf], { type: file.mime || 'image/jpeg' }), file.name || 'image.jpg');
  const api = permanent
    ? `${API_BASE}/material/add_material?access_token=${token}&type=image`
    : `${API_BASE}/media/uploadimg?access_token=${token}`;
  const data = await requestJSON(api, { method: 'POST', body: form });
  if (permanent && data.media_id) return { mediaId: data.media_id };
  if (!permanent && data.url) return { url: data.url };
  throw new Error(wxError(data));
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 纯文本正文 -> 公众号 HTML：空行分段，段内换行转 <br/>，配图追加在文末
function bodyToHtml(body, imageUrls) {
  const paras = String(body || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 16px 0;">${escapeHtml(p).replace(/\n/g, '<br/>')}</p>`);
  for (const u of imageUrls) paras.push(`<p style="text-align:center;"><img src="${u}" style="max-width:100%;"/></p>`);
  return paras.join('') || '<p></p>';
}

async function verify(account) {
  try {
    const token = await getToken(account);
    const data = await requestJSON(`${API_BASE}/draft/count?access_token=${token}`);
    if (data && typeof data.draft_count === 'number') {
      return { ok: true, status: 'active', message: `连接成功，草稿箱现有 ${data.draft_count} 篇草稿` };
    }
    if (data && data.errcode === 48001) {
      return { ok: true, status: 'active', message: '凭据有效，但该账号暂无草稿箱 API 权限（需认证公众号）' };
    }
    return { ok: false, status: 'invalid', message: wxError(data) };
  } catch (e) {
    return { ok: false, status: 'invalid', message: e.message };
  }
}

async function publish(ctx) {
  const { account, content, fields, logger, uploadRoot } = ctx;
  if (content.type !== 'article') throw new Error('微信公众号适配器当前仅支持图文内容');
  if (!content.coverFile) throw new Error('公众号草稿必须包含封面图，请先在内容库中为该图文设置封面');

  let token = await getToken(account);
  logger('已获取 access_token');

  let title = (fields.title || '').trim();
  if (!title) throw new Error('标题不能为空');
  if (title.length > 64) {
    title = title.slice(0, 64);
    logger('提示：标题超过 64 字，已截断');
  }
  let digest = (fields.desc || '').trim();
  if (digest.length > 120) {
    digest = digest.slice(0, 120);
    logger('提示：摘要超过 120 字，已截断');
  }
  if (!digest) digest = String(content.body || '').replace(/\s+/g, ' ').slice(0, 54);

  logger('上传封面图到永久素材库…');
  const cover = await uploadImage({ uploadRoot }, token, content.coverFile, true);

  const imageUrls = [];
  for (const img of content.images || []) {
    logger(`上传正文配图：${img.name}`);
    const r = await uploadImage({ uploadRoot }, token, img, false);
    imageUrls.push(r.url);
  }
  if (!content.body && !imageUrls.length) logger('提示：正文与配图均为空');
  const html = bodyToHtml(content.body, imageUrls);

  const article = {
    title,
    author: account.name || '',
    digest,
    content: html,
    thumb_media_id: cover.mediaId,
    need_open_comment: 0,
    only_fans_can_comment: 0,
  };
  const send = (tk) =>
    requestJSON(`${API_BASE}/draft/add?access_token=${tk}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articles: [article] }),
    });

  logger('创建草稿…');
  let data = await send(token);
  if (data && (data.errcode === 42001 || data.errcode === 40001)) {
    logger('access_token 失效，重新获取后重试…');
    token = await getToken(account, true);
    data = await send(token);
  }
  if (data && data.media_id) {
    logger(`草稿创建成功，media_id：${data.media_id}`);
    return { ok: true, externalId: data.media_id, message: '已存入公众号草稿箱' };
  }
  throw new Error(wxError(data));
}

module.exports = { verify, publish };
