import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const root = path.resolve('.tmp-tests-integration-' + crypto.randomUUID());
const dataDir = path.join(root, 'data');
const uploadDir = path.join(root, 'uploads');
process.env.DATA_DIR = dataDir;
process.env.UPLOAD_DIR = uploadDir;
process.env.MEDIAHUB_SAFE_TEST = '1';
process.env.MEDIAHUB_SKILL_NODE = process.execPath;
process.env.MEDIAHUB_ARTICLE_SCRIPT = path.resolve('test/fake-skill.js');
process.env.MEDIAHUB_ARTICLE_CONFIG = path.join(root, 'test-config.json');

const require = createRequire(import.meta.url);
const store = require('../server/store');
const { importBundle } = require('../server/bundles');
const { createDistribution } = require('../server/taskService');
const engine = require('../server/engine');
const { getPlatform } = require('../server/platforms');
const { getAdapter } = require('../server/adapters');
const { lastJsonObject } = require('../server/adapters/skill-publisher');

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const waitFor = async (predicate, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('timed out');
};

test.before(async () => {
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, 'run'), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(uploadDir, { recursive: true });
  await writeFile(process.env.MEDIAHUB_ARTICLE_CONFIG, '{}');
});
test.after(async () => { await rm(root, { recursive: true, force: true }); });

test('imports verified Skill bundle and distributes exact version once', async () => {
  const run = path.join(root, 'run');
  const source = path.join(run, 'source.md');
  const body = path.join(run, 'toutiao.md');
  await writeFile(source, '# source\n', 'utf8');
  await writeFile(body, '# 平台专版\n正文', 'utf8');
  const bundlePath = path.join(run, 'mediahub-bundle.json');
  await writeFile(bundlePath, JSON.stringify({
    schemaVersion: 1,
    bundleId: 'bundle-one',
    contentType: 'article',
    title: '平台专版',
    runDirectory: run,
    source: { path: source, sha256: sha(await readFile(source)) },
    platformVersions: { toutiao: { title: '平台专版', bodyFile: body, bodyFormat: 'markdown', bodySha256: sha(await readFile(body)), verification: 'verified' } },
  }), 'utf8');

  const imported = importBundle(bundlePath);
  assert.equal(imported.created, true);
  assert.equal(importBundle(bundlePath).created, false);
  const created = createDistribution({ contentId: imported.content.id, platformIds: ['toutiao'] });
  assert.equal(created.ok, true);
  await waitFor(() => !['queued', 'running'].includes(created.task.status));
  assert.equal(created.task.status, 'success', JSON.stringify(created.task.targets.map(t => ({status:t.status,message:t.message,logs:t.logs}))));
  assert.equal(created.task.targets[0].externalId, 'draft-toutiao');
  assert.match(created.task.targets[0].evidence.resultFile, /publish-result\.json$/);

  const duplicate = createDistribution({ contentId: imported.content.id, platformIds: ['toutiao'] });
  assert.equal(duplicate.task.targets[0].status, 'skipped_duplicate');
  await waitFor(() => duplicate.task.status === 'skipped');
});

test('strict adapter routing and recovery never retransmit uncertain work', () => {
  const unsupported = getAdapter(getPlatform('xiaohongshu'), 'article', 'save_draft');
  assert.equal(unsupported, require('../server/adapters/unsupported'));
  const task = {
    id: store.nextId(), operation: 'save_draft', status: 'running', createdAt: store.now(),
    contentSnapshot: { type: 'article', title: 'x' },
    targets: [{ id: store.nextId(), platformId: 'toutiao', accountId: 'missing', accountName: '默认账号', status: 'running', logs: [] }],
  };
  store.db.tasks.push(task);
  engine.recover();
  assert.equal(task.status, 'uncertain');
  assert.equal(task.targets[0].status, 'uncertain');
  assert.match(task.targets[0].message, /不能自动重传/);
});

test('stdout parser ignores prose and returns final JSON object', () => {
  assert.deepEqual(lastJsonObject('notice {bad}\n{"ok":true,"nested":{"x":1}}\n'), { ok: true, nested: { x: 1 } });
});
