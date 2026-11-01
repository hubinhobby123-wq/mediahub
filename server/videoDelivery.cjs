// Deliberately separate non-public delivery from approval/public release.
const DRAFT = { route: 'draft_cli', available: true, verification: 'save_flow_confirmed', label: '安全草稿通道' };
const BROWSER = { route: 'browser_agent', available: false, verification: 'needs_live_test', label: '浏览器协助，待逐平台验证' };
const CAPABILITIES = Object.freeze({
  douyin: { ...BROWSER, available: true, verification: 'experimental_reopen_required', label: '浏览器Agent协助（草稿持久化待验证）', note: '旧CLI暂存仅留下本地表单，未确认后台可审阅，已停用自动上传。已有不确定记录先恢复、不重传；后续仅经明确授权在可持续浏览器核对账号并保存、重开验证，或验证仅自己可见后私密投递' },
  shipinhao: { ...DRAFT, verification: 'experimental', note: '真实草稿保存需逐次确认，不以日志关键字作为最终证据' },
  bilibili: { ...BROWSER, available: true, verification: 'live_verified_browser_assisted', label: '浏览器Agent保存草稿（已实测）', note: '已保存并重新打开示例完整版草稿；需要可用浏览器和明确账号，非无人值守上传器' },
  kuaishou: { ...BROWSER, available: true, verification: 'live_verified_browser_assisted', label: '浏览器Agent私密投递（已实测）', note: '示例专版提交前选中仅自己可见，提交后全部作品显示私密；需用户确认账号与可用浏览器，非无人值守CLI' },
  xiaohongshu: { ...BROWSER, available: true, preferredState: 'private', verification: 'user_submitted_private_observed', label: '浏览器Agent私密投递（用户提交后已核查）', note: '当前示例作品已在管理列表和编辑页确认仅自己可见；浏览器预览异常独立记录，不重传。以后先确认仅自己可见再提交；需可用浏览器及账号核对，非无人值守CLI，标题上限20' },
  youtube: { route: 'youtube_private', available: true, verification: 'mock_tested_oauth_required', label: '官方API私享上传（需OAuth）', note: '强制private；不使用unlisted；真实账号未验证' },
});
function capability(platform) { return CAPABILITIES[platform] || { route: 'manual', available: false, verification: 'not_integrated', label: '尚未接入可靠非公开投递', note: '不调用旧公开/定时上传器；需实际验证草稿或仅自己可见' }; }
function checkObservedState(state, allowPrivate) {
  if (state !== 'draft' && state !== 'private') throw new Error('只接受草稿或仅自己可见；公开、不公开列出、定时均不属于非公开投递');
  if (state === 'private' && allowPrivate !== true) throw new Error('本次任务没有授权私密发布替代草稿');
}
module.exports = { capability, checkObservedState };
