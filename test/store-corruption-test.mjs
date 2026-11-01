import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve('.tmp-tests-store-corruption');

test('corrupt database is preserved and startup fails closed', async () => {
  const dataDir = path.join(root, 'data');
  await rm(root, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, 'db.json'), '{broken-json', 'utf8');
  const result = spawnSync(process.execPath, ['-e', "require('./server/store')"], {
    cwd: path.resolve('.'),
    env: { ...process.env, DATA_DIR: dataDir, UPLOAD_DIR: path.join(root, 'uploads') },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /数据库无法读取/);
  const backups = await readdir(path.join(dataDir, 'backups'));
  assert.equal(backups.some((name) => name.startsWith('db-corrupt-')), true);
  await rm(root, { recursive: true, force: true });
});
