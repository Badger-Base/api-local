import { Hono, Context } from "hono";
import { cors } from "hono/cors";
import { jwt } from "hono/jwt";
import mysql from "mysql2/promise";
// import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const app = new Hono();

// CORS configuration - allow all frontend origins
// These match the allowed origins in the Next.js proxy route
const ALLOWED_ORIGINS = [
  "https://sconniegrades.com",
  "https://www.sconniegrades.com",
  "https://badgerbase.app",
  "https://www.badgerbase.app",
  "http://localhost:3000", // for local dev
  "http://localhost:3001", // for local dev
];

// SES Client (commented out - now using ElasticEmail)
// const sesClient = new SESClient({
//   region: Bun.env.AWS_REGION || "us-east-2",
//   credentials: {
//     accessKeyId: Bun.env.AWS_ACCESS_KEY_ID!,
//     secretAccessKey: Bun.env.AWS_SECRET_ACCESS_KEY!,
//   },
// });

// ElasticEmail configuration
const ELASTICEMAIL_API_KEY = Bun.env.ELASTICEMAIL_API_KEY;
const FROM_EMAIL = Bun.env.FROM_EMAIL || Bun.env.SES_FROM_EMAIL; // Support both env vars for backward compatibility



// Email helper function using ElasticEmail
async function sendEmail(
  to: string,
  subject: string,
  htmlBody: string
): Promise<void> {
  if (!FROM_EMAIL) {
    throw new Error("FROM_EMAIL not configured");
  }

  if (!ELASTICEMAIL_API_KEY) {
    throw new Error("ELASTICEMAIL_API_KEY not configured");
  }

  // Create form data for ElasticEmail API
  const formData = new URLSearchParams();
  formData.append('apikey', ELASTICEMAIL_API_KEY);
  formData.append('from', FROM_EMAIL);
  formData.append('to', to);
  formData.append('subject', subject);
  formData.append('bodyHtml', htmlBody);
  formData.append('isTransactional', 'true');

  try {
    const response = await fetch('https://api.elasticemail.com/v2/email/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ElasticEmail API error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    console.log(`Email sent successfully to ${to}`, result);
  } catch (error) {
    console.error("Error sending email:", error);
    throw error;
  }
}

// SES Email function (commented out - now using ElasticEmail)
// async function sendEmail(
//   to: string,
//   subject: string,
//   htmlBody: string
// ): Promise<void> {
//   if (!FROM_EMAIL) {
//     throw new Error("SES_FROM_EMAIL not configured");
//   }
//
//   const command = new SendEmailCommand({
//     Source: FROM_EMAIL,
//     Destination: {
//       ToAddresses: [to],
//     },
//     Message: {
//       Subject: {
//         Data: subject,
//         Charset: "UTF-8",
//       },
//       Body: {
//         Html: {
//           Data: htmlBody,
//           Charset: "UTF-8",
//         },
//       },
//     },
//   });
//
//   try {
//     await sesClient.send(command);
//     console.log(`Email sent successfully to ${to}`);
//   } catch (error) {
//     console.error("Error sending email:", error);
//     throw error;
//   }
// }



app.use(
  "/*",
  cors({
    origin: ALLOWED_ORIGINS,
    credentials: true,
  })
);

// Get the Supabase JWT Secret from environment variables
// IMPORTANT: This is the JWT_SECRET from Supabase, NOT the anon key
// You can find this in your Supabase dashboard: Settings > API > JWT Secret
const supabaseJwtSecret = Bun.env.SUPABASE_JWT_SECRET;

if (!supabaseJwtSecret) {
  console.error("ERROR: SUPABASE_JWT_SECRET environment variable is not set!");
  console.error("Please set it in your Railway environment variables.");
  process.exit(1);
}

// MySQL connection pool configuration
// Get database credentials from environment variables
const pool = mysql.createPool({
  uri: Bun.env.MYSQL_URL,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Test the database connection
pool
  .getConnection()
  .then((connection) => {
    console.log("Connected to MySQL database");
    connection.release();
  })
  .catch((error) => {
    console.error("Error connecting to MySQL database:", error);
    process.exit(1);
  });

// Authentication helper function
// Validates API key and JWT token, returns either an error response or auth data
interface AuthData {
  userId: string;
  jwtPayload: any;
}

function validateAuth(c: Context): Response | AuthData {
  // Check API key
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || apiKey !== Bun.env.SUBSCRIPTION_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Get and validate JWT payload
  const jwtPayload = c.get("jwtPayload") as any;
  if (!jwtPayload) {
    return c.json({ error: "Invalid token: no payload found" }, 401);
  }

  // Extract and validate user ID
  const userId = jwtPayload.sub;
  if (!userId) {
    return c.json({ error: "Invalid token: missing user ID" }, 401);
  }

  return { userId, jwtPayload };
}

// JWT middleware for Supabase token verification
// This middleware will:
// 1. Extract the Bearer token from the Authorization header
// 2. Verify the token signature using the Supabase JWT secret
// 3. Check token expiration
// 4. Make the token payload available in c.get('jwtPayload')
//
// Note: By default, the JWT middleware reads from the Authorization header
// in the format: Authorization: Bearer <token>
app.use(
  "/course-subscription",
  jwt({
    secret: supabaseJwtSecret,
  })
);

app.use(
  "/section-subscription",
  jwt({
    secret: supabaseJwtSecret,
  })
);

app.use(
  "/subscriptions",
  jwt({
    secret: supabaseJwtSecret,
  })
    
);


app.post("/course-subscription", async (c) => {
  // Validate authentication
  const authResult = validateAuth(c);
  if (authResult instanceof Response) {
    return authResult;
  }
  const { userId, jwtPayload } = authResult;

  console.log(jwtPayload);

  // Get course_id, email, and course details from request body
  const { course_id, email, course_title } = await c.req.json();

  if (!course_id) {
    return c.json({ error: "course_id is required" }, 400);
  }

  // Optional: Validate that the email in the body matches the email in the token
  // This provides an extra layer of security
  if (email && jwtPayload.email && email !== jwtPayload.email) {
    return c.json({ error: "Email mismatch" }, 401);
  }

  try {
    // Check for existing subscription
    const [existingSubscriptions] = (await pool.execute(
      "SELECT * FROM course_subscriptions WHERE email = ? AND course_id = ?",
      [email, course_id]
    )) as [any[], any];

    if (existingSubscriptions.length > 0) {
      return c.json({ message: "Subscription already exists" }, 200);
    }

    // Create new subscription
    await pool.execute(
      "INSERT INTO course_subscriptions (email, course_id) VALUES (?, ?)",
      [email, course_id]
    );

    // Send confirmation email
    console.log('[COURSE EMAIL] Checking email conditions:', {
      FROM_EMAIL: !!FROM_EMAIL,
      course_title: !!course_title,
      email: email
    });
    
    if (FROM_EMAIL && course_title) {
      console.log('[COURSE EMAIL] Attempting to send email to:', email);
      try {
        const htmlBody = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background-color: #C5050C; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
    .content { background-color: #f9f9f9; padding: 30px; border-radius: 0 0 5px 5px; }
    .course-info { background-color: white; padding: 20px; margin: 20px 0; border-left: 4px solid #C5050C; }
    .footer { text-align: center; margin-top: 20px; color: #666; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Subscription Confirmed</h1>
    </div>
    <div class="content">
      <p>Hello,</p>
      <p>You've successfully subscribed to receive notifications for:</p>
      <div class="course-info">
        <h2>${course_title}</h2>
      </div>
      <p>You'll receive email notifications when this course has new openings or changes to availability.</p>
      <p>Thank you for using BadgerBase!</p>
    </div>
    <div class="footer">
      <p>This is an automated message. Please do not reply to this email.</p>
    </div>
  </div>
</body>
</html>`;

        await sendEmail(
          email,
          `Subscription Confirmed: ${course_title}`,
          htmlBody
        );
        console.log('[COURSE EMAIL] Email sent successfully to:', email);
      } catch (emailError: any) {
        console.error("[COURSE EMAIL] Failed to send confirmation email:", emailError?.message || emailError);
      }
    } else {
      console.log('[COURSE EMAIL] Email NOT sent - missing required fields');
    }

    return c.json({ message: "Subscription created successfully" }, 201);
  } catch (error: any) {
    console.error("Database error:", error);
    return c.json({ error: "Failed to create subscription" }, 500);
  }
});

app.delete("/course-subscription", async (c) => {
  // Validate authentication
  const authResult = validateAuth(c);
  if (authResult instanceof Response) {
    return authResult;
  }
  const { userId, jwtPayload } = authResult;

  // Get course_id and email from request body
  const { course_id, course_title, email } = await c.req.json();

  if (!course_id) {
    return c.json({ error: "course_id is required" }, 400);
  }

  if (!email) {
    return c.json({ error: "email is required" }, 400);
  }

  try {
    // Check if subscription exists
    const [existingSubscriptions] = (await pool.execute(
      "SELECT * FROM course_subscriptions WHERE email = ? AND course_id = ?",
      [email, course_id]
    )) as [any[], any];

    if (existingSubscriptions.length === 0) {
      return c.json({ error: "Subscription not found" }, 404);
    }


    // Delete the subscription
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

app.post("/section-subscription", async (c) => {
  // Validate authentication
  const authResult = validateAuth(c);
  if (authResult instanceof Response) {
    return authResult;
  }
  const { userId, jwtPayload } = authResult;

  // Get section_id, email, and section details from request body
  const { section_id, course_title, section_names, email } = await c.req.json();

  if (!section_id) {
    return c.json({ error: "section_id is required" }, 400);
  }

  // Optional: Validate that the email in the body matches the email in the token
  // This provides an extra layer of security
  if (email && jwtPayload.email && email !== jwtPayload.email) {
    return c.json({ error: "Email mismatch" }, 401);
  }

  try {
    // Check for existing subscription
    const [existingSubscriptions] = (await pool.execute(
      "SELECT * FROM section_subscriptions WHERE email = ? AND section_id = ?",
      [email, section_id]
    )) as [any[], any];

    if (existingSubscriptions.length > 0) {
      return c.json({ message: "Subscription already exists" }, 200);
    }

    // Create new subscription
    await pool.execute(
      "INSERT INTO section_subscriptions (email, section_id) VALUES (?, ?)",
      [email, section_id]
    );

    // Send confirmation email
    console.log('[SECTION EMAIL] Checking email conditions:', {
      FROM_EMAIL: !!FROM_EMAIL,
      FROM_EMAIL_value: FROM_EMAIL,
      course_title: !!course_title,
      course_title_value: course_title,
      section_names: section_names,
      section_names_isArray: Array.isArray(section_names),
      section_names_length: Array.isArray(section_names) ? section_names.length : 'N/A',
      section_id: section_id,
      email: email
    });
    
    if (FROM_EMAIL && course_title) {
      console.log('[SECTION EMAIL] Sending email to:', email);
      try {
        // Handle section_names - use if available, otherwise show section_id
        let sectionsDisplay = 'your selected section';
        let sectionLabel = 'Section';
        
        if (section_names && Array.isArray(section_names) && section_names.length > 0) {
          sectionsDisplay = section_names.join(', ');
          sectionLabel = section_names.length > 1 ? 'Sections' : 'Section';
        } else if (section_id) {
          sectionsDisplay = `Section ID: ${section_id}`;
        }

        const htmlBody = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background-color: #C5050C; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
    .content { background-color: #f9f9f9; padding: 30px; border-radius: 0 0 5px 5px; }
    .section-info { background-color: white; padding: 20px; margin: 20px 0; border-left: 4px solid #C5050C; }
    .footer { text-align: center; margin-top: 20px; color: #666; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Section Subscription Confirmed</h1>
    </div>
    <div class="content">
      <p>Hello,</p>
      <p>You've successfully subscribed to receive notifications for:</p>
      <div class="section-info">
        <h2>${course_title}</h2>
        <p><strong>${sectionLabel}:</strong> ${sectionsDisplay}</p>
      </div>
      <p>You'll receive email notifications when this section has new openings or changes to availability.</p>
      <p>Thank you for using BadgerBase!</p>
    </div>
    <div class="footer">
      <p>This is an automated message. Please do not reply to this email.</p>
    </div>
  </div>
</body>
</html>`;

        await sendEmail(
          email,
          `Section Subscription Confirmed: ${course_title}`,
          htmlBody
        );
        console.log('[SECTION EMAIL] Email sent successfully to:', email);
      } catch (emailError: any) {
        console.error("[SECTION EMAIL] Failed to send confirmation email:", emailError?.message || emailError);
      }
    } else {
      console.log('[SECTION EMAIL] Email NOT sent - missing FROM_EMAIL or course_title:', {
        hasFromEmail: !!FROM_EMAIL,
        hasCourseTitle: !!course_title
      });
    }

    return c.json({ message: "Subscription created successfully" }, 201);
  } catch (error: any) {
    console.error("Database error:", error);
    return c.json({ error: "Failed to create subscription" }, 500);
  }

 



});

app.delete("/section-subscription", async (c) => {
  // Validate authentication
  const authResult = validateAuth(c);
  if (authResult instanceof Response) {
    return authResult;
  }
  const { userId, jwtPayload } = authResult;

  // Get section_id and email from request body
  const { section_id, course_title, section_names, email } = await c.req.json();

  if (!section_id) {
    return c.json({ error: "section_id is required" }, 400);
  }

  if (!email) {
    return c.json({ error: "email is required" }, 400);
  }

  try {
    // Check if subscription exists
    const [existingSubscriptions] = (await pool.execute(
      "SELECT * FROM section_subscriptions WHERE email = ? AND section_id = ?",
      [email, section_id]
    )) as [any[], any];

    if (existingSubscriptions.length === 0) {
      return c.json({ error: "Subscription not found" }, 404);
    }

    // Delete the subscription
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

app.get("/subscriptions", async (c) => {
  // Validate authentication
  const authResult = validateAuth(c);
  if (authResult instanceof Response) {
    return authResult;
  }
  const { userId: authenticatedUserId, jwtPayload } = authResult;

  // Get email from query parameter
  const email = c.req.query("email");

  if (!email) {
    return c.json({ error: "email query parameter is required" }, 400);
  }

  try {
    // Fetch course subscriptions with course details only
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

    // Fetch section subscriptions with course and specific section details
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


    // Group section subscriptions by subscription_id
    const groupedSectionSubscriptions = sectionSubscriptions.reduce((acc: any, row: any) => {
      const key = row.subscription_id;
      
      if (!acc[key]) {
        acc[key] = {
          subscription_id: row.subscription_id,
          email: row.email,
          section_id: row.section_id,
          created_at: row.created_at,
          unique_section_id: row.unique_section_id,
          section_status: row.section_status,
          available_seats: row.available_seats,
          instruction_mode: row.instruction_mode,
          course_title: row.course_title,
          course_designation: row.course_designation,
          full_course_designation: row.full_course_designation,
          course_uuid: row.course_uuid,
          meetings: []
        };
      }

      // Add meeting if it exists
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

    return c.json({
      course_subscriptions: courseSubscriptions,
      section_subscriptions: Object.values(groupedSectionSubscriptions),
    }, 200);
  } catch (error: any) {
    console.error("Database error:", error);
    return c.json({ error: "Failed to fetch subscriptions" }, 500);
  }
});

// Start the server
const port = parseInt(Bun.env.PORT || "3000");

const server = Bun.serve({
  port: port,
  fetch: app.fetch,
});

console.log(`Server running on port ${port}`);

// Gracefully close the database pool on shutdown
process.on("SIGINT", async () => {
  console.log("Closing database connections...");
  await pool.end();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("Closing database connections...");
  await pool.end();
  process.exit(0);
});