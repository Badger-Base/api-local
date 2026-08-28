import { Hono } from "hono";
import { cors } from "hono/cors";
import Redis from "ioredis";
import { ALLOWED_ORIGINS } from "./middleware.ts";
import { elasticEmailSender } from "./email.ts";
import { createPgApp } from "./pg/routes/courses.ts";
import { createPgSubscriptionApp } from "./pg/routes/subscriptions.ts";
import { createPgSearchApp } from "./pg/routes/search.ts";
import { createDb } from "./pg/db.ts";
import { createCache } from "./pg/cache.ts";
// NOTE: this is a static import, so ES module semantics evaluate auth.ts's
// top-level code (including its own throw if AUTH_DATABASE_URL is unset)
// before any of this module's own code below runs — regardless of where
// this import line sits textually. That happens before the `required` loop
// below ever executes, so AUTH_DATABASE_URL is deliberately NOT added to
// `required`: it would be dead code, since a missing AUTH_DATABASE_URL
// already crashes the process via auth.ts's own clear error message prior
// to reaching this point. BETTER_AUTH_SECRET is different — better-auth
// does not validate it eagerly at construction (confirmed empirically), so
// importing `auth` succeeds even when it's unset, and it's only used later
// when a request actually hits /api/auth/*. Adding it to `required` below
// still gives a clean startup failure in that case.
import { auth } from "./auth.ts";

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

const jwksUrl = `${Bun.env.BETTER_AUTH_URL ?? "http://localhost:3002"}/api/auth/jwks`;

const redis = new Redis(Bun.env.REDIS_URL);

const emailFromAddr = Bun.env.FROM_EMAIL || Bun.env.SES_FROM_EMAIL;
const elasticApiKey = Bun.env.ELASTICEMAIL_API_KEY;
const emailSender =
  emailFromAddr && elasticApiKey
    ? (to: string, subject: string, html: string) =>
        elasticEmailSender(emailFromAddr, elasticApiKey, to, subject, html)
    : undefined;

const app = new Hono();

app.use("/*", cors({ origin: ALLOWED_ORIGINS, credentials: true }));

app.get("/health", (c) => c.json({ status: "ok" }));

// better-auth owns everything under /api/auth/* — sign-in, sign-up, JWKS.
app.all("/api/auth/*", (c) => auth.handler(c.req.raw));

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
