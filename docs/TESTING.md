# Testing

There are two test suites: the plugin tests at the repository root (Node's built-in test runner, with
one real-Chromium integration test) and the MCP server tests under `mcp/` (configuration unit tests
plus a real Xvfb + Chromium certificate test). CI runs both.

## Current status

| Suite | Command | Needs | Status |
|---|---|---|---|
| Plugin unit (6 tests) | `npm run test:unit` | Node >= 22, no browser | Passing |
| Plugin integration (1 end-to-end test) | `npm run test:integration` | Xvfb/display, Playwright + Chromium | Passing locally under `xvfb-run` |
| Plugin combined | `npm test` | both of the above | Passing locally; runs in CI |
| MCP config (3 tests) | `cd mcp && npm test` | Node only | Passing |
| MCP certificate integration (1 test) | `cd mcp && npm test` (or `npm run test:cert`) | Xvfb, Playwright Chromium | Passing locally/CI |
| Docker image build | `docker build -t browser-pods ./mcp` | Docker | Optional, non-blocking CI job |

---

## Plugin tests

The plugin is a DSH bundle, so the tests mount it with a **fake Cordis context** instead of booting
DSH.

### `tests/harness.mjs`

`createHarness()` builds a minimal stand-in for the DSH Host:

- creates a temporary `DSH_HOME` (`mkdtemp`), so real `~/.dsh` state is never touched;
- writes `capability-toggles.json` with `{ sessions: { "test-session": { browserUse: true } } }` by
  default (tests can disable it or supply a policy file);
- provides `ctx.tools.register`, `ctx.effect`, `ctx.inject` (with a fake `connection.fetch`),
  `ctx.get('approval')`, and records the registered tools and routes;
- exposes `call(name, args)` which invokes the real tool `execute(args, exec)` from `index.js`;
- cleans up the temporary home and all disposers.

The approval seam defaults to `allowed-once` with policy `standard`, which lets the integration test
exercise the approval path deterministically.

### `tests/tools.unit.test.mjs` (6 tests)

No browser is launched. The tests cover:

1. `apply` registers exactly the six browser tools.
2. `browser_open` accepts only absolute `http(s)` URLs — `javascript:`, `file:`, `data:`, relative
   and scheme-less inputs all return `invalid_url` with guidance.
3. `blockedDomains` and `allowedDomains` from `policy.json` are enforced (`domain_blocked`).
4. All browser tools refuse with `no_session` when called outside a conversation.
5. `browser_session` validates its action; `pause` blocks subsequent tools with `paused`; the model
   has no resume action; deleting the pause record restores normal validation.
6. A missing/invalid browser path returns `browser_launch_failed` (not a thrown exception) and the
   guidance mentions `DSH_BROWSER_PATH`.

Run:

```bash
npm run test:unit
```

### `tests/browser.integration.test.mjs` (1 end-to-end test)

A local `node:http` server serves two pages. The test drives the real plugin against a real
Chromium through the harness:

`browser_open` → `browser_observe` (numbered refs) → `browser_act` (click link; diff returned) →
`browser_read` (query returns matching paragraphs) → `browser_evidence` (screenshot exists on disk)
→ password-field typing is refused (`password_target`) → a high-risk "Delete account" click goes
through the approval seam → `browser_session` (`tabs`, `pause` blocks observation) → `close`.

Requirements and skip behaviour:

- A display is required on Linux; without `DISPLAY` the test **skips** with a message. Run it under
  `xvfb-run` on headless machines.
- `playwright` is test-only and intentionally **not** a package dependency (so consumers never download a browser). Install it with `npm install --no-save playwright@1.62.1`; without it the test skips.
- The browser executable is resolved from `DSH_BROWSER_PATH`, then `PLAYWRIGHT_CHROMIUM_PATH`, then
  Playwright's `chromium.executablePath()`. Install Playwright's browser with
  `npx playwright install chromium` (add `--with-deps` on a clean Linux host).
- In containers/CI where Chromium's sandbox cannot initialise, set `DSH_BROWSER_NO_SANDBOX=1`. This
  adds `--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage` to the spawned browser. It is
  a test-environment accommodation, not the desktop default.

Run:

```bash
npm install
npx playwright install chromium
xvfb-run -a npm run test:integration    # or: xvfb-run -a npm test
```

---

## MCP tests (`mcp/`)

`cd mcp && npm test` runs four tests:

```text
node --test tests/config.test.mjs tests/cert-ignore.test.mjs
```

### `config.test.mjs` (3 tests)

Environment variables are parsed when `src/pods.mjs` is loaded, so each test imports the module in a
fresh child Node process with overridden environment and prints the resulting `config`:

- `IGNORE_CERT_ERRORS` defaults to `false`;
- `IGNORE_CERT_ERRORS=1` sets `ignoreCertErrors: true`;
- `PODS_MAX=3` and `POD_IDLE_TTL_MIN=7` parse to `3` and `7 * 60_000` ms.

No browser is started.

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
