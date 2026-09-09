import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { setupTestDb, type TestDb } from "./setup.ts";
import { fixture } from "./fixtures/default.ts";
import { createMcpApp } from "../pg/mcp/server.ts";
import { auth, mcpResourceUrl } from "../auth.ts";

/**
 * This drives the real thing, not a locally-built equivalent: the JWKS
 * server binds better-auth's own `baseURL` host, port and basePath, so
 * `requireMcpAuth`'s default `jwksUrl` (derived from that same baseURL)
 * resolves to it without being told where to look, and `createMcpApp` is
 * mounted with `requireAuth: true` — the exact production wiring, endpoint
 * scope gate (`courses:read`) included. That matters here because
 * `my_subscriptions` layers a second, tool-level scope check
 * (`subscriptions:read`) on top of that endpoint gate, and only a test that
 * exercises the real `createMcpApp` can prove that second check is actually
 * wired in rather than merely present in a hand-built copy of it. See the
 * mutation check recorded in task-7-report.md.
 */
let testDb: TestDb;
let jwksServer: ReturnType<typeof Bun.serve>;
let kid: string;
let privateKey: CryptoKey;
let mountedApp: ReturnType<typeof createMcpApp>;
let realBaseURL: string;
const mockCache = { get: async () => null, set: async () => {}, bustAll: async () => {} };

beforeAll(async () => {
  testDb = await setupTestDb();
  await testDb.seed(fixture);

  // The shared fixture gives alpha a course subscription and beta a
  // section subscription so `subscriptions-query.test.ts` can assert
  // isolation with exactly one row on each side. This test also needs one
  // student watching both a course AND a section (the combined-render
  // case), so it adds that row directly here rather than reshaping the
  // shared fixture and risking those other counts.
  await testDb.db
    .insertInto("section_subscriptions")
    .values({ email: "alpha@wisc.edu", section_id: 2 }) // COMP SCI 200, LEC002, CLOSED, 0 seats
    .execute();

  ({ baseURL: realBaseURL } = await auth.$context);
  const url = new URL(realBaseURL);

  const { publicKey, privateKey: sk } = await generateKeyPair("EdDSA", { extractable: true });
  privateKey = sk;
  kid = "my-subs-test-key";
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: "EdDSA", use: "sig" };

  const jwksApp = new Hono();
  jwksApp.get(`${url.pathname}/jwks`, (c) => c.json({ keys: [publicJwk] }));

  try {
    jwksServer = Bun.serve({ port: Number(url.port), hostname: url.hostname, fetch: jwksApp.fetch });
  } catch (cause) {
    throw new Error(
      `Could not bind ${url.hostname}:${url.port} to stand in for better-auth's JWKS. ` +
        `Free that port (a dev server may be running) and re-run.`,
      { cause }
    );
  }

  mountedApp = createMcpApp({ db: testDb.db, cache: mockCache, requireAuth: true });
});

afterAll(async () => {
  jwksServer.stop(true);
  await testDb.teardown();
});

async function token(sub: string, scope: string): Promise<string> {
  return new SignJWT({ scope })
    .setProtectedHeader({ alg: "EdDSA", kid })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("5m")
    .setIssuer(realBaseURL)
    .setAudience(mcpResourceUrl)
    .sign(privateKey);
}

function rpc(method: string, params: Record<string, unknown>) {
  return { jsonrpc: "2.0", id: 1, method, params };
}

const hit = async (t: string, body: Record<string, unknown>) => {
  const res = await mountedApp.request("http://localhost/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${t}`,
    },
    body: JSON.stringify(body),
  });
  return res.text();
};

const callAs = (t: string) => hit(t, rpc("tools/call", { name: "my_subscriptions", arguments: {} }));

/** Extracts the tool result's text content out of the raw JSON-RPC (or SSE-framed) response body. */
function extractText(raw: string): string {
  const dataLine = raw
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("data:") || l.startsWith("{"));
  const jsonText = dataLine?.startsWith("data:") ? dataLine.slice("data:".length).trim() : (dataLine ?? raw);
  const payload = JSON.parse(jsonText);
  return payload.result.content[0].text as string;
}

describe("my_subscriptions", () => {
  test("is advertised in tools/list", async () => {
    const out = await hit(await token("user-alpha", "courses:read subscriptions:read"), rpc("tools/list", {}));
    expect(out).toContain("my_subscriptions");
  });

  test("returns the token holder's own course and section subscriptions", async () => {
    const raw = await callAs(await token("user-alpha", "courses:read subscriptions:read"));
    const text = extractText(raw);
    expect(text).toBe(
      "Courses you're watching (1):\n" +
        "  COMP SCI 200 — Programming I\n" +
        "\n" +
        "Sections you're watching (1):\n" +
        "  COMP SCI 200 LEC002 · CLOSED · 0 seats open"
    );
  });

  // The isolation guarantee, stated as a test.
  test("does not leak another student's subscriptions", async () => {
    const alphaText = extractText(await callAs(await token("user-alpha", "courses:read subscriptions:read")));
    expect(alphaText).not.toContain("COMP SCI 400");

    const betaText = extractText(await callAs(await token("user-beta", "courses:read subscriptions:read")));
    expect(betaText).not.toContain("COMP SCI 200");
    expect(betaText).toContain("COMP SCI 400");
  });

  test("never includes a raw email address in the response", async () => {
    const text = extractText(await callAs(await token("user-alpha", "courses:read subscriptions:read")));
    expect(text).not.toContain("@wisc.edu");
  });

  test("refuses a token without subscriptions:read, naming the missing scope", async () => {
    const raw = await callAs(await token("user-alpha", "courses:read"));
    const text = extractText(raw);
    expect(text).toMatch(/subscriptions:read/);
    expect(raw).toContain('"isError":true');
  });

  test("tells an unrecognised user how to fix it rather than erroring", async () => {
    const raw = await callAs(await token("ghost-user", "courses:read subscriptions:read"));
    const text = extractText(raw);
    expect(text).toMatch(/account/i);
    expect(raw).not.toContain('"isError":true');
  });
});
