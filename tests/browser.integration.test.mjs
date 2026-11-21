/**
 * 真实 Chromium 集成测试：
 *  1. facade 全链路 open → observe → act → read → evidence → session → close；
 *  2. attach 模式：接一个外部启动的 headless Chromium（模拟 pod 的 cdp_url），
 *     detach 后对方进程仍然存活。
 *
 * 需要：
 *   - Playwright 的 Chromium（测试专用：npm install --no-save playwright@1.62.1）
 *   - Linux 上需要 X display（仅第 1 个测试；CI 用 xvfb-run；本地无 DISPLAY 会 skip）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness } from './harness.mjs';

const HOME_PAGE = `<!doctype html><html><head><title>Harness Home</title></head><body>
  <h1>Home</h1>
  <a id="next" href="/page2">Go to page two</a>
  <p>The needle paragraph says hello from the browser harness.</p>
</body></html>`;

const PAGE_TWO = `<!doctype html><html><head><title>Page Two</title></head><body>
  <h1>Second page</h1>
  <p>Another needle lives here.</p>
  <label>Name <input id="name" type="text"></label>
  <label>Password <input id="pw" type="password"></label>
  <button id="delete" type="button">Delete account</button>
  <button id="refresh" type="button">Refresh</button>
</body></html>`;

function startServer() {
  const server = createServer((req, res) => {
    const body = req.url === '/page2' ? PAGE_TWO : HOME_PAGE;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function controlRef(observation, predicate) {
  const controls = Array.isArray(observation.controls) ? observation.controls : [];
  const hit = controls.find(predicate);
  assert.ok(hit, `control not found; rendered was:\n${observation.rendered}`);
  return hit.ref;
}

function chromiumExecutable(chromium) {
  try {
    return process.env.DSH_BROWSER_PATH || chromium.executablePath();
  } catch {
    return process.env.DSH_BROWSER_PATH || '';
  }
}

/** 启动一个带 CDP 端口的 headless Chromium，返回端口与清理函数。 */
async function startExternalChromium(executable) {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-ext-chrome-'));
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const portFile = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const text = readFileSync(portFile, 'utf8').trim();
      const port = Number(text.split(/\r?\n/)[0]);
      if (Number.isFinite(port) && port > 0) {
        return {
          port,
          child,
          cleanup: () => {
            try {
              child.kill('SIGKILL');
            } catch {
              /* ignore */
            }
            rmSync(profile, { recursive: true, force: true });
          },
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  child.kill('SIGKILL');
  rmSync(profile, { recursive: true, force: true });
  throw new Error('external Chromium did not report a DevTools port');
}

/**
 * Resolve the browser executable: DSH_BROWSER_PATH wins, then Playwright's
 * bundled Chromium. Skips (instead of failing) when neither is available.
 */
async function resolveExecutable(t) {
  let chromium = null;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    chromium = null;
  }
  const candidate = process.env.DSH_BROWSER_PATH || (chromium ? chromium.executablePath() : '');
  if (!candidate || !existsSync(candidate)) {
    return t.skip('no browser executable; set DSH_BROWSER_PATH or run npx playwright install chromium');
  }
  return candidate;
}

test('facade：open → observe → act → read → evidence → session → close', async (t) => {
  if (process.platform === 'linux' && !process.env.DISPLAY) return t.skip('no DISPLAY; run under xvfb-run');
  const executable = await resolveExecutable(t);
  if (!executable) return;
  process.env.DSH_BROWSER_PATH = executable;
  delete process.env.DSH_BROWSER_ENGINE;
  delete process.env.DSH_BROWSER_POD_URL;

  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const h = await createHarness();
  try {
    const opened = await h.call('browser', { action: 'open', url: `${base}/` });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    assert.equal(opened.title, 'Harness Home');

    const observed = await h.call('browser', { action: 'observe' });
    assert.equal(observed.ok, true);
    assert.match(observed.rendered, /^\s*\[/m);
    const linkRef = controlRef(observed, (c) => String(c.name).includes('Go to page two'));

    const clicked = await h.call('browser', { action: 'act', act: 'click', ref: linkRef, intent: 'open page two' });
    assert.equal(clicked.ok, true, JSON.stringify(clicked));

    const observed2 = await h.call('browser', { action: 'observe' });
    assert.match(observed2.url, /\/page2$/);

    const read = await h.call('browser', { action: 'read', query: 'needle' });
    assert.equal(read.ok, true);
    assert.match(read.rendered, /needle/i);

    const shot = await h.call('browser', { action: 'evidence', kind: 'screenshot' });
    assert.equal(shot.ok, true);
    assert.ok(existsSync(shot.path));

    const pwObserved = await h.call('browser', { action: 'observe' });
    const pwRef = controlRef(pwObserved, (c) => c.type === 'password' || /password/i.test(String(c.name)));
    const typedPw = await h.call('browser', { action: 'act', act: 'type', ref: pwRef, text: 'hunter2' });
    assert.equal(typedPw.ok, false);
    assert.equal(typedPw.code, 'password_target');

    const deleteObserved = await h.call('browser', { action: 'observe' });
    const deleteRef = controlRef(deleteObserved, (c) => /delete account/i.test(String(c.name)));
    const deleted = await h.call('browser', {
      action: 'act',
      act: 'click',
      ref: deleteRef,
      intent: 'delete the account',
      confirm_risk: true,
    });
    assert.equal(deleted.ok, true, JSON.stringify(deleted));

    const status = await h.call('browser', { action: 'session', op: 'status' });
    assert.equal(status.ok, true);
    assert.equal(status.mode, 'local');

    const tabs = await h.call('browser', { action: 'session', op: 'tabs' });
    assert.equal(tabs.ok, true);
    assert.ok(tabs.tabs.length >= 1);

    const paused = await h.call('browser', { action: 'session', op: 'pause' });
    assert.equal(paused.paused, true);
    const pausedObserve = await h.call('browser', { action: 'observe' });
    assert.equal(pausedObserve.code, 'paused');

    const { unlinkSync } = await import('node:fs');
    unlinkSync(join(h.dshHome, 'browser-use', 'pause.json'));

    const closed = await h.call('browser', { action: 'session', op: 'close' });
    assert.equal(closed.ok, true, JSON.stringify(closed));
  } finally {
    h.cleanup();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('attach：browser_open({cdp_url}) 接管外部 Chromium，关闭只 detach', async (t) => {
  const executable = await resolveExecutable(t);
  if (!executable) return;
  delete process.env.DSH_BROWSER_ENGINE;
  delete process.env.DSH_BROWSER_POD_URL;

  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const external = await startExternalChromium(executable);
  const h = await createHarness();
  try {
    const opened = await h.call('browser', { action: 'open', url: `${base}/`, cdp_url: `http://127.0.0.1:${external.port}` });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    assert.equal(opened.mode, 'attached');
    assert.equal(opened.title, 'Harness Home');

    const status = await h.call('browser', { action: 'session', op: 'status' });
    assert.equal(status.mode, 'attached');
    assert.equal(status.attached, true);
    assert.equal(status.engine, 'local');

    const observed = await h.call('browser', { action: 'observe' });
    assert.equal(observed.ok, true);
    assert.ok(observed.controls.length > 0);

    const closed = await h.call('browser', { action: 'session', op: 'close' });
    assert.equal(closed.ok, true);
    assert.equal(closed.mode, 'attached');
    assert.equal(external.child.exitCode, null, 'detach must not kill the external browser');
  } finally {
    h.cleanup();
    external.cleanup();
    await new Promise((resolve) => server.close(resolve));
  }
});


/** 假 browser-pods 控制面：POST /api/pods 返回给定 cdp_url，DELETE 记录调用。 */
function startFakePodControl({ cdpUrl }) {
  const calls = { created: 0, deleted: 0, lastDeleteReason: '' };
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/pods') {
      calls.created += 1;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'pod-test-1', cdp_url: cdpUrl, live_view_url: '', mode: 'managed' }));
      return;
    }
    if (req.method === 'DELETE' && req.url.startsWith('/api/pods/')) {
      calls.deleted += 1;
      calls.lastDeleteReason = decodeURIComponent(new URL(req.url, 'http://x').searchParams.get('reason') || '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'pod-test-1', closed: true }));
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls })));
}

test('pod 引擎：复用已有实例（不重复建 pod），关闭时 DELETE 归档', async (t) => {
  const chromium = await (async () => {
    try {
      const mod = await import('playwright');
      return mod.chromium;
    } catch {
      return null;
    }
  })();
  const executable = process.env.DSH_BROWSER_PATH || (chromium ? chromium.executablePath() : '');
  if (!executable || !existsSync(executable)) return t.skip('no browser executable');
  delete process.env.DSH_BROWSER_ENGINE;
  delete process.env.DSH_BROWSER_POD_URL;
  delete process.env.DSH_BROWSER_POD_TOKEN;

  const pages = await startServer();
  const external = await startExternalChromium(executable);
  const fake = await startFakePodControl({ cdpUrl: `http://127.0.0.1:${external.port}` });
  const base = `http://127.0.0.1:${pages.address().port}`;
  const h = await createHarness();
  const saved = { ...process.env };
  try {
    process.env.DSH_BROWSER_ENGINE = 'pod';
    process.env.DSH_BROWSER_POD_URL = `http://127.0.0.1:${fake.server.address().port}`;
    process.env.DSH_BROWSER_PATH = executable;

    const first = await h.call('browser', { action: 'open', url: `${base}/` });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.mode, 'pod');
    assert.equal(first.pod?.id, 'pod-test-1');
    assert.equal(fake.calls.created, 1);

    const second = await h.call('browser', { action: 'open', url: `${base}/page2` });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(fake.calls.created, 1, 'repeated open must reuse the existing pod');

    const status = await h.call('browser', { action: 'session', op: 'status' });
    assert.equal(status.mode, 'attached');
    assert.equal(status.pod?.id, 'pod-test-1');

    const closed = await h.call('browser', { action: 'session', op: 'close' });
    assert.equal(closed.ok, true);
    assert.equal(fake.calls.deleted, 1, 'closing the session must DELETE the pod');
    assert.equal(external.child.exitCode, null, 'detach must not kill the pod browser');
  } finally {
    process.env = saved;
    h.cleanup();
    external.cleanup();
    await new Promise((resolve) => fake.server.close(resolve));
    await new Promise((resolve) => pages.close(resolve));
  }
});

test('pod 引擎：KEEP=1 时关闭只 detach，不删 pod', async (t) => {
  const chromium = await (async () => {
    try {
      const mod = await import('playwright');
      return mod.chromium;
    } catch {
      return null;
    }
  })();
  const executable = process.env.DSH_BROWSER_PATH || (chromium ? chromium.executablePath() : '');
  if (!executable || !existsSync(executable)) return t.skip('no browser executable');

  const pages = await startServer();
  const external = await startExternalChromium(executable);
  const fake = await startFakePodControl({ cdpUrl: `http://127.0.0.1:${external.port}` });
  const base = `http://127.0.0.1:${pages.address().port}`;
  const h = await createHarness();
  const saved = { ...process.env };
  try {
    process.env.DSH_BROWSER_ENGINE = 'pod';
    process.env.DSH_BROWSER_POD_URL = `http://127.0.0.1:${fake.server.address().port}`;
    process.env.DSH_BROWSER_POD_KEEP = '1';
    process.env.DSH_BROWSER_PATH = executable;

    const opened = await h.call('browser', { action: 'open', url: `${base}/` });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const closed = await h.call('browser', { action: 'session', op: 'close' });
    assert.equal(closed.ok, true);
    assert.match(String(closed.rendered), /kept running/);
    assert.equal(fake.calls.deleted, 0);
  } finally {
    process.env = saved;
    h.cleanup();
    external.cleanup();
    await new Promise((resolve) => fake.server.close(resolve));
    await new Promise((resolve) => pages.close(resolve));
  }
});

test('attach：非回环 CDP 默认拒绝', async () => {
  const h = await createHarness();
  const saved = { ...process.env };
  try {
    delete process.env.DSH_BROWSER_ALLOW_REMOTE_CDP;
    const result = await h.call('browser', { action: 'open', url: 'https://example.com/', cdp_url: 'http://10.255.255.1:9222' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'cdp_not_allowed');
  } finally {
    process.env = saved;
    h.cleanup();
  }
});

test('已有本地浏览器时 attach 另一个 CDP 会被拒绝而不是静默复用', async (t) => {
  const chromium = await (async () => {
    try {
      const mod = await import('playwright');
      return mod.chromium;
    } catch {
      return null;
    }
  })();
  const executable = process.env.DSH_BROWSER_PATH || (chromium ? chromium.executablePath() : '');
  if (!executable || !existsSync(executable)) return t.skip('no browser executable');
  if (process.platform === 'linux' && !process.env.DISPLAY) return t.skip('no DISPLAY');
  process.env.DSH_BROWSER_PATH = executable;
  const pages = await startServer();
  const base = `http://127.0.0.1:${pages.address().port}`;
  const h = await createHarness();
  const saved = { ...process.env };
  try {
    delete process.env.DSH_BROWSER_ENGINE;
    const opened = await h.call('browser', { action: 'open', url: `${base}/` });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const conflict = await h.call('browser', { action: 'open', url: `${base}/page2`, cdp_url: 'http://127.0.0.1:9222' });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'browser_already_open');
  } finally {
    process.env = saved;
    h.cleanup();
    await new Promise((resolve) => pages.close(resolve));
  }
});
