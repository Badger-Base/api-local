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

export async function smtpSender(
  from: string,
  to: string,
  subject: string,
  htmlBody: string
): Promise<void> {
  await getTransporter().sendMail({
    from,
    to,
    subject,
    html: htmlBody,
  });
}
