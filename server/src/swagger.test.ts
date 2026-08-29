import { describe, it, expect } from "vitest";
import { buildSwaggerSpec } from "./swagger.js";
import { ROUTES } from "./routes/inventory.js";

type Operation = { security?: unknown[] };
type PathItem = Record<string, Operation | undefined>;
const paths = buildSwaggerSpec().paths as Record<string, PathItem>;

// Two invariants we want to hold over time:
//   1. every mounted route is documented in the Swagger spec (no drift),
//   2. every documented path corresponds to a real/mounted route (no orphans).
// The `ROUTES` constant in routes/inventory.ts is the single source of truth.

describe("Swagger spec covers all API routes", () => {
  it("documents every mounted route", () => {
    const missing: string[] = [];
    for (const r of ROUTES) {
      const path = paths[r.path];
      if (!path) {
        missing.push(`${r.method.toUpperCase()} ${r.path} (path missing)`);
        continue;
      }
      if (!path[r.method]) {
        missing.push(`${r.method.toUpperCase()} ${r.path} (no ${r.method} operation)`);
      }
    }
    expect(missing, `Missing Swagger paths:\n${missing.join("\n")}`).toEqual([]);
  });

  it("has no orphan documented paths", () => {
    const known = new Set(ROUTES.map((r) => r.path));
    const orphan = Object.keys(paths).filter((p) => !known.has(p));
    expect(orphan).toEqual([]);
  });

  it("marks required security for protected endpoints", () => {
    // "none" (public), "secret" (header-guarded), and "cookie" (httpOnly cookie,
    // cannot be sent by the Swagger Authorize button) must NOT require bearer.
    const noBearer = new Set(["none", "secret", "cookie"]);
    for (const r of ROUTES) {
      const op = paths[r.path]?.[r.method];
      if (!op) continue;
      const hasSecurity = Array.isArray(op.security) && op.security.length > 0;
      if (noBearer.has(r.auth)) {
        expect(
          hasSecurity,
          `${r.method.toUpperCase()} ${r.path} should not require bearer security`
        ).toBe(false);
      } else {
        expect(
          hasSecurity,
          `${r.method.toUpperCase()} ${r.path} should require auth`
        ).toBe(true);
      }
    }
  });
});
