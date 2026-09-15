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
      description: `REST API for the School Forms application.\n\n**Roles:** \`admin\` and \`staff\` only. **Parents submit anonymously** (no auth).\n\n- Admins design forms, view all submissions in a spreadsheet view, filter, and export.\n- Staff register, choose their school, view only their school's submissions, and add staff-only comments.\n\nAuth uses JWT access tokens (15 min) with an httpOnly refresh cookie (7 days).`,
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
            role: { type: "string", enum: ["admin", "staff"] },
            school_id: { type: "integer", nullable: true },
            organization_id: { type: "integer", nullable: true },
            display_name: { type: "string" },
          },
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
            type: { type: "string", enum: ["text", "textarea", "number", "date", "select", "checkbox", "radio", "email"] },
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
            code: { type: "string", nullable: true },
            submission_seq: { type: "integer" },
            doc_folder_id: { type: "string", nullable: true, description: "Google Drive parent folder for this form's generated documents. NULL falls back to the global env folder." },
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
            status: { type: "string", enum: ["submitted", "in_review", "flagged", "resolved"] },
            submission_seq: { type: "integer", nullable: true },
            submitted_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
            school_year: { type: "string", nullable: true, description: "School year this submission belongs to (e.g. 2026-2027). Derived from submitted_at using an Aug 1 - Jul 31 boundary." },
            staff_fields_updated_by: { type: "integer", nullable: true },
            staff_fields_updated_at: { type: "string", format: "date-time", nullable: true },
            staff_fields_updated_by_name: { type: "string", nullable: true },
            values: { type: "array", items: { $ref: "#/components/schemas/SubmissionValue" } },
            comments: { type: "array", items: { $ref: "#/components/schemas/Comment" } },
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
        Comment: {
          type: "object",
          required: ["id", "body"],
          properties: {
            id: { type: "integer" },
            submission_id: { type: "integer" },
            staff_id: { type: "integer" },
            staff_name: { type: "string" },
            body: { type: "string" },
            visibility: { type: "string", enum: ["internal"] },
            created_at: { type: "string", format: "date-time" },
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
          },
        },
        ViewColumnsConfig: {
          type: "object",
          properties: {
            columns: {
              type: "array",
              items: { $ref: "#/components/schemas/ExportColumn" },
            },
            viewKeys: {
              type: "array",
              description: "The subset of column keys currently displayed in the Submissions grid. When unconfigured, this equals all column keys.",
              items: { type: "string" },
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
            type: { type: "string", enum: ["text", "textarea", "number", "date", "select", "checkbox", "radio", "email"] },
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
          summary: "Get a public app setting (login_mode / maintenance_message / documents_link)",
          security: [],
          parameters: [
            { name: "key", in: "path", required: true, schema: { type: "string", enum: ["login_mode", "maintenance_message", "documents_link"] } },
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
            { name: "key", in: "path", required: true, schema: { type: "string", enum: ["login_mode", "maintenance_message", "documents_link"] } },
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
                        role: { type: "string", enum: ["admin", "staff"] },
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
          summary: "Register a staff user",
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
                    role: { type: "string", enum: ["staff"] },
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
          summary: "Get a form's view-columns config (admin)",
          description: "Returns the full column list plus the subset of `viewKeys` currently shown in the Submissions grid. This is independent of Export — Export always uses all columns.",
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
          summary: "Save a form's view-columns config (admin)",
          description: "`view_keys` must be an array of `field_N` strings. Stored per-form and only affects the Submissions grid display — Export is unchanged.",
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
            "as POST /api/submissions.",
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
            "Deletes a form that has no submissions. Refuses with 409 when the form has any submission history, because submissions cascade on form delete. Published but unused forms are deletable.",
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
          summary: "Publish/unpublish a form (draft|published|archived) — admin",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["status"],
                  properties: { status: { type: "string", enum: ["draft", "published", "archived"] } },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "OK — updated form",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Form" } } },
            },
            "400": { description: "Invalid status" },
            "404": { description: "Form not found" },
          },
        },
      },
      "/api/submissions/{publicId}": {
        get: {
          tags: ["Submissions"],
          summary: "Get a submission with values, comments, and ad-hoc fields",
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
                  properties: { status: { type: "string", enum: ["submitted", "in_review", "flagged", "resolved"] } },
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
      "/api/submissions/{publicId}/comments": {
        post: {
          tags: ["Submissions"],
          summary: "Add a staff-only comment (staff/admin)",
          security: [{ [bearerScheme]: [] }],
          parameters: [{ name: "publicId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["body"],
                  properties: { body: { type: "string" }, visibility: { type: "string", enum: ["internal"] } },
                },
              },
            },
          },
          responses: {
            "201": { description: "Comment created" },
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
                    type: { type: "string", enum: ["text", "textarea", "number", "date", "select", "checkbox", "radio", "email"] },
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
                    type: { type: "string", enum: ["text", "textarea", "number", "date", "select", "checkbox", "radio", "email"] },
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
      "/api/users": {
        get: {
          tags: ["Users"],
          summary: "List users in the admin's org (admin)",
          security: [{ [bearerScheme]: [] }],
          responses: {
            "200": {
              description: "OK — safe user list (no password hashes)",
              content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/User" } } } },
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
                    role: { type: "string", enum: ["admin", "staff"] },
                    school_id: { type: "integer", nullable: true },
                    organization_id: { type: "integer", nullable: true },
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
                    role: { type: "string", enum: ["admin", "staff"] },
                    school_id: { type: "integer", nullable: true },
                    active: { type: "boolean" },
                    organization_id: { type: "integer", nullable: true },
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
    },
  };
}
