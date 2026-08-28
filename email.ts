/**
 * Transactional email delivery via ElasticEmail.
 *
 * Extracted from subscription_api.ts when the MySQL API was removed — the
 * sender is transport, not MySQL-specific, and server.ts wires it into the
 * Postgres subscription app.
 */
export async function elasticEmailSender(
  fromEmail: string,
  apiKey: string,
  to: string,
  subject: string,
  htmlBody: string
): Promise<void> {
  const formData = new URLSearchParams();
  formData.append("apikey", apiKey);
  formData.append("from", fromEmail);
  formData.append("to", to);
  formData.append("subject", subject);
  formData.append("bodyHtml", htmlBody);
  formData.append("isTransactional", "true");

  const response = await fetch("https://api.elasticemail.com/v2/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ElasticEmail API error: ${response.status} - ${errorText}`);
  }
}
