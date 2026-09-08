import { Hono } from "hono";
import { cors } from "hono/cors";
import Redis from "ioredis";
import { ALLOWED_ORIGINS } from "./middleware.ts";
import { sendEmail, emailFrom, isEmailConfigured } from "./email.ts";
import { createPgApp } from "./pg/routes/courses.ts";
import { createPgSubscriptionApp } from "./pg/routes/subscriptions.ts";
import { createPgSearchApp } from "./pg/routes/search.ts";
import { createRegisterApp } from "./pg/routes/register.ts";
import { createMcpApp } from "./pg/mcp/server.ts";
import { createDb } from "./pg/db.ts";
import { createCache } from "./pg/cache.ts";
// NOTE: this is a static import, so ES module semantics evaluate auth.ts's
// top-level code (including its own throw if DATABASE_URL is unset) before
// any of this module's own code below runs — regardless of where this
// import line sits textually. That happens before the `required` loop below
// ever executes. BETTER_AUTH_SECRET is listed in `required` because
// better-auth does not validate it eagerly at construction (confirmed
// empirically), so
// importing `auth` succeeds even when it's unset, and it's only used later
// when a request actually hits /api/auth/*. Adding it to `required` below
// still gives a clean startup failure in that case.
import { auth, authBaseUrl } from "./auth.ts";

const required = [
  "REDIS_URL",
  "GET_API_KEY",
  "SUBSCRIPTION_API_KEY",
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
] as const;
for (const key of required) {
  if (!Bun.env[key]) {
    console.error(`${key} is not set`);
    process.exit(1);
  }
}

const jwksUrl = new URL("/api/auth/jwks", authBaseUrl).toString();

const redis = new Redis(Bun.env.REDIS_URL);

const emailFromAddr = emailFrom();
const emailSender = isEmailConfigured() ? sendEmail : undefined;

const app = new Hono();

app.use("/*", cors({ origin: ALLOWED_ORIGINS, credentials: true }));

app.get("/health", (c) => c.json({ status: "ok" }));

// better-auth owns everything under /api/auth/* — sign-in, sign-up, JWKS.
app.all("/api/auth/*", (c) => auth.handler(c.req.raw));

// better-auth also serves OAuth discovery metadata at bare `/.well-known/*`
// paths (RFC 8414 authorization-server metadata, RFC 9728 protected-resource
// metadata) — outside the /api/auth prefix, per those RFCs. Without this
// route, the `resource_metadata` URL that /mcp's 401 WWW-Authenticate header
// advertises 404s: a real MCP client following it hits a dead end instead of
// a login prompt.
app.all("/.well-known/*", (c) => auth.handler(c.req.raw));

const pgDb = createDb(Bun.env.DATABASE_URL!);
const queryCache = createCache(redis);
// Suggestions get their own namespace and a much shorter TTL: the text
// tracks the catalog, and 5 minutes bounds staleness after an ETL run.
const suggestCache = createCache(redis, { prefix: "pg:suggest:", ttl: 300 });

app.route(
  "/v2",
  createPgApp({ db: pgDb, cache: queryCache, apiKey: Bun.env.GET_API_KEY! })
);

app.route(
  "/v2",
  createRegisterApp({ databaseUrl: Bun.env.DATABASE_URL!, apiKey: Bun.env.GET_API_KEY! })
);

app.route(
  "/v2",
  createPgSearchApp({ db: pgDb, cache: suggestCache, apiKey: Bun.env.GET_API_KEY! })
);

app.route(
  "/v2",
  createPgSubscriptionApp({
    db: pgDb,
    jwksUrl,
    subscriptionApiKey: Bun.env.SUBSCRIPTION_API_KEY || "",
    sendEmail: emailSender,
    fromEmail: emailFromAddr,
  })
);

app.route("/mcp", createMcpApp({ db: pgDb, cache: queryCache }));

const port = parseInt(Bun.env.PORT || "3000");
Bun.serve({ port, fetch: app.fetch });
console.log(`BadgerBase API running on port ${port}`);

process.on("SIGINT", async () => {
  await Promise.all([redis.quit(), pgDb.destroy()]);
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await Promise.all([redis.quit(), pgDb.destroy()]);
  process.exit(0);
});
