/**
 * 控制面鉴权测试：设置 MCP_TOKEN 后，/mcp 与 /api 必须带 Bearer；/healthz 保持公开。
 *
 * 直接 spawn 一个 server.mjs 子进程（换端口、换 DATA_DIR），不启动浏览器。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = 'test-token-123';
const PORT = 8899;

async function waitHealth(deadlineMs = 15_000) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('server did not become healthy');
}

test('MCP_TOKEN 保护 /mcp 与 /api，/healthz 保持公开', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'browser-pods-auth-'));
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      LISTEN_HOST: '127.0.0.1',
      LISTEN_PORT: String(PORT),
      MCP_TOKEN: TOKEN,
      VNC_ENABLED: '0',
      PODS_MAX: '1',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(() => {
    child.kill('SIGTERM');
    rmSync(dataDir, { recursive: true, force: true });
  });

  try {
    await waitHealth();
  } catch (error) {
    child.kill('SIGKILL');
    throw new Error(`${error.message}\n${stderr}`);
  }

  const health = await fetch(`http://127.0.0.1:${PORT}/healthz`);
  assert.equal(health.status, 200);

  const mcpNoAuth = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(mcpNoAuth.status, 401);

  const apiNoAuth = await fetch(`http://127.0.0.1:${PORT}/api/config`);
  assert.equal(apiNoAuth.status, 401);

  const mcpWithAuth = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(mcpWithAuth.status, 200);
  const payload = await mcpWithAuth.json();
  assert.ok(Array.isArray(payload.result?.tools));
});
