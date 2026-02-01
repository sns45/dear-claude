import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { DatabaseManager } from "../src/db/schema";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let db: DatabaseManager;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "dear-claude-test-"));
  db = new DatabaseManager(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("DatabaseManager - Instances", () => {
  test("creates and retrieves an instance", () => {
    const instance = db.createInstance({
      id: "test-1",
      thread_id: "repo/test#1",
      platform: "github",
      status: "pending",
      working_dir: "/tmp/test",
      original_prompt: "Do something",
      expires_at: Date.now() + 86400000,
    });

    expect(instance.id).toBe("test-1");
    expect(instance.created_at).toBeGreaterThan(0);

    const retrieved = db.getInstance("test-1");
    expect(retrieved).toBeDefined();
    expect(retrieved!.thread_id).toBe("repo/test#1");
    expect(retrieved!.platform).toBe("github");
    expect(retrieved!.status).toBe("pending");
  });

  test("returns undefined for non-existent instance", () => {
    expect(db.getInstance("nonexistent")).toBeFalsy();
  });

  test("gets instance by thread and platform", () => {
    db.createInstance({
      id: "test-1",
      thread_id: "repo/test#1",
      platform: "github",
      status: "idle",
      working_dir: "/tmp/test",
      original_prompt: "Do something",
      expires_at: Date.now() + 86400000,
    });

    const found = db.getInstanceByThread("repo/test#1", "github");
    expect(found).toBeDefined();
    expect(found!.id).toBe("test-1");

    const notFound = db.getInstanceByThread("repo/test#1", "linear");
    expect(notFound).toBeFalsy();
  });

  test("excludes expired instances from thread lookup", () => {
    db.createInstance({
      id: "test-expired",
      thread_id: "repo/test#1",
      platform: "github",
      status: "pending",
      working_dir: "/tmp/test",
      original_prompt: "Do something",
      expires_at: Date.now() - 1000, // already expired timestamp
    });
    db.updateInstanceStatus("test-expired", "expired");

    const found = db.getInstanceByThread("repo/test#1", "github");
    expect(found).toBeFalsy();
  });

  test("updates instance status", () => {
    db.createInstance({
      id: "test-1",
      thread_id: "repo/test#1",
      platform: "github",
      status: "pending",
      working_dir: "/tmp/test",
      original_prompt: "Do something",
      expires_at: Date.now() + 86400000,
    });

    db.updateInstanceStatus("test-1", "running");
    expect(db.getInstance("test-1")!.status).toBe("running");

    db.updateInstanceStatus("test-1", "idle", "Task completed");
    const updated = db.getInstance("test-1")!;
    expect(updated.status).toBe("idle");
    expect(updated.completion_summary).toBe("Task completed");
  });

  test("gets active instances", () => {
    db.createInstance({
      id: "active-1",
      thread_id: "t1",
      platform: "github",
      status: "running",
      working_dir: "/tmp/1",
      original_prompt: "task 1",
      expires_at: Date.now() + 86400000,
    });
    db.createInstance({
      id: "active-2",
      thread_id: "t2",
      platform: "github",
      status: "idle",
      working_dir: "/tmp/2",
      original_prompt: "task 2",
      expires_at: Date.now() + 86400000,
    });
    db.createInstance({
      id: "done-1",
      thread_id: "t3",
      platform: "github",
      status: "completed",
      working_dir: "/tmp/3",
      original_prompt: "task 3",
      expires_at: Date.now() + 86400000,
    });

    const active = db.getActiveInstances();
    expect(active.length).toBe(2);
    expect(active.map(i => i.id)).toContain("active-1");
    expect(active.map(i => i.id)).toContain("active-2");
  });

  test("cleans up expired instances", () => {
    db.createInstance({
      id: "expired-1",
      thread_id: "t1",
      platform: "github",
      status: "idle",
      working_dir: "/tmp/1",
      original_prompt: "old task",
      expires_at: Date.now() - 1000, // already past
    });

    const count = db.cleanupExpired();
    expect(count).toBe(1);
    expect(db.getInstance("expired-1")!.status).toBe("expired");
  });
});

describe("DatabaseManager - Messages", () => {
  test("adds and retrieves messages", () => {
    db.createInstance({
      id: "inst-1",
      thread_id: "t1",
      platform: "github",
      status: "running",
      working_dir: "/tmp/1",
      original_prompt: "task",
      expires_at: Date.now() + 86400000,
    });

    db.addMessage({
      id: "msg-1",
      instance_id: "inst-1",
      role: "user",
      content: "Hello",
    });
    db.addMessage({
      id: "msg-2",
      instance_id: "inst-1",
      role: "assistant",
      content: "Hi there",
    });

    const messages = db.getMessages("inst-1");
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Hello");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("Hi there");
  });

  test("messages are ordered by created_at", () => {
    db.createInstance({
      id: "inst-1",
      thread_id: "t1",
      platform: "github",
      status: "running",
      working_dir: "/tmp/1",
      original_prompt: "task",
      expires_at: Date.now() + 86400000,
    });

    db.addMessage({ id: "msg-1", instance_id: "inst-1", role: "user", content: "First" });
    db.addMessage({ id: "msg-2", instance_id: "inst-1", role: "assistant", content: "Second" });
    db.addMessage({ id: "msg-3", instance_id: "inst-1", role: "user", content: "Third" });

    const messages = db.getMessages("inst-1");
    expect(messages[0].content).toBe("First");
    expect(messages[2].content).toBe("Third");
  });
});

describe("DatabaseManager - OAuth", () => {
  test("saves and retrieves OAuth token", () => {
    db.saveOAuthToken({
      id: "token-1",
      provider: "github",
      user_id: "user-1",
      access_token: "gho_test123",
      scope: "repo",
      platform_username: "testuser",
    });

    const token = db.getOAuthToken("github", "user-1");
    expect(token).toBeDefined();
    expect(token!.access_token).toBe("gho_test123");
    expect(token!.platform_username).toBe("testuser");
  });

  test("gets platform username", () => {
    db.saveOAuthToken({
      id: "token-1",
      provider: "github",
      user_id: "user-1",
      access_token: "test",
      scope: "repo",
      platform_username: "mylogin",
    });

    expect(db.getPlatformUsername("github")).toBe("mylogin");
    expect(db.getPlatformUsername("linear")).toBeUndefined();
  });
});
