# Cograph Connect

Connect Cograph to local agent clients through MCP and Codex skills.

```bash
npx -y cograph-connect setup
```

The setup command stores your Cograph URL and token locally, validates the
remote `/mcp/` endpoint, and can configure Claude Desktop, Cursor, and Codex
to launch a local stdio MCP proxy.

## What It Installs

- A local stdio MCP proxy named `cograph`.
- Client config entries for Claude Desktop, Cursor, and Codex.
- A Codex skill at `~/.codex/skills/cograph-connect`.

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
                      [--clients claude,cursor,codex] [-y] \
                      [--no-validate] [--no-skill]
cograph-connect status --check
cograph-connect config print
cograph-connect mcp --profile default
```

- `setup` prompts for any missing fields; `-y` accepts defaults
  (`http://localhost:8080`, all clients selected) for unanswered choices.
- `--no-validate` skips the MCP `tools/list` round-trip against the
  remote — useful when configuring offline.
- `--no-skill` skips copying the Codex skill to `~/.codex/skills/`.

Use `COGRAPH_CONNECT_TOKEN` to override the stored token for a single
command (handy for ad-hoc runs without touching `config.json`).
