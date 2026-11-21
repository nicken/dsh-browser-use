# Security

This document describes the threat models, the controls that exist in code, the default boundaries,
and how to deploy each component safely. It is deliberately concrete: every control listed here can
be found in `index.js`, `client.js`, `mcp/src/*.mjs` or the compose file.

**Scope:** the DSH plugin (repository root) and the `browser-pods` MCP server (`mcp/`). Neither is a
security product, and neither replaces OS-level isolation.

**Reporting a vulnerability:** do not open a public issue with a working exploit. Use the
repository's private vulnerability-reporting channel (GitHub security advisories) if available;
otherwise contact the maintainers through the repository before disclosing details publicly.

---

## Shared principles

1. **Page content is untrusted input.** A web page can contain instructions aimed at the model
   (prompt injection). The agent must be assumed to be persuadable; safety therefore lives in code
   that constrains *what actions are possible*, not in prompts.
2. **Separate the brain from the body.** The plugin owns observation and approval; the pod owns
   isolation and recording. Mixing those responsibilities would make both weaker.
3. **Loopback by default.** The MCP server binds to `127.0.0.1` unless the operator changes it; the
   plugin adds no listener beyond the loopback CDP port of the Chromium it spawns, and its routes
   are served same-origin by the DSH host.
4. **Explicit opt-in for weakened controls.** Certificate checking can be disabled only with an
   explicit per-session parameter or environment variable; Chromium's sandbox can be disabled only
   with an explicit environment variable. There is no silent downgrade.

---

## Part 1 — DSH plugin

### 1.1 What it protects

| Asset | Why it matters |
|---|---|
| The user's DSH session | Tool calls act with the user's authority; approvals must stay meaningful |
| The user's browser profile and logins | The plugin's isolated profile holds cookies/sessions for sites the agent visited |
| The local machine and intranet | The browser can reach whatever the user's network can reach |
| Files on disk | Screenshots, the audit trail and the profile are written under `~/.dsh/` |
| User trust in what happened | The audit trail and the visible window are the evidence |

The plugin runs **as the user, in the DSH process tree, on the user's desktop**. It is not a sandbox:
a browser exploit, a malicious extension in the browser, or a same-user process can do anything the
user can.

### 1.2 Attack surfaces and controls

| Surface | Control in code | Refusal code |
|---|---|---|
| Navigation target | `admitUrl`: absolute `http(s)` only; blocked-domain regexes and optional allowlist from `~/.dsh/browser-use/policy.json` | `invalid_url`, `domain_blocked` |
| Risky action | `classifyRisk`: risky verbs in `intent`, target name/role/tag, or financial terms grade `high`; needs `confirm_risk: true` and DSH approval | `risk_approval_required`, `risk_denied`, `risk_unavailable` |
| Password entry | `type` into `input[type=password]` is refused; password values are never read (`valueLength: -1`) | `password_target` |
| File upload | Clicking `input[type=file]` is refused; the window is raised, the field highlighted, a screenshot attached for the user | `upload_blocked` |
| Executable/installer download | Links ending in `.exe/.msi/.bat/.cmd/.ps1/.vbs/.apk/.dmg/.iso/.scr/.jar` are refused with highlight + screenshot | `download_blocked` |
| Document/archive download | `.zip/.rar/.7z/.pdf/.doc(x)/.xls(x)/.ppt(x)/.csv/.txt/.png/.jpg/.gif/.mp4/.mp3` are graded high risk and need approval | `risk_approval_required` |
| The DSH UI itself | The page is identified before acting; the DSH shell is user-only | `dsh_ui_blocked` |
| Unidentifiable page | The action fails closed if page identity cannot be read | `page_unverifiable` |
| Ambiguous target | More than one match is refused rather than guessed | `ambiguous_target` |
| Stale observation | Acting needs an observation no older than 120 s | `observe_required` |
| Pause | A `pause.json` record blocks open/observe/act/read; only the user can resume through the UI | `paused` |
| Typed secrets in logs | The audit stores the typed text **length**, never its content | — |
| Cross-profile contamination | Every conversation gets its own `user-data-dir` under `~/.dsh/browser-use/profiles/<sessionId>`; the daily profile is never used | — |
| User visibility | High-risk actions are highlighted in the visible window and snapshotted for the approval prompt; `browser_session action=show` raises the window | — |
| Tool exposure | Tools are registered behind the per-session `browserUse` capability flag, off by default | tools absent |

The approval seam is `ctx.get('approval')`. A missing seam, a throwing request, a cancelled prompt
or the session policy `never` all **fail closed**: the action does not run. `allowed-once` is the
only outcome that proceeds.

### 1.3 Residual risks

These are known and cannot be fixed by documentation alone:

- **Prompt injection remains possible.** The safety layer constrains classes of action, not intent.
  A page can still persuade the model to click a normal link, read sensitive text, or fill a normal
  field. The user should supervise sessions on untrusted sites and keep the capability switch off
  elsewhere.
- **Click navigation is not URL-admitted.** `admitUrl` applies to `browser_open`. A click can follow
  a link to any scheme or host the browser accepts (the code inspects the link only for download
  patterns). The domain policy is therefore not a complete egress policy.
- **Downloads can start without a link.** The download policy inspects the target of `browser_act`.
  Navigating directly to an `http(s)` URL whose response is a download can still save a file into
  the browser's download directory.
- **Key presses are not target-inspected.** The password refusal is enforced for the `type` action
  target. The `press` action sends keystrokes to the focused element without resolving a target, so
  a page that focuses a password field could still receive characters that way.
- **The DSH UI guard covers actions only.** `browser_act` refuses the DSH shell; `browser_observe`
  and `browser_read` are not blocked from it.
- **Pause is partial.** `browser_evidence` and inspection/close actions in `browser_session` are not
  pause-gated; they can still read console/network buffers or take screenshots.
- **The audit trail is best-effort, not tamper-evident.** It is an append-only JSONL file written by
  the plugin; any process running as the user can read or edit it. It also does not cover
  `browser_observe`, `browser_read` or `browser_session`.
- **Risk grading is heuristic.** Regex-based detection of risky targets can miss a destructive action
  with an innocuous label or a server-side side effect behind a GET link; it can also produce false
  positives.
- **The profile is not encrypted.** Cookies and site data persist under `~/.dsh/browser-use/profiles`
  until deleted; any same-user process can read them.
- **Screenshots may contain sensitive page data.** They are written unencrypted under
  `~/.dsh/browser-use/shots/` (40 most recent kept) and served by the same-origin shot route.
- **`DSH_BROWSER_NO_SANDBOX=1` removes Chromium's renderer sandbox.** See the deployment section.

### 1.4 Safe defaults (plugin)

- Slider off: `browserUse` is false unless the user turns it on per conversation.
- `http(s)` only; no `file:`, `data:`, `javascript:`, custom schemes.
- Empty policy file = no allowlist, but `domain_blocked` rules still apply; for high-risk
  environments, set `allowedDomains` to the sites the agent genuinely needs.
- Keep the DSH approval policy other than `never` when risky actions are expected; `never` makes
  approval-required actions fail closed (by design).
- Leave `DSH_BROWSER_NO_SANDBOX` unset on a desktop.
- Treat the visible window as part of the control: the user can watch, take over, or pause at any
  time.

---

### 1.5 Attach mode and the pod engine

- **Attach mode** (`browser({action:"open", cdp_url})`) drives an existing Chromium over CDP. Only
  loopback endpoints are accepted by default; set `DSH_BROWSER_ALLOW_REMOTE_CDP=1` to allow remote
  hosts (the configured pod host is always allowed). The plugin does not kill an attached browser on
  close — it detaches; archiving remains the pod's responsibility.
- **Pod engine** (`DSH_BROWSER_ENGINE=pod|auto`) uses the browser-pods REST API to create and delete
  pods. `DSH_BROWSER_POD_TOKEN` is sent as a Bearer header only; it is never written to tool results,
  the audit trail or the client UI, and error messages contain only the control-plane URL and the
  server's error text. `DSH_BROWSER_POD_KEEP=1` deliberately leaves a pod running after close.
- **Potency**: a pod created this way inherits the pod's isolation boundary, but the plugin's URL
  policy, password/upload/download refusals and approval flow still apply. Treat the capability as
  granting a browser *and* the pod control plane to the session.

## Part 2 — browser-pods MCP server

### 2.1 What it protects, and from what

| Asset | Why it matters |
|---|---|
| Container host and its network | The container uses host networking; services are host ports |
| Browser sessions and cookies | Pods log into real sites; named profiles persist login state |
| Recorded artifacts | Video, trace (DOM snapshots), console and network data of every session |
| Host filesystem | The `./data` directory (profiles, artifacts, downloads) is a host path |
| Other pods / other users of the same server | The pod is the tenant boundary |

The threat model assumes the *page content is hostile* and the *MCP client is trusted* unless the
operator exposes the endpoint. The container is the isolation boundary; it is a container, not a
virtual machine.

### 2.2 Exposure points and defaults

| Endpoint | Default | Authentication | Notes |
|---|---|---|---|
| MCP `POST /mcp` | `127.0.0.1:8787` | `MCP_TOKEN` Bearer, **if set**; otherwise none | Full tool surface: open browsers, execute JS, list artifacts |
| Dashboard / REST `/api/*` | `127.0.0.1:8787` | `MCP_TOKEN` Bearer, **if set**; otherwise none | Close sessions, delete artifacts, read configuration |
| `GET /healthz` | `127.0.0.1:8787` | None | Counts, uptime |
| noVNC live view | `127.0.0.1:6082`+ (slot 1) | **None** (x11vnc `-nopw`, websockify has no auth) | Full interactive control of the virtual desktop. If the installed websockify rejects the explicit `VNC_LISTEN_HOST`, the code falls back to listening on all addresses (logged as a warning) |
| x11vnc | `127.0.0.1:5902`+ | None; bound with `-localhost` | Raw VNC to the pod display |
| Chromium CDP | `127.0.0.1:9223`+ | None; `--remote-allow-origins=*` | Any local process can drive the pod browser |
| Artifact downloads | Dashboard/REST | Same as REST | Video/trace may contain secrets |

`docker-compose.yml` sets `LISTEN_HOST: 127.0.0.1`, `PUBLIC_HOST: 127.0.0.1` and
`VNC_LISTEN_HOST` falls back to `127.0.0.1` from the code default. Do not change those to
`0.0.0.0` on a shared machine without compensating controls.

**MCP_TOKEN reality check.** The server checks `authorized(req)` before every route except
`/healthz`, so a configured token does protect `/mcp` as well as the dashboard and `/api/*`. It is
still a plain `Bearer` string over plain HTTP: if `/mcp` must be reachable from another host,
terminate TLS *and* authentication in a reverse proxy in front of it, or tunnel it (SSH port
forwarding). Do not expose `/mcp` without at least one of those controls.

### 2.3 Powerful tools are the product

Anyone who can reach the service can, by design:

- call MCP tools: `browser_open` a browser and visit arbitrary sites (subject to the pod's network
  reachability),
- `browser_eval` arbitrary JavaScript in any page the pod has open, including pages with logged-in
  sessions in a reused profile,
- `browser_open({ cdp_url })` connect to an already-running local Chrome/Edge DevTools endpoint and
  drive it,
- read the console/network buffers, take screenshots, and list artifacts,
- through the dashboard/REST surface: download and delete artifacts
  (`POST /api/artifacts/:id/delete`), and close other tenants' sessions.

Treat the MCP server as a privileged remote-control service, not as a public web app.

### 2.4 Certificate handling

- TLS certificates are validated by default (`ignoreHTTPSErrors: false`).
- Per session, `browser_open({ ignore_cert_errors: true })` makes that browser accept invalid
  certificates. The server-wide default for new sessions is `IGNORE_CERT_ERRORS=1` (off by default).
- When enabled, the browser runs with `--ignore-certificate-errors`, and Playwright is configured
  with `ignoreHTTPSErrors: true`; the exception applies to every page, subresource and WebSocket in
  that browser for the whole session.
- Semantics are explicit: a navigation failure caused by certificate validation returns a hint
  telling the caller to retry with `ignore_cert_errors: true` for a trusted self-signed/internal
  site, and **not** to use it for unknown public sites.
- Risk: with validation disabled, a man-in-the-middle can read or modify the session; a reused
  named profile's cookies are exposed to whoever can intercept that traffic. Never enable it by
  default for public browsing; prefer installing the internal CA in the pod image/profile when the
  site is internal and repeatable.

### 2.5 Isolation boundary and its limits

Provided:

- Every session has its own Xvfb display, Chromium process, profile directory, ports and VNC
  endpoint; windows never appear on the host desktop.
- The compose service uses `network_mode: host`, `user: "1000:1000"`, `cpus: 6`, `mem_limit: 12g`,
  `pids_limit: 1024`, `shm_size: 1gb`, and mounts only `./data:/data`.
- Chromium's sandbox stays enabled when the container runs as non-root; `--no-sandbox` is added only
  when the process uid is 0. Depending on the host kernel's unprivileged user-namespace policy,
  Chromium may still fail to start; that is a deployment problem, not a reason to run the container
  as root.
- Artifacts and profiles are written into the mounted data directory with the host uid.

Not provided / caveats:

- **Not a VM.** Containers share the host kernel; the compose file adds no seccomp/AppArmor profile,
  user-namespace remapping or read-only root filesystem. A container escape or a kernel bug is out
  of scope.
- **Host networking.** The MCP, dashboard, noVNC, VNC and CDP ports are host ports. Any local process
  (or any container on the host) that can reach them can control pods; the CDP port in particular
  has no authentication.
- **Named profile reuse is cross-session by design.** `browser_open({ profile: "shop" })` keeps
  cookies between sessions; one profile may be held by only one pod at a time, but successive
  sessions and different tasks share the same login state. Do not mix trust domains in a profile.
- **Trace/video content is sensitive.** Playwright traces include DOM snapshots and screenshots;
  `meta.json` records URLs, console errors and network issues. They are stored unencrypted on the
  host and retained by count (`ARTIFACTS_KEEP`: 20 in compose, 50 by code default).
- **The MCP driver is inside the same process as the lifecycle manager.** A bug in a tool handler
  can affect all pods in that container; run one container per tenant/trust domain if that matters.
- **No password manager and no anti-phishing heuristics inside the pod.** The browser is a browser;
  the MCP tools do not add the plugin's approval layer. If a pod session logs into a site, any tool
  caller can drive that session.

### 2.6 Safe defaults (browser-pods)

- Keep `LISTEN_HOST`, `PUBLIC_HOST`, `VNC_LISTEN_HOST` on `127.0.0.1`; reach a remote instance over
  an SSH tunnel or a TLS reverse proxy that performs authentication.
- Never publish the noVNC or x11vnc ports; they have no authentication.
- Set `MCP_TOKEN` whenever the control plane is reachable beyond loopback: it now covers `/mcp`
  and `/api/*`. Because the token travels in plaintext, still put a TLS-terminating,
  authenticating proxy in front of a remote instance.
- Keep certificate validation on. Use `ignore_cert_errors` only for confirmed, trusted self-signed
  or internal sites.
- Use dedicated named profiles per trust domain, and delete `data/profiles/<name>` when rotating
  credentials.
- For sensitive sessions, disable recording (`RECORD_VIDEO=0`, `RECORD_TRACE=0`) and remove
  artifacts afterwards; otherwise treat `data/artifacts` as secret material.
- Keep the `./data` volume on a disk/tenant appropriate to the data; do not mount the Docker socket,
  the host home directory, or unrelated host paths into the container.
- Apply host firewall/egress rules if pods browse untrusted content.
- Rebuild the image to pick up Playwright/Chromium and OS security updates; pin versions for
  reproducibility.

### 2.7 Restricted environments: `DSH_BROWSER_NO_SANDBOX`

The DSH plugin (not the MCP server) reads this variable:

- `DSH_BROWSER_NO_SANDBOX=1` appends `--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage`
  to the spawned Chromium command line.
- Default: unset, i.e. the browser sandbox is used. Desktop users should leave it unset.
- Use it only where Chromium's sandbox cannot initialise: containers or CI runners whose kernel
  disallows unprivileged user namespaces, or where `/dev/shm` is too small for Chromium.
- Risk: the renderer is no longer sandboxed, so a page exploit is not confined by Chromium's
  sandbox. Compensate with an outer isolation boundary (a disposable container/VM, no mounted
  secrets, no production credentials, restricted network egress).

In CI the flag is set only for the test job; it does not change the plugin's behaviour for users.

---

## Deployment recommendation summary

| Scenario | Recommendation |
|---|---|
| Single user, local desktop, plugin only | Defaults are appropriate. Keep the capability switch off except in supervised conversations; keep approval policy other than `never` when risky actions are expected; maintain `allowedDomains` if the agent should stay within specific sites. |
| Single user, pods on the same machine | Compose defaults; dashboard over loopback; MCP client over loopback; noVNC only when you want to watch. Do not expose ports. |
| Remote access to pods | SSH tunnel `-L 8787:127.0.0.1:8787` (and `-L` for the noVNC ports if needed), or a TLS reverse proxy with authentication in front of `/mcp`; keep the container ports loopback-only. |
| Shared/multi-user host | One container per user or tenant, separate `data` volumes, separate containers rather than merely separate pods; firewall the host ports; treat the MCP endpoint as an admin interface. |
| CI / ephemeral tests | Run in a disposable container/VM; `DSH_BROWSER_NO_SANDBOX=1` is acceptable there; no secrets; delete artifacts afterwards. |
| Untrusted browsing | Prefer a pod over the local plugin; disable or tightly scope named profiles; consider disabling recording or handling artifacts as sensitive; watch the live view when actions matter. |
