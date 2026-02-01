# dear-claude

MCP server that triggers local Claude Code instances from external platforms (Linear, Gmail, GitHub) when "dear-claude" is mentioned.

## Quick Start

```bash
# Install dependencies
bun install

# Start the server
bun run start

# Check status
bun run src/index.ts status

# List instances
bun run src/index.ts instances
```

## Architecture

- **Trigger Detection**: Matches `/dear[- ]?claude/i` pattern
- **Instance Lifecycle**: `PENDING → RUNNING → COMPLETED/IDLE → EXPIRED` (7-day persistence)
- **Platform Adapters**: Linear, Gmail, GitHub with OAuth + webhooks
- **MCP Tools**: `list_instances`, `get_instance_status`, `kill_instance`

## Environment Variables

```bash
DEAR_CLAUDE_PORT=3334
TAILSCALE_HOSTNAME=  # Optional: auto-detected from Tailscale if not set

# Linear
LINEAR_CLIENT_ID=
LINEAR_CLIENT_SECRET=
LINEAR_WEBHOOK_SECRET=
LINEAR_ACCESS_TOKEN=

# Gmail/Google
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_ACCESS_TOKEN=
GOOGLE_REFRESH_TOKEN=
GOOGLE_PUBSUB_TOPIC=

# GitHub
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_WEBHOOK_SECRET=
GITHUB_ACCESS_TOKEN=
```

## Tailscale Setup

This server uses Tailscale Funnel for public webhook URLs.

1. Install Tailscale: `brew install tailscale` (macOS) or see https://tailscale.com/download
2. Authenticate: `tailscale up`
3. Enable Funnel in admin console: https://login.tailscale.com/admin/acls (add "funnel" capability)

## Development

```bash
# Type check
bunx tsc --noEmit

# Build
bun run build

# Run dev mode
bun run dev
```

## Conversation History

Previous implementation conversation saved at: `.claude/conversation.jsonl`
