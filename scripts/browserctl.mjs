#!/usr/bin/env node
/**
 * browserctl —— 浏览器生命周期管理（由调用方/agent 自己管，服务端不做后台回收）
 *
 *   ./scripts/browserctl start [--label 订单页回归] [--owner qa-agent] [--profile shop]
 *   ./scripts/browserctl list
 *   ./scripts/browserctl show <id>
 *   ./scripts/browserctl stop <id> [--reason "任务结束"]
 *   ./scripts/browserctl gc --idle-minutes 60      # 显式回收闲置浏览器（可选）
 *
 * 环境变量：BROWSER_PODS_ENDPOINT（默认 http://127.0.0.1:8787）
 * 输出：默认给人看，加 --json 输出原始 JSON（方便脚本/agent 解析）
 */
const ENDPOINT = (process.env.BROWSER_PODS_ENDPOINT || 'http://127.0.0.1:8787').replace(/\/$/, '');

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const cmd = argv[0];
const rest = argv.slice(1);

function flag(name, def = null) {
  const i = rest.indexOf(`--${name}`);
  if (i === -1) return def;
  return rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : true;
}
const positional = rest.filter((a, i) => !a.startsWith('--') && !(rest[i - 1] || '').startsWith('--'));

async function api(method, path, body) {
  const res = await fetch(`${ENDPOINT}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(data.error || `${res.status} ${text.slice(0, 200)}`);
  return data;
}

function out(obj) {
  if (json) return console.log(JSON.stringify(obj, null, 2));
  return obj;
}

function printBrowser(b) {
  const state = b.attached ? 'attached' : 'idle';
  console.log(`  ${b.id}`);
  console.log(`    名称    ${b.label}   (${b.owner})   状态: ${b.state}/${state}  模式: ${b.mode || 'managed'}`);
  console.log(`    页面    ${b.title || '-'}  ${b.url}`);
  console.log(`    CDP     ${b.cdp_url || '-'}`);
  if (b.live_view_url) console.log(`    画面    ${b.live_view_url}`);
}

async function main() {
  switch (cmd) {
    case 'start': {
      const body = {};
      if (flag('label')) body.label = flag('label');
      if (flag('owner')) body.owner = flag('owner');
      if (flag('profile')) body.profile = flag('profile');
      const b = await api('POST', '/api/pods', body);
      if (json) return out(b);
      console.log('已启动浏览器');
      printBrowser(b);
      console.log(`\n下一步：让 agent 调 browser_attach({ pod_id: "${b.id}" })，或直接用 CDP：${b.cdp_url}`);
      break;
    }
    case 'list':
    case 'status': {
      const data = await api('GET', '/api/pods');
      if (json) return out(data);
      console.log(`${data.instance || ''}  浏览器 ${data.pods ?? data.browsers?.length} / ${data.max}`);
      if (!data.browsers?.length) return console.log('  （没有正在运行的浏览器）');
      data.browsers.forEach(printBrowser);
      break;
    }
    case 'show': {
      const id = positional[0];
      if (!id) throw new Error('用法: browserctl show <id>');
      const data = await api('GET', '/api/pods');
      const b = data.browsers.find((x) => x.id === id);
      if (!b) throw new Error(`没有这个浏览器：${id}`);
      if (json) return out(b);
      printBrowser(b);
      break;
    }
    case 'stop': {
      const id = positional[0];
      if (!id) throw new Error('用法: browserctl stop <id>');
      const reason = flag('reason', '调用方主动停止');
      const data = await api('DELETE', `/api/pods/${encodeURIComponent(id)}?reason=${encodeURIComponent(reason)}`);
      if (json) return out(data);
      console.log(`已停止 ${data.id}`);
      break;
    }
    case 'gc': {
      const minutes = Number(flag('idle-minutes', 60));
      const data = await api('POST', '/api/gc', { idle_minutes: minutes });
      if (json) return out(data);
      console.log(data.stopped.length ? `已回收 ${data.stopped.length} 个：${data.stopped.join(', ')}` : '没有需要回收的浏览器');
      break;
    }
    default:
      console.log(`browserctl —— 浏览器生命周期管理（服务端不做后台回收）

用法：
  browserctl start [--label 名称] [--owner 归属] [--profile 复用登录态] [--json]
  browserctl list | status [--json]
  browserctl show <id>
  browserctl stop <id> [--reason 原因]
  browserctl gc --idle-minutes 60

环境变量：BROWSER_PODS_ENDPOINT（默认 ${ENDPOINT}）`);
      if (!cmd) process.exitCode = 0;
      else process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`错误：${e.message}`);
  process.exitCode = 1;
});
