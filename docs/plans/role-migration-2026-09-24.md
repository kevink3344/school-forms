# Role migration record — `staff` → `cdm_contact`

**Date:** 2026-09-24
**Database:** `wcpss-google-forms` on `wcpsssqlelasticpool` (production)
**Reason:** `staff` is not school-scoped, so these accounts could read and archive
submissions from every school in the district. Self-registration now creates a
School Contact instead; this converts the accounts that already existed.

## Who was converted

36 accounts. All had a non-null `school_id`, so all are now confined
to that school. Their passwords, school, organization, active flag and
`show_on_test_screen` flag were not touched — only `role`.

| # | id | email | display_name | school_id |
|---|----|-------|--------------|-----------|
| 1 | 3 | swatkins@gmail.com | Sammy Watkins | 38 |
| 2 | 8 | pwtest.1789431078@schoolforms.local | PW Test | 11 |
| 3 | 12 | mgainey@wcpss.net | Michelle Gainey | 16 |
| 4 | 13 | jmerry@wcpss.net | Jessica Merry | 77 |
| 5 | 14 | kawalker@wcpss.net | Kelley Walker | 19 |
| 6 | 15 | lkovalaske@wcpss.net | Laurie Kovalaske | 88 |
| 7 | 16 | tgillespie2@wcpss.net | Tara Gillespie | 124 |
| 8 | 17 | cchadwick@wcpss.net | Christina Chadwick | 47 |
| 9 | 18 | ttaylor5@wcpss.net | Tracy Taylor | 184 |
| 10 | 19 | aworley@wcpss.net | Ann Worley | 91 |
| 11 | 20 | kmoynihan@wcpss.net | Katherine Moynihan | 55 |
| 12 | 21 | mdunning3@wcpss.net | Mary Katelin Dunning | 58 |
| 13 | 22 | kbowling@wcpss.net | Kimberly Bowling | 158 |
| 14 | 23 | gcherry1@wcpss.net | Gena Cherry | 56 |
| 15 | 24 | jhowland@wcpss.net | Jennifer Howland | 164 |
| 16 | 25 | ekleimeyer@wcpss.net | Erin Kleimeyer | 206 |
| 17 | 26 | klarsen@wcpss.net | Kristen Larsen | 207 |
| 18 | 27 | mgreen2@wcpss.net | Melissa Green | 79 |
| 19 | 28 | plprice@wcpss.net | Patricia Price | 175 |
| 20 | 29 | ewilmoth@wcpss.net | Emily Wilmoth | 49 |
| 21 | 30 | jcuccurullo@wcpss.net | Julianna Cuccurullo | 105 |
| 22 | 31 | hoxendine@wcpss.net | Heidi  Oxendine | 120 |
| 23 | 32 | kganzel@wcpss.net | Karen Ganzel | 17 |
| 24 | 33 | mmaul@wcpss.net | Maurine Maul | 42 |
| 25 | 34 | kmcilhargey@wcpss.net | Kelly McIlhargey | 64 |
| 26 | 35 | rhaymore@wcpss.net | Ryan Haymore | 185 |
| 27 | 36 | wwheeler3@wcpss.net | William Eugene Wheeler | 130 |
| 28 | 37 | lhetzell@wcpss.net | Lorrie Hetzell | 188 |
| 29 | 38 | rwest2@wcpss.net | Rebecca Bonham West | 122 |
| 30 | 39 | lmejeur@wcpss.net | Lisa Mejeur | 89 |
| 31 | 40 | mcorey@wcpss.net | Megan Corey | 69 |
| 32 | 41 | jstern@wcpss.net | Julie Stern | 145 |
| 33 | 42 | mwalter@wcpss.net | Megan Walter | 135 |
| 34 | 43 | scmckay@wcpss.net | Sonja McKay | 189 |
| 35 | 44 | hmilligan@wcpss.net | Heather Milligan | 128 |
| 36 | 45 | jstallings2@wcpss.net | Jessica Stallings | 97 |

## Undo

```sql
UPDATE dbo.users SET role = 'staff' WHERE id IN (3, 8, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45);
```

**Note:** this only reverses the role. The narrowed visibility is a consequence of
`role`, so reverting restores district-wide reach for exactly these accounts.

## Consequence (measured after the change, from the converted rows themselves)

Submissions exist for only 5 schools (1, 16, 38, 185, 206) of the 45 total. A
School Contact is confined to its own school, so the narrowing bites on almost
every converted account. **Two denominators, deliberately kept apart:**

| measure | accounts |
| --- | --- |
| reach **nothing at all** in their school (`total = 0`) | **32 of 36** |
| have an **empty Active queue** (`active = 0`) | **33 of 36** |

The second is one higher because Sammy Watkins's school (38) holds 3 rows and
**all 3 are archived** — reachable in the Archived view, absent from Active.

The four converted accounts whose school holds any rows:

| id | name | school | active | total |
| --- | --- | --- | --- | --- |
| 3 | Sammy Watkins | 38 | 0 | 3 |
| 12 | Michelle Gainey | 16 | 3 | 3 |
| 25 | Erin Kleimeyer | 206 | 1 | 1 |
| 35 | Ryan Haymore | 185 | 1 | 1 |

Only Sammy Watkins is archived-only; the other three open a normal Active queue.

**Scope proof for the account this exercise was about:** district total is 45
rows; the rows reachable by Heidi Hoxendine (id 31, school 120) are **0**. Her
district-wide reach — which is what let her archive rows at four other schools —
is gone.

### When this takes effect

`requireRoles` and `scopedSchoolId` read the **JWT claim**, not the database, so
an already-issued token still says `staff`. But `POST /api/auth/refresh`
re-reads the user (`getUserById(payload.sub)`) and signs a fresh token from the
**current DB role**, and the refresh cookie carries only the user id — so the
role cannot go stale. Access tokens live **15 minutes** and the client
auto-refreshes on 401 (`client/src/lib/api.ts`), so every live session narrows
within ~15 minutes. No forced sign-out is needed.

Two staff-only fields (id 31 "Distribution of Phase I Letters", id 35 "Did Student
meet criteria?", both on form 2) list `["admin","staff"]` and were **deliberately
left unchanged**, so they are hidden from School Contacts in the UI and dropped
from CSV exports.
