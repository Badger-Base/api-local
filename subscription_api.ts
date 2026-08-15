import { Hono, Context } from "hono";
import { cors } from "hono/cors";
import { jwt } from "hono/jwt";
import mysql from "mysql2/promise";

const ALLOWED_ORIGINS = [
  "https://sconniegrades.com",
  "https://www.sconniegrades.com",
  "https://badgerbase.app",
  "https://www.badgerbase.app",
  "http://localhost:3000",
  "http://localhost:3001",
];

interface AuthData {
  userId: string;
  jwtPayload: any;
}

interface SubscriptionAppDeps {
  pool: any;
  jwtSecret: string;
  subscriptionApiKey: string;
  sendEmail?: (to: string, subject: string, htmlBody: string) => Promise<void>;
  fromEmail?: string;
}

export function createSubscriptionApp({
  pool,
  jwtSecret,
  subscriptionApiKey,
  sendEmail,
  fromEmail,
}: SubscriptionAppDeps) {
  const app = new Hono();

  app.use(
    "/*",
    cors({
      origin: ALLOWED_ORIGINS,
      credentials: true,
    })
  );

  function validateAuth(c: Context): Response | AuthData {
    const apiKey = c.req.header("X-API-Key");
    if (!apiKey || apiKey !== subscriptionApiKey) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const jwtPayload = c.get("jwtPayload") as any;
    if (!jwtPayload) {
      return c.json({ error: "Invalid token: no payload found" }, 401);
    }

    const userId = jwtPayload.sub;
    if (!userId) {
      return c.json({ error: "Invalid token: missing user ID" }, 401);
    }

    return { userId, jwtPayload };
  }

  app.use(
    "/course-subscription",
    jwt({ secret: jwtSecret })
  );

  app.use(
    "/section-subscription",
    jwt({ secret: jwtSecret })
  );

  app.use(
    "/subscriptions",
    jwt({ secret: jwtSecret })
  );

  // ─── Course Subscriptions ───────────────────────────────────────

  app.post("/course-subscription", async (c) => {
    const authResult = validateAuth(c);
    if (authResult instanceof Response) return authResult;
    const { jwtPayload } = authResult;

    const { course_id, email, course_title } = await c.req.json();

    if (!course_id) {
      return c.json({ error: "course_id is required" }, 400);
    }

    if (email && jwtPayload.email && email !== jwtPayload.email) {
      return c.json({ error: "Email mismatch" }, 401);
    }

    try {
      const [existingSubscriptions] = (await pool.execute(
        "SELECT * FROM course_subscriptions WHERE email = ? AND course_id = ?",
        [email, course_id]
      )) as [any[], any];

      if (existingSubscriptions.length > 0) {
        return c.json({ message: "Subscription already exists" }, 200);
      }

      await pool.execute(
        "INSERT INTO course_subscriptions (email, course_id) VALUES (?, ?)",
        [email, course_id]
      );

      if (sendEmail && fromEmail && course_title) {
        try {
          const htmlBody = buildCourseEmailHtml(course_title);
          await sendEmail(email, `Subscription Confirmed: ${course_title}`, htmlBody);
        } catch (emailError: any) {
          console.error("Failed to send course confirmation email:", emailError?.message || emailError);
        }
      }

      return c.json({ message: "Subscription created successfully" }, 201);
    } catch (error: any) {
      console.error("Database error:", error);
      return c.json({ error: "Failed to create subscription" }, 500);
    }
  });

  app.delete("/course-subscription", async (c) => {
    const authResult = validateAuth(c);
    if (authResult instanceof Response) return authResult;

    const { course_id, email } = await c.req.json();

    if (!course_id) {
      return c.json({ error: "course_id is required" }, 400);
    }
    if (!email) {
      return c.json({ error: "email is required" }, 400);
    }

    try {
      const [existingSubscriptions] = (await pool.execute(
        "SELECT * FROM course_subscriptions WHERE email = ? AND course_id = ?",
        [email, course_id]
      )) as [any[], any];

      if (existingSubscriptions.length === 0) {
        return c.json({ error: "Subscription not found" }, 404);
      }

      await pool.execute(
        "DELETE FROM course_subscriptions WHERE email = ? AND course_id = ?",
        [email, course_id]
      );

      return c.json({ message: "Subscription deleted successfully" }, 200);
    } catch (error: any) {
      console.error("Database error:", error);
      return c.json({ error: "Failed to delete subscription" }, 500);
    }
  });

  // ─── Section Subscriptions ──────────────────────────────────────

  app.post("/section-subscription", async (c) => {
    const authResult = validateAuth(c);
    if (authResult instanceof Response) return authResult;
    const { jwtPayload } = authResult;

    const { section_id, course_title, section_names, email } = await c.req.json();

    if (!section_id) {
      return c.json({ error: "section_id is required" }, 400);
    }

    if (email && jwtPayload.email && email !== jwtPayload.email) {
      return c.json({ error: "Email mismatch" }, 401);
    }

    try {
      const [existingSubscriptions] = (await pool.execute(
        "SELECT * FROM section_subscriptions WHERE email = ? AND section_id = ?",
        [email, section_id]
      )) as [any[], any];

      if (existingSubscriptions.length > 0) {
        return c.json({ message: "Subscription already exists" }, 200);
      }

      await pool.execute(
        "INSERT INTO section_subscriptions (email, section_id) VALUES (?, ?)",
        [email, section_id]
      );

      if (sendEmail && fromEmail && course_title) {
        try {
          const htmlBody = buildSectionEmailHtml(course_title, section_names, section_id);
          await sendEmail(email, `Section Subscription Confirmed: ${course_title}`, htmlBody);
        } catch (emailError: any) {
          console.error("Failed to send section confirmation email:", emailError?.message || emailError);
        }
      }

      return c.json({ message: "Subscription created successfully" }, 201);
    } catch (error: any) {
      console.error("Database error:", error);
      return c.json({ error: "Failed to create subscription" }, 500);
    }
  });

  app.delete("/section-subscription", async (c) => {
    const authResult = validateAuth(c);
    if (authResult instanceof Response) return authResult;

    const { section_id, email } = await c.req.json();

    if (!section_id) {
      return c.json({ error: "section_id is required" }, 400);
    }
    if (!email) {
      return c.json({ error: "email is required" }, 400);
    }

    try {
      const [existingSubscriptions] = (await pool.execute(
        "SELECT * FROM section_subscriptions WHERE email = ? AND section_id = ?",
        [email, section_id]
      )) as [any[], any];

      if (existingSubscriptions.length === 0) {
        return c.json({ error: "Subscription not found" }, 404);
      }

      await pool.execute(
        "DELETE FROM section_subscriptions WHERE email = ? AND section_id = ?",
        [email, section_id]
      );

      return c.json({ message: "Subscription deleted successfully" }, 200);
    } catch (error: any) {
      console.error("Database error:", error);
      return c.json({ error: "Failed to delete subscription" }, 500);
    }
  });

  // ─── List Subscriptions ─────────────────────────────────────────

  app.get("/subscriptions", async (c) => {
    const authResult = validateAuth(c);
    if (authResult instanceof Response) return authResult;

    const email = c.req.query("email");

    if (!email) {
      return c.json({ error: "email query parameter is required" }, 400);
    }

    try {
      const [courseSubscriptions] = (await pool.execute(
        `SELECT
          course_subscriptions.id as subscription_id,
          course_subscriptions.email,
          course_subscriptions.course_id,
          courses.course_title,
          courses.course_designation,
          courses.full_course_designation,
          courses.course_uuid
        FROM course_subscriptions
        JOIN courses ON course_subscriptions.course_id = courses.course_id
        WHERE course_subscriptions.email = ?
        ORDER BY courses.course_title`,
        [email]
      )) as [any[], any];

      const [sectionSubscriptions] = (await pool.execute(
        `SELECT
          section_subscriptions.id as subscription_id,
          section_subscriptions.email,
          section_subscriptions.section_id,
          sections.unique_section_id,
          sections.status as section_status,
          sections.available_seats,
          sections.instruction_mode,
          courses.course_title,
          courses.course_designation,
          courses.full_course_designation,
          courses.course_uuid,
          section_meetings.section_number,
          section_meetings.meeting_type
        FROM section_subscriptions
        JOIN sections ON section_subscriptions.section_id = sections.section_id
        JOIN courses ON sections.course_uuid = courses.course_uuid
        LEFT JOIN section_meetings ON sections.unique_section_id = section_meetings.unique_section_id
        WHERE section_subscriptions.email = ?
        ORDER BY courses.course_title, section_meetings.meeting_number`,
        [email]
      )) as [any[], any];

      const groupedSectionSubscriptions = sectionSubscriptions.reduce((acc: any, row: any) => {
        const key = row.subscription_id;

        if (!acc[key]) {
          acc[key] = {
            subscription_id: row.subscription_id,
            email: row.email,
            section_id: row.section_id,
            unique_section_id: row.unique_section_id,
            section_status: row.section_status,
            available_seats: row.available_seats,
            instruction_mode: row.instruction_mode,
            course_title: row.course_title,
            course_designation: row.course_designation,
            full_course_designation: row.full_course_designation,
            course_uuid: row.course_uuid,
            meetings: [],
          };
        }

        if (row.section_number && row.meeting_type) {
          const meetingLabel = `${row.meeting_type} ${row.section_number}`;
          const meetingExists = acc[key].meetings.some((m: any) => m.label === meetingLabel);

          if (!meetingExists) {
            acc[key].meetings.push({
              label: meetingLabel,
              section_number: row.section_number,
              meeting_type: row.meeting_type,
            });
          }
        }

        return acc;
      }, {});

      return c.json(
        {
          course_subscriptions: courseSubscriptions,
          section_subscriptions: Object.values(groupedSectionSubscriptions),
        },
        200
      );
    } catch (error: any) {
      console.error("Database error:", error);
      return c.json({ error: "Failed to fetch subscriptions" }, 500);
    }
  });

  return app;
}

// ─── Email Templates ──────────────────────────────────────────────

function buildCourseEmailHtml(courseTitle: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background-color: #C5050C; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0;">
      <h1>Subscription Confirmed</h1>
    </div>
    <div style="background-color: #f9f9f9; padding: 30px; border-radius: 0 0 5px 5px;">
      <p>Hello,</p>
      <p>You've successfully subscribed to receive notifications for:</p>
      <div style="background-color: white; padding: 20px; margin: 20px 0; border-left: 4px solid #C5050C;">
        <h2>${courseTitle}</h2>
      </div>
      <p>You'll receive email notifications when this course has new openings or changes to availability.</p>
      <p>Thank you for using BadgerBase!</p>
    </div>
    <div style="text-align: center; margin-top: 20px; color: #666; font-size: 12px;">
      <p>This is an automated message. Please do not reply to this email.</p>
    </div>
  </div>
</body>
</html>`;
}

function buildSectionEmailHtml(
  courseTitle: string,
  sectionNames: string[] | undefined,
  sectionId: string
): string {
  let sectionsDisplay = "your selected section";
  let sectionLabel = "Section";

  if (sectionNames && Array.isArray(sectionNames) && sectionNames.length > 0) {
    sectionsDisplay = sectionNames.join(", ");
    sectionLabel = sectionNames.length > 1 ? "Sections" : "Section";
  } else if (sectionId) {
    sectionsDisplay = `Section ID: ${sectionId}`;
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background-color: #C5050C; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0;">
      <h1>Section Subscription Confirmed</h1>
    </div>
    <div style="background-color: #f9f9f9; padding: 30px; border-radius: 0 0 5px 5px;">
      <p>Hello,</p>
      <p>You've successfully subscribed to receive notifications for:</p>
      <div style="background-color: white; padding: 20px; margin: 20px 0; border-left: 4px solid #C5050C;">
        <h2>${courseTitle}</h2>
        <p><strong>${sectionLabel}:</strong> ${sectionsDisplay}</p>
      </div>
      <p>You'll receive email notifications when this section has new openings or changes to availability.</p>
      <p>Thank you for using BadgerBase!</p>
    </div>
    <div style="text-align: center; margin-top: 20px; color: #666; font-size: 12px;">
      <p>This is an automated message. Please do not reply to this email.</p>
    </div>
  </div>
</body>
</html>`;
}

// ─── ElasticEmail sender ──────────────────────────────────────────

async function elasticEmailSender(
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

// ─── Production startup ───────────────────────────────────────────

if (import.meta.main) {
  const supabaseJwtSecret = Bun.env.SUPABASE_JWT_SECRET;
  if (!supabaseJwtSecret) {
    console.error("SUPABASE_JWT_SECRET is not set");
    process.exit(1);
  }

  const pool = mysql.createPool({
    uri: Bun.env.MYSQL_URL,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });

  const emailFromAddr = Bun.env.FROM_EMAIL || Bun.env.SES_FROM_EMAIL;
  const elasticApiKey = Bun.env.ELASTICEMAIL_API_KEY;

  const emailSender =
    emailFromAddr && elasticApiKey
      ? (to: string, subject: string, html: string) =>
          elasticEmailSender(emailFromAddr, elasticApiKey, to, subject, html)
      : undefined;

  const app = createSubscriptionApp({
    pool,
    jwtSecret: supabaseJwtSecret,
    subscriptionApiKey: Bun.env.SUBSCRIPTION_API_KEY || "",
    sendEmail: emailSender,
    fromEmail: emailFromAddr,
  });

  const port = parseInt(Bun.env.PORT || "3000");
  Bun.serve({ port, fetch: app.fetch });
  console.log(`Subscription API running on port ${port}`);

  process.on("SIGINT", async () => {
    await pool.end();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await pool.end();
    process.exit(0);
  });
}
