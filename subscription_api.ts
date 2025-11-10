import { Hono } from "hono";
import { cors } from "hono/cors";
import { jwt } from "hono/jwt";
import mysql from "mysql2/promise";

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
  // Get the verified JWT payload from the middleware
  // The JWT middleware automatically verifies the token and extracts the payload
  // Hono's JWT middleware stores the payload in c.get('jwtPayload')

  const apiKey = c.req.header("X-API-Key");

  if (!apiKey || apiKey !== Bun.env.SUBSCRIPTION_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const jwtPayload = c.get("jwtPayload") as any;

  console.log(jwtPayload);

  if (!jwtPayload) {
    return c.json({ error: "Invalid token: no payload found" }, 401);
  }

  // Supabase stores the user ID in the 'sub' (subject) field of the JWT
  const userId = jwtPayload.sub;

  if (!userId) {
    return c.json({ error: "Invalid token: missing user ID" }, 401);
  }

  // Get course_id and email from request body
  const { course_id, email } = await c.req.json();

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

    return c.json({ message: "Subscription created successfully" }, 201);
  } catch (error: any) {
    console.error("Database error:", error);
    return c.json({ error: "Failed to create subscription" }, 500);
  }
});

app.delete("/course-subscription", async (c) => {
  const apiKey = c.req.header("X-API-Key");

  if (!apiKey || apiKey !== Bun.env.SUBSCRIPTION_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Get the verified JWT payload from the middleware
  const jwtPayload = c.get("jwtPayload") as any;

  if (!jwtPayload) {
    return c.json({ error: "Invalid token: no payload found" }, 401);
  }

  // Supabase stores the user ID in the 'sub' (subject) field of the JWT
  const userId = jwtPayload.sub;

  if (!userId) {
    return c.json({ error: "Invalid token: missing user ID" }, 401);
  }

  // Get course_id and email from request body
  const { course_id, email } = await c.req.json();

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


  const apiKey = c.req.header("X-API-Key");

  if (!apiKey || apiKey !== Bun.env.SUBSCRIPTION_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Get the verified JWT payload from the middleware
  // The JWT middleware automatically verifies the token and extracts the payload
  // Hono's JWT middleware stores the payload in c.get('jwtPayload')
  const jwtPayload = c.get("jwtPayload") as any;

  if (!jwtPayload) {
    return c.json({ error: "Invalid token: no payload found" }, 401);
  }

  // Supabase stores the user ID in the 'sub' (subject) field of the JWT
  const userId = jwtPayload.sub;

  if (!userId) {
    return c.json({ error: "Invalid token: missing user ID" }, 401);
  }

  // Get section_id and email from request body
  const { section_id, email } = await c.req.json();

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

    return c.json({ message: "Subscription created successfully" }, 201);
  } catch (error: any) {
    console.error("Database error:", error);
    return c.json({ error: "Failed to create subscription" }, 500);
  }
});

app.delete("/section-subscription", async (c) => {
  const apiKey = c.req.header("X-API-Key");

  if (!apiKey || apiKey !== Bun.env.SUBSCRIPTION_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  
  // Get the verified JWT payload from the middleware
  const jwtPayload = c.get("jwtPayload") as any;

  if (!jwtPayload) {
    return c.json({ error: "Invalid token: no payload found" }, 401);
  }

  // Supabase stores the user ID in the 'sub' (subject) field of the JWT
  const userId = jwtPayload.sub;

  if (!userId) {
    return c.json({ error: "Invalid token: missing user ID" }, 401);
  }

  // Get section_id and email from request body
  const { section_id, email } = await c.req.json();

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
  const apiKey = c.req.header("X-API-Key");

  console.log(apiKey);
  console.log(Bun.env.SUBSCRIPTION_API_KEY);


  if (!apiKey || apiKey !== Bun.env.SUBSCRIPTION_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  

  // Get the verified JWT payload from the middleware
  const jwtPayload = c.get("jwtPayload") as any;

  if (!jwtPayload) {
    return c.json({ error: "Invalid token: no payload found" }, 401);
  }

  // Supabase stores the user ID in the 'sub' (subject) field of the JWT
  const authenticatedUserId = jwtPayload.sub;

  
  if (!authenticatedUserId) {
    return c.json({ error: "Invalid token: missing user ID" }, 401);
  }
  
  

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