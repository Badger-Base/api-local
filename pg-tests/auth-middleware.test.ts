import { describe, test, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import { auth } from "../auth.ts";
import { betterAuthJwt } from "../auth-middleware.ts";

// Serve better-auth (and therefore its JWKS) on a real port so the middleware
// can fetch the key set exactly as it will in production.
let baseUrl: string;
beforeAll(() => {
  const authApp = new Hono();
  authApp.all("/api/auth/*", (c) => auth.handler(c.req.raw));
  const server = Bun.serve({ port: 0, fetch: authApp.fetch });
  baseUrl = `http://localhost:${server.port}`;
});

function protectedApp() {
  const app = new Hono();
  app.use("/protected", betterAuthJwt(`${baseUrl}/api/auth/jwks`));
  app.get("/protected", (c) => c.json({ payload: c.get("jwtPayload") }));
  return app;
}

async function signedInToken(): Promise<string> {
  const email = `jwt-${crypto.randomUUID()}@wisc.edu`;
  await auth.api.signUpEmail({ body: { email, password: "test-password-123", name: "T" }, asResponse: false });
  const res = await auth.api.signInEmail({ body: { email, password: "test-password-123" }, asResponse: true });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c: string) => c.split(";")[0]).join("; ");
  const t = await auth.api.getToken({ headers: new Headers({ cookie }) });
  return (t as any).token;
}

// A syntactically well-formed JWS (three base64url segments, valid JSON
// header/payload) whose signature is never checked in these tests, because
// the JWKS fetch itself fails before jose gets to signature verification.
function wellFormedToken(): string {
  const b64url = (obj: object) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const header = b64url({ alg: "EdDSA", kid: "test-kid" });
  const payload = b64url({ sub: "test-user", email: "test@wisc.edu" });
  return `${header}.${payload}.fake-signature`;
}

describe("betterAuthJwt", () => {
  test("rejects a request with no Authorization header", async () => {
    const res = await protectedApp().request("http://localhost/protected");
    expect(res.status).toBe(401);
  });

  test("rejects a garbage token", async () => {
    const res = await protectedApp().request("http://localhost/protected", {
      headers: { Authorization: "Bearer not.a.jwt" },
    });
    expect(res.status).toBe(401);
  });

  test("accepts a valid EdDSA token and exposes sub and email", async () => {
    const token = await signedInToken();
    const res = await protectedApp().request("http://localhost/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.payload.sub).toBe("string");
    expect(typeof body.payload.email).toBe("string");
  });

  test("returns 500 (not 401), with no internal error detail, when the JWKS endpoint is unreachable", async () => {
    // Grab an ephemeral port and immediately free it, guaranteeing nothing
    // is listening there for the middleware to fetch from.
    const probe = Bun.serve({ port: 0, fetch: () => new Response() });
    const deadPort = probe.port;
    probe.stop(true);

    const app = new Hono();
    app.use("/protected", betterAuthJwt(`http://localhost:${deadPort}/jwks`));
    app.get("/protected", (c) => c.json({ payload: c.get("jwtPayload") }));

    const res = await app.request("http://localhost/protected", {
      headers: { Authorization: `Bearer ${wellFormedToken()}` },
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Internal Server Error" });
  });

  test("returns 500 (not 401), with no internal error detail, when the JWKS endpoint returns non-200", async () => {
    const badJwksApp = new Hono();
    badJwksApp.get("/jwks", (c) => c.text("service unavailable", 503));
    const server = Bun.serve({ port: 0, fetch: badJwksApp.fetch });

    const app = new Hono();
    app.use("/protected", betterAuthJwt(`http://localhost:${server.port}/jwks`));
    app.get("/protected", (c) => c.json({ payload: c.get("jwtPayload") }));

    const res = await app.request("http://localhost/protected", {
      headers: { Authorization: `Bearer ${wellFormedToken()}` },
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Internal Server Error" });

    server.stop(true);
  });
});
