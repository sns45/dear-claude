/**
 * Linear Adapter
 * Handles Linear webhooks and API interactions
 */

import { createHmac, timingSafeEqual } from "crypto";
import type { Context } from "hono";
import type { PlatformAdapter, PlatformEvent, AdapterConfig } from "./platform-adapter.js";

interface LinearIssue {
  id: string;
  title: string;
  description?: string;
  number: number;
  identifier: string;
  url: string;
  creatorId?: string;
}

interface LinearComment {
  id: string;
  body: string;
  issueId: string;
  userId?: string;
  issue?: { id: string };
}

interface LinearWebhookPayload {
  type: string;
  action: string;
  data: LinearIssue | LinearComment;
  organizationId: string;
  createdAt: string;
}

export class LinearAdapter implements PlatformAdapter {
  readonly platform = "linear" as const;
  private config: AdapterConfig;
  private apiUrl = "https://api.linear.app/graphql";
  private authUrl = "https://linear.app/oauth/authorize";
  private tokenUrl = "https://api.linear.app/oauth/token";

  constructor(config: AdapterConfig) {
    this.config = config;
  }

  isConfigured(): boolean {
    return !!(this.config.accessToken || (this.config.clientId && this.config.clientSecret));
  }

  async verifySignature(ctx: Context, body: string): Promise<boolean> {
    if (!this.config.webhookSecret) {
      console.warn("[LinearAdapter] No webhook secret configured, skipping verification");
      return true;
    }

    const signature = ctx.req.header("linear-signature");
    if (!signature) {
      console.warn("[LinearAdapter] Missing Linear signature header");
      return false;
    }

    try {
      const hmac = createHmac("sha256", this.config.webhookSecret);
      hmac.update(body);
      const expectedSignature = hmac.digest("hex");

      const sigBuffer = Buffer.from(signature);
      const expectedBuffer = Buffer.from(expectedSignature);

      if (sigBuffer.length !== expectedBuffer.length) {
        console.warn("[LinearAdapter] Signature length mismatch");
        return false;
      }

      return timingSafeEqual(sigBuffer, expectedBuffer);
    } catch (error) {
      console.error("[LinearAdapter] Signature verification error:", error);
      return false;
    }
  }

  async parseWebhook(ctx: Context, body: unknown): Promise<PlatformEvent | null> {
    const payload = body as LinearWebhookPayload;

    if (payload.type === "Issue" && payload.action === "create") {
      const issue = payload.data as LinearIssue;
      return {
        platform: "linear",
        threadId: issue.id,
        content: `${issue.title || ""}\n${issue.description || ""}`,
        isDescription: true,
        authorId: issue.creatorId,
        raw: payload
      };
    }

    if (payload.type === "Comment" && payload.action === "create") {
      const comment = payload.data as LinearComment;
      return {
        platform: "linear",
        threadId: comment.issueId || comment.issue?.id || "",
        content: comment.body || "",
        isDescription: false,
        messageId: comment.id,
        authorId: comment.userId,
        raw: payload
      };
    }

    return null;
  }

  async postResponse(threadId: string, message: string): Promise<void> {
    if (!this.config.accessToken) {
      throw new Error("Linear access token not configured");
    }

    const mutation = `
      mutation CreateComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
          comment {
            id
          }
        }
      }
    `;

    const response = await fetch(this.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": this.config.accessToken
      },
      body: JSON.stringify({
        query: mutation,
        variables: { issueId: threadId, body: message }
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to post Linear comment: ${error}`);
    }

    const result = await response.json() as { data?: { commentCreate?: { success: boolean } }; errors?: Array<{ message: string }> };
    if (result.errors) {
      throw new Error(`Linear API error: ${result.errors.map((e: { message: string }) => e.message).join(", ")}`);
    }

    console.log(`[LinearAdapter] Posted comment to issue ${threadId}`);
  }

  async setStatus(threadId: string, status: "processing" | "done" | "error"): Promise<void> {
    if (!this.config.accessToken) return;

    // Map status to Linear label names
    const labelNames: Record<string, string> = {
      processing: "claude-processing",
      done: "claude-done",
      error: "claude-error"
    };

    // First, get or create the label
    const labelQuery = `
      query GetLabels($filter: IssueLabelFilter) {
        issueLabels(filter: $filter) {
          nodes {
            id
            name
          }
        }
      }
    `;

    // For now, just log - implementing full label management would require more API calls
    console.log(`[LinearAdapter] Would set label "${labelNames[status]}" on issue ${threadId}`);
  }

  getAuthUrl(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId!,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "read,write,issues:create,comments:create",
      state,
      prompt: "consent"
    });

    return `${this.authUrl}?${params.toString()}`;
  }

  async handleCallback(code: string, redirectUri: string): Promise<{ accessToken: string; refreshToken?: string }> {
    // Linear uses PKCE, but for server-side flow we can use standard OAuth
    const response = await fetch(this.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: this.config.clientId!,
        client_secret: this.config.clientSecret!,
        redirect_uri: redirectUri,
        code
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to exchange code: ${error}`);
    }

    const data = await response.json() as { access_token: string; refresh_token?: string };
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token
    };
  }

  /**
   * Register a webhook with Linear
   */
  async registerWebhook(url: string, teamId?: string): Promise<{ id: string; secret: string }> {
    if (!this.config.accessToken) {
      throw new Error("Linear access token not configured");
    }

    const mutation = `
      mutation CreateWebhook($input: WebhookCreateInput!) {
        webhookCreate(input: $input) {
          success
          webhook {
            id
            secret
          }
        }
      }
    `;

    const input: Record<string, unknown> = {
      url,
      resourceTypes: ["Issue", "Comment"],
      enabled: true
    };

    if (teamId) {
      input.teamId = teamId;
    }

    const response = await fetch(this.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": this.config.accessToken
      },
      body: JSON.stringify({
        query: mutation,
        variables: { input }
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to register webhook: ${await response.text()}`);
    }

    const result = await response.json() as {
      data?: { webhookCreate?: { success: boolean; webhook?: { id: string; secret: string } } };
      errors?: Array<{ message: string }>;
    };

    if (result.errors || !result.data?.webhookCreate?.success) {
      throw new Error(`Failed to create webhook: ${JSON.stringify(result.errors)}`);
    }

    const webhook = result.data.webhookCreate.webhook!;
    console.log(`[LinearAdapter] Registered webhook: ${webhook.id}`);

    return { id: webhook.id, secret: webhook.secret };
  }
}
