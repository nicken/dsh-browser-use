#!/usr/bin/env node
/**
 * 端到端冒烟：MCP 管理生命周期（browser_open → 操作 → browser_close）。
 *
 *   node scripts/smoke.mjs [endpoint] [--keep]
 *
 * - endpoint 默认 http://127.0.0.1:8787/mcp
 * - --keep 保留会话（方便去看板看），跑完不关闭
 */
const mcpEndpoint = process.argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:8787/mcp';
const base = mcpEndpoint.replace(/\/mcp$/, '');
const KEEP = process.argv.includes('--keep');
let id = 0;

async function rpc(method, params = {}) {
  const res = await fetch(mcpEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  const data = JSON.parse(await res.text());
  if (data.error) throw new Error(`${method} 失败: ${JSON.stringify(data.error)}`);
  return data.result;
}

async function tool(name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args });
  const textPart = (r.content || []).find((c) => c.type === 'text');
  const imgPart = (r.content || []).find((c) => c.type === 'image');
  if (r.isError) throw new Error(`${name}: ${textPart?.text}`);
  let parsed = textPart?.text;
  try {
    parsed = JSON.parse(textPart?.text);
  } catch {
    /* keep */
  }
  return { data: parsed, imageBytes: imgPart ? Buffer.from(imgPart.data, 'base64').length : 0 };
}

const T0 = performance.now();
const t = () => `${((performance.now() - T0) / 1000).toFixed(2)}s`;
const opened = [];

try {
  console.log(`→ MCP ${mcpEndpoint}`);
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0.3.0' },
  });
  console.log(`✓ initialize ${init.serverInfo?.name}@${init.serverInfo?.version}  ${t()}`);

  const tools = await rpc('tools/list');
  const names = tools.tools.map((x) => x.name);
  console.log(`✓ tools/list ${names.length} 个：${names.join(', ')}`);
  for (const need of ['browser_open', 'browser_close', 'browser_list', 'browser_artifacts']) {
    if (!names.includes(need)) throw new Error(`缺少供应层工具 ${need}`);
  }
  const hasDriver = names.includes('browser_navigate');
  console.log(`  驱动工具: ${hasDriver ? '已开启（MCP_DRIVER_TOOLS=1）' : '已关闭——页面操作应交给 mcp__chrome__*'}`);

  console.log('\n— 并发打开 3 个浏览器（browser_open）—');
  const openedResults = await Promise.all(
    ['a', 'b', 'c'].map((k) => tool('browser_open', { label: `smoke-${k}`, owner: 'smoke' })),
  );
  const sessions = openedResults.map((r) => r.data);
  sessions.forEach((s) => {
    opened.push(s.session_id);
    console.log(`  ${s.session_id}  cdp=${s.cdp_url}  view=${s.live_view_url ? 'yes' : 'no'}  ttl=${s.expires_at || '-'}`);
  });

  if (hasDriver) {
    console.log('\n— 驱动（本 MCP 自带，仅 MCP_DRIVER_TOOLS=1 时）—');
    await Promise.all(sessions.map((s) => tool('browser_navigate', { session_id: s.session_id, url: 'https://example.com' })));
    const snaps = await Promise.all(sessions.map((s) => tool('browser_snapshot', { session_id: s.session_id })));
    snaps.forEach((s, i) => console.log(`  ${sessions[i].session_id}: ${s.data.snapshot.split('\n')[0].slice(0, 70)}`));
    const shots = await Promise.all(sessions.map((s) => tool('browser_screenshot', { session_id: s.session_id })));
    shots.forEach((s, i) => console.log(`  ${sessions[i].session_id}: PNG ${s.imageBytes} bytes`));
  } else {
    console.log('\n— 不驱动，只验证“可被外部驱动”（CDP 端口活着）—');
    for (const s of sessions) {
      const v = await fetch(`${s.cdp_url}/json/version`).then((r) => r.json()).catch(() => null);
      console.log(`  ${s.session_id}: ${v ? v.Browser : 'CDP 未响应'}`);
    }
  }

  console.log('\n— browser_list —');
  const list = await tool('browser_list');
  console.log(`  会话数 ${list.data.pods}/${list.data.max}`);
  list.data.sessions.forEach((s) => console.log(`  · ${s.id} [${s.state}] ${s.url}`));

  console.log('\n— browser_close —');
  if (KEEP) {
    console.log('  --keep：保留会话，去 http://127.0.0.1:8787/ 看');
  } else {
    await Promise.all(opened.map((sid) => tool('browser_close', { session_id: sid })));
    const left = await tool('browser_list');
    console.log(`✓ 已全部关闭，剩余 ${left.data.pods} 个  ${t()}`);
  }

  const arts = await tool('browser_artifacts', { limit: 5 });
  console.log(`\n✓ 归档 ${arts.data.count} 份（录像 + trace）`);
  console.log('\n冒烟测试通过 ✅');
} catch (e) {
  console.error('\n✗ 冒烟测试失败：', e.message);
  if (opened.length && !KEEP) {
    await Promise.all(opened.map((sid) => tool('browser_close', { session_id: sid }).catch(() => {})));
  }
  process.exit(1);
}
