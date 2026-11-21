# Credits

This project stands on the work of others. This page lists the projects that were actually used or
actually consulted while building it. It is intentionally conservative: if a project is not listed,
it was not used as a dependency or as a design reference to our knowledge.

Nothing here implies endorsement. All listed projects remain under their own licenses and copyright.

---

## Inspirations (design only)

### browser-use/browser-use

The Python **browser-use** project is the reason this repository's plugin is named `browser-use` and
the original inspiration for letting an agent drive a real browser rather than a headless test
harness. Its focus on giving a model a compact, actionable view of a page informed the observation
model here (numbered controls, small observations, explicit one-step actions).

**This repository is independent and is not affiliated with, sponsored by, or endorsed by
browser-use/browser-use.** It is not a port or a fork, and contains no code from that project.

### microsoft/playwright-mcp

Microsoft's **playwright-mcp** demonstrated that an MCP server can expose a browser through
accessibility-tree snapshots and role/name locators instead of raw DOM. The MCP driver here follows
the same ideas (`browser_snapshot` returning accessibility YAML, `browser_click` accepting
`role` + `name`), while using Playwright directly in-process.

### Anthropic computer-use materials

Anthropic's public computer-use and browser-use examples and safety guidance were a reference for
the *safety posture*: keep a human able to see and take over the browser, bound what a model can do
in one step, and require explicit confirmation for consequential actions. The plugin's visible
window, highlight-before-approval, deterministic safety layer and user-only pause/resume follow that
spirit. No Anthropic code is included.

### Steel Browser, Browserbase, Stagehand

These projects were consulted as references for the shape of a self-hosted browser sandbox behind a
programmatic interface: session-scoped browsers, live viewing, isolation between sessions, and an
MCP/tool-shaped surface. They informed the pod lifecycle and the supply/driver split here. No code
from these projects is vendored in this repository.

---

## Software used

### Playwright (Microsoft)

Used by `browser-pods` (`mcp/package.json`, pinned `1.62.1`) for:

- `chromium.launchPersistentContext` and `chromium.connectOverCDP`,
- page driving, accessibility snapshots (`ariaSnapshot`), screenshots,
- context video recording and tracing (`trace.zip`),
- console/network/page-error event capture.

The plugin itself does **not** depend on Playwright.

### Chrome DevTools Protocol (CDP)

The protocol behind the plugin's browser control. `index.js` implements a small client over the
runtime's `WebSocket` — no CDP client library is used. The MCP pods also expose a CDP endpoint
(`cdp_url`) for external drivers.

### @modelcontextprotocol/sdk

The official MCP TypeScript SDK (`mcp/package.json`, `^1.32.2`). Used for `McpServer` tool
registration and the stateless streamable-HTTP transport.

### zod

`mcp/package.json` (`^4.6.7`). Used to declare every MCP tool's input schema.

### noVNC and websockify

`noVNC` provides the browser-based VNC client served for each pod's live view; `websockify` bridges
WebSocket connections to the pod's x11vnc port. Both are installed in the `browser-pods` image and
served under `/usr/share/novnc`.

### x11vnc

The VNC server attached to each pod's Xvfb display. It is started with `-localhost` and no password
by default; see [SECURITY.md](docs/SECURITY.md) before exposing it.

### Xvfb

The virtual X server that gives each pod a display that is not the user's desktop. The pod code
creates `/tmp/.X11-unix`, disables GLX (Chrome falls back to SwiftShader) and starts one Xvfb per
session.

### DeepSeek Harness (DSH) and Cordis

The plugin platform this repository targets. The plugin is a Cordis bundle: `cordis.patch.yml`
inserts the `browser-use` row, `index.js` uses the Cordis context
(`ctx.inject`, `ctx.effect`, `ctx.tools.register`, `connection.fetch`), and `client.js` uses the DSH
Web module loader, slots and locale services. The MCP server can also be consumed by DSH through
the standard `@deepseek-ai/dsh-mcp-client` entry.

---

## Also used (directly, without a design influence)

| Project | Where | What for |
|---|---|---|
| Node.js | both | Runtime (>= 22) and built-in test runner, `node:http` |
| openbox | browser-pods image | Lightweight window manager for the pod display |
| tini | browser-pods image | PID 1 / signal forwarding in the container |
| Debian packages (fonts, Chromium libraries, `curl`, `procps`, `ca-certificates`) | Dockerfile | Runtime dependencies of Chromium/Xvfb/noVNC |
| Docker / Docker Compose | browser-pods | Container build and deployment |
| `npx playwright show-trace` / trace.playwright.dev | browser-pods docs | Opening archived traces |

---

If you believe your project or idea is used here without proper credit, please open an issue and it
will be corrected.

License: this repository is MIT; third-party projects keep their own licenses.
