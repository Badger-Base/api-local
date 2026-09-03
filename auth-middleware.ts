import type { Context, Next } from "hono";
import { createRemoteJWKSet, jwtVerify, errors } from "jose";

/**
 * Verifies a better-auth JWT against the server's JWKS.
 *
 * hono/jwt is not usable here: better-auth signs with EdDSA, and hono/jwt's
 * jwt({ secret }) does symmetric HMAC verification only.
 *
 * Sets the same "jwtPayload" context key the Supabase-era middleware set, so
 * every downstream handler keeps working unchanged.
 */
export function betterAuthJwt(jwksUrl: string) {
  const jwks = createRemoteJWKSet(new URL(jwksUrl));

  return async (c: Context, next: Next) => {
    const header = c.req.header("Authorization");
    if (!header?.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const token = header.slice("Bearer ".length);

    let payload;
    try {
      ({ payload } = await jwtVerify(token, jwks));
    } catch (err) {
      if (isTokenValidationError(err)) {
        // Malformed/expired/mis-signed token, or a kid that isn't in the
        // (possibly just-refreshed) key set -- the caller's fault. Logged
        // because it is otherwise indistinguishable from an api-key
        // rejection: same status, same body, and neither said anything.
        const e = err as { code?: string; message?: string };
        console.error(
          `[auth] token rejected: ${e?.code ?? "unknown"} ${e?.message ?? ""}`.trim()
        );
        return c.json({ error: "Unauthorized" }, 401);
      }
      // Anything else means we failed to fetch or parse our own JWKS
      // (unreachable, timed out, non-200, invalid JSON) -- our fault, not
      // the caller's, so it should not read as "your token is bad."
      console.error("betterAuthJwt: JWKS unavailable", err);
      return c.json({ error: "Internal Server Error" }, 500);
    }

    if (typeof payload.sub !== "string" || !payload.sub) {
      return c.json({ error: "Invalid token: missing user ID" }, 401);
    }

    c.set("jwtPayload", payload);
    await next();
  };
}

function isTokenValidationError(err: unknown): boolean {
  return (
    err instanceof errors.JWTInvalid ||
    err instanceof errors.JWTExpired ||
    err instanceof errors.JWTClaimValidationFailed ||
    err instanceof errors.JWSInvalid ||
    err instanceof errors.JWSSignatureVerificationFailed ||
    err instanceof errors.JOSEAlgNotAllowed ||
    err instanceof errors.JWKSNoMatchingKey ||
    err instanceof errors.JWKSMultipleMatchingKeys
  );
}
