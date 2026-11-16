#!/usr/bin/env node
/**
 * 交互链路验证：调用方起浏览器 → MCP 连接 → 点击/输入/取文本/执行 JS/快照 → 断开 → 关闭。
 *   node scripts/interact-test.mjs [endpoint]
 */
const mcpEndpoint = process.argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:8787/mcp';
const base = mcpEndpoint.replace(/\/mcp$/, '');

async function tool(name, args = {}) {
  const res = await fetch(mcpEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const data = await res.json();
  if (data.result?.isError) throw new Error(data.result.content[0].text);
  const text = data.result.content.find((c) => c.type === 'text');
  try {
    return JSON.parse(text.text);
  } catch {
    return text.text;
  }
}

const page = `data:text/html,${encodeURIComponent(`<!doctype html><meta charset=utf-8>
<h1>交互测试</h1>
<button id="b" onclick="document.getElementById('out').textContent = Number(document.getElementById('out').textContent) + 1">加一</button>
<output id="out">0</output>
<input id="in" placeholder="输入"><script>window.__ok = 1</script>`)}`;

let s;
try {
  s = await tool('browser_open', { label: 'interact-test', owner: 'verify' });
  console.log('✓ 打开浏览器', s.session_id, '→', s.cdp_url);

  await tool('browser_navigate', { session_id: s.session_id, url: page });
  await tool('browser_click', { session_id: s.session_id, selector: '#b' });
  await tool('browser_click', { session_id: s.session_id, role: 'button', name: '加一' });
  await tool('browser_type', { session_id: s.session_id, selector: '#in', text_value: '你好，页面验证' });
  const txt = await tool('browser_text', { session_id: s.session_id });
  const ev = await tool('browser_eval', { session_id: s.session_id, expression: 'document.querySelector("#out").textContent + "|" + window.__ok' });
  const snap = await tool('browser_snapshot', { session_id: s.session_id });
  console.log('  文本 →', JSON.stringify(txt.text.replace(/\s+/g, ' ').trim()));
  console.log('  eval →', ev.result, '（两次点击后计数应为 2）');
  console.log('  快照 →', snap.snapshot.split('\n').slice(0, 3).join(' / '));
  const ok = String(ev.result) === '2|1';
  console.log(ok ? '✓ 交互链路 OK' : '✗ 计数不符，疑似点击未生效');
  if (!ok) process.exitCode = 1;

} finally {
  if (s) {
    await tool('browser_close', { session_id: s.session_id }).catch(() => {});
    console.log('✓ 已关闭并归档');
  }
}
