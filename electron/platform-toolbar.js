document.querySelectorAll('[data-action]').forEach(b => b.onclick = () => window.platformControls.command(b.dataset.action));
window.platformControls.onState(state => {
  document.getElementById('account').textContent = state.name;
  document.getElementById('url').textContent = state.url;
  document.getElementById('status').textContent = state.error || '人工操作中 · 登录不等于发布已接通';
});
