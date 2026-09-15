import { useEffect, useState } from "react";
import { api } from "./api";
import { parseDocumentRoles, ROLES } from "./settings";
import type { Role } from "../types";

// Whether the Documents feature is currently enabled for a role, per the public
// `documents_link` setting (a JSON role array).
//
// This is THE gate for all document UI. It is the same setting the server
// enforces on /api/documents (403 "Documents is disabled for your role") and the
// same one the sidebar uses to decide whether to show the Documents link, so
// anything document-related should ask this hook rather than testing the role
// directly: an admin who enables Documents for a role gets that role's document
// UI back for free, with no code change.
//
// Defaults to every role while the setting loads, and if the read fails, so the
// caller never flashes off behind a slow or failed request — matching the
// sidebar's contract.
export function useDocumentsEnabled(role: Role | undefined): boolean {
  const [docRoles, setDocRoles] = useState<Role[]>(() => [...ROLES]);

  useEffect(() => {
    let cancelled = false;
    api
      .getPublicSetting("documents_link")
      .then((s) => {
        if (!cancelled) setDocRoles(parseDocumentRoles(s.value));
      })
      .catch(() => {
        // keep the default (all roles) if the read fails
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return role ? docRoles.includes(role) : false;
}
