import { Hono } from "hono";
import { cors } from "hono/cors";
import mysql from "mysql2/promise";
import Redis from "ioredis";
import { createApp } from "./api.js";
import { createSubscriptionApp, elasticEmailSender } from "./subscription_api.ts";
import { ALLOWED_ORIGINS } from "./middleware.ts";
import { createPgApp } from "./pg/routes/courses.ts";
import { createDb } from "./pg/db.ts";
import { createCache } from "./pg/cache.ts";

const usePg = Bun.env.USE_PG === "true";

const required = [
  "SUPABASE_JWT_SECRET",
  "REDIS_URL",
  "MYSQL_URL",
  "GET_API_KEY",
  "SUBSCRIPTION_API_KEY",
  ...(usePg ? (["DATABASE_URL"] as const) : ([] as const)),
] as const;
for (const key of required) {
  if (!Bun.env[key]) {
    console.error(`${key} is not set`);
    process.exit(1);
  }
}

const jwtSecret = Bun.env.SUPABASE_JWT_SECRET!;

const pool = mysql.createPool({
  uri: Bun.env.MYSQL_URL,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

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

if (usePg) {
  const db = createDb(Bun.env.DATABASE_URL!);
  const queryCache = createCache(redis);
  app.route(
    "/",
    createPgApp({ db, cache: queryCache, apiKey: Bun.env.GET_API_KEY! })
  );
} else {
  app.route(
    "/",
    createApp({ pool, redis, apiKey: Bun.env.GET_API_KEY })
  );
}

// Subscription routes stay on MySQL for now (separate migration).
app.route(
  "/",
  createSubscriptionApp({
    pool,
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
  await Promise.all([pool.end(), redis.quit()]);
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await Promise.all([pool.end(), redis.quit()]);
  process.exit(0);
});
