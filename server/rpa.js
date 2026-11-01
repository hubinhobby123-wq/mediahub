// RPA 框架：用 Playwright 驱动本机 Chromium，以导入的 Cookie 登录态操作平台发布页
// - Cookie 支持两种格式：原始字符串（"a=b; c=d"）或 DevTools 导出的 JSON 数组
// - 出错时自动截图到 data/rpa-debug/ 方便排查选择器失效
const fs = require('fs');
const path = require('path');
const store = require('./store');

const DEBUG_DIR = path.join(store.DATA_DIR, 'rpa-debug');
const HEADLESS = process.env.MEDIAHUB_RPA_HEADLESS !== '0';
// 平台对自动化浏览器指纹敏感，用常见桌面 Chrome 的 UA 降低风控概率
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function parseCookies(raw, fallbackDomain) {
  if (!raw || !String(raw).trim()) return [];
  const s = String(raw).trim();
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) {
      return arr
        .filter((c) => c && c.name && c.value !== undefined)
        .map((c) => ({
          name: c.name,
          value: String(c.value),
          domain: c.domain || fallbackDomain,
          path: c.path || '/',
          expires: c.expires && c.expires > 0 ? c.expires : -1,
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
        }));
    }
  } catch {}
  // 原始字符串：a=b; c=d
  return s
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf('=');
      if (i <= 0) return null;
      return { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), domain: fallbackDomain, path: '/' };
    })
    .filter(Boolean);
}

/**
 * 打开带登录态的浏览器会话执行 fn(page)。
 * account.credentials.cookie 为空时抛出引导性错误。
 */
async function withSession(account, domain, fn) {
  const cookies = parseCookies(account.credentials && account.credentials.cookie, domain);
  if (!cookies.length) {
    throw new Error('该账号尚未导入 Cookie：请到「账号管理」编辑该账号，粘贴浏览器登录后的 Cookie（详见提示文案）');
  }
  let page = null;
  let browser = null;
  try {
    let chromium;
    try {
      ({ chromium } = require('playwright'));
    } catch {
      throw new Error('未安装浏览器自动化组件：请在项目目录执行 npm install && npx playwright install chromium');
    }
    browser = await launchBrowser(chromium);
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
    await ctx.addCookies(cookies);
    page = await ctx.newPage();
    return await fn(page);
  } catch (e) {
    // 调试截图：帮助发现平台改版导致的选择器失效
    try {
      if (page) {
        fs.mkdirSync(DEBUG_DIR, { recursive: true });
        const file = path.join(DEBUG_DIR, `${Date.now()}-${account.platformId || 'rpa'}.png`);
        await page.screenshot({ path: file, fullPage: false });
        console.error('[RPA] 已保存调试截图：', file);
      }
    } catch {}
    if (e && /Timeout .*exceeded|timed out/i.test(e.message)) {
      throw new Error('页面操作超时：平台页面结构可能已变化，或登录态已失效（可用「验证」检查登录态）');
    }
    throw e;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function isLoginPage(url) {
  const u = String(url).toLowerCase();
  return /login|signin|passport/.test(u);
}

// 浏览器选择：优先环境变量指定（MEDIAHUB_RPA_CHANNEL=chrome/msedge/chromium），
// 否则依次尝试系统 Chrome、系统 Edge，最后回退 Playwright 自带的 Chromium。
async function launchBrowser(chromium) {
  const prefer = process.env.MEDIAHUB_RPA_CHANNEL;
  const candidates = prefer
    ? [prefer]
    : ['chrome', 'msedge', 'chromium'];
  let lastErr;
  for (const channel of candidates) {
    try {
      const opts = { headless: HEADLESS };
      if (channel !== 'chromium') opts.channel = channel;
      return await chromium.launch(opts);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    '无法启动浏览器（已尝试 ' + candidates.join('、') + '）。' +
      (lastErr ? lastErr.message : '') +
      ' 可安装系统 Chrome/Edge，或执行 npx playwright install chromium'
  );
}

module.exports = { withSession, parseCookies, isLoginPage, launchBrowser, UA };
