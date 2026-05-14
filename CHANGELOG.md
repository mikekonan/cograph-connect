# Changelog

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
