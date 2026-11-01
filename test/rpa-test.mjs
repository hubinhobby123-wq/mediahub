// RPA 框架测试：不依赖真实平台登录态，验证错误路径与 Cookie 解析
// 运行：node test/rpa-test.mjs（需先 npx playwright install chromium）
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let passed = 0;
let failed = 0;
function ok(cond, name, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

const rpa = require('../server/rpa.js');
const xhs = require('../server/adapters/xiaohongshu-rpa.js');
const { PLATFORMS } = require('../server/platforms.js');
const xhsPlatform = PLATFORMS.find((p) => p.id === 'xiaohongshu');

console.log('\n▶ Cookie 解析\n');
const cookies = rpa.parseCookies('a=1; b=等号=值;  ; c=3', '.example.com');
ok(cookies.length === 3, '原始字符串解析（3 条，忽略空段）', JSON.stringify(cookies));
ok(cookies[1].name === 'b' && cookies[1].value === '等号=值', '值中含等号时正确切分');
const jc = rpa.parseCookies(JSON.stringify([{ name: 'web_session', value: 'xyz', domain: '.xiaohongshu.com', expires: 1893456000 }]), '.example.com');
ok(jc.length === 1 && jc[0].domain === '.xiaohongshu.com' && jc[0].expires === 1893456000, 'JSON 数组解析（保留 expires/domain）');
ok(rpa.parseCookies('', '.x.com').length === 0, '空 Cookie 返回空数组');

console.log('\n▶ 适配器错误路径（无 Playwright 登录态依赖）\n');
// 1) 未导入 Cookie：立即给引导性错误，不启动浏览器
let threw = '';
try {
  await xhs.publish({ platform: xhsPlatform, account: { id: '1', credentials: {} }, content: { type: 'article' }, fields: {}, logger: () => {}, uploadRoot: '.' });
} catch (e) { threw = e.message; }
ok(/未导入 Cookie/.test(threw) && /creator\.xiaohongshu\.com/.test(threw), '未导入 Cookie 报引导性错误', threw);

// 2) 失效 Cookie：浏览器会话打开后判定「未登录」（需要 Chromium 就绪）
try {
  const v = await xhs.verify({ id: '2', platformId: 'xiaohongshu', credentials: { cookie: 'web_session=invalid_test' } });
  // 无登录态时平台会跳登录页 → 期望 ok:false 且提示重新导入
  ok(v.ok === false && /Cookie/.test(v.message), '失效 Cookie 验证返回需重新导入', v.message);
} catch (e) {
  ok(/浏览器自动化组件|超时|页面操作/.test(e.message), '失效 Cookie 验证给出可操作错误', e.message);
}

console.log(`\n■ RPA 测试结果：${passed} 通过，${failed} 失败\n`);
process.exitCode = failed ? 1 : 0;
