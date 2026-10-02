import { useEffect, useState } from "react";
import { api } from "./api";
import { parseDocumentRoles } from "./settings";

// Whether the Documents feature is currently enabled for a role, per the public
// `documents_link` setting (a JSON role list, whose UNSET value is `null`).
//
// This is THE gate for all document UI. It is the same setting the server
// enforces on /api/documents (403 "Documents is disabled for your role") and the
// same one the sidebar uses to decide whether to show the Documents link, so
// anything document-related should ask this hook rather than testing the role
// directly: an admin who enables Documents for a role gets that role's document
// UI back for free, with no code change.
//
// ★ The state is `string[] | null`, and `null` means EVERYONE — not "all the
// roles that existed when this ran". The previous version seeded its state with
// the built-in roster and parsed the setting into that same roster, so a role
// created after an installation was set up saw no Documents link even though the
// setting was unrestricted, and a role the client's hard-coded list did not know
// about was filtered OUT of a stored list that had explicitly named it. Reading
// the role as `string` and honouring `null` are both required for an
// admin-created role to behave at all.
//
// Defaults to ENABLED while the setting loads, and if the read fails, so the
// caller never flashes off behind a slow or failed request — matching the
// sidebar's contract. A control that appears 200 ms late is a wart; one that
// flickers a feature away is a bug report.
export function useDocumentsEnabled(role: string | undefined): boolean {
  const [docRoles, setDocRoles] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getPublicSetting("documents_link")
      .then((s) => {
        if (!cancelled) setDocRoles(parseDocumentRoles(s.value));
      })
      .catch(() => {
        // keep the default (unrestricted) if the read fails
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return role ? docRoles === null || docRoles.includes(role) : false;
}
