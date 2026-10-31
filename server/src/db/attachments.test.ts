import { describe, it, expect } from "vitest";
import { canUseAttachments } from "./schema.js";
import { sqlserverDialect } from "./dialect/sqlserver.js";
import { tursoDialect } from "./dialect/turso.js";

// -----------------------------------------------------------------------------
// Staff Attachments — the access rule (docs/plans/staff-attachments.md §3.2).
//
// These assert the DECISION, not the wiring: the per-form toggle is checked
// before the role list, admins are superusers, and the three role states stay
// distinct. Each of those has a failure mode that is silent in the UI (the card
// simply appears or does not), which is why they are pinned here.
// -----------------------------------------------------------------------------

const form = (over: Partial<{ attachments_enabled: boolean; attachments_roles: string[] | null }>) => ({
  attachments_enabled: true,
  attachments_roles: null,
  ...over,
});

describe("canUseAttachments — the per-form toggle comes first", () => {
  it("refuses a granted role when the form has attachments switched off", () => {
    // ★ The whole point of the toggle: a role grant left over from when the
    // feature was on must not keep the card alive.
    expect(canUseAttachments(form({ attachments_enabled: false, attachments_roles: null }), "staff")).toBe(false);
    expect(
      canUseAttachments(form({ attachments_enabled: false, attachments_roles: ["staff"] }), "staff")
    ).toBe(false);
  });

  it("allows a granted role when the form has attachments switched on", () => {
    expect(canUseAttachments(form({ attachments_roles: ["staff"] }), "staff")).toBe(true);
  });

  it("admins are superusers — the toggle does not hide the card from them", () => {
    // The detail page uses this to show an admin a read-only "turned off" card,
    // so an admin can confirm what staff see without a second account.
    expect(canUseAttachments(form({ attachments_enabled: false }), "admin")).toBe(true);
    expect(canUseAttachments(form({ attachments_enabled: false, attachments_roles: [] }), "admin")).toBe(true);
  });
});

describe("canUseAttachments — the three role states", () => {
  it("null means unrestricted, including roles created later", () => {
    expect(canUseAttachments(form({ attachments_roles: null }), "staff")).toBe(true);
    expect(canUseAttachments(form({ attachments_roles: null }), "a-role-that-does-not-exist-yet")).toBe(true);
  });

  it("an empty array means nobody", () => {
    // NOT "fall back to everyone" — that is the sentinel confusion D3 in
    // staff-only-field-access-toggles.md records.
    expect(canUseAttachments(form({ attachments_roles: [] }), "staff")).toBe(false);
    expect(canUseAttachments(form({ attachments_roles: [] }), "cdm_contact")).toBe(false);
  });

  it("an explicit list admits exactly those roles", () => {
    const f = form({ attachments_roles: ["staff", "reviewer"] });
    expect(canUseAttachments(f, "staff")).toBe(true);
    expect(canUseAttachments(f, "reviewer")).toBe(true);
    expect(canUseAttachments(f, "cdm_contact")).toBe(false);
  });
});

describe("submission_attachments is a child of submissions on both dialects", () => {
  const ddl = (statements: string[]) => statements.join("\n");

  it("SQL Server declares the FK and the index", () => {
    const sql = ddl(sqlserverDialect.ddl);
    expect(sql).toMatch(/CREATE TABLE dbo\.submission_attachments/);
    expect(sql).toMatch(
      /FOREIGN KEY \(submission_id\) REFERENCES dbo\.submissions\(id\) ON DELETE CASCADE/
    );
    expect(sql).toMatch(/IX_submission_attachments_submission/);
  });

  it("Turso declares the table, the cascade and the index", () => {
    const sql = ddl(tursoDialect.ddl);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS submission_attachments/);
    expect(sql).toMatch(/REFERENCES submissions\(id\) ON DELETE CASCADE/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS IX_submission_attachments_submission/);
  });

  it("both dialects default the per-form switch OFF", () => {
    // DEFAULT 0 is the deploy story: every existing form keeps attachments off
    // until an admin turns it on for that form.
    expect(ddl(sqlserverDialect.ddl)).toMatch(
      /attachments_enabled BIT NOT NULL\s+CONSTRAINT DF_forms_attachments_enabled DEFAULT 0/
    );
    expect(ddl(tursoDialect.ddl)).toMatch(/attachments_enabled BOOLEAN NOT NULL DEFAULT 0/);
    expect(tursoDialect.addColumns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "forms", column: "attachments_enabled" }),
        expect.objectContaining({ table: "forms", column: "attachments_roles" }),
      ])
    );
  });
});
