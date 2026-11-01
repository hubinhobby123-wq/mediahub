const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const youtube = require('./youtube');
const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3';
function createPrivateUploader({ getToken = youtube.getToken, httpJSON = youtube.httpJSON, request = fetch } = {}) {
  async function uploadPrivate(account, unit, { onUploaded = () => {} } = {}) {
    const token = await getToken(account);
    const headers = { Authorization: `Bearer ${token}` };
    const owned = await httpJSON(`${API}/channels?part=id&mine=true`, { headers });
    if (owned.status !== 200 || owned.data.items?.length !== 1) throw new Error('需要明确唯一的OAuth所属频道；先核查授权与频道，未上传');
    const channelId = owned.data.items[0].id;
    const video = unit.artifacts.video;
    const stat = fs.statSync(video.absolutePath);
    if (!stat.size || !unit.copy.title || unit.copy.title.length > 100) throw new Error('视频为空或标题不满足YouTube要求，未上传');
    // Do not invent audience, originality, AI or licensing declarations.
    const metadata = { snippet: { title: unit.copy.title, description: unit.copy.description, tags: unit.copy.tags }, status: { privacyStatus: 'private' } };
    const start = await request(`${UPLOAD}/videos?uploadType=resumable&part=snippet,status`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-Upload-Content-Length': String(stat.size), 'X-Upload-Content-Type': 'video/mp4' },
      body: JSON.stringify(metadata), signal: AbortSignal.timeout(20000),
    });
    const location = start.headers.get('location');
    if (!start.ok || !location) throw new Error(`私享上传会话未建立 HTTP ${start.status}；核查后再操作`);
    const target = new URL(location);
    if (target.protocol !== 'https:' || !['www.googleapis.com', 'upload.youtube.com'].includes(target.hostname)) throw new Error('上传会话地址非官方允许主机，已停止');
    // Never retry an upload automatically: an interrupted PUT may already exist remotely.
    const response = await request(location, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: Readable.toWeb(fs.createReadStream(video.absolutePath)), duplex: 'half', signal: AbortSignal.timeout(30 * 60 * 1000) });
    const data = await response.json();
    if (!response.ok || !/^[\w-]{11}$/.test(data.id || '')) throw new Error('未收到准确YouTube视频ID；结果不确定，禁止重传');
    await onUploaded(data.id); // Persist remote ID even if subsequent verification fails.
    const found = await httpJSON(`${API}/videos?part=status,snippet&id=${data.id}`, { headers });
    const saved = found.data.items?.[0];
    if (found.status !== 200 || saved?.snippet?.channelId !== channelId || saved?.status?.privacyStatus !== 'private' || saved.status.publishAt) throw new Error('无法确认所属频道及仅自己可见状态；保留作品ID，禁止重传');
    const warnings = [];
    const cover = unit.artifacts.cover;
    if (cover) {
      try {
        const r = await request(`${UPLOAD}/thumbnails/set?videoId=${data.id}`, { method: 'POST', headers: { ...headers, 'Content-Type': path.extname(cover.absolutePath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg' }, body: await fs.promises.readFile(cover.absolutePath), signal: AbortSignal.timeout(30000) });
        if (!r.ok) warnings.push('私享视频已保存，但自定义封面未成功，请在后台设置');
      } catch { warnings.push('私享视频已保存，封面结果不确定，请在后台核查'); }
    }
    return { id: data.id, url: `https://www.youtube.com/watch?v=${data.id}`, state: 'private', channelId, uploadStatus: saved.status.uploadStatus, warnings };
  }
  uploadPrivate.preflight = async account => {
    const token = await getToken(account);
    const owned = await httpJSON(`${API}/channels?part=id&mine=true`, { headers: { Authorization: `Bearer ${token}` } });
    if (owned.status !== 200 || owned.data.items?.length !== 1) throw new Error('先配置并验证唯一的OAuth频道；尚未上传');
  };
  return uploadPrivate;
}
module.exports = { createPrivateUploader };
