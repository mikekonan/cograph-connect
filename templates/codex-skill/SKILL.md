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
| Don't know the slug yet? | `cograph.repositories` | Required first call before any repository-scoped tool. Slug is `host/owner/name`. |
| What repos / collections exist? | `cograph.repositories`, `cograph.collections` | Cheap. Start here when the target is unspecified. |
| What is repo X about? | `cograph.repository_readme(slug)` | One call. Falls back to wiki Overview. |
| What's in this repo / collection? | `cograph.outline(repository=…)` or `cograph.outline(collection_id=…)` | Token-cheap structural preview before any heavy search. |
| Find a class / function / symbol by name | `cograph.search_code` | Returns names + line ranges, no body. |
| Where is feature X implemented? | `cograph.retrieve(mode='code')` | Excerpts + citations. |
| What does the wiki say about X? | `cograph.retrieve(mode='wiki')` | Same engine, wiki only. |
| Code AND wiki together | `cograph.retrieve(mode='mixed')` | Only when target unclear. |
| Read this code node fully | `cograph.read_node(node_id)` | After search. Pass `with_summary=true` only if you need the AST summary. |
| Read lines 100–200 of foo.py | `cograph.read_file_range(slug, path, start_line, end_line)` | Capped at 1000 lines. |
| Trace callers / callees of a node | `cograph.related` | See dedicated section below — this is the graph differentiator. |
| Find chunks in a collection | `cograph.collection_search` | Excerpts. |
| Read one chunk fully | `cograph.read_chunk` | After `cograph.collection_search`. |
| Inspect a wiki page | `cograph.collection_document` (md collection) or wiki resource via `cograph://repo/{host}/{owner}/{name}/wiki/{slug}` | |

## First-call checklist

Before the first scoped call, you almost always need a repo slug. Skipping
this step is the single most common cause of avoidable errors:

- **`"repository_id is required"`** — `cograph.retrieve`, `cograph.search_code`,
  `cograph.outline`, `cograph.read_node`, `cograph.read_file_range`, and
  `cograph.related` all require a `repository` argument. Call
  `cograph.repositories` first and pass the full slug (`host/owner/name`,
  e.g. `pgw.dev/svc/walle`).
- **`401` / Bearer required** — the locally stored PAT has expired or was
  rotated. Ask the user to re-run `cograph-connect setup` with a fresh
  token that carries the `mcp` and `api:read` scopes.
- **`502` / `504`** — the hosted Cograph backend is unhealthy or finishing
  an index pass. Wait and retry; do not silently fall back to local grep.
- **`403` / `INSUFFICIENT_SCOPE`** — token is valid but missing a scope;
  re-run setup with both `mcp` and `api:read`.
- **`NOT_FOUND`** from `cograph.repository_readme` — repo has no README and
  no wiki Overview indexed yet; suggest the user re-sync.

## Trust matrix (what's ground truth vs generated)

| Layer | What `retrieve`/`read_node` returns | Ground truth? | When to use |
|---|---|---|---|
| `code` | Raw source code excerpts | ✅ Yes | Always when the question is about *what the code does*. |
| `ast` | Symbol metadata (qualified name, line range) | ✅ Yes | Symbol-exact lookups; navigation. |
| `ast_summary` | **LLM-generated** prose summary of a node | ⚠️ Generated, may lag | Quick first-pass onboarding only. Verify against `code` before quoting. |
| `repo_doc` (wiki) | **LLM-generated** repo documentation | ⚠️ Generated, may lag | Architecture overviews, "what is service X". Never quote as behavioral truth without confirming against `code`. |

If a question hinges on exact behaviour (status codes, conditions,
fallback rules, bug investigations), always read the code itself. Use
generated layers for orientation, not as authoritative citations.

## `cograph.related` — graph traversal

The feature that makes this a *code graph* tool, not just RAG. Use after
you've located a node via `cograph.search_code` or `cograph.retrieve`.

- `direction`: `callers` (who calls this), `callees` (what this calls), or
  `both`.
- `depth`: 1 for immediate neighbours; ≤ 5 for transitive trace. Cost
  grows roughly linearly with depth — start at 1, expand only if needed.
- Use cases: "what breaks if I change this function", "who handles event
  X end-to-end", "trace fallback decisions across a service".
- Prefer `related` over repeated text searches: graph edges catch
  call-by-interface and dependency-injection paths that grep misses.

## Typical flow

One reliable chain that covers most investigations:

1. `cograph.repositories` → pick the slug.
2. `cograph.outline(repository=…)` or `cograph.repository_readme(slug)` →
   orient yourself in the package layout before any search.
3. `cograph.retrieve(repository=…, query=…, mode='code')` → find candidate
   nodes; pick the most relevant.
4. `cograph.read_node(repository=…, node_id=…)` → full body with citation.
5. `cograph.related(repository=…, node_id=…, direction='both', depth=1)`
   → expand to neighbours instead of re-running a text search.

For cross-service traces (e.g. a payment flow spanning multiple repos),
run step 3 in parallel across each repo's slug, then merge by symbol
name.

## Response envelope (search-style tools)

Every retrieval tool returns:

```jsonc
{
  "results": [
    {
      "layer": "code",
      "snippet": "≤ snippet_chars characters",
      "content_truncated": true,
      "provenance": {
        "file_path": "src/auth/middleware.py",
        "start_line": 42,
        "end_line": 58,
        "node_id": "uuid-or-null",
        "document_id": "uuid-or-null",
        "heading_path": ["…"]
      }
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
- See the First-call checklist above for `401` / `403` / `502` / `504` /
  `NOT_FOUND` handling.

## Always

- Quote provenance (`file_path:start-end`, wiki slug, document_id) in
  your answer.
- Prefer `cograph.read_node` / `cograph.read_chunk` over re-running a
  search to get exact citations.
- One question = one search call when feasible. Use `cograph.outline` /
  `cograph.repository_readme` to bootstrap context instead of chained
  retrievals.
