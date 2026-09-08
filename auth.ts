import { betterAuth } from "better-auth";
import { jwt, magicLink } from "better-auth/plugins";
import { mcp } from "@better-auth/mcp";
import { cimd } from "@better-auth/cimd";
import { Pool } from "pg";
import { sendEmail } from "./email.ts";
import { ALLOWED_ORIGINS } from "./middleware.ts";
import { fetchClientMetadataResource } from "./oauth-network.ts";

/**
 * Sends without ever blocking the caller.
 *
 * better-auth invokes these callbacks through `runInBackgroundOrAwait`, which
 * under Bun kept the sign-up request open until the send finished. With an
 * unreachable mail server that meant sign-up hung, the frontend proxy timed
 * out at 10s, and the user saw "failed to create account" for an account that
 * had in fact been created.
 *
 * Delivery is best-effort by nature — the user is told to check their inbox
 * either way — so a failure here is logged, never surfaced as a failed sign-up.
 */
function sendInBackground(
  kind: string,
  to: string,
  subject: string,
  html: string
): void {
  void sendEmail(to, subject, html).catch((err) => {
    console.error(
      `[auth] ${kind} email to ${to} failed:`,
      (err as NodeJS.ErrnoException)?.code ?? "",
      (err as Error)?.message ?? String(err)
    );
  });
}

/**
 * BadgerBase identity provider. Uses better-auth's native scrypt hashing —
 * there is no migration, so there are no foreign password hashes to verify.
 *
 * better-auth's tables live in the same Postgres as courses and
 * subscriptions, so this uses DATABASE_URL — there is no separate auth
 * database.
 *
 * Under `bun test` Bun sets NODE_ENV=test, and this resolves
 * TEST_DATABASE_URL instead. That is the one thing worth being careful
 * about here: DATABASE_URL points at production, and the suite signs users
 * up for real, so without this branch running the tests would create
 * accounts in the production database.
 */
/**
 * Public base URL of this API.
 *
 * Validated here rather than left to better-auth, which throws
 * `BetterAuthError: Invalid base URL` from inside its own module graph — a
 * crash loop whose stack points at node_modules and never names the variable
 * at fault. A scheme-less value like `api-local.railway.internal` is the easy
 * mistake, and `required` in server.ts does not catch it because the variable
 * IS set; it is just not a URL.
 *
 * It must also be the PUBLIC address. Railway's `*.railway.internal` names
 * resolve only inside Railway's private network, so the frontend on Vercel
 * cannot reach one, and better-auth builds links and checks origins against
 * this value.
 */
export const authBaseUrl = (() => {
  const raw = process.env.BETTER_AUTH_URL ?? "http://localhost:3002";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `BETTER_AUTH_URL is not a valid URL: ${JSON.stringify(raw)}. ` +
        "It must include a scheme, e.g. https://api.example.com — a bare " +
        "hostname will not parse."
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `BETTER_AUTH_URL must use http:// or https://, got ${parsed.protocol}`
    );
  }
  if (parsed.hostname.endsWith(".railway.internal")) {
    throw new Error(
      `BETTER_AUTH_URL is set to a Railway private hostname (${parsed.hostname}). ` +
        "It must be the public address of this API: better-auth builds " +
        "emailed links and validates origins against it, and the frontend " +
        "cannot resolve *.railway.internal from outside Railway's network."
    );
  }
  return parsed.origin;
})();

const isTestEnv = process.env.NODE_ENV === "test";
const authDatabaseUrl = isTestEnv
  ? process.env.TEST_DATABASE_URL
  : process.env.DATABASE_URL;
if (!authDatabaseUrl) {
  throw new Error(
    isTestEnv
      ? "TEST_DATABASE_URL is required to run the test suite (NODE_ENV=test)."
      : "DATABASE_URL is required."
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
/**
 * Guards APP_URL against the mistake that shipped it: it was left at
 * http://localhost:3000 in production, so every verification and magic link
 * emailed to a real user pointed at their own machine. Nobody could verify,
 * and nothing failed loudly — the mail sent perfectly, it just led nowhere.
 *
 * The rule is self-consistent rather than environment-sniffing: if this API's
 * own base URL is public, the app it links to must be public too. Locally
 * both are localhost and nothing fires.
 */
function assertAppUrlMatchesDeployment(appUrl: string | undefined): void {
  const apiIsPublic = !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(
    authBaseUrl
  );
  if (!apiIsPublic) return;

  if (!appUrl) {
    throw new Error(
      "APP_URL is required when BETTER_AUTH_URL is a public address. " +
        "Without it, emailed verification and magic links point at this API " +
        "instead of the frontend, and the session cookie lands on the wrong " +
        "origin."
    );
  }
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(appUrl)) {
    throw new Error(
      `APP_URL is set to a local address (${appUrl}) while BETTER_AUTH_URL ` +
        `is public (${authBaseUrl}). Emailed links would point at the ` +
        "recipient's own machine. Set it to the frontend's public origin."
    );
  }
}

assertAppUrlMatchesDeployment(process.env.APP_URL);

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
  baseURL: authBaseUrl,
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
    // Clicking the emailed link previously verified the address and then
    // dropped the user on the site still signed out, with nothing to say it
    // had worked. They had to guess that it had, and go and sign in.
    autoSignInAfterVerification: true,

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
      sendInBackground(
        "verification",
        user.email,
        "Confirm your BadgerBase email",
        `<p>Click to confirm your email address: <a href="${link}">${link}</a></p>`
      );
    },
  },
  advanced: {
    ipAddress: {
      // The frontend proxy sets x-client-ip to a single address (the one
      // Vercel observed) and strips any inbound value, so it is the only
      // header here that carries one unambiguous IP.
      //
      // better-auth's default is x-forwarded-for, but it only trusts that
      // header when it holds exactly one address. Requests arrive via Vercel
      // and then Railway, so it is always a list and gets discarded — leaving
      // every user sharing a single rate-limit bucket, which better-auth warns
      // about on boot. Configuring trustedProxies instead would mean tracking
      // Vercel's egress CIDRs, which are not static.
      //
      // x-forwarded-for is kept as a fallback for direct callers, where it is
      // a single address and genuinely is the client.
      ipAddressHeaders: ["x-client-ip", "x-forwarded-for"],
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
        sendInBackground(
          "magic-link",
          email,
          "Sign in to BadgerBase",
          `<p>Click to sign in: <a href="${link}">${link}</a></p>`
        );
      },
    }),
    // Makes this auth server the MCP endpoint's OAuth authorization server.
    // mcp() IS the OAuth provider (a thin wrapper around
    // @better-auth/oauth-provider) — there is no separate oauthProvider
    // plugin alongside it. loginPage/consentPage are absolute frontend URLs:
    // better-auth uses them verbatim as the redirect Location, with no
    // origin resolution against this server's own baseURL, so the frontend
    // does not need to live on this same origin (docs/mcp-spike-findings.md,
    // Question 1).
    mcp({
      loginPage: `${process.env.APP_URL ?? "https://badgerbase.app"}/login`,
      consentPage: `${process.env.APP_URL ?? "https://badgerbase.app"}/consent`,
      resource: process.env.MCP_RESOURCE_URL ?? "https://mcp.badgerbase.app/mcp",
    }),
    // Client ID Metadata Documents: lets MCP clients register by pointing at
    // an HTTPS URL that serves their own client metadata, instead of a
    // separate registration call. fetchClientMetadataResource is this
    // server's SSRF boundary for that fetch — see oauth-network.ts for why
    // it isn't @better-auth/cimd's own packaged Node transport.
    cimd({
      fetchClientMetadataResource,
      metadataProfile: "mcp-2026-07-28",
    }),
  ],
});
