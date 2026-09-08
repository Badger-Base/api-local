import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { generateKeyPair, exportJWK, SignJWT, type JWK } from "jose";
import { requireMcpAuth } from "@better-auth/mcp";
import { setupTestDb, type TestDb } from "./setup.ts";
import { createMcpApp } from "../pg/mcp/server.ts";
import { auth, authBaseUrl, mcpResourceUrl } from "../auth.ts";

let testDb: TestDb;
let app: ReturnType<typeof createMcpApp>;

beforeAll(async () => {
  testDb = await setupTestDb();
  app = createMcpApp({
    db: testDb.db,
    cache: { get: async () => null, set: async () => {}, bustAll: async () => {} },
    requireAuth: true,
  });
});
afterAll(async () => {
  await testDb.teardown();
});

const rpc = (headers: Record<string, string> = {}) =>
  app.request("http://localhost/", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

describe("MCP authentication", () => {
  test("rejects an unauthenticated call", async () => {
    expect((await rpc()).status).toBe(401);
  });

  // This header is how an MCP client discovers where to authorize. Without it
  // a student pasting the URL gets a dead end instead of a login prompt.
  test("points the client at the authorization server on 401", async () => {
    const res = await rpc();
    const header = res.headers.get("WWW-Authenticate");
    expect(header).toBeTruthy();
    expect(header).toMatch(/resource_metadata=/);
  });

  test("rejects a garbage bearer token", async () => {
    expect((await rpc({ Authorization: "Bearer not.a.token" })).status).toBe(401);
  });
});

/**
 * These two tests reproduce the shape of a real better-auth-issued MCP
 * access token end to end, rather than trusting `requireMcpAuth`'s defaults
 * by inspection. better-auth signs access tokens with `iss` set to
 * `(await auth.$context).baseURL` — the configured `baseURL` *plus*
 * better-auth's `/api/auth` mount path — not the bare origin. `server.ts`
 * used to override `requireMcpAuth`'s `issuer` option with the bare origin
 * (`BETTER_AUTH_URL`), which made every real token fail verification: this
 * is the regression these tests pin down, one token shape per outcome.
 *
 * `requireMcpAuth`'s own default `jwksUrl` is `${baseURL}/jwks`, which in
 * this test process resolves to `http://localhost:3002/api/auth/jwks` —
 * nothing is listening there under `bun test`, so a throwaway local JWKS
 * server stands in for it and its URL is passed as a `jwksUrl` override
 * *here only*; production code (`pg/mcp/server.ts`) must never set it.
 * `issuer` is left unset in both tests, so `requireMcpAuth`'s real default
 * resolution is exactly what's under test — not a hand-supplied stand-in.
 *
 * The protected handler wraps the same `createMcpApp` tool-serving app
 * (with `requireAuth: false`, since auth is applied by the `requireMcpAuth`
 * wrapper built here instead) that `mcp-transport.test.ts` exercises, so a
 * 200 here means the request actually reached `search_courses`, not just
 * that `requireMcpAuth` let it through.
 */
describe("MCP authentication (real token shape)", () => {
  let jwksServer: ReturnType<typeof Bun.serve>;
  let kid: string;
  let privateKey: CryptoKey;
  let protectedApp: Hono;

  beforeAll(async () => {
    const { publicKey, privateKey: sk } = await generateKeyPair("EdDSA", { extractable: true });
    privateKey = sk;
    kid = "mcp-auth-test-key";
    const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: "EdDSA", use: "sig" };

    const jwksApp = new Hono();
    jwksApp.get("/jwks", (c) => c.json({ keys: [publicJwk] }));
    jwksServer = Bun.serve({ port: 0, fetch: jwksApp.fetch });

    const innerApp = createMcpApp({
      db: testDb.db,
      cache: { get: async () => null, set: async () => {}, bustAll: async () => {} },
      requireAuth: false,
    });
    const protectedHandler = requireMcpAuth(auth, (req) => innerApp.fetch(req), {
      resource: mcpResourceUrl,
      jwksUrl: `http://localhost:${jwksServer.port}/jwks`,
    });
    protectedApp = new Hono();
    protectedApp.all("/", (c) => protectedHandler(c.req.raw));
  });

  afterAll(() => {
    jwksServer.stop(true);
  });

  async function sign(iss: string): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA", kid })
      .setSubject("test-user")
      .setIssuedAt()
      .setExpirationTime("5m")
      .setIssuer(iss)
      .setAudience(mcpResourceUrl)
      .sign(privateKey);
  }

  const call = (token: string) =>
    protectedApp.request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

  test("accepts a token whose iss is better-auth's real baseURL + basePath", async () => {
    const { baseURL } = await auth.$context;
    const res = await call(await sign(baseURL));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("search_courses");
  });

  test("rejects a token whose iss is the bare origin (the pre-fix override's value)", async () => {
    const res = await call(await sign(authBaseUrl));
    expect(res.status).toBe(401);
  });
});

/**
 * The tests above build their own `requireMcpAuth` wrapper, which proves the
 * library verifies tokens correctly but never executes the configuration
 * inside `createMcpApp` — the line that actually had the bug. Reintroducing
 * the old `issuer` override leaves every one of them green.
 *
 * This block closes that hole by driving the real thing: `createMcpApp` with
 * `requireAuth: true`, no overrides, exactly as `server.ts` mounts it. The
 * JWKS server binds the host and port of better-auth's own `baseURL` and
 * serves `${basePath}/jwks`, so `requireMcpAuth`'s default `jwksUrl` resolves
 * to it without being told where to look.
 *
 * If someone sets `issuer` back to the bare origin, this test fails and the
 * others do not.
 */
describe("MCP authentication as createMcpApp actually configures it", () => {
  let jwksServer: ReturnType<typeof Bun.serve>;
  let kid: string;
  let privateKey: CryptoKey;
  let mountedApp: ReturnType<typeof createMcpApp>;
  let baseURL: string;

  beforeAll(async () => {
    ({ baseURL } = await auth.$context);
    const url = new URL(baseURL);

    const { publicKey, privateKey: sk } = await generateKeyPair("EdDSA", { extractable: true });
    privateKey = sk;
    kid = "mcp-config-test-key";
    const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: "EdDSA", use: "sig" };

    // Serve at the exact path requireMcpAuth derives: `${baseURL}/jwks`.
    const jwksApp = new Hono();
    jwksApp.get(`${url.pathname}/jwks`, (c) => c.json({ keys: [publicJwk] }));

    try {
      jwksServer = Bun.serve({ port: Number(url.port), hostname: url.hostname, fetch: jwksApp.fetch });
    } catch (cause) {
      throw new Error(
        `Could not bind ${url.hostname}:${url.port} to stand in for better-auth's JWKS. ` +
          `This test must serve JWKS at the real baseURL so requireMcpAuth's own default is ` +
          `what gets exercised. Free that port (a dev server may be running) and re-run.`,
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
    jwksServer?.stop(true);
  });

  test("accepts a token minted the way better-auth mints one", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA", kid })
      .setSubject("test-user")
      .setIssuedAt()
      .setExpirationTime("5m")
      .setIssuer(baseURL)
      .setAudience(mcpResourceUrl)
      .sign(privateKey);

    const res = await mountedApp.request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("search_courses");
  });
});
