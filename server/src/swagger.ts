import { env } from "./config/env.js";

export function buildSwaggerSpec() {
  const bearerScheme = env.swagger.bearerScheme;
  const baseUrl = env.publicBaseUrl;

  return {
    openapi: "3.0.3",
    info: {
      title: "School Forms API",
      version: "1.0.0",
      description: `REST API for the School Forms application.\n\n**Roles:** \`admin\` and \`staff\` only. **Parents submit anonymously** (no auth).\n\n- Admins design forms, view all submissions in a spreadsheet view, filter, and export.\n- Staff register, choose their school, view only their school's submissions, and add staff-only comments.\n\nAuth uses JWT access tokens (15 min) with an httpOnly refresh cookie (7 days).`,
      contact: { name: "School Forms Team" },
    },
    servers: [
      { url: baseUrl, description: "Development" },
      { url: "https://your-school-forms-api.azurewebsites.net", description: "Azure" },
    ],
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
            values: { type: "array", items: { $ref: "#/components/schemas/SubmissionValue" } },
            comments: { type: "array", items: { $ref: "#/components/schemas/Comment" } },
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
          summary: "Get a public app setting (login_mode / maintenance_message)",
          security: [],
          parameters: [
            { name: "key", in: "path", required: true, schema: { type: "string", enum: ["login_mode", "maintenance_message"] } },
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
            { name: "key", in: "path", required: true, schema: { type: "string", enum: ["login_mode", "maintenance_message"] } },
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
      },
      "/api/schools": {
        get: {
          tags: ["Schools"],
          summary: "List all schools",
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
    },
  };
}
