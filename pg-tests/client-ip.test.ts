import { describe, test, expect } from "bun:test";
import { auth } from "../auth.ts";

/**
 * Rate limiting is only per-caller if better-auth can resolve a client IP.
 * It could not: requests arrive via Vercel then Railway, so x-forwarded-for
 * holds a list, and better-auth discards multi-value headers unless
 * trustedProxies is set — collapsing everyone into one shared bucket.
 */
describe("client IP resolution", () => {
  test("x-client-ip is preferred over x-forwarded-for", async () => {
    const ctx = await auth.$context;
    const headers = ctx.options.advanced?.ipAddress?.ipAddressHeaders;
    expect(headers).toEqual(["x-client-ip", "x-forwarded-for"]);
  });

  test("ip tracking is not disabled", async () => {
    const ctx = await auth.$context;
    expect(ctx.options.advanced?.ipAddress?.disableIpTracking).toBeFalsy();
  });
});
