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
cograph-connect setup
cograph-connect status --check
cograph-connect config print
cograph-connect mcp --profile default
```

Use `COGRAPH_CONNECT_TOKEN` to override the stored token for one command.
