# Cograph Connect

Connect Cograph to local agent clients through MCP and skill files.

```bash
npx -y cograph-connect setup
```

`setup` stores your Cograph URL and token locally, validates the remote
`/mcp/` endpoint, and writes a direct remote-HTTP MCP entry into each
selected client's config. No local proxy, no second Node process, no
custom TLS stack — clients talk to Cograph directly over their own HTTP
stacks.

## What It Installs

Per client — **every client gets the same direct-HTTP shape**. No npx, no
local proxy, no env-var dance:

| Client | Config file | MCP entry shape | SKILL.md |
|---|---|---|---|
| Claude Desktop (`claude`) | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) | `{ type: "http", url, headers: { Authorization: "Bearer …" } }` | — |
| Claude Code (`claude-code`) | `~/.claude.json` | `{ type: "http", url, headers: { Authorization: "Bearer …" } }` | `~/.claude/skills/cograph-connect/` |
| Cursor (`cursor`) | `~/.cursor/mcp.json` | `{ url, headers: { Authorization: "Bearer …" } }` | — |
| Codex (`codex`) | `~/.codex/config.toml` | `[mcp_servers.cograph]` with `url` + `bearer_token = "<pat>"` | `~/.codex/skills/cograph-connect/` |

The official Anthropic alternative for remote MCP in Claude Desktop is
**Settings → Connectors** (the GUI flow). That's separate from
`cograph-connect` and managed by your Anthropic account, not this tool.

## Token Storage

- Source of truth: `~/.config/cograph-connect/config.json` (mode `0600`,
  directory mode `0700`). Updated by `cograph-connect setup`.
- The same token is written **inline** into every client's config file as
  a literal `Authorization: Bearer …` value (JSON clients) or
  `bearer_token = "…"` line (Codex TOML). These files inherit the user's
  default permissions — restrict if needed.

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
```

- `setup` prompts for any missing fields. `-y` is non-interactive and
  **requires** both `--url` and `--token`.
- `--no-validate` skips the MCP `tools/list` round-trip against the
  remote — useful when configuring offline. (Setup never aborts on
  validation failure; the profile and client configs are saved either
  way, with a warning explaining the cause.)
- `--no-skill` skips SKILL.md install for clients that support it.

Use `COGRAPH_CONNECT_TOKEN` to override the stored token for a single
`status --check` / validation run.

## Upgrading from `gitnexus`

Earlier installs used the legacy npm package name `gitnexus`. On `setup`,
any existing `mcpServers.gitnexus` entry (JSON clients) or
`[mcp_servers.gitnexus]` block (Codex TOML) is detected, the file is
backed up, and the legacy entry is removed in favour of the new
`cograph` entry.

## Upgrading from older versions

Previous versions used two transports that we've since dropped:

- **0.3.x** — every client launched a local `cograph-connect mcp` proxy
  via `npx`.
- **0.4.x – 0.5.x** — Claude Desktop went through the community
  `mcp-remote` stdio→HTTP bridge (also `npx`), and Codex stored its PAT
  in a `COGRAPH_TOKEN_<PROFILE>` shell env var referenced via
  `bearer_token_env_var`.

Re-running setup migrates both:

```bash
npx -y cograph-connect@latest setup
```

That actively detects legacy entries — any `npx -y mcp-remote …` block
in a JSON config and any `bearer_token_env_var = …` line in
`~/.codex/config.toml` — and rewrites them to the new direct-HTTP shape
with the token inlined. Old `.bak.*` files preserve the previous state.
Restart each client to pick up the new config; you can drop any
`export COGRAPH_TOKEN_…=…` lines from your shell rc.

## Troubleshooting

### Setup ends with `Warning: could not validate remote Cograph MCP — …`

The profile and client configs were saved anyway. The warning prints the
underlying cause and a targeted hint. Common cases:

- **`getaddrinfo ENOTFOUND …`** — DNS. Usually means VPN is not
  connected, or the URL has a typo.
- **`UNABLE_TO_GET_ISSUER_CERT_LOCALLY` / `SELF_SIGNED_CERT_IN_CHAIN`** —
  TLS chain not trusted by Node. The local validation step uses Node's
  bundled CA store. Fix:
  - Quick check: `NODE_OPTIONS=--use-system-ca cograph-connect status --check`.
    On Node 22+, this reads the OS keychain (covers corporate CAs you
    already have installed in macOS Keychain / Windows certificate
    store).
  - Or `NODE_EXTRA_CA_CERTS=/path/to/ca.pem cograph-connect status --check`.
  - The runtime clients (Cursor, Codex, Claude Code) use their own HTTP
    stacks and OS trust store, so they typically work without further
    action even when local Node validation fails.
- **`ECONNREFUSED`** — wrong port / nothing listening.
- **HTTP 401** — token expired or scope-mismatch (`mcp`, `api:read`
  required).
- **HTTP 502 / 504** — backend reindexing; retry in a minute.

### `repository_id is required`

An agent called `cograph_retrieve` / `cograph_search_code` /
`cograph_outline` / `cograph_read_node` / `cograph_read_file_range` /
`cograph_related` without a `repository` argument. The SKILL.md tells
agents to call `cograph_repositories` first; if you see this in agent
traces, the agent skipped that step.

### "Failed to reconnect to claude.ai Cograph"

That's the Anthropic-account **Custom Connector** for Cograph (managed
via `claude.ai → Settings → Connectors`), not `cograph-connect`. The two
are independent — you can have either, both, or neither.

### Two entries on `tools/list` (`mcp__gitnexus__*` and `mcp__cograph__*`)

You have the legacy `gitnexus` npm package and `cograph-connect`
installed in parallel. Run `npm uninstall -g gitnexus` and re-run
`cograph-connect setup` to clear legacy entries.
