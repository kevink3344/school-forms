import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load the repo-root `.env` (server runs from `server/`, but `.env` lives at the root).
// In production (Azure Web Apps) environment variables come from App Settings, so this
// is a no-op when the vars are already set.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../");
loadDotenv({ path: path.join(repoRoot, ".env"), override: false });

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  return Number.isNaN(parsed) ? fallback : parsed;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProd: process.env.NODE_ENV === "production",

  port: int("PORT", 4000),

  // Path to the built client (single-origin serve in production).
  // Resolved relative to the repo root, NOT process.cwd(), so it works no matter
  // where Azure (or the user) starts the server from.
  clientDistPath: process.env.CLIENT_DIST_PATH ?? path.join(repoRoot, "client", "dist"),

  azureWebAppName: process.env.AZURE_WEBAPP_NAME ?? "school-forms-api",
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "http://localhost:4000",
  apiBaseUrl: process.env.API_BASE_URL ?? "http://localhost:4000",
  clientUrl: process.env.CLIENT_URL ?? "http://localhost:5173",

  db: {
    server: required("DB_SERVER", "localhost"),
    port: int("DB_PORT", 1433),
    database: required("DB_DATABASE", "school-form-data"),
    user: required("DB_USER", "sa"),
    password: required("DB_PASSWORD", ""),
    poolMax: int("DB_POOL_MAX", 10),
    poolMin: int("DB_POOL_MIN", 0),
    poolIdleTimeoutMs: int("DB_POOL_IDLE_TIMEOUT_MS", 30000),
    connectionTimeoutMs: int("DB_CONNECTION_TIMEOUT_MS", 60000),
    requestTimeoutMs: int("DB_REQUEST_TIMEOUT_MS", 15000),
  },

  auth: {
    accessSecret: required("JWT_ACCESS_SECRET", "dev-access-secret"),
    refreshSecret: required("JWT_REFRESH_SECRET", "dev-refresh-secret"),
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? "15m",
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? "7d",
    allowedRoles: (process.env.ALLOWED_ROLES ?? "admin,staff")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  },

  swagger: {
    enabled: process.env.SWAGGER_ENABLED !== "false",
    bearerScheme: process.env.SWAGGER_BEARER_SCHEME ?? "bearerAuth",
  },

  googleWebhookSecret: process.env.GOOGLE_FORMS_WEBHOOK_SECRET ?? "",

  webhookAdminEmail: process.env.SEED_ADMIN_EMAIL ?? "admin@schoolforms.local",
  webhookAdminPassword: process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!",

  rateLimit: {
    windowMs: int("RATE_LIMIT_WINDOW_MS", 900000),
    max: int("RATE_LIMIT_MAX", 100),
  },

  // School import: a public ArcGIS GeoJSON feed + the table columns to render.
  // Import is manual (admin button); see docs/plans/school-import.md.
  schoolImport: {
    url: process.env.SCHOOL_JSON ?? "",
    columns: (process.env.SCHOOL_TABLE_COLUMNS ?? "")
      .split(",")
      .map((s) => s.trim().trim())
      .filter(Boolean),
  },
};
