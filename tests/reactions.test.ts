import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

describe("GitHub Adapter - addReaction", () => {
  let fetchCalls: Array<{ url: string; options: RequestInit }> = [];
  let savedInstallationId: string | undefined;

  beforeEach(() => {
    fetchCalls = [];
    // Prevent app-mode auth from kicking in via env var
    savedInstallationId = process.env.GITHUB_INSTALLATION_ID;
    delete process.env.GITHUB_INSTALLATION_ID;
    // @ts-ignore
    globalThis.fetch = mock(async (url: string, options?: RequestInit) => {
      fetchCalls.push({ url, options: options || {} });
      return new Response(JSON.stringify({}), { status: 200 });
    });
  });

  afterEach(() => {
    if (savedInstallationId !== undefined) {
      process.env.GITHUB_INSTALLATION_ID = savedInstallationId;
    }
  });

  test("maps emoji names to GitHub reaction content", async () => {
    const { GitHubAdapter } = await import("../src/adapters/github-adapter");
    const adapter = new GitHubAdapter({ accessToken: "test-token" });

    await adapter.addReaction("owner/repo#42", "eyes");

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain("/repos/owner/repo/issues/42/reactions");
    const body = JSON.parse(fetchCalls[0].options.body as string);
    expect(body.content).toBe("eyes");
  });

  test("reacts to specific comment when targetId provided", async () => {
    const { GitHubAdapter } = await import("../src/adapters/github-adapter");
    const adapter = new GitHubAdapter({ accessToken: "test-token" });

    await adapter.addReaction("owner/repo#42", "white_check_mark", "99");

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain("/repos/owner/repo/issues/comments/99/reactions");
    const body = JSON.parse(fetchCalls[0].options.body as string);
    expect(body.content).toBe("+1"); // white_check_mark maps to +1
  });

  test("does nothing without access token", async () => {
    const { GitHubAdapter } = await import("../src/adapters/github-adapter");
    const adapter = new GitHubAdapter({});

    await adapter.addReaction("owner/repo#42", "eyes");
    expect(fetchCalls.length).toBe(0);
  });
});

describe("GitLab Adapter - addReaction", () => {
  let fetchCalls: Array<{ url: string; options: RequestInit }> = [];

  beforeEach(() => {
    fetchCalls = [];
    // @ts-ignore
    globalThis.fetch = mock(async (url: string, options?: RequestInit) => {
      fetchCalls.push({ url, options: options || {} });
      return new Response(JSON.stringify({}), { status: 200 });
    });
  });

  test("adds emoji reaction to issue", async () => {
    const { GitLabAdapter } = await import("../src/adapters/gitlab-adapter");
    const adapter = new GitLabAdapter({ accessToken: "test-token" });

    await adapter.addReaction("group/project#10", "eyes");

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain("/issues/10/award_emoji");
    const body = JSON.parse(fetchCalls[0].options.body as string);
    expect(body.name).toBe("eyes");
  });

  test("adds emoji reaction to MR", async () => {
    const { GitLabAdapter } = await import("../src/adapters/gitlab-adapter");
    const adapter = new GitLabAdapter({ accessToken: "test-token" });

    await adapter.addReaction("group/project!5", "rocket");

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain("/merge_requests/5/award_emoji");
    const body = JSON.parse(fetchCalls[0].options.body as string);
    expect(body.name).toBe("rocket");
  });

  test("adds reaction to specific note when targetId provided", async () => {
    const { GitLabAdapter } = await import("../src/adapters/gitlab-adapter");
    const adapter = new GitLabAdapter({ accessToken: "test-token" });

    await adapter.addReaction("group/project#10", "eyes", "123");

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain("/notes/123/award_emoji");
  });
});
