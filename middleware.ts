import { Context, Next } from "hono";

export const ALLOWED_ORIGINS = [
  "https://sconniegrades.com",
  "https://www.sconniegrades.com",
  "https://badgerbase.app",
  "https://www.badgerbase.app",
  "http://localhost:3000",
  "http://localhost:3001",
];

export function apiKeyAuth(apiKey: string) {
  return async (c: Context, next: Next) => {
    const key = c.req.header("x-api-key");
    if (!key || key !== apiKey) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  };
}
