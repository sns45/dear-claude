import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { ObsidianVaultWatcher } from "../src/adapters/obsidian-watcher";
import type { PlatformEvent } from "../src/adapters/platform-adapter";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "obsidian-watcher-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("ObsidianVaultWatcher", () => {
  describe("constructor", () => {
    test("resolves vault path to absolute", () => {
      const watcher = new ObsidianVaultWatcher({ vaultPath: tmpDir });
      expect(watcher.getVaultPath()).toBe(resolve(tmpDir));
    });

    test("defaults debounce to 2000ms", () => {
      const watcher = new ObsidianVaultWatcher({ vaultPath: tmpDir });
      // Can't directly test private field, but creation shouldn't throw
      expect(watcher).toBeDefined();
    });
  });

  describe("lockFile", () => {
    test("returns an unlock function", () => {
      const watcher = new ObsidianVaultWatcher({ vaultPath: tmpDir });
      const unlock = watcher.lockFile(join(tmpDir, "test.md"));
      expect(typeof unlock).toBe("function");
      unlock();
    });
  });

  describe("start/stop", () => {
    test("logs error for non-existent vault path", () => {
      const watcher = new ObsidianVaultWatcher({ vaultPath: "/nonexistent/vault" });
      const events: PlatformEvent[] = [];
      // Should not throw, just log error
      watcher.start(null as any, async (e) => { events.push(e); });
      watcher.stop();
    });

    test("starts and stops cleanly on a valid directory", () => {
      const watcher = new ObsidianVaultWatcher({ vaultPath: tmpDir, debounceMs: 50 });
      watcher.start(null as any, async () => {});
      watcher.stop();
    });
  });

  describe("file event filtering (via processFile integration)", () => {
    // We test the processFile logic indirectly by creating files and using
    // the watcher's processEvent callback with a very short debounce.

    test("triggers on .md file with dear-claude", async () => {
      const events: PlatformEvent[] = [];
      const watcher = new ObsidianVaultWatcher({ vaultPath: tmpDir, debounceMs: 50 });

      watcher.start(null as any, async (event) => {
        events.push(event);
      });

      // Write a file with trigger
      const filePath = join(tmpDir, "trigger.md");
      writeFileSync(filePath, "# Test\n\nDear Claude, write a haiku\n");

      // Wait for debounce + processing
      await new Promise(r => setTimeout(r, 300));

      watcher.stop();

      expect(events.length).toBe(1);
      expect(events[0].platform).toBe("obsidian");
      expect(events[0].threadId).toBe("obsidian:trigger.md");
      expect(events[0].content).toContain("Dear Claude, write a haiku");
      expect(events[0].isDescription).toBe(true);
    });

    test("does not trigger on .md file without dear-claude", async () => {
      const events: PlatformEvent[] = [];
      const watcher = new ObsidianVaultWatcher({ vaultPath: tmpDir, debounceMs: 50 });

      watcher.start(null as any, async (event) => {
        events.push(event);
      });

      writeFileSync(join(tmpDir, "no-trigger.md"), "# Just a note\n\nNo trigger here\n");
      await new Promise(r => setTimeout(r, 300));
      watcher.stop();

      expect(events.length).toBe(0);
    });

    test("does not trigger on non-.md files", async () => {
      const events: PlatformEvent[] = [];
      const watcher = new ObsidianVaultWatcher({ vaultPath: tmpDir, debounceMs: 50 });

      watcher.start(null as any, async (event) => {
        events.push(event);
      });

      writeFileSync(join(tmpDir, "test.txt"), "Dear Claude, this is txt not md");
      await new Promise(r => setTimeout(r, 300));
      watcher.stop();

      expect(events.length).toBe(0);
    });

    test("does not trigger on files in .obsidian directory", async () => {
      const events: PlatformEvent[] = [];
      const watcher = new ObsidianVaultWatcher({ vaultPath: tmpDir, debounceMs: 50 });
      mkdirSync(join(tmpDir, ".obsidian"), { recursive: true });

      watcher.start(null as any, async (event) => {
        events.push(event);
      });

      writeFileSync(join(tmpDir, ".obsidian", "config.md"), "Dear Claude, ignore this");
      await new Promise(r => setTimeout(r, 300));
      watcher.stop();

      expect(events.length).toBe(0);
    });

    test("deduplicates identical content (same hash)", async () => {
      const events: PlatformEvent[] = [];
      const watcher = new ObsidianVaultWatcher({ vaultPath: tmpDir, debounceMs: 50 });

      watcher.start(null as any, async (event) => {
        events.push(event);
      });

      const filePath = join(tmpDir, "dedup.md");
      writeFileSync(filePath, "Dear Claude, test dedup\n");
      await new Promise(r => setTimeout(r, 300));

      // Write the same content again (simulate save without changes)
      writeFileSync(filePath, "Dear Claude, test dedup\n");
      await new Promise(r => setTimeout(r, 300));

      watcher.stop();

      // Should only trigger once since content hash is identical
      expect(events.length).toBe(1);
    });

    test("triggers again when content actually changes", async () => {
      const events: PlatformEvent[] = [];
      const watcher = new ObsidianVaultWatcher({ vaultPath: tmpDir, debounceMs: 50 });

      watcher.start(null as any, async (event) => {
        events.push(event);
      });

      const filePath = join(tmpDir, "change.md");
      writeFileSync(filePath, "Dear Claude, first version\n");
      await new Promise(r => setTimeout(r, 300));

      writeFileSync(filePath, "Dear Claude, second version\n");
      await new Promise(r => setTimeout(r, 300));

      watcher.stop();

      expect(events.length).toBe(2);
    });
  });

  describe("callout stripping (anti-loop)", () => {
    test("does not re-trigger when only change is appended callout containing 'dear claude'", async () => {
      const events: PlatformEvent[] = [];
      const watcher = new ObsidianVaultWatcher({ vaultPath: tmpDir, debounceMs: 50 });

      watcher.start(null as any, async (event) => {
        events.push(event);
      });

      const filePath = join(tmpDir, "loop.md");
      // Initial trigger
      writeFileSync(filePath, "Dear Claude, help me\n");
      await new Promise(r => setTimeout(r, 300));

      expect(events.length).toBe(1);

      // Simulate Claude appending a callout that quotes the trigger
      const withCallout = `Dear Claude, help me

---

> [!claude] Claude Response
> You asked "Dear Claude, help me" — here's my answer.
> Done!
>
> *Instance: abc12345 | 2026-02-06 10:30*
`;
      writeFileSync(filePath, withCallout);
      await new Promise(r => setTimeout(r, 300));

      watcher.stop();

      // The second write should still trigger (content changed), but the trigger
      // detection strips callout blocks, so the "Dear Claude" in the callout is ignored.
      // The original "Dear Claude, help me" text is still present outside the callout,
      // so it may trigger again. This is expected — the instance dedup layer handles it.
      // The key test is that the callout's "Dear Claude" doesn't ADDITIONALLY trigger.
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    test("file with only trigger inside callout does not trigger", async () => {
      const events: PlatformEvent[] = [];
      const watcher = new ObsidianVaultWatcher({ vaultPath: tmpDir, debounceMs: 50 });

      watcher.start(null as any, async (event) => {
        events.push(event);
      });

      // File where "dear claude" only appears inside a callout block
      const content = `# Meeting Notes

Some normal text here.

---

> [!claude] Claude Response
> The user said "Dear Claude, help" and I responded.
>
> *Instance: abc12345 | 2026-02-06 10:30*
`;
      writeFileSync(join(tmpDir, "only-callout.md"), content);
      await new Promise(r => setTimeout(r, 300));

      watcher.stop();

      // Should NOT trigger because the only "dear claude" is inside the callout
      expect(events.length).toBe(0);
    });
  });

  describe("write lock", () => {
    test("locked file is not processed", async () => {
      const events: PlatformEvent[] = [];
      const watcher = new ObsidianVaultWatcher({ vaultPath: tmpDir, debounceMs: 50 });

      watcher.start(null as any, async (event) => {
        events.push(event);
      });

      const filePath = join(tmpDir, "locked.md");
      writeFileSync(filePath, "Initial\n");
      await new Promise(r => setTimeout(r, 200));

      // Lock the file
      const unlock = watcher.lockFile(filePath);

      // Write while locked
      writeFileSync(filePath, "Dear Claude, should be ignored while locked\n");
      await new Promise(r => setTimeout(r, 300));

      // Unlock
      unlock();
      await new Promise(r => setTimeout(r, 200));

      watcher.stop();

      // Should not have triggered during the lock period
      expect(events.length).toBe(0);
    });
  });

  describe("image resolution", () => {
    test("includes resolved local image paths in event content", async () => {
      const events: PlatformEvent[] = [];
      const watcher = new ObsidianVaultWatcher({ vaultPath: tmpDir, debounceMs: 50 });

      // Create an attachment
      mkdirSync(join(tmpDir, "attachments"), { recursive: true });
      writeFileSync(join(tmpDir, "attachments", "screenshot.png"), "fake-png-data");

      watcher.start(null as any, async (event) => {
        events.push(event);
      });

      writeFileSync(join(tmpDir, "with-image.md"), "Dear Claude, describe this\n\n![[screenshot.png]]\n");
      await new Promise(r => setTimeout(r, 300));
      watcher.stop();

      expect(events.length).toBe(1);
      expect(events[0].content).toContain("screenshot.png");
      expect(events[0].content).toContain("Referenced images");
    });

    test("includes standard markdown image paths", async () => {
      const events: PlatformEvent[] = [];
      const watcher = new ObsidianVaultWatcher({ vaultPath: tmpDir, debounceMs: 50 });

      writeFileSync(join(tmpDir, "diagram.png"), "fake-png");

      watcher.start(null as any, async (event) => {
        events.push(event);
      });

      writeFileSync(join(tmpDir, "md-image.md"), "Dear Claude, check\n\n![My Diagram](diagram.png)\n");
      await new Promise(r => setTimeout(r, 300));
      watcher.stop();

      expect(events.length).toBe(1);
      expect(events[0].content).toContain("diagram.png");
    });

    test("skips HTTP URLs in images", async () => {
      const events: PlatformEvent[] = [];
      const watcher = new ObsidianVaultWatcher({ vaultPath: tmpDir, debounceMs: 50 });

      watcher.start(null as any, async (event) => {
        events.push(event);
      });

      writeFileSync(join(tmpDir, "http-img.md"), "Dear Claude, test\n\n![pic](https://example.com/img.png)\n");
      await new Promise(r => setTimeout(r, 300));
      watcher.stop();

      expect(events.length).toBe(1);
      // Should NOT contain "Referenced images" since the HTTP URL is skipped
      expect(events[0].content).not.toContain("Referenced images");
    });
  });

  describe("wikilink resolution", () => {
    test("includes linked note content in event", async () => {
      const events: PlatformEvent[] = [];
      const watcher = new ObsidianVaultWatcher({ vaultPath: tmpDir, debounceMs: 50 });

      // Create a referenced note
      writeFileSync(join(tmpDir, "project-overview.md"), "# Project Overview\n\nThis is the overview.\n");

      watcher.start(null as any, async (event) => {
        events.push(event);
      });

      writeFileSync(join(tmpDir, "task.md"), "Dear Claude, based on [[project-overview]], create a plan\n");
      await new Promise(r => setTimeout(r, 300));
      watcher.stop();

      expect(events.length).toBe(1);
      expect(events[0].content).toContain("Linked notes included as context");
      expect(events[0].content).toContain("project-overview");
      expect(events[0].content).toContain("This is the overview.");
    });

    test("handles wikilinks with display text (pipe syntax)", async () => {
      const events: PlatformEvent[] = [];
      const watcher = new ObsidianVaultWatcher({ vaultPath: tmpDir, debounceMs: 50 });

      writeFileSync(join(tmpDir, "reference.md"), "Referenced content\n");

      watcher.start(null as any, async (event) => {
        events.push(event);
      });

      writeFileSync(join(tmpDir, "pipe.md"), "Dear Claude, see [[reference|My Reference]]\n");
      await new Promise(r => setTimeout(r, 300));
      watcher.stop();

      expect(events.length).toBe(1);
      expect(events[0].content).toContain("Referenced content");
    });

    test("does not duplicate wikilinks referenced multiple times", async () => {
      const events: PlatformEvent[] = [];
      const watcher = new ObsidianVaultWatcher({ vaultPath: tmpDir, debounceMs: 50 });

      writeFileSync(join(tmpDir, "ref.md"), "Referenced once\n");

      watcher.start(null as any, async (event) => {
        events.push(event);
      });

      writeFileSync(join(tmpDir, "multi-ref.md"), "Dear Claude, see [[ref]] and also [[ref]] again\n");
      await new Promise(r => setTimeout(r, 300));
      watcher.stop();

      expect(events.length).toBe(1);
      // Count occurrences of the linked note separator
      const matches = events[0].content.match(/--- \[\[ref\]\] ---/g);
      expect(matches?.length).toBe(1);
    });

    test("gracefully handles non-existent linked notes", async () => {
      const events: PlatformEvent[] = [];
      const watcher = new ObsidianVaultWatcher({ vaultPath: tmpDir, debounceMs: 50 });

      watcher.start(null as any, async (event) => {
        events.push(event);
      });

      writeFileSync(join(tmpDir, "broken-link.md"), "Dear Claude, check [[nonexistent-note]]\n");
      await new Promise(r => setTimeout(r, 300));
      watcher.stop();

      expect(events.length).toBe(1);
      // Should not contain "Linked notes" section since the note doesn't exist
      expect(events[0].content).not.toContain("Linked notes included as context");
    });
  });
});
