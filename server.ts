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

const required = [
  "SUPABASE_JWT_SECRET",
  "REDIS_URL",
  "GET_API_KEY",
  "SUBSCRIPTION_API_KEY",
  "DATABASE_URL",
] as const;
for (const key of required) {
  if (!Bun.env[key]) {
    console.error(`${key} is not set`);
    process.exit(1);
  }
}

const jwtSecret = Bun.env.SUPABASE_JWT_SECRET!;

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
    jwtSecret,
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
