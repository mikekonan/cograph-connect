# Cograph Connect

Connect Cograph to local agent clients through MCP and Codex skills.

```bash
npx -y cograph-connect setup
```

The setup command stores your Cograph URL and token locally, validates the
remote `/mcp/` endpoint, and configures Claude Desktop, Claude Code,
Cursor, and Codex to launch a local stdio MCP proxy.

## What It Installs

- A local stdio MCP proxy named `cograph`, pinned to the installed
  `cograph-connect` version so launches are reproducible.
- MCP server entries in each selected client's config (see paths below).
- A SKILL.md for clients that have a skill loader (Codex and Claude Code).

Per client:

| Client | MCP config | SKILL.md |
|---|---|---|
| Claude Desktop (`claude`) | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) | — |
| Claude Code (`claude-code`) | `~/.claude.json` | `~/.claude/skills/cograph-connect/` |
| Cursor (`cursor`) | `~/.cursor/mcp.json` | — |
| Codex (`codex`) | `~/.codex/config.toml` | `~/.codex/skills/cograph-connect/` |

The Cograph token is stored outside client configs:

- macOS/Linux: `~/.config/cograph-connect/config.json`
- Windows: `%APPDATA%/cograph-connect/config.json`

On POSIX systems the config directory is written as `0700` and the config file
as `0600`.

## Token Scopes

Create a Cograph personal access token with:

- `mcp`
- `api:read`

## Commands

```bash
cograph-connect setup [--url <url>] [--token <token>] [--profile <name>] \
                      [--clients claude,claude-code,cursor,codex] [-y] \
                      [--no-validate] [--no-skill]
cograph-connect status --check
cograph-connect config print
cograph-connect mcp --profile default
```

- `setup` prompts for any missing fields. `-y` is non-interactive and
  **requires** both `--url` and `--token` — there is no localhost
  default, to avoid CI footguns.
- `--no-validate` skips the MCP `tools/list` round-trip against the
  remote — useful when configuring offline.
- `--no-skill` skips SKILL.md install for clients that support it.

Use `COGRAPH_CONNECT_TOKEN` to override the stored token for a single
command (handy for ad-hoc runs without touching `config.json`).

## Upgrading from `gitnexus`

Earlier installs used the legacy npm package name `gitnexus`. On `setup`,
any existing `mcpServers.gitnexus` entry (JSON clients) or
`[mcp_servers.gitnexus]` block (Codex TOML) is detected, the file is
backed up, and the legacy entry is removed in favour of the new
`cograph` entry. You'll see a `removed legacy gitnexus MCP entry` line
in the setup output when this happens.

## Troubleshooting

### "Authorization: Bearer <token> is required" / 401

PAT in `~/.config/cograph-connect/config.json` is expired or rotated.
Re-run `cograph-connect setup` with a fresh token. Verify with
`cograph-connect status --check`.

### 502 / 504 from the hosted endpoint

The Cograph backend is unhealthy or finishing an index pass. Wait and
retry. `status --check` confirms when it's back.

### `repository_id is required`

An agent called `cograph.retrieve` / `search_code` / `outline` /
`read_node` / `read_file_range` / `related` without a `repository`
argument. The SKILL.md tells agents to call `cograph.repositories`
first; if you see this in agent traces, the agent skipped that step.

### "Failed to reconnect to claude.ai Cograph"

This is **not** cograph-connect. Claude Code can also register Cograph
as an Anthropic-account *connector* via the claude.ai web UI; that's a
separate OAuth-managed integration. cograph-connect installs a local
stdio proxy with a long-lived PAT. If you want to remove the
account-connector entry, do it in `claude.ai → Settings → Connectors`.

### Two entries on `tools/list` (`mcp__gitnexus__*` and `mcp__cograph__*`)

You have the legacy `gitnexus` npm package and `cograph-connect`
installed in parallel. Run `npm uninstall -g gitnexus` and re-run
`cograph-connect setup` to clear legacy entries (it backs files up
automatically).

### Hosted vs self-hosted Cograph

`cograph-connect` is transport-agnostic — point `--url` at whichever
Cograph instance you're entitled to (hosted, internal, or local
`http://localhost:8080`). The token must be valid for that instance.
