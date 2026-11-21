/**
 * TLS 证书行为集成测试（会真的起 Xvfb + Chromium）。
 *
 * 覆盖：
 *  1. 默认（ignoreCertErrors=false）：访问自签 HTTPS 站点必须失败，且错误里带证书字样；
 *  2. 显式开启（ignoreCertErrors=true）：同一站点访问成功；
 *  3. describePod / browser_list 里能看到 ignore_cert_errors 状态。
 *
 * 依赖：Xvfb、Playwright Chromium。CI 由 workflow 安装；本地跑不动时可在
 *   docker compose 构建的镜像里执行（见 DEVELOPMENT 文档）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-pods-cert-'));
const keyPath = path.join(here, 'fixtures', 'self-signed-key.pem');
const certPath = path.join(here, 'fixtures', 'self-signed-cert.pem');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('默认校验证书，显式 ignore 后才放行', async () => {
  const httpsServer = https.createServer(
    { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>cert test</title><h1>cert-ok</h1>');
    },
  );
  const port = await listen(httpsServer);

  // config 在模块加载时读取 env，所以必须在 import 之前设置
  Object.assign(process.env, {
    DATA_DIR: path.join(tmp, 'data'),
    PODS_MAX: '2',
    VNC_ENABLED: '0',
    RECORD_VIDEO: '0',
    RECORD_TRACE: '0',
    DISPLAY_BASE: '93',
    VNC_PORT_BASE: '5893',
    VIEW_PORT_BASE: '6093',
    CDP_PORT_BASE: '9343',
    IGNORE_CERT_ERRORS: '0',
  });

  const P = await import('../src/pods.mjs');
  const target = `https://127.0.0.1:${port}/`;
  const pods = [];

  try {
    const strictPod = await P.createPod({ label: 'cert-strict' });
    pods.push(strictPod);
    const strictPage = P.activePage(strictPod);
    assert.ok(strictPage, '严格模式会话应有可用页面');
    assert.equal((await P.describePod(strictPod)).ignore_cert_errors, false);
    await assert.rejects(
      () => strictPage.goto(target, { waitUntil: 'domcontentloaded', timeout: 15_000 }),
      (err) => /ERR_CERT|certificate|CERT_/i.test(String(err?.message || err)),
      '默认应因证书校验失败',
    );

    const loosePod = await P.createPod({ label: 'cert-loose', ignoreCertErrors: true });
    pods.push(loosePod);
    const loosePage = P.activePage(loosePod);
    assert.ok(loosePage, '忽略证书的会话应有可用页面');
    assert.equal((await P.describePod(loosePod)).ignore_cert_errors, true);
    const res = await loosePage.goto(target, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    assert.equal(res?.status() ?? 0, 200);
    assert.equal(await loosePage.title(), 'cert test');
    assert.match(await loosePage.textContent('h1'), /cert-ok/);
  } finally {
    for (const pod of pods) await P.destroyPod(pod, 'cert test').catch(() => {});
    await new Promise((resolve) => httpsServer.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
