# dear-claude

**Trigger local Claude Code instances from external platforms when "dear-claude" is mentioned.**

Works with Linear, Gmail, and GitHub - mention `dear-claude` in a comment or issue, and a Claude Code instance spins up to handle it.

## Features

- **🎫 Linear** - Mention in issue comments/descriptions → Claude works on the ticket
- **📧 Gmail** - Reply with `dear-claude` → Claude processes the email thread
- **🐙 GitHub** - Comment on issues/PRs → Claude reviews or implements
- **🔄 Persistent Sessions** - 7-day instance lifecycle with context preservation
- **🔌 MCP Integration** - Full Model Context Protocol support

## Quick Start

### 1. Install

```bash
# Run directly
bunx dear-claude start

# Or install globally
bun install -g dear-claude
dear-claude start
```

### 2. Add to Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "dear-claude": {
      "command": "bunx",
      "args": ["dear-claude", "start", "--mcp"],
      "env": {
        "LINEAR_ACCESS_TOKEN": "lin_api_...",
        "LINEAR_WEBHOOK_SECRET": "your-webhook-secret"
      }
    }
  }
}
```

> **Note:** Tailscale Funnel setup is automatic on first run. The server will guide you through installation and authentication if needed.

### 3. Configure Platform Webhooks

Once the server starts, it will display your public Tailscale URL. Configure webhooks in each platform:

**Linear:**
- Go to Settings → API → Webhooks
- Add webhook URL: `https://your-hostname.ts.net/webhook/linear`

**GitHub:**
- Go to Settings → Webhooks
- Add webhook URL: `https://your-hostname.ts.net/webhook/github`

**Gmail:**
- Requires Google Cloud Pub/Sub setup (see OAuth Setup below)

## Tailscale Funnel (Automatic Setup)

This server uses Tailscale Funnel for stable, free public URLs to receive webhooks.

**First-time setup is guided:**

1. **Install Tailscale** (if not installed):
   ```bash
   # macOS
   brew install tailscale

   # Linux
   curl -fsSL https://tailscale.com/install.sh | sh
   ```

2. **Authenticate** - Server auto-runs `tailscale up` and opens your browser

3. **Enable Funnel** - Visit the URL shown in terminal (one-time admin step)

The server handles the rest automatically.

## Environment Variables

### Tailscale (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `TAILSCALE_HOSTNAME` | auto-detected | Override Tailscale hostname |
| `DEAR_CLAUDE_PORT` | `3334` | Local HTTP server port |

### Linear

| Variable | Description |
|----------|-------------|
| `LINEAR_CLIENT_ID` | OAuth client ID (for setup flow) |
| `LINEAR_CLIENT_SECRET` | OAuth client secret |
| `LINEAR_WEBHOOK_SECRET` | Webhook signature verification |
| `LINEAR_ACCESS_TOKEN` | API token (skip OAuth if set) |

### Gmail

| Variable | Description |
|----------|-------------|
| `GOOGLE_CLIENT_ID` | OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_ACCESS_TOKEN` | Access token (skip OAuth if set) |
| `GOOGLE_REFRESH_TOKEN` | Refresh token |
| `GOOGLE_PUBSUB_TOPIC` | Pub/Sub topic for push notifications |

### GitHub

| Variable | Description |
|----------|-------------|
| `GITHUB_CLIENT_ID` | OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | OAuth App client secret |
| `GITHUB_WEBHOOK_SECRET` | Webhook signature verification |
| `GITHUB_ACCESS_TOKEN` | Personal access token (skip OAuth if set) |

## OAuth Setup

For platforms requiring OAuth, start the server and visit the setup URLs:

```bash
dear-claude start
```

Then visit:
- **Linear:** `https://your-hostname.ts.net/setup/linear`
- **Gmail:** `https://your-hostname.ts.net/setup/gmail`
- **GitHub:** `https://your-hostname.ts.net/setup/github`

## Usage

### Trigger Format

Mention `dear-claude` (or `dear claude`) anywhere in:
- Linear issue descriptions or comments
- GitHub issue/PR comments
- Gmail email replies

### Example

**Linear Issue Comment:**
```
dear-claude please review this PR and check for security issues
```

**Claude Response:**
```
🤖 Claude instance started (abc123)

I'll review the PR for security issues. Analyzing now...

[After analysis]

Found 2 potential issues:
1. SQL injection vulnerability in user.ts:45
2. Missing input validation in api.ts:102

I've created a draft PR with fixes. Please review.
```

## CLI Commands

```bash
# Start server
dear-claude start

# Start as MCP server (stdio mode)
dear-claude start --mcp

# Check status
dear-claude status

# List instances
dear-claude instances

# View instance logs
dear-claude logs <instance-id>
```

## MCP Tools

When running as an MCP server, these tools are available:

| Tool | Description |
|------|-------------|
| `list_instances` | List all Claude instances |
| `get_instance_status` | Get detailed instance status |
| `get_instance_messages` | Get conversation history |
| `kill_instance` | Terminate a running instance |
| `get_running_instances` | List currently running instance IDs |

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Linear    │     │   GitHub    │     │   Gmail     │
│  Webhooks   │     │  Webhooks   │     │  Pub/Sub    │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       └───────────────────┼───────────────────┘
                           │
                           ▼
               ┌───────────────────────┐
               │   Tailscale Funnel    │
               │  (Public HTTPS URL)   │
               └───────────┬───────────┘
                           │
                           ▼
               ┌───────────────────────┐
               │    dear-claude        │
               │    MCP Server         │
               │   (port 3334)         │
               │                       │
               │  • Trigger detection  │
               │  • Instance manager   │
               │  • Platform adapters  │
               └───────────┬───────────┘
                           │
                           ▼
               ┌───────────────────────┐
               │    Claude Code        │
               │    Instances          │
               │   (spawned on demand) │
               └───────────────────────┘
```

## Instance Lifecycle

1. **PENDING** - Trigger detected, instance queued
2. **RUNNING** - Claude Code actively processing
3. **IDLE** - Waiting for follow-up mentions
4. **COMPLETED** - Task finished successfully
5. **FAILED** - Error occurred
6. **EXPIRED** - 7-day TTL exceeded

## Troubleshooting

### Tailscale Issues

**"Tailscale not running"**
- macOS: Open the Tailscale app from Applications
- Linux: `sudo systemctl start tailscaled && tailscale up`

**"Funnel not enabled"**
- Visit the URL shown in the terminal to enable Funnel
- Or go to https://login.tailscale.com/admin/acls and add Funnel capability

### Webhook Issues

**Webhooks not triggering**
1. Check `dear-claude status` to verify server is running
2. Verify webhook URL in platform settings matches your Tailscale URL
3. Test with `curl https://your-hostname.ts.net/health`

**"Invalid signature" errors**
1. Verify webhook secret matches in both platform and environment
2. Check the raw webhook body isn't being modified by proxies

### Instance Issues

**Instance stuck in PENDING**
1. Check `dear-claude logs <id>` for errors
2. Verify Claude Code is installed and accessible
3. Check working directory permissions

## Development

```bash
# Clone
git clone https://github.com/your-repo/dear-claude
cd dear-claude

# Install
bun install

# Run dev mode
bun run dev

# Type check
bunx tsc --noEmit
```

## License

MIT
