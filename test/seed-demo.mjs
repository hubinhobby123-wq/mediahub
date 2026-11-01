// 一键填充演示数据：node test/seed-demo.mjs（需先启动服务）
// 会添加 3 个演示账号、2 条内容和 2 个分发任务，方便首次体验界面。
import fs from 'fs';
import path from 'path';

const BASE = process.env.BASE || 'http://localhost:8787';

async function api(p, opts = {}) {
  const init = { ...opts };
  if (init.body && typeof init.body !== 'string' && !(init.body instanceof FormData)) {
    init.body = JSON.stringify(init.body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  const res = await fetch(BASE + p, init);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `请求失败 ${res.status}`);
  return data;
}

// 1x1 红色 PNG 作为演示封面
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');

async function upload(name, buf, type) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type }), name);
  return api('/api/upload', { method: 'POST', body: fd });
}

const cover = await upload('demo-cover.png', PNG, 'image/png');
const demoVideo = await upload('demo-video.mp4', Buffer.alloc(512 * 1024, 7), 'video/mp4');

const douyin = await api('/api/accounts', { method: 'POST', body: { platformId: 'douyin', name: '主号 · 美食探店' } });
const xhs = await api('/api/accounts', { method: 'POST', body: { platformId: 'xiaohongshu', name: '小红书 · 食光记' } });
const wechat = await api('/api/accounts', {
  method: 'POST',
  body: { platformId: 'wechat', name: '公众号 · 食光记', credentials: { appId: 'wx_your_appid', appSecret: 'your_app_secret' } },
});
for (const a of [douyin, xhs]) await api(`/api/accounts/${a.id}/verify`, { method: 'POST' });

const video = await api('/api/contents', {
  method: 'POST',
  body: {
    type: 'video',
    title: '周末探店 Vlog：藏在巷子里的三家宝藏小店',
    desc: '本期带你逛三家本地人才知道的宝藏小店，最后一家真的绝了！',
    tags: '探店,vlog,美食',
    videoFileId: demoVideo.id,
    coverFileId: cover.id,
  },
});
const article = await api('/api/contents', {
  method: 'POST',
  body: {
    type: 'article',
    title: '一周美食清单｜5 道家常菜的做法都在这了',
    desc: '从买菜到出锅，5 道简单又下饭的家常菜。',
    tags: '家常菜,食谱,下饭菜',
    body: '周一到周五，每天一道家常菜，简单好吃不重样。\n\n第一道：番茄炒蛋，诀窍是蛋液里加几滴水，炒出来更嫩。\n\n第二道：青椒肉丝，肉丝提前腌十分钟，滑嫩不柴。\n\n其余三道见正文图片，收藏起来慢慢做～',
    coverFileId: cover.id,
  },
});

await api('/api/tasks', {
  method: 'POST',
  body: {
    contentId: article.id,
    accountIds: [xhs.id, wechat.id],
    overrides: { xiaohongshu: { title: '一周美食清单🔥5道家常菜新手也能会' } },
  },
});
await api('/api/tasks', { method: 'POST', body: { contentId: video.id, accountIds: [douyin.id] } });

const sum = await api('/api/summary');
console.log('演示数据已就绪：', JSON.stringify(sum));
console.log('提示：公众号账号使用的是占位凭据，分发到公众号会失败，可用来体验「失败重试」；配置真实 AppID/AppSecret 后即可真正存入草稿箱。');
