#!/usr/bin/env node
// MediaHub CLI：node cli.js <command> [options]
// 供终端使用，也为 AI Agent / 脚本提供自动化入口（加 --json 输出机器可读 JSON）。
// 需要本地服务已启动（npm start）。可用 MEDIAHUB_URL 环境变量指定服务地址。
const fs = require('fs');
const path = require('path');

const BASE = process.env.MEDIAHUB_URL || 'http://localhost:8788';

const argv = process.argv.slice(2);
const flags = {};
const command = [];
function setFlag(k, v) {
  if (flags[k] === undefined) flags[k] = v;
  else if (Array.isArray(flags[k])) flags[k].push(v);
  else flags[k] = [flags[k], v];
}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json' || a === '--wait') { flags[a.slice(2)] = true; continue; }
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { setFlag(k, next); i++; }
    else setFlag(k, true);
  } else command.push(a);
}
const JSON_MODE = !!flags.json;

const say = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(BASE + p, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`无法连接 ${BASE}，请先启动服务（npm start），或用 MEDIAHUB_URL 指定地址`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

async function upload(file) {
  const buf = await fs.promises.readFile(file);
  const fd = new FormData();
  fd.append('file', new Blob([buf]), path.basename(file));
  const res = await fetch(BASE + '/api/upload', { method: 'POST', body: fd });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || '上传失败');
  return data;
}

function printTask(t) {
  say(`任务 ${t.id}`);
  say(`  状态：${t.status}   进度：${t.targets.filter((x) => x.status === 'success').length}/${t.targets.length} 成功`);
  for (const x of t.targets) {
    say(`  - [${x.status}] ${x.platformId} / ${x.accountName}  ${x.message || ''}${x.externalId ? '（ID: ' + x.externalId + '）' : ''}`);
  }
}

async function main() {
  const [cmd, sub] = command;

  if (cmd === 'platforms') {
    const list = await api('/api/platforms');
    if (JSON_MODE) return say(JSON.stringify(list, null, 2));
    for (const p of list) {
      const support = Object.entries(p.draftSupport || {}).map(([type, state]) => `${type}:${state}`).join(',');
      say(`${p.id.padEnd(14)} ${p.name.padEnd(10)} [${p.capabilities.join('/')}]  ${support || 'unsupported'}`);
    }
    return;
  }

  if (cmd === 'accounts') {
    if (sub === 'add') {
      if (!flags.platform || !flags.name) throw new Error('用法：accounts add --platform <平台ID> --name <名称> [--cred key=value ...]');
      const credentials = {};
      for (const c of [].concat(flags.cred || [])) {
        const i = c.indexOf('=');
        if (i > 0) credentials[c.slice(0, i)] = c.slice(i + 1);
      }
      const acc = await api('/api/accounts', { method: 'POST', body: { platformId: flags.platform, name: flags.name, credentials } });
      if (JSON_MODE) return say(JSON.stringify(acc, null, 2));
      say(`已添加账号 ${acc.id}（${flags.platform} / ${flags.name}），验证中…`);
      const v = await api(`/api/accounts/${acc.id}/verify`, { method: 'POST' });
      say(v.ok ? `✅ 验证通过：${v.message}` : `❌ 验证失败：${v.message}`);
      return;
    }
    if (sub === 'verify') {
      if (!flags.id) throw new Error('用法：accounts verify --id <账号ID>');
      const v = await api(`/api/accounts/${flags.id}/verify`, { method: 'POST' });
      if (JSON_MODE) return say(JSON.stringify(v, null, 2));
      say(v.ok ? `✅ ${v.message}` : `❌ ${v.message}`);
      return;
    }
    // 默认 list
    const list = await api('/api/accounts');
    if (JSON_MODE) return say(JSON.stringify(list, null, 2));
    if (!list.length) return say('暂无账号，用 accounts add 添加');
    for (const a of list) say(`${a.id}  ${a.platformId.padEnd(14)} ${a.name}  [${a.status}]`);
    return;
  }

  if (cmd === 'contents') {
    if (sub === 'import-bundle') {
      if (!flags.file) throw new Error('用法：contents import-bundle --file <mediahub-bundle.json 绝对路径>');
      const result = await api('/api/bundles/import', { method: 'POST', body: { bundlePath: path.resolve(flags.file) } });
      if (JSON_MODE) return say(JSON.stringify(result, null, 2));
      say(`${result.created ? '已导入' : '已存在'} Skill 适配包：${result.content.id}（${result.content.title}）`);
      return;
    }
    if (sub === 'create-video') {
      if (!flags.file || !flags.title) throw new Error('用法：contents create-video --file <视频路径> --title <标题> [--desc ...] [--tags a,b] [--cover <封面路径>]');
      say(`上传视频 ${flags.file} …`);
      const v = await upload(flags.file);
      const cover = flags.cover ? await upload(flags.cover) : null;
      const c = await api('/api/contents', {
        method: 'POST',
        body: {
          type: 'video', title: flags.title, desc: flags.desc || '', tags: flags.tags || '',
          videoFileId: v.id, coverFileId: cover ? cover.id : null,
        },
      });
      if (JSON_MODE) return say(JSON.stringify(c, null, 2));
      say(`已创建视频内容：${c.id}（${c.title}）`);
      return;
    }
    if (sub === 'create-article') {
      if (!flags.title) throw new Error('用法：contents create-article --title <标题> [--body <正文>|--body-file <路径>] [--cover <封面>] [--image p1,p2]');
      let body = flags.body || '';
      if (flags['body-file']) body = await fs.promises.readFile(flags['body-file'], 'utf8');
      const cover = flags.cover ? await upload(flags.cover) : null;
      const images = [];
      if (flags.image) {
        for (const p of String(flags.image).split(',')) {
          const f = await upload(p.trim());
          images.push(f.id);
        }
      }
      const c = await api('/api/contents', {
        method: 'POST',
        body: {
          type: 'article', title: flags.title, desc: flags.desc || '', tags: flags.tags || '',
          body, coverFileId: cover ? cover.id : null, imageFileIds: images,
        },
      });
      if (JSON_MODE) return say(JSON.stringify(c, null, 2));
      say(`已创建图文内容：${c.id}（${c.title}）`);
      return;
    }
    const list = await api('/api/contents');
    if (JSON_MODE) return say(JSON.stringify(list, null, 2));
    if (!list.length) return say('内容库为空');
    for (const c of list) say(`${c.id}  [${c.type}]  ${c.title}`);
    return;
  }

  if (cmd === 'publish') {
    if (!flags.content && !flags.file && !flags.body && !flags['body-file']) {
      throw new Error('用法：publish (--content <内容ID> | --file <视频路径> | --body <正文> | --body-file <文件>) (--accounts id1,id2 | --platform p1,p2) [--title] [--desc] [--tags] [--cover <封面>] [--at "2026-09-09 20:00"] [--wait]');
    }
    // 未指定 --content 时：根据 --file / --body 先创建内容（Agent 一步到位）
    let contentId = flags.content;
    if (!contentId) {
      if (!flags.title) throw new Error('自动创建内容需要 --title');
      if (flags.file) {
        say(`上传视频 ${flags.file} …`);
        const v = await upload(flags.file);
        const cover = flags.cover ? await upload(flags.cover) : null;
        const c = await api('/api/contents', {
          method: 'POST',
          body: {
            type: 'video', title: flags.title, desc: flags.desc || '', tags: flags.tags || '',
            videoFileId: v.id, coverFileId: cover ? cover.id : null,
          },
        });
        contentId = c.id;
        say(`已创建视频内容：${contentId}`);
      } else {
        let body = flags.body || '';
        if (flags['body-file']) body = await fs.promises.readFile(flags['body-file'], 'utf8');
        const cover = flags.cover ? await upload(flags.cover) : null;
        const c = await api('/api/contents', {
          method: 'POST',
          body: {
            type: 'article', title: flags.title, desc: flags.desc || '', tags: flags.tags || '',
            body, coverFileId: cover ? cover.id : null,
          },
        });
        contentId = c.id;
        say(`已创建图文内容：${contentId}`);
      }
    }
    let accountIds = flags.accounts ? String(flags.accounts).split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (flags.platform) {
      const all = await api('/api/accounts');
      for (const pid of String(flags.platform).split(',').map((s) => s.trim()).filter(Boolean)) {
        for (const a of all) if (a.platformId === pid && !accountIds.includes(a.id)) accountIds.push(a.id);
      }
    }
    if (!accountIds.length) throw new Error('未指定分发账号（--accounts 或 --platform）');
    let scheduleAt;
    if (flags.at) {
      const d = new Date(String(flags.at).replace(' ', 'T'));
      if (isNaN(d.getTime())) throw new Error('无法解析时间：' + flags.at);
      scheduleAt = d.toISOString();
    }
    const task = await api('/api/tasks', {
      method: 'POST',
      body: {
        contentId,
        accountIds,
        base: { title: flags.title, desc: flags.desc, tags: flags.tags },
        scheduleAt,
        operation: 'save_draft',
        allowDuplicate: flags['allow-duplicate'] === true,
      },
    });
    if (JSON_MODE && !flags.wait) return say(JSON.stringify({ taskId: task.id, status: task.status }, null, 2));
    say(scheduleAt ? `任务已排期（${scheduleAt}）：${task.id}` : `任务已创建：${task.id}`);
    if (!flags.wait) { say('加 --wait 可等待执行完成'); return; }
    for (let i = 0; i < 150; i++) {
      await sleep(1000);
      const t = await api('/api/tasks/' + task.id);
      if (!['queued', 'running'].includes(t.status)) {
        if (JSON_MODE) return say(JSON.stringify(t, null, 2));
        printTask(t);
        if (t.status !== 'success') process.exitCode = 1;
        return;
      }
    }
    throw new Error('等待超时（150 秒），任务仍在执行');
  }

  if (cmd === 'tasks') {
    if (sub === 'retry') {
      if (!flags.id) throw new Error('用法：tasks retry --id <任务ID>');
      const r = await api(`/api/tasks/${flags.id}/retry`, { method: 'POST' });
      if (JSON_MODE) return say(JSON.stringify(r, null, 2));
      say(`已重新提交 ${r.retried} 个失败目标`);
      return;
    }
    if (sub === 'get' || sub === 'logs') {
      if (!flags.id) throw new Error('用法：tasks get|logs --id <任务ID>');
      const t = await api('/api/tasks/' + flags.id);
      if (JSON_MODE) return say(JSON.stringify(t, null, 2));
      printTask(t);
      if (sub === 'logs') {
        for (const x of t.targets) {
          say(`\n── ${x.platformId} / ${x.accountName} 的日志 ──`);
          say((x.logs || []).join('\n') || '暂无日志');
        }
      }
      return;
    }
    const list = await api('/api/tasks');
    if (JSON_MODE) return say(JSON.stringify(list, null, 2));
    if (!list.length) return say('暂无任务');
    for (const t of list) say(`${t.id}  [${t.status}]  ${t.successCount}/${t.targetCount}  ${t.title}`);
    return;
  }

  say('MediaHub CLI —— 自媒体多平台分发命令行工具');
  say('');
  say('用法：node cli.js <command> [options]（服务地址默认 http://localhost:8787）');
  say('');
  say('命令：');
  say('  platforms                                  列出所有平台');
  say('  accounts list                              列出账号');
  say('  accounts add --platform <平台ID> --name <名称> [--cred key=value]');
  say('                                             添加账号（自动验证）');
  say('  accounts verify --id <账号ID>              重新验证账号');
  say('  contents list                              列出内容');
  say('  contents create-video --file <视频> --title <标题> [--cover <封面>] [--desc] [--tags a,b]');
  say('  contents create-article --title <标题> [--body <正文>|--body-file <md>] [--cover] [--image p1,p2]');
  say('  contents import-bundle --file <mediahub-bundle.json>');
  say('  publish (--content <内容ID> | --file <视频> | --body <正文>) --platform douyin,youtube');
  say('          [--title] [--desc] [--tags] [--cover] [--at "2026-09-09 20:00"] [--wait]');
  say('                                             一行完成「建内容+分发」（Agent 推荐）');
  say('  tasks list / tasks get --id <任务ID> / tasks logs --id <任务ID> / tasks retry --id <任务ID>');
  say('');
  say('通用选项：--json 输出 JSON（适合 AI Agent / 脚本解析）');
  say('示例：node cli.js publish --file demo.mp4 --title 周末探店 --platform douyin --wait');
}

main().catch((e) => {
  console.error('错误：' + e.message);
  process.exitCode = 1;
});
