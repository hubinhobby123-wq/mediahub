// 平台目录是前端、任务服务和适配器路由的单一事实来源。
const cookieField = [{ key: 'cookie', label: '登录 Cookie（可选）', placeholder: '优先复用已登录的本地适配器会话' }];

const PLATFORMS = [
  { id: 'douyin', name: '抖音', letter: '抖', color: '#161823', capabilities: ['video'], mode: 'unsupported', draftSupport: { video: 'unsupported' }, credentialFields: [], hint: '旧CLI暂存不是可审阅草稿，已停用。平台专版请到视频分发页由浏览器Agent投递仅自己可见；到期公开能力另外验证。' },
  { id: 'kuaishou', name: '快手', letter: '快', color: '#ff4906', capabilities: ['video'], mode: 'unsupported', draftSupport: { video: 'unsupported' }, credentialFields: cookieField, hint: '视频分发页支持浏览器Agent核查私密投递；旧CLI无安全草稿通道，私密转公开入口仍待验证。' },
  { id: 'bilibili', name: '哔哩哔哩', letter: 'B', color: '#fb7299', capabilities: ['video'], mode: 'unsupported', draftSupport: { video: 'unsupported' }, credentialFields: cookieField, hint: '视频分发页支持浏览器Agent保存准确草稿；旧CLI草稿与常驻自动正式投稿未接通。' },
  { id: 'shipinhao', skillPlatform: 'tencent', name: '微信视频号', letter: '视', color: '#fa9d3b', capabilities: ['video'], mode: 'skill', draftSupport: { video: 'experimental' }, adapters: { save_draft: { video: 'skill-publisher' } }, credentialFields: [], hint: '通过 video-publisher 实验通道执行；此前测试曾卡在上传阶段。' },
  { id: 'xiaohongshu', name: '小红书', letter: '红', color: '#ff2442', capabilities: ['video', 'article'], mode: 'unsupported', draftSupport: { video: 'unsupported', article: 'unsupported' }, credentialFields: cookieField, hint: '视频分发页使用浏览器Agent仅自己可见投递及独立公开审批；旧通用发布任务不代替此流程，常驻自动仍需验证。' },
  { id: 'toutiao', name: '今日头条', letter: '头', color: '#ed4038', capabilities: ['video', 'article'], mode: 'skill', draftSupport: { video: 'unsupported', article: 'verified' }, adapters: { save_draft: { article: 'skill-publisher' } }, credentialFields: [], hint: '图文使用 article-publisher；视频草稿尚未验证。' },
  { id: 'baijiahao', name: '百家号', letter: '百', color: '#2932e1', capabilities: ['article'], mode: 'skill', draftSupport: { article: 'verified' }, adapters: { save_draft: { article: 'skill-publisher' } }, credentialFields: [], hint: '通过 article-publisher 与 Wechatsync 保存草稿。' },
  { id: 'wechat', name: '微信公众号', letter: '公', color: '#07c160', capabilities: ['article'], mode: 'skill', draftSupport: { article: 'verified' }, adapters: { save_draft: { article: 'skill-publisher' } }, credentialFields: [], hint: '唯一通道为 wechat-editor，由 article-publisher 调度。' },
  { id: 'zhihu', name: '知乎', letter: '知', color: '#0084ff', capabilities: ['article'], mode: 'skill', draftSupport: { article: 'verified' }, adapters: { save_draft: { article: 'skill-publisher' } }, credentialFields: [], hint: '通过 article-publisher 与 Wechatsync 保存草稿。' },
  { id: 'csdn', name: 'CSDN', letter: 'C', color: '#fc5531', capabilities: ['article'], mode: 'skill', draftSupport: { article: 'verified' }, adapters: { save_draft: { article: 'skill-publisher' } }, credentialFields: [], hint: '通过 article-publisher 与 Wechatsync 保存草稿。' },
  { id: 'weibo', name: '微博', letter: '微', color: '#e6162d', capabilities: ['article'], mode: 'unsupported', draftSupport: { article: 'unsupported' }, credentialFields: cookieField, hint: '尚未接入真实草稿通道。' },
  { id: 'youtube', name: 'YouTube', letter: 'Y', color: '#ff0000', capabilities: ['video'], mode: 'official-api', draftSupport: { video: 'unsupported' }, credentialFields: [{ key: 'clientId', label: 'OAuth Client ID' }, { key: 'clientSecret', label: 'OAuth Client Secret' }, { key: 'refreshToken', label: 'Refresh Token' }, { key: 'privacy', label: '上传可见性' }], hint: '私享上传不是草稿动作，默认草稿任务不执行。' },
  { id: 'tiktok_global', name: 'TikTok', letter: 'T', color: '#25f4ee', capabilities: ['video'], mode: 'unsupported', draftSupport: { video: 'unsupported' }, credentialFields: cookieField, hint: '尚未接入真实草稿通道。' },
  { id: 'instagram', name: 'Instagram', letter: 'IG', color: '#e1306c', capabilities: ['video'], mode: 'unsupported', draftSupport: { video: 'unsupported' }, credentialFields: cookieField, hint: '尚未接入真实草稿通道。' },
  { id: 'twitter', name: 'X（Twitter）', letter: 'X', color: '#0f1419', capabilities: ['video', 'article'], mode: 'unsupported', draftSupport: { video: 'unsupported', article: 'unsupported' }, credentialFields: cookieField, hint: '尚未接入真实草稿通道。' },
];

const TITLE_LIMITS = { douyin: 30, kuaishou: 30, bilibili: 80, shipinhao: 30, xiaohongshu: 20, toutiao: 30, baijiahao: 40, wechat: 64, zhihu: 100, csdn: 100, weibo: 30, youtube: 100, tiktok_global: 100, instagram: 125, twitter: 100 };
for (const platform of PLATFORMS) platform.limits = { title: TITLE_LIMITS[platform.id] || 100 };

// Account catalogue includes manual video channels without inventing upload support.
for (const [id, name] of [['xigua','西瓜视频'],['facebook','Facebook'],['linkedin','LinkedIn'],['threads','Threads'],['pinterest','Pinterest']]) {
  PLATFORMS.push({ id, name, letter: name.slice(0,2), color: '#586477', capabilities: ['video'], mode: 'unsupported', draftSupport: { video: 'unsupported' }, credentialFields: [], limits: {}, hint: '视频专版可在视频分发页管理；上传和公开目前需在平台后台操作。' });
}
function getPlatform(id) { return PLATFORMS.find((platform) => platform.id === id); }
function draftSupport(platform, contentType) { return platform?.draftSupport?.[contentType] || 'unsupported'; }

module.exports = { PLATFORMS, getPlatform, draftSupport };
