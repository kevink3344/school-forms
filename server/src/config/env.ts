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

// -----------------------------------------------------------------------------
// Database mode (docs/plans/dual-db.md §11)
//
// `sqlserver` is the default so that an unset or blank DB_MODE keeps the live
// Azure SQL behaviour exactly as it was before dual-database support existed.
// An unrecognised value is a hard error rather than a silent fallback — a typo
// must not quietly serve a different database.
// -----------------------------------------------------------------------------
const DB_MODES = ["sqlserver", "turso"] as const;
export type DbMode = (typeof DB_MODES)[number];

const dbMode: DbMode = (() => {
  const raw = (process.env.DB_MODE ?? "").trim().toLowerCase();
  if (!raw) return "sqlserver";
  if ((DB_MODES as readonly string[]).includes(raw)) return raw as DbMode;
  throw new Error(`Invalid DB_MODE "${raw}" — expected one of: ${DB_MODES.join(", ")}`);
})();

// The SQL Server connection details are only mandatory in sqlserver mode, so a
// Turso-only deployment needs no DB_SERVER / DB_USER / DB_PASSWORD at all.
// `driver/mssql.ts` builds its config object eagerly at import time, so these
// must not throw when the SQL Server path is not in use.
function requiredForSqlServer(name: string, fallback: string): string {
  if (dbMode !== "sqlserver") return process.env[name] ?? fallback;
  return required(name, fallback);
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProd: process.env.NODE_ENV === "production",

  port: int("PORT", 4000),

  // Which database backend the app talks to. See driver/index.ts.
  dbMode,

  // Path to the built client (single-origin serve in production).
  // Resolved relative to the repo root, NOT process.cwd(), so it works no matter
  // where Azure (or the user) starts the server from.
  clientDistPath: process.env.CLIENT_DIST_PATH ?? path.join(repoRoot, "client", "dist"),

  azureWebAppName: process.env.AZURE_WEBAPP_NAME ?? "school-forms-api",
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "http://localhost:4000",
  apiBaseUrl: process.env.API_BASE_URL ?? "http://localhost:4000",
  clientUrl: process.env.CLIENT_URL ?? "http://localhost:5173",

  // The organization a NEW self-registration is saved into, identified by its
  // slug. A blank or absent value falls back to `academics`, so an unconfigured
  // deployment keeps the behaviour it had before this was configurable.
  //
  // This is deliberately server-side only. The registration endpoint no longer
  // accepts an org slug from the client, so a caller cannot pick the tenant they
  // land in — the deployment decides. A slug that does not resolve to an
  // existing organization surfaces as an error at registration time (see
  // `getDefaultOrganization`), not as a silent fallback to the wrong tenant.
  defaultOrgRegistration: (process.env.DEFAULT_ORG_REGISTRATION ?? "").trim().toLowerCase() || "academics",

  db: {
    server: requiredForSqlServer("DB_SERVER", "localhost"),
    port: int("DB_PORT", 1433),
    database: requiredForSqlServer("DB_DATABASE", "school-form-data"),
    user: requiredForSqlServer("DB_USER", "sa"),
    password: requiredForSqlServer("DB_PASSWORD", ""),
    poolMax: int("DB_POOL_MAX", 10),
    poolMin: int("DB_POOL_MIN", 0),
    poolIdleTimeoutMs: int("DB_POOL_IDLE_TIMEOUT_MS", 30000),
    connectionTimeoutMs: int("DB_CONNECTION_TIMEOUT_MS", 60000),
    requestTimeoutMs: int("DB_REQUEST_TIMEOUT_MS", 15000),
  },

  // Turso / libSQL. TURSO_DB_URL / TURSO_DB_APIKEY are the names actually used
  // in this repo's `.env`; TURSO_DATABASE_URL / TURSO_AUTH_TOKEN (the names in
  // docs/plans/dual-db.md §11) are accepted as aliases so either convention
  // works. The auth token is optional for a local `file:` database.
  turso: (() => {
    const url = process.env.TURSO_DB_URL ?? process.env.TURSO_DATABASE_URL ?? "";
    const authToken = process.env.TURSO_DB_APIKEY ?? process.env.TURSO_AUTH_TOKEN ?? "";
    if (dbMode === "turso" && !url) {
      throw new Error(
        "DB_MODE=turso requires TURSO_DB_URL (or TURSO_DATABASE_URL) to be set."
      );
    }
    return { url, authToken };
  })(),

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

  slack: {
    // Incoming-webhook URL used for ADMIN notifications (new submission,
    // document created/failed). Empty string disables Slack entirely — the
    // notifier is fire-and-forget and never throws, so the flow always succeeds.
    webhookUrl: process.env.SLACK_WEBHOOK_URL ?? "",
  },

  webhookAdminEmail: process.env.SEED_ADMIN_EMAIL ?? "admin@schoolforms.local",
  webhookAdminPassword: process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!",

  // Optional production lock for the login mode. When set to a valid mode
  // (select/password/maintenance), it overrides the DB setting on reads and the
  // Settings panel disables editing. See routes/settings.ts.
  loginModeOverride: (() => {
    const raw = process.env.LOGIN_MODE?.trim().toLowerCase();
    return raw && ["select", "password", "maintenance"].includes(raw) ? raw : null;
  })(),

  rateLimit: {
    windowMs: int("RATE_LIMIT_WINDOW_MS", 900000),
    // Per IP, per window. The SPA issues several reads per page load and every
    // office behind one NAT shares a single bucket, so 300/15min was reachable
    // by ordinary use — and exhausting it used to silently downgrade the login
    // form. Bootstrap reads are now exempt in index.ts, so this budget is spent
    // on real API calls only.
    max: int("RATE_LIMIT_MAX", 1000),
  },

  // Google Docs generation (staff "Generate document" feature).
  // Authenticated as a project OAuth client using a refresh-token grant (not a
  // service account). `googleIsSharedDrive` tells the Drive API whether the
  // template/folder live in a shared drive (requires supportsAllDrives).
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN ?? "",
    grantType: process.env.GOOGLE_GRANT_TYPE ?? "refresh_token",
    docTemplateId: process.env.GOOGLE_DOC_TEMPLATE_ID ?? "",
    docFolderId: process.env.GOOGLE_DOC_FOLDER_ID ?? "",
    isSharedDrive: process.env.GOOGLE_IS_SHARED_DRIVE === "true",
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
