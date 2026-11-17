import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as P from './pods.mjs';

const ok = (obj) => ({
  content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }],
});

const fail = (err) => ({
  content: [{ type: 'text', text: `操作失败：${err?.message || err}` }],
  isError: true,
});

const guard = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (err) {
    return fail(err);
  }
};

const SESSION = z.string().describe('browser_attach 返回的 session_id');

/** 补全协议：支持 data:/file:/about:，本机地址用 http，其余默认 https */
function normalizeUrl(input) {
  const u = String(input || '').trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return u;
  if (/^(data|about|blob|file|chrome|chrome-extension|view-source):/i.test(u)) return u;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?([/?#]|$)/i.test(u)) return `http://${u}`;
  return `https://${u}`;
}

function resolveLocator(page, { selector, role, name, text, index }) {
  let loc;
  if (selector) loc = page.locator(selector);
  else if (role) loc = page.getByRole(role, name ? { name } : {});
  else if (text) loc = page.getByText(text);
  else throw new Error('需要提供 selector、role（可配 name）或 text 三者之一来定位元素');
  const idx = Number.isInteger(index) ? index : 0;
  return loc.nth(idx);
}

async function pageOf(session_id) {
  const pod = P.getPod(session_id);
  const page = P.activePage(pod);
  if (!page) throw new Error('该会话当前没有可用页面（可能被关闭了），可调用 browser_navigate 重新打开');
  return { pod, page };
}

async function run(pod, fn) {
  return P.withPod(pod, async () => {
    pod.stats.ops += 1;
    return fn();
  });
}

export function buildMcpServer() {
  // 单 MCP 模式：compose 里 MCP_DRIVER_TOOLS=1，供应 + 驱动共 16 个工具。
  // 设 MCP_DRIVER_TOOLS=0 可退回纯供应（5 个），页面操作交给外部驱动 MCP。
  const driverTools = P.config.driverTools;
  const instructions = driverTools
    ? '浏览器供应 + 页面驱动：每个会话是一套隔离的 Xvfb + Chromium，带 noVNC 实时画面、录像与 trace 归档。' +
      '固定流程：browser_open 拿 session_id（同时返回 live_view_url 与 cdp_url）→ ' +
      '用本服务的 browser_navigate / browser_snapshot / browser_click / browser_type / browser_press / ' +
      'browser_eval / browser_wait / browser_text / browser_screenshot / browser_console / browser_network 操作页面 → ' +
      'browser_close 归档。browser_list 可随时查看所有会话；' +
      '空闲超过 POD_IDLE_TTL_MIN 分钟会自动回收（正在操作的浏览器不受影响）。' +
      '需要性能 trace / Lighthouse / 堆快照时才临时用 chrome-devtools CLI 连返回的 cdp_url；' +
      'CDP 端口按槽位递增（9223/9224/…），不要为此常驻 chrome-devtools MCP。'
    : '浏览器供应与会话层：负责开/关浏览器、实时画面、录像与归档，**不负责页面操作**。' +
      '固定流程：browser_open 申请浏览器（返回 session_id、cdp_url、实时画面）→ ' +
      '用外部驱动 MCP（chrome-devtools 等）连该会话的 cdp_url 操作页面 → browser_close 归档。' +
      'CDP 端口按槽位递增（9223/9224/…），外部驱动需按 cdp_url 逐个连接，不要写死 9223。' +
      '空闲超过 POD_IDLE_TTL_MIN 分钟会自动回收（防孤儿），正在操作的浏览器不受影响。';
  const server = new McpServer(
    { name: 'browser-pods', version: '0.1.0' },
    { instructions },
  );

  server.registerTool(
    'browser_open',
    {
      title: '打开浏览器',
      description:
        '开一个浏览器并连上（返回 session_id）。不传 cdp_url 就新建一个独立的沙箱浏览器；传 cdp_url 则只连接你已有的 Chrome。' +
        '用完后必须 browser_close，否则会占着槽位直到空闲超时被回收。',
      inputSchema: {
        label: z.string().optional().describe('会话名，例如「订单页回归」，看板上能认出来'),
        owner: z.string().optional().describe('归属标记（agent 名称等）'),
        profile: z.string().optional().describe('复用命名 profile（保留登录态）；同一个 profile 同时只能被一个浏览器占用'),
        ttl_minutes: z.number().optional().describe('可选：空闲回收分钟数，默认取服务端配置'),
        cdp_url: z.string().optional().describe('可选：连接外部已开调试端口的 Chrome，例如 http://127.0.0.1:9222'),
      },
    },
    guard(async ({ label, owner, profile, ttl_minutes, cdp_url }) => {
      const pod = await P.openBrowser({ label, owner, profileKey: profile, ttlMinutes: ttl_minutes, cdpUrl: cdp_url });
      const info = await P.describePod(pod);
      return ok({
        session_id: pod.id,
        ...info,
        tip: '操作完 browser_close；想看实时画面就打开 live_view_url。',
      });
    }),
  );

  server.registerTool(
    'browser_list',
    {
      title: '列出所有浏览器会话',
      description: '列出当前所有浏览器会话：谁在用、打开到哪、空闲多久、实时画面与 CDP 地址。收尾前先看这个。',
      inputSchema: {},
    },
    guard(async () => {
      const list = await P.listPods();
      return ok({ ...P.counts(), sessions: list });
    }),
  );

  server.registerTool(
    'browser_close',
    {
      title: '关闭浏览器',
      description:
        '结束会话。本服务创建的浏览器会被停掉并归档录像/trace；通过 cdp_url 连接的外部 Chrome 只会断开连接，不会被杀死。',
      inputSchema: { session_id: SESSION, reason: z.string().optional().describe('关闭原因，会写进归档 meta') },
    },
    guard(async ({ session_id, reason }) => ok(await P.closeSession(session_id, reason || 'agent 关闭'))),
  );

  const driverTool = driverTools ? server.registerTool.bind(server) : () => {};
  driverTool(
    'browser_navigate',
    {
      title: '打开网址',
      description: '在当前页面跳转到指定 URL，等待加载完成。返回最终 URL、标题、HTTP 状态码。',
      inputSchema: {
        session_id: SESSION,
        url: z.string().describe('目标地址，可省略协议（会自动补 https://）'),
        wait_until: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).optional(),
        timeout_ms: z.number().optional(),
      },
    },
    guard(async ({ session_id, url, wait_until, timeout_ms }) => {
      const { pod, page } = await pageOf(session_id);
      const target = normalizeUrl(url);
      return run(pod, async () => {
        const res = await page.goto(target, {
          waitUntil: wait_until || 'domcontentloaded',
          timeout: timeout_ms || 45_000,
        });
        P.recordEvent(pod, 'goto', target);
        return ok({
          url: page.url(),
          title: await page.title(),
          status: res ? res.status() : null,
          screenshot_hint: '想让人看画面用 browser_view，想自己判断用 browser_snapshot 或 browser_screenshot',
        });
      });
    }),
  );

  driverTool(
    'browser_snapshot',
    {
      title: '页面结构快照（推荐用来观察）',
      description:
        '返回页面（或指定区域）的无障碍树 YAML，含元素角色与可见名字。比截图更省 token、更适合定位元素，配合 browser_click 的 role/name 参数使用。',
      inputSchema: {
        session_id: SESSION,
        selector: z.string().optional().describe('只快照某个区域，例如 main、#app'),
      },
    },
    guard(async ({ session_id, selector }) => {
      const { pod, page } = await pageOf(session_id);
      return run(pod, async () => {
        let tree = '';
        try {
          tree = selector ? await page.locator(selector).ariaSnapshot() : await page.ariaSnapshot();
        } catch (e) {
          tree = `（ariaSnapshot 不可用：${e.message}）\n` + (await page.innerText('body').catch(() => ''));
        }
        return ok({ url: page.url(), title: await page.title(), snapshot: tree.slice(0, 60_000) });
      });
    }),
  );

  driverTool(
    'browser_screenshot',
    {
      title: '页面截图',
      description: '截当前页面 PNG 返回。视觉验证、让人看效果时用；纯定位元素优先用 browser_snapshot。',
      inputSchema: {
        session_id: SESSION,
        full_page: z.boolean().optional().describe('是否整页（含滚动区域），默认 false 只看视口'),
        selector: z.string().optional().describe('只截某个元素'),
      },
    },
    guard(async ({ session_id, full_page }) => {
      const { pod, page } = await pageOf(session_id);
      return run(pod, async () => {
        const buf = await page.screenshot({ type: 'png', fullPage: !!full_page, timeout: 20_000 });
        pod.stats.screenshots += 1;
        P.recordEvent(pod, 'screenshot', page.url());
        return {
          content: [
            { type: 'text', text: JSON.stringify({ url: page.url(), title: await page.title(), bytes: buf.length }) },
            { type: 'image', data: buf.toString('base64'), mimeType: 'image/png' },
          ],
        };
      });
    }),
  );

  driverTool(
    'browser_text',
    {
      title: '读取页面文本',
      description: '返回页面（或指定元素）的纯文本，适合核对文案、报错信息、列表内容。',
      inputSchema: {
        session_id: SESSION,
        selector: z.string().optional(),
        max_chars: z.number().optional().describe('默认 20000'),
      },
    },
    guard(async ({ session_id, selector, max_chars }) => {
      const { pod, page } = await pageOf(session_id);
      return run(pod, async () => {
        const raw = selector ? await page.locator(selector).first().innerText() : await page.innerText('body');
        const limit = max_chars || 20_000;
        return ok({
          url: page.url(),
          title: await page.title(),
          truncated: raw.length > limit,
          text: raw.slice(0, limit),
        });
      });
    }),
  );

  driverTool(
    'browser_click',
    {
      title: '点击元素',
      description:
        '按 selector 或 role(+name) 或 text 点击。点击后短暂等待网络空闲，方便紧接着验证结果。',
      inputSchema: {
        session_id: SESSION,
        selector: z.string().optional().describe('CSS/XPath，例如 "button.submit"'),
        role: z.string().optional().describe('无障碍角色，例如 button、link、textbox'),
        name: z.string().optional().describe('与 role 搭配的元素可访问名称'),
        text: z.string().optional().describe('按可见文本定位'),
        index: z.number().optional().describe('匹配到多个时选第几个，默认 0'),
        button: z.enum(['left', 'right', 'middle']).optional(),
      },
    },
    guard(async ({ session_id, selector, role, name, text, index, button }) => {
      const { pod, page } = await pageOf(session_id);
      return run(pod, async () => {
        const loc = resolveLocator(page, { selector, role, name, text, index });
        await loc.click({ button: button || 'left', timeout: 20_000 });
        await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
        P.recordEvent(pod, 'click', selector || role ? `${role || ''} ${name || ''} ${selector || ''}`.trim() : text);
        return ok({ clicked: true, url: page.url(), title: await page.title() });
      });
    }),
  );

  driverTool(
    'browser_type',
    {
      title: '输入文本',
      description: '先清空再输入；submit=true 会回车提交。用于表单验证。',
      inputSchema: {
        session_id: SESSION,
        selector: z.string().optional(),
        role: z.string().optional(),
        name: z.string().optional(),
        text_value: z.string().describe('要输入的内容'),
        index: z.number().optional(),
        submit: z.boolean().optional().describe('输入后是否按回车'),
      },
    },
    guard(async ({ session_id, selector, role, name, text_value, index, submit }) => {
      const { pod, page } = await pageOf(session_id);
      return run(pod, async () => {
        const loc = resolveLocator(page, { selector, role, name, index });
        await loc.fill('', { timeout: 15_000 }).catch(() => {});
        await loc.type(text_value, { delay: 15, timeout: 20_000 });
        if (submit) await page.keyboard.press('Enter');
        P.recordEvent(pod, 'type', `${selector || role || ''} ← ${submit ? '[submit] ' : ''}${text_value.slice(0, 60)}`);
        return ok({ typed: true, submitted: !!submit, url: page.url() });
      });
    }),
  );

  driverTool(
    'browser_press',
    {
      title: '按键',
      description: '发送按键，例如 Enter、Escape、PageDown、Control+A。',
      inputSchema: { session_id: SESSION, key: z.string() },
    },
    guard(async ({ session_id, key }) => {
      const { pod, page } = await pageOf(session_id);
      return run(pod, async () => {
        await page.keyboard.press(key);
        P.recordEvent(pod, 'press', key);
        return ok({ pressed: key, url: page.url() });
      });
    }),
  );

  driverTool(
    'browser_eval',
    {
      title: '在页面里执行 JS',
      description: '在页面上下文执行一段表达式并返回 JSON 结果。用于读取 localStorage、计算元素数量、取接口数据等。',
      inputSchema: { session_id: SESSION, expression: z.string() },
    },
    guard(async ({ session_id, expression }) => {
      const { pod, page } = await pageOf(session_id);
      return run(pod, async () => {
        const value = await page.evaluate((src) => {
          // eslint-disable-next-line no-eval
          const v = eval(src);
          return v === undefined ? null : JSON.parse(JSON.stringify(v ?? null));
        }, expression);
        P.recordEvent(pod, 'eval', expression.slice(0, 120));
        return ok({ url: page.url(), result: value });
      });
    }),
  );

  driverTool(
    'browser_wait',
    {
      title: '等待',
      description: '等待若干毫秒，或等待某个元素出现/消失（配合异步渲染的页面）。',
      inputSchema: {
        session_id: SESSION,
        ms: z.number().optional().describe('等待毫秒数，默认 1000'),
        selector: z.string().optional(),
        state: z.enum(['attached', 'detached', 'visible', 'hidden']).optional(),
      },
    },
    guard(async ({ session_id, ms, selector, state }) => {
      const { pod, page } = await pageOf(session_id);
      return run(pod, async () => {
        if (selector) {
          await page.waitForSelector(selector, { state: state || 'visible', timeout: 30_000 });
          return ok({ waited: 'selector', selector, state: state || 'visible' });
        }
        const waitMs = Math.min(ms || 1000, 120_000);
        await page.waitForTimeout(waitMs);
        return ok({ waited_ms: waitMs, url: page.url() });
      });
    }),
  );

  driverTool(
    'browser_console',
    {
      title: '控制台日志与页面错误',
      description: '返回页面 console 输出和未捕获异常，排查前端报错用。',
      inputSchema: { session_id: SESSION, limit: z.number().optional() },
    },
    guard(async ({ session_id, limit }) => {
      const pod = P.getPod(session_id);
      const n = limit || 50;
      return ok({
        url: pod.url,
        console: pod.consoleLogs.slice(-n),
        errors: pod.consoleLogs.filter((l) => l.type === 'error' || l.type === 'pageerror').slice(-n),
      });
    }),
  );

  driverTool(
    'browser_network',
    {
      title: '失败请求与 4xx/5xx',
      description: '返回失败的请求和 HTTP 状态码 >= 400 的响应，验证接口是否正常。',
      inputSchema: { session_id: SESSION, limit: z.number().optional() },
    },
    guard(async ({ session_id, limit }) => {
      const pod = P.getPod(session_id);
      return ok({ url: pod.url, issues: pod.netErrors.slice(-(limit || 50)) });
    }),
  );

  server.registerTool(
    'browser_artifacts',
    {
      title: '列出录像与 trace（复盘用）',
      description:
        '列出最近的会话归档：每个会话都有 webm 录像和 Playwright trace.zip，可下载到本地用 npx playwright show-trace 打开。可按 session_id 只看某个会话。',
      inputSchema: {
        session_id: z.string().optional().describe('只看这个会话的产物'),
        limit: z.number().optional().describe('默认 20'),
      },
    },
    guard(async ({ session_id, limit }) => {
      const all = await P.listArtifacts(limit || 20);
      const list = session_id ? all.filter((a) => a.id === session_id) : all;
      return ok({
        count: list.length,
        hint: 'trace 用 `npx playwright show-trace <文件>` 打开；video.webm 可直接播放',
        artifacts: list.map((a) => ({
          id: a.id,
          label: a.label,
          owner: a.owner,
          started_at: a.started_at,
          duration_s: a.duration_s,
          close_reason: a.close_reason,
          last_url: a.last_url,
          files: a.files.map((f) => f.name),
          trace: a.trace,
          video: a.video,
        })),
      });
    }),
  );

  server.registerTool(
    'browser_view',
    {
      title: '拿到人可看的实时画面地址',
      description:
        '返回该会话的 noVNC 实时画面地址和看板地址。把这个链接发给用户，用户就能在浏览器里看到这个 agent 正在操作什么（可交互、可接管）。',
      inputSchema: { session_id: SESSION },
    },
    guard(async ({ session_id }) => {
      const pod = P.getPod(session_id);
      const info = await P.describePod(pod);
      return ok({
        session_id,
        live_view_url: info.live_view_url,
        dashboard_url: info.dashboard_url,
        note: 'live_view_url 是这项会话独占的虚拟桌面（1440x900），不是用户的真实桌面。',
      });
    }),
  );

  return server;
}
