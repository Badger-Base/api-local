import { Hono, type Context } from "hono";
import type { Kysely } from "kysely";
import type { Database } from "../types.ts";
import { apiKeyAuth } from "../../middleware.ts";
import { betterAuthJwt } from "../../auth-middleware.ts";

interface PgSubscriptionDeps {
  db: Kysely<Database>;
  jwksUrl: string;
  subscriptionApiKey: string;
  sendEmail?: (to: string, subject: string, htmlBody: string) => Promise<void>;
  fromEmail?: string;
}

export function createPgSubscriptionApp({
  db,
  jwksUrl,
  subscriptionApiKey,
  sendEmail,
  fromEmail,
}: PgSubscriptionDeps) {
  const app = new Hono();

  for (const path of [
    "/course-subscription",
    "/section-subscription",
    "/subscriptions",
  ]) {
    app.use(path, apiKeyAuth(subscriptionApiKey));
    app.use(path, betterAuthJwt(jwksUrl));
  }

  function getAuth(c: Context) {
    const jwtPayload = c.get("jwtPayload") as any;
    if (!jwtPayload?.sub) return null;
    return { userId: jwtPayload.sub as string, jwtPayload };
  }

  // ─── Course Subscriptions ───────────────────────────────────────

  app.post("/course-subscription", async (c) => {
    const auth = getAuth(c);
    if (!auth) return c.json({ error: "Invalid token: missing user ID" }, 401);

    const { course_id, email, course_title } = await c.req.json();
    if (!course_id) return c.json({ error: "course_id is required" }, 400);

    if (email && auth.jwtPayload.email && email !== auth.jwtPayload.email) {
      return c.json({ error: "Email mismatch" }, 401);
    }

    try {
      const course = await db
        .selectFrom("courses")
        .select("id")
        .where("course_id", "=", String(course_id))
        .executeTakeFirst();

      if (!course) return c.json({ error: "Course not found" }, 404);

      const result = await db
        .insertInto("course_subscriptions")
        .values({ email, course_id: course.id })
        .onConflict((oc) => oc.columns(["email", "course_id"]).doNothing())
        .executeTakeFirst();

      if (!result?.numInsertedOrUpdatedRows) {
        return c.json({ message: "Subscription already exists" }, 200);
      }

      if (sendEmail && fromEmail && course_title) {
        try {
          await sendEmail(
            email,
            `Subscription Confirmed: ${course_title}`,
            buildCourseEmailHtml(course_title),
          );
        } catch (emailError: any) {
          console.error(
            "Failed to send course confirmation email:",
            emailError?.message || emailError,
          );
        }
      }

      return c.json({ message: "Subscription created successfully" }, 201);
    } catch (error) {
      console.error("Database error:", error);
      return c.json({ error: "Failed to create subscription" }, 500);
    }
  });

  app.delete("/course-subscription", async (c) => {
    const auth = getAuth(c);
    if (!auth) return c.json({ error: "Invalid token: missing user ID" }, 401);

    const { course_id, email } = await c.req.json();
    if (!course_id) return c.json({ error: "course_id is required" }, 400);
    if (!email) return c.json({ error: "email is required" }, 400);

    try {
      const course = await db
        .selectFrom("courses")
        .select("id")
        .where("course_id", "=", String(course_id))
        .executeTakeFirst();

      if (!course) return c.json({ error: "Course not found" }, 404);

      const result = await db
        .deleteFrom("course_subscriptions")
        .where("email", "=", email)
        .where("course_id", "=", course.id)
        .executeTakeFirst();

      if (!result.numDeletedRows) {
        return c.json({ error: "Subscription not found" }, 404);
      }

      return c.json({ message: "Subscription deleted successfully" }, 200);
    } catch (error) {
      console.error("Database error:", error);
      return c.json({ error: "Failed to delete subscription" }, 500);
    }
  });

  // ─── Section Subscriptions ──────────────────────────────────────

  app.post("/section-subscription", async (c) => {
    const auth = getAuth(c);
    if (!auth) return c.json({ error: "Invalid token: missing user ID" }, 401);

    const { section_id, course_title, section_names, email } = await c.req.json();
    if (!section_id) return c.json({ error: "section_id is required" }, 400);

    if (email && auth.jwtPayload.email && email !== auth.jwtPayload.email) {
      return c.json({ error: "Email mismatch" }, 401);
    }

    try {
      const section = await db
        .selectFrom("sections")
        .select("id")
        .where("section_id", "=", String(section_id))
        .executeTakeFirst();

      if (!section) return c.json({ error: "Section not found" }, 404);

      const result = await db
        .insertInto("section_subscriptions")
        .values({ email, section_id: section.id })
        .onConflict((oc) => oc.columns(["email", "section_id"]).doNothing())
        .executeTakeFirst();

      if (!result?.numInsertedOrUpdatedRows) {
        return c.json({ message: "Subscription already exists" }, 200);
      }

      if (sendEmail && fromEmail && course_title) {
        try {
          await sendEmail(
            email,
            `Section Subscription Confirmed: ${course_title}`,
            buildSectionEmailHtml(course_title, section_names, String(section_id)),
          );
        } catch (emailError: any) {
          console.error(
            "Failed to send section confirmation email:",
            emailError?.message || emailError,
          );
        }
      }

      return c.json({ message: "Subscription created successfully" }, 201);
    } catch (error) {
      console.error("Database error:", error);
      return c.json({ error: "Failed to create subscription" }, 500);
    }
  });

  app.delete("/section-subscription", async (c) => {
    const auth = getAuth(c);
    if (!auth) return c.json({ error: "Invalid token: missing user ID" }, 401);

    const { section_id, email } = await c.req.json();
    if (!section_id) return c.json({ error: "section_id is required" }, 400);
    if (!email) return c.json({ error: "email is required" }, 400);

    try {
      const section = await db
        .selectFrom("sections")
        .select("id")
        .where("section_id", "=", String(section_id))
        .executeTakeFirst();

      if (!section) return c.json({ error: "Section not found" }, 404);

      const result = await db
        .deleteFrom("section_subscriptions")
        .where("email", "=", email)
        .where("section_id", "=", section.id)
        .executeTakeFirst();

      if (!result.numDeletedRows) {
        return c.json({ error: "Subscription not found" }, 404);
      }

      return c.json({ message: "Subscription deleted successfully" }, 200);
    } catch (error) {
      console.error("Database error:", error);
      return c.json({ error: "Failed to delete subscription" }, 500);
    }
  });

  // ─── List Subscriptions ─────────────────────────────────────────

  app.get("/subscriptions", async (c) => {
    const auth = getAuth(c);
    if (!auth) return c.json({ error: "Invalid token: missing user ID" }, 401);

    const email = c.req.query("email");
    if (!email)
      return c.json({ error: "email query parameter is required" }, 400);

    try {
      const courseSubscriptions = await db
        .selectFrom("course_subscriptions")
        .innerJoin("courses", "courses.id", "course_subscriptions.course_id")
        .select([
          "course_subscriptions.id as subscription_id",
          "course_subscriptions.email",
          "courses.course_id",
          "courses.course_title",
          "courses.course_designation",
          "courses.full_course_designation",
          "courses.course_uuid",
        ])
        .where("course_subscriptions.email", "=", email)
        .orderBy("courses.course_title")
        .execute();

      const sectionRows = await db
        .selectFrom("section_subscriptions")
        .innerJoin(
          "sections",
          "sections.id",
          "section_subscriptions.section_id",
        )
        .innerJoin("courses", "courses.id", "sections.course_ref")
        .leftJoin(
          "section_meetings",
          "section_meetings.section_id",
          "sections.id",
        )
        .select([
          "section_subscriptions.id as subscription_id",
          "section_subscriptions.email",
          "sections.section_id",
          "sections.section_uuid",
          "sections.status as section_status",
          "sections.available_seats",
          "sections.instruction_mode",
          "courses.course_title",
          "courses.course_designation",
          "courses.full_course_designation",
          "courses.course_uuid",
          "section_meetings.section_number",
          "section_meetings.meeting_type",
        ])
        .where("section_subscriptions.email", "=", email)
        .orderBy("courses.course_title")
        .orderBy("section_meetings.meeting_number")
        .execute();

      const grouped: Record<string, any> = {};
      for (const row of sectionRows) {
        const key = String(row.subscription_id);
        if (!grouped[key]) {
          grouped[key] = {
            subscription_id: row.subscription_id,
            email: row.email,
            section_id: row.section_id,
            unique_section_id: row.section_uuid,
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
          if (
            !grouped[key].meetings.some((m: any) => m.label === meetingLabel)
          ) {
            grouped[key].meetings.push({
              label: meetingLabel,
              section_number: row.section_number,
              meeting_type: row.meeting_type,
            });
          }
        }
      }

      return c.json(
        {
          course_subscriptions: courseSubscriptions,
          section_subscriptions: Object.values(grouped),
        },
        200,
      );
    } catch (error) {
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
  sectionId: string,
): string {
  let sectionsDisplay = "your selected section";
  let sectionLabel = "Section";

  if (
    sectionNames &&
    Array.isArray(sectionNames) &&
    sectionNames.length > 0
  ) {
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
