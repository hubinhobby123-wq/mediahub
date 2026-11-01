// 前端路由：hash -> 视图
let pollTimer = null;

function setPoll(fn, ms) {
  clearPoll();
  pollTimer = setInterval(fn, ms);
}

function clearPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

const ROUTES = [
  { re: /^#?\/?$/, nav: 'workbench', view: () => renderWorkbench() },
  { re: /^#\/contents$/, nav: 'contents', view: () => renderContents() },
  { re: /^#\/videos$/, nav: 'videos', view: () => renderVideos() },
  { re: /^#\/accounts$/, nav: 'accounts', view: () => renderAccounts() },
  { re: /^#\/tasks$/, nav: 'videos', view: () => renderTasks() },
  { re: /^#\/tasks\/([\w-]+)$/, nav: 'videos', view: (m) => renderTaskDetail(m[1]) },
  { re: /^#\/ai$/, nav: 'ai', view: () => renderAi() },
];

async function render() {
  clearPoll();
  const hash = location.hash || '#/';
  const route = ROUTES.find((r) => r.re.test(hash));
  $$('#nav a').forEach((a) => a.classList.toggle('active', route && a.dataset.nav === route.nav));
  state.route = route ? route.nav : '';
  const app = $('#app');
  if (!route) {
    app.innerHTML = '<div class="empty"><div class="ico">🧭</div><b>页面不存在</b><p><a class="link" href="#/">返回总览</a></p></div>';
    return;
  }
  const m = hash.match(route.re);
  try {
    await route.view(m);
  } catch (e) {
    app.innerHTML = `<div class="empty"><div class="ico">⚠️</div><b>页面加载失败</b><p>${esc(e.message)}</p><a class="btn" href="#/">返回总览</a></div>`;
  }
}

window.addEventListener('hashchange', render);

(async function init() {
  state.platforms = await API.get('/api/platforms');
  render();
})();
