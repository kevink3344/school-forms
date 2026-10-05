import type { Request } from "express";
import { env } from "./config/env.js";

// Derive the server URL from the actual request, so "Try it out" targets the
// exact origin the docs page was served from. This handles the local-dev
// `:4000` vs. Azure (no port) difference with zero config.
export function baseUrlFromRequest(req: Request): string {
  return `${req.protocol}://${req.get("host")}`;
}

export function buildSwaggerSpec(req?: Request) {
  const bearerScheme = env.swagger.bearerScheme;
  const servers = [
    // Always first: the origin this request was served from.
    ...(req ? [{ url: baseUrlFromRequest(req), description: "Current origin" }] : []),
    // Documented fallback (optional override). Never the primary.
    { url: env.publicBaseUrl, description: "Development (PUBLIC_BASE_URL)" },
  ];

  return {
    openapi: "3.0.3",
    info: {
      title: "School Forms API",
      version: "1.0.0",
      description: `REST API for the School Forms application.\n\n**Roles:** \`admin\` and \`staff\` only. **Parents submit anonymously** (no auth).\n\n- Admins design forms, view all submissions in a spreadsheet view, filter, and export.\n- Staff register, choose their school, and see every submission in their organization. A School Contact (\`cdm_contact\`) is narrowed to their own school.\n\nAuth uses JWT access tokens (15 min) with an httpOnly refresh cookie (7 days).`,
      contact: { name: "School Forms Team" },
    },
    servers,
    components: {
      securitySchemes: {
        [bearerScheme]: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
      schemas: {
        Organization: {
          type: "object",
          properties: {
            id: { type: "integer" },
            slug: { type: "string" },
            name: { type: "string" },
            description: { type: "string", nullable: true },
            doc_folder_id: { type: "string", nullable: true, description: "Google Drive parent folder id for generated documents; null falls back to the global env folder." },
            active: { type: "boolean" },
            created_at: { type: "string", format: "date-time" },
          },
        },
        School: {
          type: "object",
          properties: {
            id: { type: "integer" },
            name: { type: "string" },
            district: { type: "string", nullable: true },
            created_at: { type: "string", format: "date-time" },
          },
        },
        User: {
          type: "object",
          properties: {
            id: { type: "integer" },
            email: { type: "string", format: "email" },
            role: { type: "string", enum: ["admin", "staff", "cdm_contact"] },
            school_id: { type: "integer", nullable: true },
            organization_id: { type: "integer", nullable: true },
            display_name: { type: "string" },
            must_change_password: {
              type: "boolean",
              description:
                "Set when an administrator has issued a temporary password via POST /api/users/{id}/reset-password. " +
                "The client refuses to render the app while this is true; it is cleared by a successful " +
                "POST /api/auth/change-password.",
            },
          },
        },
        // The admin /api/users shape: the safe user fields plus the school/org
        // display names, the active flag and the test-screen opt-in.
        AdminUser: {
          allOf: [
            { $ref: "#/components/schemas/User" },
            {
              type: "object",
              properties: {
                school_name: { type: "string", nullable: true },
                organization_name: { type: "string", nullable: true },
                organization_slug: { type: "string", nullable: true },
                active: { type: "boolean" },
                show_on_test_screen: {
                  type: "boolean",
                  description:
                    "Whether the account appears in the select-mode (\"Test\") login dropdown. Defaults to false, so only explicitly opted-in accounts are listed.",
                },
                created_at: { type: "string", format: "date-time" },
              },
            },
          ],
        },
        AuthResponse: {
          type: "object",
          properties: {
            access_token: { type: "string" },
            token_type: { type: "string", example: "bearer" },
            user: { $ref: "#/components/schemas/User" },
          },
        },
        ChangePasswordRequest: {
          type: "object",
          required: ["current_password", "new_password"],
          properties: {
            current_password: { type: "string", minLength: 1, maxLength: 100 },
            new_password: {
              type: "string",
              minLength: 8,
              maxLength: 100,
              description: "Must differ from current_password. 'confirm' is client-side only and not sent.",
            },
          },
        },
        FormField: {
          type: "object",
          required: ["id", "label", "type", "sort_order"],
          properties: {
            id: { type: "integer" },
            form_id: { type: "integer" },
            label: { type: "string" },
            type: { type: "string", enum: ["text", "textarea", "number", "date", "select", "checkbox", "radio", "email", "google_doc"] },
            options: { type: "array", items: { type: "string" }, nullable: true },
            required: { type: "boolean" },
            staff_only: { type: "boolean" },
            roles: { type: "array", items: { type: "string" }, nullable: true, description: "Roles that may access a staff-only field; null for public fields." },
            sort_order: { type: "integer" },
            placeholder: { type: "string", nullable: true },
          },
        },
        Form: {
          type: "object",
          required: ["id", "title", "status"],
          properties: {
            id: { type: "integer" },
            title: { type: "string" },
            description: { type: "string", nullable: true },
            school_id: { type: "integer", nullable: true },
            designer_id: { type: "integer", nullable: true },
            organization_id: { type: "integer", nullable: true },
            status: { type: "string", enum: ["draft", "published", "archived"] },
            pre_archive_status: {
              type: "string",
              enum: ["draft", "published", "archived"],
              nullable: true,
              description:
                "The status this form held immediately before it was archived, so `{ restore: true }` can return it to exactly that state. Non-null only while `status` is `archived`.",
            },
            code: { type: "string", nullable: true },
            submission_seq: { type: "integer" },
            doc_folder_id: { type: "string", nullable: true, description: "Google Drive parent folder for this form's generated documents. NULL falls back to the global env folder." },
            google_form_url: { type: "string", nullable: true, description: "Optional link to the source Google Form this form mirrors. Informational only — no API integration." },
            visibility: {
              type: "string",
              enum: ["public", "private"],
              description:
                "Who may READ this form's results. `public` (the default) means every internal member of the organization; `private` means the organization's School Contacts do not see it without an approved grant — **administrators and staff are unaffected either way**. This narrows reading only; the parent submission path is untouched.",
            },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
            fields: { type: "array", items: { $ref: "#/components/schemas/FormField" } },
          },
        },
        Submission: {
          type: "object",
          required: ["public_id", "form_id", "status"],
          properties: {
            id: { type: "integer" },
            public_id: { type: "string" },
            form_id: { type: "integer" },
            form_name: { type: "string" },
            school_id: { type: "integer", nullable: true },
            organization_id: { type: "integer", nullable: true },
            status: { type: "string", enum: ["submitted", "in_review", "flagged", "completed"] },
            submission_seq: { type: "integer", nullable: true },
            submitted_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
            school_year: { type: "string", nullable: true, description: "School year this submission belongs to (e.g. 2026-2027). Derived from submitted_at using an Aug 1 - Jul 31 boundary." },
            staff_fields_updated_by: { type: "integer", nullable: true },
            staff_fields_updated_at: { type: "string", format: "date-time", nullable: true },
            staff_fields_updated_by_name: { type: "string", nullable: true },
            archived_at: {
              type: "string",
              format: "date-time",
              nullable: true,
              description:
                "When this submission was archived, or `null` while it is in the views. Non-null means the submission is hidden from the dashboard, the staff queue, submission counts, exports, reports and the Documents list — but NOT from `GET /api/submissions/{publicId}`, which returns archived submissions on purpose so their own page still resolves.",
            },
            archived_by: { type: "integer", nullable: true, description: "id of the admin who archived it. Cleared by restore." },
            archived_by_name: { type: "string", nullable: true, description: "Display name for `archived_by`, resolved from `users`. Present on list and detail responses; only meaningful when `archived_at` is set." },
            values: { type: "array", items: { $ref: "#/components/schemas/SubmissionValue" } },
            adhocFields: { type: "array", items: { $ref: "#/components/schemas/AdhocField" }, description: "Staff-only fields added ad-hoc to this submission." },
            staffOnlyFields: { type: "array", items: { $ref: "#/components/schemas/FormField" }, description: "The form's own staff-only field definitions." },
            parentFields: { type: "array", items: { $ref: "#/components/schemas/FormField" }, description: "The form's non-staff-only field definitions." },
          },
        },
        SubmissionValue: {
          type: "object",
          properties: {
            field_id: { type: "integer" },
            field_label: { type: "string" },
            field_type: { type: "string" },
            staff_only: { type: "boolean" },
            value: { type: "object", nullable: true },
          },
        },
        SubmitSubmissionResponse: {
          type: "object",
          properties: {
            public_id: { type: "string" },
            message: { type: "string" },
          },
        },
        ExportRow: {
          type: "object",
          properties: {
            submission_id: { type: "string" },
            submitted_at: { type: "string", format: "date-time" },
            status: { type: "string" },
          },
        },
        ExportPreview: {
          type: "object",
          properties: {
            columns: {
              type: "array",
              items: { $ref: "#/components/schemas/ExportColumn" },
            },
            rows: { type: "array", items: { $ref: "#/components/schemas/ExportRow" } },
            total: { type: "integer" },
          },
        },
        ExportColumn: {
          type: "object",
          properties: {
            key: { type: "string" },
            label: { type: "string" },
            staff_only: { type: "boolean" },
            roles: { type: "array", items: { type: "string" }, nullable: true, description: "Roles that may access a staff-only column; null for public columns." },
            type: { type: "string", enum: ["text", "textarea", "number", "date", "select", "checkbox", "radio", "email", "google_doc"], description: "The field's control type. Present on export-preview columns so a client can pick an editor without a second request." },
            options: { type: "array", items: { type: "string" }, nullable: true, description: "Allowed values for select/checkbox/radio fields; null otherwise." },
          },
        },
        ViewColumnsConfig: {
          type: "object",
          description: "One user's column selection for one form. Stored per (user, form) in dbo.user_form_view_columns, so saving never affects what another user sees.",
          properties: {
            columns: {
              type: "array",
              items: { $ref: "#/components/schemas/ExportColumn" },
            },
            viewKeys: {
              type: "array",
              description: "The subset of column keys currently displayed in the Submissions grid. When the form is unconfigured for this user this equals all column keys; when the caller has explicitly saved an empty selection it is an empty array.",
              items: { type: "string" },
            },
            hiddenBase: {
              type: "array",
              description: "The standard grid columns this user has turned off, as `base_*` keys. Empty for every config saved before those columns became hideable, which is why absence means 'shown'. The first column (Student / School) is never listed — it cannot be turned off.",
              items: { type: "string" },
            },
            configured: {
              type: "boolean",
              description: "Whether this user has an explicitly saved selection for this form. False only when they never saved one, in which case `viewKeys` is every column and a caller should apply its own default rather than showing all columns.",
            },
          },
        },
        ReportPreview: {
          type: "object",
          properties: {
            form_id: { type: "integer" },
            form_title: { type: "string" },
            school_scoped: {
              type: "boolean",
              description: "True when the caller is locked to their own school (staff / School Contact).",
            },
            columns: {
              type: "array",
              items: { $ref: "#/components/schemas/ExportColumn" },
            },
            rows: {
              type: "array",
              description: "One object per submission, keyed by column key (field_N) plus submission_public_id, submitted_at and status.",
              items: { type: "object", additionalProperties: true },
            },
            total: { type: "integer" },
          },
        },
        ReportView: {
          type: "object",
          description: "A saved report configuration, owned by exactly one user.",
          properties: {
            id: { type: "integer" },
            name: { type: "string" },
            form_id: { type: "integer" },
            filters: { type: "object", additionalProperties: true },
            columns: {
              type: "array",
              items: { type: "string" },
              nullable: true,
              description: "Selected field_N keys; null means all columns currently visible to the user.",
            },
            format: { type: "string", enum: ["csv", "xlsx", "pdf"] },
            is_default: { type: "boolean" },
            last_used_at: { type: "string", format: "date-time", nullable: true },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
          },
        },
        ReportViewResponse: {
          type: "object",
          properties: {
            view: { $ref: "#/components/schemas/ReportView" },
          },
        },
        ReportViewList: {
          type: "object",
          properties: {
            views: {
              type: "array",
              items: { $ref: "#/components/schemas/ReportView" },
            },
          },
        },
        AdhocField: {
          type: "object",
          properties: {
            id: { type: "integer" },
            submission_id: { type: "integer" },
            label: { type: "string" },
            type: { type: "string", enum: ["text", "textarea", "number", "date", "select", "checkbox", "radio", "email", "google_doc"] },
            options: { type: "array", items: { type: "string" }, nullable: true },
            value: { type: "object", nullable: true },
            sort_order: { type: "integer" },
            created_by: { type: "integer", nullable: true },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
          },
        },
        SchoolPage: {
          type: "object",
          properties: {
            data: { type: "array", items: { $ref: "#/components/schemas/School" } },
            total: { type: "integer" },
            page: { type: "integer" },
            pageSize: { type: "integer" },
            totalPages: { type: "integer" },
          },
        },
        ImportResult: {
          type: "object",
          properties: { total: { type: "integer" } },
        },
        Error: {
          type: "object",
          properties: {
            error: { type: "string" },
            details: { type: "object", nullable: true, description: "Zod flatten() output" },
          },
        },
        Document: {
          type: "object",
          properties: {
            id: { type: "integer" },
            submission_id: { type: "integer" },
            document_id: { type: "string", nullable: true, description: "Google Doc id returned by the API; null while Pending." },
            status: { type: "string", enum: ["Pending", "Completed", "Failed"] },
            created_by: { type: "integer", nullable: true },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
            error: { type: "string", nullable: true, description: "Reason for a Failed status." },
          },
        },
        ListDocumentRow: {
          type: "object",
          description: "A document row enriched with the submission's school and label-derived answers (Documents list page).",
          properties: {
            id: { type: "integer" },
            submission_id: { type: "integer" },
            document_id: { type: "string", nullable: true },
            status: { type: "string", enum: ["Pending", "Completed", "Failed"] },
            created_by: { type: "integer", nullable: true },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
            error: { type: "string", nullable: true },
            public_id: { type: "string", description: "Submission public id (through-link)." },
            school_id: { type: "integer", nullable: true },
            school_name: { type: "string", nullable: true },
            student_name: { type: "string", nullable: true },
            course_title: { type: "string", nullable: true },
            phase1_result: { type: "string", nullable: true },
          },
        },
        WebhookEvent: {
          type: "object",
          description:
            "One inbound webhook attempt. Never contains a secret; `payload_raw` is the verbatim " +
            "request body and is absent from list responses.",
          properties: {
            id: { type: "integer" },
            source: { type: "string", example: "google" },
            received_at: { type: "string", format: "date-time" },
            remote_ip: { type: "string", nullable: true },
            user_agent: { type: "string", nullable: true },
            auth_result: {
              type: "string",
              enum: ["ok", "invalid", "missing"],
              description:
                "Whether the X-Webhook-Secret header was correct. Anything other than `ok` means "
                + "no payload is stored for the row.",
            },
            status: { type: "string", enum: ["succeeded", "failed"] },
            http_status: { type: "integer" },
            error_code: {
              type: "string",
              nullable: true,
              enum: ["unauthorized", "invalid_body", "form_not_found", "form_not_published", "internal_error"],
            },
            error: { type: "string", nullable: true },
            form_id: { type: "integer", nullable: true },
            organization_id: {
              type: "integer",
              nullable: true,
              description: "The resolved form's organization; null when the form could not be resolved.",
            },
            submission_id: { type: "integer", nullable: true },
            public_id: { type: "string", nullable: true },
            payload_raw: {
              type: "string",
              nullable: true,
              description:
                "The verbatim request body, capped at 64 KB. Null when the secret check failed "
                + "or when the body was over the cap — both cases are not replayable.",
            },
            payload_bytes: { type: "integer", nullable: true },
            payload_hash: { type: "string", nullable: true, description: "sha256 of the stored body." },
            payload_present: { type: "boolean" },
            has_replay: { type: "boolean", description: "A succeeding replay already exists." },
            replay_of: { type: "integer", nullable: true, description: "The source row this replay came from." },
            replayed_by: { type: "integer", nullable: true },
            form_title: { type: "string", nullable: true },
            form_code: { type: "string", nullable: true },
            replayed_by_name: { type: "string", nullable: true },
          },
        },
        WebhookRetention: {
          type: "object",
          description: "Payloads are kept indefinitely; `warning` flags a log large enough to trim.",
          properties: {
            rows: { type: "integer" },
            threshold: { type: "integer", example: 100000 },
            warning: { type: "boolean" },
          },
        },
        WebhookReplayResult: {
          type: "object",
          properties: {
            id: { type: "integer", description: "The SOURCE event id that was replayed." },
            status: { type: "string", enum: ["succeeded", "failed", "skipped"] },
            public_id: { type: "string", nullable: true },
            error_code: { type: "string", nullable: true },
            error: { type: "string", nullable: true },
          },
        },
        SystemMessage: {
          type: "object",
          required: ["id", "organization_id", "title", "body", "active", "audience", "created_at"],
          properties: {
            id: { type: "integer" },
            organization_id: { type: "integer" },
            title: { type: "string", example: "Scheduled maintenance" },
            body: {
              type: "string",
              description: "The description. Always a string, never null — an omitted description is stored as \"\".",
            },
            active: {
              type: "boolean",
              description: "Only active messages are served to users; inactive ones stay in the admin grid so they can be switched back on.",
            },
            audience: {
              type: "array",
              items: { type: "string", enum: ["admin", "staff", "cdm_contact"] },
              description:
                "The roles that may be shown this message, resolved from the stored JSON array. " +
                "A message with no audience set is returned as every role, which is what makes a " +
                "message authored before audiences existed visible. An EMPTY array is a real value " +
                "and means nobody.",
            },
            created_by: { type: "integer", nullable: true },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
          },
        },
      },
    },
    paths: {
      "/api/health": {
        get: {
          tags: ["System"],
          summary: "Health check",
          responses: {
            "200": {
              description: "Service status",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      dbReady: { type: "boolean" },
                      dbMode: {
                        type: "string",
                        enum: ["sqlserver", "turso"],
                        description:
                          "Which database engine this process is configured to use (DB_MODE).",
                      },
                      uptime: { type: "number" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/info": {
        get: {
          tags: ["System"],
          summary: "Public app info (version + login mode override)",
          responses: {
            "200": {
              description: "App info",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      version: { type: "string" },
                      loginModeOverride: { type: "string", nullable: true, example: "select" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/settings/{key}": {
        get: {
          tags: ["Settings"],
          summary: "Get a public app setting (login_mode / maintenance_message / documents_link / menu_items / slack_notifications_enabled)",
          security: [],
          parameters: [
            { name: "key", in: "path", required: true, schema: { type: "string", enum: ["login_mode", "maintenance_message", "documents_link", "menu_items", "slack_notifications_enabled"] } },
          ],
          responses: {
            "200": {
              description: "Setting value",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { key: { type: "string" }, value: { type: "string" } },
                  },
                },
              },
            },
            "400": { description: "Unknown setting key" },
          },
        },
        put: {
          tags: ["Settings"],
          summary: "Update an app setting (admin only)",
          security: [{ [bearerScheme]: [] }],
          parameters: [
            { name: "key", in: "path", required: true, schema: { type: "string", enum: ["login_mode", "maintenance_message", "documents_link", "menu_items", "slack_notifications_enabled"] } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["value"],
                  properties: { value: { type: "string" } },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Updated",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { key: { type: "string" }, value: { type: "string" } },
                  },
                },
              },
            },
            "400": { description: "Invalid value / unknown key" },
            "401": { description: "Unauthorized" },
            "403": { description: "Forbidden (not admin)" },
          },
        },
      },
      "/api/auth/users": {
        get: {
          tags: ["Auth"],
          summary: "List users for the select-mode login dropdown",
          description:
            "Anonymous. Returns ONLY active users in active organizations that an admin has\n" +
            "opted in via `show_on_test_screen` — the flag defaults to false, so the dropdown\n" +
            "stays empty until accounts are deliberately added. This curates the test screen;\n" +
            "it is not a security boundary, because POST /api/auth/select is passwordless and\n" +
            "still accepts a hidden user's id.",
          security: [],
          parameters: [
            { name: "org", in: "query", required: false, schema: { type: "string" }, description: "Organization slug to scope results (e.g. academics)" },
          ],
          responses: {
            "200": {
              description: "Safe user list (no password hashes)",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "integer" },
                        display_name: { type: "string" },
                        email: { type: "string", format: "email" },
                        role: { type: "string", enum: ["admin", "staff", "cdm_contact"] },
                      },
                    },
                  },
                },
              },
            },
            "404": { description: "Organization not found" },
          },
        },
      },
      "/api/auth/select": {
        post: {
          tags: ["Auth"],
          summary: "Select-mode login (test/demo, no password)",
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["userId"],
                  properties: {
                    userId: { type: "integer" },
                    organizationId: { type: "integer", nullable: true },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/AuthResponse" } },
              },
            },
            "400": { description: "Validation error" },
            "403": { description: "Wrong org / deactivated account" },
            "404": { description: "User not found" },
          },
        },
      },
      "/api/auth/register": {
        post: {
          tags: ["Auth"],
          summary: "Register a School Contact user",
          description:
            "Self-service registration. Creates a `cdm_contact` (School Contact) account only — " +
            "the request cannot set a role (use `POST /api/auth/seed-admin` for administrators). " +
            "A School Contact is confined to the `school_id` they register under, so this account " +
            "can see only that school's submissions. The organization the " +
            "account is saved into is resolved server-side from the `DEFAULT_ORG_REGISTRATION` " +
            "environment variable (falling back to `academics`), so the request cannot specify an " +
            "organization either. Unknown body fields such as `role` or `slug` are ignored.",
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["email", "password", "display_name", "school_id"],
                  properties: {
                    email: { type: "string", format: "email" },
                    password: { type: "string", minLength: 8 },
                    display_name: { type: "string" },
                    school_id: { type: "integer" },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Created",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/AuthResponse" } },
              },
            },
            "400": { description: "Validation error" },
          },
        },
      },
      "/api/auth/login": {
        post: {
          tags: ["Auth"],
          summary: "Login (email + password)",
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["email", "password"],
                  properties: {
                    email: { type: "string", format: "email" },
                    password: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/AuthResponse" } },
              },
            },
            "401": { description: "Invalid credentials" },
          },
        },
      },
      "/api/auth/me": {
        get: {
          tags: ["Auth"],
          summary: "Get current user",
          security: [{ [bearerScheme]: [] }],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/User" } },
              },
            },
            "401": { description: "Unauthorized" },
          },
        },
      },
      "/api/auth/change-password": {
        post: {
          tags: ["Auth"],
          summary: "Change your own password (any role)",
          description:
            "Requires the current password as re-authentication — the bearer token alone is not sufficient. " +
            "A wrong current password returns **400**, not 401, so the client does not treat it as an expired session.",
          security: [{ [bearerScheme]: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ChangePasswordRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Password updated",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { message: { type: "string", example: "Password updated successfully." } },
                  },
                },
              },
            },
            "400": { description: "Validation failed, or current password is incorrect" },
            "401": { description: "Missing or invalid bearer token" },
            "429": { description: "Too many attempts" },
          },
        },
      },
      "/api/auth/schools": {
        get: {
          tags: ["Auth"],
          summary: "List schools for registration dropdown",
          security: [],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/School" } },
                },
              },
            },
          },
        },
      },
      "/api/organizations": {
        get: {
          tags: ["Organizations"],
          summary: "List all organizations (admin)",
          description: "Read-only coordinator list. Returns each org with its member count. Because admins are org-scoped, this is informational only.",
          security: [{ [bearerScheme]: [] }],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "integer" },
                        slug: { type: "string" },
                        name: { type: "string" },
                        active: { type: "boolean" },
                        created_at: { type: "string", format: "date-time" },
                        member_count: { type: "integer" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          tags: ["Organizations"],
          summary: "Create an organization (admin)",
          security: [{ [bearerScheme]: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string", description: "Organization display name (1-120 chars). Slug is derived if omitted." },
                    slug: {
                      type: "string",
                      description: "URL-friendly identifier (lowercase, hyphen-separated). Auto-derived from name if omitted.",
                      pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
                    },
                    description: { type: "string", nullable: true, description: "Free-form details about the organization." },
                    doc_folder_id: { type: "string", nullable: true, description: "Google Drive parent folder id for generated documents. Blank clears the override (falls back to the global env folder)." },
                    active: { type: "boolean", default: true, description: "Whether the organization is active (default true)." },
                  },
                  required: ["name"],
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Created",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Organization" },
                },
              },
            },
            "409": { description: "Slug or name already in use" },
          },
        },
      },
      "/api/organizations/{id}": {
        put: {
          tags: ["Organizations"],
          summary: "Update an organization (admin)",
          description: "Partial update. At least one of name, slug, or active is required. Active toggled to false deactivates the org.",
          security: [{ [bearerScheme]: [] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "integer" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string", description: "Organization display name (1-120 chars)." },
                    slug: {
                      type: "string",
                      description: "URL-friendly identifier (lowercase, hyphen-separated).",
                      pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
                    },
                    doc_folder_id: { type: "string", nullable: true, description: "Google Drive parent folder id for generated documents. Blank clears the override (falls back to the global env folder)." },
                    description: { type: "string", nullable: true, description: "Free-form details about the organization." },
                    active: { type: "boolean", description: "Whether the organization is active. Setting false deactivates it." },
                  },
                  minProperties: 1,
                },
              },
            },
          },
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Organization" },
                },
              },
            },
            "404": { description: "Organization not found" },
            "409": { description: "Slug or name already in use" },
          },
        },
      },
      "/api/schools": {
        get: {
          tags: ["Schools"],
          summary: "List all schools",
          description: "Requires auth. Admins get the full list; staff are scoped to their own school.",
          security: [{ [bearerScheme]: [] }],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/School" } },
                },
              },
            },
          },
        },
        post: {
          tags: ["Schools"],
          summary: "Create a school (admin)",
          security: [{ [bearerScheme]: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name"],
                  properties: {
                    name: { type: "string" },
                    district: { type: "string", nullable: true },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Created",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/School" } },
              },
            },
          },
        },
      },
      "/api/forms": {
        get: {
          tags: ["Forms"],
          summary: "List forms (admin)",
          security: [{ [bearerScheme]: [] }],
          parameters: [
            { name: "school_id", in: "query", schema: { type: "integer" }, required: false },
          ],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Form" } } },
              },
            },
          },
        },
        post: {
          tags: ["Forms"],
          summary: "Create a form template (admin)",
          security: [{ [bearerScheme]: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Form" },
              },
            },
          },
          responses: {
            "201": {
              description: "Created",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Form" } },
              },
            },
          },
        },
      },
      "/api/forms/public": {
        get: {
          tags: ["Forms"],
          summary: "List published forms (public, anonymous parent)",
          description: "Org-scoped by URL. Pass `?org=<slug>` to return only that org's published forms.",
          security: [],
          parameters: [
            { name: "org", in: "query", schema: { type: "string" }, required: false, description: "Organization slug (e.g. academics)" },
          ],
          responses: {
            "200": {
              description: "OK — published forms with staff-only fields stripped",
              content: {
                "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Form" } } },
              },
            },
            "404": { description: "Organization not found" },
          },
        },
      },
      "/api/forms/{id}/public": {
        get: {
          tags: ["Forms"],
          summary: "Fetch a published form + fields (public, anonymous parent)",
          description: "The form must belong to the org given by `?org=<slug>`.",
          security: [],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "integer" } },
            { name: "org", in: "query", schema: { type: "string" }, required: false, description: "Organization slug (e.g. academics)" },
          ],
          responses: {
            "200": {
              description: "OK — published form, staff-only fields stripped",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Form" } },
              },
            },
            "404": { description: "Not found" },
            "400": { description: "Form is not accepting submissions" },
          },
        },
      },
      "/api/forms/{id}/columns": {
        get: {
          tags: ["Forms"],
          summary: "Get your view-columns config for a form (admin, staff, School Contact)",
          description: "Returns the full column list plus the subset of `viewKeys` you currently show in the Submissions grid, and a `configured` flag saying whether you have ever saved a selection. The config is per user, so this can only ever read your own — it cannot expose another user's choice. This is independent of Export — Export always uses all columns.",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            "200": {
              description: "OK — columns + viewKeys",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ViewColumnsConfig" } },
              },
            },
            "404": { description: "Form not found" },
          },
        },
        put: {
          tags: ["Forms"],
          summary: "Save your view-columns config for a form (admin, staff, School Contact)",
          description: "`view_keys` must be an array of `field_N` strings, and optional `hidden_base` an array of `base_*` keys naming the standard columns to hide (the first column, Student / School, is not one of them). Stored per (user, form) and only affects your own Submissions grid display — Export is unchanged, and other users' selections are untouched. An empty `view_keys` is a valid, meaningful selection and is stored as such (it reads back as `configured: true` with `viewKeys: []`), so it is not treated as 'reset to all columns'.",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["view_keys"],
                  properties: {
                    view_keys: {
                      type: "array",
                      description: "e.g. [\"field_1\", \"field_3\"]",
                      items: { type: "string" },
                    },
                    hidden_base: {
                      type: "array",
                      description: "Standard grid columns to hide, e.g. [\"base_status\", \"base_submitted\"]. Omit or send [] to show them all.",
                      items: { type: "string" },
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "OK — updated columns + viewKeys",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ViewColumnsConfig" } },
              },
            },
            "400": { description: "Validation error" },
            "404": { description: "Form not found" },
          },
        },
      },
      "/api/submissions": {
        post: {
          tags: ["Submissions"],
          summary: "Anonymous parent submission (no auth)",
          description: "Org-scoped by URL. Pass `?org=<slug>` to target a specific organization's form.",
          security: [],
          parameters: [
            { name: "org", in: "query", schema: { type: "string" }, required: false, description: "Organization slug (e.g. academics)" },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["form_id", "answers"],
                  properties: {
                    form_id: { type: "integer" },
                    answers: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          field_id: { type: "integer" },
                          value: { type: "object", nullable: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Created",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/SubmitSubmissionResponse" } },
              },
            },
            "400": { description: "Validation error / form not accepting submissions" },
            "404": { description: "Form not found" },
          },
        },
        get: {
          tags: ["Submissions"],
          summary: "List submissions (admin: all, staff: own school)",
          description:
            "**Archived submissions are excluded unless `archived` is set.** Archiving is the non-destructive counterpart to a delete: the row, its answers, its staff-only and ad-hoc fields and its generated documents all stay exactly where they are, but it is hidden from every listing, count, export and report in the app — including this one.\n\n" +
            "`archived` is not a filter you combine with the others; it selects WHICH of the two lists you are asking for:\n\n" +
            "- omitted / `0` — the normal view. Archived rows are excluded, i.e. the only rows you get back are `archived_at IS NULL`.\n" +
            "- `1` / `true` — the Archive view. ONLY rows with `archived_at` set are returned, narrowed by the same `school_id` / `form_id` / `status` / date filters.\n\n" +
            "There is no mode that returns both. A merged list could not answer \"which of these is put away?\", so every row would carry a doubt that the count totals, the export and the row actions would each have to inherit.\n\n" +
            "Archived submissions are still readable **by public id** — `GET /api/submissions/{publicId}` deliberately returns them, so a bookmarked link, a Webhook Log link or browser Back lands somewhere that explains itself and offers Restore. Archiving hides a submission from *views*, not from its own URL.",
          security: [{ [bearerScheme]: [] }],
          parameters: [
            { name: "school_id", in: "query", schema: { type: "integer" }, required: false },
            { name: "form_id", in: "query", schema: { type: "integer" }, required: false },
            { name: "status", in: "query", schema: { type: "string" }, required: false },
            { name: "from", in: "query", schema: { type: "string" }, required: false },
            { name: "to", in: "query", schema: { type: "string" }, required: false },
            {
              name: "archived",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["0", "1", "true", "false"] },
              description:
                "Which list to read. `1` or `true` returns only archived submissions; anything else (or omitting it) returns only unarchived ones. See the description above.",
            },
          ],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Submission" } } },
              },
            },
          },
        },
      },
      "/api/webhook/google": {
        post: {
          tags: ["Submissions"],
          summary: "Google Forms webhook — create submission (secret-guarded)",
          description:
            "Public intake endpoint for a Google Apps Script webhook. Guards the call with the " +
            "X-Webhook-Secret header set via GOOGLE_FORMS_WEBHOOK_SECRET. Accepts the same body " +
            "as POST /api/submissions, EXCEPT that an answer may be identified by the Google Form " +
            "question title in `label` instead of a field_id. That is what lets a form whose " +
            "questions were never defined in this app's designer still be captured: a title that " +
            "matches a defined field is stored against it, and a title that matches nothing is " +
            "stored as a per-submission text field, so an answer is never dropped.",
          security: [],
          parameters: [
            {
              name: "X-Webhook-Secret",
              in: "header",
              required: true,
              schema: { type: "string" },
              description: "Shared secret from GOOGLE_FORMS_WEBHOOK_SECRET.",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["form_id", "answers"],
                  properties: {
                    form_id: { type: "integer" },
                    answers: {
                      type: "array",
                      items: {
                        type: "object",
                        description:
                          "An answer identified by `field_id`, or by the Google Form question title " +
                          "in `label` when the form was never defined in this app's designer. At " +
                          "least one of the two is required.",
                        properties: {
                          field_id: {
                            type: "integer",
                            nullable: true,
                            description:
                              "Server-side form field id. Wins over `label` when both are present; when it is not a field on this form, `label` is used instead.",
                          },
                          label: {
                            type: "string",
                            nullable: true,
                            description:
                              "The Google Form question title, sent verbatim by the Apps Script. Required when `field_id` is absent. A title longer than the 200-character field label is truncated on capture.",
                          },
                          value: { type: "object", nullable: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Submission created",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/SubmitSubmissionResponse" } },
              },
            },
            "400": { description: "Validation error / form not accepting submissions" },
            "401": { description: "Invalid or missing webhook secret" },
            "404": { description: "Form not found" },
          },
        },
      },
      "/api/submissions/{publicId}/public": {
        get: {
          tags: ["Submissions"],
          summary: "Fetch a public submission confirmation (anonymous parent)",
          description: "Org-scoped by URL. Pass `?org=<slug>` to verify the submission belongs to that org.",
          security: [],
          parameters: [
            { name: "publicId", in: "path", required: true, schema: { type: "string" } },
            { name: "org", in: "query", schema: { type: "string" }, required: false, description: "Organization slug (e.g. academics)" },
          ],
          responses: {
            "200": {
              description: "OK — submission with public values",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Submission" } },
              },
            },
            "404": { description: "Not found" },
          },
        },
      },
      "/api/export/preview": {
        get: {
          tags: ["Export"],
          summary: "Preview export columns + rows (admin)",
          security: [{ [bearerScheme]: [] }],
          parameters: [
            { name: "form_id", in: "query", required: true, schema: { type: "integer" } },
            { name: "school_id", in: "query", schema: { type: "integer" }, required: false },
            { name: "status", in: "query", schema: { type: "string" }, required: false },
          ],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ExportPreview" } },
              },
            },
          },
        },
      },
      "/api/export/csv": {
        get: {
          tags: ["Export"],
          summary: "Download CSV export (admin)",
          security: [{ [bearerScheme]: [] }],
          parameters: [
            { name: "form_id", in: "query", required: true, schema: { type: "integer" } },
            { name: "school_id", in: "query", schema: { type: "integer" }, required: false },
            { name: "status", in: "query", schema: { type: "string" }, required: false },
            { name: "include_staff_only", in: "query", schema: { type: "string" }, required: false },
          ],
          responses: {
            "200": {
              description: "CSV download",
              content: { "text/csv": { schema: { type: "string" } } },
            },
          },
        },
      },
      "/api/reports/preview": {
        get: {
          tags: ["Reports"],
          summary: "Preview report columns + rows (admin, staff)",
          description:
            "Builds the report table for one form. The rows returned here are exactly the rows every export format will contain, so the on-screen preview and the downloaded file always agree.",
          security: [{ [bearerScheme]: [] }],
          parameters: [
            { name: "form_id", in: "query", required: true, schema: { type: "integer" } },
            { name: "school_id", in: "query", schema: { type: "integer" }, required: false, description: "Admin only — staff and School Contacts are always scoped to their own school." },
            { name: "status", in: "query", schema: { type: "string" }, required: false },
            { name: "from", in: "query", schema: { type: "string" }, required: false, description: "Earliest submitted_at (inclusive)." },
            { name: "to", in: "query", schema: { type: "string" }, required: false, description: "Latest submitted_at (inclusive)." },
            { name: "q", in: "query", schema: { type: "string" }, required: false, description: "Free-text row filter (max 200 chars) matched against the public id, school name and every answer value." },
            { name: "columns", in: "query", schema: { type: "string" }, required: false, description: "Comma-separated field_N keys. Keys the caller may not access are dropped server-side." },
            { name: "include_staff_only", in: "query", schema: { type: "string" }, required: false, description: "Admin only — include staff-only columns. Ignored for staff." },
          ],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ReportPreview" } },
              },
            },
            "400": { description: "Validation error (missing form_id, or no authorized columns selected)" },
            "404": { description: "Form not found" },
          },
        },
      },
      "/api/reports/export": {
        get: {
          tags: ["Reports"],
          summary: "Download a report as CSV, Excel (.xlsx) or PDF (admin, staff)",
          description:
            "Accepts the same filters as /api/reports/preview and writes the identical table. `format` selects the writer.",
          security: [{ [bearerScheme]: [] }],
          parameters: [
            { name: "form_id", in: "query", required: true, schema: { type: "integer" } },
            { name: "format", in: "query", schema: { type: "string", enum: ["csv", "xlsx", "pdf"], default: "csv" }, required: false },
            { name: "school_id", in: "query", schema: { type: "integer" }, required: false, description: "Admin only — staff and School Contacts are always scoped to their own school." },
            { name: "status", in: "query", schema: { type: "string" }, required: false },
            { name: "from", in: "query", schema: { type: "string" }, required: false },
            { name: "to", in: "query", schema: { type: "string" }, required: false },
            { name: "q", in: "query", schema: { type: "string" }, required: false },
            { name: "columns", in: "query", schema: { type: "string" }, required: false, description: "Comma-separated field_N keys." },
            { name: "include_staff_only", in: "query", schema: { type: "string" }, required: false, description: "Admin only." },
          ],
          responses: {
            "200": {
              description: "Report file download",
              content: {
                "text/csv": { schema: { type: "string" } },
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { schema: { type: "string", format: "binary" } },
                "application/pdf": { schema: { type: "string", format: "binary" } },
              },
            },
            "400": { description: "Validation error / unsupported format" },
            "404": { description: "Form not found" },
          },
        },
      },
      "/api/reports/views": {
        get: {
          tags: ["Reports"],
          summary: "List the signed-in user's saved report views",
          security: [{ [bearerScheme]: [] }],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ReportViewList" } },
              },
            },
          },
        },
        post: {
          tags: ["Reports"],
          summary: "Save the current report configuration as a view",
          security: [{ [bearerScheme]: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name", "form_id"],
                  properties: {
                    name: { type: "string", maxLength: 120 },
                    form_id: { type: "integer" },
                    filters: { type: "object", additionalProperties: true },
                    columns: { type: "array", items: { type: "string" }, nullable: true },
                    format: { type: "string", enum: ["csv", "xlsx", "pdf"], default: "csv" },
                    is_default: { type: "boolean", default: false },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Created",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ReportViewResponse" } },
              },
            },
            "400": { description: "Validation error" },
            "404": { description: "Form not found" },
            "409": { description: "A view with that name already exists" },
          },
        },
      },
      "/api/reports/views/{id}": {
        put: {
          tags: ["Reports"],
          summary: "Update a saved report view",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string", maxLength: 120 },
                    form_id: { type: "integer" },
                    filters: { type: "object", additionalProperties: true },
                    columns: { type: "array", items: { type: "string" }, nullable: true },
                    format: { type: "string", enum: ["csv", "xlsx", "pdf"] },
                    is_default: { type: "boolean" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ReportViewResponse" } },
              },
            },
            "400": { description: "Validation error" },
            "404": { description: "View not found (or not owned by the caller)" },
            "409": { description: "A view with that name already exists" },
          },
        },
        delete: {
          tags: ["Reports"],
          summary: "Delete a saved report view",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            "204": { description: "Deleted" },
            "404": { description: "View not found (or not owned by the caller)" },
          },
        },
      },
      "/api/reports/views/{id}/default": {
        post: {
          tags: ["Reports"],
          summary: "Make a saved view the user's default",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ReportViewResponse" } },
              },
            },
            "404": { description: "View not found (or not owned by the caller)" },
          },
        },
      },
      "/api/reports/views/{id}/use": {
        post: {
          tags: ["Reports"],
          summary: "Mark a saved view as recently used",
          description: "Stamps last_used_at so the Reports page can re-apply the view the user worked with most recently.",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ReportViewResponse" } },
              },
            },
            "404": { description: "View not found (or not owned by the caller)" },
          },
        },
      },
      "/api/auth/refresh": {
        post: {
          tags: ["Auth"],
          summary: "Refresh the access token using the httpOnly refresh cookie",
          security: [],
          responses: {
            "200": {
              description: "OK — new access_token",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/AuthResponse" } },
              },
            },
            "401": { description: "Invalid or missing refresh cookie" },
          },
        },
      },
      "/api/auth/logout": {
        post: {
          tags: ["Auth"],
          summary: "Log out — clears the refresh cookie",
          security: [],
          responses: {
            "200": { description: "Logged out" },
          },
        },
      },
      "/api/auth/seed-admin": {
        post: {
          tags: ["Auth"],
          summary: "Create/seed the initial admin user (public seed)",
          description: "Seeds a default admin so the app can be logged into for the first time. Only works when no admin exists.",
          security: [],
          responses: {
            "201": { description: "Admin created" },
            "409": { description: "An admin already exists" },
          },
        },
      },
      "/api/auth/seed-staff": {
        post: {
          tags: ["Auth"],
          summary: "Create a staff user (admin only)",
          security: [{ [bearerScheme]: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["email", "password", "display_name", "school_id"],
                  properties: {
                    email: { type: "string", format: "email" },
                    password: { type: "string", minLength: 8 },
                    display_name: { type: "string" },
                    school_id: { type: "integer" },
                  },
                },
              },
            },
          },
          responses: {
            "201": { description: "Staff created" },
            "400": { description: "Validation error" },
            "401": { description: "Unauthorized" },
            "403": { description: "Forbidden (not admin)" },
          },
        },
      },
      "/api/forms/{id}": {
        get: {
          tags: ["Forms"],
          summary: "Get a form with its fields (admin)",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            "200": {
              description: "OK",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Form" } } },
            },
            "404": { description: "Form not found" },
          },
        },
        put: {
          tags: ["Forms"],
          summary: "Update a form (title/description/status/fields) — admin",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Form" } },
            },
          },
          responses: {
            "200": {
              description: "OK",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Form" } } },
            },
            "400": { description: "Validation error" },
            "404": { description: "Form not found" },
          },
        },
        delete: {
          tags: ["Forms"],
          summary: "Delete an unused form (admin)",
          description:
            "Deletes a form that has no submissions. Refuses with 409 when the form has any submission history, because submissions cascade on form delete. Published but unused forms are deletable.\n\nThis is the hard, irreversible option. To retire a form that already has submissions, use `PATCH /api/forms/{id}/status` with `{ \"status\": \"archived\" }` instead — archiving keeps every submission and can be undone.",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            "204": { description: "Deleted" },
            "400": { description: "Invalid form id" },
            "404": { description: "Form not found" },
            "409": {
              description: "Form has submissions and cannot be deleted",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      error: { type: "string" },
                      submission_count: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/forms/{id}/status": {
        patch: {
          tags: ["Forms"],
          summary: "Publish / unpublish / archive / restore a form — admin",
          description:
            "Three request shapes, all returning the updated form.\n\n" +
            "- `{ \"status\": \"draft\" | \"published\" }` — set the status explicitly. This is also how an archived form is brought back to a chosen status; it clears `pre_archive_status`.\n" +
            "- `{ \"status\": \"archived\" }` — retire the form non-destructively. Every submission is kept (unlike `DELETE /api/forms/{id}`, which refuses once a form has any). The status held at that moment is remembered in `pre_archive_status`. Idempotent: archiving an already-archived form leaves the remembered status untouched.\n" +
            "- `{ \"restore\": true }` — return an archived form to the status it held before archiving. Fails with 409 if the form is not archived. Forms archived before `pre_archive_status` existed fall back to `draft`, never to `published`.\n\n" +
            "Archived and draft forms are excluded from the parent-facing `GET /api/forms/public` routes and from the in-app form selectors.",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: {
                      type: "string",
                      enum: ["draft", "published", "archived"],
                      description: "Set the status. Mutually exclusive with `restore`.",
                    },
                    restore: {
                      type: "boolean",
                      description:
                        "Restore an archived form to its pre-archive status. Mutually exclusive with `status`.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "OK — updated form",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Form" } } },
            },
            "400": { description: "Invalid status, or a missing id/status/restore" },
            "404": { description: "Form not found" },
            "409": { description: "Restore requested for a form that is not archived" },
          },
        },
      },
      "/api/forms/available": {
        get: {
          tags: ["Forms"],
          summary: "Every published form in my organization, with my relationship to it",
          description:
            "The **Available Forms** discovery surface (docs/plans/public-private-forms.md §16).\n\n" +
            "Returns every PUBLISHED form in the caller's organization, each carrying an `access` value:\n\n" +
            "- `granted` — the caller may read it. `reason` says why: `role` (admin/staff are exempt by rule), `public`, or `grant`.\n" +
            "- `none` — private, and the caller holds no row. This is the *requestable* set.\n" +
            "- `pending` — the caller has asked and no administrator has answered.\n" +
            "- `denied` — declined, or the access was revoked. `last_event` distinguishes the two.\n\n" +
            "**Drafts and archived forms never appear, for any role.** They are unpublished and are not served by the anonymous public endpoints either.\n\n" +
            "This is NOT a replacement for `GET /api/forms`: that answers \"what may I read?\" and is what every picker uses. This answers \"what exists, and what is my relationship to it?\" — a superset by design.",
          security: [{ [bearerScheme]: [] }],
          responses: {
            "200": {
              description: "OK — every published form with the caller's access",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "integer" },
                        title: { type: "string" },
                        description: { type: "string", nullable: true },
                        code: { type: "string", nullable: true },
                        access: { type: "string", enum: ["granted", "none", "pending", "denied"] },
                        reason: { type: "string", enum: ["role", "public", "grant"], nullable: true },
                        requested_at: { type: "string", format: "date-time", nullable: true },
                        decided_at: { type: "string", format: "date-time", nullable: true },
                        note: { type: "string", nullable: true },
                        last_event: { type: "string", nullable: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/forms/{id}/visibility": {
        patch: {
          tags: ["Forms"],
          summary: "Set a form's visibility (public | private) — admin",
          description:
            "`public` means every internal member of the organization sees the form, exactly as before this feature existed. `private` means the organization's **School Contacts** (`cdm_contact`) do not see it unless they hold an approved grant — **administrators and `staff` are unaffected either way**.\n\n" +
            "**Switching to private has a side effect.** In the same transaction, every `cdm_contact` in the organization who could see the form one instant before is written an `approved` / `source = 'backfill'` grant — the grandfather. Administrators and `staff` are exempt by rule and get no row. An account that was already **declined or revoked** is deliberately NOT re-granted, so an administrator's decision is never silently reversed.\n\n" +
            "The response is the updated form plus `granted`, the number of accounts newly grandfathered — a number worth showing, because if it is wrong it is wrong in the direction of locking someone out.\n\n" +
            "Switching back to `public` changes no data: the grants stay in place and simply become irrelevant, which is what makes the change reversible.",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["visibility"],
                  properties: {
                    visibility: { type: "string", enum: ["public", "private"] },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "OK — the updated form, plus the number of accounts granted",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Form" } } },
            },
            "400": { description: "Validation error" },
            "404": { description: "Form not found in your organization" },
          },
        },
      },
      "/api/form-access/mine": {
        get: {
          tags: ["Form Access"],
          summary: "Private forms I cannot read, with my status on each",
          description:
            "The locked forms in my organization, each with `access` of `none`, `pending` or `denied`, plus `last_event` so the UI can say *declined* versus *access removed*.\n\n" +
            "This is what makes \"request access\" possible: without it a restricted person cannot even name what they are asking for.\n\n" +
            "Returns `[]` for an administrator or a `staff` account — not as a special case but because the set is genuinely empty: nothing is locked to them.",
          security: [{ [bearerScheme]: [] }],
          responses: { "200": { description: "OK — the locked forms" } },
        },
      },
      "/api/form-access/requests": {
        get: {
          tags: ["Form Access"],
          summary: "The access-request queue — admin",
          description:
            "Requests joined to the requester (name, e-mail, school) and the form. `?status=pending` (the default) | `approved` | `denied`, oldest first.\n\n" +
            "**This is the entire notification mechanism** — nothing pushes. The pending count is rendered on the closed Settings section title, because a count inside a closed section is a count nobody sees.",
          security: [{ [bearerScheme]: [] }],
          parameters: [
            {
              name: "status",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["pending", "approved", "denied"] },
            },
          ],
          responses: { "200": { description: "OK — the queue" } },
        },
        post: {
          tags: ["Form Access"],
          summary: "Request access to a private form",
          description:
            "`{ form_id }` — the caller's own row becomes `pending` and a `requested` event is written. The USER comes from the session, never the body.\n\n" +
            "Idempotent for a row already `pending`.\n\n" +
            "**Refused with 400** for a form that is not private, for a form the caller can already read, and — importantly — for a row that is already **`denied`**. A decline is final from the requester's side: if this upserted over it, a declined person could re-ask by pressing a button and the administrator's decision would mean nothing.",
          security: [{ [bearerScheme]: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["form_id"],
                  properties: { form_id: { type: "integer" } },
                },
              },
            },
          },
          responses: {
            "201": { description: "Requested" },
            "400": { description: "Not private, already readable, or already declined" },
            "404": { description: "Form not found in your organization" },
          },
        },
      },
      "/api/form-access/requests/withdraw": {
        post: {
          tags: ["Form Access"],
          summary: "Withdraw my own pending request",
          description:
            "`{ form_id }` — deletes the caller's own row **only while it is `pending`**, and writes a `withdrawn` event.\n\n" +
            "This cannot change anyone's access — it removes an unanswered question — which is why it is the one self-service action that survives the \"no way back after a decline\" rule.",
          security: [{ [bearerScheme]: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["form_id"],
                  properties: { form_id: { type: "integer" } },
                },
              },
            },
          },
          responses: {
            "200": { description: "Withdrawn" },
            "409": { description: "There is no pending request to withdraw" },
          },
        },
      },
      "/api/form-access/requests/decide": {
        post: {
          tags: ["Form Access"],
          summary: "Approve, decline or revoke a request — admin",
          description:
            "`{ user_id, form_id, decision: \"approve\" | \"decline\" | \"revoke\", note? }`.\n\n" +
            "**One endpoint carrying a `decision` field rather than three routes**, so the state change and its audit row cannot be written differently by different handlers. `revoke` lives here too: it is a decision on an approved row, not a different kind of operation.\n\n" +
            "`approve` → `approved`; `decline` and `revoke` both → `denied`, and the **audit log** is what tells them apart afterwards (`declined` vs `revoked`). A `revoke` applies only to an approved row and a `decline` only to a pending one, so a decision that does not apply answers **409** rather than silently changing the state under a misleading event name.\n\n" +
            "The `event` value is written by the server and is never accepted from the body — a caller must not be able to label their own action in the audit log.",
          security: [{ [bearerScheme]: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["user_id", "form_id", "decision"],
                  properties: {
                    user_id: { type: "integer" },
                    form_id: { type: "integer" },
                    decision: { type: "string", enum: ["approve", "decline", "revoke"] },
                    note: {
                      type: "string",
                      nullable: true,
                      description: "A reason for a decline, shown to the requester.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Decided" },
            "400": { description: "Validation error" },
            "409": { description: "No request in a state this decision applies to" },
          },
        },
      },
      "/api/form-access/grants": {
        get: {
          tags: ["Form Access"],
          summary: "Who has access to this form, and their history — admin",
          description:
            "`?form_id=N` — every account with a relationship to the form, each with its full `form_access_events` timeline.\n\n" +
            "**Includes the people with no row and the people with a `denied` row.** A grants-only list is the shape that hides exactly the account an administrator opened this screen to find, and a revoke control needs a list to revoke from.",
          security: [{ [bearerScheme]: [] }],
          parameters: [
            { name: "form_id", in: "query", required: true, schema: { type: "integer" } },
          ],
          responses: {
            "200": { description: "OK — grants with their event history" },
            "400": { description: "form_id is required" },
          },
        },
      },
      "/api/form-access/summary": {
        get: {
          tags: ["Form Access"],
          summary: "Pending access-request count — admin",
          description:
            "`{ pending: n }`, for the Settings section title. Rendered on the **closed** section, because with no push channel a count inside a closed section is a count nobody sees.",
          security: [{ [bearerScheme]: [] }],
          responses: { "200": { description: "OK — the pending count" } },
        },
      },
      "/api/form-access/user/{userId}": {
        get: {
          tags: ["Form Access"],
          summary: "One account's form-access rows — admin",
          description:
            "The rows that EXIST for this account, for the Edit User drawer.\n\n" +
            "**This is \"grants you have made\", not \"forms this person can read\".** The two differ for a `staff` or admin account, which is exempt by rule and normally holds no row at all — so its list is legitimately empty. Deriving \"forms they can read\" would mean re-running the predicate per form and would offer a Remove button for rows that do not exist.\n\n" +
            "Only PRIVATE forms are listed: a grant on a public form is inert, since the form is readable by everyone regardless.\n\n" +
            "Scoped to the caller's organization — a user in another tenant answers **404**, not 403, so the two are indistinguishable.",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "userId", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            "200": { description: "OK — the account's access rows" },
            "404": { description: "No such user in your organization" },
          },
        },
      },
      "/api/form-access/user/{userId}/remove": {
        post: {
          tags: ["Form Access"],
          summary: "Remove one account's access to one form — admin",
          description:
            "`{ form_id }` — writes `denied` and a `revoked` event, exactly as the queue's Revoke does, so the two paths cannot disagree about what a removal looks like. `denied` also means the grandfather will NOT re-grant this account on a later flip, which is what makes the removal stick.\n\n" +
            "**Refuses a PUBLIC form with 409.** On a public form every internal member can read it regardless of any row, so removing a grant would appear to succeed while changing nothing — the admin would watch the row vanish and the person would still open the form. The message says to make the form private first.\n\n" +
            "The USER comes from the path and the FORM from the body, so a removal cannot be redirected to a different account than the one the admin has open.",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "userId", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["form_id"],
                  properties: { form_id: { type: "integer" } },
                },
              },
            },
          },
          responses: {
            "200": { description: "Removed" },
            "404": { description: "No such user in your organization, or no such form" },
            "409": { description: "The form is public, or the account has no row for it" },
          },
        },
      },
      "/api/submissions/{publicId}": {
        get: {
          tags: ["Submissions"],
          summary: "Get a submission with values and ad-hoc fields",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "publicId", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "OK",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Submission" } } },
            },
            "404": { description: "Submission not found" },
          },
        },
        delete: {
          tags: ["Submissions"],
          summary: "Delete an archived submission permanently — admin, irreversible",
          description:
            "Removes the submission and everything hanging off it: its answers (`submission_values`), its ad-hoc fields (`submission_adhoc_fields`) and its generated-document rows (`documents`). Those three are removed by this call itself, in one transaction, and not by the database's `ON DELETE CASCADE` — `schema.ts` declares the cascade, but every `CREATE TABLE` there is guarded by `IF OBJECT_ID(…) IS NULL`, so a database created by an earlier revision of that DDL carries the same three foreign keys with `NO ACTION` and a delete that leaned on the cascade would answer 500 on it.\n\n" +
            "**The submission must already be archived.** The archive-first rule is part of the DELETE's own `WHERE` clause, so it cannot be bypassed by racing a restore: a row that is not archived matches nothing, the child removes are unwound, and the call answers **409** — the same status archiving and restoring use for a no-op. This is why the app's every control asks for the reversible action before offering the irreversible one.\n\n" +
            "**What is NOT deleted:** the generated Google Doc file itself, and any files the answers reference. Nothing in this app has ever had a path that deletes from the organization's Drive folder. The `documents` row that pointed at the file goes with the submission, so the file becomes unreachable from here — but it still exists in Drive, and it is the caller's business to know that. `webhook_events` rows also survive: that table has no foreign key to `submissions` on purpose, because the intake log is a record of what arrived and keeps its `submission_id` as evidence.\n\n" +
            "**A background document generation can race this call — one known, deliberately unclosed window.** Generation is fire-and-forget: a staff save that ticks the staff-only \"Generate document\" checkbox calls `maybeGenerateDocument`, and `POST /api/documents/{id}/retry` does the same, both ending in `void generateDocument(…).catch(() => undefined)`. If one is in flight as this delete commits, the outcome depends on where its `documents` INSERT lands. After the whole transaction: the insert fails on the now-missing parent, the error is swallowed, and nothing is written. *Between* this call's child removes and its parent remove: the new child re-blocks the parent delete, so this call answers **500** instead of 204 — retry it and it will succeed, no row is left behind. In the last case — a retry row that existed before the transaction and is being regenerated while the delete commits — a Google Doc can be created for a submission that no longer exists, leaving a file in the organization's Drive folder that nothing here points at. Closing the window would need either `ON DELETE CASCADE` on the live database's three child keys (a schema change this app is forbidden from imposing on a database it did not create) or a lock shared across app instances (there is none — a per-process guard would serialize nothing under App Service scale-out, so it would *look* like a fix while guaranteeing nothing). Documented rather than half-guarded. See `maybeGenerateDocument` in `google/docs.ts`.\n\n" +
            "Fails with **404** for an unknown public id and **403** for a submission in another school — checked before the delete, so a row the caller cannot see never gets the 409 that would imply it exists.\n\n" +
            "**Admin-only**, unlike archive and restore, because this one cannot be walked back. 204 with no body: there is no row left to describe.",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "publicId", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "204": { description: "Deleted" },
            "401": { description: "Not authenticated" },
            "403": { description: "Forbidden — admin required, or the submission belongs to another school" },
            "404": { description: "Submission not found" },
            "409": { description: "This submission must be archived before it can be deleted" },
          },
        },
      },
      "/api/submissions/archive/counts": {
        get: {
          tags: ["Submissions"],
          summary: "How many submissions the current filter has on each side of the archive line",
          description:
            "Returns `{ active, archived }` for the SAME filters `GET /api/submissions` accepts, so a grid can state out loud what it is not showing (\"4 archived hidden\") instead of silently dropping rows.\n\n" +
            "`active` is the count the unarchived list would return and `archived` the count the Archive view would return; together they are every submission the filter matches. Both are computed in ONE statement, so the pair cannot disagree with itself — a row archived between two separate counts would otherwise be counted on neither side (or twice).\n\n" +
            "A side with no rows reports a real `0`, never `null` and never a missing key.",
          security: [{ [bearerScheme]: [] }],
          parameters: [
            { name: "school_id", in: "query", schema: { type: "integer" }, required: false },
            { name: "form_id", in: "query", schema: { type: "integer" }, required: false },
            { name: "status", in: "query", schema: { type: "string" }, required: false },
            { name: "from", in: "query", schema: { type: "string" }, required: false },
            { name: "to", in: "query", schema: { type: "string" }, required: false },
          ],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["active", "archived"],
                    properties: {
                      active: { type: "integer", description: "Matching submissions that are in the views." },
                      archived: { type: "integer", description: "Matching submissions that are archived." },
                    },
                  },
                },
              },
            },
            "401": { description: "Not authenticated" },
          },
        },
      },
      "/api/submissions/{publicId}/archive": {
        post: {
          tags: ["Submissions"],
          summary: "Archive a submission (staff/admin)",
          description:
            "Hides a submission from every view: the admin dashboard, the staff queue, the login-page stat box, form submission counts, CSV/JSON exports, report previews and the Documents list. The row itself is untouched — answers, staff-only fields, ad-hoc fields and generated Google documents all remain, which is what makes this the non-destructive step that `DELETE /api/submissions/{publicId}` (admin-only, irreversible) requires first.\n\n" +
            "Archiving is orthogonal to `status`: the workflow state (`submitted` / `in_review` / `flagged` / `completed`) is not changed, so restoring returns the submission to exactly the state it left. A `status` of `archived` does not exist and is rejected.\n\n" +
            "Returns the updated submission, including `archived_at` and `archived_by` (with `archived_by_name` resolved) and the `documents` array.\n\n" +
            "Available to staff and school contacts as well as admins, like the rest of this resource: the row is resolved by public id (organization-scoped) and then gated on the actor's school, so the reach is the actor's own schools either way. No-op when already archived — see the 409.\n\n" +
            "The row is still readable by public id afterwards; `GET /api/submissions/{publicId}` returns it with `archived_at` set so the detail page can render an Archived banner with a Restore button.",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "publicId", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "OK — the updated submission, now archived",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Submission" } } },
            },
            "401": { description: "Not authenticated" },
            "403": { description: "Forbidden — the submission belongs to another school" },
            "404": { description: "Submission not found" },
            "409": { description: "This submission is already archived" },
          },
        },
      },
      "/api/submissions/{publicId}/restore": {
        post: {
          tags: ["Submissions"],
          summary: "Restore an archived submission (staff/admin)",
          description:
            "Returns an archived submission to every view. This only clears the archive marker (`archived_at` and `archived_by`), so the submission reappears under the workflow status it held when it was archived — nothing about the answers, documents or staff-only fields is rebuilt.\n\n" +
            "Same guards as archiving: whoever can put a row away can take it back out. Returns the updated submission. Fails with 409 if the submission is not archived, so a double-click cannot report a change that did not happen.",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "publicId", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "OK — the updated submission, no longer archived",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Submission" } } },
            },
            "401": { description: "Not authenticated" },
            "403": { description: "Forbidden — the submission belongs to another school" },
            "404": { description: "Submission not found" },
            "409": { description: "This submission is not archived" },
          },
        },
      },
      "/api/submissions/{publicId}/status": {
        patch: {
          tags: ["Submissions"],
          summary: "Update a submission's status (staff/admin)",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "publicId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["status"],
                  properties: { status: { type: "string", enum: ["submitted", "in_review", "flagged", "completed"] } },
                },
              },
            },
          },
          responses: {
            "200": { description: "OK — updated submission" },
            "404": { description: "Submission not found" },
          },
        },
      },
      "/api/submissions/{publicId}/values": {
        put: {
          tags: ["Submissions"],
          summary: "Update a submission's field values (staff/admin)",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "publicId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["answers"],
                  properties: {
                    answers: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: { field_id: { type: "integer" }, value: { type: "object", nullable: true } },
                      },
                    },
                    staff_only: { type: "boolean" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "OK — updated submission" },
            "400": { description: "Validation error" },
            "404": { description: "Submission not found" },
          },
        },
      },
      "/api/submissions/{publicId}/adhoc": {
        get: {
          tags: ["Submissions"],
          summary: "List ad-hoc staff-only fields on a submission",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "publicId", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/AdhocField" } } },
              },
            },
            "404": { description: "Submission not found" },
          },
        },
        post: {
          tags: ["Submissions"],
          summary: "Add a staff-only ad-hoc field (staff/admin)",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "publicId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["label", "type"],
                  properties: {
                    label: { type: "string" },
                    type: { type: "string", enum: ["text", "textarea", "number", "date", "select", "checkbox", "radio", "email", "google_doc"] },
                    options: { type: "array", items: { type: "string" }, nullable: true },
                    value: { type: "object", nullable: true },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Created",
              content: { "application/json": { schema: { $ref: "#/components/schemas/AdhocField" } } },
            },
            "400": { description: "Validation error" },
            "404": { description: "Submission not found" },
          },
        },
      },
      "/api/submissions/{publicId}/adhoc/{fieldId}": {
        put: {
          tags: ["Submissions"],
          summary: "Update an ad-hoc field (staff/admin)",
          security: [{ [bearerScheme]: [] }],
          parameters: [
            { name: "publicId", in: "path", required: true, schema: { type: "string" } },
            { name: "fieldId", in: "path", required: true, schema: { type: "integer" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["label", "type"],
                  properties: {
                    label: { type: "string" },
                    type: { type: "string", enum: ["text", "textarea", "number", "date", "select", "checkbox", "radio", "email", "google_doc"] },
                    options: { type: "array", items: { type: "string" }, nullable: true },
                    value: { type: "object", nullable: true },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "OK — updated field",
              content: { "application/json": { schema: { $ref: "#/components/schemas/AdhocField" } } },
            },
            "404": { description: "Submission or field not found" },
          },
        },
        delete: {
          tags: ["Submissions"],
          summary: "Remove an ad-hoc field (staff/admin)",
          security: [{ [bearerScheme]: [] }],
          parameters: [
            { name: "publicId", in: "path", required: true, schema: { type: "string" } },
            { name: "fieldId", in: "path", required: true, schema: { type: "integer" } },
          ],
          responses: {
            "200": {
              description: "OK — remaining fields",
              content: {
                "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/AdhocField" } } },
              },
            },
            "404": { description: "Submission or field not found" },
          },
        },
      },
      "/api/submissions/{publicId}/adhoc/{fieldId}/promote": {
        post: {
          tags: ["Submissions"],
          summary: "Promote a captured field to a real form field (admin)",
          description:
            "Turns a captured (Google Form) question into a real field on the form, then moves the " +
            "captured answer into it — on THIS submission and on every other submission of the same " +
            "form carrying the same question title. Future responses with that title are matched to " +
            "the new field automatically, so the Google Form needs no change. The captured copies are " +
            "removed, so the answer is never shown twice. Admin-only: it writes the form's definition, " +
            "which every other form-design route also restricts to admin. Every body key is optional — " +
            "an empty body promotes the question as a text field and backfills.",
          security: [{ [bearerScheme]: [] }],
          parameters: [
            { name: "publicId", in: "path", required: true, schema: { type: "string" } },
            { name: "fieldId", in: "path", required: true, schema: { type: "integer" } },
          ],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    type: {
                      type: "string",
                      enum: ["text", "textarea", "number", "date", "select", "checkbox", "radio", "email", "google_doc"],
                      description: "Defaults to the captured field's own type, which is always `text`.",
                    },
                    options: { type: "array", items: { type: "string" }, nullable: true },
                    required: { type: "boolean", description: "Default false." },
                    staff_only: {
                      type: "boolean",
                      description: "Default false — the question came from a parent-facing form, so promoting it must not hide it from future parents.",
                    },
                    backfill: {
                      type: "boolean",
                      description: "Default true. Set false to migrate only this submission.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "OK — the new field, how many submissions were migrated, and the re-read submission",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      field: { $ref: "#/components/schemas/FormField" },
                      migrated_submissions: { type: "integer" },
                      submission: { $ref: "#/components/schemas/Submission" },
                    },
                  },
                },
              },
            },
            "400": { description: "Validation error" },
            "404": { description: "Submission or field not found" },
          },
        },
      },
      "/api/users": {
        get: {
          tags: ["Users"],
          summary: "List users in the admin's org (admin)",
          security: [{ [bearerScheme]: [] }],
          responses: {
            "200": {
              description: "OK — safe user list (no password hashes)",
              content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/AdminUser" } } } },
            },
            "401": { description: "Unauthorized" },
            "403": { description: "Forbidden (not admin)" },
          },
        },
        post: {
          tags: ["Users"],
          summary: "Create a user within the admin's org (admin)",
          security: [{ [bearerScheme]: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["email", "password", "role"],
                  properties: {
                    email: { type: "string", format: "email" },
                    password: { type: "string", minLength: 8 },
                    display_name: { type: "string" },
                    role: { type: "string", enum: ["admin", "staff", "cdm_contact"] },
                    school_id: { type: "integer", nullable: true },
                    organization_id: { type: "integer", nullable: true },
                    show_on_test_screen: {
                      type: "boolean",
                      description:
                        "Offer this account in the select-mode (\"Test\") login dropdown. Defaults to false.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "201": { description: "Created" },
            "400": { description: "Validation error" },
            "409": { description: "Email already registered" },
            "401": { description: "Unauthorized" },
            "403": { description: "Forbidden (not admin)" },
          },
        },
      },
      "/api/users/{id}": {
        put: {
          tags: ["Users"],
          summary: "Edit a user (admin)",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    email: { type: "string", format: "email" },
                    display_name: { type: "string" },
                    role: { type: "string", enum: ["admin", "staff", "cdm_contact"] },
                    school_id: { type: "integer", nullable: true },
                    active: { type: "boolean" },
                    organization_id: { type: "integer", nullable: true },
                    show_on_test_screen: {
                      type: "boolean",
                      description:
                        "Show this user in the select-mode (\"Test\") login dropdown. Off by default.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "OK — updated user" },
            "400": { description: "Validation error / cannot deactivate self" },
            "404": { description: "User not found" },
            "409": { description: "Email already registered" },
          },
        },
      },
      "/api/users/{id}/reset-password": {
        post: {
          tags: ["Users"],
          summary: "Reset a user's password (admin)",
          description:
            "Issues a one-time temporary password for a user in the caller's own organization and " +
            "returns it in the response. The value is never stored in recoverable form, so it cannot " +
            "be shown again. The account is flagged `must_change_password`, and the client will not " +
            "render the app for that user until they replace it via POST /api/auth/change-password " +
            "(which is also the only call that clears the flag).\n\n" +
            "An administrator cannot reset their own password here — use POST /api/auth/change-password. " +
            "The endpoint exists because there is no email/forgot-password flow, so without it an " +
            "account whose password is forgotten is unreachable, including the sole admin's.",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            "200": {
              description: "OK — the temporary password, shown only once",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "integer" },
                      email: { type: "string", format: "email" },
                      display_name: { type: "string" },
                      temporary_password: { type: "string" },
                      must_change_password: { type: "boolean" },
                    },
                  },
                },
              },
            },
            "400": { description: "Invalid user id / cannot reset your own password" },
            "403": { description: "User belongs to another organization" },
            "404": { description: "User not found" },
          },
        },
      },
      "/api/schools/columns": {
        get: {
          tags: ["Schools"],
          summary: "Get the school import table columns (admin)",
          security: [{ [bearerScheme]: [] }],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { columns: { type: "array", items: { type: "string" } } } },
                },
              },
            },
          },
        },
      },
      "/api/schools/page": {
        get: {
          tags: ["Schools"],
          summary: "Paginated school listing (admin)",
          security: [{ [bearerScheme]: [] }],
          parameters: [
            { name: "page", in: "query", schema: { type: "integer" }, required: false },
            { name: "pageSize", in: "query", schema: { type: "integer" }, required: false },
          ],
          responses: {
            "200": {
              description: "OK",
              content: { "application/json": { schema: { $ref: "#/components/schemas/SchoolPage" } } },
            },
          },
        },
      },
      "/api/schools/import": {
        post: {
          tags: ["Schools"],
          summary: "Manual import from the GeoJSON school feed (admin)",
          security: [{ [bearerScheme]: [] }],
          responses: {
            "200": {
              description: "OK — imported count",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ImportResult" } } },
            },
            "400": { description: "SCHOOL_JSON not configured" },
            "502": { description: "Failed to fetch feed" },
          },
        },
      },
      "/api/schools/aliases": {
        get: {
          tags: ["Schools"],
          summary: "List admin-confirmed school-name aliases (admin)",
          security: [{ [bearerScheme]: [] }],
          responses: { "200": { description: "OK" } },
        },
        post: {
          tags: ["Schools"],
          summary: "Match a submitted school spelling to an app school (admin)",
          description:
            "Records an explicit, admin-made pairing of a submitted spelling to an app school, and " +
            "re-files the active submissions carrying that spelling onto the chosen school (so its " +
            "staff can open them). Pass `school_id: null` to Ignore a spelling that is not a school — " +
            "that records the decision but moves no submission. There is no fuzzy matching.",
          security: [{ [bearerScheme]: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["submitted_name"],
                  properties: {
                    submitted_name: { type: "string" },
                    display_name: { type: "string", nullable: true },
                    school_id: {
                      type: "integer",
                      nullable: true,
                      description: "The app school; omit/null to Ignore the spelling.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "201": { description: "Created — { alias, relocated }" },
            "400": { description: "Validation failed, or school_id does not match a school" },
          },
        },
      },
      "/api/schools/aliases/unmatched": {
        get: {
          tags: ["Schools"],
          summary: "Submitted school spellings that match no school (admin)",
          security: [{ [bearerScheme]: [] }],
          responses: { "200": { description: "OK" } },
        },
      },
      "/api/schools/aliases/{id}": {
        delete: {
          tags: ["Schools"],
          summary: "Remove a school-name alias (admin)",
          description:
            "Reverts future routing only: rows a previous Match already re-filed keep their school_id.",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            "200": { description: "OK" },
            "404": { description: "Alias not found" },
          },
        },
      },
      "/api/webhook/events": {
        get: {
          tags: ["Webhooks"],
          summary: "List inbound webhook attempts (admin)",
          description:
            "One page of the inbound webhook log, newest first, with the counts for the same " +
            "filter. Only attempts belonging to the caller's organization are returned; " +
            "`unattributed` reports how many attempts could not be tied to any organization. " +
            "The stored payload is deliberately NOT included — fetch the row by id for that.",
          security: [{ [bearerScheme]: [] }],
          parameters: [
            { name: "status", in: "query", schema: { type: "string", enum: ["succeeded", "failed"] } },
            { name: "auth_result", in: "query", schema: { type: "string", enum: ["ok", "invalid", "missing"] } },
            { name: "form_id", in: "query", schema: { type: "integer" } },
            { name: "from", in: "query", schema: { type: "string", format: "date-time" } },
            { name: "to", in: "query", schema: { type: "string", format: "date-time" } },
            { name: "search", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 100, maximum: 500 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          ],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      events: { type: "array", items: { $ref: "#/components/schemas/WebhookEvent" } },
                      stats: {
                        type: "object",
                        properties: {
                          succeeded: { type: "integer" },
                          failed: { type: "integer" },
                          total: { type: "integer" },
                        },
                      },
                      unattributed: { type: "integer" },
                      retention: { $ref: "#/components/schemas/WebhookRetention" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/webhook/events/summary": {
        get: {
          tags: ["Webhooks"],
          summary: "Webhook counters for the dashboard and the republish prompt (admin)",
          description:
            "Counts only, no rows. `window` is the last `days` days, or all time when `days` is " +
            "0; `form` is present when `form_id` is supplied and gives that form's all-time " +
            "totals, which is how the publish prompt knows there are responses waiting to be " +
            "replayed.",
          security: [{ [bearerScheme]: [] }],
          parameters: [
            {
              name: "days",
              in: "query",
              description: "Trailing window in days. `0` means all time.",
              schema: { type: "integer", default: 7, minimum: 0, maximum: 365 },
            },
            { name: "form_id", in: "query", schema: { type: "integer" } },
          ],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      days: { type: "integer" },
                      window: {
                        type: "object",
                        properties: { succeeded: { type: "integer" }, failed: { type: "integer" } },
                      },
                      form: {
                        type: "object",
                        nullable: true,
                        properties: {
                          form_id: { type: "integer" },
                          succeeded: { type: "integer" },
                          failed: { type: "integer" },
                          total: { type: "integer" },
                        },
                      },
                      unattributed: { type: "integer" },
                      retention: { $ref: "#/components/schemas/WebhookRetention" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/webhook/events/{id}": {
        get: {
          tags: ["Webhooks"],
          summary: "Get one webhook attempt, stored payload included (admin)",
          description:
            "The full log row plus `payload_raw`. 404 covers both \"no such row\" and " +
            "\"not in your organization\" on purpose, so the response cannot be used to " +
            "probe for another organization's events.",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            "200": {
              description: "OK",
              content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookEvent" } } },
            },
            "400": { description: "Invalid event id" },
            "404": { description: "Event not found" },
          },
        },
      },
      "/api/webhook/events/{id}/replay": {
        post: {
          tags: ["Webhooks"],
          summary: "Replay one stored webhook attempt (admin)",
          description:
            "Re-runs the CURRENT intake rules against the STORED payload — the payload is " +
            "unchanged but \"is this form published?\" is answered with today's answer, so a " +
            "response lost while the form was unpublished can be delivered after it is " +
            "republished. The submission is filed under the school year of the ORIGINAL " +
            "arrival and the result is recorded as a new log row linked by `replay_of`. " +
            "Replay is one-shot: it is refused with 409 if the attempt already succeeded, " +
            "has no stored payload, or has already been replayed successfully.",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            "200": {
              description: "Processed — the body reports whether delivery succeeded",
              content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookReplayResult" } } },
            },
            "400": { description: "Invalid event id" },
            "404": { description: "Event not found" },
            "409": { description: "Not replayable (already delivered, already replayed, or no stored payload)" },
          },
        },
      },
      "/api/webhook/events/replay": {
        post: {
          tags: ["Webhooks"],
          summary: "Replay many stored webhook attempts (admin)",
          description:
            "Bulk replay. Supply `event_ids`, or `form_id` to replay every eligible failed " +
            "attempt for that form (oldest first, so submission numbers stay in arrival " +
            "order). Each row is checked with the same guards as the single-row endpoint and " +
            "they run sequentially, so this is exactly N safe single replays. Capped at 200 " +
            "rows per call.",
          security: [{ [bearerScheme]: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    event_ids: { type: "array", items: { type: "integer" } },
                    form_id: { type: "integer" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      attempted: { type: "integer" },
                      succeeded: { type: "integer" },
                      failed: { type: "integer" },
                      skipped: { type: "integer" },
                      results: {
                        type: "array",
                        items: { $ref: "#/components/schemas/WebhookReplayResult" },
                      },
                    },
                  },
                },
              },
            },
            "400": { description: "Neither event_ids nor form_id supplied" },
          },
        },
      },
      "/api/documents": {
        get: {
          tags: ["Documents"],
          summary: "List generated documents (staff/admin)",
          description: "Staff sees documents for their school; admin sees documents for their organization. Returns the enriched ListDocumentRow[].",
          security: [{ [bearerScheme]: [] }],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/ListDocumentRow" } } },
              },
            },
          },
        },
      },
      "/api/submissions/{publicId}/documents": {
        get: {
          tags: ["Documents"],
          summary: "List documents for a submission (staff/admin)",
          description: "The submission's generated documents (enriched rows), used by the staff detail card. Staff must own the submission's school.",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "publicId", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/ListDocumentRow" } } },
              },
            },
            "403": { description: "Forbidden (staff from another school)" },
            "404": { description: "Submission not found" },
          },
        },
      },
      "/api/documents/{id}/retry": {
        post: {
          tags: ["Documents"],
          summary: "Retry a failed document generation (staff/admin)",
          description: "Resets a Failed (or stale Pending) document to Pending and re-runs the Google generator in the background. Fire-and-forget — responds immediately with the current row.",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            "200": {
              description: "OK — document status (Pending while the job runs)",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ListDocumentRow" } } },
            },
            "400": { description: "Document already completed / invalid id" },
            "403": { description: "Forbidden (staff from another school)" },
            "404": { description: "Document not found" },
          },
        },
      },
      "/api/documents/{id}/regenerate": {
        post: {
          tags: ["Documents"],
          summary: "Regenerate a document from the submission's current values (staff/admin)",
          description: "Force a brand-new Google Doc from the submission's CURRENT answer values, even if a Completed one already exists. Creates a fresh Pending row synchronously and returns it; the Google generation runs in the background. Use this when a submission's answers were corrected and the document must reflect them.",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            "200": {
              description: "OK — the newly-created Pending document row",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ListDocumentRow" } } },
            },
            "400": { description: "Invalid document id" },
            "403": { description: "Forbidden (staff from another school)" },
            "404": { description: "Document not found" },
          },
        },
      },
      "/api/system-messages/active": {
        get: {
          tags: ["System Messages"],
          summary: "The notices this user has not closed out yet (any signed-in role)",
          description:
            "At most three, newest first. Scoped to the caller's organization AND to the caller's " +
            "role: a message whose audience does not include that role is filtered out inside the " +
            "same query as the three-row cap, so the cap counts only messages this user may " +
            "actually see. A message with no audience set is shown to every role.",
          security: [{ [bearerScheme]: [] }],
          responses: {
            "200": {
              description: "OK — an array, empty when there is nothing to show",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/SystemMessage" } },
                },
              },
            },
            "403": { description: "The account belongs to no organization" },
          },
        },
      },
      "/api/system-messages": {
        get: {
          tags: ["System Messages"],
          summary: "List every system message in the organization (admin)",
          description:
            "Newest first, active and inactive alike — an inactive message has to appear here so " +
            "it can be switched back on. Scoped to the caller's organization.",
          security: [{ [bearerScheme]: [] }],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/SystemMessage" } },
                },
              },
            },
            "403": { description: "The account belongs to no organization" },
          },
        },
        post: {
          tags: ["System Messages"],
          summary: "Create a system message (admin)",
          description:
            "`created_by` comes from the session and cannot be set by the body. An omitted or null " +
            "`audience` means every role; an empty array means nobody.",
          security: [{ [bearerScheme]: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["title"],
                  properties: {
                    title: { type: "string", maxLength: 200 },
                    body: { type: "string", maxLength: 4000, default: "" },
                    active: { type: "boolean", default: false },
                    audience: {
                      type: "array",
                      nullable: true,
                      items: { type: "string", enum: ["admin", "staff", "cdm_contact"] },
                    },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Created",
              content: { "application/json": { schema: { $ref: "#/components/schemas/SystemMessage" } } },
            },
            "400": { description: "Validation failed (empty title, unknown role, over-long body)" },
            "403": { description: "The account belongs to no organization" },
          },
        },
      },
      "/api/system-messages/{id}": {
        put: {
          tags: ["System Messages"],
          summary: "Update a system message (admin)",
          description:
            "Partial: an omitted field is left alone. `audience` needs that distinction more than " +
            "the others — an omitted key means \"leave the audience as it is\" while an explicit " +
            "null means \"show this to everyone again\". An empty array still means nobody.",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    title: { type: "string", maxLength: 200 },
                    body: { type: "string", maxLength: 4000 },
                    active: { type: "boolean" },
                    audience: {
                      type: "array",
                      nullable: true,
                      items: { type: "string", enum: ["admin", "staff", "cdm_contact"] },
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "OK",
              content: { "application/json": { schema: { $ref: "#/components/schemas/SystemMessage" } } },
            },
            "400": { description: "Empty body, or validation failed" },
            "403": { description: "The account belongs to no organization" },
            "404": { description: "Message not found (or not in your organization)" },
          },
        },
        delete: {
          tags: ["System Messages"],
          summary: "Delete a system message (admin)",
          description:
            "Removes the message and every user's close-out row for it. 404 covers both \"no such " +
            "message\" and \"not in your organization\" deliberately, so the response cannot be " +
            "used to probe for another organization's messages.",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { deleted: { type: "boolean" } } },
                },
              },
            },
            "400": { description: "Invalid message id" },
            "403": { description: "The account belongs to no organization" },
            "404": { description: "Message not found" },
          },
        },
      },
      "/api/system-messages/{id}/dismiss": {
        post: {
          tags: ["System Messages"],
          summary: "Close a message out for this user (any signed-in role)",
          description:
            "Idempotent — dismissing the same message twice is a 200 both times, because the X " +
            "button is small and users double click it. 404 when the id is not in the caller's " +
            "organization, so a repeat is never silently mistaken for someone else's message.",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { dismissed: { type: "boolean" } } },
                },
              },
            },
            "400": { description: "Invalid message id" },
            "403": { description: "The account belongs to no organization" },
            "404": { description: "Message not found" },
          },
        },
      },
    },
  };
}
