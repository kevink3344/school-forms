// -----------------------------------------------------------------------------
// The role a public self-registration gets.
//
// `POST /api/auth/register` is unauthenticated, so the role it assigns decides
// what a stranger can reach the moment they sign up. The value is a string
// literal inside one handler, and nothing else in the suite read it — so it
// could be changed, or drift back, with every test still green.
//
// What it must be: `cdm_contact` (a School Contact). `staff` is NOT school-
// scoped (`isSchoolScoped` in auth.ts matches `cdm_contact` only), so a self-
// registered `staff` account can read and archive submissions from EVERY school
// in the district. That is the behaviour this file exists to prevent coming
// back — it was the mechanism behind one account archiving 33 rows across five
// schools it had no relationship to.
//
// `staff` remains a legitimate role: an administrator creating an account
// deliberately (POST /api/auth/seed-staff) still gets it. The CONTROL at the
// bottom asserts exactly that, so these checks are proven capable of telling
// the two endpoints apart rather than passing on a global grep.
// -----------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES = readFileSync(join(HERE, "auth.ts"), "utf8");

/**
 * Slice one route registration out of the source.
 *
 * Bounded by the NEXT `authRouter.` marker rather than by a `;` — a handler body
 * is full of semicolons, so a `[^;]*` slice ends inside the prologue and makes
 * the route look like it does not call the thing it plainly calls.
 */
function handler(method: "post" | "get", path: string): string {
  const marker = `authRouter.${method}("${path}"`;
  const at = ROUTES.indexOf(marker);
  expect(at, `no ${method.toUpperCase()} ${path} registration found in routes/auth.ts`)
    .toBeGreaterThanOrEqual(0);
  const next = ROUTES.indexOf("authRouter.", at + marker.length);
  return ROUTES.slice(at, next === -1 ? ROUTES.length : next);
}

/**
 * The text of the `createUser(...)` call, sliced to its matching close paren.
 * Returns null when the handler has no such call.
 */
function createUserCall(code: string): string | null {
  const open = code.indexOf("createUser(");
  if (open === -1) return null;
  let depth = 0;
  for (let i = open + "createUser".length; i < code.length; i += 1) {
    if (code[i] === "(") depth += 1;
    else if (code[i] === ")") {
      depth -= 1;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  return code.slice(open);
}

describe("POST /api/auth/register assigns a School Contact", () => {
  it("creates a cdm_contact account", () => {
    const call = createUserCall(handler("post", "/register"));
    expect(call, "the register handler no longer calls createUser").toBeTruthy();
    expect(
      call,
      "Self-registration no longer creates a `cdm_contact`. A public sign-up that lands on `staff` " +
        "is NOT school-scoped, so the account can read and archive every school's submissions in " +
        "the district. If a school-scoped sign-up is genuinely wanted, pass \"cdm_contact\" here; " +
        "if district-wide reach really is intended, this expectation — and the swagger description " +
        "and the Register page copy — all have to be changed together."
    ).toContain('"cdm_contact"');
  });

  it("does not fall back to staff", () => {
    const call = createUserCall(handler("post", "/register"))!;
    expect(
      call,
      "CONTROL for the check above: this asserts the literal is absent, not merely that some role " +
        "is present. If the role argument became a variable, both this and the check above are " +
        "reading a value they cannot see — resolve it by inlining the literal."
    ).not.toContain('"staff"');
  });

  it("keeps the role server-fixed, never taken from the request body", () => {
    const code = handler("post", "/register");
    const call = createUserCall(code)!;
    // The comment claims this; the check is that the third argument is a
    // literal rather than anything derived from the request.
    expect(
      call,
      "the role passed to createUser is derived from the request. This endpoint is public, so a " +
        "caller-supplied role lets anyone self-register as an admin."
    ).not.toMatch(/\bbody\b|\breq\.|\bparsed\.data\b/);
    expect(
      code,
      "the register schema now accepts a `role` field. It must not: honouring it makes privilege " +
        "escalation a one-line request."
    ).not.toMatch(/role\s*:/);
  });

  it("CONTROL: seed-staff still creates a staff account", () => {
    // Proves the checks above discriminate between the two endpoints instead of
    // passing because `"staff"` vanished from the file.
    const call = createUserCall(handler("post", "/seed-staff"));
    expect(call, "seed-staff no longer calls createUser").toBeTruthy();
    expect(
      call,
      "seed-staff stopped creating `staff`. That is the deliberate administrator-only path for a " +
        "district-wide account; if it was narrowed too, an administrator can no longer create one, " +
        "and the register-default test above would be passing without a working control."
    ).toContain('"staff"');
  });
});
