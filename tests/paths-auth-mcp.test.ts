/**
 * Regression tests for:
 *  - data directory no longer resolving against process.cwd()
 *  - control-plane token auth on /api/* and /mcp
 *  - stateless MCP Streamable HTTP transport
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { DatabaseManager } from "../src/db/schema.js";
import { InstanceManager } from "../src/core/instance-manager.js";
import { ClaudeExecutor } from "../src/core/claude-executor.js";
import { createServer } from "../src/server.js";
import { createMCPServer, mountMcpEndpoint } from "../src/mcp.js";
import { getDataDir } from "../src/utils/paths.js";
import { getApiToken, resetApiTokenCache } from "../src/utils/auth.js";

const ORIG_ENV = { ...process.env };
let sandbox: string;

beforeEach(() => {
  sandbox = join(tmpdir(), `dc-test-${crypto.randomUUID()}`);
  mkdirSync(sandbox, { recursive: true });
  resetApiTokenCache();
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
  resetApiTokenCache();
  rmSync(sandbox, { recursive: true, force: true });
});

describe("getDataDir", () => {
  test("honours DEAR_CLAUDE_DATA_DIR override", () => {
    process.env.DEAR_CLAUDE_DATA_DIR = "/custom/dc";
    expect(getDataDir()).toBe("/custom/dc");
  });

  test("falls back to XDG_DATA_HOME", () => {
    delete process.env.DEAR_CLAUDE_DATA_DIR;
    process.env.XDG_DATA_HOME = "/xdg";
    expect(getDataDir()).toBe(join("/xdg", "dear-claude"));
  });

  test("never resolves against the current working directory", () => {
    delete process.env.DEAR_CLAUDE_DATA_DIR;
    delete process.env.XDG_DATA_HOME;
    // This is the actual bug: an MCP server inherits the client's cwd, so a
    // cwd-relative data dir lands in whatever project the user opened.
    expect(getDataDir().startsWith(process.cwd())).toBe(false);
  });
});

describe("DatabaseManager", () => {
  test("does not create a data directory when given an explicit path", () => {
    process.env.DEAR_CLAUDE_DATA_DIR = join(sandbox, "should-not-exist");
    const db = new DatabaseManager(join(sandbox, "explicit.db"));
    expect(existsSync(join(sandbox, "should-not-exist"))).toBe(false);
    db.close();
  });

  test("creates the resolved data dir when using the default path", () => {
    const dataDir = join(sandbox, "resolved");
    process.env.DEAR_CLAUDE_DATA_DIR = dataDir;
    const db = new DatabaseManager();
    expect(existsSync(join(dataDir, "dear-claude.db"))).toBe(true);
    db.close();
  });
});

describe("getApiToken", () => {
  test("uses DEAR_CLAUDE_API_TOKEN when set", () => {
    process.env.DEAR_CLAUDE_API_TOKEN = "env-token";
    expect(getApiToken()).toBe("env-token");
  });

  test("generates and persists a token, returning the same value on reload", () => {
    delete process.env.DEAR_CLAUDE_API_TOKEN;
    process.env.DEAR_CLAUDE_DATA_DIR = sandbox;

    const first = getApiToken();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(sandbox, "api-token"))).toBe(true);

    resetApiTokenCache();
    expect(getApiToken()).toBe(first);
  });
});

describe("HTTP control plane", () => {
  let db: DatabaseManager;
  let app: ReturnType<typeof createServer>;
  const TOKEN = "test-token-value";

  // The outer afterEach restores process.env, so re-assert the token before
  // each test in this block (inner beforeEach runs after the outer one).
  beforeEach(() => {
    process.env.DEAR_CLAUDE_API_TOKEN = TOKEN;
    resetApiTokenCache();
  });

  beforeAll(() => {
    process.env.DEAR_CLAUDE_API_TOKEN = TOKEN;
    resetApiTokenCache();

    db = new DatabaseManager(join(tmpdir(), `dc-http-${crypto.randomUUID()}.db`));
    const instanceManager = new InstanceManager(
      db,
      join(tmpdir(), `dc-http-data-${crypto.randomUUID()}`)
    );
    const executor = new ClaudeExecutor(instanceManager);
    const config = { port: 0 } as any;

    app = createServer(config, db, instanceManager, executor);
    mountMcpEndpoint(app, () =>
      createMCPServer(instanceManager, executor, config, { db, config })
    );
  });

  afterAll(() => {
    db.close();
    process.env = { ...ORIG_ENV };
    resetApiTokenCache();
  });

  test("/health stays open (no token needed)", async () => {
    const res = await app.fetch(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
  });

  test("/api/instances rejects a request with no token", async () => {
    const res = await app.fetch(new Request("http://localhost/api/instances"));
    expect(res.status).toBe(401);
  });

  test("/api/spawn rejects unauthenticated code execution", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/spawn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "pwn", working_dir: "/" })
      })
    );
    expect(res.status).toBe(401);
  });

  test("/api/instances rejects a wrong token", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/instances", {
        headers: { authorization: "Bearer wrong-token" }
      })
    );
    expect(res.status).toBe(401);
  });

  test("/api/instances accepts the correct bearer token", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/instances", {
        headers: { authorization: `Bearer ${TOKEN}` }
      })
    );
    expect(res.status).toBe(200);
  });

  test("/mcp requires a token", async () => {
    const res = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      })
    );
    expect(res.status).toBe(401);
  });

  test("/mcp initializes over stateless Streamable HTTP and issues no session id", async () => {
    const res = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${TOKEN}`
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0.0" }
          }
        })
      })
    );

    expect(res.status).toBe(200);
    // Stateless mode must not hand back a session to track.
    expect(res.headers.get("mcp-session-id")).toBeNull();

    const body = await res.json() as any;
    expect(body.result.serverInfo.name).toBe("dear-claude");
  });

  test("/mcp lists tools without any prior session (statelessness)", async () => {
    const res = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${TOKEN}`
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const names = body.result.tools.map((t: any) => t.name);
    expect(names).toContain("spawn_instance");
    expect(names).toContain("list_instances");
  });
});
