const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const HASH = /^[a-f0-9]{64}$/;
const aliases = { wechat_channels: 'shipinhao', tencent: 'shipinhao', tiktok: 'tiktok_global', x: 'twitter' };
function platformId(p) { return aliases[p] || p; }
function digest(v) { return crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex'); }
async function hashFile(file) {
  const h = crypto.createHash('sha256');
  for await (const data of fs.createReadStream(file)) h.update(data);
  return h.digest('hex');
}
function parseCopy(md) {
  const lines = md.replace(/^\uFEFF/, '').split(/\r?\n/);
  const titleIndex = lines.findIndex(l => /^#\s+/.test(l));
  if (titleIndex < 0) throw new Error('发布文案缺少一级标题，不能猜测要上传的内容');
  const title = lines[titleIndex].replace(/^#\s+/, '').trim();
  const body = []; let tags = [];
  for (const l of lines.slice(titleIndex + 1)) {
    if (/^#{1,6}\s/.test(l)) break;
    if (/^标签(?:建议)?[：:]/.test(l)) { tags = l.replace(/^标签(?:建议)?[：:]\s*/, '').split(/[#\s,，]+/).filter(Boolean); break; }
    body.push(l);
  }
  if (!title) throw new Error('发布标题为空');
  return { title, description: body.join('\n').trim(), tags };
}
async function loadHandoff(manifestPath) {
  if (!path.isAbsolute(manifestPath)) throw new Error('请使用成品包的绝对路径');
  const realManifest = await fs.promises.realpath(manifestPath);
  const root = path.dirname(realManifest);
  const raw = await fs.promises.readFile(realManifest, 'utf8');
  const input = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (input.schema_version !== 'video-handoff/v1-draft') throw new Error('不支持的 video-handoff 版本');
  for (const k of ['package_id', 'package_revision', 'content_id']) if (!input[k] || typeof input[k] !== 'string') throw new Error(`缺少 ${k}`);
  if (!Array.isArray(input.units) || !input.units.length) throw new Error('成品包没有作品');
  const ids = new Set(); const units = [];
  for (const original of input.units) {
    if (!original.unit_id || ids.has(original.unit_id)) throw new Error('作品ID缺失或重复');
    ids.add(original.unit_id);
    if (!['full', 'clip', 'platform_variant'].includes(original.kind) || !['domestic', 'overseas'].includes(original.release_group) || !original.language || !original.revision) throw new Error(`${original.unit_id} 作品身份不完整`);
    if (!Array.isArray(original.targets) || !original.targets.length || original.targets.some(t => !t.platform || !t.surface)) throw new Error('作品缺少平台/类型');
    if (original.production_status !== 'ready_for_review') throw new Error(`${original.unit_id} 不是可审阅成品`);
    const artifacts = {};
    for (const key of ['video', 'cover', 'copy', ...(original.artifacts?.captions ? ['captions'] : [])]) {
      const a = original.artifacts?.[key];
      if (!a?.path || !HASH.test(a.sha256 || '')) throw new Error(`${original.unit_id}/${key} 缺少文件或校验值`);
      const allowed = { video: ['.mp4','.mov','.mkv','.webm','.m4v'], cover: ['.jpg','.jpeg','.png','.webp'], copy: ['.md'], captions: ['.srt','.vtt'] };
      if (!allowed[key].includes(path.extname(a.path).toLowerCase())) throw new Error(`${key} 素材格式不支持`);
      if (path.isAbsolute(a.path)) throw new Error('包内素材必须使用相对路径');
      const abs = await fs.promises.realpath(path.resolve(root, a.path));
      const relative = path.relative(root, abs);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('素材路径越出成品包');
      const stat = await fs.promises.stat(abs);
      if (!stat.isFile() || !stat.size || await hashFile(abs) !== a.sha256) throw new Error(`${original.unit_id}/${key} 文件校验失败`);
      artifacts[key] = { ...a, absolutePath: abs, size: stat.size };
    }
    const copy = parseCopy(await fs.promises.readFile(artifacts.copy.absolutePath, 'utf8'));
    units.push({ ...original, publish_authorization: 'not_granted', artifacts, copy });
  }
  for (const u of units) if (u.kind !== 'full') {
    const full = units.find(x => x.unit_id === u.release_intent?.depends_on_full_unit);
    if (!full || full.kind !== 'full' || full.release_group !== u.release_group || full.language !== u.language) throw new Error(`${u.unit_id} 缺少同组同语言的完整版锚点`);
  }
  return { manifestPath: realManifest, manifestHash: digest(raw), packageId: input.package_id, revision: input.package_revision, contentId: input.content_id, title: input.title || input.content_id, coverage: input.coverage || [], units };
}
async function verifyAssets(pkg, unit) {
  if (await hashFile(pkg.manifestPath) !== pkg.manifestHash) throw new Error('成品包清单已改变，请交付新版本并重新导入');
  for (const a of Object.values(unit.artifacts)) {
    if (await fs.promises.realpath(a.absolutePath) !== a.absolutePath || await hashFile(a.absolutePath) !== a.sha256) throw new Error('成品素材已改变，请交付新版本');
  }
}
module.exports = { loadHandoff, hashFile, digest, parseCopy, platformId, verifyAssets };
