/**
 * 配置单元测试：环境变量 → config 快照。
 *
 * 这些测试不启动浏览器，只验证「env 在模块加载时被正确解析」。
 * 证书行为见 cert-ignore.test.mjs。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const podsModule = path.join(here, '..', 'src', 'pods.mjs');

function childConfig(env) {
  const script = `import(${JSON.stringify(podsModule)}).then((m) => console.log(JSON.stringify(m.config)))`;
  const out = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim());
}

test('IGNORE_CERT_ERRORS 默认关闭', () => {
  const config = childConfig({ IGNORE_CERT_ERRORS: '' });
  assert.equal(config.ignoreCertErrors, false);
});

test('IGNORE_CERT_ERRORS=1 打开证书忽略', () => {
  const config = childConfig({ IGNORE_CERT_ERRORS: '1' });
  assert.equal(config.ignoreCertErrors, true);
});

test('PODS_MAX / POD_IDLE_TTL_MIN 解析为数字', () => {
  const config = childConfig({ PODS_MAX: '3', POD_IDLE_TTL_MIN: '7' });
  assert.equal(config.maxPods, 3);
  assert.equal(config.idleTtlMs, 7 * 60_000);
});
