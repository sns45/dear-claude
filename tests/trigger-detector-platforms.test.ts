import { describe, test, expect } from "bun:test";
import { TriggerDetector, type TriggerContext } from "../src/core/trigger-detector";

describe("TriggerDetector with Notion platform", () => {
  const notionContext: TriggerContext = {
    threadId: "notion:page-abc123",
    platform: "notion",
    content: "Dear Claude, summarize this page",
    isDescription: false,
    authorId: "user-notion-1",
    timestamp: Date.now(),
  };

  test("returns NEW for first trigger on notion page", () => {
    const result = TriggerDetector.determineTriggerAction(notionContext);
    expect(result.action).toBe("NEW");
  });

  test("returns RESUME for repeat trigger on notion with existing idle instance", () => {
    const result = TriggerDetector.determineTriggerAction(
      notionContext,
      "existing-notion-instance",
      "idle"
    );
    expect(result.action).toBe("RESUME");
  });

  test("returns IGNORE when notion instance is already running", () => {
    const result = TriggerDetector.determineTriggerAction(
      notionContext,
      "existing-notion-instance",
      "running"
    );
    expect(result.action).toBe("IGNORE");
  });

  test("notion description (page update) creates NEW instance", () => {
    const descContext: TriggerContext = {
      ...notionContext,
      isDescription: true,
      content: "My Page Title\nDear Claude, analyze this",
    };
    const result = TriggerDetector.determineTriggerAction(descContext);
    expect(result.action).toBe("NEW");
  });
});

describe("TriggerDetector with Obsidian platform", () => {
  const obsidianContext: TriggerContext = {
    threadId: "obsidian:notes/my-task.md",
    platform: "obsidian",
    content: "Dear Claude, write a haiku about testing",
    isDescription: true,
    timestamp: Date.now(),
  };

  test("returns NEW for first trigger in obsidian file", () => {
    const result = TriggerDetector.determineTriggerAction(obsidianContext);
    expect(result.action).toBe("NEW");
  });

  test("returns IGNORE for duplicate pending instance (obsidian description)", () => {
    const result = TriggerDetector.determineTriggerAction(
      obsidianContext,
      "existing-obsidian-instance",
      "pending"
    );
    expect(result.action).toBe("IGNORE");
    expect(result.reason).toContain("Duplicate description event");
  });

  test("returns RESUME for obsidian with existing completed instance", () => {
    const result = TriggerDetector.determineTriggerAction(
      obsidianContext,
      "existing-obsidian-instance",
      "completed"
    );
    expect(result.action).toBe("RESUME");
  });

  test("returns IGNORE when obsidian instance is already running", () => {
    const result = TriggerDetector.determineTriggerAction(
      obsidianContext,
      "existing-obsidian-instance",
      "running"
    );
    expect(result.action).toBe("IGNORE");
  });

  test("returns NEW when obsidian instance has expired", () => {
    const result = TriggerDetector.determineTriggerAction(
      obsidianContext,
      "old-obsidian-instance",
      "expired"
    );
    expect(result.action).toBe("NEW");
  });

  test("returns NEW when obsidian instance has failed", () => {
    const result = TriggerDetector.determineTriggerAction(
      obsidianContext,
      "failed-obsidian-instance",
      "failed"
    );
    expect(result.action).toBe("NEW");
  });

  test("IGNORE when no trigger in obsidian content", () => {
    const noTrigger: TriggerContext = {
      ...obsidianContext,
      content: "Just some regular notes about my day",
    };
    const result = TriggerDetector.determineTriggerAction(noTrigger);
    expect(result.action).toBe("IGNORE");
  });
});

describe("TriggerDetector.extractRequest with obsidian-style content", () => {
  test("extracts request from multiline obsidian note", () => {
    const content = "# My Task\n\nDear Claude, refactor the authentication module to use JWT tokens";
    const result = TriggerDetector.extractRequest(content);
    expect(result).toContain("refactor the authentication module");
  });

  test("extracts request with wikilink context", () => {
    const content = "Dear Claude, based on [[project-overview]], create a roadmap";
    const result = TriggerDetector.extractRequest(content);
    expect(result).toContain("based on [[project-overview]]");
  });
});
