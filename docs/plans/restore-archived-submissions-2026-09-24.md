# Restore record — 33 submissions archived by Heidi Oxendine

**Date:** 2026-09-24
**Database:** `wcpss-google-forms` on `wcpsssqlelasticpool` (production)
**Reason:** the rows were archived in error; the user asked for them to be restored.

## Why this file exists

`restoreSubmission()` writes `archived_at = NULL, archived_by = NULL` — it does not keep
the previous archiver "as a record of who did it last". There is no archive-history or
audit table in this database, so **once a row is restored the fact that Heidi archived
it is unrecoverable**. This file is the only remaining copy of that provenance.

## What was restored

33 rows, all with `archived_by = 31` (`hoxendine@wcpss.net`, Lufkin Road Middle School)
and `archived_at IS NOT NULL`. They span **five different schools** (1, 16, 185, 206 and
their own 120 had none — 32 of the 33 are outside Heidi's own school).

| # | id | public_id | school_id | archived_at (UTC) |
|---|----|-----------|-----------|-------------------|
| 1 | 1 | CDM-00001 | 1 | 2026-09-24 18:51:55.8501685 |
| 2 | 2 | CDM-00002 | 1 | 2026-09-24 18:52:05.6248941 |
| 3 | 3 | CDM-00003 | 1 | 2026-09-24 18:52:15.6516039 |
| 4 | 4 | CDM-00004 | 1 | 2026-09-24 18:52:26.4702525 |
| 5 | 67 | CDM2-00277 | 1 | 2026-09-24 18:52:32.1124922 |
| 6 | 66 | CDM2-00276 | 1 | 2026-09-24 18:52:35.9107826 |
| 7 | 65 | CDM2-00275 | 1 | 2026-09-24 18:52:39.9857348 |
| 8 | 64 | CDM2-00274 | 1 | 2026-09-24 18:52:43.7223327 |
| 9 | 5 | CDM-00005 | 1 | 2026-09-24 18:52:52.0136416 |
| 10 | 6 | CDM-00006 | 1 | 2026-09-24 18:52:56.6596108 |
| 11 | 31 | CDM2-00019 | 1 | 2026-09-24 18:53:02.6658685 |
| 12 | 33 | CDM2-00021 | 206 | 2026-09-24 18:53:07.7744607 |
| 13 | 34 | CDM2-00022 | 16 | 2026-09-24 18:53:12.2077326 |
| 14 | 35 | CDM2-00023 | 185 | 2026-09-24 18:53:17.2551153 |
| 15 | 36 | CDM2-00024 | 16 | 2026-09-24 18:53:22.6542213 |
| 16 | 37 | CDM2-00025 | 16 | 2026-09-24 18:53:27.4204419 |
| 17 | 42 | CDM2-00252 | 1 | 2026-09-24 18:53:34.0970142 |
| 18 | 45 | CDM2-00255 | 1 | 2026-09-24 18:53:41.3896289 |
| 19 | 46 | CDM2-00256 | 1 | 2026-09-24 18:53:47.6512599 |
| 20 | 47 | CDM2-00257 | 1 | 2026-09-24 18:53:58.8969897 |
| 21 | 49 | CDM2-00259 | 1 | 2026-09-24 18:54:06.2026669 |
| 22 | 51 | CDM2-00261 | 1 | 2026-09-24 18:54:16.4326162 |
| 23 | 52 | CDM2-00262 | 1 | 2026-09-24 18:54:22.3971487 |
| 24 | 63 | CDM2-00273 | 1 | 2026-09-24 19:10:45.8270721 |
| 25 | 62 | CDM2-00272 | 1 | 2026-09-24 19:10:49.6658186 |
| 26 | 61 | CDM2-00271 | 1 | 2026-09-24 19:10:58.4355591 |
| 27 | 60 | CDM2-00270 | 1 | 2026-09-24 19:11:03.6603526 |
| 28 | 59 | CDM2-00269 | 1 | 2026-09-24 19:11:10.1364933 |
| 29 | 57 | CDM2-00267 | 1 | 2026-09-24 19:11:14.0992231 |
| 30 | 58 | CDM2-00268 | 1 | 2026-09-24 19:11:24.2873465 |
| 31 | 53 | CDM2-00263 | 1 | 2026-09-24 19:11:36.5740854 |
| 32 | 55 | CDM2-00265 | 1 | 2026-09-24 19:11:43.2595232 |
| 33 | 56 | CDM2-00266 | 1 | 2026-09-24 19:11:48.0569915 |

## Undo (re-archives exactly these rows)

```sql
UPDATE dbo.submissions SET archived_at = '2026-09-24 18:51:55.8501685', archived_by = 31 WHERE id = 1 AND public_id = 'CDM-00001';
UPDATE dbo.submissions SET archived_at = '2026-09-24 18:52:05.6248941', archived_by = 31 WHERE id = 2 AND public_id = 'CDM-00002';
UPDATE dbo.submissions SET archived_at = '2026-09-24 18:52:15.6516039', archived_by = 31 WHERE id = 3 AND public_id = 'CDM-00003';
UPDATE dbo.submissions SET archived_at = '2026-09-24 18:52:26.4702525', archived_by = 31 WHERE id = 4 AND public_id = 'CDM-00004';
UPDATE dbo.submissions SET archived_at = '2026-09-24 18:52:32.1124922', archived_by = 31 WHERE id = 67 AND public_id = 'CDM2-00277';
UPDATE dbo.submissions SET archived_at = '2026-09-24 18:52:35.9107826', archived_by = 31 WHERE id = 66 AND public_id = 'CDM2-00276';
UPDATE dbo.submissions SET archived_at = '2026-09-24 18:52:39.9857348', archived_by = 31 WHERE id = 65 AND public_id = 'CDM2-00275';
UPDATE dbo.submissions SET archived_at = '2026-09-24 18:52:43.7223327', archived_by = 31 WHERE id = 64 AND public_id = 'CDM2-00274';
UPDATE dbo.submissions SET archived_at = '2026-09-24 18:52:52.0136416', archived_by = 31 WHERE id = 5 AND public_id = 'CDM-00005';
UPDATE dbo.submissions SET archived_at = '2026-09-24 18:52:56.6596108', archived_by = 31 WHERE id = 6 AND public_id = 'CDM-00006';
UPDATE dbo.submissions SET archived_at = '2026-09-24 18:53:02.6658685', archived_by = 31 WHERE id = 31 AND public_id = 'CDM2-00019';
UPDATE dbo.submissions SET archived_at = '2026-09-24 18:53:07.7744607', archived_by = 31 WHERE id = 33 AND public_id = 'CDM2-00021';
UPDATE dbo.submissions SET archived_at = '2026-09-24 18:53:12.2077326', archived_by = 31 WHERE id = 34 AND public_id = 'CDM2-00022';
UPDATE dbo.submissions SET archived_at = '2026-09-24 18:53:17.2551153', archived_by = 31 WHERE id = 35 AND public_id = 'CDM2-00023';
UPDATE dbo.submissions SET archived_at = '2026-09-24 18:53:22.6542213', archived_by = 31 WHERE id = 36 AND public_id = 'CDM2-00024';
UPDATE dbo.submissions SET archived_at = '2026-09-24 18:53:27.4204419', archived_by = 31 WHERE id = 37 AND public_id = 'CDM2-00025';
UPDATE dbo.submissions SET archived_at = '2026-09-24 18:53:34.0970142', archived_by = 31 WHERE id = 42 AND public_id = 'CDM2-00252';
UPDATE dbo.submissions SET archived_at = '2026-09-24 18:53:41.3896289', archived_by = 31 WHERE id = 45 AND public_id = 'CDM2-00255';
UPDATE dbo.submissions SET archived_at = '2026-09-24 18:53:47.6512599', archived_by = 31 WHERE id = 46 AND public_id = 'CDM2-00256';
UPDATE dbo.submissions SET archived_at = '2026-09-24 18:53:58.8969897', archived_by = 31 WHERE id = 47 AND public_id = 'CDM2-00257';
UPDATE dbo.submissions SET archived_at = '2026-09-24 18:54:06.2026669', archived_by = 31 WHERE id = 49 AND public_id = 'CDM2-00259';
UPDATE dbo.submissions SET archived_at = '2026-09-24 18:54:16.4326162', archived_by = 31 WHERE id = 51 AND public_id = 'CDM2-00261';
UPDATE dbo.submissions SET archived_at = '2026-09-24 18:54:22.3971487', archived_by = 31 WHERE id = 52 AND public_id = 'CDM2-00262';
UPDATE dbo.submissions SET archived_at = '2026-09-24 19:10:45.8270721', archived_by = 31 WHERE id = 63 AND public_id = 'CDM2-00273';
UPDATE dbo.submissions SET archived_at = '2026-09-24 19:10:49.6658186', archived_by = 31 WHERE id = 62 AND public_id = 'CDM2-00272';
UPDATE dbo.submissions SET archived_at = '2026-09-24 19:10:58.4355591', archived_by = 31 WHERE id = 61 AND public_id = 'CDM2-00271';
UPDATE dbo.submissions SET archived_at = '2026-09-24 19:11:03.6603526', archived_by = 31 WHERE id = 60 AND public_id = 'CDM2-00270';
UPDATE dbo.submissions SET archived_at = '2026-09-24 19:11:10.1364933', archived_by = 31 WHERE id = 59 AND public_id = 'CDM2-00269';
UPDATE dbo.submissions SET archived_at = '2026-09-24 19:11:14.0992231', archived_by = 31 WHERE id = 57 AND public_id = 'CDM2-00267';
UPDATE dbo.submissions SET archived_at = '2026-09-24 19:11:24.2873465', archived_by = 31 WHERE id = 58 AND public_id = 'CDM2-00268';
UPDATE dbo.submissions SET archived_at = '2026-09-24 19:11:36.5740854', archived_by = 31 WHERE id = 53 AND public_id = 'CDM2-00263';
UPDATE dbo.submissions SET archived_at = '2026-09-24 19:11:43.2595232', archived_by = 31 WHERE id = 55 AND public_id = 'CDM2-00265';
UPDATE dbo.submissions SET archived_at = '2026-09-24 19:11:48.0569915', archived_by = 31 WHERE id = 56 AND public_id = 'CDM2-00266';
```

## Not restored

Six rows remained archived, archived by other accounts:

- **System Admin** (id 1): 4
- **Sammy Watkins** (id 3): 1
- **Kevin Key** (id 9): 1
