import { Hono } from "hono";
import { cors } from "hono/cors";
import mysql from "mysql2/promise";
import Redis from "ioredis";
import { createApp } from "./api.js";
import { createSubscriptionApp, elasticEmailSender } from "./subscription_api.ts";
import { ALLOWED_ORIGINS } from "./middleware.ts";

const jwtSecret = Bun.env.SUPABASE_JWT_SECRET;
if (!jwtSecret) {
  console.error("SUPABASE_JWT_SECRET is not set");
  process.exit(1);
}
if (!Bun.env.REDIS_URL) {
  console.error("REDIS_URL is not set");
  process.exit(1);
}

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

app.route(
  "/",
  createApp({ pool, redis, apiKey: Bun.env.GET_API_KEY })
);

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
  await pool.end();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});
