async function verify() {
  return { ok: false, status: 'unsupported', message: '该平台尚无可验证的草稿适配器' };
}

async function publish(ctx) {
  return { ok: false, status: 'unsupported', retryable: false, message: `${ctx.platform.name} 暂不支持保存草稿` };
}

module.exports = { verify, publish };
