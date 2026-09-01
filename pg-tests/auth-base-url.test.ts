import { describe, test, expect } from "bun:test";

/**
 * auth.ts validates BETTER_AUTH_URL at module scope, so each case needs a
 * fresh module graph. A cache-busting query string gives us that.
 */
async function loadWith(value: string | undefined): Promise<string | Error> {
  const prev = process.env.BETTER_AUTH_URL;
  if (value === undefined) delete process.env.BETTER_AUTH_URL;
  else process.env.BETTER_AUTH_URL = value;
  try {
    const mod = await import(`../auth.ts?case=${encodeURIComponent(String(value))}`);
    return mod.authBaseUrl as string;
  } catch (e) {
    return e as Error;
  } finally {
    if (prev === undefined) delete process.env.BETTER_AUTH_URL;
    else process.env.BETTER_AUTH_URL = prev;
  }
}

describe("BETTER_AUTH_URL validation", () => {
  // The exact value that crash-looped the Railway container.
  test("rejects a bare hostname with a message naming the variable", async () => {
    const r = await loadWith("api-local.railway.internal");
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toContain("BETTER_AUTH_URL");
    expect((r as Error).message).toContain("scheme");
  });

  test("rejects a Railway private hostname even with a scheme", async () => {
    const r = await loadWith("http://api-local.railway.internal");
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toContain("private hostname");
  });

  test("rejects a non-http protocol", async () => {
    const r = await loadWith("ftp://example.com");
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toContain("http://");
  });

  test("accepts a public https URL and normalises to its origin", async () => {
    const r = await loadWith("https://api-local-production.up.railway.app/");
    expect(r).toBe("https://api-local-production.up.railway.app");
  });
});
