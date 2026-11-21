/**
 * Per-session real-browser control built directly on the Chrome DevTools
 * Protocol (no Playwright dependency; the host runtime ships a global
 * `WebSocket`).
 *
 * Design (phase 2, iteration 1):
 *  - One Chromium process per conversation (Edge or Chrome, first found),
 *    `--remote-debugging-port=0`, an isolated `userDataDir` under
 *    `~/.dsh/browser-use/profiles/<sessionId>`; never the user's daily profile.
 *    At most three live browsers; idle ones close after 15 minutes.
 *  - Observation is the expensive resource: `browser_observe` returns numbered
 *    interactive controls with stable `data-dsh-ref` handles (about 200–450
 *    tokens), and `browser_read` answers a query with a Markdown extract instead
 *    of dumping the DOM.
 *  - One action per call, then a light diff (`changed`) so the model decides
 *    whether to observe again. Actions need a recent observation and a ref or
 *    locator; ambiguity is refused instead of guessed.
 *  - A deterministic safety layer refuses non-http(s) navigation, disallowed
 *    domains, password typing and risky targets unless the session approval
 *    service grants them (which fails closed under the "never" policy).
 */
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export const name = 'browser-use'

/** Tools are the capability; nothing here needs another Host seam. */
export const inject = ['tools']

const MAX_INSTANCES = 3
const IDLE_CLOSE_MS = 15 * 60 * 1000
const IDLE_SWEEP_MS = 60 * 1000
const OBSERVATION_TTL_MS = 120 * 1000
const NAV_TIMEOUT_MS = 30_000
const CDP_TIMEOUT_MS = 20_000
const MAX_CONTROLS = 200
const TEXT_PAGE_CHARS = 4_000
const MAX_READ_CHARS = 8_000
const MAX_TEXT_SOURCE = 200_000
const KEEP_SHOTS = 40
const CONSOLE_BUFFER = 200
const NETWORK_BUFFER = 200
const SHOT_ROUTE = '/api/browser-use/shot'
const STATUS_ROUTE = '/api/browser-use/status'
const CAPABILITY_ROUTE = '/api/browser-use/capability'
const SHOT_FILE_PATTERN = /^[A-Za-z0-9._-]+\.png$/
const DOWNLOAD_FILE_PATTERN = /\.(zip|rar|7z|pdf|docx?|xlsx?|pptx?|csv|txt|png|jpe?g|gif|mp4|mp3)$/i
const DANGEROUS_DOWNLOAD_PATTERN = /\.(exe|msi|bat|cmd|ps1|vbs|apk|dmg|iso|scr|jar)$/i

// Provider-slot coexistence: this plugin drives its own Chromium over CDP and
// never registers the `browserUse` provider seam, so a popular third-party
// browser plugin may own it. Report the seam and the competing plugins instead
// of guessing an owner.
const PROVIDER_SLOT = 'browserUse'
const SELF_MODULE_NAME = 'dsh-browser-use'
const COMPETING_PROVIDER_RE =
  /browser[-_. ]?use|builtin[-_. ]?browser|visual[-_. ]?browser|inner[-_. ]?browser|bridge[-_. ]?browser|dsh-browser/i

const RISK_PATTERN =
  /\b(send|submit|delete|remove|purchase|buy|pay|payment|transfer|confirm|password|credential|format|wipe|shutdown|uninstall|install|overwrite|approve|publish|deploy)\b|发送|提交|删除|移除|购买|支付|付款|转账|确认|密码|卸载|安装|格式化|关机|注销|发布|部署/i
const FINANCIAL_PATTERN =
  /bank|banking|paypal|alipay|wechat\s*pay|wallet|broker|trading|checkout|payment|信用卡|银行|证券|支付|转账|钱包|收银台/i

function dshHomeDirectory() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function dataDirectory() {
  return join(dshHomeDirectory(), 'browser-use')
}

function profilesDirectory() {
  return join(dataDirectory(), 'profiles')
}

function shotsDirectory() {
  return join(dataDirectory(), 'shots')
}

function policyFilePath() {
  return join(dataDirectory(), 'policy.json')
}

function pauseFilePath() {
  return join(dataDirectory(), 'pause.json')
}

function readPause() {
  if (!existsSync(pauseFilePath())) return { paused: false, detail: null }
  const detail = readJsonFile(pauseFilePath())
  return {
    paused: true,
    detail:
      detail && typeof detail === 'object'
        ? {
            reason: typeof detail.reason === 'string' ? detail.reason : 'user',
            at: typeof detail.at === 'string' ? detail.at : '',
            by: typeof detail.by === 'string' ? detail.by : '',
          }
        : { reason: 'user', at: '', by: '' },
  }
}

function writePause(reason, by) {
  mkdirSync(dataDirectory(), { recursive: true })
  writeFileSync(
    pauseFilePath(),
    `${JSON.stringify({ paused: true, reason: reason || 'user', at: new Date().toISOString(), by: by || 'user' })}\n`,
    'utf8',
  )
}

function clearPause() {
  try {
    unlinkSync(pauseFilePath())
  } catch {
    // Already resumed.
  }
}

/** Refusal used by every tool that must stop while the user paused the browser. */
function pausedRefusal(tool) {
  const pause = readPause()
  if (!pause.paused) return null
  return refusal(
    tool,
    'paused',
    `Browser control is paused (reason: ${pause.detail?.reason ?? 'user'}).`,
    'Only the user can resume it: ask them to press "恢复浏览器" in the DSH composer status chip. Do not retry until then.',
  )
}

let lastActionRecord = null

function auditStats() {
  const file = auditFilePath()
  const stats = { actions: 0, refusals: 0, file, recent: [] }
  try {
    const lines = readFileSync(file, 'utf8').trim().split(/\r?\n/)
    const entries = []
    for (const line of lines) {
      if (!line.startsWith('{')) continue
      try {
        const entry = JSON.parse(line)
        stats.actions += 1
        if (entry && entry.ok === false) stats.refusals += 1
        entries.push({
          at: typeof entry?.at === 'string' ? entry.at : '',
          sessionId: typeof entry?.sessionId === 'string' ? entry.sessionId : null,
          tool: typeof entry?.tool === 'string' ? entry.tool : '',
          action: typeof entry?.action === 'string' ? entry.action : null,
          target: typeof entry?.target === 'string' ? entry.target.slice(0, 120) : null,
          url: typeof entry?.url === 'string' ? entry.url.slice(0, 200) : null,
          ok: entry?.ok !== false,
          code: typeof entry?.code === 'string' ? entry.code : null,
          risk: typeof entry?.risk === 'string' ? entry.risk : null,
        })
      } catch {
        // Skip a torn line.
      }
    }
    stats.recent = entries.slice(-20)
  } catch {
    // No audit file yet.
  }
  return stats
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return undefined
  }
}

function auditFilePath() {
  return join(dataDirectory(), 'audit.jsonl')
}

/**
 * Append one browser attempt to the audit trail. Never stores typed text (only
 * its length): the page cannot be trusted to mark a field as secret, so the
 * operator-facing log stays free of input content.
 */
function auditBrowser(exec, tool, args, result) {
  const entry = {
    at: new Date().toISOString(),
    sessionId: sessionIdOf(exec && exec.agent) || null,
    tool,
    action: typeof args?.action === 'string' ? args.action : typeof args?.kind === 'string' ? args.kind : null,
    target: typeof result?.target === 'string' ? result.target.slice(0, 160) : typeof args?.ref === 'string' ? args.ref : null,
    url:
      typeof result?.url === 'string'
        ? result.url.slice(0, 300)
        : result?.changed && typeof result.changed.url === 'string'
          ? result.changed.url.slice(0, 300)
          : null,
    ok: result?.ok !== false,
    code: typeof result?.code === 'string' ? result.code : null,
    textLength: typeof args?.text === 'string' ? args.text.length : null,
    risk: typeof result?.risk === 'string' ? result.risk : null,
  }
  try {
    mkdirSync(dataDirectory(), { recursive: true })
    writeFileSync(auditFilePath(), `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a' })
  } catch {
    // The audit trail must never fail a browser action.
  }
  lastActionRecord = entry
}

function messageOf(error) {
  return error && typeof error.message === 'string' && error.message ? error.message : String(error)
}

function sessionIdOf(agent) {
  try {
    return agent && agent.session && typeof agent.session.id === 'string' ? agent.session.id : ''
  } catch {
    return ''
  }
}

function browserUseEnabled(agent) {
  try {
    const sessionId = sessionIdOf(agent)
    if (!sessionId) return false
    const store = readJsonFile(join(dshHomeDirectory(), 'capability-toggles.json'))
    const record = store && store.sessions && typeof store.sessions === 'object' ? store.sessions[sessionId] : undefined
    return record !== undefined && record.browserUse === true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Per-session capability switch (~/.dsh/capability-toggles.json)
// ---------------------------------------------------------------------------

/**
 * The switch store is shared with other capability plugins; the schema stays
 * `{version:1,sessions:{"<id>":{"browserUse":true}}}`. This Host half only owns
 * the `browserUse` field of one session record and preserves everything else.
 */
function capabilityStorePath() {
  return join(dshHomeDirectory(), 'capability-toggles.json')
}

/** Read the store without ever failing on a missing or torn file. */
function readCapabilityStore() {
  const store = readJsonFile(capabilityStorePath())
  const base = store && typeof store === 'object' && !Array.isArray(store) ? store : {}
  const sessions = base.sessions && typeof base.sessions === 'object' && !Array.isArray(base.sessions) ? base.sessions : {}
  return { ...base, version: Number.isInteger(base.version) ? base.version : 1, sessions }
}

/** Whether the user enabled browser control for one Session (off by default). */
function capabilityEnabledFor(sessionId) {
  const record = readCapabilityStore().sessions[sessionId]
  return record !== undefined && record !== null && typeof record === 'object' && record.browserUse === true
}

/** Whether the user enabled the advanced (granular) tool surface for one Session. */
function capabilityAdvancedFor(sessionId) {
  if (!sessionId) return false
  const record = readCapabilityStore().sessions[sessionId]
  return record !== undefined && record !== null && typeof record === 'object' && record.browserUseAdvanced === true
}

/**
 * Replace the store atomically: a unique temp file beside the target, then a
 * rename, so a concurrent reader never sees a half-written JSON document.
 */
async function writeCapabilityStore(store) {
  const path = capabilityStorePath()
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
    await rename(temp, path)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // The temp file may not exist; the original store is untouched.
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// Browser executable and policy
// ---------------------------------------------------------------------------

const BROWSER_CANDIDATES = () => {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  return [
    process.env.DSH_BROWSER_PATH,
    join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0)
}

function browserExecutable() {
  for (const candidate of BROWSER_CANDIDATES()) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('no Chromium browser found: install Microsoft Edge or Google Chrome, or set DSH_BROWSER_PATH')
}

function compileList(values) {
  if (!Array.isArray(values)) return null
  const patterns = []
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) continue
    try {
      patterns.push(new RegExp(value, 'i'))
    } catch {
      // Ignore an unparsable operator pattern.
    }
  }
  return patterns
}

function readPolicy() {
  const custom = readJsonFile(policyFilePath())
  const allowed = compileList(custom?.allowedDomains) ?? []
  const blocked = compileList(custom?.blockedDomains) ?? []
  const risky = compileList(custom?.riskyIntentReplace)
  return {
    allowedDomains: allowed,
    blockedDomains: blocked,
    riskyIntentPatterns: risky !== null && risky.length > 0 ? risky : [RISK_PATTERN],
  }
}

function domainOf(url) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** Deterministic URL admission; never opens local files or custom schemes. */
function admitUrl(rawUrl) {
  let url
  try {
    url = new URL(String(rawUrl ?? '').trim())
  } catch {
    return { ok: false, code: 'invalid_url', message: 'The url is not absolute (for example https://example.com).', guidance: 'Pass an absolute http(s) URL.' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, code: 'invalid_url', message: `The protocol ${url.protocol} is not allowed; only http and https are.`, guidance: 'Use an http(s) URL.' }
  }
  const policy = readPolicy()
  const host = url.hostname.toLowerCase()
  if (policy.blockedDomains.some((pattern) => pattern.test(host))) {
    return { ok: false, code: 'domain_blocked', message: `The domain ${host} is blocked by the operator policy.`, guidance: 'Ask the user to update ~/.dsh/browser-use/policy.json if this site is expected.' }
  }
  if (policy.allowedDomains.length > 0 && !policy.allowedDomains.some((pattern) => pattern.test(host))) {
    return { ok: false, code: 'domain_blocked', message: `The domain ${host} is not in the operator allowlist.`, guidance: 'Ask the user to add it to ~/.dsh/browser-use/policy.json, or operate a listed domain.' }
  }
  return { ok: true, url: url.href }
}

// ---------------------------------------------------------------------------
// Minimal CDP client over the runtime's global WebSocket
// ---------------------------------------------------------------------------

class CdpClient {
  constructor(webSocketUrl) {
    this.url = webSocketUrl
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()
    this.socket = null
    this.opening = null
  }

  async open() {
    if (this.socket) return
    if (this.opening) return await this.opening
    this.opening = new Promise((resolve, reject) => {
      let socket
      try {
        socket = new WebSocket(this.url)
      } catch (error) {
        reject(new Error(`cannot open the CDP socket: ${messageOf(error)}`))
        return
      }
      socket.onopen = () => {
        this.socket = socket
        resolve()
      }
      socket.onerror = (event) => {
        const reason = event && event.message ? `: ${event.message}` : ''
        reject(new Error(`CDP socket error${reason}`))
      }
      socket.onclose = () => {
        this.socket = null
        for (const entry of this.pending.values()) entry.reject(new Error('the CDP socket closed'))
        this.pending.clear()
        for (const listener of this.listeners) listener('close', {}, undefined)
      }
      socket.onmessage = (event) => this.dispatch(event.data)
    }).finally(() => {
      this.opening = null
    })
    return await this.opening
  }

  dispatch(raw) {
    let message
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      return
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message || 'CDP command failed'))
      else entry.resolve(message.result ?? {})
      return
    }
    for (const listener of this.listeners) listener(message.method, message.params ?? {}, message.sessionId)
  }

  onEvent(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  send(method, params = {}, sessionId) {
    if (!this.socket) throw new Error('the CDP socket is not open')
    const id = this.nextId
    this.nextId += 1
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out`))
      }, CDP_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        this.socket.send(JSON.stringify(payload))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`cannot send CDP ${method}: ${messageOf(error)}`))
      }
    })
  }

  close() {
    try {
      this.socket?.close()
    } catch {
      // Already closed.
    }
    this.socket = null
  }
}

// ---------------------------------------------------------------------------
// Page evaluation helpers
// ---------------------------------------------------------------------------

const OBSERVE_EXPRESSION = String.raw`(() => {
  const selector = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="switch"], [contenteditable="true"], summary, [onclick]';
  const isVisible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 2 && rect.height > 2 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || '1') > 0.05;
  };
  const nameOf = (element) => (element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('placeholder') || element.innerText || element.getAttribute('alt') || element.getAttribute('name') || element.value || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const roleOf = (element) => {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit.toLowerCase();
    const tag = element.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'button';
    if (tag === 'input') {
      const type = (element.type || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio' || type === 'range' || type === 'button' || type === 'submit' || type === 'reset') return type;
      return 'textbox';
    }
    return tag;
  };
  const all = Array.from(document.querySelectorAll(selector)).filter(isVisible);
  const controls = [];
  let index = 0;
  for (const element of all) {
    if (controls.length >= ${MAX_CONTROLS}) break;
    index += 1;
    const ref = 'r' + index;
    try { element.setAttribute('data-dsh-ref', ref); } catch (error) { continue; }
    const type = element.tagName.toLowerCase() === 'input' ? String(element.type || 'text').toLowerCase() : '';
    controls.push({
      ref,
      role: roleOf(element),
      name: nameOf(element),
      tag: element.tagName.toLowerCase(),
      type: type === 'password' ? 'password' : type,
      disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
      valueLength: type === 'password' ? -1 : (typeof element.value === 'string' ? element.value.length : 0),
      checked: element.tagName.toLowerCase() === 'input' && (type === 'checkbox' || type === 'radio') ? Boolean(element.checked) : null,
      selection: element.tagName.toLowerCase() === 'select' ? String(element.value || '') : null,
    });
  }
  const text = (document.body ? document.body.innerText || '' : '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 40000);
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    controls,
    totalControls: all.length,
    text,
  };
})()`

function resolveTargetExpression(target) {
  return String.raw`(() => {
  const target = ${JSON.stringify(target)};
  const selector = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="switch"], [contenteditable="true"], summary, [onclick]';
  const isVisible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 2 && rect.height > 2 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const nameOf = (element) => (element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('placeholder') || element.innerText || element.getAttribute('alt') || element.getAttribute('name') || element.value || '').replace(/\s+/g, ' ').trim();
  const roleOf = (element) => {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit.toLowerCase();
    const tag = element.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') { const type = (element.type || 'text').toLowerCase(); if (type === 'checkbox' || type === 'radio' || type === 'button' || type === 'submit') return type; return 'textbox'; }
    return tag;
  };
  let matches = [];
  if (target.ref) {
    const element = document.querySelector('[data-dsh-ref="' + target.ref.replace(/"/g, '') + '"]');
    if (element) matches = [element];
  } else if (target.css) {
    matches = Array.from(document.querySelectorAll(target.css)).filter(isVisible);
  } else if (target.role || target.text) {
    matches = Array.from(document.querySelectorAll(selector)).filter(isVisible).filter((element) => {
      if (target.role && roleOf(element) !== String(target.role).toLowerCase()) return false;
      if (target.text) {
        const wanted = String(target.text).toLowerCase();
        const name = nameOf(element).toLowerCase();
        if (!(name === wanted || name.includes(wanted))) return false;
      }
      return true;
    });
  }
  if (matches.length === 0) return { matchCount: 0 };
  if (matches.length > 1) return { matchCount: matches.length };
  const element = matches[0];
  try { element.scrollIntoView({ block: 'center', inline: 'center' }); } catch (error) { /* ignore */ }
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return {
    matchCount: 1,
    ref: element.getAttribute('data-dsh-ref') || '',
    role: roleOf(element),
    name: nameOf(element).slice(0, 160),
    tag: element.tagName.toLowerCase(),
    type: element.tagName.toLowerCase() === 'input' ? String(element.type || 'text').toLowerCase() : '',
    disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    href: element.tagName.toLowerCase() === 'a' ? String(element.getAttribute('href') || '') : '',
    download: element.hasAttribute ? element.hasAttribute('download') : false,
    visibility: style.visibility,
  };
})()`
}

const ACT_READY_EXPRESSION = `(() => ({ url: location.href, title: document.title, readyState: document.readyState, dshBoot: typeof window.__DSH_BOOT__ !== 'undefined' }))()`

// ---------------------------------------------------------------------------
// One browser instance per Session
// ---------------------------------------------------------------------------

const instances = new Map()

class BrowserInstance {
  constructor(sessionId) {
    this.sessionId = sessionId
    this.child = null
    this.client = null
    this.port = 0
    this.targetId = ''
    this.pageSession = ''
    this.launchError = null
    this.lastUsedAt = Date.now()
    this.lastObservationAt = 0
    this.lastObservationUrl = ''
    this.previousControls = new Map()
    this.domVersion = 0
    this.closed = false
    this.eventsBound = false
    this.consoleBuffer = []
    this.networkBuffer = []
    this.networkById = new Map()
    this.mode = 'local'
    this.cdpUrl = null
    this.pod = null
  }

  touch() {
    this.lastUsedAt = Date.now()
  }

  /**
   * Attach to an existing CDP endpoint instead of spawning a browser.
   * Used by the pod engine (C1) and by browser_open({ cdp_url }).
   */
  async attach(cdpUrl) {
    const raw = String(cdpUrl || '').trim()
    if (!raw) throw new Error('cdp_url is empty')
    let wsUrl = ''
    if (/^wss?:\/\//i.test(raw)) {
      wsUrl = raw
    } else if (/^https?:\/\//i.test(raw)) {
      const base = raw.replace(/\/+$/, '')
      const response = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(10_000) })
      if (!response.ok) throw new Error(`the CDP endpoint answered ${response.status}`)
      const info = await response.json()
      wsUrl = String(info?.webSocketDebuggerUrl || '')
      if (!wsUrl) throw new Error('the CDP endpoint did not return webSocketDebuggerUrl')
    } else {
      throw new Error('cdp_url must be an http(s):// or ws(s):// URL')
    }
    this.mode = 'attached'
    this.cdpUrl = raw
    this.client = new CdpClient(wsUrl)
    await this.client.open()
    await this.attachPage()
  }

  async start() {
    const profile = join(profilesDirectory(), this.sessionId)
    mkdirSync(profile, { recursive: true })
    // A previous browser may have left these behind. A stale DevToolsActivePort
    // would make us connect to a dead endpoint, and Singleton* makes Chromium
    // hand off to (or wait for) a process that no longer exists.
    for (const stale of ['DevToolsActivePort', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try {
        unlinkSync(join(profile, stale))
      } catch {
        // Nothing to clean.
      }
    }
    const executable = browserExecutable()
    const args = [
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-component-update',
      '--disable-features=Translate,MediaRouter',
      '--disable-session-crashed-bubble',
      '--window-size=1360,900',
      '--new-window',
      // 受控环境（容器 / CI / 内核禁用非特权 user namespace）里 Chromium 的
      // 沙箱无法初始化，显式关闭。仅当操作者设置 DSH_BROWSER_NO_SANDBOX=1 时生效。
      ...(process.env.DSH_BROWSER_NO_SANDBOX === '1' ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] : []),
      'about:blank',
    ]
    this.child = spawn(executable, args, { stdio: 'ignore', windowsHide: false, env: process.env })
    this.child.on('error', (error) => {
      this.launchError = messageOf(error)
    })
    const portFile = join(profile, 'DevToolsActivePort')
    let content = ''
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await delay(150)
      if (this.launchError) throw new Error(`the browser failed to start: ${this.launchError}`)
      if (this.child.exitCode !== null) throw new Error('the browser exited during startup')
      try {
        const text = readFileSync(portFile, 'utf8').trim()
        if (text) {
          content = text
          break
        }
      } catch {
        // The port file appears once the DevTools endpoint is listening.
      }
    }
    if (!content) throw new Error('the browser did not report a DevTools port')
    const [portLine, webSocketPath] = content.split(/\r?\n/)
    this.port = Number(portLine)
    if (!Number.isFinite(this.port) || this.port <= 0) throw new Error('the browser reported an invalid DevTools port')
    this.client = new CdpClient(`ws://127.0.0.1:${this.port}${webSocketPath || ''}`)
    // The listener may accept the TCP connection a moment before the debugging
    // endpoint is ready, so retry the handshake a few times.
    let lastError = null
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await this.client.open()
        lastError = null
        break
      } catch (error) {
        lastError = error
        this.client = new CdpClient(`ws://127.0.0.1:${this.port}${webSocketPath || ''}`)
        await delay(300)
      }
    }
    if (lastError) throw lastError
    await this.attachPage()
  }

  async attachPage() {
    let targetId = ''
    const { targetInfos } = await this.client.send('Target.getTargets')
    const page = (targetInfos || []).find((info) => info.type === 'page')
    if (page) targetId = page.targetId
    if (!targetId) {
      const created = await this.client.send('Target.createTarget', { url: 'about:blank' })
      targetId = created.targetId
    }
    await this.attachTarget(targetId)
  }

  /** Attach to one page target (used by browser_session switch too). */
  async attachTarget(targetId) {
    const attached = await this.client.send('Target.attachToTarget', { targetId, flatten: true })
    this.targetId = targetId
    this.pageSession = attached.sessionId
    this.bindEvents()
    await this.page('Page.enable')
    await this.page('Runtime.enable')
    await this.page('Log.enable').catch(() => {})
    await this.page('Network.enable').catch(() => {})
    // Keep the tab "active" from the renderer's point of view even when another
    // OS window has focus, so synthetic input is not silently throttled away.
    await this.page('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  }

  /** Buffer console output and network activity for `browser_evidence`. */
  bindEvents() {
    if (this.eventsBound) return
    this.eventsBound = true
    this.client.onEvent((method, params, sessionId) => {
      if (sessionId && sessionId !== this.pageSession) return
      if (method === 'Runtime.consoleAPICalled') {
        const rawLevel = String(params.type || 'log')
        const level = rawLevel === 'warning' ? 'warning' : rawLevel === 'error' ? 'error' : rawLevel === 'info' ? 'info' : rawLevel === 'debug' ? 'debug' : 'log'
        const text = (params.args || [])
          .map((argument) => {
            if (argument === null || argument === undefined) return ''
            if (argument.value !== undefined) return String(argument.value)
            if (argument.description !== undefined) return String(argument.description)
            if (argument.preview) return JSON.stringify(argument.preview).slice(0, 200)
            return String(argument.type || '')
          })
          .join(' ')
          .slice(0, 1_000)
        this.consoleBuffer.push({ level, text, at: new Date().toISOString() })
        if (this.consoleBuffer.length > CONSOLE_BUFFER) this.consoleBuffer.shift()
        return
      }
      if (method === 'Runtime.exceptionThrown') {
        const details = params.exceptionDetails || {}
        const text = String(details.exception?.description || details.text || 'uncaught exception').slice(0, 1_000)
        this.consoleBuffer.push({ level: 'exception', text, at: new Date().toISOString() })
        if (this.consoleBuffer.length > CONSOLE_BUFFER) this.consoleBuffer.shift()
        return
      }
      if (method === 'Network.requestWillBeSent') {
        const entry = {
          method: String(params.request?.method || 'GET'),
          url: String(params.request?.url || '').slice(0, 500),
          status: 0,
          failed: false,
          at: new Date().toISOString(),
        }
        this.networkById.set(params.requestId, entry)
        this.networkBuffer.push(entry)
        if (this.networkBuffer.length > NETWORK_BUFFER) {
          const evicted = this.networkBuffer.shift()
          for (const [id, value] of this.networkById) {
            if (value === evicted) {
              this.networkById.delete(id)
              break
            }
          }
        }
        return
      }
      if (method === 'Network.responseReceived') {
        const entry = this.networkById.get(params.requestId)
        if (entry) {
          entry.status = Number(params.response?.status) || 0
          entry.mime = String(params.response?.mimeType || '')
        }
        return
      }
      if (method === 'Network.loadingFailed') {
        const entry = this.networkById.get(params.requestId)
        if (entry) {
          entry.failed = true
          entry.error = String(params.errorText || '').slice(0, 200)
        }
      }
    })
  }

  page(method, params = {}) {
    return this.client.send(method, params, this.pageSession)
  }

  async evaluate(expression) {
    const result = await this.page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'unknown error'
      throw new Error(`page evaluation failed: ${String(detail).slice(0, 400)}`)
    }
    return result.result ? result.result.value : undefined
  }

  async waitReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluate('document.readyState')
        if (state === 'complete') {
          await delay(120)
          return
        }
      } catch {
        // Navigation may swap execution contexts; retry until the deadline.
      }
      await delay(150)
    }
    throw new Error('the page did not finish loading in time')
  }

  async navigate(url) {
    const result = await this.page('Page.navigate', { url })
    if (result.errorText) throw new Error(result.errorText)
    await this.waitReady(NAV_TIMEOUT_MS)
    return await this.evaluate(ACT_READY_EXPRESSION)
  }

  /** Diff the current controls against the previous observation. */
  diffControls(controls) {
    const next = new Map(
      controls.map((control) => [
        control.ref,
        {
          ref: control.ref,
          role: control.role,
          name: control.name,
          type: control.type,
          disabled: control.disabled,
          valueLength: control.valueLength,
          checked: control.checked,
          selection: control.selection,
        },
      ]),
    )
    const addedControls = []
    const modifiedControls = []
    for (const [ref, control] of next) {
      const previous = this.previousControls.get(ref)
      if (!previous) {
        addedControls.push(control)
        continue
      }
      const changes = []
      if (previous.name !== control.name) changes.push('name')
      if (previous.disabled !== control.disabled) changes.push('disabled')
      if (previous.type !== control.type) changes.push('type')
      if (previous.valueLength !== control.valueLength) changes.push('value')
      if (previous.checked !== control.checked) changes.push('checked')
      if (previous.selection !== control.selection) changes.push('selection')
      if (changes.length > 0) modifiedControls.push({ ref, name: control.name, changes })
    }
    const removedControls = []
    for (const ref of this.previousControls.keys()) {
      if (!next.has(ref)) removedControls.push(ref)
    }
    this.previousControls = next
    return {
      added: addedControls.length,
      removed: removedControls.length,
      addedControls: addedControls.slice(0, 10),
      removedControls: removedControls.slice(0, 10),
      modifiedControls: modifiedControls.slice(0, 10),
    }
  }

  /** Paint a short-lived outline + label on the target so the user sees the next action. */
  async highlightTarget(ref, action, name, options = {}) {
    const durationMs = Number.isFinite(options.durationMs) ? Math.max(500, Math.min(30_000, options.durationMs)) : 3000
    const label = typeof options.label === 'string' && options.label ? options.label : `即将${action}：${String(name ?? '').slice(0, 40)}`
    try {
      const result = await this.evaluate(String.raw`(() => {
  const element = document.querySelector('[data-dsh-ref="' + ${JSON.stringify(String(ref))}.replace(/"/g, '') + '"]');
  if (!element) return { ok: false, reason: 'element-missing' };
  const previousOutline = element.style.outline;
  element.style.outline = '3px solid #e5484d';
  element.style.outlineOffset = '2px';
  const stale = document.getElementById('__dsh_action_hint__');
  if (stale) stale.remove();
  const hint = document.createElement('div');
  hint.id = '__dsh_action_hint__';
  hint.textContent = ${JSON.stringify(label)};
  hint.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:2147483647;background:#e5484d;color:#fff;font:12px/1.6 system-ui,sans-serif;padding:4px 10px;border-radius:6px;pointer-events:none;box-shadow:0 2px 8px rgb(0 0 0 / 25%)';
  document.body.appendChild(hint);
  console.log('[dsh-browser-use] highlight shown:', hint.textContent);
  setTimeout(() => {
    element.style.outline = previousOutline;
    element.style.outlineOffset = '';
    const current = document.getElementById('__dsh_action_hint__');
    if (current) current.remove();
  }, ${durationMs});
  return { ok: true };
})()`)
      return result && result.ok === true
    } catch {
      // A missing highlight must never block the action.
      return false
    }
  }

  async observe(mode) {
    if (mode === 'ax') {
      const tree = await this.page('Accessibility.getFullAXTree')
      const nodes = (tree.nodes || [])
        .filter((node) => !node.ignored && node.role && node.role.value)
        .slice(0, MAX_CONTROLS)
        .map((node, index) => ({
          ref: `ax${index + 1}`,
          role: String(node.role.value),
          name: String(node.name?.value ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
        }))
      this.lastObservationAt = Date.now()
      this.lastObservationUrl = ''
      return { mode, nodes, text: '' }
    }
    const snapshot = await this.evaluate(OBSERVE_EXPRESSION)
    const controls = Array.isArray(snapshot?.controls) ? snapshot.controls : []
    const changed = this.diffControls(controls)
    this.lastObservationAt = Date.now()
    this.lastObservationUrl = String(snapshot?.url ?? '')
    this.domVersion += 1
    const fullText = String(snapshot?.text ?? '')
    if (mode === 'text') {
      return {
        mode: 'text',
        url: String(snapshot?.url ?? ''),
        title: String(snapshot?.title ?? ''),
        fullText,
        changed,
      }
    }
    return {
      mode: 'controls',
      url: String(snapshot?.url ?? ''),
      title: String(snapshot?.title ?? ''),
      controls,
      totalControls: Number(snapshot?.totalControls) || controls.length,
      chars: fullText.length,
      text: fullText.slice(0, 1200),
      changed,
    }
  }

  async resolveTarget(target) {
    return await this.evaluate(resolveTargetExpression(target))
  }

  async captureChanged() {
    const meta = await this.evaluate(ACT_READY_EXPRESSION)
    let snapshot = null
    try {
      snapshot = await this.evaluate(OBSERVE_EXPRESSION)
    } catch {
      snapshot = null
    }
    const controls = Array.isArray(snapshot?.controls) ? snapshot.controls : []
    const changed = this.diffControls(controls)
    this.domVersion += 1
    return {
      url: String(meta?.url ?? ''),
      title: String(meta?.title ?? ''),
      domVersion: this.domVersion,
      ...changed,
    }
  }

  async dispatchClick(rect) {
    const x = rect.x + rect.width / 2
    const y = rect.y + rect.height / 2
    await this.page('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
    await this.page('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await this.page('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }

  async focusAndClear(ref) {
    return await this.evaluate(String.raw`(() => {
  const element = document.querySelector('[data-dsh-ref="' + ${JSON.stringify(ref)}.replace(/"/g, '') + '"]');
  if (!element) return { ok: false };
  element.focus();
  if (element.isContentEditable) { element.innerText = ''; }
  else if ('value' in element) { element.value = ''; element.dispatchEvent(new Event('input', { bubbles: true })); }
  return { ok: true };
})()`)
  }

  async typeText(text) {
    await this.page('Input.insertText', { text })
  }

  async pressKeys(keys) {
    const parts = String(keys ?? '')
      .split('+')
      .map((part) => part.trim())
      .filter(Boolean)
    if (parts.length === 0) throw new Error('"keys" must name at least one key, for example "Enter" or "Control+A"')
    const keyName = parts[parts.length - 1]
    const modifiers = parts.slice(0, -1).map((part) => part.toLowerCase())
    const MODIFIERS = { control: 2, ctrl: 2, shift: 8, alt: 1, meta: 4, command: 4 }
    let mask = 0
    for (const modifier of modifiers) {
      const value = MODIFIERS[modifier]
      if (value === undefined) throw new Error(`"${modifier}" is not a modifier; use Control, Shift, Alt or Meta`)
      mask |= value
    }
    const SPECIAL = {
      enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
      tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
      escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
      esc: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
      backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
      delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
      arrowdown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
      arrowup: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
      arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
      arrowright: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
      space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
      pagedown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
      pageup: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
      home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
      end: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
    }
    const lower = keyName.toLowerCase()
    let spec = SPECIAL[lower]
    if (!spec) {
      if (keyName.length !== 1) throw new Error(`unknown key "${keyName}"`)
      const upper = keyName.toUpperCase()
      spec = { key: keyName, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), text: keyName }
    }
    const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.windowsVirtualKeyCode, modifiers: mask }
    await this.page('Input.dispatchKeyEvent', { ...base, type: 'keyDown', ...(spec.text && mask === 0 ? { text: spec.text } : {}) })
    await this.page('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
  }

  async scroll(deltaY) {
    await this.page('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: 640,
      y: 450,
      deltaX: 0,
      deltaY,
    })
  }

  async selectOption(ref, option) {
    return await this.evaluate(String.raw`(() => {
  const element = document.querySelector('[data-dsh-ref="' + ${JSON.stringify(ref)}.replace(/"/g, '') + '"]');
  if (!element || element.tagName.toLowerCase() !== 'select') return { ok: false, reason: 'not-a-select' };
  const wanted = ${JSON.stringify(String(option ?? ''))};
  const match = Array.from(element.options).find((entry) => entry.value === wanted || entry.text === wanted);
  if (!match) return { ok: false, reason: 'no-option' };
  element.value = match.value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
})()`)
  }

  async pageText() {
    const expression = String.raw`(document.body ? (document.body.innerText || '') : '').slice(0, ${MAX_TEXT_SOURCE})`
    return String(await this.evaluate(expression))
  }

  async screenshot() {
    const shot = await this.page('Page.captureScreenshot', { format: 'png' })
    mkdirSync(shotsDirectory(), { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const path = join(shotsDirectory(), `browser-${stamp}.png`)
    writeFileSync(path, Buffer.from(shot.data, 'base64'))
    const metrics = await this.page('Page.getLayoutMetrics')
    const viewport = metrics.cssLayoutViewport || {}
    return {
      path,
      width: Math.round(viewport.clientWidth || 0),
      height: Math.round(viewport.clientHeight || 0),
    }
  }

  async close() {
    this.closed = true
    // An attached browser belongs to someone else (a pod or an external
    // Chrome): detach instead of shutting it down.
    if (this.mode !== 'attached') {
      try {
        await this.client?.send('Browser.close')
      } catch {
        // Browser.close is best effort.
      }
    }
    try {
      this.client?.close()
    } catch {
      // Ignore.
    }
    try {
      if (this.child && this.child.exitCode === null) this.child.kill()
    } catch {
      // Ignore.
    }
    instances.delete(this.sessionId)
  }
}

function pruneShots() {
  try {
    const entries = readdirSync(shotsDirectory())
      .filter((entry) => entry.toLowerCase().endsWith('.png'))
      .map((entry) => {
        const path = join(shotsDirectory(), entry)
        try {
          return { path, mtime: statSync(path).mtimeMs }
        } catch {
          return undefined
        }
      })
      .filter(Boolean)
      .sort((left, right) => right.mtime - left.mtime)
    for (const stale of entries.slice(KEEP_SHOTS)) {
      try {
        unlinkSync(stale.path)
      } catch {
        // Ignore.
      }
    }
  } catch {
    // Ignore.
  }
}

async function instanceFor(sessionId, { create, attachUrl = null, pod = null } = {}) {
  const existing = instances.get(sessionId)
  if (existing && !existing.closed) {
    existing.touch()
    return existing
  }
  if (!create) return null
  if (instances.size >= MAX_INSTANCES) {
    return { error: 'too_many_instances' }
  }
  const instance = new BrowserInstance(sessionId)
  try {
    if (attachUrl) {
      await instance.attach(attachUrl)
      instance.pod = pod
    } else {
      await instance.start()
    }
  } catch (error) {
    try {
      await instance.close()
    } catch {
      // Ignore cleanup failure.
    }
    throw error
  }
  instances.set(sessionId, instance)
  return instance
}

// ---------------------------------------------------------------------------
// Tool results helpers
// ---------------------------------------------------------------------------

function refusal(action, code, message, guidance, extra = {}) {
  return { ok: false, tool: action, code, message, guidance, ...extra }
}

function renderText(value) {
  if (value.ok === false) {
    const lines = [`REFUSED [${value.code}]: ${value.message}`]
    if (value.guidance) lines.push(`Next: ${value.guidance}`)
    if (value.highlighted === true) lines.push('The target was highlighted in the browser for the user.')
    if (value.evidence && value.evidence.path) {
      lines.push(`Approval snapshot: ${value.evidence.path} (read it as an image to see what the user sees).`)
    }
    return lines.join('\n')
  }
  if (value.tool === 'browser_observe') return value.rendered ?? ''
  if (value.tool === 'browser_act') {
    const changed = value.changed
      ? `url=${value.changed.url} title="${value.changed.title}" added=${value.changed.added} removed=${value.changed.removed}` +
        (Array.isArray(value.changed.modifiedControls) && value.changed.modifiedControls.length > 0
          ? ` modified=${value.changed.modifiedControls.map((entry) => `[${entry.ref}]${entry.changes.join('+')}`).join(',')}`
          : '')
      : ''
    return `${value.action} on ${value.target}. ${changed ? `Changed: ${changed}.` : ''}${value.note ?? ''}`
  }
  if (value.tool === 'browser_open') return `Opened ${value.url} — title "${value.title}".`
  if (value.tool === 'browser_read') return value.rendered ?? ''
  if (value.tool === 'browser_session') return value.rendered ?? ''
  if (value.tool === 'browser_evidence') {
    if (value.kind === 'console' || value.kind === 'network') return value.rendered ?? ''
    return `Screenshot saved to ${value.path} (${value.width}x${value.height}) at ${value.url}. Read that path as an image to inspect it.`
  }
  return JSON.stringify(value).slice(0, 2_000)
}

function lineOfObservation(observation) {
  const lines = [`URL: ${observation.url}`, `Title: ${observation.title}`]
  const total = Number(observation.total) || observation.controls.length
  const offset = Number(observation.offset) || 0
  const shown = observation.controls.length
  lines.push(
    `Controls: ${shown}${total > shown || offset > 0 ? ` (${offset + 1}-${offset + shown} of ${total})` : ''}${observation.hasMore ? ` — next page: offset ${observation.nextOffset}` : ''} (refs are for browser_act)`,
  )
  for (const control of observation.controls) {
    const disabled = control.disabled ? ' (disabled)' : ''
    const type = control.type && control.type !== 'text' ? ` [${control.type}]` : ''
    lines.push(`[${control.ref}] ${control.role}${type} "${control.name}"${disabled}`)
  }
  if (observation.changed && (observation.changed.added || observation.changed.removed)) {
    lines.push(`Changed since last observation: +${observation.changed.added} / -${observation.changed.removed}`)
  }
  if (observation.changed && Array.isArray(observation.changed.modifiedControls) && observation.changed.modifiedControls.length > 0) {
    lines.push(
      `Modified controls: ${observation.changed.modifiedControls
        .map((entry) => `[${entry.ref}] "${entry.name}" (${entry.changes.join(',')})`)
        .join('; ')}`,
    )
  }
  if (observation.text) lines.push(`Text excerpt:\n${observation.text}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pod engine (deployment form C1)
// ---------------------------------------------------------------------------
//
// The plugin can drive a browser-pods Chromium instead of a local browser.
// Control goes through the browser-pods REST API (plain fetch, no MCP client);
// pages are then driven over CDP exactly like a local browser.

function browserEngine() {
  const value = String(process.env.DSH_BROWSER_ENGINE || 'local').trim().toLowerCase()
  return ['local', 'pod', 'auto'].includes(value) ? value : 'local'
}

function podConfig() {
  return {
    url: String(process.env.DSH_BROWSER_POD_URL || 'http://127.0.0.1:8787').replace(/\/+$/, ''),
    token: String(process.env.DSH_BROWSER_POD_TOKEN || ''),
    profile: String(process.env.DSH_BROWSER_POD_PROFILE || ''),
    ttlMinutes: Number(process.env.DSH_BROWSER_POD_TTL_MIN || '') || null,
    keep: process.env.DSH_BROWSER_POD_KEEP === '1',
  }
}

function podError(code, message, guidance) {
  const error = new Error(message)
  error.podCode = code
  error.podGuidance = guidance
  return error
}

async function podRequest(method, path, body) {
  const config = podConfig()
  const headers = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (config.token) headers.authorization = `Bearer ${config.token}`
  let response
  try {
    response = await fetch(`${config.url}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    throw podError(
      'pod_unavailable',
      `The browser-pods control plane at ${config.url} is unreachable: ${messageOf(error).slice(0, 200)}`,
      'Start browser-pods (cd mcp && docker compose up -d), set DSH_BROWSER_POD_URL, or use DSH_BROWSER_ENGINE=local.',
    )
  }
  if (response.status === 401 || response.status === 403) {
    throw podError('pod_auth', 'browser-pods rejected the bearer token.', 'Set DSH_BROWSER_POD_TOKEN to the same MCP_TOKEN as the server.')
  }
  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }
  if (!response.ok) {
    throw podError(
      'pod_refused',
      `browser-pods answered ${response.status}: ${String(payload?.error || payload?.message || text).slice(0, 200)}`,
      'Check browser-pods logs (docker logs browser-pods) and capacity (PODS_MAX).',
    )
  }
  return payload
}

async function closePodBestEffort(podId, reason) {
  if (!podId) return
  try {
    await podRequest('DELETE', `/api/pods/${encodeURIComponent(podId)}?reason=${encodeURIComponent(reason || 'dsh close')}`)
  } catch {
    // The pod may be gone already; nothing to do.
  }
}

function podLabelFor(sessionId) {
  return `dsh:${String(sessionId || '').slice(-12)}`
}

function loopbackHost(host) {
  const value = String(host || '').toLowerCase()
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value === '[::1]'
}

/** Only loopback CDP endpoints (or the configured pod host) are attachable by default. */
function cdpTargetAllowed(raw) {
  if (process.env.DSH_BROWSER_ALLOW_REMOTE_CDP === '1') return true
  try {
    const target = new URL(raw)
    if (loopbackHost(target.hostname)) return true
    const podHost = new URL(podConfig().url).hostname
    return target.hostname.toLowerCase() === podHost.toLowerCase()
  } catch {
    return false
  }
}

async function openBrowserAttached(sessionId, admittedUrl, cdpUrl) {
  if (!cdpTargetAllowed(cdpUrl)) {
    return refusal(
      'browser_open',
      'cdp_not_allowed',
      `Refusing to attach to ${cdpUrl}: only loopback CDP endpoints are allowed.`,
      'Set DSH_BROWSER_ALLOW_REMOTE_CDP=1 if you really mean to attach to a remote CDP endpoint.',
    )
  }
  let instance = null
  try {
    instance = await instanceFor(sessionId, { create: true, attachUrl: cdpUrl })
  } catch (error) {
    return refusal('browser_open', 'cdp_attach_failed', `Could not attach to ${cdpUrl}: ${messageOf(error).slice(0, 300)}`, 'Check that the browser has --remote-debugging-port enabled and the URL is reachable.')
  }
  if (instance && instance.error) {
    return refusal('browser_open', instance.error, `At most ${MAX_INSTANCES} browsers may be open at once.`, 'Close another conversation browser.')
  }
  try {
    const meta = await instance.navigate(admittedUrl)
    return {
      ok: true,
      tool: 'browser_open',
      mode: 'attached',
      cdp_url: cdpUrl,
      url: String(meta?.url ?? admittedUrl),
      title: String(meta?.title ?? ''),
      targetId: instance.targetId,
      instances: instances.size,
    }
  } catch (error) {
    await instance.close().catch(() => {})
    return refusal('browser_open', 'cdp_error', `Navigation failed: ${messageOf(error).slice(0, 300)}`, 'Retry once; if it keeps failing, detach and reopen.')
  }
}

async function openBrowserInPod(sessionId, admittedUrl) {
  const config = podConfig()
  let created = null
  try {
    created = await podRequest('POST', '/api/pods', {
      label: podLabelFor(sessionId),
      owner: 'dsh-browser-use',
      ...(config.profile ? { profile: config.profile } : {}),
      ...(config.ttlMinutes ? { ttl_minutes: config.ttlMinutes } : {}),
    })
    const cdpUrl = String(created?.cdp_url || '')
    if (!cdpUrl) throw podError('pod_attach_failed', 'browser-pods did not return cdp_url.', 'Check the browser-pods version and logs.')
    const instance = await instanceFor(sessionId, {
      create: true,
      attachUrl: cdpUrl,
      pod: { id: String(created?.id || ''), liveViewUrl: String(created?.live_view_url || ''), baseUrl: config.url, keep: config.keep },
    })
    if (instance && instance.error) throw podError('pod_refused', `At most ${MAX_INSTANCES} browsers may be open at once.`, 'Close another conversation browser.')
    const meta = await instance.navigate(admittedUrl)
    await instance.page('Page.bringToFront').catch(() => {})
    return {
      ok: true,
      tool: 'browser_open',
      mode: 'pod',
      url: String(meta?.url ?? admittedUrl),
      title: String(meta?.title ?? ''),
      targetId: instance.targetId,
      instances: instances.size,
      pod: { id: instance.pod?.id || '', live_view_url: instance.pod?.liveViewUrl || '' },
    }
  } catch (error) {
    if (created?.id) await closePodBestEffort(created.id, 'dsh-browser-use open failed')
    const code = error?.podCode || 'pod_attach_failed'
    return refusal('browser_open', code, messageOf(error).slice(0, 400), error?.podGuidance || 'Retry, or set DSH_BROWSER_ENGINE=local to use a local browser.')
  }
}

async function browserOpen(ctx, exec, args) {
  const sessionId = sessionIdOf(exec?.agent)
  if (!sessionId) return refusal('browser_open', 'no_session', 'browser_open was called without a conversation.', 'Call it from a conversation.')
  const paused = pausedRefusal('browser_open')
  if (paused) return paused
  const admitted = admitUrl(args?.url)
  if (!admitted.ok) return admitted

  const cdpUrl = typeof args?.cdp_url === 'string' ? args.cdp_url.trim() : ''
  if (cdpUrl) return await openBrowserAttached(sessionId, admitted.url, cdpUrl)

  const engine = browserEngine()
  if (engine !== 'local') {
    const attempt = await openBrowserInPod(sessionId, admitted.url)
    if (attempt.ok) return attempt
    if (engine === 'pod') return attempt
    // engine=auto: fall through to a local browser, but tell the model why.
    if (attempt.code !== 'too_many_instances') attempt.engineNote = `pod engine unavailable (${attempt.code}); used the local browser`
  }

  let instance = null
  try {
    instance = await instanceFor(sessionId, { create: true })
  } catch (error) {
    return refusal('browser_open', 'browser_launch_failed', `The browser could not start: ${messageOf(error).slice(0, 400)}`, 'Check that Edge or Chrome is installed, or set DSH_BROWSER_PATH.')
  }
  if (instance && instance.error) {
    return refusal('browser_open', 'too_many_instances', `At most ${MAX_INSTANCES} browsers may be open at once.`, 'Close a browser from another conversation, or ask the user to do so.')
  }
  try {
    const meta = await instance.navigate(admitted.url)
    // Bring the window to the front so the user can watch (and take over) the
    // action instead of discovering a hidden browser afterwards.
    await instance.page('Page.bringToFront').catch(() => {})
    return {
      ok: true,
      tool: 'browser_open',
      mode: instance.mode,
      ...(instance.pod ? { pod: { id: instance.pod.id, live_view_url: instance.pod.liveViewUrl } } : {}),
      url: String(meta?.url ?? admitted.url),
      title: String(meta?.title ?? ''),
      targetId: instance.targetId,
      instances: instances.size,
    }
  } catch (error) {
    return refusal('browser_open', 'cdp_error', `Navigation failed: ${messageOf(error).slice(0, 400)}`, 'Retry once; if it keeps failing, close the session with browser_session and reopen.')
  }
}

async function browserObserve(ctx, exec, args) {
  const sessionId = sessionIdOf(exec?.agent)
  const paused = pausedRefusal('browser_observe')
  if (paused) return paused
  const instance = sessionId ? await instanceFor(sessionId, { create: false }) : null
  if (!instance) return refusal('browser_observe', 'no_session', 'No browser is open for this conversation.', 'Call browser_open first.')
  if (instance.error) return refusal('browser_observe', instance.error, 'The instance limit was reached.', 'Close another conversation browser.')
  const mode = typeof args?.mode === 'string' ? args.mode : 'controls'
  if (!['controls', 'text', 'ax'].includes(mode)) return refusal('browser_observe', 'invalid_args', 'mode must be controls, text or ax.', 'Pick one of the three modes.')
  const offset = Math.max(0, Math.floor(Number(args?.offset) || 0))
  const limit = Math.min(Math.max(Math.floor(Number(args?.limit) || 60), 1), 200)
  try {
    const observation = await instance.observe(mode)
    observation.ok = true
    observation.tool = 'browser_observe'
    observation.observationId = `obs_${Date.now().toString(36)}`
    observation.observedAt = new Date().toISOString()
    if (mode === 'ax') {
      observation.rendered = `URL: ${observation.nodes.length} accessibility nodes\n${observation.nodes.map((node) => `[${node.ref}] ${node.role} "${node.name}"`).join('\n')}`
      return observation
    }
    if (mode === 'text') {
      const fullText = String(observation.fullText ?? '')
      const pageText = fullText.slice(offset, offset + TEXT_PAGE_CHARS)
      const nextOffset = offset + pageText.length < fullText.length ? offset + pageText.length : null
      return {
        ok: true,
        tool: 'browser_observe',
        mode,
        url: observation.url,
        title: observation.title,
        text: pageText,
        textTotal: fullText.length,
        offset,
        limit,
        hasMore: nextOffset !== null,
        ...(nextOffset !== null ? { nextOffset } : {}),
        observationId: observation.observationId,
        observedAt: observation.observedAt,
        changed: observation.changed,
        rendered:
          `URL: ${observation.url}\nTitle: ${observation.title}\n` +
          `Text: chars ${offset}-${offset + pageText.length} of ${fullText.length}${nextOffset !== null ? ` (next offset ${nextOffset})` : ''}\n` +
          pageText,
      }
    }
    const all = Array.isArray(observation.controls) ? observation.controls : []
    const pageControls = all.slice(offset, offset + limit)
    const nextOffset = offset + pageControls.length < all.length ? offset + pageControls.length : null
    observation.controls = pageControls
    observation.total = all.length
    observation.offset = offset
    observation.limit = limit
    observation.hasMore = nextOffset !== null
    if (nextOffset !== null) observation.nextOffset = nextOffset
    else delete observation.nextOffset
    observation.rendered = lineOfObservation(observation)
    return observation
  } catch (error) {
    return refusal('browser_observe', 'cdp_error', `Observation failed: ${messageOf(error).slice(0, 400)}`, 'Retry; if the page is stuck, navigate again with browser_open.')
  }
}

async function browserAct(ctx, exec, args) {
  const sessionId = sessionIdOf(exec?.agent)
  const paused = pausedRefusal('browser_act')
  if (paused) return paused
  const instance = sessionId ? await instanceFor(sessionId, { create: false }) : null
  if (!instance) return refusal('browser_act', 'no_session', 'No browser is open for this conversation.', 'Call browser_open first.')
  if (instance.error) return refusal('browser_act', instance.error, 'The instance limit was reached.', 'Close another conversation browser.')
  // The DSH page is user-only: it hosts install and authorization controls, so
  // the agent must not drive it even if a browser can reach the same origin.
  try {
    const pageMeta = await instance.evaluate(ACT_READY_EXPRESSION)
    if (isDshUiPage(pageMeta)) {
      return refusal(
        'browser_act',
        'dsh_ui_blocked',
        'The DSH page itself is user-only: it hosts install and authorization controls.',
        'Ask the user to use the DSH page themselves; browser automation may only drive other sites.',
      )
    }
  } catch {
    // Fail closed: if the page cannot be identified, the agent does not get to
    // act on it, because it could be the DSH page.
    return refusal(
      'browser_act',
      'page_unverifiable',
      'The page could not be inspected, so its identity is unknown.',
      'Call browser_observe (or browser_session show) and retry once the page is readable.',
    )
  }
  const action = typeof args?.action === 'string' ? args.action.trim() : ''
  const ACTIONS = ['click', 'type', 'press', 'scroll', 'hover', 'select']
  if (!ACTIONS.includes(action)) return refusal('browser_act', 'invalid_args', `action must be one of: ${ACTIONS.join(', ')}`, 'Send a valid action.')
  if (action !== 'scroll' && action !== 'press') {
    if (!args?.ref && !args?.locator) {
      return refusal('browser_act', 'missing_target', 'This action needs a ref from browser_observe or a locator.', 'Observe the page, then pass ref (or locator {css} or {role,name}).')
    }
  }
  if (Date.now() - instance.lastObservationAt > OBSERVATION_TTL_MS) {
    return refusal('browser_act', 'observe_required', 'There is no fresh observation for this page.', 'Call browser_observe, then retry with a ref from it.')
  }
  const startedAt = Date.now()
  let downloadRisk = null
  try {
    let target = null
    if (action !== 'scroll' && action !== 'press') {
      const descriptor = args?.ref ? { ref: String(args.ref) } : { ...(args.locator || {}) }
      target = await instance.resolveTarget(descriptor)
      if (!target || target.matchCount === 0) {
        return refusal('browser_act', 'stale_ref', 'The target no longer exists on the page.', 'Observe the page again and use a current ref.')
      }
      if (target.matchCount > 1) {
        return refusal('browser_act', 'ambiguous_target', `The locator matched ${target.matchCount} elements.`, 'Use the ref from browser_observe instead of a broad locator.')
      }
      if (target.disabled) {
        return refusal('browser_act', 'invalid_args', 'The target element is disabled.', 'Wait for it to become enabled, then observe again.')
      }
      if (action === 'type' && target.type === 'password') {
        return refusal('browser_act', 'password_target', 'Typing into a password field is refused.', 'Ask the user to enter the password themselves; the browser stays open for takeover.')
      }
      // File pickers and downloads are handed back to the user instead of being
      // driven by the agent. Bring the window forward so the user sees where to act.
      if (target.tag === 'input' && target.type === 'file') {
        await instance.page('Page.bringToFront').catch(() => {})
        const highlighted = await instance.highlightTarget(target.ref, 'upload', target.name, { label: '上传需用户手动选择文件', durationMs: 8000 })
        const shot = await instance.screenshot().catch(() => null)
        if (shot) pruneShots()
        return refusal('browser_act', 'upload_blocked', 'Choosing a file to upload is not performed by the agent.', 'The browser is in front and the file field is highlighted: the user should click it and choose the file themselves.', {
          highlighted,
          ...(shot ? { evidence: { path: shot.path, width: shot.width, height: shot.height } } : {}),
        })
      }
      const hrefPath = String(target.href || '').split(/[?#]/)[0]
      // Dangerous artefacts are blocked outright; other downloadable documents
      // are graded high risk and need approval.
      if (DANGEROUS_DOWNLOAD_PATTERN.test(hrefPath)) {
        await instance.page('Page.bringToFront').catch(() => {})
        const highlighted = await instance.highlightTarget(target.ref, 'download', target.name, { label: '下载已拦截，请用户手动下载', durationMs: 8000 })
        const shot = await instance.screenshot().catch(() => null)
        if (shot) pruneShots()
        return refusal('browser_act', 'download_blocked', 'Downloading an executable or installer is refused.', 'The browser is in front and the link is highlighted: the user can download it deliberately if they want to.', {
          highlighted,
          ...(shot ? { evidence: { path: shot.path, width: shot.width, height: shot.height } } : {}),
        })
      }
      if (target.download === true || DOWNLOAD_FILE_PATTERN.test(hrefPath)) {
        downloadRisk = { level: 'high', reason: 'the target downloads a file' }
      }
    }

    const risk = downloadRisk ?? classifyRisk(action, target, args)
    let highlighted = false
    let evidence = null
    if (risk.level === 'high' && target) {
      // Show the user what is about to happen before asking for approval. The
      // snapshot is taken immediately: the highlight fades after a few seconds,
      // so a model-side screenshot would usually miss it.
      highlighted = await instance.highlightTarget(target.ref, action, target.name)
      evidence = await instance.screenshot().catch(() => null)
      if (evidence) pruneShots()
      if (args?.confirm_risk !== true) {
        return refusal(
          'browser_act',
          'risk_approval_required',
          `This action is graded high risk (${risk.reason}) and needs explicit confirmation.`,
          'If it is really intended, retry with confirm_risk:true; the user then has to approve it (or it is auto-rejected under the "never" policy).',
          { risk: risk.level, highlighted, ...(evidence ? { evidence: { path: evidence.path, width: evidence.width, height: evidence.height } } : {}) },
        )
      }
      const approval = await requestApproval(ctx, exec, args, risk)
      if (!approval.ok) return approval
    }

    // Chromium throttles/suppresses synthetic input for occluded pages: bring the
    // tab forward right before dispatching, otherwise the action silently no-ops.
    await instance.page('Page.bringToFront').catch(() => {})
    let detail = ''
    if (action === 'click' || action === 'hover') {
      const x = target.rect.x + target.rect.width / 2
      const y = target.rect.y + target.rect.height / 2
      await instance.page('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
      if (action === 'click') {
        await instance.page('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
        await instance.page('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      }
      detail = `"${target.name}" (${target.role})`
    } else if (action === 'type') {
      const text = String(args?.text ?? '')
      if (!text) return refusal('browser_act', 'invalid_args', '"text" is required for the type action.', 'Pass the text to type.')
      const focused = await instance.focusAndClear(target.ref)
      if (!focused || focused.ok !== true) return refusal('browser_act', 'stale_ref', 'The target could not be focused.', 'Observe the page again.')
      await instance.typeText(text)
      detail = `typed ${text.length} characters into "${target.name}"`
    } else if (action === 'press') {
      await instance.pressKeys(args?.keys)
      detail = `pressed ${args?.keys}`
    } else if (action === 'scroll') {
      const delta = Number.isFinite(args?.deltaY) ? Number(args.deltaY) : 600
      await instance.scroll(delta)
      detail = `scrolled by ${delta}`
    } else if (action === 'select') {
      const selected = await instance.selectOption(target.ref, args?.option)
      if (!selected || selected.ok !== true) {
        return refusal('browser_act', 'invalid_args', `The option could not be selected (${selected?.reason ?? 'unknown'}).`, 'Check the option value from browser_observe text or use type/press instead.')
      }
      detail = `selected "${args?.option}" in "${target.name}"`
    }

    await delay(250)
    const changed = await instance.captureChanged()
    return {
      ok: true,
      tool: 'browser_act',
      action,
      target: detail,
      changed,
      elapsedMs: Date.now() - startedAt,
    }
  } catch (error) {
    return refusal('browser_act', 'cdp_error', `The action failed: ${messageOf(error).slice(0, 400)}`, 'Retry once; if it keeps failing, observe again or reopen the page.')
  }
}

function classifyRisk(action, target, args) {
  const policy = readPolicy()
  const intent = typeof args?.intent === 'string' ? args.intent : ''
  if (intent && policy.riskyIntentPatterns.some((pattern) => pattern.test(intent))) {
    return { level: 'high', reason: 'intent matches a risky verb' }
  }
  const surface = target ? `${target.name} ${target.role} ${target.tag}` : ''
  if (surface && policy.riskyIntentPatterns.some((pattern) => pattern.test(surface))) {
    return { level: 'high', reason: 'the target looks destructive or account-related' }
  }
  if (FINANCIAL_PATTERN.test(surface)) return { level: 'high', reason: 'the target looks financial' }
  return { level: 'low', reason: '' }
}

async function requestApproval(ctx, exec, args, risk) {
  const approval = ctx.get('approval')
  if (!approval || typeof approval.request !== 'function') {
    return refusal('browser_act', 'risk_unavailable', 'This action is graded high risk but the approval service is not mounted.', 'Ask the user to perform it manually.', { risk: risk.level })
  }
  let outcome = 'unavailable'
  try {
    outcome = await approval.request({
      agent: exec.agent,
      toolName: 'browser_act',
      callId: exec.callId,
      reason: `browser_act ${String(args?.action ?? '')}: ${typeof args?.intent === 'string' ? args.intent : ''} (${risk.reason || 'high risk'})`,
      signal: exec.signal,
    })
  } catch (error) {
    return refusal('browser_act', 'risk_unavailable', `The approval request failed: ${messageOf(error).slice(0, 300)}`, 'Ask the user to perform the action manually.', { risk: risk.level })
  }
  if (outcome === 'allowed-once') return { ok: true }
  let policy = ''
  try {
    policy = typeof approval.effectivePolicy === 'function' ? approval.effectivePolicy(exec.agent.session) : ''
  } catch {
    policy = ''
  }
  const detail = outcome === 'rejected'
    ? policy === 'never'
      ? 'the session approval policy is "never", so approval-required actions are rejected automatically'
      : 'the user rejected this action'
    : outcome === 'cancelled'
      ? 'the approval request was cancelled'
      : 'no approval answerer is available, so the request failed closed'
  return refusal('browser_act', 'risk_denied', `The high-risk action was not approved: ${detail}.`, policy === 'never'
    ? 'Tell the user this action needs an approval policy other than "never"; they can switch it and ask you to retry, or perform the action themselves.'
    : 'Ask the user to approve it explicitly, or perform the action themselves.', { risk: risk.level })
}

async function browserRead(ctx, exec, args) {
  const sessionId = sessionIdOf(exec?.agent)
  const paused = pausedRefusal('browser_read')
  if (paused) return paused
  const instance = sessionId ? await instanceFor(sessionId, { create: false }) : null
  if (!instance) return refusal('browser_read', 'no_session', 'No browser is open for this conversation.', 'Call browser_open first.')
  if (instance.error) return refusal('browser_read', instance.error, 'The instance limit was reached.', 'Close another conversation browser.')
  const query = typeof args?.query === 'string' ? args.query.trim() : ''
  const maxChars = Math.min(Math.max(Number(args?.maxChars) || MAX_READ_CHARS, 400), 20_000)
  let text = ''
  let meta = null
  try {
    text = await instance.pageText()
    meta = await instance.evaluate(ACT_READY_EXPRESSION)
  } catch (error) {
    return refusal('browser_read', 'cdp_error', `Reading the page failed: ${messageOf(error).slice(0, 400)}`, 'Retry once, or observe the page again.')
  }
  const paragraphs = text
    .split(/\n{2,}/)
    .map((entry) => entry.replace(/\s+/g, ' ').trim())
    .filter((entry) => entry.length > 0)
  let selected = paragraphs
  let matched = paragraphs.length
  if (query) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const scored = paragraphs
      .map((entry, index) => {
        const lower = entry.toLowerCase()
        let score = 0
        for (const term of terms) {
          if (lower.includes(term)) score += 1
        }
        return { entry, index, score }
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, 40)
      .sort((left, right) => left.index - right.index)
    selected = scored.map((item) => item.entry)
    matched = selected.length
  }
  let body = selected.join('\n\n')
  const truncated = body.length > maxChars
  if (truncated) body = `${body.slice(0, maxChars)}\n\n[truncated]`
  return {
    ok: true,
    tool: 'browser_read',
    url: String(meta?.url ?? ''),
    title: String(meta?.title ?? ''),
    query,
    matched,
    chars: body.length,
    truncated,
    rendered: `# ${String(meta?.title ?? '')}\nURL: ${String(meta?.url ?? '')}\n${query ? `Query: ${query} — ${matched} matching paragraph(s)\n` : ''}\n${body}`,
  }
}

async function browserSession(ctx, exec, args) {
  const sessionId = sessionIdOf(exec?.agent)
  const action = typeof args?.action === 'string' ? args.action : 'status'
  if (!['status', 'close', 'reset', 'tabs', 'switch', 'show', 'pause'].includes(action)) {
    return refusal('browser_session', 'invalid_args', 'action must be status, tabs, switch, show, close, reset or pause.', 'Pick one of the supported actions.')
  }
  if (action === 'pause') {
    // Model-initiated emergency stop: the model may pause but never resume.
    const existing = readPause()
    if (!existing.paused) writePause('model', 'agent')
    return {
      ok: true,
      tool: 'browser_session',
      action,
      sessionId,
      paused: true,
      instances: instances.size,
      rendered: existing.paused
        ? 'Browser control is already paused (the existing pause record was kept). Only the user can resume it.'
        : 'Browser control is paused. Only the user can resume it from the DSH status chip.',
    }
  }
  const instance = sessionId ? instances.get(sessionId) : null
  if (action === 'tabs' || action === 'switch' || action === 'show') {
    if (!instance || instance.closed) {
      return refusal('browser_session', 'no_session', 'No browser is open for this conversation.', 'Call browser_open first.')
    }
    instance.touch()
    try {
      if (action === 'tabs') {
        const { targetInfos } = await instance.client.send('Target.getTargets')
        const pages = (targetInfos || []).filter((info) => info.type === 'page')
        const tabs = pages.map((page) => ({
          tabId: page.targetId,
          url: String(page.url ?? ''),
          title: String(page.title ?? ''),
          active: page.targetId === instance.targetId,
        }))
        const lines = [`Tabs: ${tabs.length} (active marked with *)`]
        for (const tab of tabs) {
          lines.push(`${tab.active ? '*' : ' '} ${tab.tabId.slice(0, 12)} | ${tab.url} | ${tab.title}`)
        }
        return { ok: true, tool: 'browser_session', action, sessionId, tabs, instances: instances.size, rendered: lines.join('\n') }
      }
      if (action === 'switch') {
        const tabId = typeof args?.tabId === 'string' ? args.tabId.trim() : ''
        if (!tabId) return refusal('browser_session', 'invalid_args', '"tabId" is required for switch.', 'Call browser_session action=tabs and pass one of the tabId values.')
        const { targetInfos } = await instance.client.send('Target.getTargets')
        const pages = (targetInfos || []).filter((info) => info.type === 'page')
        // Accept a unique prefix too: rendered lines may show a shortened id.
        let matched = pages.filter((info) => info.targetId === tabId)
        if (matched.length === 0 && tabId.length >= 6) {
          matched = pages.filter((info) => info.targetId.startsWith(tabId))
        }
        if (matched.length === 0) return refusal('browser_session', 'invalid_args', `No page tab matches ${tabId}.`, 'Call browser_session action=tabs for the current ids.')
        if (matched.length > 1) return refusal('browser_session', 'ambiguous_target', `The id prefix ${tabId} matches ${matched.length} tabs.`, 'Pass the full tabId from action=tabs.')
        const page = matched[0]
        await instance.attachTarget(page.targetId)
        await instance.page('Page.bringToFront').catch(() => {})
        const meta = await instance.evaluate(ACT_READY_EXPRESSION)
        return {
          ok: true,
          tool: 'browser_session',
          action,
          sessionId,
          tabId,
          url: String(meta?.url ?? ''),
          title: String(meta?.title ?? ''),
          instances: instances.size,
          rendered: `Switched to ${String(meta?.url ?? '')} — "${String(meta?.title ?? '')}". Observe again before acting.`,
        }
      }
      await instance.page('Page.bringToFront')
      return { ok: true, tool: 'browser_session', action, sessionId, instances: instances.size, rendered: 'Brought the browser window to the front for the user to take over.' }
    } catch (error) {
      return refusal('browser_session', 'cdp_error', `The tab operation failed: ${messageOf(error).slice(0, 400)}`, 'Retry once; if it keeps failing, close and reopen the browser.')
    }
  }
  if (action === 'status') {
    const pause = readPause()
    const lines = [`Open browsers: ${instances.size}/${MAX_INSTANCES}`, `Browser control: ${pause.paused ? `paused (${pause.detail?.reason ?? 'user'})` : 'active'}`]
    for (const [id, entry] of instances) {
      let url = ''
      let title = ''
      let tabs = 0
      try {
        const meta = await entry.evaluate(ACT_READY_EXPRESSION)
        url = String(meta?.url ?? '')
        title = String(meta?.title ?? '')
        const { targetInfos } = await entry.client.send('Target.getTargets')
        tabs = (targetInfos || []).filter((info) => info.type === 'page').length
      } catch {
        // A crashed page has no readable metadata.
      }
      const idle = Math.round((Date.now() - entry.lastUsedAt) / 1000)
      const active = id === sessionId ? ` | active tab ${String(entry.targetId).slice(0, 12)}` : ''
      const mode = entry.mode === 'attached' ? ` | ${entry.pod ? `pod ${entry.pod.id}` : 'attached'}` : ''
      lines.push(`- ${id === sessionId ? 'this conversation' : `${id.slice(0, 16)}…`} | idle ${idle}s | tabs ${tabs}${active}${mode} | ${url} | ${title}`)
    }
    if (instances.size === 0) lines.push('(no browser open)')
    const provider = await browserProviderReport()
    // Coexistence is reported, never enforced: this plugin's own tools keep
    // working while another browser plugin may own the optional seam.
    if (provider.competing.length > 0) {
      lines.push(
        `Other browser plugins are installed and enabled: ${provider.competing.map((row) => row.moduleName).join(', ')}. Use one browser solution per conversation.`,
      )
    }
    return {
      ok: true,
      tool: 'browser_session',
      action,
      sessionId,
      instances: instances.size,
      ...(instance && typeof instance.targetId === 'string' && instance.targetId ? { tabId: instance.targetId } : {}),
      paused: pause.paused,
      engine: browserEngine(),
      ...(instance && !instance.closed
        ? {
            mode: instance.mode,
            attached: instance.mode === 'attached',
            ...(instance.cdpUrl ? { cdp_url: instance.cdpUrl } : {}),
            ...(instance.pod ? { pod: { id: instance.pod.id, live_view_url: instance.pod.liveViewUrl } } : {}),
          }
        : {}),
      provider,
      rendered: lines.join('\n'),
    }
  }
  if (!instance || instance.closed) {
    return { ok: true, tool: 'browser_session', action, sessionId, instances: instances.size, rendered: 'No browser was open for this conversation.' }
  }
  const podId = instance.pod?.id && instance.pod.keep !== true ? instance.pod.id : ''
  const mode = instance.mode
  await instance.close()
  if (podId) await closePodBestEffort(podId, 'closed from DSH browser_session')
  return {
    ok: true,
    tool: 'browser_session',
    action,
    sessionId,
    instances: instances.size,
    mode,
    ...(podId ? { pod: { id: podId, closed: true } } : {}),
    rendered: mode === 'attached'
      ? `Detached from the browser for this conversation (${instances.size} left).`
      : `Closed the browser for this conversation (${instances.size} left).`,
  }
}

async function browserEvidence(ctx, exec, args) {
  const sessionId = sessionIdOf(exec?.agent)
  const instance = sessionId ? await instanceFor(sessionId, { create: false }) : null
  if (!instance) return refusal('browser_evidence', 'no_session', 'No browser is open for this conversation.', 'Call browser_open first.')
  if (instance.error) return refusal('browser_evidence', instance.error, 'The instance limit was reached.', 'Close another conversation browser.')
  const kind = typeof args?.kind === 'string' ? args.kind : 'screenshot'
  if (!['screenshot', 'console', 'network'].includes(kind)) {
    return refusal('browser_evidence', 'invalid_args', 'kind must be screenshot, console or network.', 'Pick one of the three kinds.')
  }
  const limit = Math.min(Math.max(Number(args?.limit) || 50, 1), 200)
  try {
    const meta = await instance.evaluate(ACT_READY_EXPRESSION)
    const url = String(meta?.url ?? '')
    const title = String(meta?.title ?? '')
    if (kind === 'console') {
      const entries = instance.consoleBuffer.slice(-limit)
      const lines = entries.length === 0 ? ['(no console output captured yet)'] : entries.map((entry) => `[${entry.level}] ${entry.text}`)
      return { ok: true, tool: 'browser_evidence', kind, url, title, entries, rendered: `# console (${entries.length})\n${lines.join('\n')}` }
    }
    if (kind === 'network') {
      const entries = instance.networkBuffer.slice(-limit)
      const lines = entries.length === 0
        ? ['(no network activity captured yet)']
        : entries.map((entry) => `${entry.failed ? 'FAIL' : String(entry.status || 0)} ${entry.method} ${entry.url}${entry.mime ? ` (${entry.mime})` : ''}`)
      return { ok: true, tool: 'browser_evidence', kind, url, title, entries, rendered: `# network (${entries.length})\n${lines.join('\n')}` }
    }
    const shot = await instance.screenshot()
    pruneShots()
    return { ok: true, tool: 'browser_evidence', kind, path: shot.path, width: shot.width, height: shot.height, url, title }
  } catch (error) {
    return refusal('browser_evidence', 'cdp_error', `Evidence capture failed: ${messageOf(error).slice(0, 400)}`, 'Retry once.')
  }
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify({ ok: true, value }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

function errorResponse(message, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: { message } }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/** The status route polls every 10s; the plugin list does not change that fast. */
const PROVIDER_ROW_CACHE_MS = 15_000
let competingBrowserCache = { at: 0, context: null, rows: [] }

/** The DSH page hosts user-only install and authorization controls. */
function isDshUiPage(meta) {
  if (!meta || typeof meta !== 'object') return false
  if (meta.dshBoot === true) return true
  if (typeof meta.title !== 'string' || !/deepseek harness/i.test(meta.title)) return false
  // Only the DSH shell sits at the index route; a documentation page that
  // happens to share the product name elsewhere must stay operable.
  try {
    const url = new URL(String(meta.url ?? ''))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return url.pathname === '/' || url.pathname === '/index.html'
  } catch {
    return false
  }
}

/** One localized title as plain text. */
function providerTitle(value) {  if (typeof value === 'string') return value.slice(0, 120)
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const text = value.en ?? value.zh
    if (typeof text === 'string') return text.slice(0, 120)
  }
  return ''
}

/** Enabled plugin rows that look like another browser-use provider. */
async function competingBrowserPlugins() {
  const manager = pluginContext && typeof pluginContext.get === 'function' ? pluginContext.get('pluginManager') : null
  if (!manager || typeof manager.listPlugins !== 'function') return []
  if (
    competingBrowserCache.context === pluginContext &&
    Date.now() - competingBrowserCache.at < PROVIDER_ROW_CACHE_MS
  ) {
    return competingBrowserCache.rows
  }
  let rows
  try {
    rows = await manager.listPlugins()
  } catch {
    return []
  }
  const competing = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.enabled === true)
    .filter(
      (row) =>
        typeof row.moduleName === 'string' &&
        row.moduleName !== SELF_MODULE_NAME &&
        COMPETING_PROVIDER_RE.test(row.moduleName),
    )
    .slice(0, 8)
    .map((row) => ({
      moduleName: String(row.moduleName).slice(0, 160),
      id: String(row.patchId ?? row.entryId ?? '').slice(0, 80),
      title: providerTitle(row.meta?.title),
    }))
  competingBrowserCache = { at: Date.now(), context: pluginContext, rows: competing }
  return competing
}

/**
 * Coexistence report for the status route. This plugin never claims the
 * `browserUse` seam, so `registered` is always false and `serviceMounted` only
 * says whether the seam exists in this composition; a third-party plugin may or
 * may not be registered on it, which is why the competing rows are listed.
 */
async function browserProviderReport() {
  const serviceMounted = Boolean(
    pluginContext && typeof pluginContext.get === 'function' && pluginContext.get('browserUse'),
  )
  return {
    slot: PROVIDER_SLOT,
    registered: false,
    owner: '',
    serviceMounted,
    note: 'this plugin drives its own Chromium over CDP and does not claim the browserUse provider slot',
    competing: await competingBrowserPlugins(),
  }
}

/** Status payload for the composer chip (and future operator views). */
async function browserStatusValue(highlightSessionId) {
  const pause = readPause()
  const list = []
  for (const [sessionId, instance] of instances) {
    let url = ''
    let title = ''
    let tabs = 0
    try {
      const meta = await instance.evaluate(ACT_READY_EXPRESSION)
      url = String(meta?.url ?? '')
      title = String(meta?.title ?? '')
      const { targetInfos } = await instance.client.send('Target.getTargets')
      tabs = (targetInfos || []).filter((info) => info.type === 'page').length
    } catch {
      // A crashed page has no readable metadata; the entry still lists.
    }
    list.push({
      sessionId,
      url,
      title,
      tabs,
      idleMs: Date.now() - instance.lastUsedAt,
      current: highlightSessionId ? sessionId === highlightSessionId : false,
    })
  }
  return {
    paused: pause.paused,
    pause: pause.detail,
    instances: list,
    audit: auditStats(),
    lastAction: lastActionRecord,
    provider: await browserProviderReport(),
  }
}

async function serveBrowserStatus(request) {
  try {
    let sessionId = ''
    try {
      sessionId = new URL(request.url).searchParams.get('sessionId') ?? ''
    } catch {
      sessionId = ''
    }
    if (request.method === 'POST') {
      let body = null
      try {
        body = await request.json()
      } catch {
        body = null
      }
      const action = typeof body?.action === 'string' ? body.action.trim() : ''
      if (action === 'pause') {
        writePause(typeof body?.reason === 'string' ? body.reason.slice(0, 120) : 'user', 'user')
      } else if (action === 'resume') {
        clearPause()
      } else if (action === 'close') {
        const targetSession = typeof body?.sessionId === 'string' ? body.sessionId : ''
        if (!targetSession) return errorResponse('sessionId is required for close')
        const instance = instances.get(targetSession)
        if (!instance) return errorResponse(`no browser is open for ${targetSession}`, 404)
        await instance.close()
        instances.delete(targetSession)
      } else {
        return errorResponse('action must be "pause", "resume" or "close"')
      }
    }
    return jsonResponse(await browserStatusValue(sessionId))
  } catch (error) {
    return errorResponse(messageOf(error), 500)
  }
}

/**
 * Per-session switch route for the 浏览器 tab: GET answers `{enabled}`, POST
 * sets it. The browser tools read the same store through their `when`
 * predicate, so a saved value is observed by the next tool call.
 */
async function serveCapability(request) {
  try {
    let querySession = ''
    try {
      querySession = new URL(request.url).searchParams.get('sessionId') ?? ''
    } catch {
      querySession = ''
    }
    const sessionKey = (value) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : '')
    if (request.method === 'GET') {
      const target = sessionKey(querySession)
      if (!target) return errorResponse('sessionId is required')
      return jsonResponse({ enabled: capabilityEnabledFor(target), advanced: capabilityAdvancedFor(target) })
    }
    if (request.method !== 'POST') return errorResponse('method not allowed', 405)
    let body = null
    try {
      body = await request.json()
    } catch {
      body = null
    }
    const target = sessionKey(body?.sessionId) || sessionKey(querySession)
    if (!target) return errorResponse('sessionId is required')
    const wantsEnabled = typeof body?.enabled === 'boolean'
    const wantsAdvanced = typeof body?.advanced === 'boolean'
    if (!wantsEnabled && !wantsAdvanced) return errorResponse('enabled or advanced must be a boolean')
    const store = readCapabilityStore()
    const previous = store.sessions[target]
    const record = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}
    // Keep this session's other capability fields and every other session.
    const next = { ...record }
    if (wantsEnabled) next.browserUse = body.enabled
    if (wantsAdvanced) next.browserUseAdvanced = body.advanced
    store.sessions[target] = next
    await writeCapabilityStore(store)
    return jsonResponse({ enabled: next.browserUse === true, advanced: next.browserUseAdvanced === true })
  } catch (error) {
    return errorResponse(messageOf(error), 500)
  }
}

async function serveShot(request) {  let file = ''
  try {
    file = new URL(request.url).searchParams.get('file') ?? ''
  } catch {
    return new Response('Bad Request', { status: 400 })
  }
  if (!SHOT_FILE_PATTERN.test(file)) return new Response('Not Found', { status: 404 })
  try {
    const bytes = await readFile(join(shotsDirectory(), file))
    const headers = { 'content-type': 'image/png', 'cache-control': 'no-store' }
    return request.method === 'HEAD' ? new Response(null, { status: 200, headers }) : new Response(bytes, { status: 200, headers })
  } catch {
    return new Response('Not Found', { status: 404 })
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

function outputSchema(extra = {}) {
  return {
    type: 'object',
    // Observation payloads mix fixed fields with mode-specific ones; the declared
    // properties are documentation, extra fields are allowed.
    additionalProperties: true,
    required: ['ok'],
    properties: {
      ok: { type: 'boolean' },
      tool: { type: 'string' },
      code: { type: 'string' },
      message: { type: 'string' },
      guidance: { type: 'string' },
      ...extra,
    },
  }
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

let pluginContext = null

function defineTool(def) {
  return def
}

export function apply(ctx) {
  pluginContext = ctx
  ctx.inject(['connection'], (inner) => {
    inner.effect(() => {
      const disposers = [
        inner.connection.fetch.register({
          path: SHOT_ROUTE,
          methods: ['GET', 'HEAD'],
          requestBody: 'buffered',
          fetch: (request) => serveShot(request),
        }),
        inner.connection.fetch.register({
          path: STATUS_ROUTE,
          methods: ['GET', 'POST'],
          requestBody: 'buffered',
          fetch: (request) => serveBrowserStatus(request),
        }),
        inner.connection.fetch.register({
          path: CAPABILITY_ROUTE,
          methods: ['GET', 'POST'],
          requestBody: 'buffered',
          fetch: (request) => serveCapability(request),
        }),
      ]
      return () => {
        for (const dispose of disposers.reverse()) dispose()
      }
    }, 'browser-use: routes')
  })
  // Default surface: one `browser` facade tool. The granular tools are only
  // registered when the user explicitly turns on the advanced switch, so the
  // capability panel shows one capability instead of six.
  const when = ({ agent }) => browserUseEnabled(agent) && !capabilityAdvancedFor(agent?.session?.id)
  const whenAdvanced = ({ agent }) => browserUseEnabled(agent) && capabilityAdvancedFor(agent?.session?.id)
  ctx.effect(() => {
    const disposers = [
      ctx.tools.register(
        defineTool({
          name: 'browser',
          description:
            'The conversation\'s browser (local Chrome/Edge, or a browser-pods sandbox when the pod engine is enabled). ' +
            'One tool, one action per call: ' +
            'open {url} → observe → act {act, ref} → read / evidence → session {op}. ' +
            'Observe first: refs from observe are the cheapest way to act. ' +
            'Risky actions go through user approval; passwords are never typed; certificate failures on pods return an actionable hint.',
          parameters: {
            type: 'object',
            required: ['action'],
            additionalProperties: false,
            properties: {
              action: { type: 'string', enum: ['open', 'observe', 'act', 'read', 'session', 'evidence'], description: 'What to do.' },
              url: { type: 'string', description: 'open: absolute http(s) URL.' },
              cdp_url: { type: 'string', description: 'open: attach to an existing CDP endpoint instead of launching a browser (loopback by default).' },
              mode: { type: 'string', enum: ['controls', 'text', 'ax'], description: 'observe: controls (default), text or ax.' },
              offset: { type: 'integer', description: 'observe: start offset.' },
              limit: { type: 'integer', description: 'observe/evidence: maximum entries.' },
              act: { type: 'string', enum: ['click', 'type', 'press', 'scroll', 'hover', 'select'], description: 'act: the action to perform.' },
              ref: { type: 'string', description: 'act: a ref from observe.' },
              locator: {
                type: 'object',
                additionalProperties: false,
                description: 'act: fallback target {css} or {role,name}.',
                properties: { css: { type: 'string' }, role: { type: 'string' }, name: { type: 'string' } },
              },
              text: { type: 'string', description: 'act(type): text to type.' },
              keys: { type: 'string', description: 'act(press): key, e.g. "Enter".' },
              deltaY: { type: 'integer', description: 'act(scroll): scroll delta (default 600).' },
              option: { type: 'string', description: 'act(select): option value or label.' },
              intent: { type: 'string', description: 'act: one short sentence describing the goal (used for risk grading and audit).' },
              confirm_risk: { type: 'boolean', description: 'act: accept that a high-risk action goes through user approval.' },
              query: { type: 'string', description: 'read: words to match against the page text.' },
              maxChars: { type: 'integer', description: 'read: maximum characters to return.' },
              op: { type: 'string', enum: ['status', 'tabs', 'switch', 'show', 'close', 'reset', 'pause'], description: 'session: operation.' },
              tabId: { type: 'string', description: 'session(switch): tab id from session(tabs).' },
              kind: { type: 'string', enum: ['screenshot', 'console', 'network'], description: 'evidence: what to collect (default screenshot).' },
            },
          },
          output: {
            schema: outputSchema({
              action: { type: 'string' },
              mode: { type: 'string' },
              rendered: { type: 'string' },
              url: { type: 'string' },
              title: { type: 'string' },
              pod: { type: 'object', additionalProperties: true },
            }),
            render: (_args, value) => [{ type: 'text', text: renderText(value) }],
            presentationMeta: (_args, value) => ({
              ok: value.ok !== false,
              code: value.code ?? null,
              message: value.message ?? null,
              guidance: value.guidance ?? null,
              mode: value.mode ?? null,
              url: value.url ?? null,
              title: value.title ?? null,
              pod: value.pod ?? null,
              rendered: typeof value.rendered === 'string' ? value.rendered : null,
            }),
          },
          execute: async (args, exec) => {
            const action = typeof args?.action === 'string' ? args.action : ''
            let value
            switch (action) {
              case 'open':
                value = await browserOpen(ctx, exec, { url: args.url, cdp_url: args.cdp_url })
                break
              case 'observe':
                value = await browserObserve(ctx, exec, { mode: args.mode, offset: args.offset, limit: args.limit })
                break
              case 'act':
                value = await browserAct(ctx, exec, {
                  action: args.act,
                  ref: args.ref,
                  locator: args.locator,
                  text: args.text,
                  keys: args.keys,
                  deltaY: args.deltaY,
                  option: args.option,
                  intent: args.intent,
                  confirm_risk: args.confirm_risk,
                })
                break
              case 'read':
                value = await browserRead(ctx, exec, { query: args.query, maxChars: args.maxChars })
                break
              case 'session':
                value = await browserSession(ctx, exec, { action: args.op, tabId: args.tabId })
                break
              case 'evidence':
                value = await browserEvidence(ctx, exec, { kind: args.kind, limit: args.limit })
                break
              default:
                return refusal('browser', 'invalid_args', 'action must be open, observe, act, read, session or evidence.', 'Pass one of the supported actions.')
            }
            auditBrowser(exec, 'browser', args, value)
            return value
          },
        }),
        { when },
      ),
      ctx.tools.register(
        defineTool({
          name: 'browser_open',
          description:
            'Open a page in this conversation\'s own real browser (Microsoft Edge or Google Chrome, isolated profile). Only http(s) URLs are allowed. ' +
            'At most three browsers may be open at once; browsers close after 15 minutes idle. Call browser_observe next to see the page as numbered controls.',
          parameters: {
            type: 'object',
            required: ['url'],
            additionalProperties: false,
            properties: {
              url: { type: 'string', description: 'Absolute http(s) URL to open.' },
              cdp_url: {
                type: 'string',
                description: 'Optional: attach to an existing CDP endpoint (http(s)://host:port or ws(s)://…) instead of launching a browser. Loopback only unless DSH_BROWSER_ALLOW_REMOTE_CDP=1.',
              },
            },
          },
          output: {
            schema: outputSchema({ url: { type: 'string' }, title: { type: 'string' }, targetId: { type: 'string' }, instances: { type: 'integer' } }),
            render: (_args, value) => [{ type: 'text', text: renderText(value) }],
            presentationMeta: (_args, value) => ({
              ok: value.ok !== false,
              code: value.code ?? null,
              message: value.message ?? null,
              guidance: value.guidance ?? null,
              url: value.url ?? null,
              title: value.title ?? null,
              rendered: typeof value.rendered === 'string' ? value.rendered : null,
            }),
          },
          execute: async (args, exec) => {
            const value = await browserOpen(pluginContext, exec, args)
            auditBrowser(exec, 'browser_open', args, value)
            return value
          },
        }),
        { when: whenAdvanced },
      ),
      ctx.tools.register(
        defineTool({
          name: 'browser_observe',
          description:
            'Observe the current page as a numbered list of visible interactive controls ([ref] role "name"), plus URL/title and a short text excerpt. ' +
            'Refs are the cheapest way to act: pass one to browser_act. Modes: controls (default), text (plain text only), ax (accessibility tree, read-only). ' +
            'Observe again after any action that changes the page.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              mode: { type: 'string', enum: ['controls', 'text', 'ax'], description: 'Observation mode; controls is the default.' },
              offset: { type: 'integer', description: 'Start index: control index in controls mode, character offset in text mode (default 0).' },
              limit: { type: 'integer', description: 'Maximum controls per page, 1-200 (default 60).' },
            },
          },
          output: {
            schema: outputSchema({
              rendered: { type: 'string' },
              url: { type: 'string' },
              title: { type: 'string' },
              chars: { type: 'integer' },
              total: { type: 'integer' },
              offset: { type: 'integer' },
              limit: { type: 'integer' },
              hasMore: { type: 'boolean' },
              nextOffset: { type: 'integer' },
              textTotal: { type: 'integer' },
            }),
            render: (_args, value) => [{ type: 'text', text: renderText(value) }],
            presentationMeta: (_args, value) => ({
              ok: value.ok !== false,
              code: value.code ?? null,
              message: value.message ?? null,
              guidance: value.guidance ?? null,
              url: value.url ?? null,
              title: value.title ?? null,
              controls: Array.isArray(value.controls) ? value.controls.length : null,
              total: Number.isFinite(value.total) ? value.total : null,
              nextOffset: Number.isFinite(value.nextOffset) ? value.nextOffset : null,
              rendered: typeof value.rendered === 'string' ? value.rendered : null,
            }),
          },
          execute: async (args, exec) => browserObserve(pluginContext, exec, args),
        }),
        { when: whenAdvanced },
      ),
      ctx.tools.register(
        defineTool({
          name: 'browser_act',
          description:
            'Perform one browser action against a ref from the latest browser_observe (or a locator). Actions: click, type, press, scroll, hover, select. ' +
            'Requires an observation within 120 seconds. Ambiguous targets are refused instead of guessed. Password fields are never typed into. ' +
            'Destructive, financial or send-like targets require confirm_risk:true and go through user approval (which fails closed when the session disables approval prompts). ' +
            'The result reports a light diff (url/title/controls added and removed) so you can decide whether to observe again.',
          parameters: {
            type: 'object',
            required: ['action'],
            additionalProperties: false,
            properties: {
              action: { type: 'string', enum: ['click', 'type', 'press', 'scroll', 'hover', 'select'], description: 'What to do.' },
              ref: { type: 'string', description: 'A ref from browser_observe, e.g. "r3". Preferred over a locator.' },
              locator: {
                type: 'object',
                additionalProperties: false,
                description: 'Fallback target: {css} or {role,name}. Ambiguous matches are refused.',
                properties: { css: { type: 'string' }, role: { type: 'string' }, name: { type: 'string' } },
              },
              text: { type: 'string', description: 'Text for the type action (clears the field first).' },
              keys: { type: 'string', description: 'Key for press, e.g. "Enter", "Tab", "Control+a".' },
              deltaY: { type: 'integer', description: 'Scroll delta for scroll (default 600; negative scrolls up).' },
              option: { type: 'string', description: 'Option value or label for select.' },
              intent: { type: 'string', description: 'One short sentence describing the goal; used for risk grading and the audit trail.' },
              confirm_risk: { type: 'boolean', description: 'Accept that a high-risk action goes through user approval.' },
            },
          },
          output: {
            schema: outputSchema({
              action: { type: 'string' },
              target: { type: 'string' },
              changed: { type: 'object', additionalProperties: true },
              elapsedMs: { type: 'integer' },
            }),
            render: (_args, value) => [{ type: 'text', text: renderText(value) }],
            presentationMeta: (_args, value) => ({
              ok: value.ok !== false,
              code: value.code ?? null,
              message: value.message ?? null,
              guidance: value.guidance ?? null,
              action: value.action ?? null,
              target: value.target ?? null,
              changed: value.changed ?? null,
              highlighted: value.highlighted === true,
              evidence: value.evidence ?? null,
              rendered: typeof value.rendered === 'string' ? value.rendered : null,
            }),
          },
          execute: async (args, exec) => {
            const value = await browserAct(pluginContext, exec, args)
            auditBrowser(exec, 'browser_act', args, value)
            return value
          },
        }),
        { when: whenAdvanced },
      ),
      ctx.tools.register(
        defineTool({
          name: 'browser_read',
          description:
            'Answer a question from the current page: returns the matching paragraphs as Markdown instead of dumping the DOM. ' +
            'Use it when you need content rather than controls. Quote the URL when you rely on the result.',
          parameters: {
            type: 'object',
            required: ['query'],
            additionalProperties: false,
            properties: {
              query: { type: 'string', description: 'Words to match against the page text.' },
              maxChars: { type: 'integer', description: 'Maximum characters to return (400-20000, default 8000).' },
            },
          },
          output: {
            schema: outputSchema({
              rendered: { type: 'string' },
              url: { type: 'string' },
              title: { type: 'string' },
              matched: { type: 'integer' },
              chars: { type: 'integer' },
              truncated: { type: 'boolean' },
            }),
            render: (_args, value) => [{ type: 'text', text: renderText(value) }],
            presentationMeta: (_args, value) => ({
              ok: value.ok !== false,
              code: value.code ?? null,
              message: value.message ?? null,
              guidance: value.guidance ?? null,
              url: value.url ?? null,
              title: value.title ?? null,
              chars: value.chars ?? null,
              rendered: typeof value.rendered === 'string' ? value.rendered : null,
            }),
          },
          execute: async (args, exec) => browserRead(pluginContext, exec, args),
        }),
        { when: whenAdvanced },
      ),
      ctx.tools.register(
        defineTool({
          name: 'browser_session',
          description:
            'Inspect or manage this conversation\'s browser. Actions: status (instances, tabs, urls, idle time, pause state), tabs (list page tabs with tabId), ' +
            'switch (attach to one tabId), show (bring the window to the front so the user can take over), pause (emergency stop: blocks every browser tool until the user resumes), ' +
            'close (close this conversation\'s browser), reset (close it; the next browser_open starts fresh). The model cannot resume a pause.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              action: { type: 'string', enum: ['status', 'tabs', 'switch', 'show', 'pause', 'close', 'reset'], description: 'Defaults to status.' },
              tabId: { type: 'string', description: 'Target tab id for switch (from action=tabs).' },
            },
          },
          output: {
            schema: outputSchema({
              rendered: { type: 'string' },
              instances: { type: 'integer' },
              tabs: { type: 'array', items: { type: 'object', additionalProperties: true } },
              tabId: { type: 'string' },
            }),
            render: (_args, value) => [{ type: 'text', text: renderText(value) }],
            presentationMeta: (_args, value) => ({
              ok: value.ok !== false,
              code: value.code ?? null,
              message: value.message ?? null,
              guidance: value.guidance ?? null,
              action: value.action ?? null,
              url: value.url ?? null,
              title: value.title ?? null,
              instances: value.instances ?? null,
              rendered: typeof value.rendered === 'string' ? value.rendered : null,
            }),
          },
          execute: async (args, exec) => browserSession(pluginContext, exec, args),
        }),
        { when: whenAdvanced },
      ),
      ctx.tools.register(
        defineTool({
          name: 'browser_evidence',
          description:
            'Collect evidence from the current page. kind=screenshot (default) captures a PNG and returns its path (served to the UI); ' +
            'kind=console returns buffered console output and exceptions; kind=network returns recent requests with status/failure. ' +
            'Use limit to cap the number of entries (1-200, default 50).',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', enum: ['screenshot', 'console', 'network'], description: 'Evidence kind; screenshot is the default.' },
              limit: { type: 'integer', description: 'Maximum entries for console/network (1-200, default 50).' },
            },
          },
          output: {
            schema: outputSchema({
              kind: { type: 'string' },
              path: { type: 'string' },
              width: { type: 'integer' },
              height: { type: 'integer' },
              url: { type: 'string' },
              title: { type: 'string' },
              entries: { type: 'array', items: { type: 'object', additionalProperties: true } },
              rendered: { type: 'string' },
            }),
            render: (_args, value) => [{ type: 'text', text: renderText(value) }],
            presentationMeta: (_args, value) => ({
              ok: value.ok !== false,
              code: value.code ?? null,
              message: value.message ?? null,
              guidance: value.guidance ?? null,
              kind: value.kind ?? null,
              path: value.path ?? null,
              url: value.url ?? null,
              title: value.title ?? null,
              rendered: typeof value.rendered === 'string' ? value.rendered : null,
            }),
          },
          execute: async (args, exec) => {
            const value = await browserEvidence(pluginContext, exec, args)
            auditBrowser(exec, 'browser_evidence', args, value)
            return value
          },
        }),
        { when: whenAdvanced },
      ),
    ]
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  }, 'browser-use: tools')
  ctx.effect(() => {
    const timer = setInterval(() => {
      for (const [sessionId, instance] of instances) {
        if (Date.now() - instance.lastUsedAt <= IDLE_CLOSE_MS) continue
        const podId = instance.pod?.id && instance.pod.keep !== true ? instance.pod.id : ''
        void instance
          .close()
          .then(() => (podId ? closePodBestEffort(podId, 'idle timeout') : undefined))
          .catch(() => {})
        instances.delete(sessionId)
      }
    }, IDLE_SWEEP_MS)
    return () => {
      clearInterval(timer)
      for (const instance of [...instances.values()]) {
        void instance.close().catch(() => {})
      }
      instances.clear()
    }
  }, 'browser-use: lifecycle')
}
