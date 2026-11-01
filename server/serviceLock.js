const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
// One scheduler owns one database. Ambiguous/corrupt locks fail closed.
function acquire(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, '.mediahub-service.lock');
  const owner = { pid: process.pid, token: crypto.randomUUID() };
  try {
    const fd = fs.openSync(file, 'wx');
    try { fs.writeFileSync(fd, JSON.stringify(owner)); } finally { fs.closeSync(fd); }
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let previous;
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('MediaHub服务锁异常，请人工核查后再启动'); }
    if (!Number.isInteger(previous.pid) || previous.pid <= 0 || !previous.token) throw new Error('MediaHub服务锁身份不完整');
    try { process.kill(previous.pid, 0); throw new Error('该数据库已有MediaHub服务运行；请复用它，不启动第二个调度器'); }
    catch (check) { if (check.code !== 'ESRCH') throw check; }
    // Serialize stale-lock recovery too: two simultaneous starts must not
    // both remove the same dead lock and then replace each other's new owner.
    const recoveryFile = file + '.recovery';
    let fd;
    try { fd = fs.openSync(recoveryFile, 'wx'); } catch { throw new Error('已有锁恢复检查进行中或遗留恢复锁，请人工核查'); }
    try {
      fs.writeFileSync(fd, JSON.stringify(owner)); fs.closeSync(fd); fd = undefined;
      if (fs.readFileSync(file, 'utf8') !== JSON.stringify(previous)) throw new Error('服务锁已改变，请稍后重试');
      fs.unlinkSync(file);
      return acquire(dataDir);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(recoveryFile) && fs.readFileSync(recoveryFile, 'utf8') === JSON.stringify(owner)) fs.unlinkSync(recoveryFile);
    }
  }
  const release = () => {
    if (!fs.existsSync(file)) return;
    if (fs.readFileSync(file, 'utf8') === JSON.stringify(owner)) fs.unlinkSync(file);
  };
  return release;
}
module.exports = { acquire };
