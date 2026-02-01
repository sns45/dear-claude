/**
 * Claude Executor
 * Runs Claude Code sessions using the Agent SDK
 */

import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { InstanceManager, RepoMeta } from "./instance-manager.js";
import type { Instance } from "../db/schema.js";

export interface ExecutionResult {
  instanceId: string;
  success: boolean;
  output: string;
  summary?: string;
}

export interface PlatformCallbacks {
  onStart?: (instanceId: string, message: string) => Promise<void>;
  onProgress?: (instanceId: string, message: string) => Promise<void>;
  onComplete?: (instanceId: string, summary: string) => Promise<void>;
  onError?: (instanceId: string, error: string) => Promise<void>;
}

interface ActiveExecution {
  abortController: AbortController;
  output: string[];
  startedAt: Date;
}

export class ClaudeExecutor {
  private instanceManager: InstanceManager;
  private activeExecutions: Map<string, ActiveExecution> = new Map();

  constructor(instanceManager: InstanceManager) {
    this.instanceManager = instanceManager;
  }

  /**
   * Execute a task using the Claude Agent SDK
   */
  async execute(
    instanceId: string,
    isResume: boolean = false,
    callbacks?: PlatformCallbacks,
    eventMeta?: { isPullRequest?: boolean; diffContent?: string; repoMeta?: RepoMeta }
  ): Promise<void> {
    const instance = this.instanceManager.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    // Check if already running
    if (this.activeExecutions.has(instanceId)) {
      console.log(`[ClaudeExecutor] Instance ${instanceId} is already running`);
      return;
    }

    // Get the latest user message as the request
    const messages = this.instanceManager.getMessages(instanceId);
    const latestUserMessage = [...messages].reverse().find(m => m.role === "user");

    if (!latestUserMessage) {
      throw new Error(`No user message found for instance ${instanceId}`);
    }

    // Build prompt
    let prompt: string;
    if (isResume) {
      prompt = await this.instanceManager.buildResumePrompt(instanceId, latestUserMessage.content);
    } else {
      prompt = this.buildNewPrompt(instance, latestUserMessage.content, eventMeta?.isPullRequest, eventMeta?.diffContent, eventMeta?.repoMeta);
    }

    // Update status to running
    this.instanceManager.updateStatus(instanceId, "running");

    // Notify platform that we're starting
    if (callbacks?.onStart) {
      const message = isResume
        ? `**Resuming Previous Session** (ID: ${instanceId.slice(0, 8)})\nOriginal request: "${instance.original_prompt.slice(0, 100)}..."\nContinuing from where we left off...`
        : `**Claude Instance Started** (ID: ${instanceId.slice(0, 8)})\nProcessing your request...`;
      await callbacks.onStart(instanceId, message);
    }

    console.log(`[ClaudeExecutor] Starting ${isResume ? "resumed" : "new"} execution for ${instanceId}`);
    console.log(`[ClaudeExecutor] Working directory: ${instance.working_dir}`);

    const abortController = new AbortController();
    const execution: ActiveExecution = {
      abortController,
      output: [],
      startedAt: new Date()
    };
    this.activeExecutions.set(instanceId, execution);

    // Run in background so execute() returns immediately
    this.runQuery(instanceId, instance, prompt, execution, callbacks).catch((err) => {
      console.error(`[ClaudeExecutor] Unhandled error for ${instanceId}:`, err);
    });
  }

  private async runQuery(
    instanceId: string,
    instance: Instance,
    prompt: string,
    execution: ActiveExecution,
    callbacks?: PlatformCallbacks
  ): Promise<void> {
    try {
      const mcpServers = this.getMcpServers();
      console.log(`[ClaudeExecutor] MCP servers for ${instanceId.slice(0, 8)}:`, Object.keys(mcpServers));

      const conversation = query({
        prompt,
        options: {
          abortController: execution.abortController,
          cwd: instance.working_dir,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: `You are working on behalf of a user who contacted you via ${instance.platform}. Complete their request thoroughly.`
          },
          tools: { type: "preset", preset: "claude_code" },
          mcpServers,
          maxTurns: 50,
          stderr: (data: string) => {
            console.error(`[Claude:${instanceId.slice(0, 8)}:stderr] ${data.trim()}`);
          },
        }
      });

      // Check MCP server status
      try {
        const mcpStatus = await conversation.mcpServerStatus();
        console.log(`[ClaudeExecutor] MCP status for ${instanceId.slice(0, 8)}:`, JSON.stringify(mcpStatus));
      } catch (e: any) {
        console.warn(`[ClaudeExecutor] Could not get MCP status: ${e.message}`);
      }

      let resultText = "";

      for await (const message of conversation) {
        if (message.type === "assistant") {
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text") {
                execution.output.push(block.text);
                console.log(`[Claude:${instanceId.slice(0, 8)}] ${block.text.slice(0, 200)}`);
              } else if (block.type === "tool_use") {
                console.log(`[Claude:${instanceId.slice(0, 8)}:tool] ${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);
              }
            }
          }
        } else if (message.type === "result") {
          if (message.subtype === "success") {
            resultText = message.result;
          } else {
            // Error result
            const errors = "errors" in message ? (message.errors as string[]).join(", ") : "Unknown error";
            throw new Error(`SDK error (${message.subtype}): ${errors}`);
          }
        }
      }

      // Success
      const fullOutput = execution.output.join("\n");
      const summary = resultText || this.extractSummary(fullOutput);

      this.activeExecutions.delete(instanceId);
      this.instanceManager.updateStatus(instanceId, "idle", summary);
      this.instanceManager.addMessage(instanceId, "assistant", fullOutput);

      await this.instanceManager.updateContext(
        instanceId,
        { role: "assistant", content: fullOutput },
        summary
      );

      console.log(`[ClaudeExecutor] Instance ${instanceId} completed successfully`);

      if (callbacks?.onComplete) {
        await callbacks.onComplete(instanceId, `**Task Completed**\n${summary}`);
      }
    } catch (err: any) {
      this.activeExecutions.delete(instanceId);
      const fullOutput = execution.output.join("\n");

      if (err.name === "AbortError") {
        this.instanceManager.updateStatus(instanceId, "failed");
        console.log(`[ClaudeExecutor] Instance ${instanceId} was aborted`);
      } else {
        this.instanceManager.updateStatus(instanceId, "failed");
        console.error(`[ClaudeExecutor] Instance ${instanceId} failed:`, err.message);

        if (callbacks?.onError) {
          await callbacks.onError(instanceId, `Claude failed: ${err.message}\n\nOutput:\n${fullOutput.slice(-500)}`);
        }
      }
    }
  }

  /**
   * Read MCP server configs from ~/.claude.json for the spawned instance.
   * Only include better-call-claude (not dear-claude to avoid recursion).
   */
  private getMcpServers(): Record<string, any> {
    try {
      const configPath = join(homedir(), ".claude.json");
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      const servers: Record<string, any> = {};

      if (config.mcpServers) {
        for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
          // Skip dear-claude to avoid recursive spawning
          if (name === "dear-claude") continue;
          // Only include servers that are relevant
          if (name === "better-call-claude") {
            servers[name] = serverConfig;
          }
        }
      }

      return servers;
    } catch (e) {
      console.warn("[ClaudeExecutor] Could not read MCP config:", e);
      return {};
    }
  }

  /**
   * Build prompt for a new instance
   */
  private buildNewPrompt(instance: Instance, request: string, isPR?: boolean, diffContent?: string, repoMeta?: RepoMeta): string {
    let prSection = "";
    if (isPR && diffContent) {
      prSection = `
## Pull Request / Merge Request Review

You are reviewing a pull request. Analyze the diff below and provide constructive code review.
Focus on: bugs, security issues, performance, readability, and best practices.
Be specific with file paths and line numbers when suggesting changes.

### Diff Content
\`\`\`diff
${diffContent.slice(0, 15000)}
\`\`\`
`;
    }

    let repoSection = "";
    if (repoMeta) {
      repoSection = `
## Repository Access

The repository should be at ~/dev/${repoMeta.repoName}.

If it exists: cd ~/dev/${repoMeta.repoName} && git fetch origin && git checkout ${repoMeta.branch} && git pull origin ${repoMeta.branch}
If not: git clone ${repoMeta.authCloneUrl} ~/dev/${repoMeta.repoName} && cd ~/dev/${repoMeta.repoName} && git checkout ${repoMeta.branch}

To push changes after editing:
  cd ~/dev/${repoMeta.repoName} && git add -A && git commit -m "description" && git push origin ${repoMeta.branch}

The clone URL includes auth — no password needed.
`;
    }

    let reviewFormatSection = "";
    if (isPR) {
      reviewFormatSection = `
## Review Output Format

Structure your review as:
1. Summary at the top
2. For file-specific comments, use:
   ### FILE:path/to/file.ts LINE:42
   Your comment here
   ### FILE:path/to/file.ts LINE:108-112
   \`\`\`suggestion
   fixed code
   \`\`\`
These become inline comments with one-click Apply buttons.
`;
    }

    const giphyKey = process.env.GIPHY_API_KEY;
    const gifSection = giphyKey ? `
## GIF Reactions

To make responses engaging, you can embed GIFs. Use curl to search Giphy:
  curl -s "https://api.giphy.com/v1/gifs/search?api_key=${giphyKey}&q=QUERY&limit=1&rating=g"
Then embed: ![description](gif_url)
Use sparingly - one per response max, only when it adds value (celebrations, humor).
` : "";

    return `
You received a request from a user via ${instance.platform}. Their request was:
"${request}"

## Instructions

1. **Execute the task**: Complete the user's request as described
2. **Work locally**: Create files and directories in the current working directory (${instance.working_dir})
3. **Be thorough**: Implement complete, working solutions
4. **Document your work**: Provide a summary of what you created/changed
${prSection}${repoSection}${reviewFormatSection}
## Working Directory

You are working in: ${instance.working_dir}

All files you create will be saved here. The user will be notified of the results via ${instance.platform}.

## Available MCP Tools

You have access to MCP (Model Context Protocol) servers that provide additional capabilities:

- **better-call-claude**: Send WhatsApp messages and SMS via Twilio. Use \`send_whatsapp\` or \`send_sms\` tools.

When the user asks you to send a WhatsApp message or SMS, use the better-call-claude MCP tools directly. The credentials are already configured - just call the tool.
${gifSection}
Start now. Execute the task.
`.trim();
  }

  /**
   * Extract a summary from Claude's output
   */
  private extractSummary(output: string): string {
    const lines = output.trim().split("\n");

    // Look for summary section markers and take content after them
    const summaryMarkers = ["## summary", "### summary", "**summary**", "summary:"];
    const lowerOutput = output.toLowerCase();

    for (const marker of summaryMarkers) {
      const idx = lowerOutput.indexOf(marker);
      if (idx !== -1) {
        const afterMarker = output.slice(idx + marker.length).trim();
        const nextSection = afterMarker.search(/\n#{2,}\s/);
        let summaryText = nextSection > 0 ? afterMarker.slice(0, nextSection) : afterMarker;

        if (summaryText.trim().endsWith(":")) {
          const listMatch = afterMarker.match(/^[^]*?:\n+((?:[-*]\s+[^\n]+\n?)+)/);
          if (listMatch) {
            summaryText = afterMarker.slice(0, afterMarker.indexOf(listMatch[1]) + listMatch[1].length);
          }
        }

        if (summaryText.length > 20) {
          return summaryText.slice(0, 500).trim();
        }
      }
    }

    const creationPatterns = [
      /I (?:created|built|implemented|wrote|made|added|developed)[^]*?(?:\.(?:\s|$)|!)/i,
      /(?:Created|Built|Implemented|Added)[^]*?(?:\.(?:\s|$)|!)/i
    ];

    for (const pattern of creationPatterns) {
      const match = output.match(pattern);
      if (match && match[0].length > 20) {
        const cleaned = match[0].trim();
        if (cleaned.length > 500) {
          const breakPoint = cleaned.slice(0, 500).lastIndexOf('. ');
          return breakPoint > 100 ? cleaned.slice(0, breakPoint + 1) : cleaned.slice(0, 500);
        }
        return cleaned;
      }
    }

    const meaningfulLines = lines
      .filter(l => {
        const trimmed = l.trim();
        return trimmed &&
          !trimmed.startsWith("[") &&
          !trimmed.startsWith("```") &&
          !trimmed.startsWith(">") &&
          trimmed.length > 10;
      })
      .slice(-5);

    return meaningfulLines.join("\n").slice(0, 500) || "Task completed successfully.";
  }

  /**
   * Kill a running instance
   */
  kill(instanceId: string): boolean {
    const execution = this.activeExecutions.get(instanceId);
    if (execution) {
      execution.abortController.abort();
      this.activeExecutions.delete(instanceId);
      this.instanceManager.updateStatus(instanceId, "failed");
      console.log(`[ClaudeExecutor] Killed instance ${instanceId}`);
      return true;
    }
    return false;
  }

  /**
   * Check if an instance is currently running
   */
  isRunning(instanceId: string): boolean {
    return this.activeExecutions.has(instanceId);
  }

  /**
   * Get all running instance IDs
   */
  getRunningInstances(): string[] {
    return Array.from(this.activeExecutions.keys());
  }

  /**
   * Cleanup - kill all running instances
   */
  async cleanup(): Promise<void> {
    for (const [instanceId, execution] of this.activeExecutions) {
      execution.abortController.abort();
      this.instanceManager.updateStatus(instanceId, "failed");
    }
    this.activeExecutions.clear();
    console.log("[ClaudeExecutor] Cleaned up all running instances");
  }
}

export interface ParsedReviewOutput {
  summary: string;
  inlineComments: Array<{ path: string; startLine: number; endLine?: number; body: string }>;
}

/**
 * Parse Claude's review output into summary + inline comments.
 * Looks for ### FILE:path/to/file LINE:N or LINE:N-M markers.
 */
export function parseReviewOutput(output: string): ParsedReviewOutput {
  const marker = /^### FILE:(\S+)\s+LINE:(\d+)(?:-(\d+))?/gm;
  const parts = output.split(marker);

  // parts[0] is the summary (before first marker)
  // Then groups of 4: [path, startLine, endLine?, body] repeating
  const summary = parts[0].trim();
  const inlineComments: ParsedReviewOutput["inlineComments"] = [];

  // After split with capture groups, layout is:
  // [summary, path1, line1, endLine1, body1, path2, line2, endLine2, body2, ...]
  for (let i = 1; i + 3 < parts.length; i += 4) {
    const path = parts[i];
    const startLine = parseInt(parts[i + 1], 10);
    const endLine = parts[i + 2] ? parseInt(parts[i + 2], 10) : undefined;
    const body = parts[i + 3].trim();
    if (path && body) {
      inlineComments.push({ path, startLine, endLine, body });
    }
  }

  return { summary: summary || output.trim(), inlineComments };
}
