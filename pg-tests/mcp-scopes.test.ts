import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { requireMcpAuth } from "@better-auth/mcp";
import { setupTestDb, type TestDb } from "./setup.ts";
import { createMcpApp } from "../pg/mcp/server.ts";
import { auth, mcpResourceUrl } from "../auth.ts";

let testDb: TestDb;
let jwksServer: ReturnType<typeof Bun.serve>;
let kid: string;
let privateKey: CryptoKey;
let protectedApp: Hono;
const mockCache = { get: async () => null, set: async () => {}, bustAll: async () => {} };

beforeAll(async () => {
  testDb = await setupTestDb();

  const { publicKey, privateKey: sk } = await generateKeyPair("EdDSA", { extractable: true });
  privateKey = sk;
  kid = "scope-test-key";
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: "EdDSA", use: "sig" };
  const jwksApp = new Hono();
  jwksApp.get("/jwks", (c) => c.json({ keys: [publicJwk] }));
  jwksServer = Bun.serve({ port: 0, fetch: jwksApp.fetch });

  const inner = createMcpApp({ db: testDb.db, cache: mockCache, requireAuth: false });
  const handler = requireMcpAuth(auth, (req) => inner.fetch(req), {
    resource: mcpResourceUrl,
    jwksUrl: `http://localhost:${jwksServer.port}/jwks`,
    requiredScopes: ["courses:read"],
  });
  protectedApp = new Hono();
  protectedApp.all("/", (c) => handler(c.req.raw));
});

afterAll(async () => {
  jwksServer.stop(true);
  await testDb.teardown();
});

async function token(scope: string): Promise<string> {
  const { baseURL } = await auth.$context;
  return new SignJWT({ scope })
    .setProtectedHeader({ alg: "EdDSA", kid })
    .setSubject("user-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .setIssuer(baseURL)
    .setAudience(mcpResourceUrl)
    .sign(privateKey);
}

const call = (t: string) =>
  protectedApp.request("http://localhost/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${t}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

describe("scope enforcement at the endpoint", () => {
  test("a token carrying courses:read is allowed", async () => {
    expect((await call(await token("courses:read"))).status).toBe(200);
  });

  test("a token without courses:read is refused", async () => {
    const res = await call(await token("openid profile"));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

/**
 * The block above builds its own requireMcpAuth wrapper, which proves the
 * library enforces requiredScopes but never executes the configuration
 * inside createMcpApp — the line that actually carries the gate. Verified by
 * mutation: deleting `requiredScopes` from createMcpApp leaves every test
 * above green.
 *
 * This drives the real thing. The JWKS server binds better-auth's own
 * baseURL host, port and basePath so requireMcpAuth's default jwksUrl
 * resolves to it without being told where to look.
 */
describe("scope enforcement as createMcpApp actually configures it", () => {
  let configJwks: ReturnType<typeof Bun.serve>;
  let configKid: string;
  let configKey: CryptoKey;
  let mountedApp: ReturnType<typeof createMcpApp>;
  let realBaseURL: string;

  beforeAll(async () => {
    ({ baseURL: realBaseURL } = await auth.$context);
    const url = new URL(realBaseURL);

    const { publicKey, privateKey: sk } = await generateKeyPair("EdDSA", { extractable: true });
    configKey = sk;
    configKid = "scope-config-test-key";
    const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid: configKid, alg: "EdDSA", use: "sig" };

    const jwksApp = new Hono();
    jwksApp.get(`${url.pathname}/jwks`, (c) => c.json({ keys: [publicJwk] }));

    try {
      configJwks = Bun.serve({ port: Number(url.port), hostname: url.hostname, fetch: jwksApp.fetch });
    } catch (cause) {
      throw new Error(
        `Could not bind ${url.hostname}:${url.port} to stand in for better-auth's JWKS. ` +
          `Free that port (a dev server may be running) and re-run.`,
        { cause }
      );
    }

    mountedApp = createMcpApp({
      db: testDb.db,
      cache: { get: async () => null, set: async () => {}, bustAll: async () => {} },
      requireAuth: true,
    });
  });

  afterAll(() => {
    configJwks?.stop(true);
  });

  async function mint(scope: string): Promise<string> {
    return new SignJWT({ scope })
      .setProtectedHeader({ alg: "EdDSA", kid: configKid })
      .setSubject("user-1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .setIssuer(realBaseURL)
      .setAudience(mcpResourceUrl)
      .sign(configKey);
  }

  const hit = (t: string) =>
    mountedApp.request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${t}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

  test("the mounted app accepts a token carrying courses:read", async () => {
    expect((await hit(await mint("courses:read"))).status).toBe(200);
  });

  test("the mounted app refuses a token without courses:read", async () => {
    const res = await hit(await mint("openid profile"));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
