/**
 * 不启动浏览器的工具契约测试：注册面、URL 准入、无会话拒绝、pause 语义。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';

const TOOLS = ['browser_act', 'browser_evidence', 'browser_observe', 'browser_open', 'browser_read', 'browser_session'];

test('apply 注册六个浏览器工具', async () => {
  const h = await createHarness();
  try {
    assert.deepEqual([...h.tools.keys()].sort(), TOOLS);
  } finally {
    h.cleanup();
  }
});

test('browser_open 只接受绝对 http(s) URL', async () => {
  const h = await createHarness();
  try {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'example.com', '/relative']) {
      const result = await h.call('browser_open', { url });
      assert.equal(result.ok, false, `${url} should be refused`);
      assert.equal(result.code, 'invalid_url', `${url} should be invalid_url`);
      assert.equal(typeof result.guidance, 'string');
    }
  } finally {
    h.cleanup();
  }
});

test('策略文件里的 blockedDomains / allowedDomains 生效', async () => {
  const h = await createHarness({ policy: { blockedDomains: ['^example\\.com$'] } });
  try {
    const blocked = await h.call('browser_open', { url: 'https://example.com/' });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'domain_blocked');

    const h2 = await createHarness({ policy: { allowedDomains: ['^docs\\.example\\.com$'] } });
    try {
      const notListed = await h2.call('browser_open', { url: 'https://other.example.org/' });
      assert.equal(notListed.ok, false);
      assert.equal(notListed.code, 'domain_blocked');
    } finally {
      h2.cleanup();
    }
  } finally {
    h.cleanup();
  }
});

test('没有会话时所有浏览器工具都拒绝而不是猜测', async () => {
  const h = await createHarness();
  try {
    const noSession = { ...h.exec, agent: {} };
    const call = (name, args) => h.tools.get(name).execute(args, noSession);

    const open = await call('browser_open', { url: 'https://example.com/' });
    assert.equal(open.code, 'no_session');

    for (const [name, args] of [
      ['browser_observe', {}],
      ['browser_act', { action: 'click', ref: 'r1' }],
      ['browser_read', { query: 'hello' }],
      ['browser_evidence', { kind: 'screenshot' }],
    ]) {
      const result = await call(name, args);
      assert.equal(result.ok, false, `${name} should refuse`);
      assert.equal(result.code, 'no_session', `${name} should be no_session`);
    }
  } finally {
    h.cleanup();
  }
});

test('browser_session 校验 action，pause 会阻断后续工具', async () => {
  const h = await createHarness();
  try {
    const invalid = await h.call('browser_session', { action: 'resume' });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, 'invalid_args');

    const paused = await h.call('browser_session', { action: 'pause' });
    assert.equal(paused.ok, true);
    assert.equal(paused.paused, true);

    const blocked = await h.call('browser_open', { url: 'https://example.com/' });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'paused');

    const read = await h.call('browser_read', { query: 'x' });
    assert.equal(read.code, 'paused');

    // 模型无法自行恢复：没有 resume action
    const resume = await h.call('browser_session', { action: 'resume' });
    assert.equal(resume.code, 'invalid_args');

    // 用户恢复 = 删除 pause 记录（真实 UI 走 /api/browser-use/capability）
    const { unlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    unlinkSync(join(h.dshHome, 'browser-use', 'pause.json'));

    const afterResume = await h.call('browser_open', { url: 'javascript:alert(1)' });
    assert.equal(afterResume.code, 'invalid_url', '恢复后应回到正常校验而不是 paused');
  } finally {
    h.cleanup();
  }
});

test('browser_open 在实例上限/浏览器缺失时给出可操作拒绝码', async () => {
  const h = await createHarness();
  try {
    // 指向不存在的浏览器：必须返回 browser_launch_failed 而不是抛异常
    const previous = process.env.DSH_BROWSER_PATH;
    process.env.DSH_BROWSER_PATH = '/nonexistent/definitely-not-chrome';
    try {
      const result = await h.call('browser_open', { url: 'https://example.com/' });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'browser_launch_failed');
      assert.match(String(result.guidance), /DSH_BROWSER_PATH/);
    } finally {
      if (previous === undefined) delete process.env.DSH_BROWSER_PATH;
      else process.env.DSH_BROWSER_PATH = previous;
    }
  } finally {
    h.cleanup();
  }
});
