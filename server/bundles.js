const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function hashJsonFile(filePath) {
  return crypto.createHash('sha256').update(JSON.stringify(JSON.parse(fs.readFileSync(filePath, 'utf8')))).digest('hex');
}

function readBundle(bundlePath) {
  if (!path.isAbsolute(String(bundlePath || ''))) throw new Error('适配包路径必须是本机绝对路径');
  const absolute = path.resolve(bundlePath);
  let raw;
  try { raw = fs.readFileSync(absolute, 'utf8'); } catch (error) { throw new Error(`无法读取适配包：${error.message}`); }
  let bundle;
  try { bundle = JSON.parse(raw); } catch { throw new Error('适配包不是有效 JSON'); }
  if (bundle.schemaVersion !== 1) throw new Error(`不支持的适配包版本：${bundle.schemaVersion}`);
  if (!['article', 'video'].includes(bundle.contentType)) throw new Error('适配包 contentType 必须是 article 或 video');
  if (!bundle.bundleId || !bundle.runDirectory || !bundle.source?.path || !bundle.source?.sha256) throw new Error('适配包缺少 bundleId、runDirectory 或源文件校验信息');
  if (!fs.existsSync(bundle.source.path)) throw new Error('适配包引用的源文件不存在');
  if (hashFile(bundle.source.path) !== bundle.source.sha256) throw new Error('适配包引用的源文件校验值不一致，文件可能已变化');
  if (!bundle.platformVersions || !Object.keys(bundle.platformVersions).length) throw new Error('适配包没有平台版本');
  for (const [platform, version] of Object.entries(bundle.platformVersions)) {
    if (bundle.contentType === 'article' && (!version.bodyFile || !fs.existsSync(version.bodyFile))) throw new Error(`${platform} 的正文文件不存在`);
    if (bundle.contentType === 'article' && hashFile(version.bodyFile) !== version.bodySha256) throw new Error(`${platform} 的正文校验值不一致`);
    if (bundle.contentType === 'video' && (!version.metadataFile || !fs.existsSync(version.metadataFile))) throw new Error(`${platform} 的元数据文件不存在`);
    if (bundle.contentType === 'video' && hashJsonFile(version.metadataFile) !== version.metadataSha256) throw new Error(`${platform} 的元数据校验值不一致`);
    if (version.verification !== 'verified') throw new Error(`${platform} 版本尚未通过 Skill 校验`);
  }
  return { absolute, bundle };
}

function importBundle(bundlePath) {
  const { absolute, bundle } = readBundle(bundlePath);
  if(store.db.deletionLedger?.some(x=>x.kind==='content'&&x.bundleId===bundle.bundleId))throw Error('此适配包已彻底删除，不能静默重新导入投递；请创建明确的新版本');
  const existing = store.db.contents.find((content) => content.skillBundle?.bundleId === bundle.bundleId);
  if (existing) return { content: existing, created: false, lifecycle:existing.lifecycle?.state||'active', requiresRestore:Boolean(existing.lifecycle?.state&&existing.lifecycle.state!=='active') };
  const firstPlatform = Object.keys(bundle.platformVersions)[0];
  const first = bundle.platformVersions[firstPlatform] || {};
  const body = bundle.contentType === 'article' ? fs.readFileSync(first.bodyFile, 'utf8') : '';
  const sourceStat = fs.statSync(bundle.source.path);
  const content = {
    id: store.nextId(),
    type: bundle.contentType,
    subtype: bundle.contentType === 'article' ? 'long_article' : 'video',
    title: bundle.title || first.title || path.basename(bundle.source.path, path.extname(bundle.source.path)),
    desc: bundle.description || first.description || '',
    tags: bundle.tags || first.tags || [],
    body,
    videoFile: bundle.contentType === 'video' ? { id: null, name: path.basename(bundle.source.path), path: bundle.source.path, absolutePath: bundle.source.path, size: sourceStat.size, mime: 'video/mp4', external: true } : null,
    coverFile: null,
    images: [],
    platformVersions: bundle.platformVersions,
    skillBundle: { bundleId: bundle.bundleId, bundlePath: absolute, runDirectory: bundle.runDirectory, source: bundle.source },
    createdAt: store.now(),
    updatedAt: store.now(),
  };
  store.db.contents.push(content);
  const platformMap = { tencent: 'shipinhao' };
  for (const skillPlatform of Object.keys(bundle.platformVersions)) {
    const platformId = platformMap[skillPlatform] || skillPlatform;
    if (!store.db.accounts.some((account) => account.platformId === platformId && account.isDefault)) {
      store.db.accounts.push({ id: store.nextId(), platformId, name: '默认账号', credentials: {}, status: 'runtime_check', isDefault: true, createdAt: store.now(), lastVerifiedAt: null, lastVerifyMessage: '执行任务前由 Skill 检查登录态' });
    }
  }
  store.save();
  return { content, created: true };
}

module.exports = { readBundle, importBundle };
