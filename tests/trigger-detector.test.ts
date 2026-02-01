import { describe, test, expect } from "bun:test";
import { TriggerDetector, type TriggerContext, type GitLabWebhookEvent } from "../src/core/trigger-detector";

describe("TriggerDetector.containsTrigger", () => {
  test("matches 'dear claude'", () => {
    expect(TriggerDetector.containsTrigger("dear claude, help me")).toBe(true);
  });

  test("matches 'dear-claude'", () => {
    expect(TriggerDetector.containsTrigger("dear-claude please do this")).toBe(true);
  });

  test("matches 'Dear Claude' (case insensitive)", () => {
    expect(TriggerDetector.containsTrigger("Dear Claude, can you")).toBe(true);
  });

  test("matches 'DEAR CLAUDE'", () => {
    expect(TriggerDetector.containsTrigger("DEAR CLAUDE do something")).toBe(true);
  });

  test("matches 'dearclaude' (no separator)", () => {
    expect(TriggerDetector.containsTrigger("dearclaude fix this")).toBe(true);
  });

  test("does not match unrelated text", () => {
    expect(TriggerDetector.containsTrigger("hello world")).toBe(false);
  });

  test("does not match partial 'dear'", () => {
    expect(TriggerDetector.containsTrigger("dear john")).toBe(false);
  });

  test("does not match partial 'claude'", () => {
    expect(TriggerDetector.containsTrigger("claude is great")).toBe(false);
  });
});

describe("TriggerDetector.extractRequest", () => {
  test("extracts text after 'Dear Claude,'", () => {
    expect(TriggerDetector.extractRequest("Dear Claude, fix the bug")).toBe("fix the bug");
  });

  test("extracts text after 'dear-claude:'", () => {
    expect(TriggerDetector.extractRequest("dear-claude: build a thing")).toBe("build a thing");
  });

  test("returns full content if no trigger", () => {
    expect(TriggerDetector.extractRequest("just some text")).toBe("just some text");
  });

  test("handles trigger at end of content", () => {
    const result = TriggerDetector.extractRequest("dear claude");
    // When nothing follows, returns original content
    expect(result).toBe("dear claude");
  });

  test("strips leading punctuation after trigger", () => {
    expect(TriggerDetector.extractRequest("Dear Claude - do this")).toBe("do this");
  });
});

describe("TriggerDetector.determineTriggerAction", () => {
  const baseContext: TriggerContext = {
    threadId: "test-thread",
    platform: "github",
    content: "Dear Claude, do something",
    isDescription: true,
    timestamp: Date.now(),
  };

  test("returns NEW for trigger in description", () => {
    const result = TriggerDetector.determineTriggerAction(baseContext);
    expect(result.action).toBe("NEW");
  });

  test("returns IGNORE when no trigger present", () => {
    const result = TriggerDetector.determineTriggerAction({
      ...baseContext,
      content: "no trigger here",
    });
    expect(result.action).toBe("IGNORE");
  });

  test("returns IGNORE when instance is already running", () => {
    const result = TriggerDetector.determineTriggerAction(
      baseContext,
      "existing-id",
      "running"
    );
    expect(result.action).toBe("IGNORE");
  });

  test("returns RESUME for trigger in comment with existing idle instance", () => {
    const result = TriggerDetector.determineTriggerAction(
      { ...baseContext, isDescription: false },
      "existing-id",
      "idle"
    );
    expect(result.action).toBe("RESUME");
  });

  test("returns NEW for trigger in comment with no existing instance", () => {
    const result = TriggerDetector.determineTriggerAction({
      ...baseContext,
      isDescription: false,
    });
    expect(result.action).toBe("NEW");
  });

  test("returns NEW for trigger in comment with expired instance", () => {
    const result = TriggerDetector.determineTriggerAction(
      { ...baseContext, isDescription: false },
      "existing-id",
      "expired"
    );
    expect(result.action).toBe("NEW");
  });

  test("returns NEW for trigger in comment with failed instance", () => {
    const result = TriggerDetector.determineTriggerAction(
      { ...baseContext, isDescription: false },
      "existing-id",
      "failed"
    );
    expect(result.action).toBe("NEW");
  });
});

describe("TriggerDetector.parseGitHubEvent", () => {
  test("parses issue opened event", () => {
    const result = TriggerDetector.parseGitHubEvent({
      action: "opened",
      repository: { full_name: "owner/repo" },
      issue: {
        number: 42,
        title: "Dear Claude",
        body: "Fix the bug",
        user: { login: "testuser" },
      },
    });

    expect(result).not.toBeNull();
    expect(result!.threadId).toBe("owner/repo#42");
    expect(result!.platform).toBe("github");
    expect(result!.isDescription).toBe(true);
    expect(result!.content).toContain("Dear Claude");
    expect(result!.content).toContain("Fix the bug");
    expect(result!.authorId).toBe("testuser");
  });

  test("parses comment created event", () => {
    const result = TriggerDetector.parseGitHubEvent({
      action: "created",
      repository: { full_name: "owner/repo" },
      issue: { number: 42, user: { login: "author" } },
      comment: {
        id: 123,
        body: "Dear Claude, continue",
        user: { login: "commenter" },
      },
    });

    expect(result).not.toBeNull();
    expect(result!.threadId).toBe("owner/repo#42");
    expect(result!.isDescription).toBe(false);
    expect(result!.messageId).toBe("123");
    expect(result!.authorId).toBe("commenter");
  });

  test("returns null for unsupported event", () => {
    const result = TriggerDetector.parseGitHubEvent({
      action: "closed",
      repository: { full_name: "owner/repo" },
      issue: { number: 42, user: { login: "author" } },
    });
    expect(result).toBeNull();
  });
});

describe("TriggerDetector.parseLinearEvent", () => {
  test("parses issue create event", () => {
    const result = TriggerDetector.parseLinearEvent({
      type: "Issue",
      action: "create",
      data: {
        id: "issue-123",
        title: "Dear Claude",
        description: "Please fix",
        creatorId: "user-1",
      },
      organizationId: "org-1",
    });

    expect(result).not.toBeNull();
    expect(result!.threadId).toBe("issue-123");
    expect(result!.platform).toBe("linear");
    expect(result!.isDescription).toBe(true);
  });

  test("parses comment create event", () => {
    const result = TriggerDetector.parseLinearEvent({
      type: "Comment",
      action: "create",
      data: {
        id: "comment-1",
        body: "Dear Claude, continue",
        issueId: "issue-123",
        userId: "user-1",
      },
      organizationId: "org-1",
    });

    expect(result).not.toBeNull();
    expect(result!.threadId).toBe("issue-123");
    expect(result!.isDescription).toBe(false);
  });

  test("returns null for unsupported event", () => {
    const result = TriggerDetector.parseLinearEvent({
      type: "Issue",
      action: "update",
      data: { id: "issue-123" },
      organizationId: "org-1",
    });
    expect(result).toBeNull();
  });
});

describe("TriggerDetector.parseGitLabEvent", () => {
  test("parses issue open event", () => {
    const result = TriggerDetector.parseGitLabEvent({
      object_kind: "issue",
      user: { username: "testuser" },
      project: { path_with_namespace: "group/project", id: 1 },
      object_attributes: {
        id: 1, iid: 5, title: "Dear Claude", description: "Fix this", action: "open"
      }
    });

    expect(result).not.toBeNull();
    expect(result!.threadId).toBe("group/project#5");
    expect(result!.platform).toBe("gitlab");
    expect(result!.isDescription).toBe(true);
  });

  test("parses MR open event", () => {
    const result = TriggerDetector.parseGitLabEvent({
      object_kind: "merge_request",
      user: { username: "testuser" },
      project: { path_with_namespace: "group/project", id: 1 },
      object_attributes: {
        id: 1, iid: 3, title: "Dear Claude review", description: "MR desc", action: "open"
      }
    });

    expect(result).not.toBeNull();
    expect(result!.threadId).toBe("group/project!3");
    expect(result!.platform).toBe("gitlab");
  });

  test("parses note event on issue", () => {
    const result = TriggerDetector.parseGitLabEvent({
      object_kind: "note",
      user: { username: "commenter" },
      project: { path_with_namespace: "group/project", id: 1 },
      object_attributes: {
        id: 99, note: "Dear Claude, continue", noteable_type: "Issue"
      },
      issue: { iid: 5 }
    });

    expect(result).not.toBeNull();
    expect(result!.threadId).toBe("group/project#5");
    expect(result!.isDescription).toBe(false);
    expect(result!.messageId).toBe("99");
  });

  test("returns null for unsupported event kind", () => {
    const result = TriggerDetector.parseGitLabEvent({
      object_kind: "pipeline",
      project: { path_with_namespace: "group/project", id: 1 },
      object_attributes: { id: 1 }
    });
    expect(result).toBeNull();
  });
});
