<p align="center">
  <img src="assets/marketing/hero-poster.png" alt="Dear Claude - Just say Dear Claude" width="500">
</p>

<h1 align="center">Dear Claude</h1>

<p align="center">
  <strong>MCP server that triggers local Claude Code instances from external platforms.</strong><br>
  Say "Dear Claude" in Linear, GitHub, Jira, GitLab, Notion, or Obsidian — and a Claude Code instance spins up to handle it.
</p>

<p align="center">
  <em>Your notes become architecture. Your tasks become pull requests.</em>
</p>

---

## What is this?

Dear Claude is an MCP (Model Context Protocol) server that watches your project management tools for the phrase **"Dear Claude"**. When detected, it spawns a local Claude Code instance that:

- Reads the issue/comment/note context
- Executes the requested task (code, review, create tasks, etc.)
- Posts results back to the originating platform
- Persists sessions for 7 days so you can have multi-turn conversations

**No Anthropic API keys needed.** Works with your existing Claude Code subscription. 100% local and private — your code never leaves your machine.

## Supported Platforms

| Platform | Trigger on issue/PR | Trigger on comment | Comment back | Emoji reactions | Sub-tasks | PR/MR review |
|----------|:------------------:|:-----------------:|:------------:|:--------------:|:---------:|:------------:|
| GitHub   | Yes | Yes | Yes | Yes | - | Yes |
| Linear   | Yes | Yes | Yes | Yes | Yes | - |
| Jira     | Yes | Yes | Yes | - | Yes | - |
| GitLab   | Yes | Yes | Yes | Yes | - | Yes |
| Notion   | Yes | Yes | Yes | - | - | - |
| Obsidian | Yes | - | Yes | - | - | - |

## Cross-Platform Orchestration

Instances from **any** platform get API access to **all** configured platforms. This enables workflows like:

1. Write a spec in **Obsidian** → "Dear Claude, create these tasks in Linear"
2. Discuss on **Linear** → "Dear Claude, code this on GitHub"
3. Review on **GitHub** → "Dear Claude, resolve the merge conflicts"
4. **Parallel coding** → Claude spawns multiple instances, one per branch, using git worktrees

## Quick Start

### Install in one line

```bash
claude mcp add dear-claude -- bunx dear-claude start --mcp
```

That's it. Start Claude Code and Dear Claude is ready.

### Prerequisites

- [Claude Code](https://claude.ai/claude-code) CLI installed (`claude` command available)
- [Bun](https://bun.sh) runtime (for `bunx`)
- [Tailscale](https://tailscale.com/download) with Funnel enabled (for webhooks from external platforms)

### Manual setup (alternative)

If you prefer manual configuration, add to `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "dear-claude": {
      "command": "bunx",
      "args": ["dear-claude", "start", "--mcp"],
      "env": {
        "DEAR_CLAUDE_PORT": "3334",
        "GITHUB_CLIENT_ID": "...",
        "GITHUB_CLIENT_SECRET": "...",
        "GITHUB_WEBHOOK_SECRET": "...",
        "LINEAR_CLIENT_ID": "...",
        "LINEAR_CLIENT_SECRET": "...",
        "LINEAR_WEBHOOK_SECRET": "..."
      }
    }
  }
}
```

Then start Claude Code:

```bash
claude
```

The MCP server starts automatically, sets up Tailscale Funnel, and prints your public webhook URLs.

---

## Platform Setup

### Tailscale Funnel

Dear Claude uses [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) for stable public HTTPS URLs to receive webhooks. Setup is mostly automatic.

1. **Install Tailscale**:
   ```bash
   # macOS
   brew install tailscale

   # Linux
   curl -fsSL https://tailscale.com/install.sh | sh
   ```

2. **Authenticate**: `tailscale up`

3. **Enable Funnel** in the admin console: https://login.tailscale.com/admin/acls
   - Add the `"funnel"` capability to your ACL policy

4. The server auto-configures Funnel on startup. Your public URL will be:
   ```
   https://<your-hostname>.ts.net/dc
   ```

> **Tip**: Run `tailscale serve status --json` to verify your config. The health check auto-repairs the Funnel config every 10 seconds.

---

### GitHub

#### Option A: GitHub App (recommended)

1. Go to **GitHub Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**
2. Set these fields:
   - **Homepage URL**: `https://<your-hostname>.ts.net/dc`
   - **Callback URL**: `https://<your-hostname>.ts.net/dc/oauth/callback/github`
   - **Webhook URL**: `https://<your-hostname>.ts.net/dc/webhook/github`
   - **Webhook secret**: generate a random string
3. Under **Permissions**:
   - Repository: Issues (Read & Write), Pull Requests (Read & Write), Contents (Read & Write)
4. Under **Subscribe to events**:
   - Issue comments, Pull request review comments
5. Copy credentials and set env vars:
   ```bash
   GITHUB_CLIENT_ID=Iv1.abc123...
   GITHUB_CLIENT_SECRET=abc123...
   GITHUB_WEBHOOK_SECRET=your-webhook-secret
   ```
6. Install the app on your repos
7. Complete OAuth: visit `https://<your-hostname>.ts.net/dc/setup/github`

#### Option B: Personal Access Token (simpler, no webhooks)

1. Go to **GitHub Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)**
2. Create a token with scopes: `repo`, `write:discussion`
3. Set: `GITHUB_ACCESS_TOKEN=ghp_...`

> **Note**: With a PAT alone you won't get webhook-triggered instances. You'd use the `spawn_instance` MCP tool or `/api/spawn` endpoint instead.

| Environment Variable | Description |
|---------------------|-------------|
| `GITHUB_CLIENT_ID` | GitHub App client ID |
| `GITHUB_CLIENT_SECRET` | GitHub App client secret |
| `GITHUB_WEBHOOK_SECRET` | Webhook signature verification secret |
| `GITHUB_ACCESS_TOKEN` | Personal access token (alternative to OAuth) |

---

### Linear

1. Go to **Linear Settings** → **API** → **OAuth Applications** → **New Application**
2. Set the callback URL: `https://<your-hostname>.ts.net/dc/oauth/callback/linear`
3. Copy **Client ID** and **Client Secret**
4. Enable the **Webhooks** toggle on the OAuth app
5. Go to **Linear Settings** → **API** → **Webhooks** → **New Webhook**:
   - URL: `https://<your-hostname>.ts.net/dc/webhook/linear`
   - Copy the **Signing Secret**
   - Enable events: **Comments** (create), **Issues** (create, update)
6. Set env vars:
   ```bash
   LINEAR_CLIENT_ID=your-client-id
   LINEAR_CLIENT_SECRET=your-client-secret
   LINEAR_WEBHOOK_SECRET=your-signing-secret
   ```
7. Complete OAuth: visit `https://<your-hostname>.ts.net/dc/setup/linear`

After OAuth, only issues/comments from your authenticated Linear account trigger Claude.

**Alternative**: Use a Personal API Key (`LINEAR_ACCESS_TOKEN=lin_api_...`) from Linear Settings → Account → API.

| Environment Variable | Description |
|---------------------|-------------|
| `LINEAR_CLIENT_ID` | OAuth client ID |
| `LINEAR_CLIENT_SECRET` | OAuth client secret |
| `LINEAR_WEBHOOK_SECRET` | Webhook signing secret |
| `LINEAR_ACCESS_TOKEN` | Personal API key (alternative to OAuth) |

---

### Jira Cloud

1. **Create an API token** at https://id.atlassian.com/manage-profile/security/api-tokens
2. Set env vars:
   ```bash
   JIRA_DOMAIN=mycompany              # Your Jira subdomain (mycompany.atlassian.net)
   JIRA_USER_EMAIL=you@example.com    # Your Atlassian account email
   JIRA_API_TOKEN=ATATT3x...          # The API token you just created
   JIRA_WEBHOOK_SECRET=optional-secret # Optional shared secret
   ```
3. **Create a webhook** in Jira:
   - Go to **Jira Admin** → **System** → **Webhooks** → **Create webhook**
   - URL: `https://<your-hostname>.ts.net/dc/webhook/jira`
     - If using `JIRA_WEBHOOK_SECRET`, append it: `?secret=YOUR_SECRET`
   - Select events: `issue_created`, `issue_updated`, `comment_created`
4. Save the webhook

Claude can create sub-tasks, transition issue status, and add comments via the Jira REST API v2.

| Environment Variable | Description |
|---------------------|-------------|
| `JIRA_DOMAIN` | Jira subdomain (e.g. `mycompany` for mycompany.atlassian.net) |
| `JIRA_USER_EMAIL` | Your Atlassian email |
| `JIRA_API_TOKEN` | API token from Atlassian |
| `JIRA_WEBHOOK_SECRET` | Optional shared secret for webhook verification |

---

### GitLab

1. **Create a Personal Access Token** at GitLab → **Settings** → **Access Tokens**
   - Scopes: `api`, `read_repository`, `write_repository`
2. Set env vars:
   ```bash
   GITLAB_ACCESS_TOKEN=glpat-...
   GITLAB_WEBHOOK_SECRET=your-secret
   ```
3. **Add a webhook** to your project (or group):
   - Go to **Settings** → **Webhooks**
   - URL: `https://<your-hostname>.ts.net/dc/webhook/gitlab`
   - Secret token: same as `GITLAB_WEBHOOK_SECRET`
   - Trigger events: **Comments**, **Issues events**, **Merge request events**
4. Save

For self-hosted GitLab, also set `GITLAB_URL=https://your-gitlab-instance.com`.

| Environment Variable | Description |
|---------------------|-------------|
| `GITLAB_ACCESS_TOKEN` | Personal access token |
| `GITLAB_WEBHOOK_SECRET` | Webhook secret token |
| `GITLAB_URL` | GitLab instance URL (default: `https://gitlab.com`) |

---

### Notion

#### Option A: Internal Integration (simpler)

1. Go to https://www.notion.so/my-integrations → **New integration**
2. Give it a name, select your workspace
3. Copy the **Internal Integration Secret**
4. Set: `NOTION_ACCESS_TOKEN=ntn_...`
5. **Share pages/databases** with the integration (click "..." on a page → Connections → Add your integration)

#### Option B: OAuth (public app)

1. Create an OAuth integration at https://www.notion.so/my-integrations
2. Set callback URL: `https://<your-hostname>.ts.net/dc/oauth/callback/notion`
3. Set env vars:
   ```bash
   NOTION_CLIENT_ID=your-client-id
   NOTION_CLIENT_SECRET=your-secret
   ```
4. Complete OAuth: visit `https://<your-hostname>.ts.net/dc/setup/notion`

#### Webhook setup

Notion doesn't have native webhooks yet. To trigger Claude from Notion:
- Use Notion's automation rules with a webhook action (if available)
- Or use a third-party service like Zapier/Make to POST to `https://<your-hostname>.ts.net/dc/webhook/notion`
- Set `NOTION_WEBHOOK_SECRET` if you want signature verification

| Environment Variable | Description |
|---------------------|-------------|
| `NOTION_ACCESS_TOKEN` | Internal integration token |
| `NOTION_CLIENT_ID` | OAuth client ID |
| `NOTION_CLIENT_SECRET` | OAuth client secret |
| `NOTION_WEBHOOK_SECRET` | Webhook verification secret |

---

### Obsidian

Obsidian integration works via **filesystem watching** — no webhooks needed. Claude watches your vault for files containing "Dear Claude" and responds by appending to the same file.

1. Set env var with the absolute path to your vault:
   ```bash
   OBSIDIAN_VAULT_PATH=/Users/yourname/Documents/MyVault
   ```
2. That's it! Write "Dear Claude, ..." in any `.md` file and save.

Claude's response appears as a callout block appended to the same note. The frontmatter gets a `claude-status` field (`processing` → `done` / `error`).

**How it works**:
- Watches for `.md` file changes in the vault
- Ignores files in `.obsidian/`, `.trash/`, and dotfile directories
- 2-second debounce to avoid triggering on every keystroke
- Supports wikilink references (`[[other-note]]`) — Claude resolves and reads them
- Supports embedded images — Claude can see and analyze them

| Environment Variable | Description |
|---------------------|-------------|
| `OBSIDIAN_VAULT_PATH` | Absolute path to your Obsidian vault |
| `OBSIDIAN_WATCH_DEBOUNCE_MS` | Debounce delay in ms (default: `2000`) |

---

## Usage

### Trigger Format

Write **"Dear Claude"** (case-insensitive, with a space) anywhere in:
- GitHub issue/PR comments
- Linear issue descriptions or comments
- Jira issue descriptions or comments
- GitLab issue/MR descriptions or comments
- Notion page comments
- Obsidian `.md` files

### Example

**GitHub PR Comment:**
```
Dear Claude, please review this code for bugs and security issues.
```

**Claude responds on GitHub:**
> Claude Instance Started (Instance: `abc12345`)
> Processing your request...

> **Task Completed**
> Found 2 issues:
> 1. SQL injection in `user.ts:45`
> 2. Missing input validation in `api.ts:102`
>
> Created PR #15 with fixes.

### Instance Orchestration

Claude instances can **spawn other instances** for parallel work:

```
Dear Claude, code tasks 1-5 in parallel. Each task should be a separate branch.
```

Claude will:
1. Parse the tasks
2. Spawn 5 child instances via the `/api/spawn` endpoint
3. Each child works in its own git worktree (same repo, different branch)
4. Each child creates a PR when done
5. Parent polls child statuses

---

## All Environment Variables

```bash
# Server
DEAR_CLAUDE_PORT=3334
TAILSCALE_HOSTNAME=              # Optional: auto-detected

# GitHub
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_WEBHOOK_SECRET=
GITHUB_ACCESS_TOKEN=

# Linear
LINEAR_CLIENT_ID=
LINEAR_CLIENT_SECRET=
LINEAR_WEBHOOK_SECRET=
LINEAR_ACCESS_TOKEN=

# Jira Cloud
JIRA_DOMAIN=mycompany
JIRA_USER_EMAIL=you@example.com
JIRA_API_TOKEN=
JIRA_WEBHOOK_SECRET=

# GitLab
GITLAB_ACCESS_TOKEN=
GITLAB_WEBHOOK_SECRET=
GITLAB_URL=                      # Default: https://gitlab.com

# Notion
NOTION_CLIENT_ID=
NOTION_CLIENT_SECRET=
NOTION_WEBHOOK_SECRET=
NOTION_ACCESS_TOKEN=

# Obsidian
OBSIDIAN_VAULT_PATH=
OBSIDIAN_WATCH_DEBOUNCE_MS=2000

# Optional
GIPHY_API_KEY=                   # For fun GIF reactions in responses
```

## CLI Commands

```bash
# Start the server (standalone mode)
bun run src/index.ts start

# Start as MCP server (stdio, for Claude Code)
bun run src/index.ts start --mcp

# Check server and platform status
bun run src/index.ts status

# List instances
bun run src/index.ts instances

# Setup instructions for a platform
bun run src/index.ts setup <platform>
```

## MCP Tools

When running as an MCP server inside Claude Code, these tools are available:

| Tool | Description |
|------|-------------|
| `list_platforms` | List configured platforms and their status |
| `list_instances` | List all Claude instances (filter by status) |
| `get_instance_status` | Get detailed status of a specific instance |
| `get_instance_messages` | Get conversation history for an instance |
| `kill_instance` | Terminate a running instance |
| `get_running_instances` | List currently running instance IDs |
| `spawn_instance` | Spawn a new Claude instance for a task |
| `get_project_instances` | List all instances in a project group |

## HTTP API

The server also exposes REST endpoints on `localhost:3334`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check + platform status |
| `/webhook/:platform` | POST | Webhook receiver |
| `/api/instances` | GET | List instances (`?project_id=` filter) |
| `/api/instances/:id` | GET | Get instance details + children |
| `/api/instances/:id/kill` | POST | Kill a running instance |
| `/api/spawn` | POST | Spawn a new instance programmatically |
| `/api/platforms` | GET | List configured platforms |
| `/setup/:platform` | GET | Start OAuth flow |
| `/oauth/callback/:platform` | GET | OAuth callback |

### POST /api/spawn

```json
{
  "prompt": "Implement the login page",
  "repo_url": "https://github.com/owner/repo",
  "branch": "feature/login",
  "base_branch": "main",
  "parent_instance_id": "optional-parent-id",
  "project_id": "optional-project-id"
}
```

## Architecture

```
                  Webhooks / File Watcher
  ┌────────┐ ┌────────┐ ┌──────┐ ┌────────┐ ┌──────────┐ ┌────────┐
  │ GitHub │ │ Linear │ │ Jira │ │ GitLab │ │ Obsidian │ │ Notion │
  └───┬────┘ └───┬────┘ └──┬───┘ └───┬────┘ └────┬─────┘ └───┬────┘
      │          │         │         │            │            │
      └──────────┴────┬────┴─────────┴────────────┴────────────┘
                      │
                      ▼
           ┌─────────────────────┐
           │  Tailscale Funnel   │
           │ (Public HTTPS URL)  │
           └─────────┬───────────┘
                     │
                     ▼
           ┌─────────────────────┐
           │   dear-claude       │
           │   MCP Server        │
           │                     │
           │ • Trigger detection │
           │ • Instance manager  │
           │ • Platform adapters │
           │ • Spawn API         │
           │ • SQLite DB         │
           └─────────┬───────────┘
                     │
                     ▼
           ┌─────────────────────┐
           │  Claude Code        │
           │  Instances          │
           │ (Agent SDK)         │
           │                     │
           │ • Git worktrees     │
           │ • Cross-platform    │
           │   API access        │
           │ • Child spawning    │
           └─────────────────────┘
```

## Instance Lifecycle

```
PENDING → RUNNING → IDLE → (follow-up) → RUNNING → IDLE → ... → EXPIRED (7 days)
                  ↘ COMPLETED
                  ↘ FAILED
```

- **PENDING**: Trigger detected, instance queued
- **RUNNING**: Claude Code actively processing
- **IDLE**: Waiting for follow-up "Dear Claude" mentions
- **COMPLETED**: Task finished successfully
- **FAILED**: Error occurred
- **EXPIRED**: 7-day TTL exceeded, instance cleaned up

## Development

```bash
# Install dependencies
bun install

# Run dev mode
bun run dev

# Type check
bunx tsc --noEmit

# Build
bun run build

# Run tests
bun test
```

## Troubleshooting

### Tailscale

- **"Tailscale not running"**: Open the Tailscale app (macOS) or `sudo systemctl start tailscaled && tailscale up` (Linux)
- **"Funnel not enabled"**: Visit https://login.tailscale.com/admin/acls and add Funnel capability
- **Funnel disappears**: Another `tailscale serve`/`tailscale funnel` command may have overwritten it. The health check auto-repairs within 10 seconds. Verify with `tailscale serve status --json`.

### Webhooks

- **Not triggering**: Check `bun run src/index.ts status` to verify the server is up. Test with `curl https://<your-hostname>.ts.net/dc/health`.
- **"Invalid signature"**: Verify the webhook secret matches in both the platform config and your env vars.
- **GitHub**: The app subscribes to `issue_comment` events. To trigger on a new PR, post a comment — PR descriptions alone won't trigger.

### OAuth

- **Token expired**: Re-visit `https://<your-hostname>.ts.net/dc/setup/<platform>` to re-authenticate.
- **401 errors**: The stored OAuth token may have been revoked. Delete the stale token from `data/dear-claude.db` and re-authenticate.

### Instances

- **Stuck in PENDING**: Check that Claude Code CLI (`claude`) is installed and accessible in your PATH.
- **Working directory issues**: Instances create workspaces under `data/workspaces/`. Ensure write permissions.

## Capability attestation

This repo ships a [smithmark](https://github.com/smithmark) capability manifest at [`smithmark.yaml`](smithmark.yaml), alongside a static tool listing at [`tools.json`](tools.json). The manifest declares, in one place, the full external surface this MCP server touches when it runs:

- **Network egress**: every host it talks to (`api.github.com`, `github.com`, `api.linear.app`, `linear.app`, `gitlab.com`, `*.atlassian.net`, `api.notion.com`, `api.giphy.com`, `api.anthropic.com`) and why.
- **Filesystem**: the paths it reads or writes (`~/.dear-claude/**`, `data/**`, `~/.claude.json`, the debug log) and the access level.
- **Exec**: subprocesses it spawns (`claude`, `tailscale`, `which`, `open`, `sudo`, `pkill`).
- **Env vars and secrets**: every credential-shaped environment variable it consumes, tagged by kind (access token, client secret, webhook secret, API key, private key).

Once smithmark is publicly available you'll be able to verify the manifest against the published package with:

```bash
smithmark verify dear-claude@1.1.0
```

The manifest is the **authoritative** record of this server's capability surface. smithmark's `lint` is deliberately host-unaware and advisory: it flags every `fetch()` call site and every exec as "undeclared" regardless of what's in the manifest, so it will show findings on this codebase (and on any real MCP server) even though the egress above is fully declared. Treat lint output as a discovery aid, not a drift signal, until `--strict` or a host-aware successor ships.

## License

MIT
