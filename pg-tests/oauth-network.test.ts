/**
 * Tests for the CIMD metadata transport — the authorization server's SSRF
 * boundary. Every case here is offline: each one is rejected before any
 * socket is opened, so the suite stays deterministic on CI, which has no
 * outbound network guarantees.
 */
import { describe, test, expect } from "bun:test";
import { fetchClientMetadataResource } from "../oauth-network.ts";

describe("fetchClientMetadataResource", () => {
  test("refuses a non-HTTPS metadata URL", async () => {
    await expect(
      fetchClientMetadataResource("http://example.com/.well-known/metadata")
    ).rejects.toThrow(/HTTPS/i);
  });

  test("refuses a hostname resolving to loopback", async () => {
    // localhost resolves without touching a resolver, so this exercises the
    // RFC 6890 classifier rather than the network.
    await expect(
      fetchClientMetadataResource("https://localhost/.well-known/metadata")
    ).rejects.toThrow(/public-routable/i);
  });

  test("refuses an IPv4 loopback literal written in decimal form", async () => {
    // 2130706433 is 127.0.0.1. WHATWG URL parsing normalises it to dotted
    // quad before the classifier sees it, which is what makes the check hold
    // against alternate IPv4 encodings rather than only dotted-quad ones.
    await expect(
      fetchClientMetadataResource("https://2130706433/.well-known/metadata")
    ).rejects.toThrow(/public-routable/i);
  });

  test("refuses a private RFC 1918 address", async () => {
    await expect(
      fetchClientMetadataResource("https://10.0.0.1/.well-known/metadata")
    ).rejects.toThrow(/public-routable/i);
  });

  test("refuses a method other than GET or HEAD", async () => {
    await expect(
      fetchClientMetadataResource("https://example.com/.well-known/metadata", {
        method: "POST",
      })
    ).rejects.toThrow(/GET and HEAD/i);
  });
});
