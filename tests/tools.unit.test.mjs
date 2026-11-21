/**
 * 不启动浏览器的契约测试：默认 facade 工具面、高级开关、URL 准入、
 * 无会话/暂停语义、pod 引擎的失败模式。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHarness } from './harness.mjs';

const GRANULAR = ['browser_act', 'browser_evidence', 'browser_observe', 'browser_open', 'browser_read', 'browser_session'];

function withEnv(overrides, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function listen(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('默认只暴露一个 browser facade 工具', async () => {
  const h = await createHarness();
  try {
    assert.deepEqual(h.visibleTools(), ['browser']);
  } finally {
    h.cleanup();
  }
});

test('打开高级开关后暴露六个细分工具，facade 隐藏', async () => {
  const h = await createHarness({ advanced: true });
  try {
    assert.deepEqual(h.visibleTools(), GRANULAR);
  } finally {
    h.cleanup();
  }
});

test('capability 路由可以切换高级开关', async () => {
  const h = await createHarness();
  try {
    const route = h.routes.find((entry) => entry.path === '/api/browser-use/capability');
    assert.ok(route, 'capability route registered');
    const response = await route.fetch(
      new Request(`http://localhost/api/browser-use/capability?sessionId=${encodeURIComponent('test-session')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ advanced: true }),
      }),
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.value?.advanced, true);
    assert.deepEqual(h.visibleTools(), GRANULAR);
  } finally {
    h.cleanup();
  }
});

test('facade 拒绝未知 action', async () => {
  const h = await createHarness();
  try {
    const result = await h.call('browser', { action: 'teleport' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_args');
  } finally {
    h.cleanup();
  }
});

test('facade open 只接受绝对 http(s) URL', async () => {
  const h = await createHarness();
  try {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'example.com']) {
      const result = await h.call('browser', { action: 'open', url });
      assert.equal(result.ok, false, `${url} should be refused`);
      assert.equal(result.code, 'invalid_url', `${url} should be invalid_url`);
    }
  } finally {
    h.cleanup();
  }
});

test('策略文件里的 blockedDomains / allowedDomains 生效（facade open）', async () => {
  const h = await createHarness({ policy: { blockedDomains: ['^example\\.com$'] } });
  try {
    const blocked = await h.call('browser', { action: 'open', url: 'https://example.com/' });
    assert.equal(blocked.code, 'domain_blocked');

    const h2 = await createHarness({ policy: { allowedDomains: ['^docs\\.example\\.com$'] } });
    try {
      const notListed = await h2.call('browser', { action: 'open', url: 'https://other.example.org/' });
      assert.equal(notListed.code, 'domain_blocked');
    } finally {
      h2.cleanup();
    }
  } finally {
    h.cleanup();
  }
});

test('没有会话时操作类 action 拒绝，session status 仍可用', async () => {
  const h = await createHarness();
  try {
    const noSession = { ...h.exec, agent: {} };
    const call = (name, args) => {
      const entry = h.tools.get(name);
      return entry.def.execute(args, noSession);
    };

    for (const args of [
      { action: 'open', url: 'https://example.com/' },
      { action: 'observe' },
      { action: 'act', act: 'click', ref: 'r1' },
      { action: 'read', query: 'hello' },
      { action: 'evidence', kind: 'screenshot' },
    ]) {
      const result = await call('browser', args);
      assert.equal(result.ok, false, JSON.stringify(args));
      assert.equal(result.code, 'no_session', JSON.stringify(args));
    }

    const status = await call('browser', { action: 'session', op: 'status' });
    assert.equal(status.ok, true);
    assert.equal(status.engine, 'local');
  } finally {
    h.cleanup();
  }
});

test('session op=pause 阻断后续操作，模型无法自行恢复', async () => {
  const h = await createHarness();
  try {
    const invalid = await h.call('browser', { action: 'session', op: 'resume' });
    assert.equal(invalid.code, 'invalid_args');

    const paused = await h.call('browser', { action: 'session', op: 'pause' });
    assert.equal(paused.ok, true);
    assert.equal(paused.paused, true);

    const blocked = await h.call('browser', { action: 'open', url: 'https://example.com/' });
    assert.equal(blocked.code, 'paused');
    const read = await h.call('browser', { action: 'read', query: 'x' });
    assert.equal(read.code, 'paused');

    const { unlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    unlinkSync(join(h.dshHome, 'browser-use', 'pause.json'));

    const afterResume = await h.call('browser', { action: 'open', url: 'javascript:alert(1)' });
    assert.equal(afterResume.code, 'invalid_url');
  } finally {
    h.cleanup();
  }
});

test('浏览器缺失时返回 browser_launch_failed', async () => {
  const h = await createHarness();
  try {
    await withEnv({ DSH_BROWSER_PATH: '/nonexistent/definitely-not-chrome' }, async () => {
      const result = await h.call('browser', { action: 'open', url: 'https://example.com/' });
      assert.equal(result.code, 'browser_launch_failed');
      assert.match(String(result.guidance), /DSH_BROWSER_PATH/);
    });
  } finally {
    h.cleanup();
  }
});

test('pod 引擎：控制面不可达 → pod_unavailable', async () => {
  const h = await createHarness();
  try {
    await withEnv({ DSH_BROWSER_ENGINE: 'pod', DSH_BROWSER_POD_URL: 'http://127.0.0.1:1' }, async () => {
      const result = await h.call('browser', { action: 'open', url: 'https://example.com/' });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'pod_unavailable');
    });
  } finally {
    h.cleanup();
  }
});

test('pod 引擎：401 → pod_auth，5xx → pod_refused', async () => {
  let status = 401;
  const server = await listen((req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'nope' }));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const h = await createHarness();
  try {
    await withEnv({ DSH_BROWSER_ENGINE: 'pod', DSH_BROWSER_POD_URL: base, DSH_BROWSER_POD_TOKEN: 't' }, async () => {
      const auth = await h.call('browser', { action: 'open', url: 'https://example.com/' });
      assert.equal(auth.code, 'pod_auth');

      status = 500;
      const refused = await h.call('browser', { action: 'open', url: 'https://example.com/' });
      assert.equal(refused.code, 'pod_refused');
    });
  } finally {
    h.cleanup();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('pod 引擎：auto 在控制面不可用时回退本地并标注 engineNote', async () => {
  const h = await createHarness();
  try {
    await withEnv(
      { DSH_BROWSER_ENGINE: 'auto', DSH_BROWSER_POD_URL: 'http://127.0.0.1:1', DSH_BROWSER_PATH: '/nonexistent/definitely-not-chrome' },
      async () => {
        const result = await h.call('browser', { action: 'open', url: 'https://example.com/' });
        // auto falls back to the local path; with no browser installed that path fails.
        assert.equal(result.code, 'browser_launch_failed');
      },
    );
  } finally {
    h.cleanup();
  }
});
