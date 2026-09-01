import nodemailer from "nodemailer";

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: Bun.env.SMTP_HOST,
      port: parseInt(Bun.env.SMTP_PORT || "465"),
      secure: true,
      auth: {
        user: Bun.env.SMTP_USER,
        pass: Bun.env.SMTP_PASS,
      },
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
