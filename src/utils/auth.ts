/**
 * Local API authentication
 *
 * The HTTP server exposes control endpoints (/api/*, /mcp) that can spawn
 * Claude instances with bypassed permissions on this machine. Those must never
 * be callable by anything that merely reaches the port -- another host on the
 * LAN, a browser on this machine via a stray fetch, or a public tunnel.
 *
 * Webhook and OAuth routes are deliberately NOT covered here: webhooks carry
 * their own per-platform signature verification, and OAuth callbacks must stay
 * reachable by the identity provider.
 */

import { randomBytes, timingSafeEqual } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { Context, Next } from "hono";
import { getDataDir } from "./paths.js";

let cachedToken: string | undefined;

/**
 * Resolve the shared control-plane token, generating and persisting one on
 * first use. Callers read the same value from DEAR_CLAUDE_API_TOKEN or from
 * <dataDir>/api-token (written 0600).
 */
export function getApiToken(): string {
  if (cachedToken) return cachedToken;

  const fromEnv = process.env.DEAR_CLAUDE_API_TOKEN;
  if (fromEnv) {
    cachedToken = fromEnv;
    return cachedToken;
  }

  const dataDir = getDataDir();
  const tokenPath = join(dataDir, "api-token");

  if (existsSync(tokenPath)) {
    const existing = readFileSync(tokenPath, "utf-8").trim();
    if (existing) {
      cachedToken = existing;
      return cachedToken;
    }
  }

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  const generated = randomBytes(32).toString("hex");
  writeFileSync(tokenPath, generated, { mode: 0o600 });
  cachedToken = generated;
  return cachedToken;
}

/** Reset memoised state. Test-only. */
export function resetApiTokenCache(): void {
  cachedToken = undefined;
}

/** Constant-time comparison that tolerates differing lengths. */
function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Extract a presented token from either `Authorization: Bearer <t>` or the
 * `x-dear-claude-token` header.
 */
export function extractPresentedToken(c: Context): string | undefined {
  const header = c.req.header("authorization");
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1]!.trim();
  }
  const direct = c.req.header("x-dear-claude-token");
  if (direct) return direct.trim();
  return undefined;
}

/**
 * Hono middleware guarding the control plane. Returns 401 with a WWW-Authenticate
 * challenge so MCP clients surface an auth error rather than a protocol error.
 */
export async function requireApiToken(c: Context, next: Next): Promise<Response | void> {
  const presented = extractPresentedToken(c);
  if (!presented || !tokensMatch(presented, getApiToken())) {
    return c.json(
      {
        error: "unauthorized",
        message:
          "This endpoint requires a token. Send 'Authorization: Bearer <token>'. " +
          "Run 'dear-claude token' to print it."
      },
      401,
      { "WWW-Authenticate": 'Bearer realm="dear-claude"' }
    );
  }
  await next();
}
