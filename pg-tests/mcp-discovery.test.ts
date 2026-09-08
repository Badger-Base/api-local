import { describe, test, expect } from "bun:test";
import { auth } from "../auth.ts";

describe("MCP OAuth discovery", () => {
  test("serves protected resource metadata naming the resource", async () => {
    const res = await auth.handler(
      new Request("http://localhost:3002/.well-known/oauth-protected-resource")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBeTruthy();
  });

  // Task 1's spike found the bare-root path 404s; only the two paths a
  // spec-conforming client actually derives from the issuer are served —
  // the OIDC-style path-append and the RFC 8414 path-insertion form.
  test("serves authorization server metadata at the OIDC-style path-append", async () => {
    const res = await auth.handler(
      new Request(
        "http://localhost:3002/api/auth/.well-known/oauth-authorization-server"
      )
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authorization_endpoint).toBeTruthy();
    expect(body.token_endpoint).toBeTruthy();
  });

  test("serves authorization server metadata at the RFC 8414 path-insertion form", async () => {
    const res = await auth.handler(
      new Request(
        "http://localhost:3002/.well-known/oauth-authorization-server/api/auth"
      )
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authorization_endpoint).toBeTruthy();
    expect(body.token_endpoint).toBeTruthy();
  });

  test("still serves JWKS, which the resource server verifies against", async () => {
    const res = await auth.handler(new Request("http://localhost:3002/api/auth/jwks"));
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).keys)).toBe(true);
  });
});
