import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { DatabaseManager } from "../src/db/schema";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let db: DatabaseManager;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "dear-claude-db-platform-test-"));
  db = new DatabaseManager(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Database - Notion platform support", () => {
  test("creates instance with platform 'notion'", () => {
    const instance = db.createInstance({
      id: "notion-1",
      thread_id: "notion:page-abc",
      platform: "notion",
      status: "pending",
      working_dir: "/tmp/notion-test",
      original_prompt: "Summarize this page",
      expires_at: Date.now() + 86400000,
    });

    expect(instance.id).toBe("notion-1");
    expect(instance.platform).toBe("notion");

    const retrieved = db.getInstance("notion-1");
    expect(retrieved).toBeDefined();
    expect(retrieved!.platform).toBe("notion");
  });

  test("retrieves instance by thread for notion", () => {
    db.createInstance({
      id: "notion-2",
      thread_id: "notion:page-xyz",
      platform: "notion",
      status: "idle",
      working_dir: "/tmp/test",
      original_prompt: "test",
      expires_at: Date.now() + 86400000,
    });

    const found = db.getInstanceByThread("notion:page-xyz", "notion");
    expect(found).toBeDefined();
    expect(found!.id).toBe("notion-2");
  });

  test("saves and retrieves OAuth token for notion provider", () => {
    db.saveOAuthToken({
      id: "token-notion",
      provider: "notion",
      user_id: "default",
      access_token: "ntn_test_token",
      scope: "",
      platform_username: "bot-123",
    });

    const token = db.getOAuthToken("notion", "default");
    expect(token).toBeDefined();
    expect(token!.access_token).toBe("ntn_test_token");
    expect(token!.platform_username).toBe("bot-123");
  });

  test("saves webhook config for notion", () => {
    db.saveWebhookConfig({
      id: "wh-notion",
      platform: "notion",
      webhook_id: "wh-1",
      webhook_secret: "secret-notion",
    });

    const config = db.getWebhookConfig("notion");
    expect(config).toBeDefined();
    expect(config!.webhook_secret).toBe("secret-notion");
  });
});

describe("Database - Obsidian platform support", () => {
  test("creates instance with platform 'obsidian'", () => {
    const instance = db.createInstance({
      id: "obsidian-1",
      thread_id: "obsidian:notes/test.md",
      platform: "obsidian",
      status: "pending",
      working_dir: "/vault/path",
      original_prompt: "Write a haiku",
      expires_at: Date.now() + 86400000,
    });

    expect(instance.id).toBe("obsidian-1");
    expect(instance.platform).toBe("obsidian");
  });

  test("retrieves instance by thread for obsidian", () => {
    db.createInstance({
      id: "obsidian-2",
      thread_id: "obsidian:daily/2026-02-06.md",
      platform: "obsidian",
      status: "running",
      working_dir: "/vault",
      original_prompt: "test",
      expires_at: Date.now() + 86400000,
    });

    const found = db.getInstanceByThread("obsidian:daily/2026-02-06.md", "obsidian");
    expect(found).toBeDefined();
    expect(found!.id).toBe("obsidian-2");

    // Should not find for different platform
    const notFound = db.getInstanceByThread("obsidian:daily/2026-02-06.md", "notion");
    expect(notFound).toBeFalsy();
  });

  test("saves webhook config for obsidian", () => {
    db.saveWebhookConfig({
      id: "wh-obs",
      platform: "obsidian",
    });

    const config = db.getWebhookConfig("obsidian");
    expect(config).toBeDefined();
    expect(config!.platform).toBe("obsidian");
  });
});

describe("Database - Mixed platform instances", () => {
  test("active instances span multiple platforms", () => {
    for (const [id, platform] of [
      ["gh-1", "github"],
      ["lin-1", "linear"],
      ["not-1", "notion"],
      ["obs-1", "obsidian"],
      ["jira-1", "jira"],
    ] as const) {
      db.createInstance({
        id,
        thread_id: `${platform}:thread`,
        platform,
        status: "running",
        working_dir: `/tmp/${id}`,
        original_prompt: "test",
        expires_at: Date.now() + 86400000,
      });
    }

    const active = db.getActiveInstances();
    expect(active.length).toBe(5);
    const platforms = active.map(i => i.platform);
    expect(platforms).toContain("notion");
    expect(platforms).toContain("obsidian");
    expect(platforms).toContain("github");
  });
});
