// 适配器单元测试：本地 mock 微信/YouTube 接口，不依赖真实凭据与外网
// 运行：node test/adapters-test.mjs
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let passed = 0;
let failed = 0;
function ok(cond, name, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Mock 服务器 ----------
let capturedDraft = null;

const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => r(Buffer.concat(c))); });

const wechatServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://mock');
  const body = await readBody(req);
  const reply = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
  if (url.pathname.endsWith('/token')) {
    const appid = url.searchParams.get('appid');
    if (appid === 'bad_appid') return reply({ errcode: 40013, errmsg: 'invalid appid' });
    return reply({ access_token: 'WX_TOKEN', expires_in: 7200 });
  }
  if (url.pathname.endsWith('/draft/count')) return reply({ draft_count: 3 });
  if (url.pathname.endsWith('/material/add_material')) return reply({ media_id: 'MEDIA_COVER_1' });
  if (url.pathname.endsWith('/media/uploadimg')) return reply({ url: 'https://mock.weixin/img.png' });
  if (url.pathname.endsWith('/draft/add')) {
    try { capturedDraft = JSON.parse(body.toString()); } catch {}
    return reply({ media_id: 'DRAFT_1' });
  }
  reply({ errcode: -1, errmsg: 'unknown ' + url.pathname });
});

let sessionBody = null;
const ytServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://mock');
  const body = await readBody(req);
  const reply = (code, obj, headers = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(obj));
  };
  if (url.pathname === '/token') {
    if (/refresh_token=bad/.test(body.toString())) return reply(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
    return reply(200, { access_token: 'YT_TOKEN', expires_in: 3600 });
  }
  if (url.pathname === '/v3/channels') return reply(200, { items: [{ id: 'C1', snippet: { title: 'Mock 频道' } }] });
  if (url.pathname === '/upload/youtube/v3/videos' && url.searchParams.get('uploadType') === 'resumable') {
    return reply(200, {}, { location: `http://127.0.0.1:${ytPort}/session` });
  }
  if (url.pathname === '/session') {
    sessionBody = body;
    return reply(200, { id: 'VID_1', snippet: { title: 'x' } });
  }
  reply(404, { error: { message: 'unknown ' + url.pathname } });
});

await new Promise((r) => wechatServer.listen(0, '127.0.0.1', r));
const wxPort = wechatServer.address().port;
await new Promise((r) => ytServer.listen(0, '127.0.0.1', r));
const ytPort = ytServer.address().port;

// 环境变量必须先于 require 适配器设置
process.env.WECHAT_API_BASE = `http://127.0.0.1:${wxPort}/cgi-bin`;
process.env.YT_API_URL = `http://127.0.0.1:${ytPort}/v3`;
process.env.YT_UPLOAD_URL = `http://127.0.0.1:${ytPort}/upload/youtube/v3`;
process.env.YT_OAUTH_URL = `http://127.0.0.1:${ytPort}/token`;

const wechat = require('../server/adapters/wechat.js');
const youtube = require('../server/adapters/youtube.js');
const { PLATFORMS } = require('../server/platforms.js');
const wxPlatform = PLATFORMS.find((p) => p.id === 'wechat');
const ytPlatform = PLATFORMS.find((p) => p.id === 'youtube');

// ---------- 夹具 ----------
const uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mediahub-adapter-'));
const mk = (name, bytes) => {
  const p = path.join(uploadRoot, name);
  fs.writeFileSync(p, bytes);
  return { id: name, name, path: 'uploads/' + name, size: bytes.length, mime: name.endsWith('.jpg') ? 'image/jpeg' : 'video/mp4' };
};
const cover = mk('cover.jpg', Buffer.alloc(2048, 1));
const img = mk('img2.jpg', Buffer.alloc(1024, 2));
const video = mk('demo.mp4', Buffer.alloc(4096, 3));
const noopLogger = () => {};

console.log('\n▶ 微信公众号适配器（mock）\n');
try {
  let r = await wechat.verify({ id: 'a1', name: '测试号', credentials: { appId: 'wx123', appSecret: 'sec' } });
  ok(r.ok === true && /3 篇草稿/.test(r.message), 'verify 成功并返回草稿数', r.message);
  r = await wechat.verify({ id: 'a2', name: '测试号', credentials: { appId: 'bad_appid', appSecret: 'sec' } });
  ok(r.ok === false && /40013/.test(r.message), 'verify 错误凭据返回明确错误', r.message);

  capturedDraft = null;
  r = await wechat.publish({
    platform: wxPlatform, account: { id: 'a1', name: '测试号', credentials: { appId: 'wx123', appSecret: 'sec' } },
    content: { type: 'article', title: '测试标题', desc: '', tags: [], body: '第一段\n\n第二段 <特殊> 字符', coverFile: cover, images: [img] },
    fields: { title: '发布标题', desc: '摘要', tags: ['a'] },
    logger: noopLogger, uploadRoot,
  });
  ok(r.ok === true && r.externalId === 'DRAFT_1', 'publish 成功返回草稿 media_id');
  ok(capturedDraft && capturedDraft.articles[0].thumb_media_id === 'MEDIA_COVER_1', '封面已上传为永久素材');
  ok(capturedDraft.articles[0].title === '发布标题', '标题使用合并后字段');
  ok(capturedDraft.articles[0].content.includes('第一段</p>') && capturedDraft.articles[0].content.includes('&lt;特殊&gt;'), '正文转 HTML 并转义');
  ok(capturedDraft.articles[0].content.includes('mock.weixin/img.png'), '配图已转公众号图片地址');

  capturedDraft = null;
  const longTitle = '长'.repeat(80);
  await wechat.publish({
    platform: wxPlatform, account: { id: 'a1', name: '测试号', credentials: { appId: 'wx123', appSecret: 'sec' } },
    content: { type: 'article', title: longTitle, desc: '', tags: [], body: 'x', coverFile: cover, images: [] },
    fields: { title: longTitle, desc: '', tags: [] },
    logger: noopLogger, uploadRoot,
  });
  ok(capturedDraft.articles[0].title.length === 64, '标题超 64 字自动截断');

  let threw = '';
  try {
    await wechat.publish({
      platform: wxPlatform, account: { id: 'a1', name: '测试号', credentials: { appId: 'wx123', appSecret: 'sec' } },
      content: { type: 'article', title: '无封面', desc: '', tags: [], body: 'x', coverFile: null, images: [] },
      fields: { title: '无封面', desc: '', tags: [] },
      logger: noopLogger, uploadRoot,
    });
  } catch (e) { threw = e.message; }
  ok(/封面/.test(threw), '缺少封面时给出明确报错', threw);
} catch (e) {
  ok(false, '微信适配器测试异常', e.message);
}

console.log('\n▶ YouTube 适配器（mock）\n');
try {
  const goodAcc = { id: 'y1', name: 'YT 号', credentials: { clientId: 'cid', clientSecret: 'sec', refreshToken: 'good', privacy: 'private' } };
  let r = await youtube.verify(goodAcc);
  ok(r.ok === true && /Mock 频道/.test(r.message), 'verify 成功并返回频道名', r.message);
  r = await youtube.verify({ id: 'y2', name: 'YT 号', credentials: { clientId: 'cid', clientSecret: 'sec', refreshToken: 'bad' } });
  ok(r.ok === false && /invalid_grant|过期|无效/.test(r.message), 'verify 失效凭据返回明确错误', r.message);

  sessionBody = null;
  r = await youtube.publish({
    platform: ytPlatform, account: goodAcc,
    content: { type: 'video', title: '探店视频', desc: '描述', tags: ['a', 'b'], videoFile: video, coverFile: cover, images: [] },
    fields: { title: '探店视频', desc: '描述', tags: ['a', 'b'] },
    logger: noopLogger, uploadRoot,
  });
  ok(r.ok === true && r.externalId === 'VID_1', 'publish 上传成功返回视频 ID');
  ok(sessionBody && sessionBody.length === video.size, '视频二进制完整传输', sessionBody && sessionBody.length);
  ok(/youtu\.be\/VID_1/.test(r.message) && /私享/.test(r.message), '返回私享视频链接');

  let threw = '';
  try {
    await youtube.publish({
      platform: ytPlatform, account: goodAcc,
      content: { type: 'article', title: 'x', desc: '', tags: [], videoFile: null, coverFile: null, images: [] },
      fields: { title: 'x', desc: '', tags: [] },
      logger: noopLogger, uploadRoot,
    });
  } catch (e) { threw = e.message; }
  ok(/仅支持视频/.test(threw), '图文内容被拒绝', threw);
} catch (e) {
  ok(false, 'YouTube 适配器测试异常', e.message);
}

wechatServer.close();
ytServer.close();
await sleep(100);

console.log(`\n■ 适配器测试结果：${passed} 通过，${failed} 失败\n`);
process.exitCode = failed ? 1 : 0;
