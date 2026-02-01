/**
 * Instance Manager
 * Manages Claude Code instance lifecycle and context persistence
 */

import { randomUUID } from "crypto";
import { mkdir, writeFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { DatabaseManager, type Instance, type Message } from "../db/schema.js";
import { TriggerDetector, type TriggerContext, type TriggerResult } from "./trigger-detector.js";

export interface RepoMeta {
  authCloneUrl: string;
  branch: string;
  baseBranch: string;
  prNumber: number;
  repoName: string;
}

export interface InstanceContext {
  originalPrompt: string;
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  completionSummary?: string;
  filesCreated: string[];
  workingDir: string;
  repoMeta?: RepoMeta;
}

export interface CreateInstanceResult {
  instance: Instance;
  context: InstanceContext;
}

export class InstanceManager {
  private db: DatabaseManager;
  private dataDir: string;

  constructor(db: DatabaseManager, dataDir?: string) {
    this.db = db;
    this.dataDir = dataDir || join(process.cwd(), "data");
  }

  /**
   * Determine if we should create a new instance, resume existing, or ignore
   */
  async processEvent(triggerContext: TriggerContext): Promise<TriggerResult & { instanceId?: string }> {
    // Look up existing instance for this thread
    const existing = this.db.getInstanceByThread(triggerContext.threadId, triggerContext.platform);

    const result = TriggerDetector.determineTriggerAction(
      triggerContext,
      existing?.id,
      existing?.status
    );

    if (result.action === "NEW") {
      const created = await this.createInstance(triggerContext);
      return { ...result, instanceId: created.instance.id };
    }

    if (result.action === "RESUME" && existing) {
      // Add the new message to the instance
      this.db.addMessage({
        id: randomUUID(),
        instance_id: existing.id,
        role: "user",
        content: TriggerDetector.extractRequest(triggerContext.content),
        platform_message_id: triggerContext.messageId
      });

      // Update instance status to pending (will be set to running when Claude starts)
      this.db.updateInstanceStatus(existing.id, "pending");

      return { ...result, instanceId: existing.id };
    }

    return result;
  }

  /**
   * Create a new Claude instance
   */
  async createInstance(context: TriggerContext): Promise<CreateInstanceResult> {
    const instanceId = randomUUID();
    const workspaceDir = join(this.dataDir, "workspaces", instanceId);
    const contextPath = join(this.dataDir, "contexts", `${instanceId}.json`);
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days

    // Create workspace directory
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(join(this.dataDir, "contexts"), { recursive: true });

    const prompt = TriggerDetector.extractRequest(context.content);

    // Create instance in database
    const instance = this.db.createInstance({
      id: instanceId,
      thread_id: context.threadId,
      platform: context.platform,
      status: "pending",
      working_dir: workspaceDir,
      original_prompt: prompt,
      expires_at: expiresAt
    });

    // Add initial message
    this.db.addMessage({
      id: randomUUID(),
      instance_id: instanceId,
      role: "user",
      content: prompt,
      platform_message_id: context.messageId
    });

    // Create initial context file
    const instanceContext: InstanceContext = {
      originalPrompt: prompt,
      conversationHistory: [{ role: "user", content: prompt }],
      filesCreated: [],
      workingDir: workspaceDir
    };

    await this.saveContext(instanceId, instanceContext);

    console.log(`[InstanceManager] Created instance ${instanceId} for ${context.platform}:${context.threadId}`);

    return { instance, context: instanceContext };
  }

  /**
   * Get instance by ID
   */
  getInstance(instanceId: string): Instance | undefined {
    return this.db.getInstance(instanceId);
  }

  /**
   * Get instance by thread ID and platform
   */
  getInstanceByThread(threadId: string, platform: string): Instance | undefined {
    return this.db.getInstanceByThread(threadId, platform);
  }

  /**
   * Update instance status
   */
  updateStatus(instanceId: string, status: Instance["status"], summary?: string): void {
    this.db.updateInstanceStatus(instanceId, status, summary);
    console.log(`[InstanceManager] Instance ${instanceId} status: ${status}`);
  }

  /**
   * Add a message to instance conversation
   */
  addMessage(instanceId: string, role: "user" | "assistant", content: string, platformMessageId?: string): void {
    this.db.addMessage({
      id: randomUUID(),
      instance_id: instanceId,
      role,
      content,
      platform_message_id: platformMessageId
    });
  }

  /**
   * Get all messages for an instance
   */
  getMessages(instanceId: string): Message[] {
    return this.db.getMessages(instanceId);
  }

  /**
   * Save instance context to JSON file
   */
  async saveContext(instanceId: string, context: InstanceContext): Promise<void> {
    const contextPath = join(this.dataDir, "contexts", `${instanceId}.json`);
    await writeFile(contextPath, JSON.stringify(context, null, 2));
  }

  /**
   * Load instance context from JSON file
   */
  async loadContext(instanceId: string): Promise<InstanceContext | undefined> {
    const contextPath = join(this.dataDir, "contexts", `${instanceId}.json`);
    if (!existsSync(contextPath)) {
      return undefined;
    }
    const data = await readFile(contextPath, "utf-8");
    return JSON.parse(data);
  }

  /**
   * Update context with new message and optionally completion summary
   */
  async updateContext(
    instanceId: string,
    message: { role: "user" | "assistant"; content: string },
    completionSummary?: string,
    newFiles?: string[]
  ): Promise<void> {
    const context = await this.loadContext(instanceId);
    if (!context) {
      console.warn(`[InstanceManager] No context found for instance ${instanceId}`);
      return;
    }

    context.conversationHistory.push(message);
    if (completionSummary) {
      context.completionSummary = completionSummary;
    }
    if (newFiles) {
      context.filesCreated.push(...newFiles);
    }

    await this.saveContext(instanceId, context);
  }

  /**
   * Get all active instances
   */
  getActiveInstances(): Instance[] {
    return this.db.getActiveInstances();
  }

  /**
   * Get all instances with limit
   */
  getAllInstances(limit?: number): Instance[] {
    return this.db.getAllInstances(limit);
  }

  /**
   * Cleanup expired instances
   */
  cleanupExpired(): number {
    const count = this.db.cleanupExpired();
    if (count > 0) {
      console.log(`[InstanceManager] Cleaned up ${count} expired instances`);
    }
    return count;
  }

  /**
   * Build context prompt for resuming an instance
   */
  async buildResumePrompt(instanceId: string, newRequest: string): Promise<string> {
    const instance = this.getInstance(instanceId);
    const context = await this.loadContext(instanceId);

    if (!instance || !context) {
      return newRequest;
    }

    const conversationSummary = context.conversationHistory
      .map((m, i) => `[${m.role}]: ${m.content.slice(0, 200)}${m.content.length > 200 ? "..." : ""}`)
      .join("\n");

    const repoSection = context.repoMeta ? `
## Repository Access
The repo is at ~/dev/${context.repoMeta.repoName}. Run:
  cd ~/dev/${context.repoMeta.repoName} && git fetch origin && git checkout ${context.repoMeta.branch} && git pull origin ${context.repoMeta.branch}
To push changes: git add -A && git commit -m "description" && git push origin ${context.repoMeta.branch}
The clone URL includes auth — no password needed.
` : "";

    return `
## IMPORTANT: Resuming Previous Session (Instance: ${instanceId.slice(0, 8)})

This is a FOLLOW-UP request. You have prior context from a previous task.

**Original Request**: "${context.originalPrompt}"
${context.completionSummary ? `**Previous Work Summary**: "${context.completionSummary}"` : ""}
**Working Directory**: ${context.workingDir}
${context.filesCreated.length > 0 ? `**Files Created**: ${context.filesCreated.join(", ")}` : ""}

**Conversation History**:
${conversationSummary}

---

**New Request**: "${newRequest}"
${repoSection}
## Available MCP Tools

You have access to MCP (Model Context Protocol) servers:

- **better-call-claude**: Send WhatsApp messages and SMS via Twilio. Use \`send_whatsapp\` or \`send_sms\` tools directly.
- **dear-claude**: Manage Claude instances (list, status, kill).

When asked to send WhatsApp/SMS, use the MCP tools directly - credentials are already configured.

Continue working in the same directory (${context.workingDir}) and build on what was already created.
`.trim();
  }
}
