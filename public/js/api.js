// API 请求封装 + 全局状态 + 文件上传
const state = {
  platforms: [],
  route: '',
};

const API = {
  async req(path, opts = {}) {
    const init = { ...opts };
    if (init.body && !(init.body instanceof FormData)) {
      init.headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch (e) {
      throw new Error('网络错误，请确认本地服务已启动');
    }
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error((data && data.error) || `请求失败（${res.status}）`);
    return data;
  },
  get(p) { return this.req(p); },
  post(p, body) { return this.req(p, { method: 'POST', body: body ? JSON.stringify(body) : undefined }); },
  patch(p, body) { return this.req(p, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }); },
  del(p) { return this.req(p, { method: 'DELETE' }); },
};

// 带进度的文件上传
function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error((data && data.error) || `上传失败（${xhr.status}）`));
    };
    xhr.onerror = () => reject(new Error('网络错误，上传失败'));
    xhr.send(fd);
  });
}
