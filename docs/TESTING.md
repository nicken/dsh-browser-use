# Testing

There are two test suites: the plugin tests at the repository root (Node's built-in test runner, with
real-Chromium integration tests) and the MCP server tests under `mcp/` (configuration/auth unit tests
plus a real Xvfb + Chromium certificate test). CI runs both.

## Current status

| Suite | Command | Needs | Status |
|---|---|---|---|
| Plugin unit (17 tests) | `npm run test:unit` | Node >= 22, no browser | Passing |
| Plugin integration (6 tests) | `npm run test:integration` | Xvfb/display + a Chromium/Chrome binary | Passing locally and in CI |
| Plugin combined (23 tests) | `npm test` | both of the above | Passing locally; runs in CI |
| MCP config + auth (4 tests) | `cd mcp && npm run test:unit` | Node only | Passing |
| MCP certificate integration (1 test) | `cd mcp && npm test` (or `npm run test:cert`) | Xvfb, Playwright Chromium | Passing locally/CI |
| Docker image build | `docker build -t browser-pods ./mcp` | Docker | Optional, non-blocking CI job |

---

## Plugin tests

The plugin is a DSH bundle, so the tests mount it with a **fake Cordis context** instead of booting
DSH.

### `tests/harness.mjs`

`createHarness()` builds a minimal stand-in for the DSH Host:

- creates a temporary `DSH_HOME` (`mkdtemp`), so real `~/.dsh` state is never touched;
- writes `capability-toggles.json` with
  `{ sessions: { "test-session": { browserUse: true, browserUseAdvanced: false } } }` by default
  (tests can disable it, enable the advanced surface, or supply a policy file);
- provides `ctx.tools.register`, `ctx.effect`, `ctx.inject` (with a fake `connection.fetch`),
  `ctx.get('approval')`, and records the registered tools and routes;
- exposes `call(name, args)` which invokes the real tool `execute(args, exec)` from `index.js`;
- cleans up the temporary home and all disposers.

The approval seam defaults to `allowed-once` with policy `standard`, which lets the integration test
exercise the approval path deterministically.

### `tests/tools.unit.test.mjs` (17 tests)

No browser is launched. The tests cover:

1. **Tool surface / capability gating.** The default surface is exactly one `browser` tool; turning
   on `browserUseAdvanced` exposes the six granular tools; the capability route (`GET`/`POST
   /api/browser-use/capability`) round-trips both `enabled` and `advanced`.
2. **Facade dispatch.** `browser({action})` rejects unknown actions and forwards `open`, `observe`,
   `act`, `read`, `session` and `evidence` to the real handlers.
3. **URL policy.** `open` accepts only absolute `http(s)` URLs (`javascript:`, `file:`, `data:`,
   relative and scheme-less inputs return `invalid_url` with guidance); `blockedDomains` /
   `allowedDomains` from `policy.json` are enforced (`domain_blocked`).
4. **No-session refusals.** Operation actions refuse with `no_session` outside a conversation while
   `session status` still works.
5. **Pause semantics.** `session op=pause` blocks subsequent tools (`paused`), the model has no
   resume action, and deleting the pause record restores normal validation.
6. **Launch failures.** A missing/invalid browser path returns `browser_launch_failed` (not a thrown
   exception) and the guidance mentions `DSH_BROWSER_PATH`.
7. **Pod engine failures.** Unreachable control plane → `pod_unavailable`, `401` → `pod_auth`,
   `5xx` → `pod_refused`, and `engine=auto` falls back to local with an `engineNote`.
8. **Engine settings (`engine.json`).** Defaults are `local`; saving persists (mode `0600`) and never
   returns the token (only `tokenSet`); environment variables override the file and are reported in
   `envOverrides`; a saved pod config is used by the tools without env vars; the `test` action probes
   the control plane.

Run:

```bash
npm run test:unit
```

### `tests/browser.integration.test.mjs` (6 tests)

Real-browser tests; each skips cleanly when no display or browser binary is available.

1. **Facade round trip.** Local HTTP pages; `browser({action:"open"})` → `observe` (numbered refs) →
   `act` (click a link; diff returned) → `read` (query returns matching paragraphs) → `evidence`
   (screenshot exists on disk) → password-field typing refused (`password_target`) → a high-risk
   "Delete account" click goes through the approval seam → `session` (`tabs`, `pause` blocks
   observation) → `close`.
2. **Attach mode.** Starts an external headless Chromium, opens its CDP endpoint through
   `browser({action:"open", cdp_url})`, observes/acts, then closes the session: the plugin must
   **detach** and leave the external process alive.
3. **Pod engine happy path.** A fake browser-pods control plane returns a local Chromium CDP URL;
   the plugin creates one pod (`POST /api/pods`), a second `open` reuses it (no second POST), and
   `session close` sends `DELETE /api/pods/{id}` while leaving the browser process alive.
4. **Pod `KEEP=1`.** Closing only detaches; no DELETE is sent.
5. **Remote CDP refusal.** A non-loopback `cdp_url` is refused with `cdp_not_allowed` unless
   `DSH_BROWSER_ALLOW_REMOTE_CDP=1`.
6. **Attach conflict.** With a local browser already open, opening a different `cdp_url` is refused
   with `browser_already_open` instead of silently reusing it.

Requirements and skip behaviour:

- A display is required on Linux for the local-browser test; without `DISPLAY` it **skips**. Run it
  under `xvfb-run` on headless machines.
- `playwright` is test-only and intentionally **not** a package dependency (so consumers never
  download a browser). Install it with `npm install --no-save playwright@1.62.1`; without it tests
  skip.
- The browser executable is resolved from `DSH_BROWSER_PATH`, then Playwright's
  `chromium.executablePath()`; a system Chrome works too (`DSH_BROWSER_PATH=/usr/bin/google-chrome`).
- In containers/CI where Chromium's sandbox cannot initialise, set `DSH_BROWSER_NO_SANDBOX=1`. This
  adds `--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage` to the spawned browser.

Run:

```bash
npm install --no-save playwright@1.62.1
npx playwright install chromium
xvfb-run -a npm run test:integration    # or: xvfb-run -a npm test
```

---

## MCP tests (`mcp/`)

`cd mcp && npm test` runs five tests (config, auth, certificate):

```text
node --test tests/config.test.mjs tests/auth.test.mjs tests/cert-ignore.test.mjs
```

### `config.test.mjs` (3 tests)

Environment variables are parsed when `src/pods.mjs` is loaded, so each test imports the module in a
fresh child Node process with overridden environment and prints the resulting `config`:

- `IGNORE_CERT_ERRORS` defaults to `false`;
- `IGNORE_CERT_ERRORS=1` sets `ignoreCertErrors: true`;
- `PODS_MAX=3` and `POD_IDLE_TTL_MIN=7` parse to `3` and `7 * 60_000` ms.

No browser is started.

### `auth.test.mjs` (1 test)

Starts the real HTTP server with `MCP_TOKEN` set and asserts that `POST /mcp` and `GET /api/config`
return `401` without a Bearer token, that `/healthz` stays public, and that `tools/list` succeeds
with the token.

### `cert-ignore.test.mjs` (1 integration test)

This is the core certificate-behaviour test:

1. Starts a self-signed HTTPS server on `127.0.0.1` using the committed **test-only** fixtures
   `tests/fixtures/self-signed-cert.pem` / `self-signed-key.pem` (CN/SAN `127.0.0.1`, localhost).
2. Sets its own environment (`DATA_DIR` temp dir, `VNC_ENABLED=0`, `RECORD_VIDEO=0`,
   `RECORD_TRACE=0`, dedicated display/port bases, `IGNORE_CERT_ERRORS=0`) before importing
   `pods.mjs`.
3. Creates a pod with default settings and asserts navigation to the HTTPS site **fails** with an
   error mentioning the certificate (`ERR_CERT|certificate|CERT_`), and that
   `describePod().ignore_cert_errors` is `false`.
4. Creates a second pod with `ignoreCertErrors: true`, asserts `describePod().ignore_cert_errors` is
   `true`, and that navigation succeeds with HTTP 200 and the expected page content.
5. Destroys both pods and the server in `finally`.

It really launches Xvfb and Chromium, so it needs a Linux-ish environment with X11 binaries and a
Playwright Chromium build. On headless hosts run the suite under Xvfb:

```bash
cd mcp
npm install
npx playwright install --with-deps chromium
xvfb-run -a npm test
```

The test assumes the display base `93` and CDP base `9343` are free (slot 1 uses display `:94` and
CDP `9343`); if you run multiple suites concurrently on one host, change those values in the test.

**Naming, consistently:** the server-side environment variable is `IGNORE_CERT_ERRORS`; the
per-session tool argument is `browser_open({ ignore_cert_errors: true })`; the reported field in
`describePod`/`browser_list` is `ignore_cert_errors`.

### Other MCP checks (not part of `npm test`)

These need a running server and are manual/integration scripts:

```bash
cd mcp
node scripts/smoke.mjs           # concurrent open/observe/drive/close, checks tools list and archives
node scripts/interact-test.mjs   # click/type/text/eval/snapshot round trip against a data: page
node scripts/browserctl.mjs list # lifecycle CLI (BROWSER_PODS_ENDPOINT overrides the endpoint)
```

`scripts/smoke.mjs --keep` leaves the sessions open so you can watch them on the dashboard.

---

## CI matrix

`.github/workflows/ci.yml`:

| Job | Runner | Node | Steps |
|---|---|---|---|
| `plugin` | `ubuntu-latest` | matrix `22`, `24` | `npm ci` → `npm install --no-save playwright@1.62.1` (test-only) → apt `xvfb` → `npx playwright install --with-deps chromium` → `xvfb-run -a npm test` with `DSH_BROWSER_NO_SANDBOX=1` |
| `mcp` | `ubuntu-latest` | `22` | `cd mcp` → `npm ci` → apt `xvfb` → `npx playwright install --with-deps chromium` → `xvfb-run -a npm test` |
| `docker` | `ubuntu-latest` | — | on `main` pushes only: `docker build -t browser-pods ./mcp`; `continue-on-error: true` (optional check) |

Workflow-level settings: `permissions: contents: read`, and a `concurrency` group keyed by workflow +
ref with `cancel-in-progress: true`.

The plugin job sets `DSH_BROWSER_NO_SANDBOX=1` only for the test step because GitHub runners cannot
start Chromium's sandbox with unprivileged user namespaces. The integration test still skips if no
display is available, but the job runs it under `xvfb-run`, so the real-Chromium path is exercised.

---

## Certificate tests explained

Certificates exist at two independent layers:

- **Plugin:** the browser does normal certificate validation; the plugin has no ignore-certificates
  switch. Its URL policy is independent of TLS. There is currently no certificate-specific plugin
  test; adding one would need a self-signed server and an explicit `browser_open` expectation of
  failure.
- **browser-pods:** validation is on by default and can be explicitly disabled per session or for
  new sessions by default. The MCP suite asserts both sides of that switch with a real browser, which
  is why it is the slowest and most environment-sensitive test in the repository.

The PEM fixtures under `mcp/tests/fixtures/` are self-signed, test-only material. Never add them to a
system trust store and never reuse them outside tests.

---

## Manual verification checklist

When a change touches user-visible behaviour, also check:

1. Plugin off by default: a fresh conversation has no `browser_*` tools until the switch is on.
2. `browser_open` on a normal site: the real window appears; `browser_observe` returns refs; an
   action reports a diff; `browser_read` answers a query.
3. A password field: typing is refused with `password_target`.
4. A high-risk target: highlight + approval screenshot, approval prompt, rejection path.
5. `browser_session action=pause` from the model, then resume from the status chip (the model cannot).
6. The Browser tab shows the pool, tabs, idle time and recent audit; closing a row works.
7. MCP: dashboard cards and thumbnails update; noVNC live view opens; close archives video + trace;
   `npx playwright show-trace` opens the trace.
8. Certificate behaviour: with validation on, a self-signed site fails with an actionable hint; with
   `ignore_cert_errors: true`, a new session can open it.

## Known gaps

- The plugin integration test runs against one browser build and one page fixture; cross-platform
  behaviour (especially Windows browser auto-detection) is not covered in CI.
- MCP CI covers config parsing and pod certificate behaviour, not the MCP protocol end-to-end
  (`scripts/smoke.mjs` does that manually) and not the dashboard/REST routes.
- The `docker` CI job is optional and excluded from branch protection by design.
- There is no coverage measurement.
