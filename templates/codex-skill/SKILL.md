---
name: cograph-connect
description: Use Cograph MCP for indexed repos, generated wiki pages, code symbols, file ranges, and markdown collections. The server-side playbook (delivered in `initialize`) is the source of truth — read it once per session and follow it.
---

# Cograph

The hosted Cograph deployment ships an **operator-tunable, ACL-aware
playbook** in the MCP `initialize` response (the FastMCP
`instructions=` payload). It tells you:

- Which repositories and collections this user can see.
- How to plan a question: routing → outline → retrieve → search_code,
  with the per-tool decision tree pinned to the L1 / L2 / L3 schema
  on every tool description.
- The "≥3 distinct approaches before giving up" rule and the 8-call
  ceiling.
- Cite-or-bust against the `provenance` block.
- Any operator-specific briefing (domain terms, freshness caveats,
  which service owns which surface) — admins edit this live at
  `/admin?tab=mcp`.

**Read the `instructions` payload once per session and follow it.**
Do not duplicate decision logic here that the server already covers —
the server-side text is rendered fresh on every `initialize` and is
guaranteed to match the live tool surface; anything in this file is a
snapshot that drifts.

## Re-fetching the playbook mid-session

Two MCP resources expose the same state out of band if your context
gets compacted or you want to confirm something without a full
`initialize`:

- `cograph://briefing` — the operator briefing (just the deployment-
  specific guidance).
- `cograph://my-context` — the ACL-aware "where am I" list of repos
  and collections this user can see.

Read these on demand. They are cheap.

## When something looks wrong

The few cases the server-side playbook can't preempt — surface them
to the user rather than guessing:

- **`401` / Bearer required** — the stored PAT expired or was
  rotated. Re-run `cograph-connect setup` with a fresh token that
  carries the `mcp` and `api:read` scopes.
- **`403` / `INSUFFICIENT_SCOPE`** — token is valid but missing a
  scope; re-run setup with both `mcp` and `api:read`.
- **`502` / `504`** — hosted backend is unhealthy or finishing an
  index pass. Wait and retry; never silently fall back to local grep
  or a web search.
- **`REPO_NOT_READY`** — the repo's index is rebuilding (status not
  `ready`). The server admits this is transient; ask the user to
  wait or pick a different repo.
- **0 results after three distinct attempts** — the playbook tells
  you exactly what to say: "I don't have enough information in this
  Cograph instance to answer." Use that wording verbatim. Do not
  improvise.

## What this stub deliberately does NOT include

Earlier versions of this file duplicated the server's decision tree,
trust matrix, and tool catalog. That was a maintenance trap — every
playbook change shipped server-side had to be mirrored here, and the
two surfaces drifted within weeks. The single source of truth lives
in `backend/app/mcp/instructions.py` on the cograph backend; this
file just points you at it.
