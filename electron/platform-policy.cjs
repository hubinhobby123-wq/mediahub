const crypto = require('crypto');
const HOMES = {
  bilibili: 'https://member.bilibili.com/platform/home', douyin: 'https://creator.douyin.com/',
  kuaishou: 'https://cp.kuaishou.com/', xiaohongshu: 'https://creator.xiaohongshu.com/',
  shipinhao: 'https://channels.weixin.qq.com/', toutiao: 'https://mp.toutiao.com/',
  baijiahao: 'https://baijiahao.baidu.com/', wechat: 'https://mp.weixin.qq.com/',
  zhihu: 'https://www.zhihu.com/creator', csdn: 'https://mp.csdn.net/', youtube: 'https://studio.youtube.com/'
};
const DOMAINS = {
  bilibili:['bilibili.com'], douyin:['douyin.com'], kuaishou:['kuaishou.com'],
  xiaohongshu:['xiaohongshu.com'], shipinhao:['weixin.qq.com','qq.com'],
  toutiao:['toutiao.com'], baijiahao:['baidu.com'], wechat:['weixin.qq.com','qq.com'],
  zhihu:['zhihu.com'], csdn:['csdn.net'], youtube:['youtube.com','google.com','youtu.be']
};
function allowed(platform, value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password &&
    (!u.port || u.port === '443') && (DOMAINS[platform] || []).some(d => u.hostname === d || u.hostname.endsWith('.'+d)); }
  catch { return false; }
}
function partition(accountId) { return 'persist:platform-' + crypto.createHash('sha256').update(accountId).digest('hex'); }
module.exports = { HOMES, allowed, partition };
