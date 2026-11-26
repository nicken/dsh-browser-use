# Deployment forms

Status: **implemented (unreleased), form C1 phases 1–2** — 2026-11-21. Forms A and B are unchanged;
form C is now available through `DSH_BROWSER_ENGINE=pod|auto`: the plugin creates a pod through the
browser-pods REST API and drives it over CDP. `browser(open, cdp_url)` attach mode also works
standalone. Phases 3–4 (UX polish, CI compose e2e) remain open.

The same browser capability can be delivered in three ways. They differ in **who owns the
browser** and in **what the model sees**.

| Form | What is installed | Model-visible tools | Browser runs in |
|---|---|---|---|
| **A. Plugin only** | `dsh-browser-use` (DSH plugin) | `browser` (1 facade tool; the 6 granular `browser_*` tools behind the advanced switch) | Local Edge/Chrome on the DSH host |
| **B. MCP only** | `browser-pods` (MCP server) | `mcp__browser-pods__*` (16 tools) | Container pod (Xvfb + Chromium) |
| **C. Plugin + pods, integrated** | Both; engine configured in the Browser tab (`engine.json`) or env | Same as A — the model never sees MCP tools | Local *or* pod, chosen per session |

A and B work today. C is the interesting one: it gives the model **one browser object** while
letting the operator choose isolation, live view and recording without changing the tool surface.

---

## Why C is worth building

- **One thing to enable.** The user turns on one capability (`browserUse`) and the agent gets one
  browser tool surface. No "should I enable the MCP or the plugin?" decision at session start.
- **One safety model.** The plugin's deterministic safety layer (http(s)-only navigation, refs,
  approval, password/download refusals, pause) stays authoritative. The pod is a dumb, isolated
  body, so safety does not fork into two implementations.
- **Isolation on demand.** Untrusted pages, parallel agents, or auditable runs can move to a pod
  without teaching the model a second API.
- **Observability on demand.** Pods already record `video.webm` + `trace.zip` and expose a noVNC
  live view. In form C the plugin simply surfaces `live_view_url` in `browser_session status`.

---

## Recommended design (C1): plugin as the engine router

```text
agent ──► browser_* tools (DSH plugin, unchanged surface)
              │
              ├─ engine=local ──► spawn local Edge/Chrome (today's path)
              │
              └─ engine=pod ───► browser-pods REST (control plane)
                                   │  POST /api/pods → { id, cdp_url, live_view_url }
                                   ▼
                            pod Chromium ◄── CDP attach (observe/act/read/evidence)
                                   │
                                   └─ DELETE /api/pods/{id} on close → video + trace archived
```

Key properties:

1. **Control via REST, driving via CDP.** The plugin already speaks CDP; it does not need to
   implement MCP. `browser-pods` already exposes the needed REST calls:
   - `POST /api/pods` `{ label, owner, profile?, ttl_minutes? }` → `201` with `describePod`
     (`id`, `cdp_url`, `live_view_url`, `mode`, `ignore_cert_errors`, …);
   - `DELETE /api/pods/{id}?reason=...` → stop + archive;
   - `GET /api/pods` for reconciliation.
2. **Attach mode first.** `browser_open({ cdp_url })` opens the same `BrowserInstance` against an
   existing CDP endpoint instead of spawning Chromium. Close only detaches; the pod owns its
   lifecycle and archiving.
3. **Configuration** (env or DSH plugin settings, all optional):
   | Setting | Default | Meaning |
   |---|---|---|
   | `BROWSER_ENGINE` / `engine` | `local` | `local`, `pod`, or `auto` |
   | `BROWSER_POD_URL` / `pod.url` | `http://127.0.0.1:8787` | browser-pods control plane |
   | `BROWSER_POD_TOKEN` / `pod.token` | empty | Bearer token when `MCP_TOKEN` is set |
   | `BROWSER_POD_PROFILE` / `pod.profile` | empty | handed to `POST /api/pods` |
   | `BROWSER_POD_TTL_MIN` / `pod.ttlMinutes` | server default | passed through |
   | `BROWSER_POD_KEEP` / `pod.keep` | false | leave the pod running after close (debugging) |
4. **`auto` heuristic** (nice to have): pod when the target is not in the operator allowlist or
   when the session asks for isolation (`browser_open({ isolated: true })`); local otherwise.
   Start with explicit `local`/`pod`; add heuristics only after the explicit path is stable.
5. **Failure semantics.** `pod_unavailable` (control plane unreachable), `pod_auth` (401),
   `pod_exhausted` (no slots), `pod_attach_failed` (CDP refused). Each refusal carries guidance;
   with `engine=auto`, a failed pod falls back to local and says so in the result.
6. **Secrets.** The pod token is read from env/settings and never echoed in tool output, audit
   lines or the client UI. The status route reports only `tokenConfigured: true/false`.

### Why not C2 (plugin speaks MCP)

Implementing an MCP client inside the plugin means adding a protocol dependency (or hand-rolling
JSON-RPC + SSE) for no functional gain: the plugin needs pod *control* and page *driving*, not the
MCP tool surface. REST + CDP is smaller, easier to test, and keeps the plugin dependency-free.

### Why not C3 (provider seam)

Registering the plugin as the host-wide `browserUse` provider would fight other browser plugins and
require host changes. The plugin deliberately does not claim that seam today.

---

## Implementation plan

| Phase | Change | Tests |
|---|---|---|
| 1 | Plugin: `browser_open({ cdp_url })` attach mode, `browser_session` reports `mode: attached`, close only detaches | integration: attach to a Chromium started by the test, observe/act, detach leaves it running |
| 2 | Plugin: pod control client + engine config + refusal codes + status fields | unit: fake pod HTTP server (201/401/409); integration: fake pod that returns a real CDP endpoint |
| 3 | Docs + UX: README "choose a form", `browser_session` shows `pod_id` / `live_view_url` | docs links, manual smoke |
| 4 (optional) | CI e2e job: `docker compose up` pods + plugin attach | compose + one test |

Phase 1 is useful on its own: it also lets the plugin drive any externally started Chrome
(`--remote-debugging-port=9222`), which several users have asked for.

---

## Open questions

1. Should a pod created by the plugin be closed on session end, on DSH shutdown, or left for the
   pod's idle TTL? Proposal: close on `browser_session close` and on DSH shutdown; TTL as backstop.
2. How should pod profiles map to plugin profiles? A plugin profile currently means "isolated
   local user-data-dir"; pods have their own named profiles. Proposal: `pod.profile` only, no
   automatic translation.
3. Should `browser_evidence` screenshots be uploaded into the pod archive so that one artifact
   bundle contains both? Proposal: yes eventually (pod API needs an upload endpoint).
4. Multi-agent sharing: one pod per DSH session, or allow attaching an existing pod id? Proposal:
   allow `browser_open({ pod_id })` in phase 2 for explicit sharing.
