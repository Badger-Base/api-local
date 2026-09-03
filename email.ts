/**
 * Outbound mail for BadgerBase.
 *
 * Submits over Mox's HTTP/JSON API on 443 rather than SMTP. Railway's egress
 * cannot open a TCP connection to any submission port on the mail host —
 * 465 and 2525 both time out from there, while Vercel, GitHub Actions and
 * ordinary clients reach 2525 fine — so SMTP is simply not available to this
 * service. 443 is.
 *
 * Two things about Mox's API that are not guessable from the endpoint:
 *   - the JSON goes in a form field named `request`, not as a JSON body
 *   - `From` is an array of addresses, not a single object
 */

const DEFAULT_FROM = "notifications@badgerbase.app";
const DEFAULT_API_URL = "https://mail.badgerbase.app/webapi/v0/Send";

export function emailFrom(): string {
  return Bun.env.SMTP_FROM || DEFAULT_FROM;
}

function apiUrl(): string {
  return Bun.env.MAIL_API_URL || DEFAULT_API_URL;
}

export function isEmailConfigured(): boolean {
  return Boolean(Bun.env.SMTP_USER && Bun.env.SMTP_PASS);
}

/**
 * The one place this app sends mail. auth.ts's magic-link and verification
 * callbacks and the subscription routes all go through here, so changing
 * transport or provider is a change to this file alone.
 *
 * That matters: when ElasticEmail was swapped for SMTP, the two callbacks in
 * auth.ts were missed — they live in an auth file and do not read as email
 * code — and the API stopped booting.
 */
export async function sendEmail(
  to: string,
  subject: string,
  htmlBody: string
): Promise<void> {
  // Never reach the network from the test suite.
  if (process.env.NODE_ENV === "test") return;

  if (!isEmailConfigured()) {
    throw new Error("email is not configured: SMTP_USER/SMTP_PASS are unset");
  }

  const request = JSON.stringify({
    From: [{ Name: "BadgerBase", Address: emailFrom() }],
    To: [{ Address: to }],
    Subject: subject,
    HTML: htmlBody,
  });

  const auth = Buffer.from(
    `${Bun.env.SMTP_USER}:${Bun.env.SMTP_PASS}`
  ).toString("base64");

  // Bounded so a slow mail host degrades sign-up instead of blocking it.
  const res = await fetch(apiUrl(), {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ request }),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    // Mox returns {"Code":...,"Message":...} on failure. Surface both; the
    // caller logs them, and they are the difference between a bad password
    // and a malformed request.
    const detail = await res.text().catch(() => "");
    throw new Error(
      `mail api ${res.status}: ${detail.slice(0, 200) || res.statusText}`
    );
  }
}
