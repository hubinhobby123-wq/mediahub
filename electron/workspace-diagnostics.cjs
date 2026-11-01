const http=require('http');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
async function installDiagnostics(win, workspace, directory) {
  const token=crypto.randomBytes(32).toString('hex');
  const discovery=path.join(directory,'workspace-diagnostics.json');
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
    if(req.headers.authorization!=='Bearer '+token || req.headers.origin) {res.writeHead(403);res.end('{"error":"forbidden"}');return;}
    if(req.method!=='GET'||req.url!=='/status'){res.writeHead(404);res.end('{}');return;}
    try {await workspace.flush();res.end(JSON.stringify({...await workspace.inspect(),window:{visible:win.isVisible(),minimized:win.isMinimized(),title:win.getTitle()}}));}
    catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  fs.writeFileSync(discovery,JSON.stringify({port:server.address().port,token,pid:process.pid}));
  win.once('closed',()=>{server.close();if(fs.existsSync(discovery)){const latest=JSON.parse(fs.readFileSync(discovery));if(latest.pid===process.pid)fs.unlinkSync(discovery);}});
}
module.exports={installDiagnostics};
