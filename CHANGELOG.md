# Changelog

All notable changes to this repository are documented here. The plugin
(`dsh-browser-use`) and the MCP server (`mcp/`, `browser-pods`) version independently.

## Unreleased

- **Deployment form C1 — pod engine.** `DSH_BROWSER_ENGINE=pod` (or `auto`) makes the plugin create
  a browser-pods sandbox through its REST API and drive it over CDP; the model still sees only the
  plugin's browser tools. `browser_open({ cdp_url })` / `browser({action:"open", cdp_url})` also
  attach to any existing CDP endpoint (loopback by default). Pod sessions report `pod.id` and
  `live_view_url` in `browser_session status`, and close/detach archives the pod.
- **Single tool surface by default.** The plugin now registers one `browser` tool
  (`action: open | observe | act | read | session | evidence`); the six granular tools are only
  registered when the per-session `browserUseAdvanced` switch is on. The Browser tab exposes both
  switches.
- Tests: facade dispatch, advanced-switch gating, pod failure modes (`pod_unavailable`, `pod_auth`,
  `pod_refused`, `auto` fallback) and CDP attach/detach coverage.

## 0.2.0 — 2026-11-21

First open-source release. The plugin was previously developed privately as
`@local/dsh-browser-use`; the MCP server was previously a separate `browser-pods`
repository whose history is included under `mcp/`.

### Plugin (`dsh-browser-use`)

- Six tools: `browser_open`, `browser_observe`, `browser_act`, `browser_read`,
  `browser_session`, `browser_evidence`.
- Zero-dependency CDP driver (no Playwright), per-session isolated Chromium/Edge profiles,
  numbered observations (~200–450 tokens for a typical page), query reads, one action per call
  with a diff, deterministic safety layer (http(s)-only navigation, domain allow/deny policy,
  password/upload/download refusals, approval for risky actions, user-only pause).
- Per-session capability switch (`browserUse`), bounded browser pool (3 live, 15 min idle),
  audit trail, DSH-native client UI (Browser tab, tool cards, status chip).
- New `DSH_BROWSER_NO_SANDBOX=1` escape hatch for containers/CI where Chromium's sandbox
  cannot initialise (off by default).
- Tests: contract unit tests with a fake Cordis context plus a real-Chromium integration test.

### MCP server (`browser-pods` 0.1.0)

- Self-hosted browser pods: one Xvfb + Chromium + noVNC desktop per session, Playwright driver,
  16 MCP tools (or 5 in supply-only mode), video + Playwright trace archiving, dashboard,
  multi-instance slot allocation.
- **New:** explicit TLS certificate override. Certificates are validated by default; a trusted
  self-signed/internal site can opt out per session with
  `browser_open({ ignore_cert_errors: true })`, or for new sessions with `IGNORE_CERT_ERRORS=1`.
  Certificate failures return an actionable hint instead of a bare error.
- **Security fix:** `MCP_TOKEN` now also protects `POST /mcp` (previously the MCP route was
  handled before the auth check). `/healthz` stays public for container health checks.
- Dockerfile takes optional `APT_MIRROR` / `NPM_REGISTRY` build args instead of hard-coding a
  mirror; tests cover config parsing, token auth and certificate behaviour.
- Removed the internal hand-off snapshot that shipped with the private repository.
