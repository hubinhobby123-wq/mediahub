// API 全流程自动化测试：node test/api-test.mjs（需先启动服务：npm start）
import fs from 'fs';
import os from 'os';
import http from 'http';
import path from 'path';

const BASE = process.env.BASE || 'http://localhost:8787';

let passed = 0;
let failed = 0;

function ok(cond, name, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

async function api(p, opts = {}) {
  const init = { ...opts };
  if (init.body && typeof init.body !== 'string' && !(init.body instanceof FormData)) {
    init.body = JSON.stringify(init.body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  const res = await fetch(BASE + p, init);
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitTask(id, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { data } = await api(`/api/tasks/${id}`);
    if (!['queued', 'running'].includes(data.status) && data.targets.every((t) => t.status !== 'pending' && t.status !== 'running')) return data;
    await sleep(500);
  }
  throw new Error('等待任务超时');
}

async function main() {
  console.log(`\n▶ MediaHub API 测试（${BASE}）\n`);

  // 1. 平台目录
  let r = await api('/api/platforms');
  ok(r.status === 200 && Array.isArray(r.data) && r.data.length >= 14, '平台目录可用（含国际平台，共 14 个）');

  // 2. 上传素材
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mediahub-test-'));
  const jpg = path.join(tmp, 'cover.jpg');
  const mp4 = path.join(tmp, 'demo.mp4');
  fs.writeFileSync(jpg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...crypto.getRandomValues(new Uint8Array(2048))]));
  fs.writeFileSync(mp4, crypto.getRandomValues(new Uint8Array(8192)));
  fs.writeFileSync(path.join(tmp, 'bad.exe'), Buffer.from([0x4d, 0x5a, 0x00, 0x00]));
  const up = (p, type) => {
    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(p)], { type }), path.basename(p));
    return api('/api/upload', { method: 'POST', body: fd });
  };
  r = await up(jpg, 'image/jpeg');
  ok(r.status === 200 && r.data.id, '上传封面图');
  const coverId = r.data.id;
  r = await up(mp4, 'video/mp4');
  ok(r.status === 200 && r.data.kind === 'video', '上传视频文件');
  const videoId = r.data.id;
  r = await up(path.join(tmp, 'bad.exe'), 'application/exe');
  ok(r.status === 400, '拒绝非法格式（.exe）');

  // 3. 内容库
  r = await api('/api/contents', { method: 'POST', body: { type: 'video', title: '测试视频·探店 Vlog', desc: '一条测试视频', tags: '测试,vlog', videoFileId: videoId, coverFileId: coverId } });
  ok(r.status === 200 && r.data.id, '创建视频内容');
  const videoContentId = r.data.id;
  r = await api('/api/contents', { method: 'POST', body: { type: 'article', title: '测试图文·一周探店合集', body: '第一段正文\n\n第二段正文', coverFileId: coverId, tags: ['图文'] } });
  ok(r.status === 200 && r.data.id, '创建图文内容');
  const articleContentId = r.data.id;
  r = await api('/api/contents', { method: 'POST', body: { type: 'video', title: '缺视频文件' } });
  ok(r.status === 400, '校验：视频内容必须带视频文件');

  // 4. 账号
  r = await api('/api/accounts', { method: 'POST', body: { platformId: 'douyin', name: '测试抖音号' } });
  ok(r.status === 200 && r.data.id, '创建抖音账号（模拟）');
  const douyinId = r.data.id;
  r = await api(`/api/accounts/${douyinId}/verify`, { method: 'POST' });
  ok(r.status === 200 && r.data.ok === true && r.data.status === 'active', '模拟账号验证通过');
  r = await api('/api/accounts', { method: 'POST', body: { platformId: 'xiaohongshu', name: '测试小红书' } });
  const xhsId = r.data.id;
  r = await api('/api/accounts', { method: 'POST', body: { platformId: 'wechat', name: '测试公众号', credentials: { appId: 'wx_fake_appid', appSecret: 'fake_secret' } } });
  ok(r.status === 200 && r.data.id && r.data.credentials === undefined, '创建公众号账号（响应不含凭据）');
  const wechatId = r.data.id;
  r = await api('/api/accounts');
  ok(r.data.every((a) => a.credentials === undefined) && r.data.some((a) => a.hasCredentials === true), '账号列表不回显凭据（含 hasCredentials 标记）');
  r = await api(`/api/accounts/${wechatId}`, { method: 'PATCH', body: { credentials: { appId: 'wx_fake_appid2' } } });
  ok(r.status === 200 && r.data.status === 'unverified', '编辑账号：非空凭据覆盖且状态重置');
  r = await api(`/api/accounts/${wechatId}/verify`, { method: 'POST' });
  ok(r.status === 200 && r.data.ok === false, '假凭据的公众号验证失败且不崩溃');

  // 5. 视频分发（模拟平台）
  r = await api('/api/tasks', { method: 'POST', body: { contentId: videoContentId, accountIds: [douyinId] } });
  ok(r.status === 200 && r.data.id && ['queued', 'running'].includes(r.data.status), '创建视频分发任务');
  let task = await waitTask(r.data.id);
  ok(task.status === 'success' && task.targets[0].status === 'success', '视频分发成功（模拟草稿）');
  ok((task.targets[0].externalId || '').startsWith('sim-douyin-'), '生成模拟草稿 ID', task.targets[0].externalId);
  ok(task.targets[0].logs.length >= 3, '记录分发日志');

  // 6. 图文分发（模拟 + 官方 API 失败路径 + 小红书 RPA 无 Cookie 报错）
  r = await api('/api/accounts', { method: 'POST', body: { platformId: 'zhihu', name: '回归知乎号' } });
  const regZhihuId = r.data.id;
  r = await api('/api/tasks', { method: 'POST', body: { contentId: articleContentId, accountIds: [xhsId, regZhihuId, wechatId], base: { tags: '探店' } } });
  ok(r.status === 200 && r.data.id, '创建图文分发任务（多平台）');
  task = await waitTask(r.data.id);
  const xhsT = task.targets.find((t) => t.platformId === 'xiaohongshu');
  const wx = task.targets.find((t) => t.platformId === 'wechat');
  const zhihuT = task.targets.find((t) => t.accountId === regZhihuId);
  ok(xhsT.status === 'failed' && /未导入 Cookie/.test(xhsT.message), '小红书 RPA：无 Cookie 给出引导性报错', xhsT.message);
  ok(zhihuT && zhihuT.status === 'success', '知乎（模拟）分发成功');
  ok(wx.status === 'failed' && wx.message.length > 0, `公众号真实请求失败且消息清晰（${(wx.message || '').slice(0, 40)}…）`);
  ok(task.status === 'partial', '任务状态：部分成功');

  // 7. 失败重试（小红书无 Cookie + 公众号假凭据）
  r = await api(`/api/tasks/${task.id}/retry`, { method: 'POST' });
  ok(r.status === 200 && r.data.retried === 2, '重试失败项（2 个）');
  task = await waitTask(task.id);
  ok(task.targets.find((t) => t.platformId === 'wechat').status === 'failed', '重试后公众号仍为失败（凭据无效，符合预期）');
  ok(task.targets.find((t) => t.platformId === 'xiaohongshu').status === 'failed', '重试后小红书仍为失败（无 Cookie，符合预期）');

  // 8. 平台与内容类型校验
  r = await api('/api/tasks', { method: 'POST', body: { contentId: articleContentId, accountIds: [douyinId] } });
  ok(r.status === 400 && /不支持/.test(r.data.error), '校验：抖音不接受图文内容');

  // 9. 国际平台目录
  r = await api('/api/platforms');
  ok(
    r.data.some((p) => p.id === 'youtube' && p.mode === 'official-api') &&
      ['tiktok_global', 'instagram', 'twitter'].every((id) => r.data.some((p) => p.id === id)),
    '国际平台目录：YouTube（官方API）+ TikTok/Instagram/X'
  );
  r = await api('/api/accounts', { method: 'POST', body: { platformId: 'youtube', name: '测试YT', credentials: { clientId: 'fake', clientSecret: 'fake', refreshToken: 'fake' } } });
  ok(r.status === 200, '创建 YouTube 账号（官方 API）');
  const ytId = r.data.id;
  r = await api(`/api/accounts/${ytId}/verify`, { method: 'POST' });
  ok(r.status === 200 && r.data.ok === false, 'YouTube 假凭据验证失败且不崩溃');

  // 10. MCP 端点（AI Agent 接入）
  const mcp = async (method, params, id) => {
    const res = await fetch(BASE + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  r = await mcp('initialize', { protocolVersion: '2025-06-18' });
  ok(r.status === 200 && r.data.result && r.data.result.serverInfo.name === 'mediahub', 'MCP initialize');
  r = await mcp('tools/list');
  ok(r.status === 200 && r.data.result.tools.length >= 10, 'MCP tools/list 返回工具集（含新增工具）');
  r = await mcp('tools/call', { name: 'mediahub_list_platforms', arguments: {} });
  ok(r.status === 200 && /youtube/.test(r.data.result.content[0].text), 'MCP 调用：mediahub_list_platforms');
  r = await mcp('tools/call', { name: 'mediahub_create_article_content', arguments: { title: 'MCP 创建的图文', body: '第一段\n\n第二段', tags: ['ai', 'mcp'] } });
  const mcpContent = JSON.parse(r.data.result.content[0].text);
  ok(!!mcpContent.contentId, 'MCP 创建图文内容');
  r = await api('/api/accounts', { method: 'POST', body: { platformId: 'zhihu', name: 'MCP测试知乎' } });
  const zhihuId = r.data.id;
  r = await mcp('tools/call', { name: 'mediahub_publish', arguments: { contentId: mcpContent.contentId, platformIds: ['zhihu'] } });
  const mcpPub = JSON.parse(r.data.result.content[0].text);
  ok(!!mcpPub.taskId && ['queued', 'running'].includes(mcpPub.status), 'MCP 发起分发（platformIds 便捷参数）');
  task = await waitTask(mcpPub.taskId);
  ok(task.status === 'success', 'MCP 分发任务执行成功');
  r = await mcp('tools/call', { name: 'mediahub_task_status', arguments: { taskId: mcpPub.taskId, includeLogs: true } });
  ok(/已存入草稿箱/.test(r.data.result.content[0].text), 'MCP 查询任务状态（含日志）');
  r = await mcp('tools/call', { name: 'mediahub_list_tasks' });
  ok(r.status === 200, 'MCP 列出任务');
  r = await mcp('tools/call', { name: 'mediahub_get_content', arguments: { contentId: mcpContent.contentId } });
  ok(/MCP 创建的图文/.test(r.data.result.content[0].text), 'MCP 查看内容详情');
  r = await mcp('tools/call', { name: 'mediahub_task_status', arguments: { taskId: mcpPub.taskId, waitSeconds: 10 } });
  ok(/success/.test(r.data.result.content[0].text), 'MCP 等待任务完成（waitSeconds）');
  const nt = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  ok(nt.status === 202, 'MCP 通知（无 id）返回 202');
  const gt = await fetch(BASE + '/mcp');
  ok(gt.status === 405, 'MCP GET 返回 405（无状态端点）');

  // 11. platformIds 便捷参数（REST）
  r = await api('/api/tasks', { method: 'POST', body: { contentId: articleContentId, platformIds: ['zhihu'] } });
  ok(r.status === 200 && r.data.targets.length >= 1 && r.data.targets.every((t) => t.platformId === 'zhihu'), 'REST platformIds 参数可用（包含该平台全部账号）');
  await waitTask(r.data.id);

  // 11.5 设置接口与安全默认值
  r = await api('/api/settings');
  ok(r.status === 200 && typeof r.data === 'object', '读取设置');
  r = await api('/api/settings', { method: 'PATCH', body: { notifyWebhook: 'http://127.0.0.1:9/hook', autoRetry: 1, targetTimeoutSec: 300 } });
  ok(r.status === 200 && r.data.autoRetry === 1 && r.data.notifyWebhook.includes('/hook'), '更新设置');
  r = await api('/api/settings', { method: 'PATCH', body: { notifyWebhook: '', autoRetry: 0, targetTimeoutSec: 0 } });
  ok(r.status === 200 && r.data.autoRetry === 0, '恢复默认设置');
  const rawHost = (host) =>
    new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: new URL(BASE).port || 80, path: '/api/summary', headers: { Host: host }, timeout: 3000 },
        (res) => { res.resume(); resolve(res.statusCode); }
      );
      req.on('error', () => resolve(0));
      req.end();
    });
  ok((await rawHost('evil.example.com')) === 403, 'Host 校验拦截陌生域名（防 DNS rebinding）');
  ok((await rawHost('localhost')) === 200, 'Host 校验放行 localhost');
  r = await api('/api/platforms');
  ok(r.data.every((p) => p.limits && p.limits.title > 0), '平台目录含标题字数上限');

  // 9. 定时任务
  r = await api('/api/tasks', { method: 'POST', body: { contentId: videoContentId, accountIds: [douyinId], scheduleAt: new Date(Date.now() + 3000).toISOString() } });
  ok(r.status === 200 && r.data.status === 'scheduled', '创建定时分发任务');
  const schedId = r.data.id;
  await sleep(9000); // 调度器 20s 扫描一次，这里手动触发一次 run 以缩短测试
  await api(`/api/tasks/${schedId}/run`, { method: 'POST' });
  task = await waitTask(schedId);
  ok(task.status === 'success', '定时任务可立即执行并成功');

  // 12. 清理与汇总
  r = await api('/api/summary');
  ok(r.status === 200 && typeof r.data.targetsSuccess === 'number', '汇总接口可用');
  for (const t of (await api('/api/tasks')).data) await api(`/api/tasks/${t.id}`, { method: 'DELETE' });
  for (const c of (await api('/api/contents')).data) await api(`/api/contents/${c.id}`, { method: 'DELETE' });
  for (const a of (await api('/api/accounts')).data) await api(`/api/accounts/${a.id}`, { method: 'DELETE' });
  r = await api('/api/summary');
  ok(r.data.contents === 0 && r.data.accounts === 0 && r.data.tasks === 0, '删除接口正常，数据已清理');

  console.log(`\n■ 结果：${passed} 通过，${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('测试执行异常：', e.message);
  process.exit(1);
});
