// Repair accounts created by the PUBLIC registration endpoint before commit
// c4dac1e (2026-09-24) hardcoded the role correctly.
//
// History of the role the register route assigns:
//   927d846 (Aug 26)  role as Role        <-- caller-supplied: an anonymous
//                                             caller could ask for anything
//   83a7375 (Sep 15)  "staff"             <-- fixed, but the WRONG role: staff
//                                             is not school-scoped, so a public
//                                             sign-up could read every school
//   c4dac1e (Sep 24)  "cdm_contact"       <-- correct, and what main has now
//
// Any deployment still serving the 83a7375 code writes `staff` for every public
// sign-up. Those rows are not distinguishable from a deliberate staff account by
// role alone, so this script:
//   * only considers `staff` rows that hold a school_id (a self-registration
//     always names a school; the register schema requires it),
//   * names every row it would touch before touching it,
//   * refuses to guess about a `staff` row with a NULL school_id.
//
// Idempotent: re-running after a successful pass finds nothing to change.

import { execute } from "./queries.js";

type U = {
  id: number;
  email: string;
  display_name: string | null;
  role: string;
  school_id: number | null;
  created_at: string;
};

const apply = process.argv.includes("--apply");
console.log(`[role-repair] mode: ${apply ? "APPLY" : "dry run (db kind: sqlserver)"}`);

const staff = await execute<U>(
  `SELECT u.id, u.email, u.display_name, u.role, u.school_id, u.created_at
     FROM dbo.users u
    WHERE u.role = 'staff'
    ORDER BY u.id`
);

const withSchool = staff.filter((u) => u.school_id !== null);
const withoutSchool = staff.filter((u) => u.school_id === null);

console.log(`[role-repair] ${staff.length} user(s) hold role 'staff'`);

if (withSchool.length === 0) {
  console.log("[role-repair] nothing to change.");
} else {
  console.log(`[role-repair] ${withSchool.length} candidate self-registration(s) to move to 'cdm_contact':`);
  for (const u of withSchool) {
    console.log(
      `[role-repair]   #${u.id} ${u.email} (${u.display_name ?? "-"}) school_id=${u.school_id} created=${u.created_at}`
    );
  }
}

if (withoutSchool.length > 0) {
  console.log(
    `[role-repair] ${withoutSchool.length} 'staff' row(s) have NO school_id and are left alone ` +
      `(a self-registration always names a school, so these are not ours to guess about):`
  );
  for (const u of withoutSchool) {
    console.log(`[role-repair]   #${u.id} ${u.email} (${u.display_name ?? "-"}) created=${u.created_at}`);
  }
}

if (!apply) {
  console.log("[role-repair] dry run — nothing written. Re-run with `-- --apply` to apply the list above.");
} else if (withSchool.length === 0) {
  console.log("[role-repair] applied: 0 rows.");
} else {
  // One statement, guarded on the row still being a `staff` row, so a concurrent
  // change (or a second run) is a no-op rather than an overwrite.
  let changed = 0;
  for (const u of withSchool) {
    const res = await execute<{ n: number }>(
      `UPDATE dbo.users SET role = 'cdm_contact' WHERE id = @id AND role = 'staff'`,
      { id: u.id }
    );
    void res;
    changed += 1;
    console.log(`[role-repair]   #${u.id} ${u.email}: staff -> cdm_contact`);
  }
  console.log(`[role-repair] updated ${changed} user(s).`);
  console.log(
    "[role-repair] NOTE: an already-issued access token still carries the old role for up to 15 minutes. " +
      "Sign out and back in to pick up the new one."
  );
}

// Confirm the end state either way, so a silent no-op cannot look like success.
const after = await execute<{ role: string; n: number }>(
  `SELECT role, COUNT(*) AS n FROM dbo.users GROUP BY role ORDER BY COUNT(*) DESC`
);
console.log("[role-repair] role distribution now:");
for (const r of after) console.log(`[role-repair]   ${String(r.role).padEnd(14)} ${r.n}`);
