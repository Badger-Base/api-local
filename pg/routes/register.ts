import { Hono } from "hono";
import { apiKeyAuth } from "../../middleware.ts";
import { auth } from "../../auth.ts";
import pg from "pg";

interface RegisterAppDeps {
  /** Connection string for the database holding better-auth's tables. */
  databaseUrl: string;
  apiKey: string;
}

export type RegisterOutcome =
  | "CREATED"
  | "VERIFICATION_RESENT"
  | "ACCOUNT_EXISTS";

/**
 * Sign-up that tells the user what actually happened.
 *
 * better-auth's own /sign-up/email is deliberately non-enumerable: for an
 * address that already exists it returns a fabricated user object — fresh id,
 * emailVerified false — writes nothing, and sends nothing. That is sound
 * anti-enumeration design, but it strands people. Someone whose verification
 * email is lost re-registers, is told "check your email", and no email is
 * ever sent. They cannot get in and cannot find out why.
 *
 * We accept the enumeration trade knowingly. Sign-in already leaks it for
 * unverified accounts (EMAIL_NOT_VERIFIED vs INVALID_EMAIL_OR_PASSWORD), what
 * sits behind an account is a course-notification list, and UW addresses are
 * guessable anyway. Being able to recover an account on-screen is worth more
 * here than hiding whether one exists — particularly since the alternative
 * routes every recovery through email, which is the least reliable part of
 * this stack.
 */
export function createRegisterApp({ databaseUrl, apiKey }: RegisterAppDeps) {
  const app = new Hono();
  const pool = new pg.Pool({ connectionString: databaseUrl });

  app.use("/api/*", apiKeyAuth(apiKey));

  app.post("/api/register", async (c) => {
    let body: {
      email?: string;
      password?: string;
      name?: string;
      callbackURL?: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const email = body.email?.trim().toLowerCase();
    if (!email || !body.password || !body.name) {
      return c.json({ error: "email, password and name are required" }, 400);
    }

    try {
      const existing = await pool.query<{ emailVerified: boolean }>(
        'SELECT "emailVerified" FROM "user" WHERE lower(email) = $1 LIMIT 1',
        [email]
      );

      if (existing.rowCount && existing.rows[0].emailVerified) {
        return c.json(
          { outcome: "ACCOUNT_EXISTS" satisfies RegisterOutcome },
          409
        );
      }

      if (existing.rowCount) {
        // Exists but unverified: the case that stranded people. Send a fresh
        // link rather than silently doing nothing.
        await auth.api.sendVerificationEmail({
          body: { email, callbackURL: body.callbackURL },
        });
        return c.json({
          outcome: "VERIFICATION_RESENT" satisfies RegisterOutcome,
        });
      }

      await auth.api.signUpEmail({
        body: {
          email,
          password: body.password,
          name: body.name,
          // Where the emailed link lands after verifying. Passed through from
          // the frontend so it can show a confirmation rather than dropping
          // the user on the home page with no indication anything happened.
          callbackURL: body.callbackURL,
        },
        asResponse: false,
      });
      return c.json({ outcome: "CREATED" satisfies RegisterOutcome });
    } catch (err) {
      const e = err as { body?: { code?: string }; message?: string };
      // better-auth rejects weak passwords and malformed addresses; surface
      // those to the user rather than turning them into a 500.
      const code = e?.body?.code;
      if (code) {
        return c.json({ error: e.body?.code, message: e.message }, 400);
      }
      console.error("[register] failed:", e?.message ?? err);
      return c.json({ error: "Registration failed" }, 500);
    }
  });

  return app;
}
