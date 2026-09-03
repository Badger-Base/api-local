import nodemailer from "nodemailer";

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: Bun.env.SMTP_HOST,
      port: parseInt(Bun.env.SMTP_PORT || "2525"),
      secure: true,
      auth: {
        user: Bun.env.SMTP_USER,
        pass: Bun.env.SMTP_PASS,
      },
      // Fail fast. nodemailer defaults to a two-minute connection timeout,
      // and better-auth's sendVerificationEmail did not reliably run in the
      // background under Bun — so an unreachable mail server held the whole
      // sign-up request open until the frontend proxy gave up at 10s and
      // returned 502. The account was created; the user just saw a failure.
      // Five seconds is far longer than a healthy send and well under that
      // 10s budget, so a broken mail server degrades sign-up instead of
      // breaking it.
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 10000,
    });
  }
  return transporter;
}

const DEFAULT_FROM = "notifications@badgerbase.app";

export function emailFrom(): string {
  return Bun.env.SMTP_FROM || DEFAULT_FROM;
}

export function isEmailConfigured(): boolean {
  return Boolean(Bun.env.SMTP_HOST);
}

/**
 * The one place this app sends mail. auth.ts's magic-link and verification
 * callbacks and the subscription routes all go through here, so changing
 * providers is a change to this file alone.
 *
 * This exists because it was learned the hard way: when ElasticEmail was
 * swapped for SMTP, the two callbacks in auth.ts were missed — they live in
 * an auth file and do not read as email code — and the API failed to boot
 * with "Export named 'elasticEmailSender' not found".
 */
export async function sendEmail(
  to: string,
  subject: string,
  htmlBody: string
): Promise<void> {
  // Never open a real SMTP connection from the test suite. Bun sets
  // NODE_ENV=test, and without this guard every auth test that triggers a
  // magic link or a verification email dials the production mail server and
  // hangs until the test times out — which is exactly what happened once
  // SMTP_HOST appeared in .env.
  if (process.env.NODE_ENV === "test") {
    return;
  }
  if (!isEmailConfigured()) {
    throw new Error("email is not configured: SMTP_HOST is unset");
  }
  await getTransporter().sendMail({
    from: emailFrom(),
    to,
    subject,
    html: htmlBody,
  });
}
