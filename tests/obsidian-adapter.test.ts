import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ObsidianAdapter } from "../src/adapters/obsidian-adapter";

let tmpDir: string;
let adapter: ObsidianAdapter;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "obsidian-test-"));
  adapter = new ObsidianAdapter(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("ObsidianAdapter", () => {
  describe("platform identity", () => {
    test("platform is 'obsidian'", () => {
      expect(adapter.platform).toBe("obsidian");
    });
  });

  describe("isConfigured", () => {
    test("returns true when vault path exists", () => {
      expect(adapter.isConfigured()).toBe(true);
    });

    test("returns false when vault path does not exist", () => {
      const bad = new ObsidianAdapter("/nonexistent/path/vault");
      expect(bad.isConfigured()).toBe(false);
    });
  });

  describe("verifySignature (no-op)", () => {
    test("always returns true", async () => {
      const result = await adapter.verifySignature(null as any, "");
      expect(result).toBe(true);
    });
  });

  describe("parseWebhook (no-op)", () => {
    test("always returns null", async () => {
      const result = await adapter.parseWebhook(null as any, {});
      expect(result).toBeNull();
    });
  });

  describe("postResponse", () => {
    test("appends callout block to existing file", async () => {
      const filePath = join(tmpDir, "test-note.md");
      writeFileSync(filePath, "# My Note\n\nDear Claude, help me\n");

      await adapter.postResponse("obsidian:test-note.md", "Here is my response");

      const content = readFileSync(filePath, "utf-8");
      expect(content).toContain("> [!claude] Claude Response");
      expect(content).toContain("> Here is my response");
      expect(content).toContain("*Instance:");
      // Original content preserved
      expect(content).toContain("# My Note");
      expect(content).toContain("Dear Claude, help me");
    });

    test("handles multi-line response", async () => {
      const filePath = join(tmpDir, "multi.md");
      writeFileSync(filePath, "Dear Claude, test\n");

      await adapter.postResponse("obsidian:multi.md", "Line 1\nLine 2\nLine 3");

      const content = readFileSync(filePath, "utf-8");
      expect(content).toContain("> Line 1");
      expect(content).toContain("> Line 2");
      expect(content).toContain("> Line 3");
    });

    test("includes separator before callout", async () => {
      const filePath = join(tmpDir, "sep.md");
      writeFileSync(filePath, "Content\n");

      await adapter.postResponse("obsidian:sep.md", "response");

      const content = readFileSync(filePath, "utf-8");
      expect(content).toContain("\n---\n\n> [!claude]");
    });

    test("does nothing for non-existent file", async () => {
      // Should not throw
      await adapter.postResponse("obsidian:does-not-exist.md", "response");
    });

    test("handles nested path in threadId", async () => {
      const subDir = join(tmpDir, "projects");
      mkdirSync(subDir, { recursive: true });
      const filePath = join(subDir, "deep.md");
      writeFileSync(filePath, "Dear Claude, nested test\n");

      await adapter.postResponse("obsidian:projects/deep.md", "Nested response");

      const content = readFileSync(filePath, "utf-8");
      expect(content).toContain("> Nested response");
    });
  });

  describe("setStatus", () => {
    test("creates frontmatter when none exists", async () => {
      const filePath = join(tmpDir, "no-fm.md");
      writeFileSync(filePath, "# No Frontmatter\n\nContent here\n");

      await adapter.setStatus("obsidian:no-fm.md", "processing");

      const content = readFileSync(filePath, "utf-8");
      expect(content).toMatch(/^---\nclaude-status: processing\n---\n/);
      expect(content).toContain("# No Frontmatter");
    });

    test("adds key to existing frontmatter", async () => {
      const filePath = join(tmpDir, "has-fm.md");
      writeFileSync(filePath, "---\ntitle: Test\ntags: [a, b]\n---\n# Content\n");

      await adapter.setStatus("obsidian:has-fm.md", "done");

      const content = readFileSync(filePath, "utf-8");
      expect(content).toContain("title: Test");
      expect(content).toContain("claude-status: done");
      expect(content).toContain("# Content");
    });

    test("updates existing claude-status key", async () => {
      const filePath = join(tmpDir, "update-fm.md");
      writeFileSync(filePath, "---\nclaude-status: processing\ntitle: Note\n---\n# Note\n");

      await adapter.setStatus("obsidian:update-fm.md", "done");

      const content = readFileSync(filePath, "utf-8");
      expect(content).toContain("claude-status: done");
      expect(content).not.toContain("claude-status: processing");
      expect(content).toContain("title: Note");
    });

    test("handles error status", async () => {
      const filePath = join(tmpDir, "err.md");
      writeFileSync(filePath, "---\nclaude-status: processing\n---\nContent\n");

      await adapter.setStatus("obsidian:err.md", "error");

      const content = readFileSync(filePath, "utf-8");
      expect(content).toContain("claude-status: error");
    });

    test("does nothing for non-existent file", async () => {
      // Should not throw
      await adapter.setStatus("obsidian:ghost.md", "done");
    });
  });
});
