# Positioning: one tool contract, two execution bodies

This repository ships two things that both drive a browser:

| Component | What it is | Where it runs |
|---|---|---|
| **`dsh-browser-use`** (repository root) | DeepSeek Harness (DSH) plugin: a per-session browser controller with numbered observations, query reads, and a deterministic safety layer | Inside the DSH host, next to the user |
| **`browser-pods`** (`mcp/`) | MCP server: containerised Xvfb + Chromium + noVNC pods, Playwright driver, video/trace archiving | Anywhere Docker runs, behind an MCP endpoint |

They overlap only at the surface: both can open a page, observe it, act on it, and produce
evidence. They do **not** overlap at the trust boundary, and that is the whole point.

This document explains how the two are meant to be used together, and which one should own
which responsibility when both are available to an agent.

---

## 1. Decision rule

> Use the **plugin** when the browser can be trusted and the agent needs to be cheap and
> precise. Use a **pod** when the browser cannot be trusted, must be isolated, must be
> watched by a human, or must be replayable afterwards.

| Signal | Plugin (local) | Pod (MCP) |
|---|---|---|
| Target site is your own / a known intranet | ✅ | ✅ (if isolation wanted) |
| Target site is arbitrary internet content | ⚠️ allowed, but no OS isolation | ✅ container boundary |
| Task must keep a logged-in session | ✅ named profile + isolated profile | ✅ named profile in pod volume |
| Need a human watching / taking over | ✅ `browser_session action=show` (real window) | ✅ noVNC live view |
| Need video or trace for audit | ❌ | ✅ `video.webm` + `trace.zip` |
| Need many concurrent browsers | ❌ (max 3 per session) | ✅ (`PODS_MAX`, default 6) |
| Need zero extra services | ✅ (no Docker, no Playwright) | ❌ Docker required |
| Need low token cost per step | ✅ numbered refs, ~200–450 tokens/observe | ⚠️ Playwright-level snapshots are larger |
| Client is not DSH (Claude Code, Cursor, …) | ❌ DSH-only | ✅ any MCP client |
| Untrusted content + logged-in account | ❌ same OS user | ✅ isolation boundary |

When both are available in one DSH session, pick **one provider per task** and say so in the
session title. Mixing `browser_*` (plugin) and `mcp__browser-pods__*` tools in one task is
allowed but confusing; the recommended composition is the attach mode below.

---

## 2. Architecture: brain and body

```text
                 ┌───────────────────────── DSH session ─────────────────────────┐
                 │                                                               │
  agent  ───────▶│  dsh-browser-use (brain)                                      │
                 │    · observation model (numbered refs)                        │
                 │    · deterministic safety layer + approval seam               │
                 │    · query reads / evidence                                   │
                 │    · CDP client ───────────────┐                              │
                 └────────────────────────────────┼──────────────────────────────┘
                                                  │ CDP (WebSocket)
                        ┌─────────────────────────▼─────────────────────────┐
                        │ body: local Chrome/Edge    OR    browser-pods pod │
                        │ · isolated user-data-dir        · Xvfb+Chromium   │
                        │ · user can see the window       · noVNC live view │
                        │ · dies with the session         · video + trace   │
                        └───────────────────────────────────────────────────┘
```

The plugin deliberately does not depend on Playwright, Docker, or the MCP SDK: its value is
the **observation and safety layer**, not the process supervision. The pod deliberately does
not implement approval, refs, or query reads: its value is **isolation, observability, and
multi-tenancy**. Keeping these responsibilities apart is why the two can share a contract
without sharing a codebase.

---

## 3. The shared tool contract

Both sides implement the same four-step loop. Names differ because the transports differ;
semantics do not.

| Step | Plugin tool | MCP tool | Shared semantics |
|---|---|---|---|
| Open | `browser_open` | `browser_open` | returns a session/pod handle + page target; profile is isolated per session by default |
| Observe | `browser_observe` | `browser_snapshot` (a11y YAML) | returns a bounded, numbered/structured view; acting without a fresh observation is refused by the plugin |
| Act | `browser_act` | `browser_click` / `browser_type` / `browser_press` / `browser_eval` / `browser_navigate` / `browser_wait` | one action per call where possible; result reports what changed |
| Evidence | `browser_evidence`, `browser_read` | `browser_screenshot`, `browser_text`, `browser_console`, `browser_network`, `browser_artifacts` | stable, machine-readable artefacts; screenshots are files, not base64 blobs |
| Close | `browser_session action=close` | `browser_close` | idempotent; pod archives video/trace on close |

Shared error semantics:

- **Refusals are structured** (`ok: false`, stable `code`, human `message`, actionable
  `guidance`) rather than bare exceptions, so a model can recover without guessing.
- **Freshness matters**: acting on a stale observation/token is refused, not guessed.
- **TLS certificate failures are explicit**: the pod returns a hint to retry with
  `ignore_cert_errors: true` (opt-in, per session); the plugin's safety layer keeps its own
  URL policy independent of certificates.
- **No silent side effects**: downloads of executables are refused by default; password
  typing is refused by the plugin; pods are the only place where raw playback lives.

---

## 4. Attach mode: pods as the body, plugin as the brain

The pod already exposes each session's `cdp_url`. The plugin's CDP client only needs a
WebSocket endpoint and a page target, so the natural composition is:

```text
1. mcp__browser-pods__browser_open  → { session_id, cdp_url, live_view_url }
2. browser_open({ cdp_url })        → plugin attaches to the pod's Chromium
3. browser_observe / browser_act    → low-token observation + approval + safety layer
4. mcp__browser-pods__browser_close → archives video + trace
```

What this buys:

- **Isolation without losing ergonomics.** Untrusted sites run in the container; the agent
  still gets numbered refs, query reads, and the deterministic safety layer.
- **One safety model.** The plugin remains the only component that asks for approval; the
  pod stays a dumb, well-instrumented body.
- **Auditable sessions.** The pod records video/trace; the plugin writes its audit log.
  Correlate by session id.

Status: `browser_open({ cdp_url })` is **not implemented in the plugin yet** (the pod side is
already there and used by external drivers). Until then, use the pod's own driver tools
(`browser_snapshot` / `browser_click`) and accept the higher token cost, or use the plugin
with a local browser.

Design constraints for attach mode, when implemented:

- The plugin must not spawn its own Chromium when given `cdp_url`.
- The plugin must not assume it can kill the browser: closing a session only detaches;
  archiving stays the pod's job.
- `browser_session` must report `mode: "attached"` and surface the pod's `live_view_url` so a
  human can take over.
- Certificate policy is decided by whoever launched the browser. Attached mode inherits the
  pod's `ignore_cert_errors` setting and must say so in the tool result.

---

## 5. Non-goals

- **Not an agent framework.** Neither component decides *what* to do; they expose
  primitives to a harness/model. There is no built-in LLM loop.
- **Not a hosted service.** `browser-pods` is self-hosted; there is no cloud offering.
- **Not a Playwright MCP clone.** Playwright MCP is an excellent generic driver and was an
  inspiration for the accessibility-snapshot approach; this repository's differentiator is
  the DSH-native observation/safety layer plus a self-hosted pod lifecycle with recording.
- **Not a replacement for browser-use (the Python project).** Same problem space, different
  integration point (DSH plugin + MCP, not a Python agent library). See CREDITS.

---

## 6. Roadmap

| Horizon | Item | Why |
|---|---|---|
| Near | Plugin `browser_open({ cdp_url })` attach mode + `browser_session` attached state | completes the brain/body story; lets DSH agents use pods with low token cost |
| Near | Share this document's contract table as JSON fixtures in both test suites | keeps tool semantics honest across two implementations |
| Mid | Optional `engine: "pod"` shortcut in the plugin (calls MCP server if configured) | one-line switch for users running both |
| Mid | Pod "profile handoff" (export/import a named profile between local and pod) | logged-in workflows without copying a daily profile |
| Far | Streaming observation (DOM diff over CDP) shared by both drivers | lower token cost for long sessions |
| Far | Signed artifact manifests for pods (tamper-evident trace/meta) | audit-grade replay |

---

## 7. Open questions

1. Should attach mode register the plugin as the `browserUse` provider seam for the whole
   DSH host, or stay a per-session tool surface? (Current plugin intentionally does not take
   the provider seam to coexist with other browser plugins.)
2. When a pod is attached, should the plugin's approval prompts show the `live_view_url`
   inline so the human can watch before approving? This seems strictly better, pending UI
   work in the client half.
3. Do we ship a single Docker image with the MCP server and a "remote DSH host" profile, or
   keep the pod strictly MCP-only? MCP-only keeps the blast radius small.
