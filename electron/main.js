// Electron 桌面壳：把本地服务包成独立窗口应用（npm run desktop）
// 服务逻辑完全复用 server/，这里只负责窗口与生命周期。
const { app, BrowserWindow, shell, Menu, dialog } = require('electron');
const path = require('path');
const http = require('http');

process.env.NO_OPEN = '1'; // 服务端不再自动开系统浏览器
if (process.env.MEDIAHUB_USER_DATA) {
  require('fs').mkdirSync(process.env.MEDIAHUB_USER_DATA, { recursive: true });
  app.setPath('userData', process.env.MEDIAHUB_USER_DATA);
}
// Keep platform cookies and Chromium cache beside this installation, off C:.
const sessionDir = path.resolve(process.env.MEDIAHUB_SESSION_DIR || path.join(__dirname, '..', 'data', 'browser-sessions'));
require('fs').mkdirSync(sessionDir, { recursive: true });
app.setPath('sessionData', sessionDir);

let win = null;
async function existingServer(url) {
  return new Promise(resolve => {
    const req = http.get(url + '/api/identity', res => {
      let body = ''; res.on('data', chunk => { body += chunk; });
      res.on('end', () => { try { const data = JSON.parse(body); resolve(data.name === 'mediahub' && path.resolve(data.dataDir).toLowerCase() === path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')).toLowerCase()); } catch { resolve(false); } });
    });
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function waitPort(url, timeoutMs = 20000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) reject(new Error('本地服务启动超时'));
        else setTimeout(probe, 300);
      });
    };
    probe();
  });
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    title: 'MediaHub · 自媒体分发工作台',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Explicitly show even when the launcher inherited Windows SW_HIDE.
  win.once('ready-to-show', () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } });
  const workspace=require('./platform-workspace.cjs').installWorkspace(win, url);
  require('./workspace-diagnostics.cjs').installDiagnostics(win,workspace,sessionDir).catch(e=>dialog.showErrorBox('工作区诊断启动失败',e.message));
  // 站内是单页应用；外部链接（平台站点、youtu.be 等）交回系统默认浏览器
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    shell.openExternal(u);
    return { action: 'deny' };
  });
  win.on('closed', () => (win = null));
  win.loadURL(url).then(async()=>{
    if(process.env.MEDIAHUB_OPEN_ACCOUNT) await win.webContents.executeJavaScript('window.mediahubDesktop.openAccount('+JSON.stringify(process.env.MEDIAHUB_OPEN_ACCOUNT)+')');
  }).catch(e=>dialog.showErrorBox('工作台打开失败',e.message));
}

const ownsDesktop = app.requestSingleInstanceLock();
if (!ownsDesktop) app.quit();
if (ownsDesktop) app.whenReady().then(async () => {
  try {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: '视图',
        submenu: [
          { role: 'reload', label: '刷新' },
          { role: 'zoomIn', label: '放大' },
          { role: 'zoomOut', label: '缩小' },
          { role: 'toggleDevTools', label: '开发者工具' },
        ],
      },
    ]));
    let url = `http://localhost:${process.env.PORT || 8788}`;
    if (!await existingServer(url)) {
      const server = require(path.join(__dirname, '..', 'server', 'index.js'));
      url = (await server.ready).url;
    }
    await waitPort(url);
    createWindow(url);
    if (process.env.MEDIAHUB_SMOKE === '1') {
      // 冒烟模式：窗口起来即认为成功，随后自动退出
      setTimeout(() => {
        console.log('SMOKE_OK');
        app.quit();
      }, 3000);
    }
  } catch (e) {
    dialog.showErrorBox('启动失败', e.message || String(e));
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});
app.on('activate', () => {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});
