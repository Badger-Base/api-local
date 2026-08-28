import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { auth } from "../auth.ts";

function buildApp() {
  const app = new Hono();
  app.all("/api/auth/*", (c) => auth.handler(c.req.raw));
  return app;
}

describe("better-auth mount", () => {
  test("exposes the JWKS endpoint", async () => {
    const res = await buildApp().request("http://localhost/api/auth/jwks");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.keys)).toBe(true);
  });

  test("unknown auth route does not 500", async () => {
    const res = await buildApp().request("http://localhost/api/auth/nope");
    expect(res.status).toBeLessThan(500);
  });

  // Guards against the magicLink plugin being dropped from the config, which
  // would remove a login method users currently rely on.
  test("the magic-link endpoint is registered", async () => {
    const res = await buildApp().request("http://localhost/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "badger@wisc.edu" }),
    });
    expect(res.status).not.toBe(404);
  });
});
