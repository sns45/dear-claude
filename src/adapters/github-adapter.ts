/**
 * GitHub Adapter
 * Handles GitHub webhooks and API interactions
 * Supports both OAuth and GitHub App authentication
 */

import { createHmac, createSign, timingSafeEqual } from "crypto";
import { readFileSync, appendFileSync } from "fs";
import type { Context } from "hono";

const debugLog = (msg: string) => {
  appendFileSync("/tmp/dear-claude-debug.log", `${new Date().toISOString()} [GitHubAdapter] ${msg}\n`);
};
import type { PlatformAdapter, PlatformEvent, AdapterConfig } from "./platform-adapter.js";

interface GitHubIssue {
  number: number;
  title: string;
  body?: string;
  user?: { login: string };
  labels?: Array<{ name: string }>;
}

interface GitHubComment {
  id: number;
  body: string;
  user?: { login: string };
}

interface GitHubRepository {
  full_name: string;
  owner: { login: string };
  name: string;
}

interface GitHubWebhookPayload {
  action: string;
  issue?: GitHubIssue;
  comment?: GitHubComment;
  repository: GitHubRepository;
  sender: { login: string };
  installation?: { id: number };
}

interface InstallationToken {
  token: string;
  expiresAt: Date;
}

export class GitHubAdapter implements PlatformAdapter {
  readonly platform = "github" as const;
  private config: AdapterConfig;
  private apiUrl = "https://api.github.com";
  private authUrl = "https://github.com/login/oauth/authorize";
  private tokenUrl = "https://github.com/login/oauth/access_token";

  // GitHub App specific
  private appId?: string;
  private privateKey?: string;
  private installationTokens: Map<number, InstallationToken> = new Map();

  constructor(config: AdapterConfig) {
    this.config = config;

    // Load GitHub App credentials if available
    this.appId = process.env.GITHUB_APP_ID;
    const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
    const privateKeyEnv = process.env.GITHUB_APP_PRIVATE_KEY;

    if (privateKeyPath) {
      try {
        this.privateKey = readFileSync(privateKeyPath, "utf-8");
        debugLog(` Loaded GitHub App private key from ${privateKeyPath}`);
      } catch (e) {
        console.error(`[GitHubAdapter] Failed to load private key from ${privateKeyPath}:`, e);
      }
    } else if (privateKeyEnv) {
      // Support inline private key (with escaped newlines)
      this.privateKey = privateKeyEnv.replace(/\\n/g, "\n");
      console.log("[GitHubAdapter] Using GitHub App private key from environment");
    }

    if (this.appId && this.privateKey) {
      debugLog(` GitHub App mode enabled (App ID: ${this.appId}, key length: ${this.privateKey.length})`);
    } else {
      debugLog(` GitHub App mode NOT enabled - appId: ${this.appId ? "set" : "missing"}, privateKey: ${this.privateKey ? "set" : "missing"}`);
      debugLog(` Env vars: GITHUB_APP_ID=${process.env.GITHUB_APP_ID}, GITHUB_APP_PRIVATE_KEY_PATH=${process.env.GITHUB_APP_PRIVATE_KEY_PATH}`);
    }
  }

  isConfigured(): boolean {
    // GitHub App mode OR OAuth mode
    return !!(
      (this.appId && this.privateKey) ||
      this.config.accessToken ||
      (this.config.clientId && this.config.clientSecret)
    );
  }

  isAppMode(): boolean {
    return !!(this.appId && this.privateKey);
  }

  /**
   * Generate a JWT for GitHub App authentication
   */
  private generateAppJwt(): string {
    if (!this.appId || !this.privateKey) {
      throw new Error("GitHub App credentials not configured");
    }

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iat: now - 60, // Issued 60 seconds ago to account for clock drift
      exp: now + 600, // Expires in 10 minutes
      iss: this.appId
    };

    // Create JWT manually (header.payload.signature)
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const unsigned = `${header}.${body}`;

    const sign = createSign("RSA-SHA256");
    sign.update(unsigned);
    const signature = sign.sign(this.privateKey, "base64url");

    return `${unsigned}.${signature}`;
  }

  /**
   * Get an installation access token for a specific installation
   */
  private async getInstallationToken(installationId: number): Promise<string> {
    // Check cache
    const cached = this.installationTokens.get(installationId);
    if (cached && cached.expiresAt > new Date(Date.now() + 60000)) {
      debugLog(` Using cached installation token`);
      return cached.token;
    }

    debugLog(` Generating JWT for app ID: ${this.appId}`);
    const jwt = this.generateAppJwt();
    debugLog(` JWT generated, length: ${jwt.length}`);

    const response = await fetch(`${this.apiUrl}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });

    debugLog(` Installation token response: ${response.status}`);

    if (!response.ok) {
      const error = await response.text();
      debugLog(` Installation token error: ${error}`);
      throw new Error(`Failed to get installation token: ${error}`);
    }

    const data = await response.json() as { token: string; expires_at: string };

    // Cache the token
    this.installationTokens.set(installationId, {
      token: data.token,
      expiresAt: new Date(data.expires_at)
    });

    debugLog(` Got installation token for installation ${installationId}`);
    return data.token;
  }

  /**
   * Get access token - either from OAuth or GitHub App installation
   */
  private async getAccessToken(installationId?: number): Promise<string> {
    // Use installation ID from parameter, env var, or fallback
    const effectiveInstallationId = installationId ||
      (process.env.GITHUB_INSTALLATION_ID ? parseInt(process.env.GITHUB_INSTALLATION_ID) : undefined);

    debugLog(` getAccessToken: isAppMode=${this.isAppMode()}, effectiveInstallationId=${effectiveInstallationId}`);

    if (this.isAppMode() && effectiveInstallationId) {
      return this.getInstallationToken(effectiveInstallationId);
    }

    if (this.config.accessToken) {
      debugLog(` Using OAuth token`);
      return this.config.accessToken;
    }

    throw new Error("No access token available");
  }

  setAccessToken(token: string): void {
    this.config.accessToken = token;
  }

  async verifySignature(ctx: Context, body: string): Promise<boolean> {
    if (!this.config.webhookSecret) {
      console.warn("[GitHubAdapter] No webhook secret configured, skipping verification");
      return true;
    }

    const signature = ctx.req.header("x-hub-signature-256");
    if (!signature) {
      console.warn("[GitHubAdapter] Missing GitHub signature header");
      return false;
    }

    try {
      const hmac = createHmac("sha256", this.config.webhookSecret);
      hmac.update(body);
      const expectedSignature = `sha256=${hmac.digest("hex")}`;

      const sigBuffer = Buffer.from(signature);
      const expectedBuffer = Buffer.from(expectedSignature);

      if (sigBuffer.length !== expectedBuffer.length) {
        console.warn("[GitHubAdapter] Signature length mismatch");
        return false;
      }

      return timingSafeEqual(sigBuffer, expectedBuffer);
    } catch (error) {
      console.error("[GitHubAdapter] Signature verification error:", error);
      return false;
    }
  }

  async parseWebhook(ctx: Context, body: unknown): Promise<PlatformEvent | null> {
    const event = ctx.req.header("x-github-event");
    const payload = body as GitHubWebhookPayload;

    // Extract installation ID for GitHub App mode
    const installationId = payload.installation?.id;

    // Handle issue events
    if (event === "issues" && payload.action === "opened" && payload.issue) {
      return {
        platform: "github",
        threadId: `${payload.repository.full_name}#${payload.issue.number}`,
        content: `${payload.issue.title || ""}\n${payload.issue.body || ""}`,
        isDescription: true,
        authorId: payload.issue.user?.login,
        installationId, // Pass installation ID for GitHub App mode
        raw: payload
      };
    }

    // Handle issue comment events
    if (event === "issue_comment" && payload.action === "created" && payload.comment && payload.issue) {
      return {
        platform: "github",
        threadId: `${payload.repository.full_name}#${payload.issue.number}`,
        content: payload.comment.body || "",
        isDescription: false,
        messageId: String(payload.comment.id),
        authorId: payload.comment.user?.login,
        installationId, // Pass installation ID for GitHub App mode
        raw: payload
      };
    }

    return null;
  }

  async postResponse(threadId: string, message: string, installationId?: number): Promise<void> {
    debugLog(` postResponse called - threadId: ${threadId}, installationId: ${installationId}, isAppMode: ${this.isAppMode()}`);
    const token = await this.getAccessToken(installationId);
    debugLog(` Got token: ${token ? "yes (length: " + token.length + ")" : "no"}`);

    // Parse threadId: "owner/repo#number"
    const match = threadId.match(/^(.+?)#(\d+)$/);
    if (!match) {
      throw new Error(`Invalid thread ID format: ${threadId}`);
    }

    const [, repo, issueNumber] = match;

    const response = await fetch(`${this.apiUrl}/repos/${repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      body: JSON.stringify({ body: message })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to post GitHub comment: ${error}`);
    }

    const mode = this.isAppMode() ? "[bot]" : "[oauth]";
    debugLog(` Posted comment to ${threadId} ${mode}`);
  }

  async setStatus(threadId: string, status: "processing" | "done" | "error", installationId?: number): Promise<void> {
    let token: string;
    try {
      token = await this.getAccessToken(installationId);
    } catch {
      return; // No token available
    }

    // Parse threadId
    const match = threadId.match(/^(.+?)#(\d+)$/);
    if (!match) return;

    const [, repo, issueNumber] = match;

    // Map status to label names
    const labelToAdd = `claude-${status}`;
    const labelsToRemove = ["claude-processing", "claude-done", "claude-error"].filter(l => l !== labelToAdd);

    // Remove old status labels and add new one
    try {
      // Get current labels
      const issueResponse = await fetch(`${this.apiUrl}/repos/${repo}/issues/${issueNumber}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json"
        }
      });

      if (!issueResponse.ok) return;

      const issue = await issueResponse.json() as GitHubIssue;
      const currentLabels = (issue.labels || []).map(l => l.name);

      // Filter out claude status labels and add new one
      const newLabels = currentLabels
        .filter(l => !labelsToRemove.includes(l) && l !== labelToAdd)
        .concat(labelToAdd);

      // Update labels
      await fetch(`${this.apiUrl}/repos/${repo}/issues/${issueNumber}/labels`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/vnd.github+json"
        },
        body: JSON.stringify({ labels: newLabels })
      });

      debugLog(` Set label "${labelToAdd}" on ${threadId}`);
    } catch (error) {
      console.error(`[GitHubAdapter] Failed to set status label:`, error);
    }
  }

  getAuthUrl(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId!,
      redirect_uri: redirectUri,
      scope: "repo read:user",
      state
    });

    return `${this.authUrl}?${params.toString()}`;
  }

  async handleCallback(code: string, redirectUri: string): Promise<{ accessToken: string; refreshToken?: string; username?: string }> {
    const response = await fetch(this.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: redirectUri
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to exchange code: ${error}`);
    }

    const data = await response.json() as { access_token: string; refresh_token?: string; error?: string };

    if (data.error) {
      throw new Error(`OAuth error: ${data.error}`);
    }

    // Fetch the authenticated user's profile to get their username
    let username: string | undefined;
    try {
      const userResponse = await fetch(`${this.apiUrl}/user`, {
        headers: {
          Authorization: `Bearer ${data.access_token}`,
          Accept: "application/vnd.github+json"
        }
      });
      if (userResponse.ok) {
        const userData = await userResponse.json() as { login: string };
        username = userData.login;
        debugLog(` Authenticated as: ${username}`);
      }
    } catch (err) {
      console.error("[GitHubAdapter] Failed to fetch user profile:", err);
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      username
    };
  }

  /**
   * Create a webhook for a repository
   */
  async createWebhook(owner: string, repo: string, url: string, secret: string): Promise<{ id: number }> {
    if (!this.config.accessToken) {
      throw new Error("GitHub access token not configured");
    }

    const response = await fetch(`${this.apiUrl}/repos/${owner}/${repo}/hooks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json"
      },
      body: JSON.stringify({
        name: "web",
        active: true,
        events: ["issues", "issue_comment"],
        config: {
          url,
          content_type: "json",
          secret,
          insecure_ssl: "0"
        }
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to create webhook: ${error}`);
    }

    const webhook = await response.json() as { id: number };
    debugLog(` Created webhook ${webhook.id} for ${owner}/${repo}`);

    return webhook;
  }
}
