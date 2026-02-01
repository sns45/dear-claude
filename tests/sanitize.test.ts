import { describe, test, expect } from "bun:test";
import { sanitize, containsSensitiveInfo } from "../src/utils/sanitize";

describe("sanitize", () => {
  test("redacts US phone numbers", () => {
    const result = sanitize("Call me at 555-123-4567");
    expect(result).not.toContain("555-123-4567");
    expect(result).toContain("[PHONE [REDACTED]]");
  });

  test("redacts international phone numbers", () => {
    const result = sanitize("Number: +14155238886");
    expect(result).not.toContain("+14155238886");
  });

  test("redacts API keys (sk- prefix)", () => {
    const result = sanitize("Key: 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");
    expect(result).not.toContain("sk-lgdW");
    expect(result).toContain("[SECRET [REDACTED]]");
  });

  test("redacts GitHub PATs", () => {
    const result = sanitize("Token: ghp_abcdefABCDEFghijklABCDEF");
    expect(result).not.toContain("ghp_abcdef");
  });

  test("redacts AWS access keys", () => {
    const result = sanitize("AWS: AKIAIOSFODNN7EXAMPLE");
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("redacts Bearer tokens", () => {
    const result = sanitize("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test");
    expect(result).not.toContain("Bearer eyJ");
  });

  test("redacts Tailscale URLs", () => {
    const result = sanitize("URL: https://myhost.tail1234.ts.net/path");
    expect(result).not.toContain("ts.net");
    expect(result).toContain("[URL [REDACTED]]");
  });

  test("redacts localhost URLs", () => {
    const result = sanitize("Server: http://localhost:3000/api");
    expect(result).not.toContain("localhost");
  });

  test("redacts private network IPs", () => {
    const result = sanitize("Access: http://192.168.1.100:8080/");
    expect(result).not.toContain("192.168");
  });

  test("does not redact emails by default", () => {
    const result = sanitize("Contact: user@example.com");
    expect(result).toContain("user@example.com");
  });

  test("redacts emails when enabled", () => {
    const result = sanitize("Contact: user@example.com", { redactEmails: true });
    expect(result).not.toContain("user@example.com");
    expect(result).toContain("[EMAIL [REDACTED]]");
  });

  test("leaves clean text unchanged", () => {
    const text = "This is a normal message with no secrets.";
    expect(sanitize(text)).toBe(text);
  });

  test("handles custom replacement", () => {
    const result = sanitize("Key: sk-abcdefghijklmnop1234567890123456", {
      replacement: "***",
    });
    expect(result).toContain("[SECRET ***]");
  });
});

describe("containsSensitiveInfo", () => {
  test("detects phone numbers", () => {
    expect(containsSensitiveInfo("Call 555-123-4567")).toBe(true);
  });

  test("detects API keys", () => {
    expect(containsSensitiveInfo("sk-abcdefghijklmnop1234567890123456")).toBe(true);
  });

  test("returns false for clean text", () => {
    expect(containsSensitiveInfo("Hello world")).toBe(false);
  });
});
