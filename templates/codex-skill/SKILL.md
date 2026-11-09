---
name: cograph-connect
description: Cograph MCP is a read-only index of the team's repositories and docs. Use for code and docs in team repositories that are not in your working directory, or to search them by meaning. When a subagent does this work, pass it the repository as `host/owner/name`.
---

# Cograph

The Cograph server sends its own short instructions, and each tool's
description carries its rules. This file adds what the server cannot
know: when to reach for Cograph, what to tell a subagent, and what to
tell the user when a call fails.

## When to use it

- Code and docs in team repositories that are not in your working
  directory.
- A search by meaning, when you do not know a name.

If the repository is in your working directory and you know a name,
grep and read the files yourself.

## Subagents

Pass the subagent the repository as `host/owner/name` (for example
`github.com/acme/warehouse`) and put this block in its prompt as is:

```text
Cograph MCP is a read-only index of the team's repositories and docs.
Find with cograph_search_code (one identifier) or cograph_retrieve (a question in words). Results show an excerpt; read the best hit with cograph_read_node(node_id). If a hit is a helper, see its callers; if a test, what it calls: cograph_related.
Stop when you have read the code that answers and can cite it as path:start-end. Do not repeat an identical call. If two different searches find nothing, say what you searched and stop.
If the repository is in your working directory and you know a name, grep and read the files yourself.
```

## When a call fails

Tell the user; do not guess around it.

- **`401`** - the token expired or was rotated. Re-run
  `cograph-connect setup` with a fresh token that has the `mcp` and
  `api:read` scopes.
- **`403` / `INSUFFICIENT_SCOPE`** - the token is valid but lacks a
  scope. Re-run setup with a token that has both `mcp` and `api:read`.
- **`502` / `504`** - the server is unhealthy or busy indexing. Try
  again later.
- **`REPO_NOT_READY`** - the repository is being indexed. Ask the user
  to wait or to pick another repository.
