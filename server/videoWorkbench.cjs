// Pure view projections; no browser, upload or release side effects.
const LISTS = Object.freeze({
  kuaishou: 'https://cp.kuaishou.com/article/manage/video',
  xiaohongshu: 'https://creator.xiaohongshu.com/new/note-manager',
});
function referenceId(platform, url) {
  const u = new URL(url);
  if (platform === 'bilibili') return u.searchParams.get('draftId') || /\/video\/(BV[\w]+)/.exec(u.pathname)?.[1] || null;
  if (platform === 'kuaishou') return u.searchParams.get('workId') || /\/short-video\/([\w]+)/.exec(u.pathname)?.[1] || null;
  if (platform === 'xiaohongshu') return u.pathname === '/publish/update' ? u.searchParams.get('id') : /\/(?:explore|discovery\/item)\/([a-f0-9]{24})/.exec(u.pathname)?.[1] || null;
  if (platform === 'youtube') return u.searchParams.get('v') || (u.hostname === 'youtu.be' ? u.pathname.slice(1) : /\/(?:video|shorts)\/([\w-]{11})/.exec(u.pathname)?.[1]) || null;
  if (platform === 'douyin') return /\/video\/(\d+)/.exec(u.pathname)?.[1] || (u.hostname==='creator.douyin.com' && u.pathname==='/creator-micro/content/post/video' ? u.searchParams.get('mid') : null);
  return null;
}
function category(j) {
  if (j.status === 'uncertain') return 'check';
  if (j.status === 'public') return 'public';
  if (j.status === 'cancelled') return 'cancelled';
  if (['approved','manual_due','agent_due','release_running','awaiting_public'].includes(j.status)) return 'release';
  if (['draft_saved','private_saved','remote_ready'].includes(j.status)) return 'review';
  return 'delivery';
}
function project(j, creators) {
  const exact = (j.status === 'public' ? j.publicUrl : null) || j.remote?.url;
  return { category: category(j), reviewUrl: exact || LISTS[j.platformId] || creators[j.platformId],
    reviewExact: Boolean(exact), canApprove: Boolean(j.remote && ['remote_ready','draft_saved','private_saved'].includes(j.status)),
    previewWarning: j.preview?.warning || null };
}
function batchPlan(jobs, capabilities) {
  return jobs.map(j => {
    const c = capabilities(j.platformId);
    const disposition = j.status !== 'prepared' ? 'skip' : !c.available ? 'manual' : c.route === 'browser_agent' ? 'browser' : ['draft_cli','youtube_private'].includes(c.route) ? 'ready' : 'manual';
    return { jobId: j.id, unitId: j.unitId, platformId: j.platformId, account: j.account, status: j.status, route: c.route, disposition,
      reason: disposition === 'skip' ? '已有投递结果、运行中或需核查：禁止重传' : disposition === 'browser' ? '需有浏览器能力的Agent逐条核对后投递' : disposition === 'manual' ? '尚无可靠非公开适配器，人工处理' : '可首次非公开投递' };
  });
}
module.exports = { referenceId, category, project, batchPlan, LISTS };
