# dsh-browser-use

**Agent browser control for DeepSeek Harness (DSH): a lean per-session plugin plus a self-hosted MCP browser sandbox.**

This repository ships two independent pieces that solve the same problem at different trust levels:

| | **DSH plugin** (repository root) | **browser-pods MCP server** (`mcp/`) |
|---|---|---|
| Runs | Inside the DSH host, next to the user | In a container (Xvfb + Chromium + noVNC) |
| Browser | The user's real Edge or Chrome, isolated per-session profile | Chromium in a sandboxed virtual desktop |
| Strength | Low-token observation, deterministic safety layer, approvals, zero dependencies | Isolation, live view, video/trace replay, many concurrent sessions, any MCP client |
| Transport | DSH tools + same-origin Web routes | MCP over streamable HTTP |
| Cost | Nothing extra to run | Docker and CPU/memory |

Use the **plugin** when the browser can be trusted and the agent needs to be cheap and precise.
Use a **pod** when the browser cannot be trusted, must be watched by a human, or must be replayable
afterwards. The design rationale and the intended composition are in
[docs/POSITIONING.md](docs/POSITIONING.md).

> The plugin cannot attach to a pod's `cdp_url` yet: `browser_open({ cdp_url })` is a roadmap item.
> Today, pod pages are driven by the pod's own MCP driver tools.

---

## Features

### DSH plugin

- **Zero-dependency CDP driver.** `index.js` speaks the Chrome DevTools Protocol directly over the
  runtime's global `WebSocket`; there is no Playwright or CDP library in the plugin.
- **Numbered refs, small observations.** `browser_observe` returns visible interactive controls as
  `[r1] button "Submit"` lines (about 200–450 tokens for a typical page), not a DOM dump. Refs are
  stable `data-dsh-ref` handles that `browser_act` resolves directly.
- **Query reads.** `browser_read` answers a question by returning the matching paragraphs as
  Markdown, with an 8,000-character default budget, instead of dumping the page.
- **One action per call, then a diff.** `browser_act` performs exactly one click/type/press/scroll/
  hover/select and reports URL, title and controls added/removed/modified, so the model can decide
  whether to observe again.
- **Deterministic safety layer.** Navigation is restricted to absolute `http(s)` URLs and runs
  through an operator policy file (domain allow/deny lists). Password fields are never typed into,
  file pickers and executable downloads are handed back to the user, and risky actions require
  explicit confirmation.
- **Approval with visual evidence.** High-risk actions are highlighted in the visible browser,
  snapshotted, and must pass the DSH approval service; when the session policy is `never` they fail
  closed.
- **Per-session capability switch, off by default.** Tools are registered behind a
  `when` predicate reading `~/.dsh/capability-toggles.json`; the Browser tab and the composer
  status chip expose the switch, and a saved value applies on the next step.
- **Isolated profiles, bounded pool.** One Chromium process per conversation with a per-session
  `user-data-dir`; never the user's daily profile. At most three live browsers; idle ones close
  after 15 minutes.
- **User takeover and audit.** The window is brought to the front before risky actions, `show`
  raises it on demand, and every open/act/evidence call is appended to a JSONL audit trail (typed
  text is never stored — only its length).
- **DSH-native UI.** A Browser conversation tab (pool, pause/resume, recent audit), one lightweight
  card per browser tool, and a compact status chip that appears only while a browser is open or
  paused.
- **Coexistence.** The plugin drives its own Chromium and never claims the optional `browserUse`
  provider seam, so it can live beside other browser plugins; the status route reports competing
  plugins instead of guessing.

### browser-pods MCP server

- **Per-session container isolation.** Every session gets its own Xvfb display, Chromium process,
  profile directory, ports and VNC endpoint. Windows never appear on the user's desktop.
- **Live view.** Each session has a noVNC URL for real-time watching and manual takeover, plus a
  dashboard with thumbnails, operation logs and controls.
- **Replayable sessions.** On close, the pod archives `video.webm` (the whole session) and
  `trace.zip` (Playwright trace with actions, DOM snapshots, network and screenshots), together with
  a `meta.json` describing the run.
- **Many concurrent sessions.** Slot-based allocation, `PODS_MAX` sessions per instance (default 6),
  and `scripts/scale.sh` for several instances on one machine.
- **Explicit certificate override.** TLS certificates are validated by default; a self-signed or
  internal HTTPS site can be trusted per session with `browser_open({ ignore_cert_errors: true })`,
  or for new sessions by default with `IGNORE_CERT_ERRORS=1`.
- **Supply-only or all-in-one.** With `MCP_DRIVER_TOOLS=1` the server exposes 16 tools (lifecycle +
  driving). With `0` it exposes only the 5 supply/observation tools and you drive pages through any
  CDP client. `docker compose` sets `1`.
- **Any MCP client.** One stateless streamable-HTTP endpoint at `http://127.0.0.1:8787/mcp` works
  with DSH, Claude Code, or any MCP-capable agent.

![browser-pods dashboard](mcp/docs/dashboard.png)

---

## Requirements

- **DSH plugin:** a DSH installation; Microsoft Edge or Google Chrome. Auto-detection covers the
  default Windows install locations — on other platforms, or for a non-standard install, set
  `DSH_BROWSER_PATH` to the browser executable.
- **Node.js:** >= 22 for the repository (`engines.node`); the plugin itself has no runtime npm
  dependencies, and tests use Playwright as a devDependency.
- **browser-pods:** a Linux Docker host. The image is Debian-based and runs Xvfb, x11vnc, noVNC,
  Playwright Chromium and the MCP server.

---

## Install and quick start

### 1. The DSH plugin

Install the bundle into a DSH profile:

```bash
dsh plugin --profile web add github:nicken/dsh-browser-use
```

Then enable the installed bundle in **Plugins** if DSH leaves it off (the install dialog offers
**Enable now**). The plugin is per-session and **off by default**:

1. Open a conversation.
2. Open the **Browser** tab and turn **Browser control** on (the switch at the top of the tab).
3. The saved value applies on the next step; the six `browser_*` tools become available to the
   agent.

Plugin data lives under `~/.dsh/browser-use/` (profiles, screenshots, policy, audit, pause record);
the capability switch lives in `~/.dsh/capability-toggles.json`. Override the DSH home with
`DSH_HOME` if needed.

A minimal agent loop looks like this:

```text
browser_open    { "url": "https://example.com/" }
browser_observe { "mode": "controls" }             # → [r1] link "Docs", [r2] button "Sign in", ...
browser_act     { "action": "click", "ref": "r1" } # → changed: url=..., added=..., removed=...
browser_read    { "query": "pricing" }             # → matching paragraphs as Markdown
browser_session { "action": "close" }
```

### 2. The browser-pods MCP server

```bash
cd mcp
docker compose up -d --build     # first build can take 5–10 minutes
curl -s http://127.0.0.1:8787/healthz
```

- Dashboard: <http://127.0.0.1:8787/>
- MCP endpoint: `http://127.0.0.1:8787/mcp`
- Per-session live view: returned as `live_view_url`, e.g.
  `http://127.0.0.1:6082/vnc.html?autoconnect=1&resize=remote`

Connect a DSH profile by adding an MCP entry to its `cordis.patch.yml` (tools then appear as
`mcp__browser__*`):

```yaml
- insert:
    - id: mcp-browser
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: browser
        transport: streamable-http
        url: http://127.0.0.1:8787/mcp
        failOnStartupError: false
        toolCallTimeoutMs: 120000
```

Other MCP clients can point at the same URL as a streamable-HTTP server:

```bash
# Claude Code
claude mcp add --transport http browser-pods http://127.0.0.1:8787/mcp
```

A raw JSON-RPC round trip (the endpoint is stateless and accepts POST only):

```bash
curl -sS http://127.0.0.1:8787/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

curl -sS http://127.0.0.1:8787/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"browser_open","arguments":{"label":"curl-demo","owner":"me"}}}'
```

`browser_open` returns a `session_id`, `cdp_url`, `live_view_url` and `expires_at`; pass the
`session_id` to the driver tools and finish with `browser_close` so the video and trace are archived.

There are also two end-to-end scripts once the server is running:

```bash
cd mcp
node scripts/smoke.mjs           # opens 3 browsers, drives them, closes and archives
node scripts/interact-test.mjs   # click / type / eval / snapshot round trip
```

---

## Tools

### Plugin tools (6)

| Tool | Purpose | Key arguments |
|---|---|---|
| `browser_open` | Open a page in this conversation's real browser | `url` (absolute http/https) |
| `browser_observe` | Numbered controls, plain text or accessibility tree | `mode` (`controls`, `text`, `ax`), `offset`, `limit` |
| `browser_act` | One action against a ref or locator, then a diff | `action` (`click`, `type`, `press`, `scroll`, `hover`, `select`), `ref` or `locator`, `text`, `keys`, `deltaY`, `option`, `intent`, `confirm_risk` |
| `browser_read` | Query the page text; returns matching paragraphs | `query`, `maxChars` (400–20000, default 8000) |
| `browser_session` | Inspect or manage the pool/tabs and pause | `action` (`status`, `tabs`, `switch`, `show`, `pause`, `close`, `reset`), `tabId` |
| `browser_evidence` | Screenshot, console output or network issues | `kind` (`screenshot`, `console`, `network`), `limit` |

Behaviour worth knowing:

- `browser_act` requires a recent observation (120 s) and refuses ambiguous targets rather than
  guessing. `press` and `scroll` do not need a target.
- `browser_session action=pause` is a model-initiated emergency stop. Only the user can resume it,
  from the status chip or the Browser tab. `pause` blocks opening, observing, acting and reading.
- `reset` is accepted and behaves like `close`: the next `browser_open` starts a fresh browser.

### browser-pods MCP tools (16 with driver tools enabled)

Lifecycle and observation (`MCP_DRIVER_TOOLS=0` keeps only these 5):

| Tool | Purpose | Key arguments |
|---|---|---|
| `browser_open` | Create a sandbox browser, or attach to an existing CDP endpoint | `label`, `owner`, `profile`, `ttl_minutes`, `cdp_url`, `ignore_cert_errors` |
| `browser_list` | List sessions with URL, idle time, live view and CDP address | — |
| `browser_close` | Close and archive, or detach from an external browser | `session_id`, `reason` |
| `browser_view` | Return the noVNC live-view and dashboard URLs | `session_id` |
| `browser_artifacts` | List archived video/trace runs | `session_id`, `limit` |

Page driving (`MCP_DRIVER_TOOLS=1`, the `docker compose` default):

| Tool | Purpose | Key arguments |
|---|---|---|
| `browser_navigate` | Go to a URL and wait for load | `session_id`, `url`, `wait_until`, `timeout_ms` |
| `browser_snapshot` | Accessibility-tree YAML, cheaper than a screenshot for locating elements | `session_id`, `selector` |
| `browser_click` | Click by selector, role+name or text | `session_id`, `selector`, `role`, `name`, `text`, `index`, `button` |
| `browser_type` | Clear and type text, optionally submit with Enter | `session_id`, `selector`, `role`, `name`, `text_value`, `index`, `submit` |
| `browser_press` | Press a key or chord | `session_id`, `key` |
| `browser_eval` | Evaluate a JavaScript expression in the page | `session_id`, `expression` |
| `browser_wait` | Wait for milliseconds or for an element state | `session_id`, `ms`, `selector`, `state` |
| `browser_text` | Plain text of the page or an element | `session_id`, `selector`, `max_chars` |
| `browser_screenshot` | PNG screenshot (inline image result) | `session_id`, `full_page`, `selector` |
| `browser_console` | Console output and uncaught page errors | `session_id`, `limit` |
| `browser_network` | Failed requests and HTTP 4xx/5xx responses | `session_id`, `limit` |

The full environment-variable table, lifecycle semantics and troubleshooting live in
[mcp/README.md](mcp/README.md) (Chinese) and the one-page English summary in
[mcp/README.en.md](mcp/README.en.md).

---

## Typical workflows

**Local, trusted site, low token budget** — plugin only:

1. `browser_open` the page.
2. `browser_observe` to get refs; `browser_act` one step at a time.
3. `browser_read` for content; `browser_evidence` for a screenshot or console/network evidence.
4. `browser_session action=close`.

**Untrusted content or auditable run** — browser-pods:

1. `browser_open` a pod (`label` names the run for the dashboard).
2. Drive it with the MCP driver tools, or inspect the `live_view_url` yourself.
3. `browser_close` to archive `video.webm` + `trace.zip` + `meta.json`.
4. Open the dashboard's replay section, or run `npx playwright show-trace <trace.zip>`.

**Human in the loop:** keep the local browser visible (`browser_session action=show` brings it to
the front) or watch the pod's noVNC view; risky local actions pause and highlight the target while
the approval prompt is open.

---

## Configuration

### Plugin

| Path under `~/.dsh/` | Meaning |
|---|---|
| `browser-use/profiles/<sessionId>/` | Per-session browser `user-data-dir` (never the daily profile) |
| `browser-use/policy.json` | Optional operator policy: `allowedDomains`, `blockedDomains`, `riskyIntentReplace` (arrays of case-insensitive regular-expression strings) |
| `browser-use/pause.json` | Pause record written by the user or the model; its presence blocks browser tools |
| `browser-use/audit.jsonl` | Append-only audit trail; typed text is never stored |
| `browser-use/shots/` | Screenshots kept for evidence and approval (40 most recent) |
| `capability-toggles.json` | Per-session switches shared with other capability plugins |

Environment variables read by the plugin:

| Variable | Default | Meaning |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | Base directory for all plugin state |
| `DSH_BROWSER_PATH` | — | Explicit browser executable (needed outside standard Windows install locations) |
| `DSH_BROWSER_NO_SANDBOX` | unset | `1` adds `--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage`; only for containers/CI where Chromium's sandbox cannot start. See [docs/SECURITY.md](docs/SECURITY.md) |

### browser-pods

Key variables (full table in [mcp/README.md](mcp/README.md)): `LISTEN_HOST`/`LISTEN_PORT` (default
`127.0.0.1:8787`), `PUBLIC_HOST`, `PODS_MAX` (6), `POD_IDLE_TTL_MIN` (60), `MCP_DRIVER_TOOLS`
(compose sets 1; code default 0), `IGNORE_CERT_ERRORS` (0), `RECORD_VIDEO`/`RECORD_TRACE` (1),
`ARTIFACTS_KEEP` (compose 20, code default 50), `MCP_TOKEN` (empty).

---

## Security model

The two components have different boundaries, and neither should be treated as a substitute for the
other:

- **The plugin runs with the user's own OS privileges**, in the same process tree as DSH. It is not
  a sandbox. What it adds is a deterministic, code-level safety layer between the model and the
  browser: `http(s)`-only navigation, an operator domain policy, approval for risky actions,
  refusal to type passwords, file-picker and executable-download handoff, a guard that refuses to
  drive the DSH UI itself, and a user-only pause/resume.
- **A pod is a container boundary**, not a virtual machine. The default deployment listens on
  loopback only, allocates an isolated Xvfb/profile per session, and archives recordings. Treat the
  MCP endpoint as privileged: the driver tools can execute JavaScript in pages and drive whatever
  the pod browser can reach.

Read [docs/SECURITY.md](docs/SECURITY.md) before exposing either component beyond `127.0.0.1`.
In particular: `MCP_TOKEN`, when set, protects `/mcp` and the dashboard/REST API
(`Authorization: Bearer <token>`); `/healthz` stays public for container health checks. noVNC has
no password authentication, so never publish its port.

---

## Limitations

- The plugin is not an isolation boundary: a malicious page can still prompt-inject the model, and
  clicks are not URL-admitted the way `browser_open` is. Keep approval policies and domain policies
  tight when browsing untrusted content.
- The plugin pool is global (3 live browsers across conversations) and reclamation is time-based
  (15 minutes idle).
- Plugin browser auto-detection targets Windows install locations; elsewhere set
  `DSH_BROWSER_PATH`. No `browser_eval`-style JavaScript execution tool by design.
- The plugin cannot attach to a pod's `cdp_url` yet (see [docs/POSITIONING.md](docs/POSITIONING.md)).
- browser-pods is single-host (no cross-machine scheduling), has no audio or GPU acceleration, and
  its noVNC view is unauthenticated by default.
- Traces include DOM snapshots and may contain sensitive page data; recordings are stored
  unencrypted on the host.

---

## Repository layout

```text
.
├── index.js                 # DSH Host half: CDP client, tools, safety layer, HTTP routes
├── client.js                # DSH Web client half: Browser tab, status chip, tool cards
├── cordis.patch.yml         # DSH bundle patch (inserts the browser-use row)
├── locale/                  # Plugin UI dictionary resources
├── icon.svg
├── tests/                   # Plugin tests: fake-host harness, unit tests, real-Chromium integration
├── docs/                    # Architecture, security, development, testing, positioning
├── mcp/                     # browser-pods MCP server (git subtree, full history)
│   ├── src/                 # server, pod lifecycle, MCP tools, dashboard
│   ├── scripts/             # smoke, interaction, lifecycle CLI, multi-instance scaling
│   ├── tests/               # config + TLS-certificate integration tests
│   ├── Dockerfile
│   └── docker-compose.yml
├── CREDITS.md
├── CONTRIBUTING.md
└── LICENSE
```

---

## Testing and CI

```bash
npm install                 # devDependency: playwright
npm test                    # plugin unit + real-Chromium integration tests
npm run test:unit           # no browser needed
npm run test:integration    # needs DISPLAY/xvfb-run and Playwright Chromium

cd mcp && npm test          # MCP config + self-signed HTTPS certificate tests (needs Xvfb)
```

The GitHub Actions workflow `.github/workflows/ci.yml` runs the plugin suite on Node 22 and 24, the
MCP suite on Node 22, and builds the Docker image on `main`. See [docs/TESTING.md](docs/TESTING.md)
for prerequisites and what each test covers.

---

## Documentation

| Document | Contents |
|---|---|
| [docs/POSITIONING.md](docs/POSITIONING.md) | How the plugin and the MCP server relate, and which one should own which task |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Plugin internals (CDP, observation, refs, safety, routes) and MCP internals (pods, recording, HTTP) |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat models, defaults and deployment recommendations for both components |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Local setup, directory map, MCP subtree workflow, releases |
| [docs/TESTING.md](docs/TESTING.md) | Test suites, CI matrix, certificate tests |
| [mcp/README.md](mcp/README.md) / [mcp/README.en.md](mcp/README.en.md) | browser-pods full documentation / English summary |
| [CREDITS.md](CREDITS.md) | Inspirations and every third-party project actually used |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Issue/PR process, test requirements, commit conventions |

---

## License

MIT — see [LICENSE](LICENSE). Third-party components keep their own licenses; see
[CREDITS.md](CREDITS.md).
