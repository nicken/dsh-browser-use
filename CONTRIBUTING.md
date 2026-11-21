# Contributing

Thanks for helping improve `dsh-browser-use`. This repository contains two components — the DSH
plugin at the root and the `browser-pods` MCP server under `mcp/` — and contributions to both are
welcome.

Please keep changes focused. A small, well-tested pull request that fixes one problem is much easier
to review than a large one that mixes refactoring, features and formatting.

---

## Ways to contribute

- **Bug reports** with a minimal reproduction: commands, environment (OS, Node version, browser
  version, DSH version), expected vs actual behaviour, and relevant logs with secrets removed.
- **Documentation fixes** — especially places where the docs and the code disagree.
- **Tests** for existing behaviour (the plugin suite and the MCP certificate test are the safest
  places to start).
- **Features** — open an issue first for anything that changes the tool surface, the safety layer,
  the MCP protocol, or the container lifecycle.
- **Platform reports** — the plugin's browser auto-detection is Windows-oriented; reports from
  Linux/macOS users (with `DSH_BROWSER_PATH`) are valuable.

**Security issues:** do not open a public issue with a working exploit. Use the repository's private
vulnerability-reporting channel if available, or contact the maintainers privately first. See
[SECURITY.md](docs/SECURITY.md).

---

## Before you start

1. Search existing issues and pull requests.
2. For non-trivial changes, open an issue describing the problem and the proposed approach, so
   nobody duplicates work or builds the wrong thing.
3. Read [DEVELOPMENT.md](docs/DEVELOPMENT.md) for local setup and [TESTING.md](docs/TESTING.md) for
   how to run the suites.

---

## Development setup

The short version:

```bash
# plugin
npm install
npm run test:unit
xvfb-run -a npm test          # headless Linux; needs Playwright Chromium

# MCP server (Docker recommended; local Node also works)
cd mcp && npm install
xvfb-run -a npm test
docker compose up -d --build
```

Details, prerequisites and debugging tips are in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

---

## Change boundaries

| Area | What belongs there | What to watch out for |
|---|---|---|
| Repository root (`index.js`, `client.js`, `locale/`, `cordis.patch.yml`) | DSH plugin behavior, observation/safety layer, Web UI | Keep the plugin **zero-runtime-dependency**; keep the safety layer deterministic; keep tool names/arguments stable; `additionalProperties: false` for inputs |
| `mcp/` | browser-pods server, MCP tools, pod lifecycle, dashboard, image | Keep the supply/driver split working (`MCP_DRIVER_TOOLS=0` and `=1`); declare tool inputs with zod; serialise pod operations with `withPod`; never kill an external browser on detach |
| `docs/`, root `README*.md`, `mcp/README*.md` | User-facing documentation | Every tool name, argument, environment variable, default and path must match the code |
| `tests/` (root), `mcp/tests/` | Automated tests | Tests must not touch a real `~/.dsh` (use the harness) or require fixed ports/display numbers that collide on CI |

`mcp/` is a **git subtree** with its own history. Small, self-contained fixes can be made here
directly; structural changes should go to the standalone `browser-pods` repository first and be
pulled in by a maintainer with `git subtree pull` (see [DEVELOPMENT.md](docs/DEVELOPMENT.md#the-mcp-subtree)).
Do not convert the subtree into a submodule or re-initialise its history.

---

## Requirements for a pull request

- **Tests:** add or update tests for behavior changes. New refusal codes, tool arguments, MCP tools
  and configuration variables need coverage. If a test cannot run in CI (needs a specific OS,
  browser or display), say so in the PR.
- **CI green:** the `plugin` (Node 22/24) and `mcp` (Node 22) jobs must pass. The `docker` job is
  optional.
- **Docs:** update `README.md`, `README.zh-CN.md`, the relevant file under `docs/`, and/or
  `mcp/README.md` when user-visible behavior changes. When in doubt, update both languages.
- **Safety:** do not weaken the deterministic safety layer (URL admission, password refusal,
  download/upload handoff, DSH-UI guard, approval fail-closed) without an explicit, documented
  rationale and maintainer agreement.
- **Secrets and data:** no tokens, cookies, personal data, internal hostnames/IPs, screenshots of
  private pages, `mcp/data/` contents, `.env` files or profile directories.
- **No drive-by refactors:** keep unrelated formatting/renames out of a behavioral PR.
- **Commits:** small and logically separated; a clear message (see below). Do not force-push shared
  branches.

### Commit messages

Conventional-commit style prefixes are recommended (English or Chinese is fine, be imperative and
specific):

```text
feat(plugin): add a show action to browser_session
fix(mcp): release the profile lock when pod startup fails
docs: correct the noVNC port example
test(plugin): cover password-target refusal
chore: bump playwright devDependency
```

Use a scope when it helps (`plugin`, `mcp`, `docs`, `tests`). Avoid vague messages such as
"updates" or "fix".

---

## Pull request process

1. Fork the repository and create a topic branch (`fix/pause-refusal`, `docs/cert-options`, …).
2. Make the change, add tests and docs, and run the suites you can run locally.
3. Open the PR with:
   - what problem it solves and which component it touches,
   - how it was tested (exact commands / environment),
   - known limitations or follow-ups,
   - screenshots for UI changes, with private data removed.
4. CI will run; fix failures rather than disabling checks.
5. A maintainer reviews. Expect questions about the safety layer, tool-surface compatibility and
   the supply/driver split — they are load-bearing parts of the design.
6. Once approved and green, the maintainer merges. Do not merge your own PR.

Large or cross-cutting PRs may be asked to split along the component boundary (plugin vs `mcp/`) so
each change can be reviewed and, if needed, synced upstream independently.

---

## Code of conduct

Be respectful and constructive. Harassment, discrimination, personal attacks, doxxing and
deliberately hostile behavior are not acceptable in issues, pull requests, reviews or any other
project space. Maintainers may edit or remove contributions and block participants who violate
these expectations. Assume good faith, criticise the code rather than the person, and keep
technical disagreement about the design.

---

## License

By contributing, you agree that your contributions are licensed under the repository's MIT license
(see [LICENSE](LICENSE)).
