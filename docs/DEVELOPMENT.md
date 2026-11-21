# Development

This repository contains two components with different toolchains. The plugin has **no build step**;
the MCP server is a plain Node ESM service that runs from source (or from the Docker image).

---

## Prerequisites

| Tool | Needed for | Notes |
|---|---|---|
| DSH with a `web` profile | plugin development | Plugin bundles are installed into a profile |
| Node.js >= 22 | repository tooling, MCP server, tests | `package.json` `engines.node` |
| npm | installing the Playwright devDependency and MCP dependencies | |
| Microsoft Edge or Google Chrome | running the plugin | Linux/macOS: point `DSH_BROWSER_PATH` at the executable |
| Xvfb / a display | plugin integration tests, MCP server | `xvfb-run` on headless Linux |
| Docker (Linux host) | browser-pods | Xvfb, x11vnc, noVNC and Chromium run in the image |

---

## Repository layout

```text
.
├── index.js                    # DSH Host half (ESM, no runtime dependencies)
├── client.js                   # DSH Web client half (module-loader bundle)
├── cordis.patch.yml            # DSH bundle patch
├── locale/{en,zh}.json         # Bundle display metadata
├── icon.svg
├── package.json                # Plugin metadata; tests/devDependency/scripts
├── tests/
│   ├── harness.mjs             # Fake Cordis context that mounts apply()
│   ├── tools.unit.test.mjs     # Tool surface, URL policy, pause, refusal codes
│   └── browser.integration.test.mjs  # Real Chromium end-to-end
├── docs/                       # POSITIONING, ARCHITECTURE, SECURITY, TESTING, this file
├── mcp/                        # browser-pods — git subtree from the standalone repo
│   ├── src/server.mjs          # Control plane: dashboard, REST, MCP, audit
│   ├── src/pods.mjs            # Pod lifecycle: Xvfb + Chromium + x11vnc + noVNC + recording
│   ├── src/mcp.mjs             # The 16 MCP tools
│   ├── src/dashboard.html      # Dashboard
│   ├── scripts/                # smoke, interaction test, lifecycle CLI, scaling
│   ├── tests/                  # config unit test + certificate integration test
│   ├── docs/                   # screenshots
│   ├── Dockerfile
│   └── docker-compose.yml
├── .github/workflows/ci.yml
├── CREDITS.md
└── CONTRIBUTING.md
```

---

## Plugin development

### Install a local checkout into a DSH profile

No build is required — `index.js` and `client.js` are loaded as-is. Install the working copy as a
link into the profile (the `dsh plugin` command forwards its arguments to pnpm in the profile
directory):

```bash
dsh plugin --profile web add link:/absolute/path/to/dsh-browser-use
```

The DSH **Plugins** page also accepts an absolute local path via **Add plugin**; either way the
bundle patch in `cordis.patch.yml` registers the `browser-use` row.

After a Host-side change (`index.js`), reload/restart the DSH Web process if the change does not
appear immediately. After a Client-side change (`client.js`), refresh the Web page; when the DSH
Web shell itself is running from a source checkout, follow that checkout's own client-plugin
development instructions. The composed profile can always be inspected with:

```bash
dsh --profile web --dump-config
```

For an isolated development environment, point the plugin at a throwaway DSH home:

```bash
DSH_HOME=/tmp/dsh-dev dsh web
```

The plugin stores everything under `$DSH_HOME`, so a temporary home keeps your real profiles,
screenshots and audit trail untouched.

### Enable it for a conversation

The plugin is off by default. Open a conversation, go to the **Browser** tab and turn on **Browser
control**. The switch writes `~/.dsh/capability-toggles.json`; the tools appear on the next step.
In tests, the fake host writes the same file (see `tests/harness.mjs`).

### Environment and data

| Variable | Purpose |
|---|---|
| `DSH_HOME` | Base directory for plugin state (default `~/.dsh`) |
| `DSH_BROWSER_PATH` | Explicit browser executable; required outside the standard Windows install locations |
| `DSH_BROWSER_NO_SANDBOX` | `1` adds `--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage`; only for containers/CI where Chromium's sandbox cannot start |

State written at runtime: `browser-use/profiles/<sessionId>/`, `browser-use/policy.json`,
`browser-use/pause.json`, `browser-use/audit.jsonl`, `browser-use/shots/`, and the shared
`capability-toggles.json`. Delete the relevant directory/file to reset that piece of state.

### Debugging the plugin

- `browser_session action=status` shows the pool, tab counts, idle time, pause state and a provider
  report for other browser plugins.
- `browser_session action=show` raises the real window; the user can take over at any point.
- `browser_session action=pause` is the emergency stop; to resume during development, delete
  `$DSH_HOME/browser-use/pause.json` or use the UI.
- The audit trail (`browser-use/audit.jsonl`) is the quickest way to see the last attempts, refusal
  codes and risk grades.
- The plugin deliberately has no logging framework; it reports through tool values and the UI
  routes.

### Tests

See [TESTING.md](TESTING.md) for the full description. The short version:

```bash
npm install
npx playwright install chromium          # plus --with-deps on Linux
npm run test:unit                        # no browser needed
xvfb-run -a npm test                     # unit + real Chromium
```

On Linux, the integration test needs a display (`DISPLAY`); it skips itself otherwise. It resolves
the browser from `DSH_BROWSER_PATH`, then `PLAYWRIGHT_CHROMIUM_PATH`, then Playwright's own
`chromium.executablePath()`. In a container whose kernel disallows unprivileged user namespaces, set
`DSH_BROWSER_NO_SANDBOX=1`.

---

## MCP server development

### Recommended: Docker

```bash
cd mcp
docker compose up -d --build
docker compose logs -f
```

The image installs Xvfb, x11vnc, noVNC (`websockify`), openbox, fonts and Playwright Chromium. Data
lives in `mcp/data/` (ignored by git); recreate with `docker compose down` plus `docker compose up
-d --build`. The Dockerfile currently points apt at an Aliyun mirror and npm at npmmirror; those are
environment-specific choices. If they are unreachable from your network, adjust the Dockerfile (or
build with a proxy). This is one reason the optional `docker` CI job is allowed to fail.

### Local (no Docker)

You need the same system packages the image installs: `xvfb`, `x11vnc`, `novnc`, `websockify`,
`openbox`, Chromium runtime libraries and fonts, plus Playwright's Chromium:

```bash
cd mcp
npm install
npx playwright install --with-deps chromium

DATA_DIR="$PWD/data-local" \
LISTEN_HOST=127.0.0.1 LISTEN_PORT=8787 \
node src/server.mjs
```

Then use the dashboard (<http://127.0.0.1:8787/>) or run the end-to-end scripts against the running
server:

```bash
node scripts/smoke.mjs           # opens 3 browsers concurrently, drives them, closes and archives
node scripts/interact-test.mjs   # click / type / text / eval / snapshot round trip
node scripts/browserctl.mjs list # lifecycle CLI (start/list/show/stop/gc, --json)
```

`scripts/browserctl.mjs` reads `BROWSER_PODS_ENDPOINT` (default `http://127.0.0.1:8787`).

### Tests

```bash
cd mcp
npm test                         # config.test.mjs + cert-ignore.test.mjs
xvfb-run -a npm test             # required on headless Linux
npm run test:cert                # certificate test only
```

The certificate test really launches Xvfb + Chromium and a self-signed HTTPS server; it is the
slowest part of the suite.

### Configuration

Every knob is an environment variable read once at module load (`mcp/src/pods.mjs` `config`).
`mcp/README.md` has the complete table. For development the useful ones are `DATA_DIR`,
`LISTEN_HOST`/`LISTEN_PORT`, `PODS_MAX`, `POD_IDLE_TTL_MIN`, `DISPLAY_BASE`/`VNC_PORT_BASE`/
`VIEW_PORT_BASE`/`CDP_PORT_BASE` (to avoid collisions with another local instance), `VNC_ENABLED`,
`RECORD_VIDEO`/`RECORD_TRACE`, `IGNORE_CERT_ERRORS` and `MCP_DRIVER_TOOLS`.

`MCP_DRIVER_TOOLS` is `0` by default in code (supply-only, 5 tools); `docker-compose.yml` sets it
to `1` (16 tools). Keep both configurations working when changing tool registration.

---

## The `mcp/` subtree

`mcp/` is a **git subtree** of the standalone `browser-pods` repository, merged with its complete
history. Do not convert it into a submodule or re-init it; that would break history and change how
contributors clone the repo.

Maintainer commands (run from the repository root, replace the path/remote with your checkout):

```bash
# Pull upstream browser-pods changes into mcp/
git subtree pull --prefix=mcp ../projects/browser-pods main

# Send changes made in mcp/ back to the standalone repository
git subtree push --prefix=mcp <browser-pods-remote> main

# Inspect the subtree's history from the monorepo
git log --oneline -- mcp
```

Rules of thumb:

- Small, self-contained fixes under `mcp/` can land in this repository directly; mention in the PR
  that the change may need to be synced upstream.
- Structural changes to the MCP server should be made in the standalone `browser-pods` repository
  first and pulled in with `git subtree pull`, so the two histories stay compatible.
- Resolve subtree merge conflicts in the same PR; do not force-push `main`.
- The plugin (repository root) and the subtree are independent release artifacts: a plugin release
  does not require a new MCP image, and vice versa.

---

## Release process

### Plugin (GitHub / npm)

1. Update `version` in `package.json`, and keep README/docs in sync with user-visible behaviour.
2. Run `npm test` with a display (`xvfb-run -a npm test` on headless Linux).
3. Commit, tag (`v0.2.0` style), push tags.
4. Publish the npm tarball if the package should be installable by name:
   `npm publish` (the tarball contains only the paths listed in `package.json#files`; docs beyond
   `README.md` are not included).
5. Create a GitHub release. Users can then install either:
   - `dsh plugin --profile web add github:nicken/dsh-browser-use`, or
   - `dsh plugin --profile web add dsh-browser-use` (after npm publication).

There is no build artifact: the published package is the source.

### browser-pods image

1. Update the version in `mcp/package.json` and the image tag in `mcp/docker-compose.yml`.
2. Rebuild: `docker build -t browser-pods:0.1.0 ./mcp` (or `docker compose build`).
3. Tag and push to your registry if you publish images, e.g.
   `docker tag browser-pods:0.1.0 <registry>/browser-pods:0.1.0 && docker push <registry>/browser-pods:0.1.0`.
   If you push to a registry, update `image:` in `docker-compose.yml` accordingly.
4. Smoke-test the built image: `cd mcp && docker compose up -d && node scripts/smoke.mjs`.
5. If the MCP change came through the subtree, push it back to the standalone repository.

### CI

`.github/workflows/ci.yml` gates the release: the `plugin` job runs the unit + real-Chromium suite on
Node 22 and 24, the `mcp` job runs the MCP suite on Node 22, and the optional `docker` job builds the
image on `main`. See [TESTING.md](TESTING.md) for details.

---

## Conventions

- **Plugin:** ESM only, Node >= 22, **no new runtime dependencies** — the zero-dependency CDP client is
  a design constraint, not an accident. Keep the safety layer deterministic (code, not prompts), keep
  tool parameter schemas closed (`additionalProperties: false`), and add a test for every new refusal
  code or tool argument.
- **MCP:** keep the supply/driver split intact (`MCP_DRIVER_TOOLS=0` must still work), declare every
  tool input with zod, keep pod operations serialised through `withPod`, and never kill an external
  browser on detach.
- **Docs:** user-visible behaviour (tool names, arguments, environment variables, defaults, paths)
  must match the code. When you change one, update `README.md`, `README.zh-CN.md`, the relevant
  `docs/` page and `mcp/README.md` in the same PR.
- **Secrets and local data:** never commit `~/.dsh` state, `mcp/data/`, screenshots, audit logs or
  recordings.
