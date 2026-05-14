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

Per client:

| Client | Config file | MCP entry shape | SKILL.md |
|---|---|---|---|
| Claude Code (`claude-code`) | `~/.claude.json` | `{ type: "http", url, headers: { Authorization: "Bearer …" } }` | `~/.claude/skills/cograph-connect/` |
| Cursor (`cursor`) | `~/.cursor/mcp.json` | `{ url, headers: { Authorization: "Bearer …" } }` | — |
| Codex (`codex`) | `~/.codex/config.toml` | `[mcp_servers.cograph]` with `url` + `bearer_token_env_var = "COGRAPH_TOKEN_<PROFILE>"` | `~/.codex/skills/cograph-connect/` |
| Claude Desktop (`claude`) | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) | `npx -y mcp-remote <url> --header "Authorization: Bearer …"` with `env: { NODE_OPTIONS: "--use-system-ca" }` | — |

### Why Claude Desktop is special

Claude Desktop's `claude_desktop_config.json` schema accepts only stdio MCP
servers (`command` + `args`); it has no native field for a remote HTTP URL.
For that one client, `setup` writes a thin stdio bridge via the community
[`mcp-remote`](https://github.com/geelen/mcp-remote) package. The
`NODE_OPTIONS=--use-system-ca` env makes its Node read the OS keychain so
internal hosts behind a corporate CA (e.g. `*.pgw.internal`) verify out of
the box.

The official Anthropic alternative for remote MCP in Claude Desktop is
**Settings → Connectors** (the GUI flow). That's separate from
`cograph-connect` and managed by your Anthropic account, not this tool.

## Token Storage

- Source of truth: `~/.config/cograph-connect/config.json` (mode `0600`,
  directory mode `0700`). Updated by `cograph-connect setup`.
- The same token is written **inline** into the JSON configs of Claude
  Code, Cursor, and Claude Desktop (since their schemas accept a literal
  `Authorization: Bearer …` value). These files inherit the user's
  default permissions — restrict if needed.
- For **Codex**, the token is *not* written into `config.toml`. Codex
  reads it from an env var. `setup` prints the exact line to add to your
  shell rc, e.g.:

  ```bash
  export COGRAPH_TOKEN_DEFAULT='cgr_pat_…'
  ```

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

## Upgrading from 0.3.x → 0.4.x

0.3.x configured every client to launch a local `cograph-connect mcp`
proxy via `npx`. 0.4.x dropped the proxy entirely. To migrate:

```bash
npx -y cograph-connect@latest setup
```

That re-writes every `mcpServers.cograph` entry into the new direct-HTTP
shape. Old `.bak.*` files preserve the previous state. Restart each
client to pick up the new config. For Codex, also add the printed
`export COGRAPH_TOKEN_<PROFILE>=…` line to your shell rc.

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

### Codex doesn't pick up the token

`config.toml` only contains an env-var *name*, not the token. Codex reads
the actual value from your shell environment at request time. Verify:

```bash
echo $COGRAPH_TOKEN_DEFAULT   # should print your PAT
```

If empty, add the `export` line to `~/.zshenv` (loaded by every shell on
login, including the one Codex inherits) and reload.

### `repository_id is required`

An agent called `cograph.retrieve` / `search_code` / `outline` /
`read_node` / `read_file_range` / `related` without a `repository`
argument. The SKILL.md tells agents to call `cograph.repositories`
first; if you see this in agent traces, the agent skipped that step.

### "Failed to reconnect to claude.ai Cograph"

That's the Anthropic-account **Custom Connector** for Cograph (managed
via `claude.ai → Settings → Connectors`), not `cograph-connect`. The two
are independent — you can have either, both, or neither.

### Two entries on `tools/list` (`mcp__gitnexus__*` and `mcp__cograph__*`)

You have the legacy `gitnexus` npm package and `cograph-connect`
installed in parallel. Run `npm uninstall -g gitnexus` and re-run
`cograph-connect setup` to clear legacy entries.
