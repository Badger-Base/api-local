import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { auth, toFirstPartyAuthUrl } from "../auth.ts";
import { markEmailVerified } from "./setup.ts";

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

// Regression cover for the defect where better-auth's default
// (requireEmailVerification: false) silently dropped the email-confirmation
// step Supabase used to enforce. Subscriptions are keyed by email with no
// foreign key, so an unverified account for someone else's address would
// hand over that person's notification list.
describe("email verification", () => {
  test("email/password sign-up requires a verified address", () => {
    expect(auth.options.emailAndPassword?.requireEmailVerification).toBe(true);
  });

  test("a verification email sender is configured", () => {
    expect(typeof auth.options.emailVerification?.sendVerificationEmail).toBe(
      "function"
    );
  });

  test("sign-up creates no session until the address is verified", async () => {
    const email = `verify-${crypto.randomUUID()}@wisc.edu`;
    const result: any = await auth.api.signUpEmail({
      body: { email, password: "test-password-123", name: "T" },
      asResponse: false,
    });
    expect(result.user.email).toBe(email);
    expect(result.user.emailVerified).toBe(false);
    // No token means no session -- the frontend's signup page keys its
    // "check your email" message off exactly this.
    expect(result.token).toBeNull();
  });

  test("sign-in is rejected with EMAIL_NOT_VERIFIED before verification", async () => {
    const email = `unverified-${crypto.randomUUID()}@wisc.edu`;
    await auth.api.signUpEmail({
      body: { email, password: "test-password-123", name: "T" },
      asResponse: false,
    });
    const res = await buildApp().request(
      "http://localhost/api/auth/sign-in/email",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "test-password-123" }),
      }
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("EMAIL_NOT_VERIFIED");
  });

  test("sign-in succeeds once the address is verified", async () => {
    const email = `verified-${crypto.randomUUID()}@wisc.edu`;
    await auth.api.signUpEmail({
      body: { email, password: "test-password-123", name: "T" },
      asResponse: false,
    });
    await markEmailVerified(email);
    const res = await buildApp().request(
      "http://localhost/api/auth/sign-in/email",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "test-password-123" }),
      }
    );
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().length).toBeGreaterThan(0);
  });
});

// /magic-link/verify sets the session cookie on whichever origin serves it,
// so an emailed link pointing at this API would set it on the API's own
// (cross-site, in production) domain and the user would land back on the
// frontend still signed out.
describe("toFirstPartyAuthUrl", () => {
  const LINK =
    "https://api.example.com/api/auth/magic-link/verify?token=abc&callbackURL=%2Fdashboard";

  test("swaps in the frontend origin, keeping path, token and callbackURL", () => {
    process.env.APP_URL = "https://badgerbase.app";
    expect(toFirstPartyAuthUrl(LINK)).toBe(
      "https://badgerbase.app/api/auth/magic-link/verify?token=abc&callbackURL=%2Fdashboard"
    );
    delete process.env.APP_URL;
  });

  test("keeps a non-default port on the frontend origin", () => {
    process.env.APP_URL = "http://localhost:3000";
    expect(toFirstPartyAuthUrl(LINK)).toBe(
      "http://localhost:3000/api/auth/magic-link/verify?token=abc&callbackURL=%2Fdashboard"
    );
    delete process.env.APP_URL;
  });

  test("leaves the link alone when APP_URL is unset", () => {
    delete process.env.APP_URL;
    expect(toFirstPartyAuthUrl(LINK)).toBe(LINK);
  });

  test("falls back to the original link when APP_URL is malformed", () => {
    process.env.APP_URL = "not a url";
    expect(toFirstPartyAuthUrl(LINK)).toBe(LINK);
    delete process.env.APP_URL;
  });
});
