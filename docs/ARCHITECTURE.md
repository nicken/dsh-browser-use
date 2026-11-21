# Architecture

This repository contains two browser-control implementations that share a tool contract but not a
codebase:

- **`dsh-browser-use`** (repository root) — a DeepSeek Harness (DSH) plugin. It already runs inside
  the DSH host, so it contributes the *observation model, the safety layer and the UI*.
- **`browser-pods`** (`mcp/`) — a standalone MCP server. It owns *process supervision, isolation,
  live viewing and recording*, and is usable from any MCP client.

The intended division of labour is analysed in [POSITIONING.md](POSITIONING.md); this document
describes how each side is actually built.

```text
┌──────────────────────────────── DSH session ────────────────────────────────┐
│  agent                                                                      │
│    │ DSH tool calls / Web UI                                                │
│    ▼                                                                        │
│  dsh-browser-use (index.js + client.js)                                     │
│    ├─ capability gate (capability-toggles.json)                             │
│    ├─ safety layer (URL policy, risk grading, approvals, pause)             │
│    ├─ observation/ref model and one-action diffs                            │
│    ├─ routes: /api/browser-use/{status,capability,shot}                     │
│    └─ CDP client ────────────── WebSocket ──────────────┐                   │
│                                                          ▼                  │
│                                          local Edge/Chrome (isolated        │
│                                          per-session profile, visible)      │
└─────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────── browser-pods (Docker) ──────────────────────────┐
│  MCP client ── streamable HTTP ──► :8787/mcp                                │
│                                     │                                       │
│  control plane :8787 ── dashboard, REST, artifact download, MCP audit       │
│                                     │                                       │
│  pod-N: Xvfb :10x ─ openbox ─ Chromium (Playwright) ─ x11vnc :59xx          │
│                                     └─ websockify/noVNC :608x               │
│         profile dir, downloads dir, artifacts dir (video + trace)           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Part 1 — The DSH plugin

The plugin is split into a Host half (`index.js`, ESM, no runtime dependencies) and a Web client
half (`client.js`, loaded by the DSH Web module loader). State that gates tools lives on the Host;
the client only renders and calls authenticated same-origin routes.

### 1.1 Host entry and tool registration

`index.js` exports `name = 'browser-use'`, `inject = ['tools']`, and `apply(ctx)`.
The bundle patch `cordis.patch.yml` inserts one row:

```yaml
- insert:
    - id: browser-use
      name: 'dsh-browser-use'
```

Inside `apply`:

1. `ctx.inject(['connection'], …)` registers the three HTTP routes inside an effect, so they are
   torn down with the plugin.
2. A second effect registers the six tools with `ctx.tools.register(def, { when })`. The `when`
   predicate is `({ agent }) => browserUseEnabled(agent)`, i.e. the tools are invisible unless the
   current Session's `browserUse` flag is `true` in `~/.dsh/capability-toggles.json`.
3. A third effect owns the idle sweeper and closes every instance when the plugin is disposed.

Every tool definition carries a parameter schema (`additionalProperties: false`), an output schema
(`additionalProperties: true`, `required: ['ok']`), a `render` function returning text for the model,
and a `presentationMeta` object consumed by the Web client's tool cards. Refusals are normal
successful tool calls whose value is `{ ok: false, code, message, guidance }`; the renderer turns
that into `REFUSED [<code>]: <message>` plus guidance.

### 1.2 CDP client

`CdpClient` is a minimal Chrome DevTools Protocol client over the runtime's global `WebSocket`:

- One socket per browser process, opened to the `webSocketPath` read from the profile's
  `DevToolsActivePort` file.
- Requests are multiplexed by a monotonically increasing `id`; each pending request has a 20 s
  timeout. Responses and events are dispatched by `id`/`method`.
- `flatten: true` target attachment gives each page a `sessionId`; every page-level command is sent
  with that `sessionId`.
- Event listeners receive `(method, params, sessionId)`; the instance filters page events to its
  current page session.
- Socket close rejects every pending request and notifies listeners (`'close'`).

The client does not interpret protocol errors beyond rejecting with the CDP error message.

### 1.3 Browser instance lifecycle

`instances` is a module-level `Map<sessionId, BrowserInstance>`. One instance per conversation,
created on demand by `browser_open`; there is no separate "attach" input in the plugin yet.

Startup (`BrowserInstance.start`):

1. Compute `$DSH_HOME/browser-use/profiles/<sessionId>` and remove stale `DevToolsActivePort`,
   `SingletonLock`, `SingletonCookie`, `SingletonSocket` left by a previous crash.
2. Resolve the executable: `DSH_BROWSER_PATH`, then Edge/Chrome under `ProgramFiles` and
   `ProgramFiles(x86)` (Windows install locations).
3. Spawn the browser with `--remote-debugging-port=0` (OS-assigned port), the per-session
   `--user-data-dir`, no first-run/default-check/background-networking/sync/component-update,
   `--window-size=1360,900`, `--new-window`, `about:blank`. If `DSH_BROWSER_NO_SANDBOX=1`, it also
   appends `--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage` for constrained
   containers/CI. The window is visible (`windowsHide: false`) so the user can watch.
4. Poll `DevToolsActivePort` up to 120 × 150 ms, parse port + WebSocket path, then retry the
   WebSocket handshake up to 5 times (300 ms apart).
5. Attach to the first `page` target, or create one with `Target.createTarget`, using
   `Target.attachToTarget({ flatten: true })`.
6. Enable `Page`, `Runtime`, `Log`, `Network`, plus
   `Emulation.setFocusEmulationEnabled({ enabled: true })` so synthetic input is not throttled when
   another OS window has focus.

Instance limits and reclamation are module constants: `MAX_INSTANCES = 3`, `IDLE_CLOSE_MS = 15 min`,
`IDLE_SWEEP_MS = 60 s`. `instanceFor(sessionId, { create })` returns the existing live instance,
creates one if allowed, or returns `{ error: 'too_many_instances' }` when the pool is full. The
sweeper closes instances whose `lastUsedAt` is older than 15 minutes; `lastUsedAt` is refreshed by
tool calls that go through `instanceFor` (open/observe/act/read/evidence) and by `tabs`/`switch`/
`show`, but not by `status`/`pause`.

`close()` sends `Browser.close` (best effort), closes the socket, kills the child if still running,
and removes the map entry. Reopening the same conversation reuses the same profile directory, so
cookies survive a close/reopen of that conversation's browser.

### 1.4 Page binding and evidence buffers

Per instance:

- `targetId` is the attached page target; `pageSession` is its flattened CDP session.
- `consoleBuffer` (max 200) collects `Runtime.consoleAPICalled` (level/text) and
  `Runtime.exceptionThrown` (level `exception`).
- `networkBuffer` (max 200) and `networkById` track `Network.requestWillBeSent`,
  `Network.responseReceived` and `Network.loadingFailed` (status, MIME type, failure text).
- `browser_session action=tabs` lists page targets via `Target.getTargets`;
  `switch` re-attaches with `attachTarget` and accepts an exact target id or a unique prefix of at
  least six characters.

### 1.5 Observation model and refs

`browser_observe` runs one page expression (`OBSERVE_EXPRESSION`) that:

1. Selects interactive elements: `a[href]`, `button`, `input`, `select`, `textarea`,
   `[role=button|link|checkbox|radio|tab|menuitem|switch]`, `[contenteditable=true]`, `summary`,
   `[onclick]`.
2. Filters to visible elements (rect > 2×2, not `visibility:hidden`, not `display:none`, opacity >
   0.05).
3. Assigns a numbered ref `r1`, `r2`, … in DOM order, writing `data-dsh-ref` on the element, capped
   at 200 controls.
4. Derives `role` (explicit `role`, else tag/input-type mapping) and `name` (aria-label, title,
   placeholder, innerText, alt, name, value; whitespace-collapsed, 120 chars).
5. Reports `type`, `disabled`, `valueLength` (`-1` for password fields), `checked` and `selection`
   without exposing values.
6. Returns URL, title, readyState, controls, total count, and body text (normalised, up to 40,000
   characters).

Modes:

| Mode | Returns | Notes |
|---|---|---|
| `controls` (default) | Paged ref list plus URL/title and a 1,200-character text excerpt | `limit` default 60, max 200 |
| `text` | Plain text pages | Character paging, 4,000 characters per call |
| `ax` | Accessibility tree nodes with refs `ax1…` | Read-only: `ax` refs are **not** actionable |

Each observation updates `lastObservationAt`, `lastObservationUrl` and increments `domVersion`, and
diffs the control set against the previous observation: added refs, removed refs and per-ref changes
in `name`, `disabled`, `type`, `valueLength`, `checked`, `selection`. `browser_observe` returns a
rendered `[ref] role "name"` list, which is the low-token path (about 200–450 tokens for a typical
page).

`browser_act` requires `now - lastObservationAt <= 120 s` (`OBSERVATION_TTL_MS`), otherwise it
returns `observe_required`. A successful action also diffs the page (`captureChanged`), but does not
extend the observation TTL.

### 1.6 Target resolution

`resolveTargetExpression` resolves, in priority order:

1. `{ ref }` → `[data-dsh-ref="<ref>"]`.
2. `{ css }` → `querySelectorAll(css)`, filtered to visible elements.
3. `{ role, text }` → visible interactive controls matching the role and a case-insensitive
   exact-or-substring name match.

It scrolls the match into view and returns `matchCount`, ref, role, name, tag, type, disabled,
bounding rect, href, `download` attribute and visibility. The action layer refuses:

- `matchCount === 0` → `stale_ref`, guidance to observe again;
- `matchCount > 1` → `ambiguous_target`, guidance to use a ref instead of a broad locator;
- disabled target → `invalid_args`.

### 1.7 Actions and diff

`browser_act` supports exactly one action per call: `click`, `type`, `press`, `scroll`, `hover`,
`select`.

| Action | Implementation |
|---|---|
| `click` / `hover` | `Input.dispatchMouseEvent` at the centre of the resolved rect (`mouseMoved`, optionally `mousePressed`/`mouseReleased` with left button) |
| `type` | Focus and clear via page JS, then `Input.insertText` (clears the field first; `text` is required) |
| `press` | `Input.dispatchKeyEvent` keyDown/keyUp from a `Control+a`-style chord parser with a special-key table (Enter, Tab, Escape, Backspace, Delete, arrows, Space, PageUp/Down, Home, End) |
| `scroll` | `Input.dispatchMouseEvent` wheel at (640, 450), `deltaY` default 600 |
| `select` | Page JS sets the `<select>` value and dispatches `input` + `change` |

The page is brought to the front before dispatching (`Page.bringToFront`) because Chromium throttles
synthetic input for occluded pages. After a 250 ms settle, the instance re-reads URL/title and the
control set and returns `{ action, target, changed: { url, title, domVersion, added, removed,
addedControls, removedControls, modifiedControls }, elapsedMs }`.

### 1.8 Deterministic safety layer

Everything below is code, not prompt advice:

| Control | Behaviour | Refusal code(s) |
|---|---|---|
| URL admission | Only absolute `http:`/`https:` URLs; policy file `allowedDomains`/`blockedDomains` are case-insensitive regex lists | `invalid_url`, `domain_blocked` |
| Risk grading | `risk` words in `intent`, target name/role/tag, or financial terms grade an action `high`; file-download targets are also high | `risk_approval_required` |
| Approval | `confirm_risk: true` plus the DSH `approval` seam (`allowed-once` proceeds); missing seam or failed request fails closed, `never` policy rejects | `risk_denied`, `risk_unavailable` |
| Password fields | Typing into `input[type=password]` is always refused | `password_target` |
| File upload | Clicking a file input is refused; the window is raised, the field highlighted and a screenshot returned | `upload_blocked` |
| Dangerous downloads | Links matching `.exe/.msi/.bat/.cmd/.ps1/.vbs/.apk/.dmg/.iso/.scr/.jar` (and similar) are refused with highlight + screenshot | `download_blocked` |
| Downloadable documents | `.zip/.rar/.7z/.pdf/.doc(x)/.xls(x)/.ppt(x)/.csv/.txt/.png/.jpg/.gif/.mp4/.mp3` are graded high risk and need approval | `risk_approval_required` |
| DSH UI guard | The page is identified before acting (`__DSH_BOOT__`, or title matching "DeepSeek Harness" on `/` or `/index.html`); the DSH shell is user-only | `dsh_ui_blocked` |
| Unverifiable page | If the page identity cannot be read, the action fails closed | `page_unverifiable` |
| Pause | `pause.json` blocks open/observe/act/read; the model may pause but has no resume path | `paused` |
| User visibility | High-risk actions outline the target and show an in-page label for 3 s, then capture a screenshot for the approval; upload/download handoffs highlight for 8 s | (carried as `highlighted` / `evidence`) |

Risk grading reads the policy file on every call, so operator edits apply to subsequent actions
without restarting the plugin. `riskyIntentReplace` can replace the built-in risky-verb regex.
`admitUrl` is used by `browser_open`; navigation caused by a click is **not** re-admitted through
the policy (see SECURITY for the consequence).

`requestApproval` calls `approval.request({ agent, toolName: 'browser_act', callId, reason, signal })`
and interprets `allowed-once` as success. When the outcome is not allowed, the error text explains
whether the user rejected it, the request was cancelled, the seam was unavailable, or the session
policy is `never`.

### 1.9 Persistence and audit

All plugin state is under `$DSH_HOME` (`~/.dsh` by default):

| File/dir | Written by | Content |
|---|---|---|
| `browser-use/profiles/<sessionId>/` | Chromium | Per-session `user-data-dir`; persists until the user removes it |
| `browser-use/policy.json` | Operator (not the tools) | `{ allowedDomains?: string[], blockedDomains?: string[], riskyIntentReplace?: string[] }` |
| `browser-use/pause.json` | User route / `browser_session action=pause` | `{ paused: true, reason, at, by }`; deletion resumes |
| `browser-use/audit.jsonl` | `browser_open`, `browser_act`, `browser_evidence` | One JSON object per attempt: timestamp, session id, tool, action, target, URL, ok/code, input text **length only**, risk |
| `browser-use/shots/` | Screenshots/evidence/approval | PNGs named `browser-<timestamp>.png`, 40 most recent kept |
| `capability-toggles.json` | Capability route | Shared, versioned store `{ version: 1, sessions: { "<id>": { browserUse: bool, … } } }`; writes are temp-file + rename |

Audit writes never fail the browser action (all exceptions are swallowed). The audit file is
append-only from the plugin's point of view and is not rotated by the plugin.

### 1.10 Capability switch

`browserUseEnabled(agent)` reads the session id and the shared store; anything other than
`browserUse === true` means disabled. The capability route does a read-modify-write that preserves
other sessions and other fields in the same session record:

- `GET /api/browser-use/capability?sessionId=…` → `{ enabled }`
- `POST /api/browser-use/capability` `{ sessionId, enabled }` → `{ enabled }`

Because tools are registered behind `when`, a saved value is picked up on the next step, which the
UI communicates as "applies on the next step". The store is a plain file: any process that can write
it can enable the capability, so it is a UX/consent control, not a security boundary.

### 1.11 HTTP routes

Registered through the DSH `connection.fetch` seam (same-origin, authenticated by the host):

| Route | Methods | Purpose |
|---|---|---|
| `/api/browser-use/status` | GET, POST | GET: pause state, instances (URL/title/tabs/idle/current), last 20 audit entries, provider report. POST: `{action: "pause"｜"resume"｜"close", reason?, sessionId?}` |
| `/api/browser-use/capability` | GET, POST | Read/write the per-session switch |
| `/api/browser-use/shot` | GET, HEAD | Serve a screenshot by basename; filename must match `^[A-Za-z0-9._-]+\.png$`; `no-store` |

Responses use `{ ok: true, value }` / `{ ok: false, error: { message } }` envelopes. The status route
is what the composer chip and the Browser tab poll (every 10 s).

### 1.12 Web client

`client.js` is a DSH Web client module loaded via `window.__ModuleLoader__` with id
`dsh-browser-use`. It registers, all under its own locale namespace `browserUse`:

- **Six tool views** on `tool.call.toolview` (`browser_open`, `browser_observe`, `browser_act`,
  `browser_read`, `browser_session`, `browser_evidence`) — cards driven entirely by the Host's
  `presentationMeta`; refusal cards show code/message/guidance, screenshot evidence is served from
  `/api/browser-use/shot`.
- **A conversation tab** on `conversation.view` (`id: browser-use`, order 21) containing the
  per-session switch at the top, the browser pool (URL/title/tabs/idle, close button), pause/resume,
  and the recent audit with "this session / all" filters.
- **A composer status chip** on `conversation.input.left` (order 41), visible only while at least one
  browser is open or browser control is paused; its button pauses/resumes.

Locale dictionaries are inlined in `client.js`; `locale/en.json` and `locale/zh.json` carry the
bundle's display metadata for DSH.

### 1.13 Coexistence with other browser plugins

The plugin never registers the optional `browserUse` provider seam; it drives its own Chromium and
keeps its tools self-contained. `browserProviderReport()` reports `{ slot, registered: false,
serviceMounted, competing }`, where `competing` is the enabled plugin list filtered by a
browser-plugin name regex (`pluginManager` rows, cached for 15 s). This is a report, not an
enforcement mechanism.

---

## Part 2 — browser-pods (MCP server)

### 2.1 Process and port topology

A pod is the unit of isolation: one Xvfb display, one Chromium process/context, one profile
directory, one downloads directory, one artifacts directory, one x11vnc + websockify pair.

Ports are derived from the pod's slot `s` (1-based) and the configured bases:

| Resource | Formula | Default for slot 1 |
|---|---|---|
| X display | `DISPLAY_BASE + s` | `:102` |
| x11vnc | `VNC_PORT_BASE + s` | `5902` |
| noVNC (websockify) | `VIEW_PORT_BASE + s` | `6082` |
| CDP | `CDP_PORT_BASE + s - 1` | `9223` |

`docker compose` runs the container with `network_mode: host`, so these ports are host-local
services; `LISTEN_HOST`, `VNC_LISTEN_HOST` and `PUBLIC_HOST` decide what is reachable and what
appears in generated URLs. Defaults keep everything on `127.0.0.1`.

### 2.2 Pod model and lifecycle

`pods.mjs` keeps `pods: Map<id, pod>`, `slotOwner: Map<slot, id>`, `profileLocks: Map<profileKey, id>`
and `allProcs: Set<child>`. Pod ids are `pod-<slot>-<random>` (external attachments are
`ext-<random>`).

`createPod`:

1. Rejects when shutting down or at `PODS_MAX`, and when the requested `profile` is locked by
   another pod.
2. Allocates the first free slot and computes directories and ports.
3. Creates `profileDir`, `downloads/`, `artifacts/<id>/`, ensures `/tmp/.X11-unix` exists.
4. Starts `Xvfb <display> -screen 0 <SCREEN_SIZE> -nolisten tcp -ac -extension GLX` and waits for
   the X socket.
5. If `VNC_ENABLED=1`: starts `x11vnc -localhost -nopw -forever -shared -quiet -noxdamage …`, then
   `websockify --web <NOVNC_WEB> <host:viewPort> 127.0.0.1:<vncPort>` (falls back to listening on
   all addresses if the installed websockify rejects the explicit host).
6. Starts `openbox` as a lightweight window manager and waits briefly.
7. Writes Chromium `Preferences` once (translate and password-manager UI disabled).
8. Launches Chromium with Playwright `chromium.launchPersistentContext(profileDir, …)`:
   headed, viewport, `locale: zh-CN`, configured timezone, downloads accepted into the pod directory,
   `ignoreHTTPSErrors` from the pod's certificate setting, `recordVideo` when enabled,
   `DISPLAY` pointing at the pod's Xvfb, and CDP on `--remote-debugging-port=<pod.cdpPort>`.
   `--no-sandbox` is added only when the process runs as root.
9. Binds page events, starts Playwright tracing when enabled, marks the pod `ready`, sets
   `expiresAt` from `ttl_minutes` or `POD_IDLE_TTL_MIN`, and records events.

On failure the pod is destroyed immediately, so no half-started process remains.

`destroyPod` (close, idle sweep, shutdown, failed creation):

1. Capture `page.video()` handles before the context closes.
2. Stop tracing to `artifacts/<id>/trace.zip` (20 s cap).
3. Close the Playwright context (6 s cap).
4. Finalize artifacts (see 2.7).
5. Stop openbox, websockify, x11vnc, Xvfb (SIGTERM, then SIGKILL after 2.5 s).
6. Delete the pod, release its slot and profile lock; delete the pod directory for anonymous
   profiles, and named profiles too unless `KEEP_PROFILES=1`.

Idle reclamation: `startSweeper()` runs every 15 s when `POD_IDLE_TTL_MIN > 0`, and destroys pods
that are `ready` and whose `lastUsedAt` is older than the TTL. Any tool call through `getPod`/`run`
refreshes `lastUsedAt`, and `recordEvent` also refreshes it; a pod being operated on is therefore
not reclaimed.

### 2.3 Profiles

- No `profile` argument → profile directory inside the pod directory, deleted on close.
- `profile: "shop"` → `data/profiles/shop` (sanitised), reused across sessions to keep login state;
  only one live pod may hold a named profile at a time. Named profiles are kept when
  `KEEP_PROFILES=1` (the default).
- External browsers (`cdp_url`) use the remote browser's profile; the pod only stores artifacts.

### 2.4 Playwright layer

The MCP server uses Playwright (pinned in `mcp/package.json`) for:

- launching the persistent context (`launchPersistentContext`),
- page driving (navigate/snapshot/click/type/press/eval/wait/text/screenshot),
- accessibility snapshots (`page.ariaSnapshot` / `locator.ariaSnapshot`),
- console and network event capture, page error capture, URL tracking,
- context video recording and trace recording,
- `chromium.connectOverCDP(cdpUrl)` for externally launched browsers.

Within a pod, tool operations are serialised by `withPod(pod, fn)`, a promise chain per pod, so
multiple agents sharing one session cannot interleave page operations. Console logs are capped at
300 entries, network issues at 200, and pod events at 200.

### 2.5 MCP layer

`mcp.mjs` builds a fresh `McpServer` per HTTP request (required for the stateless transport):

- Server identity: `browser-pods` `0.1.0`; `instructions` are selected at runtime based on
  `MCP_DRIVER_TOOLS`.
- Error handling: every handler is wrapped by `guard`, which converts exceptions into
  `{ content: [{ type: 'text', text: '操作失败：…' }], isError: true }`.
- Input schemas are zod objects; every tool has a title and a description.
- Supply tools (always): `browser_open`, `browser_list`, `browser_close`, `browser_view`,
  `browser_artifacts`.
- Driver tools (only when `MCP_DRIVER_TOOLS=1`): `browser_navigate`, `browser_snapshot`,
  `browser_screenshot`, `browser_text`, `browser_click`, `browser_type`, `browser_press`,
  `browser_eval`, `browser_wait`, `browser_console`, `browser_network`.

Note the code default for `MCP_DRIVER_TOOLS` is `0` (supply-only); `docker-compose.yml` sets it to
`1`, which is the configuration the 16-tool documentation describes.

Certificate failures during `browser_navigate` are rewritten by `certificateHint` into an actionable
message: if the pod has certificate checking enabled, the hint suggests retrying a **new** session
with `ignore_cert_errors: true`; if it is already ignored, the hint points at an incomplete chain or
an intercepting proxy.

### 2.6 HTTP server and auth

`server.mjs` is a plain `node:http` server (no Express):

- `POST /mcp` → streamable HTTP transport, stateless (`sessionIdGenerator: undefined`), JSON
  responses (`enableJsonResponse: true`), `POST` only (405 otherwise). Each request creates a
  transport + server and closes them when the response closes. `Accept` is normalised to
  `application/json, text/event-stream` when a client omits it.
- `GET /healthz` → counts (pods/max/instance) and uptime. Public (container healthcheck).
- `MCP_TOKEN` check → applies to `/mcp` and everything below; only `/healthz` is handled before
  the check.
- `GET /` → dashboard; `GET /demo` → a small built-in demo page; `GET /favicon.ico` → 204.
- REST: `GET/POST /api/pods`, `DELETE /api/pods/:id`, `POST /api/gc`, `GET /api/sessions`,
  `GET /api/artifacts`, `GET/POST /api/artifacts/:id[/:file]` (and `POST /api/artifacts/:id/delete`),
  `GET /api/sessions/:id`, `/api/sessions/:id/events`, `/api/sessions/:id/screenshot.jpg`,
  `POST /api/sessions/:id/close`, `GET /api/config`, `GET /api/mcp-audit`.
- Artifact files are streamed with `Range` support (needed for video scrubbing); `.zip` is served
  with `content-disposition: attachment`.
- Request bodies are limited to 32 MiB; `server.requestTimeout = 0` (long tool calls);
  `headersTimeout = 65 s`.
- MCP calls are audited in memory (last 100 entries: initialize client info, tools/call name, other
  methods).

`MCP_TOKEN` is deliberately simple: a constant string compared with `Bearer <token>`. It gates
`/mcp`, the dashboard and `/api/*`; `/healthz` stays public for health checks. The token travels
in plaintext unless a TLS proxy terminates in front, so network placement remains the real access
control.

### 2.7 Artifacts and replay

On close, `finalizeArtifacts` writes into `data/artifacts/<pod-id>/`:

| File | Source |
|---|---|
| `video.webm` (or `video-<n>.webm` when several pages produced videos) | Playwright `recordVideo` directory, moved out after the context closes |
| `trace.zip` | Playwright tracing with screenshots, DOM snapshots and sources |
| `meta.json` | id, label, owner, profile, start/end, duration, close reason, last URL, operation/screenshot counts, video/trace presence, last 30 console errors, last 30 network issues, last 80 events |

`pruneArtifacts` keeps the newest `ARTIFACTS_KEEP` directories (compose: 20, code default: 50) by
directory mtime and deletes older ones. `browser_artifacts` and the dashboard expose the archives;
traces can be opened with `npx playwright show-trace <file>` or on `trace.playwright.dev`.

### 2.8 Dashboard

`dashboard.html` is a static page served by the control plane. It polls:

- `/api/sessions` every 2 s for cards (label/owner/profile, state, URL, title, age, operation and
  screenshot counts, last six events) and refreshes each card's JPEG thumbnail every 4 s via
  `/api/sessions/:id/screenshot.jpg`;
- `/api/artifacts` every 8 s for the replay grid (embedded `video` element, artifact sizes,
  download links, copy-`show-trace` button, delete button);
- `/api/config` once for the MCP endpoint and pod limit.

Card actions: open noVNC live view, refresh thumbnail, close session. Session close and artifact
deletion are `POST` requests.

### 2.9 Shutdown and multi-instance operation

`SIGTERM`/`SIGINT` trigger `shutdownAll()`: destroy every pod (archiving artifacts) and kill any
remaining child processes, then close the HTTP server (with a 3 s fallback exit). `tini` is the
container entrypoint, so signals are forwarded.

`scripts/scale.sh start N` runs N independent containers from the same image with disjoint port
ranges (`8786+i` HTTP, `100+20i+slot` displays, `5900+20i+slot` VNC, `6080+20i+slot` noVNC,
`9222+20i+slot-1` CDP) and separate `data/instance-<i>` directories. It refuses to start while the
compose single instance occupies `:8787`.

### 2.10 External browsers

`browser_open({ cdp_url })` attaches to a browser started elsewhere:

- The URL must be `http(s)`; a duplicate `cdp_url` reuses the existing attach session.
- `chromium.connectOverCDP(cdpUrl)` is used; the first context is adopted, page events are bound,
  and tracing starts if enabled.
- `browser_close` on an external session only stops tracing, finalizes artifacts and disconnects
  (`browser_still_running: true`); it never kills the remote browser.
- Certificate policy belongs to the external browser process; `describePod` reports
  `ignore_cert_errors: false` and `mode: "external"`.

---

## Part 3 — How the two fit together

Both sides implement the same four-step loop; the names differ because the transports differ.

| Step | Plugin | browser-pods |
|---|---|---|
| Open | `browser_open` | `browser_open` |
| Observe | `browser_observe` (numbered refs, text, AX) | `browser_snapshot` (accessibility YAML), `browser_text` |
| Act | `browser_act` (one action + diff) | `browser_navigate` / `browser_click` / `browser_type` / `browser_press` / `browser_eval` / `browser_wait` |
| Evidence | `browser_read`, `browser_evidence` | `browser_screenshot`, `browser_console`, `browser_network`, `browser_artifacts` |
| Close | `browser_session action=close` | `browser_close` |

The plugin deliberately does not implement process supervision, recording or remote access; the pod
deliberately does not implement approval, refs or query reads. The planned composition is "pod as the
body, plugin as the brain": the pod exposes `cdp_url`, and the plugin's CDP client only needs a
WebSocket endpoint and a page target. That attach mode is **not implemented yet** — see
[POSITIONING.md](POSITIONING.md) for the intended contract and the constraints (do not spawn a local
browser, detach rather than kill, inherit the pod's certificate policy, surface `live_view_url`).

## Design decisions

- **Why CDP directly in the plugin:** the plugin already runs next to DSH; a CDP client keeps it
  dependency-free, small, and able to attach to any Chromium exposing CDP. Playwright would add a
  large dependency and a second browser lifecycle to manage.
- **Why the observation layer is separate from the driver:** refs and query reads are the token-cost
  control. The driver stays deliberately dumb; all "what does the model see" logic lives in one
  expression and one diff function.
- **Why a deterministic safety layer:** approval prompts and prompt instructions are not sufficient
  controls for a model reading untrusted pages. URL admission, password refusal, upload/download
  handoff and the DSH-UI guard are enforced in code so a model cannot talk its way past them.
- **Why the plugin does not take the `browserUse` provider seam:** coexistence. Claiming the seam
  would make two browser plugins fight over ownership; instead the plugin reports competing plugins
  and operates its own browser.
- **Why pods are long-lived sessions:** recording and live viewing only make sense over a continuous
  session; re-creating a browser per tool call would lose the video, the trace and the page state.
  Isolation is per session, not per action.
- **Why the MCP server owns the driver:** a separate driver MCP cannot follow slot-based CDP ports
  without one instance per browser; keeping supply and driving together means one endpoint, one
  `session_id`, and no mis-targeted browser.
