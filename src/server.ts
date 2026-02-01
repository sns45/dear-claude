/**
 * Hono HTTP Server
 * Handles webhooks and OAuth callbacks
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { appendFileSync } from "fs";
const debugLog = (msg: string) => {
  appendFileSync("/tmp/dear-claude-debug.log", `${new Date().toISOString()} ${msg}\n`);
};
import type { DatabaseManager } from "./db/schema.js";
import type { InstanceManager } from "./core/instance-manager.js";
import type { ClaudeExecutor, PlatformCallbacks } from "./core/claude-executor.js";
import { TriggerDetector } from "./core/trigger-detector.js";
import { LinearAdapter } from "./adapters/linear-adapter.js";
import { GmailAdapter } from "./adapters/gmail-adapter.js";
import { GitHubAdapter } from "./adapters/github-adapter.js";
import type { PlatformAdapter } from "./adapters/platform-adapter.js";
import { sanitize } from "./utils/sanitize.js";

export interface ServerConfig {
  port: number;
  publicUrl?: string;
  linear?: {
    clientId?: string;
    clientSecret?: string;
    webhookSecret?: string;
    accessToken?: string;
  };
  gmail?: {
    clientId?: string;
    clientSecret?: string;
    accessToken?: string;
    refreshToken?: string;
    pubsubTopic?: string;
  };
  github?: {
    clientId?: string;
    clientSecret?: string;
    webhookSecret?: string;
    accessToken?: string;
  };
}

export function createServer(
  config: ServerConfig,
  db: DatabaseManager,
  instanceManager: InstanceManager,
  executor: ClaudeExecutor
): Hono {
  const app = new Hono();

  // Middleware
  app.use("*", logger());
  app.use("*", cors());

  // Initialize adapters
  const adapters: Map<string, PlatformAdapter> = new Map();

  if (config.linear) {
    adapters.set("linear", new LinearAdapter(config.linear));
  }
  if (config.gmail) {
    adapters.set("gmail", new GmailAdapter(config.gmail));
  }
  if (config.github) {
    adapters.set("github", new GitHubAdapter(config.github));
  }

  // Health check
  app.get("/health", async (c) => {
    const publicUrl = config.publicUrl;

    return c.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      transport: "tailscale",
      publicUrl: publicUrl || null,
      webhooks: publicUrl ? {
        github: `${publicUrl}/webhook/github`,
        linear: `${publicUrl}/webhook/linear`,
        gmail: `${publicUrl}/webhook/gmail`
      } : null,
      oauth: publicUrl ? {
        github: `${publicUrl}/setup/github`,
        linear: `${publicUrl}/setup/linear`,
        gmail: `${publicUrl}/setup/gmail`
      } : null,
      platforms: {
        linear: adapters.has("linear"),
        gmail: adapters.has("gmail"),
        github: adapters.has("github")
      },
      authenticatedUsers: {
        github: db.getPlatformUsername("github") || null,
        linear: db.getPlatformUsername("linear") || null,
        google: db.getPlatformUsername("google") || null
      }
    });
  });

  // Webhook endpoints
  app.post("/webhook/:platform", async (c) => {
    const platform = c.req.param("platform") as "linear" | "gmail" | "github";
    const adapter = adapters.get(platform);

    if (!adapter) {
      return c.json({ error: `Platform ${platform} not configured` }, 400);
    }

    // Get raw body for signature verification
    const rawBody = await c.req.text();

    // Verify signature
    const isValid = await adapter.verifySignature(c, rawBody);
    if (!isValid) {
      console.warn(`[Server] Invalid ${platform} webhook signature`);
      return c.json({ error: "Invalid signature" }, 401);
    }

    // Parse webhook
    const body = JSON.parse(rawBody);
    const event = await adapter.parseWebhook(c, body);

    if (!event) {
      // Not a relevant event
      return c.json({ status: "ignored" });
    }

    // Check if the event is from the authenticated user (user filtering)
    const authenticatedUsername = db.getPlatformUsername(platform);
    if (authenticatedUsername && event.authorId) {
      if (event.authorId.toLowerCase() !== authenticatedUsername.toLowerCase()) {
        console.log(`[Server] Ignoring event from ${event.authorId} (authenticated user: ${authenticatedUsername})`);
        return c.json({ status: "ignored", reason: "Event not from authenticated user" });
      }
    }

    // Check for trigger
    if (!TriggerDetector.containsTrigger(event.content)) {
      console.log(`[Server] No trigger found in ${platform} event for thread ${event.threadId}`);
      return c.json({ status: "no_trigger" });
    }

    // Process the event
    const triggerContext = {
      threadId: event.threadId,
      platform: event.platform,
      content: event.content,
      isDescription: event.isDescription,
      messageId: event.messageId,
      authorId: event.authorId,
      timestamp: Date.now()
    };

    const result = await instanceManager.processEvent(triggerContext);
    console.log(`[Server] Trigger result for ${platform}:${event.threadId}: ${result.action} - ${result.reason}`);

    if (result.action === "IGNORE") {
      return c.json({ status: "ignored", reason: result.reason });
    }

    // Get access token from DB if not in config (for OAuth-authenticated adapters)
    const dbToken = db.getOAuthTokenByProvider(platform);
    if (dbToken?.access_token && adapter.setAccessToken) {
      adapter.setAccessToken(dbToken.access_token);
    }

    // Set up platform callbacks
    // Pass installationId for GitHub App mode
    const installationId = event.installationId;

    const callbacks: PlatformCallbacks = {
      onStart: async (instanceId, message) => {
        debugLog(`onStart called for ${instanceId}, installationId: ${installationId}`);
        try {
          // Sanitize message before posting to remove sensitive info
          const safeMessage = sanitize(message);
          await adapter.postResponse(event.threadId, safeMessage, installationId);
          debugLog(`onStart postResponse succeeded`);
          if (adapter.setStatus) {
            await adapter.setStatus(event.threadId, "processing", installationId);
          }
        } catch (err) {
          debugLog(`onStart failed: ${err}`);
          console.error(`[Server] Failed to send start message:`, err);
        }
      },
      onComplete: async (instanceId, summary) => {
        try {
          // Sanitize summary before posting to remove sensitive info
          const safeSummary = sanitize(summary);
          await adapter.postResponse(event.threadId, safeSummary, installationId);
          if (adapter.setStatus) {
            await adapter.setStatus(event.threadId, "done", installationId);
          }
        } catch (err) {
          console.error(`[Server] Failed to send completion message:`, err);
        }
      },
      onError: async (instanceId, error) => {
        try {
          // Sanitize error message before posting to remove sensitive info
          const safeError = sanitize(error);
          await adapter.postResponse(event.threadId, `**Error**\n${safeError}`, installationId);
          if (adapter.setStatus) {
            await adapter.setStatus(event.threadId, "error", installationId);
          }
        } catch (err) {
          console.error(`[Server] Failed to send error message:`, err);
        }
      }
    };

    // Execute Claude
    const isResume = result.action === "RESUME";
    executor.execute(result.instanceId!, isResume, callbacks).catch((err) => {
      console.error(`[Server] Execution error:`, err);
    });

    return c.json({
      status: result.action.toLowerCase(),
      instanceId: result.instanceId,
      reason: result.reason
    });
  });

  // OAuth callback endpoints
  app.get("/oauth/callback/:platform", async (c) => {
    const platform = c.req.param("platform") as "linear" | "gmail" | "github";
    const adapter = adapters.get(platform);

    if (!adapter || !adapter.handleCallback) {
      return c.json({ error: `Platform ${platform} not configured for OAuth` }, 400);
    }

    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");

    if (error) {
      return c.html(`
        <html>
          <body>
            <h1>OAuth Error</h1>
            <p>${error}</p>
            <p>You can close this window.</p>
          </body>
        </html>
      `);
    }

    if (!code) {
      return c.json({ error: "Missing code parameter" }, 400);
    }

    try {
      const redirectUri = `${config.publicUrl}/oauth/callback/${platform}`;
      const tokens = await adapter.handleCallback(code, redirectUri);

      // Save tokens to database
      // Map gmail platform to google provider (OAuth provider name)
      const oauthProvider = platform === "gmail" ? "google" : platform;
      db.saveOAuthToken({
        id: crypto.randomUUID(),
        provider: oauthProvider,
        user_id: "default",  // Single-user for now
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        platform_username: tokens.username,  // Store the authenticated user's username
        scope: ""
      });

      const usernameInfo = tokens.username ? ` as <strong>${tokens.username}</strong>` : "";
      return c.html(`
        <html>
          <body>
            <h1>Success!</h1>
            <p>${platform} has been connected${usernameInfo}.</p>
            <p>Only your issues/comments will trigger Claude instances.</p>
            <p>You can close this window and return to the terminal.</p>
          </body>
        </html>
      `);
    } catch (err) {
      console.error(`[Server] OAuth callback error:`, err);
      return c.html(`
        <html>
          <body>
            <h1>OAuth Error</h1>
            <p>${err instanceof Error ? err.message : "Unknown error"}</p>
            <p>Please try again.</p>
          </body>
        </html>
      `);
    }
  });

  // Setup initiation endpoints (for CLI to open in browser)
  app.get("/setup/:platform", (c) => {
    const platform = c.req.param("platform") as "linear" | "gmail" | "github";
    const adapter = adapters.get(platform);

    if (!adapter || !adapter.getAuthUrl) {
      return c.json({ error: `Platform ${platform} not configured for OAuth` }, 400);
    }

    const state = crypto.randomUUID();
    const redirectUri = `${config.publicUrl}/oauth/callback/${platform}`;
    const authUrl = adapter.getAuthUrl(redirectUri, state);

    return c.redirect(authUrl);
  });

  // API endpoints for MCP tools
  app.get("/api/instances", (c) => {
    const instances = instanceManager.getAllInstances(50);
    return c.json({ instances });
  });

  app.get("/api/instances/:id", (c) => {
    const id = c.req.param("id");
    const instance = instanceManager.getInstance(id);

    if (!instance) {
      return c.json({ error: "Instance not found" }, 404);
    }

    const messages = instanceManager.getMessages(id);
    return c.json({ instance, messages });
  });

  app.post("/api/instances/:id/kill", (c) => {
    const id = c.req.param("id");
    const killed = executor.kill(id);
    return c.json({ success: killed });
  });

  app.get("/api/platforms", (c) => {
    const platforms: Record<string, boolean> = {};
    for (const [name, adapter] of adapters) {
      platforms[name] = adapter.isConfigured();
    }
    return c.json({ platforms });
  });

  return app;
}
