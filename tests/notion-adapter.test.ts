import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test";
import { createHmac } from "crypto";
import { NotionAdapter } from "../src/adapters/notion-adapter";

// Helper to create a mock Hono context
function mockCtx(headers: Record<string, string> = {}): any {
  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()] || null,
      query: () => null
    }
  };
}

describe("NotionAdapter", () => {
  describe("isConfigured", () => {
    test("returns true with accessToken", () => {
      const adapter = new NotionAdapter({ accessToken: "ntn_test123" });
      expect(adapter.isConfigured()).toBe(true);
    });

    test("returns true with clientId + clientSecret", () => {
      const adapter = new NotionAdapter({ clientId: "id", clientSecret: "secret" });
      expect(adapter.isConfigured()).toBe(true);
    });

    test("returns false with no config", () => {
      const adapter = new NotionAdapter({});
      expect(adapter.isConfigured()).toBe(false);
    });
  });

  describe("setAccessToken", () => {
    test("updates the token", () => {
      const adapter = new NotionAdapter({});
      expect(adapter.isConfigured()).toBe(false);
      adapter.setAccessToken("ntn_new");
      expect(adapter.isConfigured()).toBe(true);
    });
  });

  describe("verifySignature", () => {
    test("returns true when no webhook secret configured", async () => {
      const adapter = new NotionAdapter({});
      const result = await adapter.verifySignature(mockCtx(), "body");
      expect(result).toBe(true);
    });

    test("returns false when signature header missing", async () => {
      const adapter = new NotionAdapter({ webhookSecret: "secret123" });
      const result = await adapter.verifySignature(mockCtx(), "body");
      expect(result).toBe(false);
    });

    test("returns true for valid HMAC-SHA256 signature", async () => {
      const secret = "my-webhook-secret";
      const body = '{"type":"comment.created"}';
      const hmac = createHmac("sha256", secret);
      hmac.update(body);
      const signature = hmac.digest("hex");

      const adapter = new NotionAdapter({ webhookSecret: secret });
      const ctx = mockCtx({ "x-notion-signature": signature });
      const result = await adapter.verifySignature(ctx, body);
      expect(result).toBe(true);
    });

    test("returns false for invalid signature", async () => {
      const adapter = new NotionAdapter({ webhookSecret: "secret123" });
      const ctx = mockCtx({ "x-notion-signature": "badhex" });
      // Different length will fail
      const result = await adapter.verifySignature(ctx, "body");
      expect(result).toBe(false);
    });
  });

  describe("parseWebhook - comment.created", () => {
    let adapter: NotionAdapter;

    beforeEach(() => {
      adapter = new NotionAdapter({ accessToken: "ntn_test" });
    });

    test("parses comment on page", async () => {
      // Mock the fetch for page context — we'll use a global fetch mock
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async (url: any) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.includes("/pages/")) {
          return new Response(JSON.stringify({
            id: "page-123",
            url: "https://notion.so/page-123",
            properties: {
              Name: { type: "title", title: [{ plain_text: "Test Page" }] }
            }
          }), { status: 200 });
        }
        if (u.includes("/blocks/")) {
          return new Response(JSON.stringify({
            results: [
              { id: "b1", type: "paragraph", has_children: false, paragraph: { rich_text: [{ plain_text: "Hello world" }] } }
            ],
            has_more: false,
            next_cursor: null
          }), { status: 200 });
        }
        return new Response("", { status: 404 });
      }) as any;

      try {
        const event = await adapter.parseWebhook(mockCtx(), {
          type: "comment.created",
          data: {
            id: "comment-abc",
            parent: { type: "page_id", page_id: "page-123" },
            rich_text: [
              { type: "text", text: { content: "Dear Claude, summarize this" }, plain_text: "Dear Claude, summarize this" }
            ],
            created_by: { id: "user-456" }
          }
        });

        expect(event).not.toBeNull();
        expect(event!.platform).toBe("notion");
        expect(event!.threadId).toBe("notion:page-123");
        expect(event!.content).toBe("Dear Claude, summarize this");
        expect(event!.isDescription).toBe(false);
        expect(event!.messageId).toBe("comment-abc");
        expect(event!.authorId).toBe("user-456");
        expect(event!.issueTitle).toBe("Test Page");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("returns null for comment on non-page parent (block_id)", async () => {
      const event = await adapter.parseWebhook(mockCtx(), {
        type: "comment.created",
        data: {
          id: "comment-abc",
          parent: { type: "block_id", block_id: "block-123" },
          rich_text: [{ type: "text", text: { content: "test" }, plain_text: "test" }],
          created_by: { id: "user-1" }
        }
      });
      expect(event).toBeNull();
    });

    test("concatenates multiple rich_text segments", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => new Response("", { status: 404 })) as any;

      try {
        const event = await adapter.parseWebhook(mockCtx(), {
          type: "comment.created",
          data: {
            id: "c1",
            parent: { type: "page_id", page_id: "p1" },
            rich_text: [
              { type: "text", text: { content: "Dear " }, plain_text: "Dear " },
              { type: "text", text: { content: "Claude, " }, plain_text: "Claude, " },
              { type: "text", text: { content: "help" }, plain_text: "help" }
            ],
            created_by: { id: "u1" }
          }
        });

        expect(event).not.toBeNull();
        expect(event!.content).toBe("Dear Claude, help");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("parseWebhook - page.content_updated", () => {
    test("returns null when page context cannot be fetched", async () => {
      const adapter = new NotionAdapter({ accessToken: "ntn_test" });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => new Response("", { status: 404 })) as any;

      try {
        const event = await adapter.parseWebhook(mockCtx(), {
          type: "page.content_updated",
          data: { id: "page-999", updated_by: { id: "user-1" } }
        });
        expect(event).toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("builds full content from page title + blocks", async () => {
      const adapter = new NotionAdapter({ accessToken: "ntn_test" });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async (url: any) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.includes("/pages/")) {
          return new Response(JSON.stringify({
            id: "page-1",
            url: "https://notion.so/page-1",
            properties: {
              Title: { type: "title", title: [{ plain_text: "My Page" }] }
            }
          }), { status: 200 });
        }
        if (u.includes("/blocks/")) {
          return new Response(JSON.stringify({
            results: [
              { id: "b1", type: "paragraph", has_children: false, paragraph: { rich_text: [{ plain_text: "Dear Claude, do something" }] } }
            ],
            has_more: false, next_cursor: null
          }), { status: 200 });
        }
        return new Response("", { status: 404 });
      }) as any;

      try {
        const event = await adapter.parseWebhook(mockCtx(), {
          type: "page.content_updated",
          data: { id: "page-1", updated_by: { id: "user-1" } }
        });

        expect(event).not.toBeNull();
        expect(event!.platform).toBe("notion");
        expect(event!.threadId).toBe("notion:page-1");
        expect(event!.isDescription).toBe(true);
        expect(event!.content).toContain("My Page");
        expect(event!.content).toContain("Dear Claude, do something");
        expect(event!.authorId).toBe("user-1");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("parseWebhook - unknown type", () => {
    test("returns null for unsupported event type", async () => {
      const adapter = new NotionAdapter({ accessToken: "ntn_test" });
      const event = await adapter.parseWebhook(mockCtx(), {
        type: "page.deleted",
        data: { id: "page-1" }
      });
      expect(event).toBeNull();
    });
  });

  describe("postResponse", () => {
    test("throws when no access token", async () => {
      const adapter = new NotionAdapter({});
      expect(adapter.postResponse("notion:page-1", "hello")).rejects.toThrow("Notion access token not configured");
    });

    test("sends comment with chunked rich_text", async () => {
      const adapter = new NotionAdapter({ accessToken: "ntn_test" });
      let capturedBody: any = null;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async (_url: any, init: any) => {
        capturedBody = JSON.parse(init.body);
        return new Response("{}", { status: 200 });
      }) as any;

      try {
        await adapter.postResponse("notion:page-abc", "Hello from Claude");

        expect(capturedBody).not.toBeNull();
        expect(capturedBody.parent.page_id).toBe("page-abc");
        expect(capturedBody.rich_text.length).toBe(1);
        expect(capturedBody.rich_text[0].text.content).toBe("Hello from Claude");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("chunks long text into multiple rich_text blocks", async () => {
      const adapter = new NotionAdapter({ accessToken: "ntn_test" });
      let capturedBody: any = null;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async (_url: any, init: any) => {
        capturedBody = JSON.parse(init.body);
        return new Response("{}", { status: 200 });
      }) as any;

      try {
        // Create text longer than 2000 chars
        const longText = "A".repeat(2500) + "\n" + "B".repeat(1000);
        await adapter.postResponse("notion:page-1", longText);

        expect(capturedBody.rich_text.length).toBeGreaterThan(1);
        // Total content should equal original
        const total = capturedBody.rich_text.map((rt: any) => rt.text.content).join("");
        expect(total).toBe(longText);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("addReaction", () => {
    test("is a no-op (no errors)", async () => {
      const adapter = new NotionAdapter({ accessToken: "ntn_test" });
      // Should not throw
      await adapter.addReaction("notion:page-1", "eyes");
    });
  });

  describe("getAuthUrl", () => {
    test("builds correct OAuth URL", () => {
      const adapter = new NotionAdapter({ clientId: "my-client-id", clientSecret: "secret" });
      const url = adapter.getAuthUrl("https://example.com/callback", "state123");
      expect(url).toContain("https://api.notion.com/v1/oauth/authorize");
      expect(url).toContain("client_id=my-client-id");
      expect(url).toContain("redirect_uri=");
      expect(url).toContain("state=state123");
      expect(url).toContain("owner=user");
    });
  });

  describe("platform identity", () => {
    test("platform is 'notion'", () => {
      const adapter = new NotionAdapter({});
      expect(adapter.platform).toBe("notion");
    });
  });
});
