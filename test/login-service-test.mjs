import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const service = require('../server/loginService');

test('真实登录能力按平台路由，不把未接入平台伪装成成功', () => {
  const douyin = service.capabilityForPlatform({ id: 'douyin' });
  assert.equal(douyin.provider, 'social-auto-upload');
  assert.equal(douyin.canCheck, true);
  assert.equal(douyin.canLogin, true);

  const zhihu = service.capabilityForPlatform({ id: 'zhihu' });
  assert.equal(zhihu.provider, 'browser-extension');
  assert.equal(zhihu.canCheck, false);
  assert.match(zhihu.instructions, /Wechatsync/);

  const instagram = service.capabilityForPlatform({ id: 'instagram' });
  assert.equal(instagram.provider, 'unsupported');
  assert.equal(instagram.canLogin, false);
});

test('本地登录身份拒绝路径与控制字符', () => {
  assert.equal(service.sanitizeRuntimeAccount('default'), 'default');
  assert.equal(service.sanitizeRuntimeAccount('主号'), '主号');
  assert.throws(() => service.sanitizeRuntimeAccount('../escape'), /路径符号/);
  assert.throws(() => service.sanitizeRuntimeAccount('bad\\name'), /路径符号/);
});

test('登录命令使用参数数组并映射视频号与头条账号', () => {
  const tencent = service._testing.commandFor({ id: '1', runtimeAccount: 'default' }, { id: 'shipinhao' }, 'check');
  assert.deepEqual(tencent.args.slice(1), ['tencent', 'check', '--account', 'default']);

  const toutiao = service._testing.commandFor({ id: '2', runtimeAccount: 'default' }, { id: 'toutiao' }, 'check');
  assert.deepEqual(toutiao.args.slice(-3), ['auth', 'check', '--headless']);
  assert.equal(toutiao.args.includes('--account'), true);
});
