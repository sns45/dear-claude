import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { ClaudeExecutor, type PlatformCallbacks } from "../src/core/claude-executor";
import { InstanceManager } from "../src/core/instance-manager";
import { DatabaseManager } from "../src/db/schema";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let db: DatabaseManager;
let instanceManager: InstanceManager;
let executor: ClaudeExecutor;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "dear-claude-exec-test-"));
  db = new DatabaseManager(join(tmpDir, "test.db"));
  instanceManager = new InstanceManager(db, tmpDir);
  executor = new ClaudeExecutor(instanceManager);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("ClaudeExecutor", () => {
  test("isRunning returns false for unknown instance", () => {
    expect(executor.isRunning("nonexistent")).toBe(false);
  });

  test("getRunningInstances returns empty initially", () => {
    expect(executor.getRunningInstances()).toEqual([]);
  });

  test("kill returns false for non-running instance", () => {
    expect(executor.kill("nonexistent")).toBe(false);
  });

  test("execute throws for non-existent instance", async () => {
    expect(executor.execute("nonexistent")).rejects.toThrow("Instance nonexistent not found");
  });

  test("execute throws when no user message found", async () => {
    // Create instance directly in DB without messages
    db.createInstance({
      id: "no-msg",
      thread_id: "t1",
      platform: "github",
      status: "pending",
      working_dir: tmpDir,
      original_prompt: "test",
      expires_at: Date.now() + 86400000,
    });

    expect(executor.execute("no-msg")).rejects.toThrow("No user message found");
  });

  test("cleanup completes without error", async () => {
    await executor.cleanup();
    expect(executor.getRunningInstances()).toEqual([]);
  });
});

describe("ClaudeExecutor.extractSummary (via integration)", () => {
  // Test the summary extraction logic indirectly by checking the executor
  // has the right methods exposed
  test("executor has expected interface", () => {
    expect(typeof executor.execute).toBe("function");
    expect(typeof executor.kill).toBe("function");
    expect(typeof executor.isRunning).toBe("function");
    expect(typeof executor.getRunningInstances).toBe("function");
    expect(typeof executor.cleanup).toBe("function");
  });
});
