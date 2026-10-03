import { describe, it, expect, vi, beforeEach } from "vitest";

// -----------------------------------------------------------------------------
// `canAccessForm` — run for real, against a mocked database seam.
//
// WHY THIS FILE EXISTS
//
// The visibility rule shipped with a guard that tested the RAW form id:
//
//     if (!Number.isFinite(formId)) return false;
//
// `form_id` reaches this function as a STRING — the SQL Server driver returns
// numeric columns as TEXT and `normalizeRow` does not coerce them — and
// `Number.isFinite` does not parse its argument, so it is `false` for every
// valid id. The guard also sits ABOVE the role branch, so it denied EVERY
// viewer: an admin, whose predicate here is a literal `1 = 1`, got
// `403 Forbidden: no access to this form` on every submission page.
//
// It failed CLOSED and threw nothing, so nothing caught it. `form-access.test.ts`
// could not: it inspects the predicate's SOURCE TEXT, which was correct. The
// lesson is that a rule expressed in SQL still needs its TypeScript boundary run
// at least once — so this file mocks the single `execute` seam and exercises the
// real function.
// -----------------------------------------------------------------------------

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock("../db/queries.js", () => ({
  execute: (sql: string, params?: unknown) => execute(sql, params),
}));

import { canAccessForm } from "./formAccess.js";

describe("canAccessForm — the id it is handed", () => {
  beforeEach(() => {
    execute.mockReset();
    execute.mockResolvedValue([{ n: 1 }]);
  });

  it("accepts a form id that arrives as a STRING (the driver's real behaviour)", async () => {
    // ★ The regression. `"11"` is a valid id: the row exists, and the caller's
    // own TypeScript says `number`. Rejecting it is the bug being pinned here.
    await expect(
      canAccessForm({ role: "admin", id: 1 }, "11" as unknown as number)
    ).resolves.toBe(true);
  });

  it("queries the form by the PARSED id, not the raw string", async () => {
    await canAccessForm({ role: "admin", id: 1 }, "11" as unknown as number);
    const params = execute.mock.calls[0][1] as { formId: unknown };
    expect(params.formId).toBe(11);
  });

  it("accepts a numeric id unchanged", async () => {
    await expect(canAccessForm({ role: "admin", id: 1 }, 11)).resolves.toBe(true);
  });

  it("still returns false when the form does not exist", async () => {
    execute.mockResolvedValue([{ n: 0 }]);
    await expect(canAccessForm({ role: "admin", id: 1 }, 11)).resolves.toBe(false);
  });

  it("CONTROL: rejects a non-numeric id without touching the database", async () => {
    // The guard's real job. If this ever queries, the coercion has become
    // "accept anything".
    await expect(
      canAccessForm({ role: "admin", id: 1 }, "abc" as unknown as number)
    ).resolves.toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("CONTROL: rejects a missing id without touching the database", async () => {
    await expect(
      canAccessForm({ role: "admin", id: 1 }, undefined as unknown as number)
    ).resolves.toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("an unrestricted role adds no viewer parameter at all", async () => {
    // The clause for admin/staff is the literal `1 = 1`, so no grant lookup can
    // be reintroduced by accident.
    await canAccessForm({ role: "staff", id: 1 }, 11);
    const params = execute.mock.calls[0][1] as Record<string, unknown>;
    expect(params).not.toHaveProperty("__viewerId");
  });

  it("a restricted role DOES bind a viewer id for the grant lookup", async () => {
    await canAccessForm({ role: "cdm_contact", id: 7 }, 11);
    const params = execute.mock.calls[0][1] as Record<string, unknown>;
    expect(params.__viewerId).toBe(7);
  });

  it("binds a viewer id that arrives as a STRING (the JWT's `sub` claim)", async () => {
    // Same coercion rule, same class of bug: a `"7"` discarded by `viewerId`
    // dropped the grant lookup, so an APPROVED School Contact was denied a form
    // the picker had just offered them.
    await canAccessForm({ role: "cdm_contact", id: "7" as unknown as number }, 11);
    const params = execute.mock.calls[0][1] as Record<string, unknown>;
    expect(params.__viewerId).toBe(7);
  });

  it("CONTROL: an unidentifiable viewer binds NO id and fails closed", async () => {
    await canAccessForm({ role: "cdm_contact" }, 11);
    const params = execute.mock.calls[0][1] as Record<string, unknown>;
    expect(params).not.toHaveProperty("__viewerId");
    const sql = execute.mock.calls[0][0] as string;
    expect(sql).toContain("visibility = 'public'");
  });
});
