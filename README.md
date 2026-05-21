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

Per client. Claude Code and Cursor get direct HTTP with an inline Bearer
header. Codex also uses direct HTTP, but the token is bound through
`bearer_token_env_var` plus Codex's own `[shell_environment_policy.set]`
block because Codex does not apply inline `bearer_token = "..."` as an
Authorization header. Claude Desktop's config validator only accepts stdio,
so for that one we shell out through the `mcp-remote` bridge:

| Client | Config file | MCP entry shape | SKILL.md |
|---|---|---|---|
| Claude Code (`claude-code`) | `~/.claude.json` | `{ type: "http", url, headers: { Authorization: "Bearer …" } }` | `~/.claude/skills/cograph-connect/` |
| Cursor (`cursor`) | `~/.cursor/mcp.json` | `{ url, headers: { Authorization: "Bearer …" } }` | — |
| Codex (`codex`) | `~/.codex/config.toml` | `[shell_environment_policy.set] COGRAPH_TOKEN = "…"` + `[mcp_servers.cograph]` with `url` + `bearer_token_env_var = "COGRAPH_TOKEN"` | `~/.codex/skills/cograph-connect/` |
| Claude Desktop (`claude`) | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) | `npx -y mcp-remote <url> --header "Authorization: Bearer …"` with `env: { NODE_OPTIONS: "--use-system-ca" }` | — |

### Why Claude Desktop is special

Claude Desktop's `claude_desktop_config.json` schema accepts only stdio
MCP servers (`command` + `args`). Writing a `{ type: "http", url, headers }`
entry there produces a startup warning:

> The following entries in `claude_desktop_config.json` are not valid MCP
> server configurations and were skipped: cograph

For that one client, `setup` writes a thin stdio bridge via the community
[`mcp-remote`](https://github.com/geelen/mcp-remote) package. The
`NODE_OPTIONS=--use-system-ca` env makes its Node read the OS keychain so
internal hosts behind a corporate CA (e.g. `*.internal.example.com`) verify out
of the box.

The official Anthropic alternative for remote MCP in Claude Desktop is
**Settings → Connectors** (the GUI flow). That's separate from
`cograph-connect` and managed by your Anthropic account, not this tool.

## Token Storage

- Source of truth: `~/.config/cograph-connect/config.json` (mode `0600`,
  directory mode `0700`). Updated by `cograph-connect setup`.
- JSON clients store the token inline as `Authorization: Bearer …`.
- Codex stores the token in `~/.codex/config.toml` under
  `[shell_environment_policy.set]` and references it from
  `[mcp_servers.cograph]` via `bearer_token_env_var`.
- These files inherit the user's default permissions — restrict if needed.

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

- **0.3.x** routed every client through a local `cograph-connect mcp`
  proxy launched by `npx`. 0.4.x dropped that.
- **0.4.x – 0.5.x** kept the npx-based `mcp-remote` bridge for *every*
  JSON client (including Claude Code and Cursor, where it wasn't needed)
  and stored the Codex PAT in a `COGRAPH_TOKEN_<PROFILE>` shell env var
  referenced via `bearer_token_env_var`.

0.6.x narrowed the npx bridge to **Claude Desktop only** (the one client
whose config schema actually requires stdio) but incorrectly inlined the
Codex token directly in `config.toml`. 0.8.x migrates Codex back to
`bearer_token_env_var` and writes the matching token into
`[shell_environment_policy.set]`. Re-running setup migrates both:

```bash
npx -y cograph-connect@latest setup
```

`setup` actively detects legacy entries and rewrites them:

- Any `npx -y mcp-remote …` block in a Claude Code or Cursor config →
  replaced with `{ type: "http", url, headers }` and reported as
  `removed legacy npx mcp-remote bridge`. (Claude Desktop keeps its
  bridge — that's not legacy there.)
- Any inline `bearer_token = …` line in `~/.codex/config.toml` →
  replaced with `bearer_token_env_var = "COGRAPH_TOKEN"` plus
  `[shell_environment_policy.set] COGRAPH_TOKEN = "…"`, and reported as
  `removed legacy inline bearer_token`.

Old `.bak.*` files preserve the previous state. Restart each client to
pick up the new config.

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
