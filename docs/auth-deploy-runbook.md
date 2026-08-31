# Auth Deploy Runbook

## Preconditions
- Tasks 1–9 merged; full test suites green (`bun test` in api-local,
  `npx vitest run` in BadgerBaseFrontend — the 3 pre-existing
  `__tests__/tokens.test.ts` failures are unrelated to auth and are expected).
- API: `BETTER_AUTH_SECRET` and `AUTH_DATABASE_URL` set explicitly in Railway.
  `AUTH_DATABASE_URL` has no fallback to `DATABASE_URL` — `auth.ts` throws at
  import time and the server refuses to start without it.
- Frontend: `AUTH_UPSTREAM_URL` set in Vercel **before** the first production
  build, pointing at this API (e.g.
  `https://api-local-production.up.railway.app`, no trailing slash).
  `next.config.mjs` hard-fails the production build if this is unset — this is
  by design, not a bug to work around. It replaces `NEXT_PUBLIC_AUTH_URL`,
  which no longer exists: the browser now authenticates against the
  frontend's own origin through the same-origin proxy at
  `app/api/auth/[...all]/route.ts`, and only the server needs to know this
  API's address. Delete the old `NEXT_PUBLIC_AUTH_URL` from Vercel so it
  can't be mistaken for live configuration.
- Frontend: `SUBSCRIPTION_URL` **must end in `/v2`** (e.g.
  `https://api-local-production.up.railway.app/v2`). This API mounts the
  subscription routes (`/subscriptions`, `/course-subscription`,
  `/section-subscription`) under `/v2`; the bare paths were served by the
  MySQL API, which has been deleted. Without the suffix every subscription
  call 404s while auth itself looks perfectly healthy — verify with
  `curl -o /dev/null -w '%{http_code}' "$SUBSCRIPTION_URL/subscriptions?email=x@y.com"`,
  which should return 401 (route exists, credentials missing), not 404.
- API: `APP_URL` set in Railway to the frontend's public origin
  (`https://badgerbase.app`). Emailed auth links are rewritten to this origin
  so the click lands on the frontend's `/api/auth` proxy. Without it,
  better-auth builds the magic link against its own Railway `baseURL`, and
  `/magic-link/verify` sets the session cookie on the Railway host — a
  different registrable domain — so magic-link sign-in appears to succeed and
  leaves the user signed out.
- API: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` set in Railway (self-hosted Mox at mail.badgerbase.app). These are now
  required in practice, not optional — see "Email verification is required".
- `trustedOrigins` in `api-local/auth.ts` (currently reused from
  `ALLOWED_ORIGINS` in `middleware.ts`) must include the frontend's
  production origin(s) (e.g. `https://badgerbase.app`), or magic-link
  sign-in returns 403 (`INVALID_CALLBACK_URL`). This is a separate check
  from CORS — don't assume the CORS allowlist alone covers it, just confirm
  the same list is actually wired into `trustedOrigins`.

## No data migration
There is no user data migration. The old Supabase-authenticated accounts are
wiped; every user re-registers from scratch under better-auth.

`section_subscriptions` (and course subscriptions) are keyed by email with
no foreign key to any users table. This means re-registering with the same
email address automatically regains the associated notification
subscriptions — no migration script or backfill is needed for this to work.

## Email verification is required
`emailAndPassword.requireEmailVerification` is on. Sign-up creates the user
but no session (the response carries `token: null`), and sign-in on an
unverified address returns 403 `EMAIL_NOT_VERIFIED` until the emailed link is
clicked. This restores the confirmation step Supabase enforced, and it is a
security control rather than a nicety: subscriptions are keyed by email with
no foreign key to the users table, so an unverified account for someone
else's address would expose that person's notification list.

That makes the `SMTP_*` variables **operationally required**
in production even though the server starts without them. better-auth invokes
`sendVerificationEmail` through `runInBackgroundOrAwait`, which catches and
only logs a failure — so with those vars unset, sign-up returns a cheerful
200, no email is ever sent, and the account can never sign in. Confirm both
are set in Railway and that a verification email actually arrives during
staging verification.

## Passwordless login is a magic link, not an OTP code
Passwordless sign-in sends an emailed magic link (better-auth's `magicLink`
plugin, wired in `api-local/auth.ts`) — the user clicks a link, not a
6-digit code. If the code-entry UX is ever wanted back, better-auth ships an
`emailOTP` plugin as a drop-in alternative; it is not currently enabled.

## Staging verification (required before production)
1. Apply `schema/002_better_auth.sql` to staging.
2. Confirm `account.issuer` exists:
   `psql "$STAGING_URL" -c "SELECT column_name FROM information_schema.columns WHERE table_name='account' AND column_name='issuer';"`
   An empty result means signup will fail at runtime with Postgres 42703.
3. Sign up a new account through the UI. Confirm the "check your email"
   message appears and that no session is created. Click the emailed
   confirmation link, then sign in. Signing in *before* clicking the link
   must fail with the "Please confirm your email address" message.
4. Sign out, then sign back in.
5. Request a magic link and complete sign-in through it (click the emailed
   link — there is no code to enter).
6. Subscribe to a section, then confirm it appears in the dashboard. This is
   the check that catches a `SUBSCRIPTION_URL` missing its `/v2` suffix.
7. **Subscription continuity check:** pick an email that already has rows in
   `section_subscriptions`, register a *new* account with that same email,
   and confirm the existing subscriptions appear. This is expected to work
   with no data migration step — this check proves the email-keyed lookup
   still functions after cutover, not that migration ran.

## Production cutover
1. Confirm `AUTH_UPSTREAM_URL` and a `/v2`-suffixed `SUBSCRIPTION_URL` are
   set in Vercel and `BETTER_AUTH_SECRET` / `AUTH_DATABASE_URL` are set in
   Railway, ahead of the deploy (see Preconditions — these are hard failures,
   not warnings).
2. Apply the schema migration to production Postgres.
3. Deploy the API, then the frontend.
4. Smoke test: sign up, confirm the emailed link arrives and works, sign out,
   sign in, magic link, subscribe, view dashboard.
5. Announce that existing users need to register again. Anyone re-registering
   with their original email automatically regains their notification
   subscriptions (see "No data migration" above) — no action needed from
   them beyond re-registering.

## Rollback
- Redeploy the previous API and frontend images. The better-auth tables are
  additive, so nothing needs to be undone in the database.
- Supabase has already been fully removed from the frontend (dependencies
  uninstalled, `lib/supabase/` and `AUTH_README.md` deleted) as of this
  task, so rollback means reverting to the pre-cutover frontend/API build
  artifacts (e.g. the previous Vercel/Railway deployment), not repointing
  environment variables on the current build.
- Keep the old Supabase project alive until sign-up and sign-in are confirmed
  healthy in production, then delete it.
