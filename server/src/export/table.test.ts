import { describe, expect, it, vi } from "vitest";

// `buildExportRows` fetches submission values in bulk through this one function.
// Mocking it keeps these tests off the network while still exercising the join
// that decides whether an answer lands in its column at all.
vi.mock("../db/queries.js", () => ({
  listSubmissionValuesBatch: vi.fn(),
}));

import { listSubmissionValuesBatch } from "../db/queries.js";
import { buildExportRows, formatSubmittedAt, type ExportColumnWithFieldId } from "./table.js";

// -----------------------------------------------------------------------------
// formatSubmittedAt — the function that turned a whole report into
// `500 {"error":"Invalid time value"}`.
//
// `Intl.DateTimeFormat#format` coerces its argument with ToNumber, so a string
// argument throws `RangeError: Invalid time value` instead of formatting. Every
// caller passes a value straight out of the data layer, and production hands
// back `submitted_at` as TEXT: measured, 18 rows, the newest of them
// `"2026-09-21T15:39:12.080"` — the fixed-width form with no trailing `Z` — while
// its neighbours carried one. One such row was enough to 500 the preview and
// both export formats.
//
// The first test is a CONTROL that asserts the raw `Intl` call still throws.
// Without it, a green suite would only prove this file runs — not that it
// guards anything.
// -----------------------------------------------------------------------------
describe("formatSubmittedAt", () => {
  it("CONTROL — the bare Intl call really does throw on a string", () => {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York" });
    expect(() => formatter.format("2026-09-21T15:39:12.080" as never)).toThrow(RangeError);
  });

  it("formats a real Date", () => {
    expect(formatSubmittedAt(new Date("2026-09-21T15:39:12.080Z"))).toBe("9/21/2026, 11:39:12 AM");
  });

  it("formats the Z-suffixed text form", () => {
    expect(formatSubmittedAt("2026-09-21T15:39:12.080Z")).toBe("9/21/2026, 11:39:12 AM");
  });

  it("formats the Z-LESS text form production actually serves", () => {
    // THE regressions: this threw `RangeError: Invalid time value`, and the
    // stray `Z`-less row is why. 15:39 UTC is 11:39 EDT, so the assertion also
    // pins the UTC reading — treating a bare value as server-local would render
    // a different hour depending on which machine ran the query.
    expect(formatSubmittedAt("2026-09-21T15:39:12.080")).toBe("9/21/2026, 11:39:12 AM");
  });

  it("returns an unparseable value unchanged instead of throwing", () => {
    // Showing the raw timestamp is more useful than a blank cell, and it keeps
    // the bad value visible rather than hiding it behind a 500. The
    // second-precision form is deliberately NOT guessed at — an earlier test in
    // driver/libsql.test.ts pins that decision.
    for (const value of ["", "—", "2026-09-15T02:33:35Z", "2026-2027", "nonsense"]) {
      expect(formatSubmittedAt(value)).toBe(value);
    }
  });

  it("never throws on a nullish or non-scalar value", () => {
    expect(formatSubmittedAt(null)).toBe("");
    expect(formatSubmittedAt(undefined)).toBe("");
    expect(formatSubmittedAt({} as never)).toBe("");
  });
});

// -----------------------------------------------------------------------------
// buildExportRows — the whole preview/export path in one call.
// -----------------------------------------------------------------------------
describe("buildExportRows", () => {
  const addressColumn: ExportColumnWithFieldId = {
    key: "field_9",
    label: "Address",
    staff_only: false,
    roles: null,
    field_id: 9,
  };

  it("renders a row whose submitted_at is the Z-less text form", async () => {
    vi.mocked(listSubmissionValuesBatch).mockResolvedValue(new Map());
    const rows = await buildExportRows([addressColumn], [
      {
        id: 29,
        public_id: "CDM2-00017",
        submitted_at: "2026-09-21T15:39:12.080",
        status: "submitted",
      },
    ]);
    expect(rows).toEqual([
      {
        submission_public_id: "CDM2-00017",
        submitted_at: "9/21/2026, 11:39:12 AM",
        status: "submitted",
      },
    ]);
  });

  it("matches a value whose field_id comes back as a string", async () => {
    // The row types declare `field_id: number`, and a driver that returns TEXT
    // ids hands back `"9"` anyway — the same lie production tells about
    // `submissions.id`. Keyed the old way (`Map<number, …>.get("9")`) this
    // returns undefined, so the column comes back BLANK with no error at all:
    // a silently wrong report, which is worse than the 500 being fixed.
    vi.mocked(listSubmissionValuesBatch).mockResolvedValue(
      new Map([
        [29, [{ field_id: "9" as unknown as number, value: "123 Ash Ave" }]],
      ])
    );
    const rows = await buildExportRows([addressColumn], [
      {
        id: 29,
        public_id: "CDM2-00017",
        submitted_at: "2026-09-21T15:39:12.080",
        status: "submitted",
      },
    ]);
    expect(rows[0].field_9).toBe("123 Ash Ave");
  });
});
