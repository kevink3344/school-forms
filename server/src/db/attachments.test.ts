import { describe, it, expect } from "vitest";
import { canUseAttachments, expectedIndexNames } from "./schema.js";
import { sqlserverDialect } from "./dialect/sqlserver.js";
import { tursoDialect } from "./dialect/turso.js";
import { isHttpsUrl, createSubmissionLinkSchema } from "../schemas.js";
import {
  signAttachmentLinkToken,
  verifyAttachmentLinkToken,
  signAccessToken,
} from "../auth.js";

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

// -----------------------------------------------------------------------------
// Links (docs/plans/staff-attachments.md §3.6)
//
// A link is a separate table from an attachment, because the attachment table is
// a Drive table (drive_file_id NOT NULL, size_bytes, mime_type) and a link has
// none of those. These pin the two things that would fail silently: the table
// cascading with its submission (or the permanent delete leaves rows behind) and
// the `https://` rule that keeps a stored URL safe to render as an href.
// -----------------------------------------------------------------------------
describe("submission_links is a child of submissions on both dialects", () => {
  const ddl = (statements: string[]) => statements.join("\n");

  it("SQL Server declares the table, the cascade and the index", () => {
    const sql = ddl(sqlserverDialect.ddl);
    expect(sql).toMatch(/CREATE TABLE dbo\.submission_links/);
    expect(sql).toMatch(
      /FOREIGN KEY \(submission_id\) REFERENCES dbo\.submissions\(id\) ON DELETE CASCADE/
    );
    expect(sql).toMatch(/IX_submission_links_submission/);
    // The creator is SET NULL, so deleting a user never blocks on a link they
    // once added.
    expect(sql).toMatch(
      /FOREIGN KEY \(created_by\) REFERENCES dbo\.users\(id\) ON DELETE SET NULL/
    );
  });

  it("Turso declares the table, the cascade and the index", () => {
    const sql = ddl(tursoDialect.ddl);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS submission_links/);
    expect(sql).toMatch(/REFERENCES submissions\(id\) ON DELETE CASCADE/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS IX_submission_links_submission/);
  });

  it("needs no addColumns entry — the table is new on both engines", () => {
    // `addColumns` exists only for columns added to a table that predates them.
    expect(tursoDialect.addColumns.some((c) => c.table === "submission_links")).toBe(false);
  });

  it("declares the index through indexGuard on SQL Server", () => {
    // Otherwise the boot-time "N indexes MISSING" report cannot name it.
    expect(expectedIndexNames(sqlserverDialect.ddl)).toContain("IX_submission_links_submission");
    expect(expectedIndexNames(tursoDialect.ddl)).toContain("IX_submission_links_submission");
  });
});

describe("isHttpsUrl — the Link URL rule", () => {
  it("accepts an https URL with a host", () => {
    expect(isHttpsUrl("https://example.org/handbook")).toBe(true);
    expect(isHttpsUrl("  https://drive.google.com/drive/folders/abc  ")).toBe(true);
    expect(isHttpsUrl("HTTPS://Example.ORG")).toBe(true);
  });

  it("refuses anything that does not begin with https://", () => {
    // ★ The brief's rule, and the reason a stored link can never be a
    // `javascript:` URL: the prefix is required before anything else is checked.
    expect(isHttpsUrl("http://example.org")).toBe(false);
    expect(isHttpsUrl("www.example.org")).toBe(false);
    expect(isHttpsUrl("example.org")).toBe(false);
    expect(isHttpsUrl("ftp://example.org")).toBe(false);
    expect(isHttpsUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpsUrl("//example.org")).toBe(false);
    expect(isHttpsUrl("")).toBe(false);
  });

  it("refuses a host-less https:// — the prefix alone is not enough", () => {
    expect(isHttpsUrl("https://")).toBe(false);
    expect(isHttpsUrl("https://   ")).toBe(false);
  });

  it("refuses an over-long URL", () => {
    expect(isHttpsUrl(`https://example.org/${"a".repeat(2100)}`)).toBe(false);
  });

  it("is the rule the create schema applies", () => {
    expect(createSubmissionLinkSchema.safeParse({ title: "Handbook", url: "https://a.org/x" }).success).toBe(true);
    const bad = createSubmissionLinkSchema.safeParse({ title: "Handbook", url: "http://a.org/x" });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues[0].message).toBe("Link URL must begin with https://");
    }
    // A title is required — a bare URL is not a link the list can render.
    expect(createSubmissionLinkSchema.safeParse({ title: "  ", url: "https://a.org/x" }).success).toBe(false);
  });
});

describe("attachment link tokens", () => {
  // The link is minted on click and lives 10 minutes. These pin the two
  // properties that made the first version fail: it must not BE the session
  // token, and it must be bound to one file.
  const mint = () =>
    signAttachmentLinkToken({ userId: 1, submissionId: 22, attachmentId: 2 });

  it("round-trips the user, submission and attachment", () => {
    const payload = verifyAttachmentLinkToken(mint());
    expect(payload).not.toBeNull();
    expect(Number(payload!.sub)).toBe(1);
    expect(Number(payload!.submissionId)).toBe(22);
    expect(Number(payload!.attachmentId)).toBe(2);
    expect(payload!.type).toBe("attachment");
  });

  it("refuses a real ACCESS token, so a session token cannot be used as a link", () => {
    // ★ This is the regression that produced "Invalid or expired token": the
    // href used to carry the 15-minute access token, which died with the page.
    const accessToken = signAccessToken({
      id: 1,
      email: "a@b.c",
      role: "admin",
      school_id: null,
      organization_id: 1,
    });
    expect(verifyAttachmentLinkToken(accessToken)).toBeNull();
  });

  it("refuses a tampered or garbage token", () => {
    expect(verifyAttachmentLinkToken("")).toBeNull();
    expect(verifyAttachmentLinkToken("not-a-jwt")).toBeNull();
    const good = mint();
    expect(verifyAttachmentLinkToken(`${good}x`)).toBeNull();
  });

  it("mints a DIFFERENT token per file, so a link cannot be reused for another", () => {
    const a = signAttachmentLinkToken({ userId: 1, submissionId: 22, attachmentId: 2 });
    const b = signAttachmentLinkToken({ userId: 1, submissionId: 22, attachmentId: 3 });
    expect(verifyAttachmentLinkToken(a)!.attachmentId).not.toBe(
      verifyAttachmentLinkToken(b)!.attachmentId
    );
  });
});
