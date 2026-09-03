import { describe, test, expect } from "bun:test";
import { auth } from "../auth.ts";

/**
 * The failure this guards against: an unreachable mail server used to hold the
 * sign-up request open, the frontend proxy aborted at 10s, and the user saw
 * "failed to create account" for an account that had been created.
 */
describe("sign-up does not block on email", () => {
  test("returns promptly even though email is unconfigured in tests", async () => {
    const email = `nonblocking-${crypto.randomUUID()}@wisc.edu`;
    const started = Date.now();
    const res: any = await auth.api.signUpEmail({
      body: { email, password: "test-password-123", name: "T" },
      asResponse: false,
    });
    const elapsed = Date.now() - started;

    expect(res.user.email).toBe(email);
    // Comfortably under the frontend proxy's 10s abort.
    expect(elapsed).toBeLessThan(5000);
  });
});
