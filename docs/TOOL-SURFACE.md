# Tool surface: fewer capability switches, same power

Status: **implemented** (2026-11-21, unreleased). The default surface is one facade `browser` tool;
the six granular tools are registered only when `browserUseAdvanced` is on. `dsh-computer-use`
applies the same pattern (`computer` includes `action:"screenshot"`; `computer_screenshot` is
advanced-only).

## The problem

The DSH capability panel counts tools per plugin. Users see:

- `browser-use`: **6** capabilities (`browser_open`, `browser_observe`, `browser_act`,
  `browser_read`, `browser_session`, `browser_evidence`)
- `computer-use`: **2** capabilities (`computer`, `computer_screenshot`)

Two problems follow:

1. **Too many switches for a binary decision.** The user's real choice is "may the agent use a
   browser / the desktop in this session?" — not which of six primitives to enable.
2. **No obvious starting point.** A newcomer cannot tell whether `browser_read` alone is useful,
   or which subset is safe. Enabling all six is the only sane choice, which makes the toggles
   noise.

## Options considered

### Option A — one facade tool by default, granular tools behind an "advanced" switch (**recommended**)

- Default capability (`browserUse` / `computerUse`) registers **one** tool:
  - browser: `browser` with `action`: `open | observe | act | read | session | evidence`;
  - computer: `computer` with `action`: `screenshot | move | click | …` (screenshot folded in,
    accepting the existing `screen` / `region` / `scale` arguments).
- Panel shows **1** capability per plugin. The model gets one object, which also matches the
  deployment-forms goal ("one browser use object").
- A second, opt-in switch (`browserUseAdvanced` / `computerUseAdvanced`) re-registers the
  granular tools and hides the facade, for power users and scripts that depend on tool names.
- Approval and audit keep the existing internal tool identity (`browser_act`, `computer`) so risk
  routing does not change; only the model-facing name is unified.

Trade-offs:

- One larger JSON schema per plugin. Mitigation: `action` enum with per-action field descriptions,
  and short examples in the description. Refusals already return actionable `code`/`guidance`.
- Tool cards in the DSH client must render a generic card by `action` instead of one card per
  tool. The client half already renders from `presentationMeta`, so this is a small change.
- Existing automation that calls `browser_open` etc. must either enable the advanced switch or
  switch to `browser({action:"open"})`. Since the project is at its first open-source release,
  now is the cheapest moment to do this; the advanced switch keeps old names working.

### Option B — split by scenario (read-only vs control)

- browser: `browserRead` (observe/read/evidence) + `browserControl` (open/act/session);
  computer: `computerObserve` (screenshot) + `computerControl` (input).
- Pros: safety-first default (enable observation only), clear risk boundary.
- Cons: two switches instead of one (the user still has to choose), two tool sets in the model
  context, and the same tool would live in different sets depending on the scenario. Doesn't meet
  the "one object" goal; more documentation rather than less.

### Option C — keep tools, improve the panel

Not in this repository's control: the capability panel is a separate DSH plugin. We could ship
description strings that explain usage, but the counts stay 6 and 2. Doesn't solve the complaint.

## Recommendation

Adopt **Option A**:

| Plugin | Default (1 switch → 1 tool) | Advanced (1 switch → N tools) |
|---|---|---|
| browser-use | `browser({ action })` | the current 6 `browser_*` tools |
| computer-use | `computer({ action })` including screenshot | `computer` + `computer_screenshot` |

Name the advanced switches clearly in the client UI (`高级：暴露细分工具` / "Advanced: expose
granular tools") and default them to off. Keep the JSON schemas in the same file as today; the
facade is a thin dispatcher over the existing handlers, so the risk and approval paths are reused
verbatim.

## Implementation checklist

1. `index.js`: build a single tool registration that dispatches by `action` to the existing
   handlers; register granular tools under the advanced `when` predicate.
2. Capability store: add `browserUseAdvanced` / `computerUseAdvanced` to the per-session record
   (the store is shared and already preserves unknown fields, so this is additive).
3. Client half: one tool card per plugin that renders from `presentationMeta` (action + result),
   plus the second switch in the capability panel and the tab.
4. Tests: facade dispatch (each action reaches the right handler and refusal code), advanced flag
   registers granular tools, capability store round-trip; update the integration tests to use the
   facade.
5. Docs: README "Tools" section rewritten around actions, migration note, CHANGELOG entry.
6. Backwards compatibility: `browser_open` etc. remain available when advanced is on; document
   that scripts should enable it or migrate.

## Open questions

1. Should the advanced switch be per session (like the main switch) or per agent preset? Per
   session is consistent with the current store; presets can set it later.
2. Tool name for the facade: `browser` reads well in transcripts but collides conceptually with
   `mcp__browser-pods__*`. Alternative: `browser_use`. Proposal: `browser` and `computer`, matching
   the plugin names.
3. Do we keep the old names in the default surface as aliases for one release? Proposal: no —
   aliases would bring the count back to 6. Advanced switch is the compatibility path.
