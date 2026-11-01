const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const DEFAULTS = {
  hermesConfigDir: process.env.HERMES_CONFIG_DIR || path.join(__dirname, '..', 'config'),
  node: process.env.HERMES_NODE || process.execPath,
  socialAutoUploadRoot: process.env.SOCIAL_AUTO_UPLOAD_ROOT || path.join(__dirname, '..', 'unconfigured-social-auto-upload'),
  toutiaoOps: process.env.TOUTIAO_OPS || path.join(__dirname, '..', 'unconfigured-toutiao-ops', 'index.js'),
};

const SAU_PLATFORMS = {
  douyin: 'douyin',
  kuaishou: 'kuaishou',
  bilibili: 'bilibili',
  shipinhao: 'tencent',
  xiaohongshu: 'xiaohongshu',
};

const BROWSER_PLATFORMS = {
  zhihu: {
    url: 'https://www.zhihu.com/signin',
    methodLabel: '浏览器登录 + Wechatsync',
    instructions: '请在 Chrome 登录知乎，并保持 Wechatsync 扩展设置页处于已连接状态。',
  },
  baijiahao: {
    url: 'https://baijiahao.baidu.com/builder/theme/bjh/login',
    methodLabel: '浏览器登录 + Wechatsync',
    instructions: '请在 Chrome 登录百家号，并保持 Wechatsync 扩展设置页处于已连接状态。',
  },
  csdn: {
    url: 'https://passport.csdn.net/login',
    methodLabel: '浏览器登录 + Wechatsync',
    instructions: '请在 Chrome 登录 CSDN，并保持 Wechatsync 扩展设置页处于已连接状态。',
  },
};

const jobs = new Map();

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function runtimeConfig() {
  const video = readJson(path.join(DEFAULTS.hermesConfigDir, 'video-publisher.json'));
  const article = readJson(path.join(DEFAULTS.hermesConfigDir, 'article-publisher.json'));
  const root = video.socialAutoUploadRoot || DEFAULTS.socialAutoUploadRoot;
  return {
    socialAutoUploadRoot: root,
    python: process.env.SOCIAL_AUTO_UPLOAD_PYTHON || path.join(root, '.venv', 'Scripts', 'python.exe'),
    sauScript: path.join(root, 'sau_cli.py'),
    accounts: video.accounts || {},
    toutiaoOps: article.toutiaoOps || DEFAULTS.toutiaoOps,
    toutiaoAccount: article.toutiaoAccount || 'default',
  };
}

function sanitizeRuntimeAccount(value, fallback = 'default') {
  const text = String(value || fallback).trim();
  if (!text || text.length > 48 || /[\\/\x00-\x1f<>:"|?*]/.test(text)) {
    const error = new Error('本地登录身份仅允许 1–48 个普通字符，不能包含路径符号');
    error.status = 400;
    throw error;
  }
  return text;
}

function defaultRuntimeAccount(platformId) {
  const config = runtimeConfig();
  if (platformId === 'toutiao') return sanitizeRuntimeAccount(config.toutiaoAccount);
  const key = SAU_PLATFORMS[platformId];
  return key ? sanitizeRuntimeAccount(config.accounts[key] || config.accounts[platformId] || 'default') : '';
}

function capabilityForPlatform(platform) {
  if (SAU_PLATFORMS[platform.id]) {
    return {
      provider: 'social-auto-upload', methodLabel: '扫码登录', canCheck: true, canLogin: true,
      loginAction: platform.id === 'bilibili' ? '打开登录终端' : '去登录',
      instructions: platform.id === 'bilibili'
        ? '登录将在独立终端中显示二维码；二维码不完整时可打开终端提示的 qrcode.png。'
        : '点击后会生成平台二维码；扫码完成后登录状态会自动保存到本机适配器。',
      runtimeAccount: defaultRuntimeAccount(platform.id),
    };
  }
  if (platform.id === 'toutiao') {
    return {
      provider: 'toutiao-ops', methodLabel: '头条浏览器扫码登录', canCheck: true, canLogin: true,
      loginAction: '去登录', instructions: '点击后会打开今日头条登录窗口，扫码成功后自动保存本机登录状态。',
      runtimeAccount: defaultRuntimeAccount(platform.id),
    };
  }
  if (BROWSER_PLATFORMS[platform.id]) {
    return {
      provider: 'browser-extension', canCheck: false, canLogin: true, loginAction: '打开登录页',
      ...BROWSER_PLATFORMS[platform.id],
    };
  }
  if (platform.id === 'wechat') {
    return {
      provider: 'wechat-editor', methodLabel: 'wechat-editor 本地配置', canCheck: false, canLogin: false,
      loginAction: '', instructions: '微信公众号不使用二维码登录；由 Hermes 的 wechat-editor 配置调用，并始终只保存草稿。',
    };
  }
  if (platform.id === 'youtube') {
    return {
      provider: 'credentials', methodLabel: 'OAuth 凭据', canCheck: true, canLogin: false,
      loginAction: '', instructions: '编辑账号并填写 OAuth Client ID、Client Secret 和 Refresh Token 后可检查。',
    };
  }
  return {
    provider: 'unsupported', methodLabel: '登录通道未接入', canCheck: false, canLogin: false,
    loginAction: '', instructions: 'MediaHub 尚未接入该平台的安全登录与草稿通道。',
  };
}

function capabilityForAccount(account, platform) {
  const capability = capabilityForPlatform(platform);
  return {
    ...capability,
    runtimeAccount: capability.runtimeAccount
      ? sanitizeRuntimeAccount(account.runtimeAccount || capability.runtimeAccount)
      : undefined,
  };
}

function execFileResult(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024, ...options }, (error, stdout, stderr) => {
      resolve({ code: error && Number.isInteger(error.code) ? error.code : error ? -1 : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error });
    });
  });
}

function commandFor(account, platform, action) {
  const capability = capabilityForAccount(account, platform);
  const runtimeAccount = capability.runtimeAccount;
  const config = runtimeConfig();
  if (capability.provider === 'social-auto-upload') {
    const args = [config.sauScript, SAU_PLATFORMS[platform.id], action, '--account', runtimeAccount];
    // 登录必须显示平台官方页面，让用户自行选择扫码、短信验证码或密码登录。
    if (action === 'login' && platform.id !== 'bilibili') args.push('--headed');
    return { file: config.python, args, cwd: config.socialAutoUploadRoot, qrRoot: path.join(config.socialAutoUploadRoot, 'cookies') };
  }
  if (capability.provider === 'toutiao-ops') {
    const args = [config.toutiaoOps, '--account', runtimeAccount, 'auth', action === 'check' ? 'check' : 'login'];
    if (action === 'check') args.push('--headless');
    return { file: DEFAULTS.node, args, cwd: path.dirname(config.toutiaoOps) };
  }
  return null;
}

async function checkAccount(account, platform, verifyCredentials) {
  const capability = capabilityForAccount(account, platform);
  if (capability.provider === 'credentials') return verifyCredentials();
  if (capability.provider === 'wechat-editor') {
    return { ok: false, status: 'runtime_check', message: capability.instructions };
  }
  if (capability.provider === 'browser-extension') {
    return { ok: false, status: 'action_required', message: `${capability.instructions} MediaHub 无法读取扩展登录状态，请在执行草稿任务前确认扩展显示已连接。` };
  }
  if (capability.provider === 'unsupported') {
    return { ok: false, status: 'unsupported', message: capability.instructions };
  }
  const command = commandFor(account, platform, 'check');
  if (!command || !fs.existsSync(command.file) || !fs.existsSync(command.args[0])) {
    return { ok: false, status: 'unavailable', message: '本地登录适配器未找到，请检查 Hermes 与发布 Skill 配置。' };
  }
  const result = await execFileResult(command.file, command.args, { cwd: command.cwd, env: { ...process.env, PYTHONUTF8: '1' } });
  if (result.code === 0) return { ok: true, status: 'active', message: `登录状态有效（本地身份：${capability.runtimeAccount}）` };
  if (result.code === 1 || /invalid|未登录|失效/i.test(`${result.stdout}\n${result.stderr}`)) {
    return { ok: false, status: 'invalid', message: `未登录或登录已过期（本地身份：${capability.runtimeAccount}）` };
  }
  return { ok: false, status: 'unavailable', message: '登录状态检查失败，请确认 Hermes 运行环境可用后重试。' };
}

function stripAnsi(value) {
  return String(value || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function findQrPath(job, output = '') {
  const clean = stripAnsi(output);
  const matches = clean.match(/[A-Za-z]:[\\/][^\r\n"'<>|]+?\.png/gi) || [];
  for (const match of matches.reverse()) {
    const candidate = path.resolve(match.trim());
    if (fs.existsSync(candidate)) return candidate;
  }
  if (!job.qrRoot || !fs.existsSync(job.qrRoot)) return null;
  const candidates = fs.readdirSync(job.qrRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.png$/i.test(entry.name))
    .map((entry) => path.join(job.qrRoot, entry.name))
    .filter((file) => fs.statSync(file).mtimeMs >= job.startedMs - 2000)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0] || null;
}

function publicJob(job) {
  if (!job) return null;
  const qrPath = job.qrPath && fs.existsSync(job.qrPath) ? job.qrPath : findQrPath(job, job.output);
  if (qrPath) job.qrPath = qrPath;
  return {
    id: job.id, accountId: job.accountId, status: job.status, message: job.message,
    qrAvailable: !!qrPath, startedAt: job.startedAt, finishedAt: job.finishedAt || null,
  };
}

function startLogin(account, platform, onFinish = () => {}) {
  const capability = capabilityForAccount(account, platform);
  if (capability.provider === 'browser-extension') {
    return { kind: 'external', externalUrl: capability.url, status: 'action_required', message: capability.instructions };
  }
  if (!capability.canLogin) {
    return { kind: 'unavailable', status: 'unsupported', message: capability.instructions };
  }
  const active = [...jobs.values()].find((job) => job.accountId === account.id && ['starting', 'waiting_scan'].includes(job.status));
  if (active) return { kind: 'session', session: publicJob(active) };
  const command = commandFor(account, platform, 'login');
  if (!command || !fs.existsSync(command.file) || !fs.existsSync(command.args[0])) {
    return { kind: 'unavailable', status: 'unavailable', message: '本地登录适配器未找到，请检查 Hermes 与发布 Skill 配置。' };
  }

  if (platform.id === 'bilibili') {
    const child = spawn('cmd.exe', ['/c', 'start', 'MediaHub Bilibili Login', command.file, ...command.args], {
      cwd: command.cwd, detached: true, windowsHide: false, stdio: 'ignore',
    });
    child.unref();
    return { kind: 'external-terminal', status: 'action_required', message: '已打开哔哩哔哩登录终端。请在终端扫码，完成后回到这里点击“检查登录”。' };
  }

  const job = {
    id: crypto.randomUUID(), accountId: account.id, status: 'starting',
    message: '正在准备登录二维码或浏览器窗口…', output: '', qrPath: null, qrRoot: command.qrRoot,
    startedAt: new Date().toISOString(), startedMs: Date.now(), finishedAt: null,
  };
  jobs.set(job.id, job);
  const child = spawn(command.file, command.args, {
    cwd: command.cwd, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  job.child = child;
  job.status = 'waiting_scan';
  job.message = platform.id === 'toutiao' ? '登录窗口已打开，请在窗口中完成扫码。' : '正在生成二维码，请稍候…';
  const capture = (chunk) => {
    job.output = `${job.output}${chunk.toString('utf8')}`.slice(-24000);
    const qr = findQrPath(job, job.output);
    if (qr) { job.qrPath = qr; job.message = '请使用对应平台 App 扫描二维码。'; }
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('error', (error) => {
    job.status = 'failed'; job.message = `登录工具启动失败：${error.message}`; job.finishedAt = new Date().toISOString();
    onFinish({ ok: false, status: 'unavailable', message: job.message });
  });
  child.on('exit', (code) => {
    if (job.finishedAt) return;
    job.finishedAt = new Date().toISOString();
    job.status = code === 0 ? 'success' : 'failed';
    job.message = code === 0 ? '登录成功，登录状态已保存。' : '登录未完成或二维码已过期，请重新登录。';
    onFinish({ ok: code === 0, status: code === 0 ? 'active' : 'invalid', message: job.message });
  });
  job.timeout = setTimeout(() => {
    if (!job.finishedAt) {
      child.kill();
      job.status = 'expired'; job.message = '登录等待已超时，请重新生成二维码。'; job.finishedAt = new Date().toISOString();
      onFinish({ ok: false, status: 'invalid', message: job.message });
    }
  }, 5 * 60 * 1000);
  return { kind: 'session', session: publicJob(job) };
}

function getJob(id) { return publicJob(jobs.get(id)); }
function getQrPath(id) {
  const job = jobs.get(id);
  if (!job) return null;
  const info = publicJob(job);
  return info.qrAvailable ? job.qrPath : null;
}

module.exports = {
  capabilityForPlatform, capabilityForAccount, defaultRuntimeAccount, sanitizeRuntimeAccount,
  checkAccount, startLogin, getJob, getQrPath,
  _testing: { commandFor, runtimeConfig, findQrPath },
};
