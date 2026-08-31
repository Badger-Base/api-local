import { betterAuth } from "better-auth";
import { jwt, magicLink } from "better-auth/plugins";
import { Pool } from "pg";
import { sendEmail } from "./email.ts";
import { ALLOWED_ORIGINS } from "./middleware.ts";

/**
 * BadgerBase identity provider. Uses better-auth's native scrypt hashing —
 * there is no migration, so there are no foreign password hashes to verify.
 *
 * AUTH_DATABASE_URL is deliberately separate from DATABASE_URL: the latter
 * points at production, and schema tooling must never default to it. There
 * is no fallback to DATABASE_URL — production sets AUTH_DATABASE_URL
 * explicitly (opted in), rather than inheriting it implicitly.
 */
const authDatabaseUrl = process.env.AUTH_DATABASE_URL;
if (!authDatabaseUrl) {
  throw new Error(
    "AUTH_DATABASE_URL is required and must be set explicitly — it must not " +
      "be inherited from DATABASE_URL (which points at production)."
  );
}

/**
 * Rewrites an emailed auth link so it points at the frontend's own origin
 * rather than this API's.
 *
 * better-auth builds these links from its own `baseURL`, which in production
 * is the Railway host. The magic-link verify endpoint calls `setSessionCookie`
 * on whatever origin serves it, so a link the user clicks on the Railway host
 * sets the session cookie on the Railway host — a different registrable
 * domain from badgerbase.app / sconniegrades.com, so the browser drops it and
 * the user lands back on the site still signed out. Pointing the link at the
 * frontend routes the click through its same-origin /api/auth proxy
 * (BadgerBaseFrontend app/api/auth/[...all]/route.ts), which relays the
 * Set-Cookie first-party. Only the origin is swapped; the path, token, and
 * callbackURL are untouched, and the request reaches this same handler.
 *
 * With APP_URL unset (local dev, where the API and frontend are same-site
 * anyway) the link is left exactly as better-auth built it.
 */
export function toFirstPartyAuthUrl(url: string): string {
  const appUrl = process.env.APP_URL;
  if (!appUrl) return url;
  try {
    const rewritten = new URL(url);
    const app = new URL(appUrl);
    rewritten.protocol = app.protocol;
    rewritten.host = app.host;
    return rewritten.toString();
  } catch {
    // A malformed APP_URL must not take down sign-in; send the original link.
    console.error("APP_URL is not a valid URL; sending the unrewritten link");
    return url;
  }
}

export const auth = betterAuth({
  database: new Pool({
    connectionString: authDatabaseUrl,
  }),
  secret: process.env.BETTER_AUTH_SECRET!,
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3002",
  // better-auth validates every request's callbackURL (e.g. the frontend's
  // authClient.signIn.magicLink({ callbackURL })) against this list and
  // rejects with INVALID_CALLBACK_URL if it isn't present — this is not
  // redundant with CORS, it's a separate check. Reuses the CORS allowlist
  // from middleware.ts rather than duplicating it, since that is already
  // exactly the set of origins allowed to talk to this API.
  trustedOrigins: ALLOWED_ORIGINS,
  emailAndPassword: {
    enabled: true,
    // Supabase required email confirmation before an account could be used;
    // better-auth defaults this off, which silently dropped that guarantee.
    // It matters more here than usual: course/section subscriptions are keyed
    // by email address with no foreign key to the users table, so without
    // verification anyone could register victim@wisc.edu, never confirm it,
    // and read or delete that person's notification list.
    requireEmailVerification: true,
  },
  emailVerification: {
    // Enabling requireEmailVerification above makes better-auth send this on
    // sign-up (see sign-up.mjs: `sendOnSignUp ?? requireEmailVerification`)
    // and makes sign-in reject unverified users with 403 EMAIL_NOT_VERIFIED,
    // which the frontend's app/login/page.tsx already handles.
    //
    // Same sender and same unconfigured-env behavior as sendMagicLink below:
    // throw rather than silently pretend the mail went out. Note the
    // asymmetry in how better-auth treats that throw -- sendMagicLink's
    // rejection fails the request, but this one is invoked through
    // `runInBackgroundOrAwait`, which catches and only logs. So with the
    // email vars unset, sign-up still succeeds (returning token: null) and
    // the error shows up in the server log, not in the API response.
    sendVerificationEmail: async ({ user, url }) => {
      const link = toFirstPartyAuthUrl(url);
      await sendEmail(
        user.email,
        "Confirm your BadgerBase email",
        `<p>Click to confirm your email address: <a href="${link}">${link}</a></p>`
      );
    },
  },
  plugins: [
    jwt(),
    // The Supabase setup offered OTP sign-in; magic links are the equivalent
    // here. Dropping it would silently remove a login method users rely on.
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        // Must go through the frontend proxy: /magic-link/verify sets the
        // session cookie on whichever origin serves it.
        const link = toFirstPartyAuthUrl(url);
        await sendEmail(
          email,
          "Sign in to BadgerBase",
          `<p>Click to sign in: <a href="${link}">${link}</a></p>`
        );
      },
    }),
  ],
});
