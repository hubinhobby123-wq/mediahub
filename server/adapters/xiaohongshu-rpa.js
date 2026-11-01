// 小红书 RPA 适配器：Cookie 登录态 + Playwright 模拟「小红书创作服务」发布页操作
// ⚠️ 这是浏览器自动化（非官方 API）：请遵守平台协议、控制发布频率；平台改版后需更新 SELECTORS。
const fs = require('fs');
const path = require('path');
const rpa = require('../rpa');

const HOME = 'https://creator.xiaohongshu.com';
const PUBLISH_URL = HOME + '/publish/publish?source=official';
const COOKIE_DOMAIN = '.xiaohongshu.com';

// 页面选择器集中管理：平台改版时只改这里
const SEL = {
  tabs: '.creator-tab, .el-tabs__item',
  tabText: { video: /上传视频/, article: /上传图文/ },
  fileInput: 'input[type=file]',
  title: '.titleInput input, input[placeholder*="标题"], .c-input_inner[placeholder*="标题"]',
  body: '#post-textarea, textarea[placeholder*="正文"], .ql-editor[contenteditable="true"]',
  submit: 'button.css-k7kh5y, .publishBtn, button:has-text("发布")',
  successToast: 'text=发布成功',
  errorToast: '.css-el22wy, text=发布失败',
};

function checkCookie(account) {
  const raw = account.credentials && account.credentials.cookie;
  if (!raw || !String(raw).trim()) {
    throw new Error(
      '未导入 Cookie。获取方法：本机浏览器登录 creator.xiaohongshu.com → F12 开发者工具 → Network → 任一请求 → 复制请求头里的 Cookie 值（或 Application → Cookies 的 JSON），粘贴到该账号的 Cookie 字段'
    );
  }
  return raw;
}

// 登录态检查：带着 Cookie 打开创作者中心，若被踢到登录页则视为失效
async function verify(account) {
  try {
    const raw = checkCookie(account);
    const hasSession = await rpa.withSession({ ...account, credentials: { cookie: raw } }, COOKIE_DOMAIN, async (page) => {
      await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2500);
      if (rpa.isLoginPage(page.url())) return false;
      // 部分场景登录态失效会在页面内弹出登录引导
      const loginMask = await page
        .locator('text=登录')
        .first()
        .isVisible()
        .catch(() => false);
      return !loginMask;
    });
    return hasSession
      ? { ok: true, status: 'active', message: '登录态有效（RPA 浏览器验证）' }
      : { ok: false, status: 'invalid', message: 'Cookie 已失效或未登录，请重新导入 Cookie' };
  } catch (e) {
    return { ok: false, status: 'invalid', message: e.message };
  }
}

async function publish(ctx) {
  const { account, content, fields, logger } = ctx;
  const raw = checkCookie(account);

  const title = (fields.title || '').trim();
  if (!title) throw new Error('标题不能为空');

  return rpa.withSession({ ...account, credentials: { cookie: raw } }, COOKIE_DOMAIN, async (page) => {
    logger('打开小红书创作服务发布页…');
    await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);
    if (rpa.isLoginPage(page.url())) throw new Error('登录态已失效：请重新导入 Cookie');

    const isVideo = content.type === 'video';
    if (isVideo && !content.videoFile) throw new Error('视频内容缺少视频文件');
    if (!isVideo && !(content.images || []).length) throw new Error('小红书图文笔记至少需要 1 张配图');

    // 选择「上传视频 / 上传图文」标签（发布页默认可能停在另一类）
    const tab = page.getByText(isVideo ? SEL.tabText.video : SEL.tabText.article).first();
    if (await tab.isVisible().catch(() => false)) {
      await tab.click();
      await page.waitForTimeout(1200);
    }

    // 上传文件（视频 1 个 / 图文 1~9 张，一次性全部注入）
    const files = isVideo
      ? [path.join(ctx.uploadRoot, path.basename(content.videoFile.path))]
      : content.images.map((i) => path.join(ctx.uploadRoot, path.basename(i.path)));
    for (const f of files) if (!fs.existsSync(f)) throw new Error('素材文件已丢失：' + path.basename(f));
    logger(`上传${isVideo ? '视频' : `${files.length} 张配图`}：${files.map((f) => path.basename(f)).join('、')}`);
    await page.setInputFiles(SEL.fileInput, files, { timeout: 30000 });

    // 等待平台处理媒体（视频转码较慢）
    await page.waitForTimeout(isVideo ? 8000 : 3500);

    const titleEl = page.locator(SEL.title).first();
    await titleEl.waitFor({ state: 'visible', timeout: 20000 });
    const maxTitle = 20;
    if (title.length > maxTitle) logger(`提示：小红书标题上限 ${maxTitle} 字，已截断`);
    await titleEl.fill(title.slice(0, maxTitle));

    const bodyText = [fields.desc, content.body].filter(Boolean).join('\n\n').slice(0, 1000);
    if (bodyText) {
      const bodyEl = page.locator(SEL.body).first();
      await bodyEl.waitFor({ state: 'visible', timeout: 15000 }).catch(() => null);
      if (bodyEl) {
        await bodyEl.click();
        await page.keyboard.insertText(bodyText);
      }
    }
    if (fields.tags && fields.tags.length) {
      logger(`话题标签将在发布后于 App/网页端手动补充：${fields.tags.join('、')}（发布页自动打话题暂不稳定）`);
    }

    logger('点击发布…');
    const submit = page.locator(SEL.submit).last();
    await submit.click({ timeout: 15000 });

    // 成功判定：出现「发布成功」提示或跳转离开发布页
    const ok1 = await page.locator(SEL.successToast).first().waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false);
    await page.waitForTimeout(1500);
    const leftPublish = !page.url().includes('/publish/publish');
    if (!ok1 && !leftPublish) {
      const errText = await page.locator(SEL.errorToast).first().textContent().catch(() => '');
      throw new Error('发布未确认成功' + (errText ? `：${errText.trim()}` : '（可在 data/rpa-debug 截图排查）'));
    }

    const externalId = 'xhs-' + Date.now().toString(36);
    logger(`发布流程完成（笔记需要平台审核，稍后在 App 内可见）`);
    return { ok: true, externalId, message: '已通过浏览器自动化发布（发布页流程完成）' };
  });
}

module.exports = { verify, publish };
