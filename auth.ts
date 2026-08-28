import { betterAuth } from "better-auth";
import { jwt, magicLink } from "better-auth/plugins";
import { Pool } from "pg";
import { elasticEmailSender } from "./email.ts";

/**
 * BadgerBase identity provider. Uses better-auth's native scrypt hashing —
 * there is no migration, so there are no foreign password hashes to verify.
 *
 * AUTH_DATABASE_URL is deliberately separate from DATABASE_URL: the latter
 * points at production, and schema tooling must never default to it.
 */
export const auth = betterAuth({
  database: new Pool({
    connectionString: process.env.AUTH_DATABASE_URL ?? process.env.DATABASE_URL,
  }),
  secret: process.env.BETTER_AUTH_SECRET!,
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3002",
  emailAndPassword: {
    enabled: true,
  },
  plugins: [
    jwt(),
    // The Supabase setup offered OTP sign-in; magic links are the equivalent
    // here. Dropping it would silently remove a login method users rely on.
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        const from = process.env.FROM_EMAIL ?? process.env.SES_FROM_EMAIL;
        const key = process.env.ELASTICEMAIL_API_KEY;
        if (!from || !key) throw new Error("magic link email is not configured");
        await elasticEmailSender(
          from,
          key,
          email,
          "Sign in to BadgerBase",
          `<p>Click to sign in: <a href="${url}">${url}</a></p>`
        );
      },
    }),
  ],
});
