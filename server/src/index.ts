import path from "node:path";
import { existsSync } from "node:fs";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import swaggerUi from "swagger-ui-express";
import { env } from "./config/env.js";
import { initDb, isDbReady } from "./db/pool.js";
import { authRouter } from "./routes/auth.js";
import { schoolsRouter } from "./routes/schools.js";
import { usersRouter } from "./routes/users.js";
import { formsRouter } from "./routes/forms.js";
import { submissionsRouter } from "./routes/submissions.js";
import { organizationsRouter } from "./routes/organizations.js";
import { exportRouter } from "./routes/export.js";
import { webhookRouter } from "./routes/webhook.js";
import { healthRouter, infoHandler } from "./routes/health.js";
import { settingsRouter } from "./routes/settings.js";
import { buildSwaggerSpec } from "./swagger.js";

const app = express();

// Azure App Service sits behind a reverse proxy. Trust one hop so req.protocol /
// req.get("host") reflect the real public scheme + host (https, no port).
app.set("trust proxy", 1);

// -----------------------------------------------------------------------------
// Middleware
// -----------------------------------------------------------------------------
app.use(helmet());
app.use(
  cors({
    origin: env.clientUrl,
    credentials: true,
  })
);
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

// Rate limiting (skip health + docs)
const apiLimiter = rateLimit({
  windowMs: env.rateLimit.windowMs,
  max: env.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    const p = req.path;
    return p.startsWith("/health") || p.startsWith("/docs");
  },
});
app.use("/api/", apiLimiter);

// -----------------------------------------------------------------------------
// Swagger / OpenAPI
// -----------------------------------------------------------------------------
if (env.swagger.enabled) {
  // Serve the OpenAPI spec dynamically so `servers[0]` matches the origin the
  // docs page was served from (localhost:4000 vs. Azure no-port).
  app.get("/api/docs.json", (_req, res) => {
    res.json(buildSwaggerSpec(_req));
  });

  app.use(
    "/api/docs",
    swaggerUi.serve,
    swaggerUi.setup(null, {
      swaggerOptions: {
        url: "/api/docs.json",
      },
      customSiteTitle: "School Forms API",
    })
  );
}

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------
app.use("/api/health", healthRouter);
app.get("/api/info", infoHandler);
app.use("/api/auth", authRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/schools", schoolsRouter);
app.use("/api/users", usersRouter);
app.use("/api/forms", formsRouter);
app.use("/api/submissions", submissionsRouter);
app.use("/api/organizations", organizationsRouter);
app.use("/api/export", exportRouter);
app.use("/api/webhook", webhookRouter);

// -----------------------------------------------------------------------------
// Serve the built client (SPA) so a single URL hosts BOTH the API and the app.
// In production, the React app and API share the same origin; the client calls
// relative "/api/..." so no CORS is needed. Falls back to a JSON root in dev.
// -----------------------------------------------------------------------------
const clientDist = env.clientDistPath;
const clientIndex = existsSync(clientDist) ? path.join(clientDist, "index.html") : null;
if (clientIndex) {
  app.use(express.static(clientDist));
  // SPA fallback — every non-/api GET returns the app shell (pushes client-side routes).
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(clientIndex);
  });
} else {
  app.get("/", (_req, res) => {
    res.json({
      name: "School Forms API",
      docs: "/api/docs",
      health: "/api/health",
    });
  });
}

// -----------------------------------------------------------------------------
// 404 + error handling
// -----------------------------------------------------------------------------
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : "Internal server error";
  // eslint-disable-next-line no-console
  console.error("[error]", err);
  res.status(500).json({ error: message });
});

// -----------------------------------------------------------------------------
// Start server FIRST, then warm the DB in the background (Azure Serverless
// auto-suspends; the first wake can take minutes and will ECONNRESET).
// -----------------------------------------------------------------------------
const server = app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(
    `[server] School Forms API listening on http://localhost:${env.port} (dbReady=${isDbReady()})`
  );
  void warmDb();
});

async function warmDb() {
  const maxAttempts = 40;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ok = await initDb();
    if (ok) {
      // eslint-disable-next-line no-console
      console.log("[server] DB is ready.");
      return;
    }
    if (attempt % 5 === 0) {
      // eslint-disable-next-line no-console
      console.warn(`[server] Still waiting for DB (attempt ${attempt}/${maxAttempts})...`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  // eslint-disable-next-line no-console
  console.error("[server] Could not warm DB after retries. Server remains up (dbReady=false) for health checks.");
}

// Graceful shutdown
function shutdown() {
  // eslint-disable-next-line no-console
  console.log("[server] Shutting down...");
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
