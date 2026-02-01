/**
 * Platform Adapter Interface
 * Common interface for all platform integrations
 */

import type { Context } from "hono";

export interface PlatformEvent {
  platform: "linear" | "gmail" | "github";
  threadId: string;
  content: string;
  isDescription: boolean;
  messageId?: string;
  authorId?: string;
  installationId?: number; // GitHub App installation ID
  raw: unknown;
}

export interface PlatformAdapter {
  /** Platform identifier */
  readonly platform: "linear" | "gmail" | "github";

  /** Verify webhook signature */
  verifySignature(ctx: Context, body: string): Promise<boolean>;

  /** Parse webhook payload into PlatformEvent */
  parseWebhook(ctx: Context, body: unknown): Promise<PlatformEvent | null>;

  /** Post a response/comment back to the platform */
  postResponse(threadId: string, message: string, installationId?: number): Promise<void>;

  /** Add a label or status indicator (platform-specific) */
  setStatus?(threadId: string, status: "processing" | "done" | "error", installationId?: number): Promise<void>;

  /** Initialize OAuth flow */
  getAuthUrl?(redirectUri: string, state: string): string;

  /** Exchange code for tokens */
  handleCallback?(code: string, redirectUri: string): Promise<{ accessToken: string; refreshToken?: string; username?: string }>;

  /** Set access token (for injecting DB-stored OAuth tokens) */
  setAccessToken?(token: string): void;

  /** Check if adapter is configured */
  isConfigured(): boolean;
}

export interface AdapterConfig {
  clientId?: string;
  clientSecret?: string;
  webhookSecret?: string;
  accessToken?: string;
  refreshToken?: string;
}
