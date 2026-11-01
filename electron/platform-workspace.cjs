const { WebContentsView, ipcMain } = require('electron');
const path = require('path');
const { HOMES, allowed, partition } = require('./platform-policy.cjs');

function installWorkspace(win, baseUrl) {
  let current = null;
  const trusted = event => event.sender === win.webContents && new URL(event.sender.getURL()).origin === new URL(baseUrl).origin;
  const close = () => {
    if (!current) return;
    const closing=current;current=null;
    for (const view of [closing.page,closing.toolbar]) {
      win.contentView.removeChildView(view);
      view.webContents.close();
    }
    current = null;
  };
  const layout = () => {
    if (!current) return;
    const [width,height] = win.getContentSize();
    current.toolbar.setBounds({x:0,y:0,width,height:72});
    current.page.setBounds({x:0,y:72,width,height:Math.max(0,height-72)});
  };
  ipcMain.handle('platform:open', async (event, request) => {
    if (!trusted(event)) throw new Error('只接受工作台发起的账号操作');
    const response = await fetch(baseUrl+'/api/accounts');
    if (!response.ok) throw new Error('无法读取账号');
    const accounts = await response.json();
    const account = accounts.find(a => a.id === request?.accountId);
    if (!account || !HOMES[account.platformId]) throw new Error('此平台尚未配置应用内入口');
    const url = request.url || HOMES[account.platformId];
    if (!allowed(account.platformId,url)) throw new Error('作品网址与所选平台不匹配');
    if (current?.account.id === account.id) { await current.page.webContents.loadURL(url); return {opened:true}; }
    close();
    const page = new WebContentsView({webPreferences:{partition:partition(account.id),nodeIntegration:false,contextIsolation:true,sandbox:true}});
    const toolbar = new WebContentsView({webPreferences:{preload:path.join(__dirname,'platform-toolbar-preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
    current = {page,toolbar,account};
    const update = error => { if (current?.page === page && toolbar.webContents && !toolbar.webContents.isDestroyed()) toolbar.webContents.send('platform:state',{name:account.name,url:page.webContents.getURL(),error}); };
    page.webContents.session.setPermissionRequestHandler((_wc,_permission,callback) => callback(false));
    page.webContents.on('will-navigate',(e,target) => {if (!allowed(account.platformId,target)) {e.preventDefault();update('跨域登录跳转需单独适配，已停止');}});
    page.webContents.setWindowOpenHandler(({url:target}) => {
      if (allowed(account.platformId,target)) page.webContents.loadURL(target).catch(e=>update(e.message));
      else update('此登录弹窗需单独适配，已停止');
      return {action:'deny'};
    });
    page.webContents.on('did-navigate',()=>update());
    page.webContents.on('did-fail-load',(_e,code,description,_url,isMainFrame)=>{if(isMainFrame&&code!==-3) update('页面加载失败：'+description);});
    win.contentView.addChildView(page);win.contentView.addChildView(toolbar);layout();
    await toolbar.webContents.loadFile(path.join(__dirname,'platform-toolbar.html'));
    update();
    page.webContents.loadURL(url).catch(e=>update(e.message));
    return {opened:true,session:'account-isolated',verifiedLogin:false};
  });
  ipcMain.handle('platform:control', (event, action) => {
    if (!current || event.sender !== current.toolbar.webContents) throw new Error('无效工作区');
    if(action==='close') close();
    else if(action==='reload') current.page.webContents.reload();
    else if(action==='back' && current.page.webContents.navigationHistory.canGoBack()) current.page.webContents.navigationHistory.goBack();
  });
  win.on('resize',layout);
  win.on('close',close);
  win.on('closed',()=>{ipcMain.removeHandler('platform:open');ipcMain.removeHandler('platform:control');});
  return {
    async inspect() {
      if (!current) return {open:false};
      const selected=current;
      const url=selected.page.webContents.getURL();
      if (!allowed(selected.account.platformId,url)) return {open:true,platformId:selected.account.platformId,error:'页面不在平台允许域名中'};
      const text=await selected.page.webContents.executeJavaScript('document.body ? document.body.innerText.slice(0, 16000) : ""');
      if(current!==selected) throw new Error('工作区已切换，请重新读取');
      return {open:true,accountId:selected.account.id,accountName:selected.account.name,platformId:selected.account.platformId,url,text,observedAt:new Date().toISOString()};
    },
    async flush() {if(current)await current.page.webContents.session.cookies.flushStore();}
  };
}
module.exports = {installWorkspace};
