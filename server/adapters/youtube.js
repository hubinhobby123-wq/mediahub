// YouTube 官方适配器：YouTube Data API v3（refresh_token 换 access_token，OAuth 2.0）
// 「草稿」语义：YouTube 没有草稿箱，默认上传为 private（私享）视频，
// 可在 YouTube Studio 中继续编辑标题/封面/可见性后再公开。
const fs = require('fs');
const path = require('path');

const API = process.env.YT_API_URL || 'https://www.googleapis.com/youtube/v3';
const UPLOAD = process.env.YT_UPLOAD_URL || 'https://www.googleapis.com/upload/youtube/v3';
const OAUTH_URL = process.env.YT_OAUTH_URL || 'https://oauth2.googleapis.com/token';
const PRIVACY = new Set(['private', 'unlisted', 'public']);
const tokenCache = new Map(); // accountId -> { token, exp }

async function httpJSON(url, options = {}) {
  let res;
  try {
    res = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw new Error(`网络请求失败（${e.message}），请检查本机网络与代理设置`);
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Google 接口返回非 JSON 响应（HTTP ${res.status}）`);
  }
  return { status: res.status, data };
}

async function getToken(account, force = false) {
  const c = account.credentials || {};
  if (!c.clientId || !c.clientSecret || !c.refreshToken) {
    throw new Error('该账号未配置完整的 OAuth 凭据（Client ID / Client Secret / Refresh Token）');
  }
  const hit = tokenCache.get(account.id);
  if (!force && hit && hit.exp > Date.now() + 60000) return hit.token;
  const body = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    refresh_token: c.refreshToken,
    grant_type: 'refresh_token',
  });
  const { status, data } = await httpJSON(OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!data.access_token) {
    if (data.error === 'invalid_grant') throw new Error('refresh_token 无效或已过期，请重新走 OAuth 授权获取');
    throw new Error(`获取 access_token 失败：${data.error_description || data.error || 'HTTP ' + status}`);
  }
  tokenCache.set(account.id, { token: data.access_token, exp: Date.now() + ((data.expires_in || 3600) - 120) * 1000 });
  return data.access_token;
}

async function verify(account) {
  try {
    const token = await getToken(account);
    const { status, data } = await httpJSON(`${API}/channels?part=snippet&mine=true`, {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (status === 401 || status === 403) {
      const msg = (data.error && data.error.message) || 'HTTP ' + status;
      return { ok: false, status: 'invalid', message: '凭据被拒绝：' + msg };
    }
    const ch = data.items && data.items[0];
    if (ch) return { ok: true, status: 'active', message: `已连接频道：${(ch.snippet && ch.snippet.title) || ch.id}` };
    return { ok: false, status: 'invalid', message: '未找到所属频道（该 Google 账号可能尚未创建 YouTube 频道）' };
  } catch (e) {
    return { ok: false, status: 'invalid', message: e.message };
  }
}

async function publish(ctx) {
  const { account, content, fields, logger, uploadRoot } = ctx;
  if (content.type !== 'video') throw new Error('YouTube 适配器仅支持视频内容');
  if (!content.videoFile) throw new Error('缺少视频文件');

  const abs = path.join(uploadRoot, path.basename(content.videoFile.path));
  if (!fs.existsSync(abs)) throw new Error('视频文件已丢失：' + content.videoFile.name);
  const size = fs.statSync(abs).size;
  if (!size) throw new Error('视频文件为空');

  const c = account.credentials || {};
  const privacy = PRIVACY.has(c.privacy) ? c.privacy : 'private';

  let title = (fields.title || '').trim();
  if (!title) throw new Error('标题不能为空');
  if (title.length > 100) {
    title = title.slice(0, 100);
    logger('提示：标题超过 100 字符，已截断');
  }
  const tags = (fields.tags || []).slice(0, 15);
  const descParts = [];
  if (fields.desc) descParts.push(fields.desc);
  if (content.body) descParts.push(content.body);
  if (tags.length) descParts.push(tags.map((t) => '#' + t.replace(/\s+/g, '')).join(' '));
  const description = descParts.join('\n\n').slice(0, 4900);

  const metadata = {
    snippet: { title, description, tags, categoryId: '22' },
    status: { privacyStatus: privacy, selfDeclaredMadeForKids: false },
  };

  let token = await getToken(account);
  logger('已获取 access_token（YouTube Data API v3）');

  const init = (tk) =>
    fetch(`${UPLOAD}/videos?uploadType=resumable&part=snippet,status`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + tk,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(size),
        'X-Upload-Content-Type': content.videoFile.mime || 'video/mp4',
      },
      body: JSON.stringify(metadata),
      signal: AbortSignal.timeout(20000),
    });
  let res = await init(token);
  if (res.status === 401) {
    logger('access_token 失效，刷新后重试…');
    token = await getToken(account, true);
    res = await init(token);
  }
  const location = res.headers.get('location');
  if (!location) {
    let extra = '';
    try {
      extra = (await res.json()).error.message || '';
    } catch {}
    throw new Error(`创建上传会话失败（HTTP ${res.status}）${extra ? '：' + extra : ''}`);
  }

  const privacyText = privacy === 'private' ? '私享' : privacy === 'unlisted' ? '不公开列出' : '公开';
  logger(`上传会话已建立，开始传输 ${content.videoFile.name}（${(size / 1048576).toFixed(1)} MB，可见性：${privacyText}）`);

  const mime = content.videoFile.mime || 'video/mp4';
  let putRes;
  if (size <= 512 * 1048576) {
    putRes = await fetch(location, {
      method: 'PUT',
      headers: { 'Content-Type': mime },
      body: await fs.promises.readFile(abs),
    });
  } else {
    const { Readable } = require('stream');
    putRes = await fetch(location, {
      method: 'PUT',
      headers: { 'Content-Type': mime },
      body: Readable.toWeb(fs.createReadStream(abs)),
      duplex: 'half',
    });
  }

  let data = null;
  try {
    data = await putRes.json();
  } catch {}
  if (!data || !data.id) {
    const msg = data && data.error && data.error.message;
    throw new Error(`视频上传失败（HTTP ${putRes.status}）${msg ? '：' + msg : ''}`);
  }
  logger(`上传完成，视频 ID：${data.id}`);
  return {
    ok: true,
    externalId: data.id,
    message: `已上传为${privacyText}视频：https://youtu.be/${data.id}`,
  };
}

module.exports = { verify, publish, getToken, httpJSON };
