const youtube = require('./youtube');
const API = 'https://www.googleapis.com/youtube/v3';
function createYoutubeLifecycle({ getToken = youtube.getToken, httpJSON = youtube.httpJSON } = {}) {
  async function call(account, resource, options = {}) {
    const token = await getToken(account);
    const { status, data } = await httpJSON(`${API}/${resource}`, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    if (status < 200 || status >= 300) throw new Error(`YouTube 请求被拒绝 HTTP ${status}：${data.error?.message || '需要核查授权范围'}`);
    return data;
  }
  async function inspect(account, remote) {
    if (!/^[\w-]{11}$/.test(remote.id || '')) throw new Error('需要准确的YouTube视频ID');
    const channels = await call(account, 'channels?part=id&mine=true');
    const data = await call(account, `videos?part=status,snippet&id=${remote.id}`);
    const video = data.items?.[0];
    if (!video || !channels.items?.some(c => c.id === video.snippet?.channelId)) throw new Error('视频不属于所选频道，禁止操作');
    const state = video.status.privacyStatus === 'public' && video.status.uploadStatus !== 'processed' ? 'processing_or_unavailable' : video.status.privacyStatus;
    return { state, video, url: `https://www.youtube.com/watch?v=${remote.id}` };
  }
  async function release(account, remote) {
    const found = await inspect(account, remote);
    if (found.state === 'public') return found;
    if (found.state === 'processing_or_unavailable') return found;
    if (found.state !== 'private') throw new Error('只允许公开已审核的私享视频');
    if (found.video.status.uploadStatus !== 'processed') throw new Error('视频尚未完成处理或不可用，不能执行公开');
    if (found.video.status.publishAt) throw new Error('平台已有定时计划，请先在后台取消或改用人工跟踪，避免双调度');
    const status = { privacyStatus: 'public' };
    for (const k of ['embeddable', 'license', 'publicStatsViewable', 'selfDeclaredMadeForKids', 'containsSyntheticMedia']) if (Object.hasOwn(found.video.status, k)) status[k] = found.video.status[k];
    await call(account, 'videos?part=status', { method: 'PUT', body: JSON.stringify({ id: remote.id, status }) });
    return inspect(account, remote);
  }
  return { inspect, release };
}
module.exports = { createYoutubeLifecycle };
