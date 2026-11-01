const express = require('express');
const path = require('path');
const { exec } = require('child_process');
const store = require('./store');
const engine = require('./engine');
const routes = require('./routes');
const releaseLock = require('./serviceLock').acquire(store.DATA_DIR);
process.once('exit', releaseLock);
process.once('SIGINT', () => process.exit(0));
process.once('SIGTERM', () => process.exit(0));

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' }));

// Host 校验：防 DNS rebinding；默认仅允许本机主机名访问。
// 如需局域网访问：HOST=0.0.0.0 并把额外主机名/IP 加进 EXTRA_HOSTS（逗号分隔）。
const ALLOWED_HOSTS = new Set([
  'localhost', '127.0.0.1', '::1',
  ...(process.env.EXTRA_HOSTS ? process.env.EXTRA_HOSTS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : []),
]);
app.use((req, res, next) => {
  let h = (req.headers.host || '').toLowerCase().trim();
  if (h.startsWith('[')) h = h.slice(1, h.indexOf(']')); // [IPv6]:port
  else if (h.includes(':')) h = h.slice(0, h.lastIndexOf(':')); // host:port
  if (!ALLOWED_HOSTS.has(h)) return res.status(403).json({ error: 'Host 不允许：本工作台默认仅限本机访问' });
  next();
});

// MCP 端点（AI Agent 接入）：需在静态资源与 API 之前挂载
app.use('/mcp', require('./mcp'));

// 素材文件访问
app.get('/files/:id', (req, res) => {
  const f = store.db.files.find((x) => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: '文件不存在' });
  res.sendFile(path.join(store.UPLOAD_DIR, path.basename(f.path)));
});

app.use('/api', routes);
app.use('/api/library', require('./libraryRoutes'));
app.get('/api/identity', (req, res) => res.json({ name: 'mediahub', version:'0.3.1', build:'v2-cleanup-20261027', dataDir: path.resolve(store.DATA_DIR) }));
app.use('/api/videos', require('./videoRoutes').router);
app.use(express.static(path.join(__dirname, '..', 'public')));

// SPA 回退：非 API/文件请求统一返回前端页面
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return;
  let status = err && (err.status || err.statusCode);
  if (!status && err && (err.code === 'LIMIT_FILE_SIZE' || /格式|文件/.test(err.message || ''))) status = 400;
  if (!status) status = 500;
  console.error('[错误]', err.message || err);
  res.status(status).json({ error: err.message || '服务器内部错误' });
});

if (process.env.MEDIAHUB_SAFE_TEST !== '1') {
  engine.recover();
  engine.startScheduler();
  require('./videoRoutes').startScheduler();
  store.backup();
}

const HOST = process.env.HOST || '127.0.0.1';
const BASE_PORT = Number(process.env.PORT) || 8788;
let resolveReady;
const ready = new Promise(resolve => { resolveReady = resolve; });

function start(port, left = 10) {
  const srv = app.listen(port, HOST, () => {
    const url = `http://localhost:${port}`;
    resolveReady({ url, port });
    console.log('──────────────────────────────────────');
    console.log('  MediaHub · 自媒体分发工作台 已启动');
    console.log(`  本地地址：${url}（监听 ${HOST}）`);
    console.log(`  数据目录：${store.DATA_DIR}`);
    console.log('  按 Ctrl+C 停止');
    console.log('──────────────────────────────────────');
    if (process.env.NO_OPEN !== '1') openBrowser(url);
  });
  srv.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && left > 0) {
      console.log(`端口 ${port} 被占用，尝试 ${port + 1} …`);
      start(port + 1, left - 1);
    } else {
      console.error('启动失败：', err.message);
      process.exit(1);
    }
  });
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') exec(`start "" "${url}"`);
    else if (process.platform === 'darwin') exec(`open "${url}"`);
    else exec(`xdg-open "${url}"`);
  } catch {}
}

module.exports = { app, ready };
start(BASE_PORT);
