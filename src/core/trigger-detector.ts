/**
 * Trigger Detector
 * Detects "dear-claude" mentions in platform events
 */

export interface TriggerContext {
  threadId: string;
  platform: "linear" | "gmail" | "github";
  content: string;
  isDescription: boolean;  // True if this is the issue description/email body, false if comment/reply
  messageId?: string;
  authorId?: string;
  timestamp: number;
}

export type TriggerAction = "NEW" | "RESUME" | "IGNORE";

export interface TriggerResult {
  action: TriggerAction;
  context?: TriggerContext;
  reason: string;
}

// Pattern to match "dear-claude", "dear claude", "Dear-Claude", etc.
const DEAR_CLAUDE_PATTERN = /\bdear[- ]?claude\b/i;

export class TriggerDetector {
  /**
   * Check if content contains "dear-claude" trigger
   */
  static containsTrigger(content: string): boolean {
    return DEAR_CLAUDE_PATTERN.test(content);
  }

  /**
   * Extract the request content after the "dear-claude" trigger
   * Returns the full content after the trigger phrase
   */
  static extractRequest(content: string): string {
    const match = content.match(DEAR_CLAUDE_PATTERN);
    if (!match) return content;

    // Get everything after "dear-claude"
    const afterTrigger = content.slice(match.index! + match[0].length).trim();

    // Remove common punctuation that might follow the trigger
    const cleaned = afterTrigger.replace(/^[,:\-]+\s*/, "");

    return cleaned || content;
  }

  /**
   * Determine the action based on event context
   *
   * Rules:
   * - "dear-claude" in new issue description → NEW instance
   * - "dear-claude" first time in comments → NEW instance
   * - "dear-claude" again in same issue comments → RESUME instance
   * - New email with "dear-claude" → NEW instance
   * - Reply in thread with prior "dear-claude" → RESUME instance
   * - No "dear-claude" keyword → IGNORE
   */
  static determineTriggerAction(
    context: TriggerContext,
    existingInstanceId?: string,
    existingInstanceStatus?: string
  ): TriggerResult {
    const hasTrigger = this.containsTrigger(context.content);

    // No trigger phrase → IGNORE
    if (!hasTrigger) {
      return {
        action: "IGNORE",
        reason: "No 'dear-claude' trigger found in content"
      };
    }

    // Instance already running → IGNORE (debounce)
    if (existingInstanceId && existingInstanceStatus === "running") {
      return {
        action: "IGNORE",
        context,
        reason: `Instance ${existingInstanceId} is already running`
      };
    }

    // Has trigger phrase in description/body of new item → NEW
    if (context.isDescription) {
      return {
        action: "NEW",
        context,
        reason: "Trigger found in new item description/body"
      };
    }

    // Has trigger in comment/reply...
    // If we have an existing instance (not expired) → RESUME
    if (existingInstanceId && existingInstanceStatus && !["expired", "failed"].includes(existingInstanceStatus)) {
      return {
        action: "RESUME",
        context,
        reason: `Resuming existing instance ${existingInstanceId}`
      };
    }

    // First time trigger in comments (no existing instance or expired) → NEW
    return {
      action: "NEW",
      context,
      reason: "First trigger in thread, creating new instance"
    };
  }

  /**
   * Parse platform-specific events into TriggerContext
   */
  static parseLinearEvent(event: LinearWebhookEvent): TriggerContext | null {
    if (event.type === "Issue" && event.action === "create") {
      return {
        threadId: event.data.id,
        platform: "linear",
        content: `${event.data.title || ""}\n${event.data.description || ""}`,
        isDescription: true,
        authorId: event.data.creatorId,
        timestamp: Date.now()
      };
    }

    if (event.type === "Comment" && event.action === "create") {
      return {
        threadId: event.data.issueId || event.data.issue?.id || "",
        platform: "linear",
        content: event.data.body || "",
        isDescription: false,
        messageId: event.data.id,
        authorId: event.data.userId,
        timestamp: Date.now()
      };
    }

    return null;
  }

  static parseGmailEvent(message: GmailMessage, threadId: string, isFirstInThread: boolean): TriggerContext {
    return {
      threadId,
      platform: "gmail",
      content: `${message.subject || ""}\n${message.body || ""}`,
      isDescription: isFirstInThread,
      messageId: message.id,
      authorId: message.from,
      timestamp: message.timestamp
    };
  }

  static parseGitHubEvent(event: GitHubWebhookEvent): TriggerContext | null {
    if (event.action === "opened" && event.issue) {
      return {
        threadId: `${event.repository.full_name}#${event.issue.number}`,
        platform: "github",
        content: `${event.issue.title || ""}\n${event.issue.body || ""}`,
        isDescription: true,
        authorId: event.issue.user?.login,
        timestamp: Date.now()
      };
    }

    if (event.action === "created" && event.comment && event.issue) {
      return {
        threadId: `${event.repository.full_name}#${event.issue.number}`,
        platform: "github",
        content: event.comment.body || "",
        isDescription: false,
        messageId: String(event.comment.id),
        authorId: event.comment.user?.login,
        timestamp: Date.now()
      };
    }

    return null;
  }
}

// Type definitions for platform events
export interface LinearWebhookEvent {
  type: "Issue" | "Comment" | string;
  action: "create" | "update" | "remove" | string;
  data: {
    id: string;
    title?: string;
    description?: string;
    body?: string;
    creatorId?: string;
    userId?: string;
    issueId?: string;
    issue?: { id: string };
  };
  organizationId: string;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  subject?: string;
  body?: string;
  from: string;
  timestamp: number;
}

export interface GitHubWebhookEvent {
  action: string;
  repository: {
    full_name: string;
  };
  issue?: {
    number: number;
    title?: string;
    body?: string;
    user?: { login: string };
  };
  comment?: {
    id: number;
    body?: string;
    user?: { login: string };
  };
}
