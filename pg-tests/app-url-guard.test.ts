import { describe, test, expect } from "bun:test";

/**
 * APP_URL sat at http://localhost:3000 in production. Verification emails
 * sent perfectly and led nowhere — the failure was invisible from the API's
 * side, and only visible in a user's inbox.
 */
async function loadWith(env: Record<string, string | undefined>) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await import(`../auth.ts?case=${encodeURIComponent(JSON.stringify(env))}`);
    return null;
  } catch (e) {
    return e as Error;
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("APP_URL guard", () => {
  test("rejects a localhost APP_URL when the API is public", async () => {
    const err = await loadWith({
      BETTER_AUTH_URL: "https://api.example.com",
      APP_URL: "http://localhost:3000",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("APP_URL");
    expect(err!.message).toContain("local address");
  });

  test("requires APP_URL at all when the API is public", async () => {
    const err = await loadWith({
      BETTER_AUTH_URL: "https://api.example.com",
      APP_URL: undefined,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("APP_URL is required");
  });

  test("allows localhost APP_URL in local development", async () => {
    const err = await loadWith({
      BETTER_AUTH_URL: "http://localhost:3002",
      APP_URL: "http://localhost:3000",
    });
    expect(err).toBeNull();
  });

  test("accepts a public APP_URL alongside a public API", async () => {
    const err = await loadWith({
      BETTER_AUTH_URL: "https://api.example.com",
      APP_URL: "https://www.badgerbase.app",
    });
    expect(err).toBeNull();
  });
});
