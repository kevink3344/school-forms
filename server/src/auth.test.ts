import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import type { Request, Response } from "express";
import { requireAuth, signAccessToken } from "./auth.js";
import { env } from "./config/env.js";
import type { Role } from "./db/schema.js";

// -----------------------------------------------------------------------------
// requireAuth's tenant check.
//
// This exists because the guard shipped once with `Number.isInteger(payload.
// organization_id)` and that rejected EVERY authenticated request on SQL Server:
// the mssql/tedious driver returns these id columns as STRINGS, so the token
// carries `organization_id: "1"` and `Number.isInteger("1")` is false. The
// original verification ran under DB_MODE=turso, where libSQL returns real
// numbers, so it passed while the deployment was down.
//
// The two dialects disagree about the TYPE of the same column, so both shapes
// are asserted here. Any future type-strict check on a value that came out of
// the database will fail this file.
// -----------------------------------------------------------------------------

// Mint a token exactly as the app does, but with a chosen claim value — this is
// how the SQL Server shape ("1") is reproduced without a SQL Server.
function tokenWithOrg(org: unknown, overrides: Record<string, unknown> = {}): string {
  return jwt.sign(
    {
      sub: 1,
      email: "admin@schoolforms.local",
      role: "admin" as Role,
      school_id: null,
      organization_id: org,
      type: "access",
      ...overrides,
    },
    env.auth.accessSecret,
    { expiresIn: "15m" }
  );
}

// Minimal Express doubles — enough to observe status/body and whether next() ran.
function invoke(token: string | null) {
  const req = {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as unknown as Request;

  let statusCode: number | null = null;
  let body: unknown = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
  } as unknown as Response;

  let nextCalled = false;
  requireAuth(req, res, () => {
    nextCalled = true;
  });

  return { req, statusCode, body, nextCalled };
}

describe("requireAuth — tenant claim", () => {
  it("accepts a numeric claim (libSQL / Turso shape)", () => {
    const r = invoke(tokenWithOrg(1));
    expect(r.nextCalled).toBe(true);
    expect(r.statusCode).toBeNull();
    expect(r.req.user?.organization_id).toBe(1);
  });

  it("accepts a numeric-STRING claim (SQL Server / tedious shape) — the regression", () => {
    const r = invoke(tokenWithOrg("1"));
    expect(r.nextCalled).toBe(true);
    expect(r.statusCode).toBeNull();
  });

  it("keeps the claim VERBATIM, so a string stays a string", () => {
    // Coercing here would make `"1" !== 1` true against a row read from the same
    // database and reintroduce the cross-tenant 403 in routes/users.ts.
    const r = invoke(tokenWithOrg("1"));
    expect(r.req.user?.organization_id).toBe("1");
    expect(typeof r.req.user?.organization_id).toBe("string");
  });

  it("preserves the type so a claim and a DB row compare equal", () => {
    const r = invoke(tokenWithOrg("7"));
    // What routes/users.ts does: `target.organization_id !== req.user!.organization_id`
    //
    // `unknown` is deliberate. `AccessPayload.organization_id` is declared
    // `number | null`, so TypeScript rejects this comparison outright ("'string'
    // and 'number | null | undefined' have no overlap") — that compile error IS
    // the bug: the declared type does not describe what the SQL Server driver
    // puts in the payload. Asserting through `unknown` keeps the runtime check
    // honest instead of silencing it with a cast.
    const dbRowValueFromSqlServer: unknown = "7";
    expect(dbRowValueFromSqlServer !== r.req.user?.organization_id).toBe(false);
  });

  const rejects: Array<[string, unknown]> = [
    ["a missing claim", undefined],
    ["a null claim", null],
    ["an empty-string claim", ""],
    ["a whitespace claim", "   "],
    ["a zero claim", 0],
    ["a negative claim", -1],
    ["a non-numeric string claim", "academics"],
    ["an object claim", { id: 1 }],
    ["an array claim", []],
  ];

  it.each(rejects)("rejects %s with 401", (_label, org) => {
    const r = invoke(tokenWithOrg(org));
    expect(r.nextCalled).toBe(false);
    expect(r.statusCode).toBe(401);
    expect(r.body).toEqual({ error: "Session is missing an organization. Sign in again." });
  });

  it("accepts a claim that matches the value signAccessToken actually emits", () => {
    // Control: a token minted by the real helper must pass, whichever shape the
    // DB supplied. Guards against this test drifting from production minting.
    for (const org of [1, "1"] as const) {
      const token = signAccessToken({
        id: 1,
        email: "admin@schoolforms.local",
        role: "admin" as Role,
        school_id: null,
        organization_id: org as unknown as number,
      });
      const r = invoke(token);
      expect(r.nextCalled).toBe(true);
    }
  });

  it("control: an unknown/garbage token is rejected (so a PASS means the check ran)", () => {
    const r = invoke("not-a-jwt");
    expect(r.nextCalled).toBe(false);
    expect(r.statusCode).toBe(401);
    expect(r.body).toEqual({ error: "Invalid or expired token" });
  });

  it("control: a token signed with the wrong secret is rejected", () => {
    const token = jwt.sign(
      { sub: 1, email: "x@y.z", role: "admin", school_id: null, organization_id: 1, type: "access" },
      "wrong-secret",
      { expiresIn: "15m" }
    );
    const r = invoke(token);
    expect(r.nextCalled).toBe(false);
    expect(r.statusCode).toBe(401);
  });
});
