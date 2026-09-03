import { Context, Next } from "hono";

export const ALLOWED_ORIGINS = [
  "https://sconniegrades.com",
  "https://www.sconniegrades.com",
  "https://badgerbase.app",
  "https://www.badgerbase.app",
  "http://localhost:3000",
  "http://localhost:3001",
];

/**
 * `name` only exists so a rejection is identifiable in the logs. Several
 * middlewares return an identical `{"error":"Unauthorized"}` 401, and none of
 * them logged, which made a key mismatch indistinguishable from a rejected
 * token — the two are diagnosed completely differently, and telling them
 * apart previously meant guessing.
 */
export function apiKeyAuth(apiKey: string, name = "api") {
  return async (c: Context, next: Next) => {
    const key = c.req.header("x-api-key");
    if (!key || key !== apiKey) {
      // Never log either key, only which side was absent or mismatched.
      console.error(
        `[auth] ${name} key rejected on ${c.req.method} ${new URL(c.req.url).pathname}: ` +
          (!key ? "no x-api-key header" : "key does not match") +
          (apiKey ? "" : " (server-side key is empty!)")
      );
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  };
}
