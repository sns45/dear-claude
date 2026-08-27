# dear-claude

MCP server that triggers local Claude Code instances from external platforms (Linear, GitHub, Jira, GitLab, Notion, Obsidian) when "Dear Claude" is mentioned.

## Architecture Notes

### Data directory (do NOT use process.cwd())
All persistent state resolves through `getDataDir()` in `src/utils/paths.ts`:

1. `DEAR_CLAUDE_DATA_DIR` (explicit override)
2. `$XDG_DATA_HOME/dear-claude`
3. `~/.local/share/dear-claude` (default)

This holds `dear-claude.db`, `workspaces/`, `contexts/`, and `api-token`.

Never resolve state against `process.cwd()`. A stdio MCP server inherits the working directory of whatever project the client opened, so a cwd relative path creates a stray `data/` folder in every project. That was a real bug, fixed in v1.1.3.

### Two transports
The same tool surface is served two ways:

- **stdio**: `dear-claude start --mcp`. Spawned per Claude Code window.
- **Stateless Streamable HTTP**: `POST /mcp` on the Hono server, mounted by `mountMcpEndpoint()` in `src/mcp.ts`.

The HTTP endpoint runs stateless (`sessionIdGenerator: undefined`), building a fresh `Server` and transport per request, so nothing is shared across requests. Prefer it when running several Claude Code windows: one shared process instead of one per window, which avoids contention on the webhook port.

```json
"dear-claude": {
  "type": "http",
  "url": "http://127.0.0.1:3334/mcp",
  "headers": { "Authorization": "Bearer <dear-claude token>" }
}
```

### stdout is the MCP protocol channel
In `--mcp` mode, `console.log` is redirected to stderr at the top of the `start` action in `src/cli.ts`. Anything written to stdout that is not JSON-RPC corrupts the framing and the client drops the connection with `CONNECTION_CLOSED`. Use `console.error` for any new logging on a code path that can run under stdio.

### Auth and binding
`/api/*` and `/mcp` require a bearer token (`src/utils/auth.ts`). These endpoints can spawn Claude with `bypassPermissions` on this machine, so they must never be open.

- Token source: `DEAR_CLAUDE_API_TOKEN`, else auto generated and persisted at `<dataDir>/api-token` with mode `0600`.
- Print it with `dear-claude token`.
- Send as `Authorization: Bearer <token>` or `x-dear-claude-token`.

Webhook routes are deliberately **not** covered by the token: they verify their own per platform signatures. OAuth callback and setup routes stay open because the identity provider must reach them.

The HTTP server binds `127.0.0.1` by default. Override with `DEAR_CLAUDE_HOST` only if you genuinely need LAN or tunnel exposure.

### Port contention
Every Claude Code window spawns its own stdio process, so port 3334 is contended. A busy port is treated as "another instance owns webhooks" and the server continues in MCP only mode. It is not fatal.

### Tailscale is opt in and non interactive
Server startup never prompts, never launches the Tailscale app, and never opens a browser login. If Tailscale is missing, stopped, unauthenticated, or Funnel is off, the tunnel fails fast with one clear line and the server carries on without a public URL.

Interactive setup lives in its own command: `dear-claude tunnel-setup`. Note the Homebrew `tailscale` CLI can linger after the app is uninstalled, so "binary exists" is not the same as "Tailscale is usable".

## Pending Work

### Agent SDK is far behind
`@anthropic-ai/claude-agent-sdk` is pinned at `^0.2.25` while current is `0.3.x`. No model id is hardcoded anywhere (the SDK inherits the Claude Code default model), so this is not urgent, but the bump needs its own testing pass.

### Integration Testing Needed
These adapters have code and unit tests but have NOT been tested end to end against live platforms:

- **Notion**: `src/adapters/notion-adapter.ts`
- **GitLab**: `src/adapters/gitlab-adapter.ts`
- **Jira**: `src/adapters/jira-adapter.ts`

All three need real webhook and OAuth testing against actual platform instances.

### Gmail/Google (removed)
Gmail support was removed in v1.1.0 because it was incomplete. The adapter file was deleted. Revisiting means rebuilding from scratch.

## Current State (as of Aug 2026)
- **Version**: 1.1.2 in package.json (unreleased fixes on top, see Architecture Notes)
- **Published**: npm + MCP Registry (`io.github.sns45/dear-claude`)
- **Working platforms**: GitHub, Linear, Obsidian (tested end to end)
- **Untested platforms**: Notion, GitLab, Jira (code exists, needs live testing)
- **Branch**: all work merged to `main`

## Development
- Runtime: Bun
- Build: `bun build src/index.ts --outdir dist --target bun`
- Tests: `bun test` (179 tests passing)
- Publish npm: bump version in package.json + server.json, then `npm publish`
- Publish MCP: `mcp-publisher publish` (installed via brew, login with `mcp-publisher login github`)

### Environment variables
| Variable | Purpose |
| --- | --- |
| `DEAR_CLAUDE_DATA_DIR` | Override the data directory |
| `DEAR_CLAUDE_API_TOKEN` | Override the control plane token |
| `DEAR_CLAUDE_HOST` | Bind address (default `127.0.0.1`) |
| `DEAR_CLAUDE_PORT` | HTTP port (default `3334`) |
| `OBSIDIAN_VAULT_PATH` | Enables the Obsidian vault watcher |
| `OBSIDIAN_WATCH_DEBOUNCE_MS` | Watcher debounce (default `2000`) |
