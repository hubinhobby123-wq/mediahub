// 凭据静态加密：AES-256-GCM，密钥保存在 data/.secretkey（与 db.json 分离）
// 防止 db.json 被直接拷走后明文泄露凭据；密钥文件本身需与数据一同保管。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const KEY_PATH = path.join(DATA_DIR, '.secretkey');
let cachedKey = null;

function getKey() {
  if (cachedKey) return cachedKey;
  try {
    const k = Buffer.from(fs.readFileSync(KEY_PATH, 'utf8').trim(), 'hex');
    if (k.length !== 32) throw new Error('密钥长度异常');
    cachedKey = k;
  } catch {
    cachedKey = crypto.randomBytes(32);
    fs.writeFileSync(KEY_PATH, cachedKey.toString('hex'), { mode: 0o600 });
  }
  return cachedKey;
}

function encryptJSON(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(obj), 'utf8')),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { enc: data.toString('base64') + '.' + iv.toString('base64') };
}

function decryptJSON(blob) {
  const [dataB64, ivB64] = String(blob.enc).split('.');
  const buf = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(buf.subarray(buf.length - 16));
  const plain = Buffer.concat([decipher.update(buf.subarray(0, buf.length - 16)), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

// 落盘前调用：明文凭据 -> { enc }（空对象保持空）
function sealCredentials(creds) {
  if (!creds || Object.keys(creds).length === 0) return {};
  if (creds.enc) return creds;
  return encryptJSON(creds);
}

// 载入后调用：{ enc } -> 明文；兼容旧版明文存储（会在下次保存时自动加密）
function openCredentials(raw) {
  if (!raw || Object.keys(raw).length === 0) return {};
  if (!raw.enc) return raw;
  try {
    return decryptJSON(raw);
  } catch {
    console.error('[警告] 凭据解密失败（data/.secretkey 可能丢失或不匹配），请到「账号管理」重新填写该账号凭据');
    return {};
  }
}

module.exports = { sealCredentials, openCredentials, encryptJSON, decryptJSON };
