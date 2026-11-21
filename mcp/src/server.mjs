import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer } from './mcp.mjs';
import * as P from './pods.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.LISTEN_PORT || 8787);
const HOST = process.env.LISTEN_HOST || '127.0.0.1';
const TOKEN = process.env.MCP_TOKEN || '';
const DASHBOARD = path.join(__dirname, 'dashboard.html');

const log = (...a) => console.log(new Date().toISOString(), '[http]', ...a);

/** MCP 调用审计：谁连上来、调了什么（最近 100 条） */
const mcpAudit = [];
function audit(entry) {
  mcpAudit.push({ t: new Date().toISOString(), ...entry });
  if (mcpAudit.length > 100) mcpAudit.shift();
}

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, {
    'content-type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function json(res, status, obj) {
  send(res, status, JSON.stringify(obj, null, 2), { 'content-type': 'application/json; charset=utf-8' });
}

const MIME = {
  '.webm': 'video/webm',
  '.zip': 'application/zip',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

function serveFile(req, res, filePath, name) {
  const ext = path.extname(name).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return json(res, 404, { error: '文件不存在' });
  }
  const total = stat.size;
  const range = req.headers.range;
  if (range && /^bytes=/.test(range)) {
    const [startRaw, endRaw] = range.replace('bytes=', '').split('-');
    const start = startRaw ? Number(startRaw) : 0;
    const end = endRaw ? Math.min(Number(endRaw), total - 1) : total - 1;
    if (Number.isNaN(start) || start >= total) {
      res.writeHead(416, { 'content-range': `bytes */${total}` });
      return res.end();
    }
    res.writeHead(206, {
      'content-type': type,
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${total}`,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    });
    return fs.createReadStream(filePath, { start, end }).pipe(res);
  }
  res.writeHead(200, {
    'content-type': type,
    'content-length': total,
    'accept-ranges': 'bytes',
    'content-disposition': ext === '.zip' ? `attachment; filename="${name}"` : 'inline',
    'cache-control': 'no-store',
  });
  return fs.createReadStream(filePath).pipe(res);
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authorized(req) {
  if (!TOKEN) return true;
  const h = req.headers.authorization || '';
  return h === `Bearer ${TOKEN}`;
}

async function handleMcp(req, res) {
  if (req.method !== 'POST') {
    // 无状态模式下不提供 SSE 长连接
    return json(res, 405, { error: 'method_not_allowed', hint: '该 MCP 端点是无状态模式，只接受 POST' });
  }
  // 部分客户端不带 Accept，放宽一下
  if (!req.headers.accept || !req.headers.accept.includes('application/json')) {
    req.headers.accept = 'application/json, text/event-stream';
  }
  let parsed;
  try {
    const raw = await readBody(req);
    parsed = raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
  } catch (e) {
    return json(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: `解析失败: ${e.message}` }, id: null });
  }

  try {
    const msg = parsed;
    if (msg?.method === 'initialize') {
      audit({ method: 'initialize', client: msg.params?.clientInfo?.name, version: msg.params?.clientInfo?.version });
    } else if (msg?.method === 'tools/call') {
      audit({ method: 'tools/call', tool: msg.params?.name });
    } else if (msg?.method) {
      audit({ method: msg.method });
    }
  } catch {
    /* ignore */
  }

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const mcp = buildMcpServer();
  res.on('close', () => {
    transport.close().catch(() => {});
    mcp.close().catch(() => {});
  });
  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res, parsed);
  } catch (e) {
    log('MCP 处理失败', e?.message);
    if (!res.headersSent) json(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: String(e?.message || e) }, id: null });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    if (p === '/healthz') return json(res, 200, { ok: true, ...P.counts(), uptime_s: Math.round(process.uptime()) });

    // 鉴权放在所有业务路由之前：MCP_TOKEN 设置后 /mcp 与 /api 都必须带 Bearer。
    // /healthz 保持公开，供容器探活使用。
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });

    if (p === '/mcp') return await handleMcp(req, res);

    if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(DASHBOARD, 'utf8');
      return send(res, 200, html, { 'content-type': 'text/html; charset=utf-8' });
    }

    // 给演示 / 冒烟测试用的本地页面，方便验证点击、输入、提交
    if (p === '/demo') {
      return send(res, 200, `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>订单查询 · 演示页</title>
<style>body{font:15px/1.6 -apple-system,"PingFang SC",sans-serif;margin:40px;color:#222}
h2{margin:0 0 16px}input{padding:8px 10px;font-size:14px;width:220px;border:1px solid #bbb;border-radius:6px}
button{padding:8px 16px;font-size:14px;margin-left:8px;border:0;border-radius:6px;background:#2f6fed;color:#fff;cursor:pointer}
#result{margin-top:18px;padding:12px 14px;background:#f4f6fa;border-radius:8px;min-height:20px}
table{margin-top:18px;border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px 12px;font-size:13px}</style>
<h2>订单查询</h2>
<input id="orderNo" placeholder="订单号，例如 A1001">
<button id="btn" onclick="const v=document.getElementById('orderNo').value.trim();
 document.getElementById('result').textContent = v ? '查询中… ' + v : '请输入订单号';">
查询</button>
<div id="result">等待输入</div>
<table><tr><th>订单号</th><th>状态</th></tr>
<tr><td>A1001</td><td>已发货</td></tr><tr><td>A1002</td><td>待付款</td></tr></table>
</html>`, { 'content-type': 'text/html; charset=utf-8' });
    }

    if (p === '/api/mcp-audit') {
      return json(res, 200, { count: mcpAudit.length, entries: mcpAudit.slice(-100).reverse() });
    }

    if (p === '/api/config') {
      return json(res, 200, {
        ...P.counts(),
        idle_ttl_min: Math.round(P.config.idleTtlMs / 60000),
        lifecycle: 'caller', // 浏览器生命周期由调用方（browserctl / REST）管理
        viewport: { width: P.config.viewportW, height: P.config.viewportH },
        public_host: P.config.publicHost,
        mcp_endpoint: `http://${HOST}:${PORT}/mcp`,
        auth_required: !!TOKEN,
      });
    }

    // ---- 生命周期 API（由调用方/agent 自己管，服务端不自动回收）----
    if (p === '/api/pods' && req.method === 'GET') {
      return json(res, 200, { ...P.counts(), browsers: await P.listPods() });
    }
    if (p === '/api/pods' && req.method === 'POST') {
      const raw = await readBody(req);
      const body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      const pod = await P.startBrowser({
        label: body.label,
        owner: body.owner,
        profileKey: body.profile,
        ttlMinutes: body.ttl_minutes,
      });
      return json(res, 201, await P.describePod(pod));
    }
    const pm = p.match(/^\/api\/pods\/([^/]+)$/);
    if (pm && req.method === 'DELETE') {
      const out = await P.stopBrowser(decodeURIComponent(pm[1]), req.query?.get?.('reason') || '调用方主动停止');
      return json(res, 200, out);
    }
    if (p === '/api/gc' && req.method === 'POST') {
      const raw = await readBody(req);
      const body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      return json(res, 200, await P.gcIdle(Number(body.idle_minutes ?? body.minutes ?? 0)));
    }

    if (p === '/api/sessions' && req.method === 'GET') {
      return json(res, 200, { ...P.counts(), sessions: await P.listPods() });
    }

    if (p === '/api/artifacts' && req.method === 'GET') {
      return json(res, 200, { artifacts: await P.listArtifacts(50) });
    }

    const am = p.match(/^\/api\/artifacts\/([^/]+)(?:\/([^/]+))?$/);
    if (am) {
      const id = decodeURIComponent(am[1]);
      const file = am[2] ? decodeURIComponent(am[2]) : null;
      if (!file) return json(res, 200, { id, files: await P.artifactFiles(id) });
      if (file === 'delete' && req.method === 'POST') {
        const dir = P.artifactPath(id, 'meta.json');
        fs.rmSync(path.dirname(dir), { recursive: true, force: true });
        return json(res, 200, { id, deleted: true });
      }
      return serveFile(req, res, P.artifactPath(id, file), file);
    }

    const m = p.match(/^\/api\/sessions\/([^/]+)(?:\/(screenshot\.jpg|close|events))?$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const action = m[2];
      const pod = P.getPod(id);

      if (!action && req.method === 'GET') {
        return json(res, 200, await P.describePod(pod, { withEvents: 40 }));
      }
      if (action === 'events' && req.method === 'GET') return json(res, 200, pod.events.slice(-200));
      if (action === 'screenshot.jpg' && req.method === 'GET') {
        const buf = await P.captureJpeg(pod, { quality: 60 });
        return send(res, 200, buf, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
      }
      if (action === 'close' && req.method === 'POST') {
        const out = await P.closePod(id, '用户在看板上关闭');
        return json(res, 200, out);
      }
    }

    if (p === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    return json(res, 404, { error: 'not_found', path: p });
  } catch (err) {
    const msg = String(err?.message || err);
    const code = /不存在/.test(msg) ? 404 : 500;
    if (!res.headersSent) json(res, code, { error: msg });
    else res.end();
  }
});

server.requestTimeout = 0;
server.headersTimeout = 65_000;

server.listen(PORT, HOST, () => {
  log(`监听 http://${HOST}:${PORT}`);
  log(`看板   http://${HOST}:${PORT}/`);
  log(`MCP    http://${HOST}:${PORT}/mcp`);
  log(`上限   ${P.config.maxPods} 个并发会话，空闲 ${Math.round(P.config.idleTtlMs / 60000)} 分钟回收`);
  P.startSweeper();
});

async function shutdown(sig) {
  log(`收到 ${sig}，正在清理会话…`);
  try {
    await P.shutdownAll();
  } finally {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => log('unhandledRejection', e?.message || e));
