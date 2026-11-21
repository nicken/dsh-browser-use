import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);

export const config = {
  dataDir: env('DATA_DIR', '/data'),
  maxPods: Number(env('PODS_MAX', '6')),
  // 空闲多久自动回收（防孤儿）。0 = 关闭；正在操作的浏览器不会被回收
  idleTtlMs: Number(env('POD_IDLE_TTL_MIN', '60')) * 60_000,
  displayBase: Number(env('DISPLAY_BASE', '101')),
  vncPortBase: Number(env('VNC_PORT_BASE', '5901')),
  viewPortBase: Number(env('VIEW_PORT_BASE', '6081')),
  cdpPortBase: Number(env('CDP_PORT_BASE', '9223')),
  instanceName: env('INSTANCE_NAME', 'instance-1'),
  novncWeb: env('NOVNC_WEB', '/usr/share/novnc'),
  screen: env('SCREEN_SIZE', '1440x900x24'),
  publicHost: env('PUBLIC_HOST', '127.0.0.1'),
  viewportW: Number(env('VIEWPORT_W', '1440')),
  viewportH: Number(env('VIEWPORT_H', '900')),
  tz: env('TZ_ID', 'Asia/Shanghai'),
  keepProfiles: env('KEEP_PROFILES', '1') === '1',
  vncEnabled: env('VNC_ENABLED', '1') === '1',
  vncListenHost: env('VNC_LISTEN_HOST', '127.0.0.1'),
  browserChannel: env('BROWSER_CHANNEL', ''),
  // 显式忽略 TLS 证书错误（自签/内网 HTTPS 站点）。默认关闭；也可在 browser_open 里按会话开启
  ignoreCertErrors: env('IGNORE_CERT_ERRORS', '0') === '1',
  // 驱动工具开关：0 = 只做“供应/会话/观测”，页面操作交给 chrome-devtools 之类的驱动 MCP
  driverTools: env('MCP_DRIVER_TOOLS', '0') === '1',
  recordVideo: env('RECORD_VIDEO', '1') === '1',
  recordTrace: env('RECORD_TRACE', '1') === '1',
  artifactsKeep: Number(env('ARTIFACTS_KEEP', '50')),
  maxEvents: 200,
  maxConsole: 300,
  maxNet: 200,
};

/** @type {Map<string, any>} */
const pods = new Map();
/** @type {Map<number, string>} */
const slotOwner = new Map();
/** @type {Map<string, string>} */
const profileLocks = new Map();
const allProcs = new Set();
let closing = false;

const rand = () => Math.random().toString(36).slice(2, 8);
const nowIso = () => new Date().toISOString();

function log(...args) {
  console.log(nowIso(), '[pods]', ...args);
}

function pushCapped(arr, item, cap) {
  arr.push(item);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

export function recordEvent(pod, kind, text, extra = {}) {
  if (!pod) return;
  pod.lastUsedAt = Date.now();
  pushCapped(pod.events, { t: nowIso(), kind, text: String(text ?? '').slice(0, 500), ...extra }, config.maxEvents);
}

function firstFreeSlot() {
  for (let s = 1; s <= config.maxPods; s += 1) if (!slotOwner.has(s)) return s;
  return null;
}

function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fs.existsSync(file)) return resolve(true);
      if (Date.now() > deadline) return reject(new Error(`等待 ${file} 超时`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

function waitForPort(port, timeoutMs, host = '127.0.0.1') {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.connect({ port, host });
      sock.once('connect', () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) return reject(new Error(`等待端口 ${port} 超时`));
        setTimeout(tryOnce, 150);
      });
    };
    tryOnce();
  });
}

function spawnProc(name, cmd, args, env = {}) {
  const cp = spawn(cmd, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ...env },
  });
  cp.on('error', (err) => {
    allProcs.delete(cp);
    log(`${name} 启动失败: ${err.message}`);
  });
  cp.stderr.on('data', (b) => {
    const s = b.toString().trim();
    if (s) log(`${name}: ${s.split('\n').slice(-2).join(' | ')}`);
  });
  cp.on('exit', (code, sig) => {
    allProcs.delete(cp);
    if (code !== 0 && code !== null && !closing) log(`${name} 退出 code=${code} sig=${sig}`);
  });
  allProcs.add(cp);
  return cp;
}

function killProc(cp, signal = 'SIGTERM') {
  if (!cp || cp.killed || cp.exitCode !== null) return;
  try {
    cp.kill(signal);
  } catch {
    /* ignore */
  }
}

async function stopProc(cp, name) {
  if (!cp) return;
  killProc(cp, 'SIGTERM');
  const deadline = Date.now() + 2500;
  while (cp.exitCode === null && Date.now() < deadline) await sleep(80);
  if (cp.exitCode === null) {
    killProc(cp, 'SIGKILL');
    await sleep(120);
  }
  allProcs.delete(cp);
  return name;
}

function bindPageEvents(pod, page) {
  pod.activePage = page;
  page.on('console', (m) => {
    pushCapped(
      pod.consoleLogs,
      { t: nowIso(), type: m.type(), text: m.text().slice(0, 1000), url: page.url() },
      config.maxConsole,
    );
  });
  page.on('pageerror', (e) => {
    pushCapped(pod.consoleLogs, { t: nowIso(), type: 'pageerror', text: String(e?.message || e).slice(0, 1000), url: page.url() }, config.maxConsole);
    recordEvent(pod, 'pageerror', String(e?.message || e).slice(0, 300));
  });
  page.on('requestfailed', (req) => {
    pushCapped(
      pod.netErrors,
      { t: nowIso(), kind: 'requestfailed', url: req.url(), method: req.method(), error: req.failure()?.errorText || '' },
      config.maxNet,
    );
  });
  page.on('response', (res) => {
    if (res.status() >= 400) {
      pushCapped(pod.netErrors, { t: nowIso(), kind: 'http', status: res.status(), url: res.url(), method: res.request().method() }, config.maxNet);
    }
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      pod.url = frame.url();
      recordEvent(pod, 'navigate', frame.url());
    }
  });
  page.on('close', () => {
    if (pod.activePage === page) pod.activePage = null;
  });
}

export function activePage(pod) {
  if (pod.activePage && !pod.activePage.isClosed()) return pod.activePage;
  const pages = pod.context.pages().filter((p) => !p.isClosed());
  if (pages.length) {
    pod.activePage = pages[pages.length - 1];
    return pod.activePage;
  }
  return null;
}

/** 同一会话内的操作串行执行，避免多个 agent 并发操作同一页面时互相踩 */
export function withPod(pod, fn) {
  const run = pod.chain.then(fn, fn);
  pod.chain = run.then(
    () => {},
    () => {},
  );
  return run;
}

export function getPod(id) {
  const pod = pods.get(id);
  if (!pod) {
    const known = [...pods.keys()].join(', ') || '(无)';
    throw new Error(`浏览器 ${id} 不存在。当前在跑的：${known}。用 browserctl start 起一个，或 browser_list 看看现有的是哪些。`);
  }
  if (pod.state === 'error') throw new Error(`会话 ${id} 状态异常：${pod.error || '未知错误'}`);
  pod.lastUsedAt = Date.now();
  return pod;
}

export async function createPod({ label = null, owner = null, profileKey = null, ttlMinutes = null, ignoreCertErrors = null } = {}) {
  if (closing) throw new Error('服务正在关闭');
  if (pods.size >= config.maxPods) {
    throw new Error(`并发浏览器已达上限 ${config.maxPods}。先 browserctl stop / gc 收掉不用的，或调大 PODS_MAX。`);
  }
  const slot = firstFreeSlot();
  if (slot === null) throw new Error('没有空闲槽位');

  if (profileKey) {
    if (profileLocks.has(profileKey)) {
      throw new Error(`profile "${profileKey}" 已被会话 ${profileLocks.get(profileKey)} 占用，同一 profile 不能被两个会话同时打开。`);
    }
  }

  const id = `pod-${slot}-${rand()}`;
  const display = `:${config.displayBase + slot}`;
  const displayNum = config.displayBase + slot;
  const vncPort = config.vncPortBase + slot;
  const viewPort = config.viewPortBase + slot;
  const dir = path.join(config.dataDir, 'pods', id);
  const profileDir = profileKey
    ? path.join(config.dataDir, 'profiles', profileKey.replace(/[^\w.-]/g, '_'))
    : path.join(dir, 'profile');

  const pod = {
    id,
    slot,
    label: label || id,
    owner: owner || 'unknown',
    profileKey: profileKey || null,
    display,
    vncPort,
    viewPort,
    cdpPort: config.cdpPortBase + slot - 1,
    dir,
    profileDir,
    state: 'starting',
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    expiresAt: null,
    context: null,
    activePage: null,
    url: 'about:blank',
    procs: {},
    events: [],
    consoleLogs: [],
    netErrors: [],
    chain: Promise.resolve(),
    stats: { ops: 0, screenshots: 0 },
    managed: true,
    external: false,
    // 显式忽略 TLS 证书校验：默认取服务端配置，browser_open 可按会话覆盖
    ignoreCertErrors: ignoreCertErrors == null ? config.ignoreCertErrors : ignoreCertErrors === true,
    attached: false,
    cdpUrl: null,
    artifactsDir: path.join(config.dataDir, 'artifacts', id),
    startedAt: Date.now(),
    videoHandles: [],
    tracingActive: false,
    artifacts: null,
  };

  pods.set(id, pod);
  slotOwner.set(slot, id);
  if (profileKey) profileLocks.set(profileKey, id);
  recordEvent(pod, 'create', `分配槽位 ${slot}，显示 ${display}`);

  try {
    await fsp.mkdir(profileDir, { recursive: true });
    await fsp.mkdir(path.join(dir, 'downloads'), { recursive: true });
    await fsp.mkdir(pod.artifactsDir, { recursive: true });

    // Xvfb 需要 /tmp/.X11-unix 已存在；GLX 在有 nvidia 库的机器上会段错误，直接关掉（Chrome 走 SwiftShader）
    await fsp.mkdir('/tmp/.X11-unix', { recursive: true }).catch(() => {});
    await fsp.chmod('/tmp/.X11-unix', 0o1777).catch(() => {});
    pod.procs.xvfb = spawnProc('xvfb', 'Xvfb', [
      display, '-screen', '0', config.screen, '-nolisten', 'tcp', '-ac', '-extension', 'GLX',
    ]);
    await waitForFile(`/tmp/.X11-unix/X${displayNum}`, 10_000);

    if (config.vncEnabled) {
      pod.procs.x11vnc = spawnProc('x11vnc', 'x11vnc', [
        '-display', display,
        '-rfbport', String(vncPort),
        '-localhost',
        '-nopw',
        '-forever',
        '-shared',
        '-quiet',
        '-noxdamage',
        '-nolookup',
        '-cursor', 'arrow',
      ]);
      await waitForPort(vncPort, 10_000).catch((e) => log(`x11vnc 未就绪: ${e.message}（不影响操作，只影响实时画面）`));

      // websockify 没有 --listen-host，监听地址要写成 host:port 的形式
      const wsArgs = (listenHost) => [
        '--web', config.novncWeb,
        listenHost && listenHost !== '0.0.0.0' ? `${listenHost}:${viewPort}` : String(viewPort),
        `127.0.0.1:${vncPort}`,
      ];
      pod.procs.websockify = spawnProc('websockify', 'websockify', wsArgs(config.vncListenHost));
      try {
        await waitForPort(viewPort, 8_000);
      } catch {
        // 老版本 websockify 不认 --listen-host，降级重试
        log('websockify 绑定指定地址失败，改为监听全部地址重试');
        await stopProc(pod.procs.websockify, 'websockify');
        pod.procs.websockify = spawnProc('websockify', 'websockify', wsArgs(null));
        await waitForPort(viewPort, 8_000).catch((e) => log(`websockify 未就绪: ${e.message}`));
      }
    }

    // 没有窗口管理器时 Chromium 也能正常渲染；有 openbox 则窗口尺寸/焦点更规矩
    pod.procs.wm = spawnProc('openbox', 'openbox', ['--display', display]);
    await sleep(120);

    // 预先写入偏好：关掉翻译气泡 / 密码保存弹窗，画面更干净
    const prefsPath = path.join(profileDir, 'Default', 'Preferences');
    if (!fs.existsSync(prefsPath)) {
      await fsp.mkdir(path.dirname(prefsPath), { recursive: true }).catch(() => {});
      await fsp
        .writeFile(
          prefsPath,
          JSON.stringify({
            translate: { enabled: false },
            translate_blocked_languages: ['zh', 'zh-CN', 'en'],
            credentials_enable_service: false,
            profile: { password_manager_enabled: false, password_manager_leak_detection: false },
          }),
        )
        .catch(() => {});
    }

    log(`启动 Chromium for ${id} on ${display} (profile=${profileDir})`);
    pod.context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      ...(config.browserChannel ? { channel: config.browserChannel } : {}),
      viewport: { width: config.viewportW, height: config.viewportH },
      locale: 'zh-CN',
      timezoneId: config.tz,
      acceptDownloads: true,
      downloadsPath: path.join(dir, 'downloads'),
      // 显式开启时才跳过 TLS 校验；默认仍按正常证书链校验（安全优先）
      ignoreHTTPSErrors: pod.ignoreCertErrors === true,
      ...(config.recordVideo
        ? { recordVideo: { dir: path.join(pod.artifactsDir, 'video'), size: { width: config.viewportW, height: config.viewportH } } }
        : {}),
      env: { ...process.env, DISPLAY: display },
      args: [
        `--window-size=${config.viewportW},${config.viewportH}`,
        '--window-position=0,0',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-dev-shm-usage',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion,Translate,TranslateUI',
        '--disable-notifications',
        '--disable-save-password-bubble',
        '--hide-crash-restore-bubble',
        '--force-device-scale-factor=1',
        '--lang=zh-CN',
        '--use-angle=swiftshader',
        `--remote-debugging-port=${pod.cdpPort}`,
        '--remote-allow-origins=*',
        // 仅在显式开启时跳过证书校验；--ignore-certificate-errors 同时覆盖子资源/WS
        ...(pod.ignoreCertErrors ? ['--ignore-certificate-errors'] : []),
        // 容器里以 root 运行时 Chromium 必须关闭沙箱（外层已有容器隔离兜底）
        ...(process.getuid?.() === 0 ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
      ],
    });

    pod.context.on('page', (page) => bindPageEvents(pod, page));
    for (const page of pod.context.pages()) bindPageEvents(pod, page);
    if (!pod.context.pages().length) await pod.context.newPage();

    if (config.recordTrace) {
      try {
        await pod.context.tracing.start({ screenshots: true, snapshots: true, sources: true, title: pod.label });
        pod.tracingActive = true;
        recordEvent(pod, 'trace', '开始记录 Playwright trace');
      } catch (e) {
        log(`tracing 启动失败: ${e.message}`);
      }
    }

    pod.state = 'ready';
    pod.attached = false;
    const ttlMs = ttlMinutes ? ttlMinutes * 60_000 : config.idleTtlMs;
    pod.expiresAt = ttlMs > 0 ? Date.now() + ttlMs : null;
    recordEvent(pod, 'ready', 'Chromium 已就绪');
    log(`会话就绪 ${id} (${display}, vnc=${vncPort}, view=${viewPort}, cdp=${pod.cdpPort})`);
    return pod;
  } catch (err) {
    pod.state = 'error';
    pod.error = String(err?.message || err);
    log(`会话创建失败 ${id}: ${pod.error}`);
    await destroyPod(pod, '启动失败').catch(() => {});
    throw new Error(`创建浏览器会话失败：${pod.error}`);
  }
}

export async function destroyPod(pod, reason = 'closed') {
  if (!pod || pod.state === 'closed') return;
  pod.state = 'closed';
  recordEvent(pod, 'close', reason);

  // 先把 video 句柄拿住（context 关闭后 page.video() 就取不到了）
  pod.videoHandles = [];
  try {
    for (const [i, page] of pod.context.pages().entries()) {
      const v = page.video();
      if (v) pod.videoHandles.push({ index: i, url: page.url(), video: v });
    }
  } catch {
    /* ignore */
  }

  // trace 必须在 close 之前停，否则写不出来
  if (pod.tracingActive) {
    const tracePath = path.join(pod.artifactsDir, 'trace.zip');
    try {
      await Promise.race([pod.context.tracing.stop({ path: tracePath }), sleep(20_000)]);
      pod.tracePath = tracePath;
      recordEvent(pod, 'trace', 'trace 已落盘');
    } catch (e) {
      log(`tracing 停止失败: ${e.message}`);
    }
  }

  try {
    if (pod.context) await Promise.race([pod.context.close().catch(() => {}), sleep(6000)]);
  } catch {
    /* ignore */
  }

  await finalizeArtifacts(pod, reason);
  await stopProc(pod.procs.wm);
  await stopProc(pod.procs.websockify);
  await stopProc(pod.procs.x11vnc);
  await stopProc(pod.procs.xvfb);
  pods.delete(pod.id);
  slotOwner.delete(pod.slot);
  if (pod.profileKey && profileLocks.get(pod.profileKey) === pod.id) profileLocks.delete(pod.profileKey);
  // 匿名会话的 profile 用完即删；只有显式命名（profile=xxx）的才保留登录态
  if (!pod.profileKey) {
    await fsp.rm(pod.dir, { recursive: true, force: true }).catch(() => {});
  } else if (!config.keepProfiles) {
    await fsp.rm(pod.profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function closePod(id, reason = 'agent 主动关闭') {
  const pod = pods.get(id);
  if (!pod) throw new Error(`会话 ${id} 不存在`);
  await destroyPod(pod, reason);
  return { id, closed: true };
}

async function fileSize(p) {
  try {
    const st = await fsp.stat(p);
    return st.size;
  } catch {
    return 0;
  }
}

/** 收尾：把视频落到 artifacts 目录、写 meta.json，并按数量做保留策略 */
async function finalizeArtifacts(pod, reason) {
  const dir = pod.artifactsDir;
  const videos = [];
  try {
    await fsp.mkdir(dir, { recursive: true });
    // Playwright 的 video.saveAs 在 context 关闭后会失效，直接收 recordVideo.dir 里的成品
    const vdir = path.join(dir, 'video');
    const names = (await fsp.readdir(vdir).catch(() => [])).filter((n) => n.endsWith('.webm'));
    for (const [i, name] of names.entries()) {
      const target = path.join(dir, names.length === 1 ? 'video.webm' : `video-${i}.webm`);
      try {
        await fsp.rename(path.join(vdir, name), target).catch(async () => {
          await fsp.copyFile(path.join(vdir, name), target);
        });
        videos.push({ file: path.basename(target), bytes: await fileSize(target) });
      } catch (e) {
        log(`整理录像失败: ${e.message}`);
      }
    }
    await fsp.rm(vdir, { recursive: true, force: true }).catch(() => {});
  } catch (e) {
    log(`finalize 录像失败: ${e.message}`);
  }

  const traceFile = pod.tracePath && (await fileSize(pod.tracePath)) > 0 ? 'trace.zip' : null;
  const meta = {
    id: pod.id,
    label: pod.label,
    owner: pod.owner,
    profile: pod.profileKey || `slot-${pod.slot}`,
    started_at: new Date(pod.startedAt).toISOString(),
    ended_at: new Date().toISOString(),
    duration_s: Math.round((Date.now() - pod.startedAt) / 1000),
    close_reason: reason,
    last_url: pod.url,
    stats: pod.stats,
    video: videos,
    trace: traceFile,
    console_errors: pod.consoleLogs.filter((l) => l.type === 'error' || l.type === 'pageerror').slice(-30),
    network_issues: pod.netErrors.slice(-30),
    events: pod.events.slice(-80),
  };
  await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2)).catch(() => {});
  pod.artifacts = {
    dir,
    video: videos.map((v) => v.file),
    trace: traceFile,
    meta: path.join(dir, 'meta.json'),
  };
  log(`录像归档 ${pod.id}: video=${videos.length} trace=${traceFile ? 'yes' : 'no'}`);
  await pruneArtifacts();
}

/**
 * 一站式打开：没给 cdp_url 就新建一个浏览器盒子并连上；给了就只连接外部浏览器。
 * 这是 MCP 生命周期工具的入口。
 */
export async function openBrowser({ label = null, owner = null, profileKey = null, ttlMinutes = null, cdpUrl = null, ignoreCertErrors = null } = {}) {
  if (cdpUrl) return attachExternal({ cdpUrl, label, owner });
  const pod = await createPod({ label, owner, profileKey, ttlMinutes, ignoreCertErrors });
  pod.attached = true;
  recordEvent(pod, 'attach', 'MCP 已连接');
  return pod;
}

/** 关闭：本服务起的浏览器 → 停进程并归档；外部浏览器 → 只断开连接 */
export async function closeSession(id, reason = 'agent 关闭') {
  const pod = getPod(id);
  if (pod.external) return detach(id);
  await destroyPod(pod, reason);
  return { id, closed: true, mode: 'managed' };
}

/** 启动一个浏览器盒子（生命周期由调用方负责，MCP 不自动回收） */
export async function startBrowser(opts = {}) {
  return createPod(opts);
}

/** 停止并回收一个浏览器盒子 */
export async function stopBrowser(id, reason = '调用方主动停止') {
  return closePod(id, reason);
}

/**
 * 连接一个“外面已经跑着”的浏览器（BYO / 另一个 agent 自己起的 Chrome）。
 * 只借用 CDP 端口，不动对方进程；断开时只断开连接，不杀浏览器。
 */
export async function attachExternal({ cdpUrl, label = null, owner = null }) {
  if (!cdpUrl) throw new Error('需要 cdpUrl，例如 http://127.0.0.1:9222');
  let parsed;
  try {
    parsed = new URL(cdpUrl);
  } catch {
    throw new Error(`cdpUrl 不合法：${cdpUrl}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('cdpUrl 必须是 http:// 或 https:// 开头');

  const dup = [...pods.values()].find((p) => p.external && p.cdpUrl === cdpUrl);
  if (dup) {
    dup.lastUsedAt = Date.now();
    return dup;
  }
  if (pods.size >= config.maxPods) {
    throw new Error(`连接数已达上限 ${config.maxPods}（PODS_MAX）`);
  }

  const id = `ext-${rand()}`;
  const pod = {
    id,
    slot: null,
    label: label || id,
    owner: owner || 'external',
    profileKey: null,
    display: null,
    vncPort: null,
    viewPort: null,
    cdpPort: null,
    cdpUrl,
    external: true,
    managed: false,
    // 外部浏览器的证书策略由对方进程决定，这里只做展示
    ignoreCertErrors: false,
    attached: true,
    state: 'starting',
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    expiresAt: null,
    context: null,
    browser: null,
    activePage: null,
    url: 'about:blank',
    procs: {},
    events: [],
    consoleLogs: [],
    netErrors: [],
    chain: Promise.resolve(),
    stats: { ops: 0, screenshots: 0 },
    artifactsDir: path.join(config.dataDir, 'artifacts', id),
    startedAt: Date.now(),
    videoHandles: [],
    tracingActive: false,
    artifacts: null,
  };
  pods.set(id, pod);

  try {
    pod.browser = await chromium.connectOverCDP(cdpUrl);
    pod.context = pod.browser.contexts()[0] || (await pod.browser.newContext());
    pod.context.on('page', (page) => bindPageEvents(pod, page));
    for (const page of pod.context.pages()) bindPageEvents(pod, page);
    await fsp.mkdir(pod.artifactsDir, { recursive: true });
    if (config.recordTrace) {
      try {
        await pod.context.tracing.start({ screenshots: true, snapshots: true, sources: true, title: pod.label });
        pod.tracingActive = true;
      } catch (e) {
        log(`外部浏览器 tracing 启动失败: ${e.message}`);
      }
    }
    pod.state = 'ready';
    recordEvent(pod, 'attach', `已连接外部浏览器 ${cdpUrl}`);
    log(`已连接外部浏览器 ${cdpUrl} → ${id}`);
    return pod;
  } catch (err) {
    pods.delete(id);
    throw new Error(`连接 ${cdpUrl} 失败：${err.message}`);
  }
}

/**
 * 解除驱动：assistant 不再操作这个浏览器。
 * - managed（本服务起的）：浏览器继续跑，录像/trace 到 stop 时才归档；
 * - external（外部浏览器）：断开 CDP 并归档 trace，对方的浏览器不受影响。
 */
export async function detach(id) {
  const pod = getPod(id);
  if (pod.external) {
    if (pod.tracingActive) {
      try {
        const tracePath = path.join(pod.artifactsDir, 'trace.zip');
        await Promise.race([pod.context.tracing.stop({ path: tracePath }), sleep(15_000)]);
        pod.tracePath = tracePath;
        pod.tracingActive = false;
      } catch (e) {
        log(`外部浏览器 tracing 停止失败: ${e.message}`);
      }
    }
    await finalizeArtifacts(pod, '驱动断开（外部浏览器）');
    await pod.browser?.close().catch(() => {});
    pods.delete(pod.id);
    return { id, detached: true, browser_still_running: true, mode: 'external' };
  }
  pod.attached = false;
  recordEvent(pod, 'detach', '驱动已断开，浏览器仍由调用方持有');
  return { id, detached: true, browser_still_running: true, mode: 'managed' };
}

/** 显式回收：停掉闲置超过 N 分钟的浏览器（默认不启用任何后台回收） */
export async function gcIdle(minutes) {
  const limitMs = Number(minutes) * 60_000;
  if (!Number.isFinite(limitMs) || limitMs <= 0) throw new Error('需要 minutes > 0');
  const victims = [...pods.values()].filter((p) => Date.now() - p.lastUsedAt > limitMs);
  for (const pod of victims) await destroyPod(pod, `显式回收：闲置超过 ${minutes} 分钟`);
  return { stopped: victims.map((p) => p.id) };
}

export async function pruneArtifacts() {
  try {
    const root = path.join(config.dataDir, 'artifacts');
    const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
    const dirs = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const st = await fsp.stat(path.join(root, e.name)).catch(() => null);
      if (st) dirs.push({ name: e.name, mtime: st.mtimeMs });
    }
    dirs.sort((a, b) => b.mtime - a.mtime);
    for (const old of dirs.slice(config.artifactsKeep)) {
      await fsp.rm(path.join(root, old.name), { recursive: true, force: true }).catch(() => {});
    }
  } catch {
    /* ignore */
  }
}

export async function listArtifacts(limit = 30) {
  const root = path.join(config.dataDir, 'artifacts');
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const metaPath = path.join(root, e.name, 'meta.json');
    try {
      const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
      out.push({ ...meta, files: await artifactFiles(e.name) });
    } catch {
      /* 没有 meta 的目录跳过 */
    }
  }
  out.sort((a, b) => String(b.ended_at).localeCompare(String(a.ended_at)));
  return out.slice(0, limit);
}

export async function artifactFiles(id) {
  const dir = path.join(config.dataDir, 'artifacts', id);
  const names = await fsp.readdir(dir).catch(() => []);
  const files = [];
  for (const name of names) {
    if (name === 'meta.json' || name === 'video') continue;
    const bytes = await fileSize(path.join(dir, name));
    if (bytes > 0) files.push({ name, bytes });
  }
  return files;
}

export function artifactPath(id, name) {
  if (!/^[\w.-]+$/.test(id) || !/^[\w.-]+$/.test(name)) throw new Error('非法路径');
  const p = path.join(config.dataDir, 'artifacts', id, name);
  if (!p.startsWith(path.join(config.dataDir, 'artifacts'))) throw new Error('非法路径');
  return p;
}

export function liveViewUrl(pod) {
  if (!config.vncEnabled || pod.external) return null;
  return `http://${config.publicHost}:${pod.viewPort}/vnc.html?autoconnect=1&resize=remote&reconnect=1&reconnect_delay=1500`;
}

export async function describePod(pod, { withEvents = 6 } = {}) {
  let title = '';
  try {
    const page = activePage(pod);
    if (page) title = await page.title();
  } catch {
    /* ignore */
  }
  return {
    id: pod.id,
    label: pod.label,
    owner: pod.owner,
    state: pod.state,
    slot: pod.slot,
    url: pod.url,
    title,
    created_at: new Date(pod.createdAt).toISOString(),
    last_used_at: new Date(pod.lastUsedAt).toISOString(),
    expires_at: pod.expiresAt ? new Date(pod.expiresAt).toISOString() : null,
    live_view_url: liveViewUrl(pod),
    cdp_url: pod.external ? pod.cdpUrl : `http://127.0.0.1:${pod.cdpPort}`,
    mode: pod.external ? 'external' : 'managed',
    attached: !!pod.attached,
    ignore_cert_errors: pod.ignoreCertErrors === true,
    dashboard_url: `http://${config.publicHost}:${Number(env('LISTEN_PORT', '8787'))}/`,
    profile: pod.profileKey || `slot-${pod.slot}`,
    stats: pod.stats,
    recording: { video: config.recordVideo, trace: config.recordTrace },
    events: pod.events.slice(-withEvents),
  };
}

export async function listPods() {
  return Promise.all([...pods.values()].map((p) => describePod(p)));
}

export async function captureJpeg(pod, { quality = 70, fullPage = false } = {}) {
  const page = activePage(pod);
  if (!page) throw new Error('会话里没有可用页面');
  const buf = await page.screenshot({ type: 'jpeg', quality, fullPage, timeout: 15_000 });
  pod.stats.screenshots += 1;
  return buf;
}

export async function capturePng(pod, { fullPage = false } = {}) {
  const page = activePage(pod);
  if (!page) throw new Error('会话里没有可用页面');
  const buf = await page.screenshot({ type: 'png', fullPage, timeout: 15_000 });
  pod.stats.screenshots += 1;
  return buf;
}

export function counts() {
  return { pods: pods.size, max: config.maxPods, instance: config.instanceName };
}

export function startSweeper() {
  if (config.idleTtlMs <= 0) return null; // 生命周期由调用方管理，不做后台回收
  const timer = setInterval(async () => {
    if (closing) return;
    for (const pod of [...pods.values()]) {
      try {
        if (pod.state === 'ready' && Date.now() - pod.lastUsedAt > config.idleTtlMs) {
          log(`回收空闲会话 ${pod.id}（空闲 ${Math.round((Date.now() - pod.lastUsedAt) / 60000)} 分钟）`);
          await destroyPod(pod, '空闲超时自动回收');
        }
      } catch (e) {
        log(`sweep 出错 ${pod.id}: ${e.message}`);
      }
    }
  }, 15_000);
  timer.unref?.();
  return timer;
}

export async function shutdownAll() {
  closing = true;
  await Promise.all([...pods.values()].map((p) => destroyPod(p, '服务关闭').catch(() => {})));
  for (const cp of [...allProcs]) killProc(cp, 'SIGKILL');
}
