/**
 * 真实 Chromium 集成测试：用假 Cordis 上下文挂载插件，走完
 * open → observe → act → read → evidence → session → close 全链路。
 *
 * 需要：
 *   - Playwright 的 Chromium（devDependency）：npx playwright install chromium
 *   - Linux 上需要 X display（CI 用 xvfb-run；本地无 DISPLAY 会 skip）
 *
 * 运行：npm run test:integration（或 xvfb-run -a node --test tests/browser.integration.test.mjs）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
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

const browserPath = (() => {
  try {
    return process.env.DSH_BROWSER_PATH || process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
  } catch {
    return null;
  }
})();

const hasDisplay = process.platform !== 'linux' || Boolean(process.env.DISPLAY);

test(
  'open → observe → act → read → evidence → session → close',
  async (t) => {
    if (!hasDisplay) return t.skip('no DISPLAY; run under xvfb-run');
    // 延迟解析 playwright，缺依赖时整个测试 skip 而不是 crash
    let chromium;
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      return t.skip('playwright is not installed (npm install)');
    }
    const executable = browserPath || chromium.executablePath();
    if (!executable || !existsSync(executable)) {
      return t.skip('no Chromium executable; run npx playwright install chromium');
    }
    process.env.DSH_BROWSER_PATH = executable;
    if (!process.env.DSH_HOME || !process.env.DSH_HOME.includes('dsh-browser-use-test-')) {
      process.env.DSH_HOME = process.env.DSH_HOME || '/tmp';
    }

    const server = await startServer();
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const h = await createHarness();

    try {
      // 1. open
      const opened = await h.call('browser_open', { url: `${base}/` });
      assert.equal(opened.ok, true, JSON.stringify(opened));
      assert.equal(opened.title, 'Harness Home');
      assert.match(opened.url, /\/$/);

      // 2. observe：拿到编号 ref
      const observed = await h.call('browser_observe', { mode: 'controls' });
      assert.equal(observed.ok, true);
      assert.ok(observed.controls.length > 0);
      assert.equal(observed.total > 0, true);
      assert.match(observed.rendered, /^\s*\[/m);
      const linkRef = controlRef(observed, (c) => String(c.name).includes('Go to page two'));

      // 3. act：点击链接，结果带 diff，页面跳转
      const clicked = await h.call('browser_act', { action: 'click', ref: linkRef, intent: 'open page two' });
      assert.equal(clicked.ok, true, JSON.stringify(clicked));
      assert.equal(clicked.action, 'click');

      const observed2 = await h.call('browser_observe', { mode: 'controls' });
      assert.match(observed2.url, /\/page2$/);
      assert.equal(observed2.title, 'Page Two');

      // 4. read：查询式读取，不 dump DOM
      const read = await h.call('browser_read', { query: 'needle' });
      assert.equal(read.ok, true);
      assert.ok(read.chars > 0);
      assert.match(read.rendered, /needle/i);

      // 5. evidence：截图落盘
      const shot = await h.call('browser_evidence', { kind: 'screenshot' });
      assert.equal(shot.ok, true);
      assert.ok(existsSync(shot.path), `screenshot missing: ${shot.path}`);
      assert.ok(shot.width > 0 && shot.height > 0);

      // 6. 密码框拒绝输入
      const pwObserved = await h.call('browser_observe', { mode: 'controls' });
      const pwRef = controlRef(pwObserved, (c) => c.type === 'password' || /password/i.test(String(c.name)));
      const typedPw = await h.call('browser_act', { action: 'type', ref: pwRef, text: 'hunter2' });
      assert.equal(typedPw.ok, false);
      assert.equal(typedPw.code, 'password_target');

      // 7. 高风险动作：approval seam 被调用并放行（harness 默认 allowed-once）
      const deleteObserved = await h.call('browser_observe', { mode: 'controls' });
      const deleteRef = controlRef(deleteObserved, (c) => /delete account/i.test(String(c.name)));
      const deleted = await h.call('browser_act', {
        action: 'click',
        ref: deleteRef,
        intent: 'delete the account',
        confirm_risk: true,
      });
      assert.equal(deleted.ok, true, JSON.stringify(deleted));

      // 8. session：tabs 与 pause 语义
      const tabs = await h.call('browser_session', { action: 'tabs' });
      assert.equal(tabs.ok, true);
      assert.ok(tabs.tabs.length >= 1);

      const paused = await h.call('browser_session', { action: 'pause' });
      assert.equal(paused.paused, true);
      const pausedObserve = await h.call('browser_observe', {});
      assert.equal(pausedObserve.code, 'paused');

      // 用户恢复（等价于 UI 删除 pause 记录）
      const { unlinkSync } = await import('node:fs');
      unlinkSync(join(h.dshHome, 'browser-use', 'pause.json'));

      const closed = await h.call('browser_session', { action: 'close' });
      assert.equal(closed.ok, true, JSON.stringify(closed));
    } finally {
      h.cleanup();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
