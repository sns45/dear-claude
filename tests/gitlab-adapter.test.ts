import { describe, test, expect, mock, beforeEach } from "bun:test";

describe("GitLab Adapter", () => {
  let fetchCalls: Array<{ url: string; options: RequestInit }> = [];

  beforeEach(() => {
    fetchCalls = [];
    // @ts-ignore
    globalThis.fetch = mock(async (url: string, options?: RequestInit) => {
      fetchCalls.push({ url, options: options || {} });
      if (url.includes("/changes")) {
        return new Response(JSON.stringify({
          changes: [{ diff: "@@ -1 +1 @@\n-old\n+new", old_path: "file.ts", new_path: "file.ts" }]
        }), { status: 200 });
      }
      if (url.includes("/labels") && (options?.method === "GET" || !options?.method)) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
  });

  test("verifySignature accepts matching token", async () => {
    const { GitLabAdapter } = await import("../src/adapters/gitlab-adapter");
    const adapter = new GitLabAdapter({ webhookSecret: "my-secret" });

    const ctx = { req: { header: (name: string) => name === "x-gitlab-token" ? "my-secret" : null } } as any;
    expect(await adapter.verifySignature(ctx, "{}")).toBe(true);
  });

  test("verifySignature rejects wrong token", async () => {
    const { GitLabAdapter } = await import("../src/adapters/gitlab-adapter");
    const adapter = new GitLabAdapter({ webhookSecret: "my-secret" });

    const ctx = { req: { header: (name: string) => name === "x-gitlab-token" ? "wrong" : null } } as any;
    expect(await adapter.verifySignature(ctx, "{}")).toBe(false);
  });

  test("parseWebhook handles issue open", async () => {
    const { GitLabAdapter } = await import("../src/adapters/gitlab-adapter");
    const adapter = new GitLabAdapter({ accessToken: "test" });

    const ctx = { req: { header: () => null } } as any;
    const payload = {
      object_kind: "issue",
      user: { username: "testuser" },
      project: { id: 1, path_with_namespace: "group/project" },
      object_attributes: { iid: 5, title: "Dear Claude", description: "Fix this", action: "open" }
    };

    const event = await adapter.parseWebhook(ctx, payload);
    expect(event).not.toBeNull();
    expect(event!.threadId).toBe("group/project#5");
    expect(event!.platform).toBe("gitlab");
    expect(event!.isDescription).toBe(true);
    expect(event!.content).toContain("Dear Claude");
  });

  test("parseWebhook handles MR open with diff", async () => {
    const { GitLabAdapter } = await import("../src/adapters/gitlab-adapter");
    const adapter = new GitLabAdapter({ accessToken: "test" });

    const ctx = { req: { header: () => null } } as any;
    const payload = {
      object_kind: "merge_request",
      user: { username: "testuser" },
      project: { id: 1, path_with_namespace: "group/project" },
      object_attributes: { iid: 3, title: "Dear Claude, review", description: "MR desc", action: "open" }
    };

    const event = await adapter.parseWebhook(ctx, payload);
    expect(event).not.toBeNull();
    expect(event!.threadId).toBe("group/project!3");
    expect(event!.isPullRequest).toBe(true);
    expect(event!.diffContent).toContain("-old");
    expect(event!.diffContent).toContain("+new");
  });

  test("parseWebhook handles note on issue", async () => {
    const { GitLabAdapter } = await import("../src/adapters/gitlab-adapter");
    const adapter = new GitLabAdapter({ accessToken: "test" });

    const ctx = { req: { header: () => null } } as any;
    const payload = {
      object_kind: "note",
      user: { username: "commenter" },
      project: { id: 1, path_with_namespace: "group/project" },
      object_attributes: { id: 99, note: "Dear Claude, continue", noteable_type: "Issue" },
      issue: { iid: 5 }
    };

    const event = await adapter.parseWebhook(ctx, payload);
    expect(event).not.toBeNull();
    expect(event!.threadId).toBe("group/project#5");
    expect(event!.isDescription).toBe(false);
    expect(event!.messageId).toBe("99");
  });

  test("parseWebhook handles note on MR", async () => {
    const { GitLabAdapter } = await import("../src/adapters/gitlab-adapter");
    const adapter = new GitLabAdapter({ accessToken: "test" });

    const ctx = { req: { header: () => null } } as any;
    const payload = {
      object_kind: "note",
      user: { username: "reviewer" },
      project: { id: 1, path_with_namespace: "group/project" },
      object_attributes: { id: 100, note: "Dear Claude, looks good?", noteable_type: "MergeRequest" },
      merge_request: { iid: 3 }
    };

    const event = await adapter.parseWebhook(ctx, payload);
    expect(event).not.toBeNull();
    expect(event!.threadId).toBe("group/project!3");
    expect(event!.isPullRequest).toBe(true);
  });

  test("parseWebhook ignores non-open issue actions", async () => {
    const { GitLabAdapter } = await import("../src/adapters/gitlab-adapter");
    const adapter = new GitLabAdapter({ accessToken: "test" });

    const ctx = { req: { header: () => null } } as any;
    const payload = {
      object_kind: "issue",
      user: { username: "testuser" },
      project: { id: 1, path_with_namespace: "group/project" },
      object_attributes: { iid: 5, title: "Closed", action: "close" }
    };

    const event = await adapter.parseWebhook(ctx, payload);
    expect(event).toBeNull();
  });

  test("postResponse posts comment to issue", async () => {
    const { GitLabAdapter } = await import("../src/adapters/gitlab-adapter");
    const adapter = new GitLabAdapter({ accessToken: "test" });

    await adapter.postResponse("group/project#5", "Hello!");

    const postCall = fetchCalls.find(c => c.options.method === "POST" && c.url.includes("/notes"));
    expect(postCall).toBeDefined();
    expect(postCall!.url).toContain("/issues/5/notes");
    const body = JSON.parse(postCall!.options.body as string);
    expect(body.body).toBe("Hello!");
  });

  test("postResponse posts comment to MR", async () => {
    const { GitLabAdapter } = await import("../src/adapters/gitlab-adapter");
    const adapter = new GitLabAdapter({ accessToken: "test" });

    await adapter.postResponse("group/project!3", "Review done");

    const postCall = fetchCalls.find(c => c.options.method === "POST" && c.url.includes("/notes"));
    expect(postCall).toBeDefined();
    expect(postCall!.url).toContain("/merge_requests/3/notes");
  });

  test("isConfigured returns true with access token", () => {
    const { GitLabAdapter } = require("../src/adapters/gitlab-adapter");
    const adapter = new GitLabAdapter({ accessToken: "test" });
    expect(adapter.isConfigured()).toBe(true);
  });

  test("isConfigured returns false without access token", () => {
    const { GitLabAdapter } = require("../src/adapters/gitlab-adapter");
    const adapter = new GitLabAdapter({});
    expect(adapter.isConfigured()).toBe(false);
  });
});
