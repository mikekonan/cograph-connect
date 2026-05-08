# Changelog

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
