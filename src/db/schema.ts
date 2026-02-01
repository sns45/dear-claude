/**
 * Database Schema
 * SQLite schema using Bun's built-in SQLite support
 */

import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";

export interface Instance {
  id: string;
  thread_id: string;           // Platform-specific thread/issue ID
  platform: "linear" | "gmail" | "github" | "gitlab";
  status: "pending" | "running" | "completed" | "failed" | "idle" | "expired";
  working_dir: string;
  original_prompt: string;
  completion_summary?: string;
  created_at: number;
  updated_at: number;
  expires_at: number;          // 7 days from last activity
}

export interface Message {
  id: string;
  instance_id: string;
  role: "user" | "assistant";
  content: string;
  platform_message_id?: string;
  created_at: number;
}

export interface OAuthToken {
  id: string;
  provider: "linear" | "google" | "github" | "gitlab";
  user_id: string;
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  scope: string;
  platform_username?: string;  // GitHub login, Linear user ID, etc.
  created_at: number;
  updated_at: number;
}

export interface WebhookConfig {
  id: string;
  platform: "linear" | "gmail" | "github" | "gitlab";
  webhook_id?: string;
  webhook_secret?: string;
  subscription_id?: string;    // For Gmail Pub/Sub
  created_at: number;
}

const SCHEMA = `
-- Instances table
CREATE TABLE IF NOT EXISTS instances (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('linear', 'gmail', 'github', 'gitlab')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'idle', 'expired')),
  working_dir TEXT NOT NULL,
  original_prompt TEXT NOT NULL,
  completion_summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_instances_thread_platform ON instances (thread_id, platform);
CREATE INDEX IF NOT EXISTS idx_instances_status ON instances (status);
CREATE INDEX IF NOT EXISTS idx_instances_expires ON instances (expires_at);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  platform_message_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_instance ON messages (instance_id);

-- OAuth tokens table
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('linear', 'google', 'github', 'gitlab')),
  user_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at INTEGER,
  scope TEXT NOT NULL,
  platform_username TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_provider_user ON oauth_tokens (provider, user_id);

-- Webhook configurations table
CREATE TABLE IF NOT EXISTS webhook_configs (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL UNIQUE CHECK (platform IN ('linear', 'gmail', 'github', 'gitlab')),
  webhook_id TEXT,
  webhook_secret TEXT,
  subscription_id TEXT,
  created_at INTEGER NOT NULL
);
`;

export class DatabaseManager {
  private db: Database;

  constructor(dbPath?: string) {
    const dataDir = join(process.cwd(), "data");
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    const path = dbPath || join(dataDir, "dear-claude.db");
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(SCHEMA);
    this.runMigrations();
    console.log("[Database] Initialized schema");
  }

  private runMigrations(): void {
    // Migration: Add platform_username column to oauth_tokens if it doesn't exist
    try {
      const tableInfo = this.db.prepare("PRAGMA table_info(oauth_tokens)").all() as Array<{ name: string }>;
      const hasColumn = tableInfo.some(col => col.name === "platform_username");
      if (!hasColumn) {
        this.db.exec("ALTER TABLE oauth_tokens ADD COLUMN platform_username TEXT");
        console.log("[Database] Migration: Added platform_username column to oauth_tokens");
      }
    } catch (err) {
      console.error("[Database] Migration error:", err);
    }
  }

  getDatabase(): Database {
    return this.db;
  }

  // Instance operations
  createInstance(instance: Omit<Instance, "created_at" | "updated_at">): Instance {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO instances (id, thread_id, platform, status, working_dir, original_prompt, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      instance.id,
      instance.thread_id,
      instance.platform,
      instance.status,
      instance.working_dir,
      instance.original_prompt,
      instance.expires_at,
      now,
      now
    );
    return { ...instance, created_at: now, updated_at: now };
  }

  getInstance(id: string): Instance | undefined {
    const stmt = this.db.prepare("SELECT * FROM instances WHERE id = ?");
    return stmt.get(id) as Instance | undefined;
  }

  getInstanceByThread(threadId: string, platform: string): Instance | undefined {
    const stmt = this.db.prepare(
      "SELECT * FROM instances WHERE thread_id = ? AND platform = ? AND status NOT IN ('expired') ORDER BY created_at DESC LIMIT 1"
    );
    return stmt.get(threadId, platform) as Instance | undefined;
  }

  updateInstanceStatus(id: string, status: Instance["status"], summary?: string): void {
    const now = Date.now();
    const expiresAt = now + 7 * 24 * 60 * 60 * 1000; // 7 days
    if (summary) {
      const stmt = this.db.prepare(
        "UPDATE instances SET status = ?, completion_summary = ?, updated_at = ?, expires_at = ? WHERE id = ?"
      );
      stmt.run(status, summary, now, expiresAt, id);
    } else {
      const stmt = this.db.prepare(
        "UPDATE instances SET status = ?, updated_at = ?, expires_at = ? WHERE id = ?"
      );
      stmt.run(status, now, expiresAt, id);
    }
  }

  getActiveInstances(): Instance[] {
    const stmt = this.db.prepare(
      "SELECT * FROM instances WHERE status IN ('pending', 'running', 'idle') ORDER BY updated_at DESC"
    );
    return stmt.all() as Instance[];
  }

  getAllInstances(limit: number = 50): Instance[] {
    const stmt = this.db.prepare(
      "SELECT * FROM instances ORDER BY updated_at DESC LIMIT ?"
    );
    return stmt.all(limit) as Instance[];
  }

  // Message operations
  addMessage(message: Omit<Message, "created_at">): Message {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO messages (id, instance_id, role, content, platform_message_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(message.id, message.instance_id, message.role, message.content, message.platform_message_id ?? null, now);
    return { ...message, created_at: now };
  }

  getMessages(instanceId: string): Message[] {
    const stmt = this.db.prepare("SELECT * FROM messages WHERE instance_id = ? ORDER BY created_at ASC");
    return stmt.all(instanceId) as Message[];
  }

  // OAuth operations
  saveOAuthToken(token: Omit<OAuthToken, "created_at" | "updated_at">): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO oauth_tokens (id, provider, user_id, access_token, refresh_token, expires_at, scope, platform_username, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(token.id, token.provider, token.user_id, token.access_token, token.refresh_token ?? null, token.expires_at ?? null, token.scope, token.platform_username ?? null, now, now);
  }

  getOAuthToken(provider: string, userId: string): OAuthToken | undefined {
    const stmt = this.db.prepare("SELECT * FROM oauth_tokens WHERE provider = ? AND user_id = ?");
    return stmt.get(provider, userId) as OAuthToken | undefined;
  }

  getOAuthTokenByProvider(provider: string): OAuthToken | undefined {
    const stmt = this.db.prepare("SELECT * FROM oauth_tokens WHERE provider = ? ORDER BY updated_at DESC LIMIT 1");
    return stmt.get(provider) as OAuthToken | undefined;
  }

  getPlatformUsername(provider: string): string | undefined {
    const token = this.getOAuthTokenByProvider(provider);
    return token?.platform_username ?? undefined;
  }

  // Webhook config operations
  saveWebhookConfig(config: Omit<WebhookConfig, "created_at">): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO webhook_configs (id, platform, webhook_id, webhook_secret, subscription_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(config.id, config.platform, config.webhook_id ?? null, config.webhook_secret ?? null, config.subscription_id ?? null, now);
  }

  getWebhookConfig(platform: string): WebhookConfig | undefined {
    const stmt = this.db.prepare("SELECT * FROM webhook_configs WHERE platform = ?");
    return stmt.get(platform) as WebhookConfig | undefined;
  }

  // Cleanup expired instances
  cleanupExpired(): number {
    const now = Date.now();
    const stmt = this.db.prepare("UPDATE instances SET status = 'expired' WHERE expires_at < ? AND status != 'expired'");
    const result = stmt.run(now);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
