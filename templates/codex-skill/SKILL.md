---
name: cograph-connect
description: Use Cograph MCP for indexed repos, generated wiki pages, code symbols, file ranges, and markdown collections. Picks the right tool to keep the response token-cheap and provenance-anchored.
---

# Cograph

Cograph indexes repositories, wiki pages, and markdown collections. Use the
configured MCP server for any question that maps to one of those four
surfaces. Bias toward the tool that returns the smallest answer that still
covers the question — every search-style tool returns excerpts plus a
`content_truncated` flag, not full bodies.

## Decision tree

| Question | Tool | Notes |
|---|---|---|
| What repos / collections exist? | `cograph.repositories`, `cograph.collections` | Cheap. Start here when the target is unspecified. |
| What is repo X about? | `cograph.repository_readme(slug)` | One call. Falls back to wiki Overview. |
| What's in this repo / collection? | `cograph.outline(repository=…)` or `cograph.outline(collection_id=…)` | Token-cheap structural preview before any heavy search. |
| Find a class / function / symbol by name | `cograph.search_code` | Returns names + line ranges, no body. |
| Where is feature X implemented? | `cograph.retrieve(mode='code')` | Excerpts + citations. |
| What does the wiki say about X? | `cograph.retrieve(mode='wiki')` | Same engine, wiki only. |
| Code AND wiki together | `cograph.retrieve(mode='mixed')` | Only when target unclear. |
| Read this code node fully | `cograph.read_node(node_id)` | After search. Pass `with_summary=true` only if you need the AST summary. |
| Read lines 100–200 of foo.py | `cograph.read_file_range(slug, path, start_line, end_line)` | Capped at 1000 lines. |
| Find chunks in a collection | `cograph.collection_search` | Excerpts. |
| Read one chunk fully | `cograph.read_chunk` | After `cograph.collection_search`. |
| Inspect a wiki page | `cograph.collection_document` (md collection) or wiki resource via `cograph://repo/{slug}/wiki/{page-slug}` | |

## Response envelope (search-style tools)

Every retrieval tool returns:

```jsonc
{
  "results": [
    {
      "snippet": "≤ snippet_chars characters",
      "content_truncated": true,
      "citation": { "file_path": "...", "start_line": 42, "end_line": 58 },
      "repository_slug": "github.com/owner/name"
    }
  ],
  "total_tokens_estimate": 2840,
  "mode": "code"
}
```

If `total_tokens_estimate` exceeds your budget, drop `top_k` or pass a
smaller `snippet_chars` (default 600, range 80–4000) before retrying.

## Failure rules

- 0 results from `mode='code'` → try `mode='mixed'` once. If still empty,
  say so. Do **not** silently fall back to filesystem grep or web search.
- `content_truncated=true` and you need full text → `cograph.read_node`
  (code) or `cograph.read_chunk` (md collection).
- 403 / `INSUFFICIENT_SCOPE` → ask the user to re-run
  `cograph-connect setup` with a token carrying both `mcp` and
  `api:read` scopes.
- `NOT_FOUND` from `cograph.repository_readme` → the repo has no README
  and no wiki Overview indexed yet; suggest the user re-sync.

## Always

- Quote provenance (`file_path:start-end`, wiki slug, document_id) in
  your answer.
- Prefer `cograph.read_node` / `cograph.read_chunk` over re-running a
  search to get exact citations.
- One question = one search call when feasible. Use `cograph.outline` /
  `cograph.repository_readme` to bootstrap context instead of chained
  retrievals.
