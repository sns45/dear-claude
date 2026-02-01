import { describe, test, expect, mock, beforeEach } from "bun:test";

describe("GitHub Adapter - PR Support", () => {
  let fetchCalls: Array<{ url: string; options: RequestInit }> = [];

  beforeEach(() => {
    fetchCalls = [];
    // @ts-ignore
    globalThis.fetch = mock(async (url: string, options?: RequestInit) => {
      fetchCalls.push({ url, options: options || {} });
      if (url.includes("/pulls/") && (options?.headers as any)?.Accept === "application/vnd.github.diff") {
        return new Response("diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new", { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
  });

  test("parseWebhook handles PR opened event", async () => {
    const { GitHubAdapter } = await import("../src/adapters/github-adapter");
    const adapter = new GitHubAdapter({ accessToken: "test-token" });

    const ctx = {
      req: { header: (name: string) => name === "x-github-event" ? "pull_request" : null }
    } as any;

    const payload = {
      action: "opened",
      pull_request: {
        number: 10,
        title: "Dear Claude, review this",
        body: "Please check the changes",
        user: { login: "author" },
        head: { ref: "feature-branch" },
        base: { ref: "main" }
      },
      repository: {
        full_name: "owner/repo",
        owner: { login: "owner" },
        name: "repo",
        clone_url: "https://github.com/owner/repo.git"
      },
      sender: { login: "author" },
      installation: { id: 123 }
    };

    const event = await adapter.parseWebhook(ctx, payload);
    expect(event).not.toBeNull();
    expect(event!.threadId).toBe("owner/repo#10");
    expect(event!.isPullRequest).toBe(true);
    expect(event!.diffContent).toContain("-old");
    expect(event!.diffContent).toContain("+new");
    expect(event!.installationId).toBe(123);
  });

  test("parseWebhook handles PR review comment", async () => {
    const { GitHubAdapter } = await import("../src/adapters/github-adapter");
    const adapter = new GitHubAdapter({ accessToken: "test-token" });

    const ctx = {
      req: { header: (name: string) => name === "x-github-event" ? "pull_request_review_comment" : null }
    } as any;

    const payload = {
      action: "created",
      comment: { id: 456, body: "Dear Claude, what about this?", user: { login: "reviewer" } },
      pull_request: { number: 10, title: "PR", user: { login: "author" } },
      repository: { full_name: "owner/repo", owner: { login: "owner" }, name: "repo" },
      sender: { login: "reviewer" }
    };

    const event = await adapter.parseWebhook(ctx, payload);
    expect(event).not.toBeNull();
    expect(event!.threadId).toBe("owner/repo#10");
    expect(event!.isPullRequest).toBe(true);
    expect(event!.messageId).toBe("456");
  });

  test("postPRReview posts a review", async () => {
    const { GitHubAdapter } = await import("../src/adapters/github-adapter");
    const adapter = new GitHubAdapter({ accessToken: "test-token" });

    await adapter.postPRReview(
      "owner/repo#10",
      "Looks good overall!",
      [{ path: "file.ts", position: 5, body: "Consider renaming this variable" }],
      "COMMENT"
    );

    const reviewCall = fetchCalls.find(c => c.url.includes("/pulls/10/reviews"));
    expect(reviewCall).toBeDefined();
    const body = JSON.parse(reviewCall!.options.body as string);
    expect(body.body).toBe("Looks good overall!");
    expect(body.event).toBe("COMMENT");
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0].path).toBe("file.ts");
  });

  test("postPRReview works without inline comments", async () => {
    const { GitHubAdapter } = await import("../src/adapters/github-adapter");
    const adapter = new GitHubAdapter({ accessToken: "test-token" });

    await adapter.postPRReview("owner/repo#10", "LGTM!", undefined, "APPROVE");

    const reviewCall = fetchCalls.find(c => c.url.includes("/pulls/10/reviews"));
    expect(reviewCall).toBeDefined();
    const body = JSON.parse(reviewCall!.options.body as string);
    expect(body.event).toBe("APPROVE");
    expect(body.comments).toBeUndefined();
  });
});
