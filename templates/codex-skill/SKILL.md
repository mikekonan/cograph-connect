---
name: cograph-connect
description: Use Cograph MCP when answering questions about indexed repositories, generated wiki pages, code search, markdown collections, architecture, or project documentation available through Cograph.
---

# Cograph Connect

Use the configured Cograph MCP server for questions about indexed repositories,
generated wiki pages, code graph context, markdown collections, architecture,
and project documentation.

## Workflow

- Start by listing available repositories or collections when the target is not explicit.
- Prefer precise Cograph tools/resources over broad filesystem or web searches.
- Preserve provenance from Cograph responses in your answer when available.
- If Cograph returns an authorization error, ask the user to run `cograph-connect setup` with a token that has `mcp` and `api:read` scopes.
