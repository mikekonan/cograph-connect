# Changelog

## 0.4.1

Polish on the 0.4.0 architecture change. Setup's validation warning is now
a single line — the multi-paragraph VPN / corporate-CA / 502 / proxy
explanation got dropped. In 0.4.0 the runtime path for Cursor, Codex, and
Claude Code is direct HTTP from each client (their own TLS stacks), so
the local Node-side validation hint set was misleading more often than
helpful. Cause-chain unwinding and Bearer redaction are unchanged.

## 0.4.0

Breaking: dropped the local stdio MCP proxy. `setup` now writes direct
remote-HTTP entries straight into each client's config — no `cograph-connect
mcp` runtime, no second Node process, no custom TLS stack.

### Per-client output

| Client | Transport | Notes |
|---|---|---|
| Claude Code | `type: "http"`, inline `Authorization` header | Native HTTP MCP. No proxy. |
| Cursor | `url` + inline `Authorization` header | Native HTTP MCP. No proxy. |
| Codex | TOML with `url` + `bearer_token_env_var` | Codex reads token from `COGRAPH_TOKEN_<PROFILE>` env var — `setup` prints the `export …` line for the user's shell rc. Token is **not** written into `config.toml`. |
| Claude Desktop | `npx -y mcp-remote <url> --header "Authorization: Bearer …"` + `env: { NODE_OPTIONS: "--use-system-ca" }` | Claude Desktop's config schema is stdio-only (confirmed by [Anthropic Help](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) and several bug reports). Setup falls back to the community `mcp-remote` stdio→HTTP bridge. The `NODE_OPTIONS=--use-system-ca` env makes its Node trust the OS keychain (closes the corporate-CA hole). |

### Removed

- `cograph-connect mcp` subcommand and `src/proxy.ts`. The package no longer
  runs an MCP server itself. Anything still launching `npx -y --
  cograph-connect@<old> mcp …` will break — re-run `cograph-connect setup`
  on the new version to rewrite client configs.
- `PINNED_PACKAGE_SPEC` constant and the version-pinned npx invocation. Not
  needed now that we are not the server. Pin still applies to `mcp-remote`
  via npx's normal version-spec rules (we let npx resolve `mcp-remote`
  without a pin so `--prefer-offline` cache reuse works after first run).

### Why this is the right move

- Eliminates the npx-on-every-launch DNS to `registry.npmjs.org` for the
  three clients that don't need a stdio bridge.
- Eliminates the Node-bundled-CA-store problem for those three clients —
  Cursor, Codex, and Claude Code use the OS trust store via their own HTTP
  stacks. Internal hosts behind a private CA (e.g. `*.pgw.internal`) work
  out of the box for them.
- Token still has a single source of truth in
  `~/.config/cograph-connect/config.json`. `setup` reads it and writes it
  inline (Claude Code, Cursor, Claude Desktop bridge) or by env-var-name
  reference (Codex). Token rotation = `cograph-connect setup` once, every
  client picks up the new value.

### Caveats

- Token is now present in plaintext in the JSON files for Claude Desktop /
  Code / Cursor. Equivalent exposure to the previous
  `~/.config/cograph-connect/config.json` if the user owns the home
  directory, but worth knowing. Codex avoids this via env var.
- Claude Desktop still spawns `npx mcp-remote`, so the npm-registry DNS
  dependency persists for that one client. Setting `NODE_OPTIONS=
  --use-system-ca` in its `env` block addresses the bigger pain — private
  CA TLS verification.

### Upgrade path from 0.3.x

1. `npx -y cograph-connect@0.4.0 setup` — overwrites `mcpServers.cograph` /
   `[mcp_servers.cograph]` entries in every selected client with the new
   shape. Existing files are backed up automatically.
2. For Codex: copy the printed `export COGRAPH_TOKEN_<PROFILE>=…` line into
   your shell rc (`~/.zshenv` or equivalent) and reload the shell.
3. Restart each client so it picks up the new config.

## 0.3.2

UX fix for the `fetch failed` wall users hit on `setup` when their Cograph
hostname is unreachable (VPN off, hosted backend briefly 502/504, corporate
proxy). Setup now writes the profile and client configs anyway and prints a
warning with the real cause and recovery steps. Re-run `cograph-connect setup`
or just `cograph-connect status --check` once connectivity is back.

- `setup` no longer aborts when remote validation fails. The profile is saved
  and every selected client is configured. A final `Warning:` block names the
  underlying cause and gives a targeted next step based on the error code:
  - TLS (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `SELF_SIGNED_CERT_IN_CHAIN`,
    `DEPTH_ZERO_SELF_SIGNED_CERT`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`,
    `CERT_UNTRUSTED`) → suggest `NODE_EXTRA_CA_CERTS` and warn that MCP
    clients launching the proxy need the same env var.
  - `CERT_HAS_EXPIRED` → flag as a backend issue.
  - `ENOTFOUND` → VPN / hostname typo.
  - `ECONNREFUSED` → wrong port / nothing listening.
  - `ECONNRESET` / `ETIMEDOUT` → corporate proxy or firewall.
  - Anything else → generic VPN / private-host / 502 / proxy explanation.
  All cases point to `cograph-connect status --check` for re-verification.
- Errors raised from MCP transport now propagate their full `cause` chain.
  Previously the CLI surface only showed `TypeError: fetch failed` with no
  hint at the actual failure. Affects `setup`, `status --check`, and any
  future fetch-backed command.
- Bug fix: `--no-validate` and `--no-skill` were silently ignored in 0.3.0
  and 0.3.1. commander parses `--no-X` flags into `options.X = false`, but
  the action handler read `options.noValidate` / `options.noSkill` (always
  `undefined`). Both flags now actually skip the corresponding step.
- Behaviour change for CI: `setup` against an unreachable URL now exits
  `0` (with a warning) instead of `1`. Pipelines that relied on the exit
  code to gate "did the URL validate" should switch to
  `cograph-connect status --check`, which remains strict (exits `1` on
  failure with the full cause chain).
- User-facing instructions are unchanged. `npx -y cograph-connect setup`
  still walks through the same prompts and writes to the same paths.

## 0.3.1

Hotfix for npm 11 `npx` argument parsing — 0.3.0 (and every prior version)
wrote a proxy invocation that `npm exec` no longer accepts, so MCP clients
that re-resolved the bin would fail with `Unknown command:
"cograph-connect"`. Re-run `cograph-connect setup` after upgrading.

- `mcpServerConfig` now emits `npx --yes -- cograph-connect@<ver> mcp
  --profile <p>` instead of `npx -y cograph-connect@<ver> mcp …`. npm 11.x
  requires the long `--yes` flag and a `--` separator before the package
  spec; the short `-y` form is silently consumed and the package spec is
  interpreted as an npm subcommand.
- Same fix applied to Codex TOML output.
- New test asserts the `--yes` / `--` shape so future regressions break
  the build.

## 0.3.0

Multi-client + skill fan-out, legacy `gitnexus` migration, version-pinned
proxy, expanded SKILL.md.

- New `claude-code` client target. `setup` now writes the MCP entry into
  `~/.claude.json` under `mcpServers.cograph` and installs the SKILL.md
  to `~/.claude/skills/cograph-connect/`. Previously Claude Code users
  had to edit `~/.claude.json` by hand.
- Skill installer fans out: same canonical `templates/codex-skill/SKILL.md`
  is copied to every selected client that has a skill loader (Codex,
  Claude Code). Claude Desktop and Cursor are silently skipped — they
  have no skill surface.
- Legacy `gitnexus` MCP entries are detected and removed during `setup`,
  in both JSON clients (`mcpServers.gitnexus`) and Codex TOML
  (`[mcp_servers.gitnexus]`). Backups are still written. Setup prints a
  notice when a legacy entry is replaced.
- The proxy command written into client configs is now pinned to the
  installed `cograph-connect` version (`npx -y cograph-connect@<ver> mcp`).
  Removes the supply-chain hole where `npx` could resolve a newer
  unvalidated release at launch.
- Dropped the `http://localhost:8080` default URL under `-y`. `-y` is
  now strictly non-interactive: requires `--url` and `--token`. Removes
  the CI footgun where a missing `--url` silently pointed at a
  non-existent local server.
- `SKILL.md` gains a First-call checklist (`repository_id is required`,
  401, 502/504, 403, NOT_FOUND), a trust matrix
  (`code`/`ast`=ground-truth vs `ast_summary`/`wiki`=generated), a
  dedicated `cograph.related` section, and a Typical-flow chain
  (`repositories → outline → retrieve → read_node → related`).
- Proxy prints a `→ run cograph-connect status --check` hint when the
  upstream connection fails, so end users have a single command to
  diagnose token / network / scope issues.
- README rewritten: per-client install paths, upgrade-from-`gitnexus`
  note, troubleshooting section covering 401/502, hosted vs
  account-connector Cograph (the `claude.ai Cograph` 502 confusion),
  and `repository_id is required` for agent traces.

## 0.2.1

Sync with the current Cograph MCP surface and drop the three hardcoded
`0.1.0` strings still in the source. CLI behaviour is unchanged.

- `cograph-connect --version`, the MCP client identifier sent to the
  remote server, and the local stdio server's name all now read from
  `package.json` instead of a literal `0.1.0`. Easier to spot the
  client version in remote logs after future bumps.
- `templates/codex-skill/SKILL.md`:
  - Added `cograph.related(repository, node_id, depth, direction)` to
    the decision table — the backend ships it but the previous skill
    file omitted it.
  - Fixed the wiki resource URI from
    `cograph://repo/{slug}/wiki/{page-slug}` to the actual template
    `cograph://repo/{host}/{owner}/{name}/wiki/{slug}` (backend uses
    the host/owner/name shape, not the repo slug).
- `package-lock.json` patch bumps: `@types/node` 24.12.2 → 24.12.4,
  `vitest` 4.1.5 → 4.1.6.

## 0.2.0

Requires a Cograph backend with the rewritten MCP surface (server commit
`bb0cfa5` and later — the one that renamed `cograph.node` to
`cograph.read_node` and added `cograph.repository_readme`,
`cograph.read_file_range`, `cograph.outline`).

- Rewrote `templates/codex-skill/SKILL.md` with a tool-selection table,
  the search-style envelope, and explicit failure rules.
- New tool surface available to agents:
  - `cograph.repository_readme(slug)` — one-shot README/Overview fetch
    with wiki fallback.
  - `cograph.read_file_range(slug, path, start_line, end_line)` —
    direct line-range reader, capped at 1000 lines.
  - `cograph.outline(repository=… | collection_id=…)` — token-cheap
    structural preview before any heavy retrieval.
  - `cograph.read_node` (renamed from `cograph.node`); the heavy graph /
    summary / linked-doc fan-out is now opt-in via `with_graph`,
    `with_summary`, `with_linked_docs`.
- `cograph.retrieve` gained `mode` (`code` / `wiki` / `mixed`) and
  `snippet_chars`; the dedicated `cograph.search` tool was removed.
- Search-style responses now carry `total_tokens_estimate` and a
  `content_truncated` flag per hit so agents can self-budget.

### Compatibility

A 0.2.0 client connected to a pre-`bb0cfa5` Cograph server will see the
new tools 404 with “tool not found”. The skill file says so and asks the
agent to surface the gap rather than fall back silently.

## 0.1.0

Initial release: `cograph-connect setup` for Claude Desktop, Cursor,
and Codex; profile-aware config; templates/codex-skill/SKILL.md
six-bullet starter.
