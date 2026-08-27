import type {
  AuthResponse,
  AdhocField,
  AdminUser,
  Comment,
  ExportPreview,
  Form,
  FormWithFields,
  OrganizationWithMembers,
  PublicForm,
  Role,
  School,
  SchoolPage,
  SubmissionAnswer,
  SubmissionDetail,
  SubmissionRow,
  SubmissionStatus,
  User,
} from "../types";

// Use API base from env or dev proxy (vite proxy sends /api to backend).
const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

const TOKEN_KEY = "school_forms_access_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
}

// True while a /auth/refresh is in flight, so concurrent 401s share one refresh
// instead of stampeding the endpoint.
let refreshing: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data?.access_token) {
        setToken(data.access_token);
        return data.access_token as string;
      }
      return null;
    } catch {
      return null;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.auth !== false) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method || "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: "include",
  });

  // If the access token expired (401) and this was an authenticated call, try
  // once to refresh the token (the refresh token lives in an httpOnly cookie)
  // and replay the original request.
  if (res.status === 401 && opts.auth !== false) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      headers.Authorization = `Bearer ${newToken}`;
      const retry = await fetch(`${API_BASE}${path}`, {
        method: opts.method || "GET",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        credentials: "include",
      });
      if (retry.ok) {
        if (retry.status === 204) return undefined as T;
        return (await retry.json()) as T;
      }
      return await handleError(retry);
    }
  }

  // Success — parse and return the response body.
  if (res.ok) {
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  return await handleError(res);
}

// Parse a failed response into an ApiError. When the status is 401 the access
// token could not be refreshed (session is genuinely gone), so we clear it to
// keep the app from retrying with a dead token.
async function handleError(res: Response): Promise<never> {
  let detail = res.statusText;
  try {
    const data = (await res.json()) as { error?: string; message?: string } | null;
    if (data?.error) detail = data.error;
    else if (data?.message) detail = data.message;
  } catch {
    // ignore parse errors
  }
  if (res.status === 401) clearToken();
  throw new ApiError(res.status, detail);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
export const api = {
  async login(email: string, password: string): Promise<AuthResponse> {
    return request<AuthResponse>("/api/auth/login", {
      method: "POST",
      auth: false,
      body: { email, password },
    });
  },

  async registerStaff(input: {
    email: string;
    password: string;
    display_name: string;
    school_id: number;
    slug?: string;
  }): Promise<AuthResponse> {
    return request<AuthResponse>("/api/auth/register", {
      method: "POST",
      auth: false,
      body: { ...input, role: "staff" },
    });
  },

  async me(): Promise<User> {
    return request<User>("/api/auth/me", { auth: true });
  },

  async logout(): Promise<void> {
    try {
      await request<{ message: string }>("/api/auth/logout", {
        method: "POST",
        auth: true,
      });
    } finally {
      clearToken();
    }
  },

  async listSchools(): Promise<School[]> {
    // Sends the token when present so a logged-in non-admin is scoped to their
    // own school; anonymous registration callers get the full public list.
    return request<School[]>("/api/auth/schools", { auth: true });
  },

  // -------------------------------------------------------------------------
  // Organizations (admin Settings → Organizations panel)
  // -------------------------------------------------------------------------
  async listOrganizations(): Promise<OrganizationWithMembers[]> {
    return request<OrganizationWithMembers[]>("/api/organizations", { auth: true });
  },

  async listSchoolColumns(): Promise<{ columns: string[] }> {
    return request<{ columns: string[] }>("/api/schools/columns", { auth: true });
  },

  async listSchoolsPage(page = 1, pageSize = 50): Promise<SchoolPage> {
    return request<SchoolPage>(`/api/schools/page?page=${page}&pageSize=${pageSize}`, { auth: true });
  },

  async importSchools(): Promise<{ total: number }> {
    return request<{ total: number }>("/api/schools/import", { method: "POST", auth: true });
  },

  // -------------------------------------------------------------------------
  // Users (admin Settings → Users panel)
  // -------------------------------------------------------------------------
  async listUsers(): Promise<AdminUser[]> {
    return request<AdminUser[]>("/api/users", { auth: true });
  },

  async createUser(input: {
    email: string;
    password: string;
    display_name: string;
    role: Role;
    school_id?: number | null;
    organization_id?: number | null;
  }): Promise<AdminUser> {
    return request<AdminUser>("/api/users", {
      method: "POST",
      auth: true,
      body: input,
    });
  },

  async updateUser(
    id: number,
    input: {
      display_name?: string;
      email?: string;
      active?: boolean;
      role?: Role;
      school_id?: number | null;
      organization_id?: number | null;
    }
  ): Promise<AdminUser> {
    return request<AdminUser>(`/api/users/${id}`, {
      method: "PUT",
      auth: true,
      body: input,
    });
  },

  // -------------------------------------------------------------------------
  // Forms
  // -------------------------------------------------------------------------
  async listForms(): Promise<Form[]> {
    return request<Form[]>("/api/forms", { auth: true });
  },

  async getForm(id: number): Promise<FormWithFields> {
    return request<FormWithFields>(`/api/forms/${id}`, { auth: true });
  },

  async createForm(input: {
    title: string;
    description?: string | null;
    school_id?: number | null;
    fields: {
      label: string;
      type: string;
      options?: string[] | null;
      required?: boolean;
      staff_only?: boolean;
      sort_order?: number;
      placeholder?: string | null;
    }[];
  }): Promise<FormWithFields> {
    return request<FormWithFields>("/api/forms", {
      method: "POST",
      auth: true,
      body: input,
    });
  },

  async updateForm(
    id: number,
    input: {
      title?: string;
      description?: string | null;
      status?: string;
      fields: {
        id?: number;
        label: string;
        type: string;
        options?: string[] | null;
        required?: boolean;
        staff_only?: boolean;
        sort_order?: number;
        placeholder?: string | null;
      }[];
    }
  ): Promise<FormWithFields> {
    return request<FormWithFields>(`/api/forms/${id}`, {
      method: "PUT",
      auth: true,
      body: input,
    });
  },

  async updateFormStatus(id: number, status: string): Promise<FormWithFields> {
    return request<FormWithFields>(`/api/forms/${id}/status`, {
      method: "PATCH",
      auth: true,
      body: { status },
    });
  },

  // -------------------------------------------------------------------------
  // Submissions
  // -------------------------------------------------------------------------
  async listSubmissions(params: {
    school_id?: number;
    form_id?: number;
    status?: string;
    from?: string;
    to?: string;
  } = {}): Promise<SubmissionRow[]> {
    const qs = new URLSearchParams();
    if (params.school_id !== undefined) qs.set("school_id", String(params.school_id));
    if (params.form_id !== undefined) qs.set("form_id", String(params.form_id));
    if (params.status) qs.set("status", params.status);
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    const q = qs.toString();
    return request<SubmissionRow[]>(`/api/submissions${q ? `?${q}` : ""}`, { auth: true });
  },

  async getSubmission(publicId: string): Promise<SubmissionDetail> {
    return request<SubmissionDetail>(`/api/submissions/${publicId}`, { auth: true });
  },

  async updateSubmissionStatus(
    publicId: string,
    status: SubmissionStatus
  ): Promise<void> {
    return request<void>(`/api/submissions/${publicId}/status`, {
      method: "PATCH",
      auth: true,
      body: { status },
    });
  },

  async addComment(publicId: string, body: string): Promise<Comment> {
    return request<Comment>(`/api/submissions/${publicId}/comments`, {
      method: "POST",
      auth: true,
      body: { body, visibility: "internal" },
    });
  },

  async updateSubmissionValues(
    publicId: string,
    answers: SubmissionAnswer[]
  ): Promise<SubmissionDetail> {
    return request<SubmissionDetail>(`/api/submissions/${publicId}/values`, {
      method: "PUT",
      auth: true,
      body: { answers },
    });
  },

  // -------------------------------------------------------------------------
  // Submission ad-hoc staff-only fields
  // -------------------------------------------------------------------------
  async listAdhocFields(publicId: string): Promise<AdhocField[]> {
    return request<AdhocField[]>(`/api/submissions/${publicId}/adhoc`, { auth: true });
  },

  async createAdhocField(
    publicId: string,
    input: {
      label: string;
      type: string;
      options?: string[] | null;
      value: string | number | boolean | string[] | null;
    }
  ): Promise<AdhocField> {
    return request<AdhocField>(`/api/submissions/${publicId}/adhoc`, {
      method: "POST",
      auth: true,
      body: input,
    });
  },

  async updateAdhocField(
    publicId: string,
    fieldId: number,
    input: {
      label: string;
      type: string;
      options?: string[] | null;
      value: string | number | boolean | string[] | null;
    }
  ): Promise<AdhocField> {
    return request<AdhocField>(`/api/submissions/${publicId}/adhoc/${fieldId}`, {
      method: "PUT",
      auth: true,
      body: input,
    });
  },

  async deleteAdhocField(publicId: string, fieldId: number): Promise<AdhocField[]> {
    return request<AdhocField[]>(`/api/submissions/${publicId}/adhoc/${fieldId}`, {
      method: "DELETE",
      auth: true,
    });
  },

  // -------------------------------------------------------------------------
  // Public (anonymous) parent submission
  // -------------------------------------------------------------------------
  async listPublicForms(slug?: string): Promise<PublicForm[]> {
    const qs = slug ? `?org=${encodeURIComponent(slug)}` : "";
    return request<PublicForm[]>(`/api/forms/public${qs}`, { auth: false });
  },

  async getPublicForm(id: number, slug?: string): Promise<PublicForm> {
    const qs = slug ? `?org=${encodeURIComponent(slug)}` : "";
    return request<PublicForm>(`/api/forms/${id}/public${qs}`, { auth: false });
  },

  async submitForm(
    input: {
      form_id: number;
      answers: { field_id: number; value: string | number | boolean | string[] | null }[];
    },
    slug?: string
  ): Promise<{ public_id: string; message: string }> {
    const qs = slug ? `?org=${encodeURIComponent(slug)}` : "";
    return request<{ public_id: string; message: string }>(`/api/submissions${qs}`, {
      method: "POST",
      auth: false,
      body: input,
    });
  },

  async getSubmissionPublic(publicId: string, slug?: string): Promise<{
    public_id: string;
    status: string;
    submitted_at: string;
    form_name: string;
  }> {
    const qs = slug ? `?org=${encodeURIComponent(slug)}` : "";
    return request<{ public_id: string; status: string; submitted_at: string; form_name: string }>(
      `/api/submissions/${publicId}/public${qs}`,
      { auth: false }
    );
  },

  // -------------------------------------------------------------------------
  // Export (admin)
  // -------------------------------------------------------------------------
  async exportPreview(params: {
    form_id: number;
    school_id?: number;
    status?: string;
  }): Promise<ExportPreview> {
    const qs = new URLSearchParams({ form_id: String(params.form_id) });
    if (params.school_id !== undefined) qs.set("school_id", String(params.school_id));
    if (params.status) qs.set("status", params.status);
    return request<ExportPreview>(`/api/export/preview?${qs.toString()}`, { auth: true });
  },

  /**
   * Build a URL for the CSV export that includes the current auth token.
   * CSV is fetched as a blob & downloaded.
   */
  async exportCsv(params: {
    form_id: number;
    school_id?: number;
    status?: string;
    include_staff_only?: boolean;
  }): Promise<void> {
    const qs = new URLSearchParams({ form_id: String(params.form_id) });
    if (params.school_id !== undefined) qs.set("school_id", String(params.school_id));
    if (params.status) qs.set("status", params.status);
    if (params.include_staff_only) qs.set("include_staff_only", "1");

    const res = await fetch(`${API_BASE}/api/export/csv?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${getToken()}` },
      credentials: "include",
    });
    if (!res.ok) throw new ApiError(res.status, "Export failed");

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `submissions-export.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },
};
