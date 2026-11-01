// 本地 JSON 数据存储：数据量小（个人工作台），直接落盘，写文件采用「临时文件 + 原子重命名」防止写坏
// - schema 版本号（meta.version），升级时可做数据迁移
// - 账号凭据静态加密（见 secrets.js），内存中始终是明文，落盘自动加密
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sealCredentials, openCredentials } = require('./secrets');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(ROOT, 'uploads');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const SCHEMA_VERSION = 7;

for (const dir of [DATA_DIR, UPLOAD_DIR]) fs.mkdirSync(dir, { recursive: true });

const EMPTY = {
  meta: { version: SCHEMA_VERSION, createdAt: new Date().toISOString() },
  settings: {},
  accounts: [],
  accountGroups: [],
  contents: [],
  files: [],
  tasks: [],
  videoPackages: [],
  videoJobs: [],
};
let db;
try {
  db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
} catch (error) {
  if (error.code === 'ENOENT') {
    db = JSON.parse(JSON.stringify(EMPTY));
  } else {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const preserved = path.join(BACKUP_DIR, 'db-corrupt-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
    try { fs.copyFileSync(DB_PATH, preserved); } catch {}
    throw new Error(`数据库无法读取，已保留原文件${fs.existsSync(preserved) ? `到 ${preserved}` : ''}：${error.message}`);
  }
}
// v1 -> v2：补齐新字段，凭据解密进内存（旧明文会在下次保存时自动加密）
if (!db.meta) db.meta = { version: 1, createdAt: new Date().toISOString() };
if (!db.settings || typeof db.settings !== 'object' || Array.isArray(db.settings)) db.settings = {};
for (const k of ['accounts', 'accountGroups', 'contents', 'files', 'tasks', 'videoPackages', 'videoJobs', 'deletionLedger']) {
  if (!Array.isArray(db[k])) db[k] = [];
}
for (const a of db.accounts) a.credentials = openCredentials(a.credentials);
db.meta.version = SCHEMA_VERSION;

function save() {
  const clone = {
    ...db,
    accounts: db.accounts.map((a) => ({ ...a, credentials: sealCredentials(a.credentials) })),
  };
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(clone, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

// 启动时备份数据库（保留最近 keep 份）
function backup(keep = 7) {
  try {
    if (!fs.existsSync(DB_PATH)) return;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const name = 'db-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json';
    fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, name));
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('db-')).sort();
    while (files.length > keep) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  } catch (e) {
    console.error('[备份失败]', e.message);
  }
}

function nextId() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

function backupBeforePurge() {
  fs.mkdirSync(BACKUP_DIR, {recursive:true});
  const destination=path.join(BACKUP_DIR,'cleanup-before-'+Date.now()+'-'+crypto.randomUUID()+'.json');
  fs.copyFileSync(DB_PATH,destination,fs.constants.COPYFILE_EXCL);
  return destination;
}

module.exports = { get db() { return db; }, save, nextId, now, backup, backupBeforePurge, ROOT, DATA_DIR, UPLOAD_DIR };
