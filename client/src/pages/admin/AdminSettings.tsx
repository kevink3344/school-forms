import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../../lib/api";
import { ChevronDown, Check, Copy, KeyRound, Plus, Webhook, X } from "lucide-react";
import { parseDocumentRoles, parseMenuItems, defaultMenuItems, MENU_ITEMS, MENU_ITEM_LABELS, audienceLabel, type MenuItemKey } from "../../lib/settings";
import { BADGE_CHOICES, badgeClass, roleBadgeFor, roleLabelFor, useRoleCatalog } from "../../lib/roles";
import type { AccessGrantRow, AccessRequestRow, AdminUser, LoginMode, OrganizationWithMembers, ResetPasswordResult, Role, RoleRow, RoleUsageReport, School, SystemMessage, UserAccessRow, WebhookEventSummary } from "../../types";
import { PageHead } from "../../components/layout";
import { Toggle } from "../../components/Toggle";
import { refreshSystemMessages } from "../../components/SystemMessageBar";
import { Toast } from "../../components/Toast";
import { useAuth } from "../../context/AuthContext";
import SchoolsPanel from "./SchoolsPanel";
import SchoolNameMatchingPanel from "./SchoolNameMatchingPanel";

// login mode options displayed in the Settings → Login Mode panel.
const LOGIN_MODES: { value: LoginMode; label: string; desc: string; tone: string }[] = [
  { value: "select", label: "Select User (Test)", desc: "Pick a user from the directory — no email/password needed.", tone: "blue" },
  { value: "password", label: "Password (Production)", desc: "Requires email + password for every sign-in.", tone: "green" },
  { value: "maintenance", label: "System Maintenance", desc: "Blocks sign-in and shows a maintenance message.", tone: "amber" },
];

const MAINTENANCE_DEFAULT =
  "We are performing scheduled maintenance. Please try again shortly.";

// ---------------------------------------------------------------------------
// Small inline form control (matches the .filter-group / .edit-input styling)
// ---------------------------------------------------------------------------
function Field({
  label,
  children,
  full,
}: {
  label: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <label className="cf" style={full ? { gridColumn: "1 / -1" } : undefined}>
      <span>{label}</span>
      {children}
    </label>
  );
}

// A toggle switch component built from a styled checkbox — now shared (see
// components/Toggle.tsx) so the filter toolbars do not grow a second copy.

// Role labels and badges come from the catalog (lib/roles.ts), not from a chain of
// `if (role === …)` comparisons here. The chain that used to live at this spot
// labelled every role it did not recognise "Staff" and gave it staff's badge, so a
// role an administrator created appeared in the Users grid as a second Staff
// account with nothing to tell them apart — and it could not follow a rename, which
// is the whole point of the Roles panel further down this page.

// ---------------------------------------------------------------------------
// System Messages (Settings → System Messages)
// ---------------------------------------------------------------------------
interface SysMsgFormState {
  id: number | null; // null → create
  title: string;
  body: string;
  active: boolean;
  // The roles that may see it. `null` means everyone, INCLUDING roles created
  // later — see `emptySysMsgForm`.
  audience: string[] | null;
}

// A factory rather than a shared constant: the audience is an array, and a
// module-level constant would be handed to every new form, so a later edit to one
// form's chips could mutate the template the next form starts from.
function emptySysMsgForm(): SysMsgFormState {
  return {
    id: null,
    title: "",
    body: "",
    // New messages start Active. The toggle sits in the drawer next to the Save
    // button, so the admin sees the state they are about to save — whereas
    // saving a message Inactive produces a message that is stored and invisible,
    // which reads as "saving did nothing". The server's own default is the
    // opposite (`active` defaults to false on create); this form always sends
    // the field explicitly, so that default is never reached from the UI.
    active: true,
    // Everyone, INCLUDING roles that do not exist yet. `null` is what the stored
    // column uses for that, and it is deliberately not the built-in roster: the
    // built-ins are a list frozen at the moment this form was opened, so an
    // administrator who created a role afterwards would find it excluded from a
    // message nobody had actually narrowed.
    audience: null,
  };
}

/**
 * The Target Audience control: one chip per role in the catalog, plus an
 * "Everyone" chip for the unset (null) audience.
 *
 * There are three stored states and all three are reachable here:
 *   - `null` — everyone, including roles created later. That is what the
 *     "Everyone" chip sets, and the reason it is a distinct chip rather than
 *     "all the roles happen to be selected". A full roster and an unset audience
 *     are NOT the same value, and the difference is invisible until someone adds
 *     a role.
 *   - `[]` — nobody. Deselecting the last role chip is how it is authored, which
 *     is why that path must send an empty ARRAY and never `null`: `null`
 *     broadcasts to everyone, the precise opposite of what the admin just asked
 *     for.
 *   - a list — exactly those.
 *
 * Clicking a pressed role chip while the audience is `null` therefore materialises
 * the explicit list of the OTHER roles rather than writing `null` back, which
 * would make the click look like it did nothing.
 *
 * The chips are the catalog, so a role an administrator created appears here on
 * its own. While the catalog is loading there is exactly one honest thing to
 * render — that it is loading — rather than a built-in roster that would silently
 * omit it.
 */
function AudienceChips({
  value,
  onChange,
}: {
  value: string[] | null;
  onChange: (next: string[] | null) => void;
}) {
  const { roles, error } = useRoleCatalog();
  const keys = roles.map((r) => r.role_key);
  const effective = value ?? keys;
  const isEveryone = value === null;
  const chip = (has: boolean): React.CSSProperties => ({
    cursor: "pointer",
    fontSize: "0.8125rem",
    fontWeight: 700,
    padding: "7px 14px",
    borderRadius: "var(--radius)",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    transition: "background-color .13s ease, border-color .13s ease, color .13s ease",
    background: has ? "var(--accent)" : "var(--card-bg)",
    color: has ? "#fff" : "var(--accent)",
    border: "1px solid var(--accent)",
  });

  if (roles.length === 0) {
    return (
      <span style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>
        {error ? `Could not load the role list: ${error}` : "Loading roles…"}
      </span>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      {roles.map((row) => {
        const has = effective.includes(row.role_key);
        const label = row.label;
        return (
          <button
            key={row.role_key}
            type="button"
            aria-pressed={has}
            title={has ? `Remove ${label} from this message` : `Show this message to ${label}`}
            onClick={() =>
              onChange(
                has
                  ? effective.filter((r) => r !== row.role_key)
                  : [...effective, row.role_key]
              )
            }
            style={chip(has)}
          >
            {has ? <Check size={14} /> : <Plus size={14} />}
            <span>{label}</span>
          </button>
        );
      })}
      <button
        type="button"
        aria-pressed={isEveryone}
        title="Everyone, including any role added later — stored as an unset audience"
        onClick={() => onChange(null)}
        style={chip(isEveryone)}
      >
        {isEveryone ? <Check size={14} /> : <Plus size={14} />}
        <span>Everyone</span>
      </button>
    </div>
  );
}

// How a message's audience reads in the table and in the drawer's "Visible to …"
// hint is `audienceLabel` from lib/settings, shared with the badge the notice
// card renders. It lives there because this page and the card have to agree about
// the same message, and one copy is the only way to guarantee that.

// This stylesheet has no destructive button variant. Adding a class for the two
// Delete buttons in the System Messages panel would be more change than it
// warrants, so they borrow the secondary button's shape and take the colour the
// app already uses to mean "this went wrong" (--vacant-fg, the foreground of
// .alert-error). A destructive action should not look like the safe one next to
// it.
const DANGER_BUTTON: React.CSSProperties = {
  borderColor: "var(--vacant-fg)",
  color: "var(--vacant-fg)",
};

// ---------------------------------------------------------------------------
// Collapsible card section (Settings) — clickable header toggles the body
// ---------------------------------------------------------------------------
function CollapsibleSection({
  title,
  subtitle,
  children,
  defaultOpen = false,
  bodyStyle,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  bodyStyle?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card">
      <button
        type="button"
        className="collapse-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="collapse-title-wrap">
          <span className="collapse-title">{title}</span>
          <span className="sub">{subtitle}</span>
        </span>
        <ChevronDown className={`collapse-chevron${open ? " open" : ""}`} size={16} />
      </button>
      {open && (
        <div className="collapse-body" style={bodyStyle}>
          {children}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / Edit modal
// ---------------------------------------------------------------------------
interface FormState {
  id: number | null; // null → create
  display_name: string;
  email: string;
  password: string; // only used on create
  role: Role;
  school_id: string; // "" = no school
  organization_id: string; // "" = default to current admin's org
  active: boolean;
  show_on_test_screen: boolean;
}

const EMPTY: FormState = {
  id: null,
  display_name: "",
  email: "",
  password: "",
  role: "staff",
  school_id: "",
  organization_id: "",
  active: true,
  // Off by default, matching the server: a new account is never listed on the
  // select-mode ("Test") login screen until an admin opts it in.
  show_on_test_screen: false,
};

// ---------------------------------------------------------------------------
// Create / edit Organization (right slide-out drawer)
// ---------------------------------------------------------------------------
interface OrgFormState {
  id: number | null; // null → create
  name: string;
  slug: string; // "" = auto-derive from name on create
  description: string;
  active: boolean;
}

const EMPTY_ORG: OrgFormState = {
  id: null,
  name: "",
  slug: "",
  description: "",
  active: true,
};

// ---------------------------------------------------------------------------
// Roles (Settings → Roles)
// ---------------------------------------------------------------------------
interface RoleFormState {
  // The role_key being edited, or null when creating. Also the flag the save
  // handler branches on: a CREATE sends a body shape an UPDATE must not (and vice
  // versa), so the mode is carried in the state rather than inferred.
  editing: string | null;
  role_key: string;
  label: string;
  description: string;
  badge: string;
  can_view: boolean;
  can_edit: boolean;
  school_scoped: boolean;
  is_admin: boolean;
  // Carried so the form can disable the four capability controls rather than let
  // an admin change them and collect a 400 on save: this installation re-derives
  // a built-in's capabilities from code at every start, so an edit here would
  // appear to save and then silently revert.
  built_in: boolean;
}

type RoleFlagKey =
  | "can_view"
  | "can_edit"
  | "school_scoped"
  | "is_admin";

// The four capability flags, with the sentence each one needs to be unambiguous.
// `school_scoped` and `is_admin` are not capabilities in the same sense as the
// other two — they change WHICH rows a role can reach rather than whether it can
// act at all — so they are labelled as what they are.
//
// ★ `Export` and `Report` were removed from this list, and from the table's Access
// column, on request. They are still real columns on `dbo.roles` (`can_export`,
// `can_report`), still seeded `1` on all four built-ins and still returned by the
// API — only the two controls are gone. Before anyone re-adds them, know what they
// were doing: nothing. `requireCapability` in server/src/auth.ts accepts "export"
// and "report" but is attached to no route at all, and no client component reads
// `user.capabilities.export`, so both flags described an authority that nothing
// ever exercised. A create still sends them as `true` (see `handleRoleSave`) so no
// role is left holding a flag it had before; an edit deliberately sends neither.
const ROLE_FLAGS: { key: RoleFlagKey; label: string; hint: string }[] = [
  { key: "can_view", label: "View submissions", hint: "May open and read submissions." },
  { key: "can_edit", label: "Edit submissions", hint: "May change and archive submissions." },
  {
    key: "school_scoped",
    label: "Limited to their own school",
    hint: "Sees only submissions belonging to the school on their account.",
  },
  {
    key: "is_admin",
    label: "Administrator",
    hint: "Full access, including users, schools and system settings.",
  },
];

// The caption and hint styles of a `Field`, for the two controls in the Roles
// drawer that cannot be one: a group of buttons and a group of checkboxes. A
// <label> wrapping several controls hands every click to the first one inside it,
// so these blocks use a plain span and reproduce the look deliberately.
const FIELD_CAPTION: React.CSSProperties = {
  display: "block",
  fontSize: "0.6875rem",
  fontWeight: 600,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  marginBottom: 6,
};
const FIELD_HINT: React.CSSProperties = {
  display: "block",
  fontSize: "0.6875rem",
  color: "var(--text-muted)",
  marginTop: 6,
};

// A factory rather than a constant for the same reason as `emptySysMsgForm` — the
// object is handed to state and then mutated per keystroke, so a shared instance
// would leak one form's edits into the next.
//
// ★ `can_view` starts TRUE while every other flag starts false. The server's own
// create defaults are restrictive across the board, and it is right to be — but a
// role saved with all four flags off can sign in and do nothing at all, and an
// admin who creates one and assigns it gets a support ticket rather than a
// message. "Can see nothing" is a deliberate choice, so it is made explicitly.
function emptyRoleForm(): RoleFormState {
  return {
    editing: null,
    role_key: "",
    label: "",
    description: "",
    badge: "blue",
    can_view: true,
    can_edit: false,
    school_scoped: false,
    is_admin: false,
    built_in: false,
  };
}

export default function AdminSettings() {
  const { user } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [schools, setSchools] = useState<School[]>([]);
  const [orgs, setOrgs] = useState<OrganizationWithMembers[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  // Confirmation for a user SAVE, pinned to the viewport. This is the one action
  // in this component that does not use the `.alert-success` banner under the
  // page head: the admin who saves a row has scrolled past that banner to reach
  // the row, so a message there is off screen at the exact moment it is needed.
  // See components/Toast.tsx. `id` increments per call so that a repeated,
  // identical message remounts the toast (restarting its dismiss timer and
  // giving the live region something new to announce) instead of looking
  // unchanged to React, which would silently swallow the second confirmation.
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const toastSeq = useRef(0);
  const showToast = (text: string) => {
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, text });
  };

  // Login Mode panel state.
  const [loginMode, setLoginMode] = useState<LoginMode>("select");
  const [loginModeOverride, setLoginModeOverride] = useState<LoginMode | null>(null);
  const [maintenanceMessage, setMaintenanceMessage] = useState(MAINTENANCE_DEFAULT);
  const [loginModeBusy, setLoginModeBusy] = useState(false);

  // The role catalog: every role in this installation, including the ones an
  // administrator created. Shared with the Users grid, the Documents and Menu
  // toggles and the System Messages audience chips — all of them call
  // `useRoleCatalog`, which fetches once and dedupes, so this page costs one
  // request no matter how many controls read it.
  const roleCatalog = useRoleCatalog();
  const roles = roleCatalog.roles;
  const roleKeys = roles.map((r) => r.role_key);

  // Per-role reference census, keyed by role_key. Its only consumer is the Delete
  // button, which is disabled — with the server's own sentence in its tooltip —
  // while anything references the role. `GET /api/roles/:key/usage` composes that
  // sentence with the same helper the 409 refusal interpolates, so a disabled
  // button and the error behind it cannot disagree about the reason.
  const [roleUsage, setRoleUsage] = useState<Record<string, RoleUsageReport>>({});

  // Documents link panel state. A JSON role array stored in app_settings, where
  // `null` means unrestricted — every role, including ones created later. That is
  // the server's own default for the key, so it is also the honest initial state:
  // seeding this with the built-in roster would render a narrowed list that the
  // stored value does not contain.
  const [docRoles, setDocRoles] = useState<string[] | null>(null);
  const [docBusy, setDocBusy] = useState(false);

  // Menu visibility per item, from the `menu_items` setting. `null` per item means
  // the item is shown to everyone.
  const [menuItems, setMenuItems] = useState<Record<MenuItemKey, string[] | null>>(defaultMenuItems);
  const [menuBusy, setMenuBusy] = useState(false);

  // Slack Notifications section state. `slackEnabled` is the admin's on/off
  // switch (app setting `slack_notifications_enabled`, default ON). While it is
  // off the server sends nothing — see server/src/notify/slack.ts — so the test
  // below is disabled too, rather than reporting a failure the admin cannot fix.
  const [slackEnabled, setSlackEnabled] = useState(true);
  const [slackEnabledBusy, setSlackEnabledBusy] = useState(false);

  // Slack test panel state — subject, body, and a busy flag.
  const [slackSubject, setSlackSubject] = useState("Test notification");
  const [slackBody, setSlackBody] = useState(
    "This is a test message from School Forms. Slack *markdown* is supported."
  );
  const [slackBusy, setSlackBusy] = useState(false);

  // Webhook Log section state — the trailing 7-day intake counters. Null until
  // loaded, and left null on failure: the button below must still render, since
  // the log is the place you go when something is wrong.
  const [webhookSummary, setWebhookSummary] = useState<WebhookEventSummary | null>(null);

  const [modalOpen, setModalOpen] = useState<boolean>(false);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  // Admin password reset, rendered INSIDE the user drawer rather than as a second
  // overlay — the drawer already owns the account, and stacking two modals makes
  // "which Cancel am I clicking?" ambiguous.
  //   "idle"    → the normal create/edit form
  //   "confirm" → the "this signs them out" warning
  //   "done"    → the temporary password, shown exactly once
  // The result lives in state only: the server stores a bcrypt hash, so there is
  // no endpoint that could hand this value back a second time.
  const [resetStep, setResetStep] = useState<"idle" | "confirm" | "done">("idle");
  const [resetResult, setResetResult] = useState<ResetPasswordResult | null>(null);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState("");
  const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");

  // Organization drawer state.
  const [orgOpen, setOrgOpen] = useState<boolean>(false);
  const [orgForm, setOrgForm] = useState<OrgFormState>(EMPTY_ORG);
  const [orgSaving, setOrgSaving] = useState(false);
  const [orgSaveError, setOrgSaveError] = useState("");

  // System Messages — the list is the AUTHORING view (every message, active or
  // not), which is why it can hold rows no user is currently being shown.
  const [sysMsgs, setSysMsgs] = useState<SystemMessage[]>([]);
  const [sysMsgOpen, setSysMsgOpen] = useState(false);
  const [sysMsgForm, setSysMsgForm] = useState<SysMsgFormState>(emptySysMsgForm);
  const [sysMsgSaving, setSysMsgSaving] = useState(false);
  const [sysMsgSaveError, setSysMsgSaveError] = useState("");
  // Which row's Delete has been clicked once. Deleting a message also drops every
  // per-user dismissal record for it, so it is irreversible for every user at
  // once — worth one confirmation, and an inline one rather than a native dialog
  // so the confirmation appears in the row it applies to.
  const [sysMsgDeleteId, setSysMsgDeleteId] = useState<number | null>(null);

  // Roles panel state. The list itself comes from `useRoleCatalog` above; these
  // are only the drawer's form and the two inline confirmations.
  const [roleOpen, setRoleOpen] = useState(false);
  const [roleForm, setRoleForm] = useState<RoleFormState>(emptyRoleForm);
  const [roleSaving, setRoleSaving] = useState(false);
  const [roleSaveError, setRoleSaveError] = useState("");
  // Which row's Delete has been clicked once. Keyed by role_key, like the delete
  // endpoint.
  const [roleDeleteKey, setRoleDeleteKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [u, s, o] = await Promise.all([api.listUsers(), api.listSchools(), api.listOrganizations()]);
      setUsers(u);
      setSchools(s);
      setOrgs(o);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load users");
    } finally {
      setLoading(false);
    }

    // Load the Login Mode + maintenance settings (separate try so a settings
    // failure never blocks the users/orgs panels).
    try {
      const [mode, info, msg, docs, menu, slack] = await Promise.all([
        api.getPublicSetting("login_mode"),
        api.getInfo(),
        api.getPublicSetting("maintenance_message"),
        api.getPublicSetting("documents_link"),
        api.getPublicSetting("menu_items"),
        api.getPublicSetting("slack_notifications_enabled"),
      ]);
      setLoginMode((mode.value as LoginMode) || "select");
      setLoginModeOverride(info.loginModeOverride);
      if (msg.value) setMaintenanceMessage(msg.value);
      setDocRoles(parseDocumentRoles(docs.value));
      setMenuItems(parseMenuItems(menu.value));
      // Default ON when unset/blank, mirroring the server's default so the switch
      // never renders "off" for a setting that has never been written.
      setSlackEnabled(slack.value.trim().toLowerCase() !== "false");
    } catch {
      // keep defaults
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Refresh the reference census whenever the catalog changes — after a create, a
  // rename or a delete. Per-role try/catch: one failing request must not blank the
  // panel, and a role whose census is unknown gets no Delete affordance rather
  // than a wrong one (`roleUsage[key]` is then simply absent).
  useEffect(() => {
    if (roles.length === 0) return;
    let cancelled = false;
    void (async () => {
      const pairs = await Promise.all(
        roles.map(async (r): Promise<[string, RoleUsageReport] | null> => {
          try {
            return [r.role_key, await api.getRoleUsage(r.role_key)];
          } catch {
            return null;
          }
        })
      );
      if (cancelled) return;
      const next: Record<string, RoleUsageReport> = {};
      for (const pair of pairs) if (pair) next[pair[0]] = pair[1];
      setRoleUsage(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [roles]);

  // Intake counters for the Webhook Log section. Deliberately its own try/catch:
  // a webhook-stats failure must not blank out the account and organization
  // panels, and the link to the log stays usable regardless.
  useEffect(() => {
    let cancelled = false;
    api
      .getWebhookEventSummary({ days: 7 })
      .then((s) => {
        if (!cancelled) setWebhookSummary(s);
      })
      .catch(() => {
        /* leave the counters out; the button still works */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The authoring list of System Messages. Its own try/catch for the same reason
  // the webhook counters have one — a failure here must not blank the account and
  // organization panels — but it also carries the one call that tells the message
  // strip its cached list is stale, so every path that changes a message goes
  // through here instead of each mutation having to remember.
  const loadSysMsgs = useCallback(async () => {
    try {
      setSysMsgs(await api.listSystemMessages());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load system messages");
    }
    refreshSystemMessages();
  }, []);

  useEffect(() => {
    void loadSysMsgs();
  }, [loadSysMsgs]);

  // ---------------------------------------------------------------------------
  // Access Requests (docs/plans/public-private-forms.md §10.2).
  //
  // ★ The pending count is fetched SEPARATELY from the queue and is rendered on
  // the section TITLE, because the section is closed by default and §15 Q3
  // answered "in-app only" — so the count IS the notification. A count that only
  // rendered inside an open section would be a count nobody sees.
  //
  // Its own try/catch, like the webhook counters: a failure here must not blank
  // the account and organization panels.
  // ---------------------------------------------------------------------------
  const [accessRequests, setAccessRequests] = useState<AccessRequestRow[]>([]);
  const [accessPending, setAccessPending] = useState(0);
  const [accessError, setAccessError] = useState("");
  const [accessBusy, setAccessBusy] = useState<string | null>(null);
  // Which form's grant list is expanded, and its rows.
  const [grantsFormId, setGrantsFormId] = useState<number | null>(null);
  const [grants, setGrants] = useState<AccessGrantRow[]>([]);
  // The note an admin types before declining.
  const [declineFor, setDeclineFor] = useState<string | null>(null);
  const [declineNote, setDeclineNote] = useState("");

  // Per-account access, for the Edit User drawer. Loaded when the drawer opens
  // on an EXISTING user — a create has no account to grant to yet.
  const [userAccess, setUserAccess] = useState<UserAccessRow[]>([]);
  const [userAccessBusy, setUserAccessBusy] = useState<number | null>(null);
  const [userAccessError, setUserAccessError] = useState("");

  const loadUserAccess = useCallback(async (userId: number) => {
    setUserAccessError("");
    try {
      setUserAccess(await api.listUserAccess(userId));
    } catch (err) {
      setUserAccessError(
        err instanceof ApiError ? err.message : "Could not load this account's form access."
      );
      setUserAccess([]);
    }
  }, []);

  /**
   * Remove one account's access to one form.
   *
   * ★ Re-reads on success AND on a 409. The 409 means the form is public, so the
   * row is still there and the list must not pretend otherwise — the server's
   * message is shown verbatim because it names the fix ("make the form private
   * first").
   */
  const removeAccess = async (userId: number, formId: number) => {
    setUserAccessBusy(formId);
    setUserAccessError("");
    try {
      await api.removeUserAccess(userId, formId);
      await loadUserAccess(userId);
    } catch (err) {
      setUserAccessError(err instanceof ApiError ? err.message : "The removal did not reach the server.");
    } finally {
      setUserAccessBusy(null);
    }
  };

  const loadAccess = useCallback(async () => {
    try {
      const [queue, summary] = await Promise.all([
        api.listAccessRequests("pending"),
        api.getAccessRequestSummary(),
      ]);
      setAccessRequests(queue);
      setAccessPending(summary.pending);
      setAccessError("");
    } catch {
      /* leave the section empty; the rest of Settings still works */
    }
  }, []);

  useEffect(() => {
    void loadAccess();
  }, [loadAccess]);

  const decide = async (
    row: { user_id: number; form_id: number },
    decision: "approve" | "decline" | "revoke",
    note?: string
  ) => {
    const key = `${row.user_id}:${row.form_id}`;
    setAccessBusy(key);
    setAccessError("");
    try {
      await api.decideFormAccess({
        user_id: row.user_id,
        form_id: row.form_id,
        decision,
        note: note ?? null,
      });
      setDeclineFor(null);
      setDeclineNote("");
      await loadAccess();
      // A revoke changes the grant list, so refresh it if it is open.
      if (grantsFormId === row.form_id) setGrants(await api.listAccessGrants(row.form_id));
    } catch (err) {
      setAccessError(err instanceof ApiError ? err.message : "The decision did not reach the server.");
    } finally {
      setAccessBusy(null);
    }
  };

  const toggleGrants = async (formId: number) => {
    if (grantsFormId === formId) {
      setGrantsFormId(null);
      setGrants([]);
      return;
    }
    setGrantsFormId(formId);
    try {
      setGrants(await api.listAccessGrants(formId));
    } catch (err) {
      setAccessError(err instanceof ApiError ? err.message : "Could not load the access list.");
      setGrants([]);
    }
  };

  const openCreate = () => {
    setForm(EMPTY);
    // Always enter the drawer in its normal state, so a half-finished reset in a
    // previous session can never reappear over another account.
    setResetStep("idle");
    setResetResult(null);
    setResetError("");
    setModalOpen(true);
    setSaveError("");
  };

  const openEdit = (u: AdminUser) => {
    setForm({
      id: u.id,
      display_name: u.display_name,
      email: u.email,
      password: "",
      role: u.role,
      // `== null` rather than `=== null`: a key that is merely ABSENT would become
      // the string "undefined", which is truthy, so `Number("undefined")` reaches
      // the API as NaN and comes back as a flat "Validation failed" naming no
      // field. Catching both nullish shapes keeps that from being reachable.
      school_id: u.school_id == null ? "" : String(u.school_id),
      organization_id: u.organization_id == null ? "" : String(u.organization_id),
      active: u.active,
      show_on_test_screen: u.show_on_test_screen,
    });
    setResetStep("idle");
    setResetResult(null);
    setResetError("");
    setModalOpen(true);
    setSaveError("");
    // Load this account's form access. A create has no account yet, so only an
    // edit does this — and the list is cleared first so the previous user's rows
    // are never briefly visible under a different name.
    setUserAccess([]);
    setUserAccessError("");
    void loadUserAccess(u.id);
  };

  // The signed-in admin's own tenant, which is the ONLY tenant this form can act
  // on: `GET /api/users` returns only users inside it and `PUT /api/users/:id`
  // pins `organization_id` to the caller's own org regardless of what is sent.
  // Derived from the auth context (not from the user being edited) because that is
  // the value the server will actually write.
  const ownOrgId = user?.organization_id != null ? String(user.organization_id) : "";
  const ownOrgName =
    orgs.find((o) => o.id === user?.organization_id)?.name ??
    user?.organization_slug ??
    "Your organization";

  const closeModal = () => {
    if (saving || resetBusy) return;
    setModalOpen(false);
    setSaveError("");
    setForm(EMPTY);
    setResetStep("idle");
    setResetResult(null);
    setResetError("");
  };

  // Issue a temporary password for the user currently open in the drawer.
  // Deliberately NOT optimistic and deliberately not "undo"-able: the old password
  // stops working immediately, so the confirm step (resetStep === "confirm") is
  // what stands between an admin and locking a colleague out by mis-click.
  const handleReset = async () => {
    if (form.id === null) return;
    setResetBusy(true);
    setResetError("");
    try {
      const res = await api.resetUserPassword(form.id);
      setResetResult(res);
      setCopied("no");
      setResetStep("done");
      // Refresh so the grid shows the "Must change" badge the reset just set.
      await load();
    } catch (err) {
      setResetError(err instanceof ApiError ? err.message : "Could not reset the password");
    } finally {
      setResetBusy(false);
    }
  };

  const copyTemporaryPassword = async () => {
    const value = resetResult?.temporary_password;
    if (!value) return;
    try {
      // Only available in a secure context (https or localhost). If it is missing
      // the admin still has to be able to read the password off the screen, so a
      // failure is a message rather than an error.
      await navigator.clipboard.writeText(value);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError("");
    try {
      if (form.id === null) {
        await api.createUser({
          email: form.email,
          password: form.password,
          display_name: form.display_name,
          role: form.role,
          school_id: form.school_id ? Number(form.school_id) : null,
          organization_id: form.organization_id ? Number(form.organization_id) : null,
          show_on_test_screen: form.show_on_test_screen,
        });
        setMessage("User created.");
      } else {
        await api.updateUser(form.id, {
          display_name: form.display_name,
          email: form.email,
          role: form.role,
          school_id: form.school_id ? Number(form.school_id) : null,
          organization_id: form.organization_id ? Number(form.organization_id) : null,
          active: form.active,
          show_on_test_screen: form.show_on_test_screen,
        });
        // A toast rather than the banner, for the reason in Toast.tsx. The
        // banner is CLEARED rather than left alone: an earlier action's message
        // would otherwise be sitting there contradicting what was just saved.
        setMessage("");
        showToast("User updated successfully");
      }
      await load();
      closeModal();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Could not save user");
    } finally {
      setSaving(false);
    }
  };

  // Set a login mode. Optimistic update with rollback on failure.
  const setLoginModeValue = async (mode: LoginMode) => {
    if (loginModeOverride) return; // locked by env override
    setError("");
    setLoginModeBusy(true);
    const prev = loginMode;
    setLoginMode(mode);
    try {
      await api.updateSetting("login_mode", mode);
      setMessage(`Login mode set to "${mode}".`);
    } catch (err) {
      setLoginMode(prev);
      setError(err instanceof ApiError ? err.message : "Could not update login mode");
    } finally {
      setLoginModeBusy(false);
    }
  };

  const saveMaintenanceMessage = async () => {
    if (loginModeOverride) return;
    setError("");
    setLoginModeBusy(true);
    try {
      await api.updateSetting("maintenance_message", maintenanceMessage.trim());
      setMessage("Maintenance message saved.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save maintenance message");
    } finally {
      setLoginModeBusy(false);
    }
  };

  // Toggle a role's access to the Documents link. Optimistic with rollback.
  //
  // ★ `null` is unrestricted, so turning ONE role off out of that state has to
  // materialise the explicit list of the others. Writing `null` back would make
  // the click look like it did nothing, and writing `[]` would hide Documents from
  // everyone instead of from the one role the admin aimed at.
  const toggleDocRole = async (role: string) => {
    setError("");
    setDocBusy(true);
    const prev = docRoles;
    const current = prev ?? roleKeys;
    const next = current.includes(role)
      ? current.filter((r) => r !== role)
      : [...current, role];
    setDocRoles(next);
    try {
      await api.updateSetting("documents_link", JSON.stringify(next));
      setMessage(
        `Documents link ${next.includes(role) ? "enabled" : "hidden"} for ${roleLabelFor(role)}.`
      );
    } catch (err) {
      setDocRoles(prev);
      setError(err instanceof ApiError ? err.message : "Could not update Documents visibility");
    } finally {
      setDocBusy(false);
    }
  };

  // Toggle a role's visibility of a sidebar menu item. Optimistic with rollback,
  // and the same `null` handling as the Documents toggle above.
  const toggleMenuItemRole = async (item: MenuItemKey, role: string) => {
    setError("");
    setMenuBusy(true);
    const prev = menuItems;
    const stored = prev[item];
    const current = stored ?? roleKeys;
    const nextRoles = current.includes(role)
      ? current.filter((r) => r !== role)
      : [...current, role];
    const next = { ...prev, [item]: nextRoles };
    setMenuItems(next);
    try {
      await api.updateSetting("menu_items", JSON.stringify(next));
      setMessage(
        `${MENU_ITEM_LABELS[item]} ${nextRoles.includes(role) ? "shown" : "hidden"} for ${roleLabelFor(role)}.`
      );
    } catch (err) {
      setMenuItems(prev);
      setError(err instanceof ApiError ? err.message : "Could not update menu visibility");
    } finally {
      setMenuBusy(false);
    }
  };

  // Turn admin Slack alerts on or off. Optimistic with rollback, matching the
  // other switches on this page. Stored as the string "true"/"false"; the server
  // reads it in notify/slack.ts and skips EVERY send while it is "false".
  const toggleSlackEnabled = async (next: boolean) => {
    setError("");
    setSlackEnabledBusy(true);
    const prev = slackEnabled;
    setSlackEnabled(next);
    try {
      await api.updateSetting("slack_notifications_enabled", next ? "true" : "false");
      setMessage(
        next
          ? "Slack notifications turned on."
          : "Slack notifications turned off. No admin alerts will be sent."
      );
    } catch (err) {
      setSlackEnabled(prev);
      setError(err instanceof ApiError ? err.message : "Could not update Slack notifications");
    } finally {
      setSlackEnabledBusy(false);
    }
  };

  // Send a test message to the configured Slack webhook (admin only).
  const sendSlackTest = async () => {
    setError("");
    setSlackBusy(true);
    try {
      const r = await api.sendSlackTest(slackSubject.trim(), slackBody.trim());
      setMessage(r.message || "Test message sent to Slack.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send Slack test message");
    } finally {
      setSlackBusy(false);
    }
  };

  // -------------------------------------------------------------------------
  // Organizations drawer handlers
  // -------------------------------------------------------------------------
  const openOrgCreate = () => {
    setOrgForm(EMPTY_ORG);
    setOrgOpen(true);
    setOrgSaveError("");
  };

  const openOrgEdit = (o: OrganizationWithMembers) => {
    setOrgForm({
      id: o.id,
      name: o.name,
      slug: o.slug,
      description: o.description ?? "",
      active: o.active,
    });
    setOrgOpen(true);
    setOrgSaveError("");
  };

  const closeOrg = () => {
    if (orgSaving) return;
    setOrgOpen(false);
    setOrgSaveError("");
    setOrgForm(EMPTY_ORG);
  };

  const handleOrgSave = async () => {
    setOrgSaving(true);
    setOrgSaveError("");
    try {
      if (orgForm.id === null) {
        await api.createOrganization({
          name: orgForm.name.trim(),
          slug: orgForm.slug.trim() || undefined,
          description: orgForm.description.trim() || null,
          active: orgForm.active,
        });
        setMessage("Organization created.");
      } else {
        await api.updateOrganization(orgForm.id, {
          name: orgForm.name.trim(),
          slug: orgForm.slug.trim() || undefined,
          description: orgForm.description.trim() || null,
          active: orgForm.active,
        });
        setMessage("Organization updated.");
      }
      await load();
      closeOrg();
    } catch (err) {
      setOrgSaveError(err instanceof ApiError ? err.message : "Could not save organization");
    } finally {
      setOrgSaving(false);
    }
  };

  // Toggle an organization active/inactive. Optimistic with rollback.
  const toggleOrgActive = async (o: OrganizationWithMembers) => {
    setError("");
    const next = !o.active;
    const prev = orgs;
    setOrgs(prev.map((x) => (x.id === o.id ? { ...x, active: next } : x)));
    try {
      await api.updateOrganization(o.id, { active: next });
      setMessage(`Organization "${o.name}" ${next ? "activated" : "deactivated"}.`);
    } catch (err) {
      setOrgs(prev);
      setError(err instanceof ApiError ? err.message : "Could not update organization");
    }
  };

  // -------------------------------------------------------------------------
  // System Messages handlers
  // -------------------------------------------------------------------------
  const openSysMsgCreate = () => {
    setSysMsgForm(emptySysMsgForm());
    setSysMsgOpen(true);
    setSysMsgSaveError("");
    setSysMsgDeleteId(null);
  };

  const openSysMsgEdit = (m: SystemMessage) => {
    setSysMsgForm({
      id: m.id,
      title: m.title,
      body: m.body,
      active: m.active,
      // A copy, so editing a message cannot mutate the row it was opened from —
      // and `null` is carried through as `null` rather than expanded, because
      // expanding it would silently narrow an "everyone" message on save.
      audience: m.audience === null ? null : [...m.audience],
    });
    setSysMsgOpen(true);
    setSysMsgSaveError("");
    setSysMsgDeleteId(null);
  };

  const closeSysMsg = () => {
    if (sysMsgSaving) return;
    setSysMsgOpen(false);
    setSysMsgSaveError("");
    setSysMsgForm(emptySysMsgForm());
  };

  const handleSysMsgSave = async () => {
    setSysMsgSaving(true);
    setSysMsgSaveError("");
    try {
      const payload = {
        title: sysMsgForm.title.trim(),
        // Not trimmed: the description is multi-line and the reader sees the
        // line breaks as typed, so leading indentation in a pasted list is
        // meaningful.
        body: sysMsgForm.body,
        active: sysMsgForm.active,
        audience: sysMsgForm.audience,
      };
      if (sysMsgForm.id === null) {
        await api.createSystemMessage(payload);
        setMessage("System message created.");
      } else {
        await api.updateSystemMessage(sysMsgForm.id, payload);
        setMessage("System message updated.");
      }
      await loadSysMsgs();
      closeSysMsg();
    } catch (err) {
      setSysMsgSaveError(err instanceof ApiError ? err.message : "Could not save the message");
    } finally {
      setSysMsgSaving(false);
    }
  };

  // Toggle a message active/inactive from the table, without opening the drawer.
  // Optimistic with rollback, matching the organization toggle above.
  const toggleSysMsgActive = async (m: SystemMessage) => {
    setError("");
    const next = !m.active;
    const prev = sysMsgs;
    setSysMsgs((cur) => cur.map((x) => (x.id === m.id ? { ...x, active: next } : x)));
    try {
      await api.updateSystemMessage(m.id, { active: next });
      setMessage(`Message "${m.title}" ${next ? "activated" : "deactivated"}.`);
    } catch (err) {
      setSysMsgs(prev);
      setError(err instanceof ApiError ? err.message : "Could not update the message");
    }
    // Even on the rollback path the strip's cached list may be wrong, so the
    // refresh runs either way.
    refreshSystemMessages();
  };

  const deleteSysMsg = async (m: SystemMessage) => {
    setError("");
    setSysMsgDeleteId(null);
    try {
      await api.deleteSystemMessage(m.id);
      setMessage(`Message "${m.title}" deleted.`);
      await loadSysMsgs();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete the message");
    }
  };

  // -------------------------------------------------------------------------
  // Roles handlers
  // -------------------------------------------------------------------------
  // A named updater for one capability flag. Assigning through a computed key in
  // the JSX (`{ ...prev, [flag.key]: value }`) is the shape that makes TypeScript
  // widen the object to an index signature and stop checking it; this keeps the
  // object typed as a RoleFormState.
  const setRoleFlag = (key: RoleFlagKey, value: boolean) => {
    setRoleForm((prev) => {
      const next: RoleFormState = { ...prev };
      next[key] = value;
      return next;
    });
  };

  const openRoleCreate = () => {
    setRoleForm(emptyRoleForm());
    setRoleOpen(true);
    setRoleSaveError("");
    setRoleDeleteKey(null);
  };

  const openRoleEdit = (r: RoleRow) => {
    setRoleForm({
      editing: r.role_key,
      role_key: r.role_key,
      label: r.label,
      description: r.description ?? "",
      // A blank stored badge falls back to the picker's default for the same reason
      // `roleBadgeFor` does: `""` is not a colour, and rendering the picker with no
      // selection at all would look like a bug rather than a default.
      badge: r.badge && r.badge.trim() !== "" ? r.badge : "blue",
      can_view: r.can_view,
      can_edit: r.can_edit,
      school_scoped: r.school_scoped,
      is_admin: r.is_admin,
      built_in: r.built_in,
    });
    setRoleOpen(true);
    setRoleSaveError("");
    setRoleDeleteKey(null);
  };

  const closeRole = () => {
    if (roleSaving) return;
    setRoleOpen(false);
    setRoleSaveError("");
    setRoleForm(emptyRoleForm());
  };

  const handleRoleSave = async () => {
    setRoleSaving(true);
    setRoleSaveError("");
    try {
      if (roleForm.editing === null) {
        // ★ The key is OMITTED when the field is blank, not sent empty. The server
        // derives it from the name (`finance_lead`), and — if the derivation is not
        // usable — answers with a message naming the key it derived. Sending ""
        // instead is a validation failure about a field the admin deliberately left
        // alone.
        await api.createRole({
          ...(roleForm.role_key.trim() === "" ? {} : { role_key: roleForm.role_key.trim() }),
          label: roleForm.label.trim(),
          description: roleForm.description.trim(),
          badge: roleForm.badge,
          can_view: roleForm.can_view,
          can_edit: roleForm.can_edit,
          // ★ Sent as a constant rather than from a control, because the Export and
          // Report controls were removed from this form while the columns stayed.
          // A CREATE has no prior value to preserve, so it has to state one — and
          // `true` is what every role in this installation already holds (all four
          // built-ins are seeded with both). Sending the schema default (`false`)
          // would quietly create every new role with two flags nobody can see or
          // set. An EDIT deliberately sends neither; see the branch below.
          can_export: true,
          can_report: true,
          school_scoped: roleForm.school_scoped,
          is_admin: roleForm.is_admin,
        });
        setMessage(`Role "${roleForm.label.trim()}" created.`);
      } else if (roleForm.built_in) {
        // ★ A built-in role's six flags are re-derived from code at every start, so
        // the API refuses them (400, naming each field it will not accept). Sending
        // the name, description and badge only is what keeps renaming a built-in
        // from failing on flags this form disables anyway.
        await api.updateRole(roleForm.editing, {
          label: roleForm.label.trim(),
          description: roleForm.description.trim(),
          badge: roleForm.badge,
        });
        setMessage(`Role "${roleForm.label.trim()}" saved.`);
      } else {
        // ★ `is_admin` is deliberately NOT sent. The API refuses to PROMOTE an
        // existing role to administrator (only a create can grant it), and the form
        // keeps that checkbox fixed for the same reason — so sending it would be a
        // 400 about a control the administrator could not change anyway.
        await api.updateRole(roleForm.editing, {
          label: roleForm.label.trim(),
          description: roleForm.description.trim(),
          badge: roleForm.badge,
          can_view: roleForm.can_view,
          can_edit: roleForm.can_edit,
          // ★ `can_export` / `can_report` are deliberately NOT sent, for the same
          // reason `is_admin` is not (below): their controls no longer exist in this
          // form, so there is no value here that the administrator chose. The update
          // path writes only the fields it is given, so omitting them leaves whatever
          // the role already stores — whereas sending a constant would silently
          // rewrite a flag in the middle of an unrelated label edit.
          school_scoped: roleForm.school_scoped,
        });
        setMessage(`Role "${roleForm.label.trim()}" saved.`);
      }
      setRoleOpen(false);
      setRoleForm(emptyRoleForm());
      // Re-fetch the catalog rather than patching it from the response: the panel's
      // other columns (the census, the built-in flag, the derived key) come from the
      // server, and a locally assembled row would have to guess all three.
      await roleCatalog.reload();
    } catch (err) {
      setRoleSaveError(err instanceof ApiError ? err.message : "Could not save the role");
    } finally {
      setRoleSaving(false);
    }
  };

  const deleteRole = async (r: RoleRow) => {
    setError("");
    setRoleDeleteKey(null);
    try {
      await api.deleteRole(r.role_key);
      setMessage(`Role "${r.label}" deleted.`);
      await roleCatalog.reload();
    } catch (err) {
      // The 409 carries the same sentence the Delete button's tooltip showed, so
      // this path is for the race the census cannot cover (something started
      // referencing the role between the census and the delete).
      setError(err instanceof ApiError ? err.message : "Could not delete the role");
    }
  };

  return (
    <div>
      <PageHead
        title="Settings"
        subtitle="Manage accounts, roles, and access."
        actions={
          <button className="primary-button" onClick={openCreate}>
            + Add User
          </button>
        }
      />

      {error && (
        <div className="alert-error" role="alert">
          {error}
        </div>
      )}
      {message && (
        <div className="alert-success" role="status">
          {message}
        </div>
      )}

      <CollapsibleSection
        title="Users"
        subtitle={`${users.length} user${users.length === 1 ? "" : "s"} · ${users.filter((u) => u.active).length} active`}
        bodyStyle={{ padding: 0 }}
      >
        <div className="grid-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>School</th>
                <th>Status</th>
                <th>Test screen</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", padding: 24 }}>
                    Loading…
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", padding: 24 }}>
                    No users yet. Click <strong>Add User</strong> to create one.
                  </td>
                </tr>
              ) : (
                users.map((u) => {
                  const badge = roleBadgeFor(u.role);
                  return (
                    <tr key={u.id} className="grid-row" onClick={() => openEdit(u)} title="Edit user">
                      <td className="cell-strong" data-label="Name">{u.display_name}</td>
                      <td data-label="Email">{u.email}</td>
                      <td data-label="Role">
                        <span className={`badge ${badge.cls}`}>{badge.label}</span>
                      </td>
                      <td data-label="School">{u.school_name ?? "—"}</td>
                      <td data-label="Status">
                        <span className={`badge ${u.active ? "badge-green" : "badge-gray"}`}>
                          {u.active ? "Active" : "Inactive"}
                        </span>
                        {/* Surfaced here rather than in a new column: an admin who
                            reset a password needs to see that the user has not
                            replaced it yet, and the row is where they look. */}
                        {u.must_change_password && (
                          <span
                            className="badge badge-amber"
                            style={{ marginLeft: 6 }}
                            title="A temporary password was issued; the user must choose a new one at next sign-in"
                          >
                            Must change
                          </span>
                        )}
                      </td>
                      <td data-label="Test screen">
                        <span
                          className={`badge ${u.show_on_test_screen ? "badge-blue" : "badge-gray"}`}
                          title={
                            u.show_on_test_screen
                              ? "Listed in the Select User (Test) login dropdown"
                              : "Not listed in the Select User (Test) login dropdown"
                          }
                        >
                          {u.show_on_test_screen ? "Shown" : "Hidden"}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </CollapsibleSection>

      {/* Roles panel — the installation's role catalog. Sits directly under the
          Users panel because the two are read together: this one says what a role
          may do, the one above says who is in it. */}
      <CollapsibleSection
        title="Roles"
        subtitle="Create roles and choose what each one may do. Roles apply to the whole installation."
        bodyStyle={{ padding: 0 }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          {/* ★ The scope, said out loud. A role is not per school and not per form —
              it is one row in this installation's catalog, offered for every account
              in every organization. An administrator who assumes otherwise will add
              a "Central Office" role here and then wonder why every school can pick
              it. Nothing about the UI would correct that assumption. */}
          <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
            {roles.length > 0 &&
              `${roles.length} role${roles.length === 1 ? "" : "s"} · ${
                roles.filter((r) => r.built_in).length
              } built in · any role can be assigned to any user in any organization`}
          </span>
          <button className="primary-button" onClick={openRoleCreate}>
            + Add Role
          </button>
        </div>
        <div className="grid-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th>Role</th>
                <th>Key</th>
                <th>Access</th>
                <th>Scope</th>
                <th>Users</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {roles.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", padding: 24 }}>
                    {roleCatalog.error
                      ? `Could not load the roles: ${roleCatalog.error}`
                      : "Loading roles…"}
                  </td>
                </tr>
              ) : (
                roles.map((r) => {
                  const usage = roleUsage[r.role_key];
                  const badge = roleBadgeFor(r.role_key);
                  // ★ `Export` and `Report` were removed from this list on request.
                  // The two `can_*` columns still exist on the row and the API still
                  // returns them — only these two labelled badges are gone, because
                  // all four seeded roles carry both and the pair therefore read the
                  // same on every row.
                  const caps = [
                    r.can_view ? "View" : null,
                    r.can_edit ? "Edit" : null,
                  ].filter((c): c is string => c !== null);
                  return (
                    <tr key={r.role_key}>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <span className={`badge ${badge.cls}`}>{r.label}</span>
                          {r.built_in && (
                            <span
                              className="badge badge-gray"
                              // ★ The sentence has to be true on EVERY built-in row,
                              // not just on `admin`. An earlier wording ended "...so
                              // an installation can never be left with no
                              // administrator", which is a claim about the
                              // administrator row shown on `reviewer` too. The
                              // protection is that the installation creates the
                              // role; seeding one administrator this way is the
                              // purpose, not the consequence of deleting this row.
                              title="The installation defines this role and re-applies its access flags at every start. Because the installation creates it, it can never be deleted — seeding one administrator this way is what keeps an installation from ending up with nobody able to administer it."
                            >
                              Built in
                            </span>
                          )}
                        </div>
                        {r.description && (
                          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 4 }}>
                            {r.description}
                          </div>
                        )}
                      </td>
                      <td>
                        {/* The key is what is actually stored — in form-field access
                            lists, message audiences, the menu setting and the
                            Documents link. Shown so an administrator can line this
                            panel up with anything that names a role. */}
                        <code style={{ fontSize: "0.75rem" }}>{r.role_key}</code>
                      </td>
                      <td>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {r.is_admin && <span className="badge badge-orange">Administrator</span>}
                          {caps.map((c) => (
                            <span key={c} className="badge badge-blue">
                              {c}
                            </span>
                          ))}
                          {/* `caps` now tests View and Edit only, so this branch is
                              reached by a role carrying neither. The sentence stays
                              true as written: `can_export` and `can_report` are
                              deliberately not part of the condition, because nothing
                              in the app consults them (see ROLE_FLAGS above). */}
                          {caps.length === 0 && !r.is_admin && (
                            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                              No access — can sign in and nothing else
                            </span>
                          )}
                        </div>
                      </td>
                      <td style={{ fontSize: "0.8125rem" }}>
                        {r.school_scoped ? "Own school only" : "All schools"}
                      </td>
                      <td style={{ fontSize: "0.8125rem" }}>
                        {usage ? (
                          <span title={usage.usage_message ?? "Nothing references this role."}>
                            {usage.usage.users}
                          </span>
                        ) : (
                          <span style={{ color: "var(--text-muted)" }}>—</span>
                        )}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "flex-end",
                            alignItems: "center",
                            gap: 8,
                          }}
                        >
                          {/* ★ Edit is offered on EVERY row, built-in or not.
                              The installation pins a built-in's ACCESS FLAGS only:
                              `label`, `description` and `badge` are deliberately
                              excluded from the re-derivation (see PUT
                              /api/roles/:key, and `handleRoleSave`'s built_in branch)
                              specifically so they stay editable. Gating Edit on
                              `!r.built_in` therefore hid the one part of a built-in
                              that CAN be changed — and because all four seeded roles
                              are built-in, it left this installation with no way to
                              edit any role at all. Only Delete varies by row. */}
                          <button className="secondary-button" onClick={() => openRoleEdit(r)}>
                            Edit
                          </button>
                          {r.built_in ? (
                            <span
                              style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}
                              // True for all four built-ins: the reason is the
                              // re-seed, and a deletion a restart would undo is not
                              // an operation worth offering.
                              title="A built-in role can never be deleted: the installation re-creates it and resets its access flags at every start, so a deletion would be undone by the next restart."
                            >
                              Cannot be deleted
                            </span>
                          ) : roleDeleteKey === r.role_key ? (
                            <>
                              <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                                Delete this role?
                              </span>
                              <button className="secondary-button" onClick={() => setRoleDeleteKey(null)}>
                                Cancel
                              </button>
                              <button
                                className="secondary-button"
                                style={DANGER_BUTTON}
                                onClick={() => void deleteRole(r)}
                              >
                                Delete
                              </button>
                            </>
                          ) : (
                            <>
                              {/* ★ DISABLED, not hidden, and never disabled silently.
                                  The reason sentence comes from the server
                                  (`usage_message`), composed by the same helper the
                                  DELETE refusal interpolates — so a greyed-out button
                                  and the 409 behind it cannot disagree. Hiding the
                                  button instead would leave an administrator unable
                                  to tell a protected role from a broken page. */}
                              <button
                                className="secondary-button"
                                style={
                                  usage && usage.total > 0
                                    ? { ...DANGER_BUTTON, opacity: 0.55 }
                                    : DANGER_BUTTON
                                }
                                disabled={usage === undefined || usage.total > 0}
                                title={
                                  usage === undefined
                                    ? "Checking whether anything uses this role…"
                                    : usage.total > 0
                                      ? usage.usage_message ?? "This role is in use."
                                      : `Delete the role "${r.label}"`
                                }
                                onClick={() => setRoleDeleteKey(r.role_key)}
                              >
                                {usage && usage.total > 0 ? "In use" : "Delete"}
                              </button>
                            </>
                          )}
                        </div>
                        {/* The sentence is repeated as VISIBLE text, not only as a
                            title: a disabled button does not take pointer events in
                            every browser, so a tooltip on it is unreachable — which
                            would make the most important line on the row the one
                            nobody can read. */}
                        {!r.built_in && usage && usage.total > 0 && usage.usage_message && (
                          <div
                            style={{
                              fontSize: "0.6875rem",
                              color: "var(--text-muted)",
                              marginTop: 4,
                              maxWidth: 340,
                              marginLeft: "auto",
                            }}
                          >
                            {usage.usage_message}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", margin: 0, padding: "12px 14px" }}>
          Roles are installation-wide: every role can be assigned to any user in any
          organization. <strong>Built-in roles</strong> cannot be deleted, and their access
          flags come from the installation rather than from this page — this is what keeps
          an installation from ending up with no administrator. A role that anything still
          references cannot be deleted either; the button says what is holding it, and the
          API refuses it for the same reason.
        </p>
      </CollapsibleSection>

      {/* Login Mode panel */}
      <CollapsibleSection
        title="Login Mode"
        subtitle="Control how users sign in to School Forms"
      >
          {loginModeOverride && (
            <div
              style={{
                background: "rgb(255,247,229)",
                color: "rgb(146,90,10)",
                padding: "10px 14px",
                borderRadius: "var(--radius)",
                fontSize: "0.8125rem",
                marginBottom: 16,
              }}
            >
              Login mode is locked to <strong>{loginModeOverride}</strong> by the{" "}
              <code>LOGIN_MODE</code> environment variable and cannot be changed here.
            </div>
          )}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 14,
            }}
          >
            {LOGIN_MODES.map((m) => {
              const active = loginMode === m.value;
              return (
                <button
                  key={m.value}
                  type="button"
                  disabled={!!loginModeOverride || loginModeBusy}
                  onClick={() => void setLoginModeValue(m.value)}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    gap: 4,
                    padding: 14,
                    borderRadius: "var(--radius)",
                    border: `1.5px solid ${active ? "var(--accent)" : "var(--border)"}`,
                    background: active ? "rgb(238,246,255)" : "var(--app-bg)",
                    cursor: !!loginModeOverride ? "not-allowed" : "pointer",
                    textAlign: "left",
                    fontFamily: "inherit",
                      }}
                >
                  <span
                    className={`badge ${active ? "badge-blue" : `badge-${m.tone}`}`}
                    style={{ alignSelf: "flex-start" }}
                  >
                    {active ? "ACTIVE" : m.label}
                  </span>
                  <span style={{ fontSize: "0.8125rem", fontWeight: 700, color: "var(--text)" }}>
                    {m.label}
                  </span>
                  <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{m.desc}</span>
                </button>
              );
            })}
          </div>

          <div style={{ marginTop: 18 }}>
            <div className="filter-group" style={{ minWidth: 0 }}>
              <label htmlFor="maintenance-message">Maintenance message</label>
              <textarea
                id="maintenance-message"
                value={maintenanceMessage}
                onChange={(e) => setMaintenanceMessage(e.target.value)}
                rows={3}
                disabled={!!loginModeOverride || loginModeBusy}
              />
            </div>
            <button
              type="button"
              className="primary-button"
              disabled={!!loginModeOverride || loginModeBusy || !maintenanceMessage.trim()}
              onClick={() => void saveMaintenanceMessage()}
              style={{ marginTop: 10 }}
            >
              Save Maintenance Message
            </button>
          </div>
      </CollapsibleSection>

      {/* Documents link panel — which roles see the Documents sidebar link */}
      <CollapsibleSection
        title="Documents Link"
        subtitle="Show or hide the Documents sidebar link, enabled by role"
      >
        <p style={{ fontSize: "0.8125rem", color: "var(--text-muted)", margin: "0 0 14px" }}>
          Toggle which roles see <strong>Documents</strong> in the sidebar. Toggling a role
          off hides the link for those users immediately; the API also refuses their
          requests. At least one role should remain enabled for the page to be used.
        </p>
        {/* The scope, stated rather than implied. "Unrestricted" and "all four roles
            happen to be on" are the same picture in the list below but different
            stored values, and the difference only shows up when a fifth role is
            created. */}
        <p style={{ fontSize: "0.8125rem", color: "var(--text-muted)", margin: "0 0 14px" }}>
          {docRoles === null
            ? "Currently unrestricted: every role can see Documents, including any role created later."
            : docRoles.length === 0
              ? "Currently enabled for no role — the link is hidden from everyone."
              : `Currently enabled for ${docRoles.map((r) => roleLabelFor(r)).join(", ")}.`}
        </p>
        {roles.length === 0 ? (
          <p style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>
            {roleCatalog.error ? `Could not load the role list: ${roleCatalog.error}` : "Loading roles…"}
          </p>
        ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {roles.map((row) => {
            const has = docRoles === null || docRoles.includes(row.role_key);
            const badge = roleBadgeFor(row.role_key);
            return (
              <div
                key={row.role_key}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "12px 14px",
                  borderRadius: "var(--radius)",
                  border: "1px solid var(--border)",
                  background: "var(--app-bg)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className={`badge ${badge.cls}`}>{badge.label}</span>
                  <span style={{ fontSize: "0.8125rem", color: "var(--text)" }}>
                    {badge.label}
                    {has ? " — can see Documents" : " — cannot see Documents"}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                    {has ? "Visible" : "Hidden"}
                  </span>
                  <Toggle
                    checked={has}
                    disabled={docBusy}
                    onChange={() => void toggleDocRole(row.role_key)}
                  />
                </div>
              </div>
            );
          })}
        </div>
        )}
      </CollapsibleSection>

      {/* Menu Settings — show/hide sidebar items, by role */}
      <CollapsibleSection
        title="Menu Settings"
        subtitle="Show or hide sidebar menu items, enabled by role"
      >
        <p style={{ fontSize: "0.8125rem", color: "var(--text-muted)", margin: "0 0 14px" }}>
          Choose which sidebar items each role can see. Hiding an item removes it from
          the menu for that role; it does not delete any data or change permissions on
          the underlying pages.
        </p>
        <p style={{ fontSize: "0.8125rem", color: "var(--text-muted)", margin: "0 0 14px" }}>
          <strong>Documents</strong> is not listed here. It is controlled by the
          Documents Link panel above, which also decides whether the documents API
          accepts a request.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {MENU_ITEMS.map((item) => (
            <div key={item}>
              <div
                style={{
                  fontSize: "0.6875rem",
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "var(--text-muted)",
                  marginBottom: 8,
                }}
              >
                {MENU_ITEM_LABELS[item]}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {roles.map((row) => {
                  const allowed = menuItems[item];
                  const has = allowed === null || allowed.includes(row.role_key);
                  const badge = roleBadgeFor(row.role_key);
                  return (
                    <div
                      key={row.role_key}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                        padding: "12px 14px",
                        borderRadius: "var(--radius)",
                        border: "1px solid var(--border)",
                        background: "var(--app-bg)",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span className={`badge ${badge.cls}`}>{badge.label}</span>
                        <span style={{ fontSize: "0.8125rem", color: "var(--text)" }}>
                          {has ? "Sees this menu item" : "Menu item hidden"}
                        </span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                          {has ? "Visible" : "Hidden"}
                        </span>
                        <Toggle
                          checked={has}
                          disabled={menuBusy}
                          onChange={() => void toggleMenuItemRole(item, row.role_key)}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </CollapsibleSection>

      {/* Slack notifications — the on/off switch plus a test panel to verify the
          admin alert webhook. */}
      <CollapsibleSection
        title="Slack Notifications"
        subtitle="Turn admin alerts on or off, and send a test message"
      >
        {/* The master switch. Its label is its children, so the visible words are
            the checkbox's accessible name (see components/Toggle.tsx). */}
        <div style={{ margin: "0 0 14px" }}>
          <Toggle
            checked={slackEnabled}
            disabled={slackEnabledBusy}
            onChange={(v) => void toggleSlackEnabled(v)}
          >
            Send Slack notifications
          </Toggle>
          <p style={{ fontSize: "0.8125rem", color: "var(--text-muted)", margin: "6px 0 0" }}>
            {slackEnabled
              ? "Admin alerts are delivered to Slack when a webhook is configured."
              : "Off — no admin alerts are sent, even when a webhook is configured."}
          </p>
        </div>

        <p style={{ fontSize: "0.8125rem", color: "var(--text-muted)", margin: "0 0 14px" }}>
          Admin alerts (new submissions, generated documents) are delivered to{" "}
          <strong>Slack</strong> through a webhook. Use this panel to verify the webhook
          is working and preview how a message looks. The subject and body support Slack
          formatting: <code>*bold*</code>, <code>_italic_</code>, <code>`code`</code>,{" "}
          <code>&gt;quote</code>, and <code>&lt;https://example.com|link&gt;</code>.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="filter-group" style={{ minWidth: 0 }}>
            <label htmlFor="slack-subject">Subject</label>
            <input
              id="slack-subject"
              className="edit-input"
              value={slackSubject}
              onChange={(e) => setSlackSubject(e.target.value)}
              placeholder="Test notification"
            />
          </div>
          <div className="filter-group" style={{ minWidth: 0 }}>
            <label htmlFor="slack-body">Body</label>
            <textarea
              id="slack-body"
              className="edit-input"
              value={slackBody}
              onChange={(e) => setSlackBody(e.target.value)}
              rows={4}
              placeholder="Message body — Slack markdown supported"
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <button
              type="button"
              className="primary-button"
              disabled={slackBusy || !slackSubject.trim() || !slackEnabled}
              onClick={() => void sendSlackTest()}
              style={{ alignSelf: "flex-start" }}
            >
              {slackBusy ? "Sending…" : "Send Test Message"}
            </button>
            {!slackEnabled && (
              <span className="muted-note">Turn notifications on to send a test.</span>
            )}
          </div>
        </div>
      </CollapsibleSection>

      {/* Access Requests — the queue for private forms
          (docs/plans/public-private-forms.md §10.2).
          ★ The pending count is on the TITLE because the section is closed by
          default and nothing pushes (§15 Q3): the count IS the notification. */}
      <CollapsibleSection
        title={`Access Requests${accessPending > 0 ? ` (${accessPending} pending)` : ""}`}
        subtitle="Requests to read a private form. Approving is the only thing that grants access."
        bodyStyle={{ padding: 0 }}
      >
        {accessError && (
          <div className="alert-error" role="alert" style={{ margin: 14 }}>
            {accessError}
          </div>
        )}
        <table className="grid">
          <thead>
            <tr>
              <th>Requester</th>
              <th>Form</th>
              <th>Requested</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {accessRequests.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ textAlign: "center", padding: 24 }}>
                  No pending requests.
                </td>
              </tr>
            ) : (
              accessRequests.map((r) => {
                const key = `${r.user_id}:${r.form_id}`;
                const busy = accessBusy === key;
                return (
                  <tr key={key}>
                    <td data-label="Requester">
                      <div className="cell-strong">{r.user_name ?? `User ${r.user_id}`}</div>
                      <div className="cell-sub">
                        {r.user_email}
                        {r.school_name ? ` · ${r.school_name}` : ""}
                      </div>
                    </td>
                    <td data-label="Form">
                      <div className="cell-strong">
                        {r.form_code ? `#${r.form_id} ` : ""}
                        {r.form_title}
                      </div>
                      <button
                        type="button"
                        className="badge-button"
                        onClick={() => void toggleGrants(r.form_id)}
                      >
                        {grantsFormId === r.form_id ? "Hide access list" : "Who has access?"}
                      </button>
                    </td>
                    <td data-label="Requested" className="cell-mono">
                      {new Date(r.requested_at).toLocaleDateString()}
                    </td>
                    <td>
                      {declineFor === key ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          <input
                            className="edit-input"
                            placeholder="Reason (shown to the requester)"
                            value={declineNote}
                            onChange={(e) => setDeclineNote(e.target.value)}
                          />
                          <div style={{ display: "flex", gap: 6 }}>
                            <button
                              type="button"
                              className="badge-button danger"
                              disabled={busy}
                              onClick={() => void decide(r, "decline", declineNote)}
                            >
                              Confirm decline
                            </button>
                            <button
                              type="button"
                              className="badge-button"
                              onClick={() => {
                                setDeclineFor(null);
                                setDeclineNote("");
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div style={{ display: "flex", gap: 6 }}>
                          <button
                            type="button"
                            className="badge-button"
                            disabled={busy}
                            onClick={() => void decide(r, "approve")}
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            className="badge-button"
                            disabled={busy}
                            onClick={() => {
                              setDeclineFor(key);
                              setDeclineNote("");
                            }}
                          >
                            Decline
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>

        {/* The access list for one form, with a Revoke per row and each
            account's event history. ★ A revoke control needs a list to act on,
            and the HISTORY is what makes "declined" and "access removed"
            distinguishable (§15 Q6/Q7). */}
        {grantsFormId !== null && (
          <div style={{ borderTop: "1px solid var(--border)", padding: "14px" }}>
            <h3 className="section-title">Who can read this form</h3>
            {grants.length === 0 ? (
              <p className="empty-note">Nobody holds a grant on this form.</p>
            ) : (
              <table className="grid">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Status</th>
                    <th>History</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {grants.map((g) => (
                    <tr key={g.user_id}>
                      <td data-label="Account">
                        <div className="cell-strong">{g.user_name ?? `User ${g.user_id}`}</div>
                        <div className="cell-sub">{g.user_email}</div>
                      </td>
                      <td data-label="Status">
                        <span
                          className={`badge ${
                            g.status === "approved"
                              ? "badge-green"
                              : g.status === "pending"
                                ? "badge-blue"
                                : "badge-gray"
                          }`}
                        >
                          {g.status ?? "no row"}
                        </span>
                        {g.source === "backfill" && (
                          <div className="cell-sub">Grandfathered when the form went private</div>
                        )}
                      </td>
                      <td data-label="History">
                        <ul className="event-list">
                          {g.events.map((e) => (
                            <li key={e.id}>
                              <span className="cell-mono">{e.event}</span>{" "}
                              {new Date(e.created_at).toLocaleDateString()}
                              {e.actor_name ? ` by ${e.actor_name}` : ""}
                              {e.note ? ` — “${e.note}”` : ""}
                            </li>
                          ))}
                        </ul>
                      </td>
                      <td>
                        {g.status === "approved" && (
                          <button
                            type="button"
                            className="badge-button danger"
                            disabled={accessBusy === `${g.user_id}:${grantsFormId}`}
                            onClick={() =>
                              void decide({ user_id: g.user_id, form_id: grantsFormId }, "revoke")
                            }
                          >
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </CollapsibleSection>

      {/* Webhook Log — the log itself stays on its own page because its filters
          are URL-driven: the dashboard, the post-publish banner, and the form
          designer all link into it with query params. Settings therefore links
          out to it rather than embedding it, which takes it off the sidebar
          without breaking any of those deep links. */}
      <CollapsibleSection
        title="Webhook Log"
        subtitle="Every response Google Forms has posted to this app, including the rejected ones"
      >
        <p style={{ fontSize: "0.8125rem", color: "var(--text-muted)", margin: "0 0 14px" }}>
          A response that is rejected — because its form was unpublished, its secret was
          wrong, or its body was invalid — is recorded in the log instead of disappearing.
          The log is read-only apart from <strong>Replay</strong>, which re-sends a rejected
          attempt against its form's current state. It is always available to admins and
          cannot be switched off.
        </p>
        {webhookSummary && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
              marginBottom: 14,
              fontSize: "0.8125rem",
            }}
          >
            <span>
              <strong>Last {webhookSummary.days} days</strong>
            </span>
            <span className="badge badge-green">{webhookSummary.window.succeeded} delivered</span>
            {webhookSummary.window.failed > 0 && (
              <span className="badge badge-red">{webhookSummary.window.failed} failed</span>
            )}
            {webhookSummary.unattributed > 0 && (
              <span
                className="badge badge-slate"
                title="Attempts that could not be attributed to a form"
              >
                {webhookSummary.unattributed} unattributed
              </span>
            )}
          </div>
        )}
        <Link
          to="/admin/webhooks"
          className="primary-button"
          style={{ textDecoration: "none" }}
        >
          <Webhook size={16} />
          Open Webhook Log
        </Link>
      </CollapsibleSection>

      {/* System Messages — the banners shown at the top of every page until each
          user closes them out. This list is the AUTHORING view: it holds every
          message, Active or Inactive, because that is what an admin has to
          manage. What a given user is shown is decided by the strip in
          components/SystemMessageBar.tsx, from a different endpoint that applies
          the active flag, the audience and the per-user dismissals in SQL. */}
      <CollapsibleSection
        title="System Messages"
        subtitle="Banners shown at the top of every page until each user closes them out"
        bodyStyle={{ padding: 0 }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <button className="primary-button" onClick={openSysMsgCreate}>
            + Add Message
          </button>
        </div>
        <table className="grid">
          <thead>
            <tr>
              <th>Message</th>
              <th>Status</th>
              <th>Audience</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sysMsgs.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ textAlign: "center", padding: 24 }}>
                  No messages yet.
                </td>
              </tr>
            ) : (
              sysMsgs.map((m) => {
                // The first line of the description, as a preview. Deliberately
                // not a CSS line-clamp on the whole text: a clipped element
                // measures correctly and renders sliced, so the truncation is
                // done in the data and marked with an ellipsis the reader can
                // see.
                const preview = m.body.split("\n")[0].trim();
                const more = m.body.trim() !== preview;
                return (
                  <tr key={m.id}>
                    <td data-label="Message">
                      <div style={{ fontWeight: 600 }}>{m.title}</div>
                      {preview !== "" && (
                        <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 2 }}>
                          {preview}
                          {more ? " …" : ""}
                        </div>
                      )}
                    </td>
                    <td data-label="Status">
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Toggle
                          checked={m.active}
                          onChange={() => void toggleSysMsgActive(m)}
                        />
                        <span className={`badge ${m.active ? "badge-green" : "badge-gray"}`}>
                          {m.active ? "Active" : "Inactive"}
                        </span>
                      </div>
                    </td>
                    <td data-label="Audience">{audienceLabel(m.audience)}</td>
                    <td
                      data-label="Actions"
                      style={{ textAlign: "right", whiteSpace: "nowrap" }}
                    >
                      {sysMsgDeleteId === m.id ? (
                        <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                            Delete for every user?
                          </span>
                          <button
                            className="secondary-button"
                            onClick={() => setSysMsgDeleteId(null)}
                          >
                            Cancel
                          </button>
                          <button
                            className="secondary-button"
                            style={DANGER_BUTTON}
                            onClick={() => void deleteSysMsg(m)}
                          >
                            Delete
                          </button>
                        </div>
                      ) : (
                        <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                          <button className="secondary-button" onClick={() => openSysMsgEdit(m)}>
                            Edit
                          </button>
                          <button
                            className="secondary-button"
                            style={DANGER_BUTTON}
                            onClick={() => setSysMsgDeleteId(m.id)}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", margin: 0, padding: "12px 14px" }}>
          Closing a message is recorded against the one user who closed it, and cannot be undone
          for them — post a new message to say it again. A message whose audience is{" "}
          <strong>No one</strong> is stored but delivered to nobody; switching one to{" "}
          <strong>Inactive</strong> withdraws it from everyone who has not already closed it.
        </p>
      </CollapsibleSection>

      {/* Organizations panel */}
      <CollapsibleSection
        title="Organizations"
        subtitle="Tenant boundaries — schools are shared across all organizations"
        bodyStyle={{ padding: 0 }}
      >        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
          <button className="primary-button" onClick={openOrgCreate}>
            + Add Organization
          </button>
        </div>
        <table className="grid">
          <thead>
            <tr>
              <th>Name</th>
              <th>Slug</th>
              <th>Members</th>
              <th>Status</th>
            </tr>
          </thead>
            <tbody>
              {orgs.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ textAlign: "center", padding: 24 }}>
                    No organizations.
                  </td>
                </tr>
              ) : (
                orgs.map((o) => (
                  <tr key={o.id}>
                    <td className="cell-strong" data-label="Name" onClick={() => openOrgEdit(o)} style={{ cursor: "pointer" }}>{o.name}</td>
                    <td className="cell-mono" data-label="Slug" onClick={() => openOrgEdit(o)} style={{ cursor: "pointer" }}>{o.slug}</td>
                    <td data-label="Members">{o.member_count} user{o.member_count === 1 ? "" : "s"}</td>
                    <td data-label="Status">
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Toggle
                          checked={o.active}
                          disabled={o.id === user?.organization_id}
                          onChange={() => void toggleOrgActive(o)}
                        />
                        <span className={`badge ${o.active ? "badge-green" : "badge-gray"}`}>
                          {o.active ? "Active" : "Inactive"}
                        </span>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
      </CollapsibleSection>

      {/* Schools panel — the district school list. This used to be its own page
          at /admin/schools; it now lives here so all data administration is in
          one place. It renders its own toolbar, table, and pager, so the body
          padding is removed to keep it flush with the section. */}
      <CollapsibleSection
        title="Schools"
        subtitle="The district list, maintained by hand. A submission is routed by matching its school answer to a name here."
        bodyStyle={{ padding: 0 }}
      >
        <SchoolsPanel />
      </CollapsibleSection>

      {/* School Name Matching — the remedy for a submission whose school answer
          matches no school (docs/plans/school-name-reconciliation.md). Sits
          beside Schools: that list is what the app knows, this is what the forms
          are saying that it does not. */}
      <CollapsibleSection
        title="School Name Matching"
        subtitle="Google Form school answers that don't match a school in the list — match one to fix it for good."
        bodyStyle={{ padding: 0 }}
      >
        <SchoolNameMatchingPanel />
      </CollapsibleSection>

      {/* Create / edit organization — right slide-out drawer */}
      <div className={`drawer-overlay ${orgOpen ? "open" : ""}`} onClick={closeOrg}>
        <div className="drawer" onClick={(e) => e.stopPropagation()}>
          <div className="drawer-head">
            <h2>{orgForm.id === null ? "Add Organization" : "Edit Organization"}</h2>
            <button className="icon-button close" onClick={closeOrg} title="Close">
              <X size={18} />
            </button>
          </div>
          <div className="drawer-body">
            {orgSaveError && (
              <div className="alert-error" role="alert" style={{ marginBottom: 12 }}>
                {orgSaveError}
              </div>
            )}
            <div className="form-grid">
              <Field label="Name" full>
                <input
                  className="edit-input"
                  value={orgForm.name}
                  onChange={(e) => setOrgForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Academics"
                />
              </Field>
              <Field label="Slug" full>
                <input
                  className="edit-input"
                  value={orgForm.slug}
                  onChange={(e) => setOrgForm((f) => ({ ...f, slug: e.target.value }))}
                  placeholder="academics (auto-derived from name if left blank)"
                />
              </Field>
              <Field label="Description" full>
                <textarea
                  className="edit-input"
                  value={orgForm.description}
                  onChange={(e) => setOrgForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="Details about this organization"
                  rows={4}
                />
              </Field>
              <Field label="Active" full>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Toggle
                    checked={orgForm.active}
                    disabled={orgForm.id === user?.organization_id}
                    onChange={(v) => setOrgForm((f) => ({ ...f, active: v }))}
                  />
                  <span style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>
                    {orgForm.active ? "Active" : "Inactive"}
                    {orgForm.id === user?.organization_id ? " (your organization)" : ""}
                    {!orgForm.active && " — users of this org can no longer sign in"}
                  </span>
                </div>
              </Field>
            </div>
          </div>
          <div className="drawer-foot">
            <span className="muted-note">{orgForm.id === null ? "New organization" : "Editing organization"}</span>
            <button className="secondary-button" onClick={closeOrg} disabled={orgSaving}>
              Cancel
            </button>
            <button
              className="primary-button"
              onClick={() => void handleOrgSave()}
              disabled={orgSaving || !orgForm.name.trim()}
            >
              {orgSaving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>

      {/* Create / edit system message — right slide-out drawer */}
      <div className={`drawer-overlay ${sysMsgOpen ? "open" : ""}`} onClick={closeSysMsg}>
        <div className="drawer" onClick={(e) => e.stopPropagation()}>
          <div className="drawer-head">
            <h2>{sysMsgForm.id === null ? "Add Message" : "Edit Message"}</h2>
            <button className="icon-button close" onClick={closeSysMsg} title="Close">
              <X size={18} />
            </button>
          </div>
          <div className="drawer-body">
            {sysMsgSaveError && (
              <div className="alert-error" role="alert" style={{ marginBottom: 12 }}>
                {sysMsgSaveError}
              </div>
            )}
            <div className="form-grid">
              <Field label="Title" full>
                <input
                  className="edit-input"
                  value={sysMsgForm.title}
                  maxLength={200}
                  onChange={(e) => setSysMsgForm((f) => ({ ...f, title: e.target.value }))}
                  placeholder="Fall semester forms are open"
                />
              </Field>
              <Field label="Description" full>
                <textarea
                  className="edit-input"
                  value={sysMsgForm.body}
                  maxLength={4000}
                  onChange={(e) => setSysMsgForm((f) => ({ ...f, body: e.target.value }))}
                  placeholder="Anything the reader needs to know. Line breaks are kept."
                  rows={6}
                />
              </Field>
              {/* Not a <Field>: Field renders a <label>, and a <label> containing
                  buttons hands every chip click to the first control inside it —
                  so clicking "Staff" would also toggle "Admin". The caption is a
                  plain span for the same reason. */}
              <div style={{ gridColumn: "1 / -1" }}>
                <span
                  style={{
                    display: "block",
                    fontSize: "0.6875rem",
                    fontWeight: 600,
                    color: "var(--text-muted)",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    marginBottom: 6,
                  }}
                >
                  Target Audience
                </span>
                <AudienceChips
                  value={sysMsgForm.audience}
                  onChange={(next) => setSysMsgForm((f) => ({ ...f, audience: next }))}
                />
                <span
                  style={{ display: "block", fontSize: "0.6875rem", color: "var(--text-muted)", marginTop: 6 }}
                >
                  {/* Three stored states, three sentences. `null` is not "every role
                      that exists" — it is "everyone, including roles created after
                      this message was saved", which is a different and often the
                      intended meaning. Collapsing it into a list would narrow the
                      message the moment an administrator adds a role. */}
                  {sysMsgForm.audience === null
                    ? "Visible to everyone — including any role created later."
                    : sysMsgForm.audience.length === 0
                      ? "No role selected — this message is stored but delivered to nobody."
                      : `Visible to ${audienceLabel(sysMsgForm.audience)}.`}
                </span>
              </div>
              <Field label="Active" full>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Toggle
                    checked={sysMsgForm.active}
                    onChange={(v) => setSysMsgForm((f) => ({ ...f, active: v }))}
                  />
                  <span style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>
                    {sysMsgForm.active ? "Active" : "Inactive"}
                    {!sysMsgForm.active && " — stored, but no user is shown it"}
                  </span>
                </div>
              </Field>
            </div>
          </div>
          <div className="drawer-foot">
            <span className="muted-note">
              {sysMsgForm.id === null ? "New message" : "Editing message"}
            </span>
            <button className="secondary-button" onClick={closeSysMsg} disabled={sysMsgSaving}>
              Cancel
            </button>
            <button
              className="primary-button"
              onClick={() => void handleSysMsgSave()}
              disabled={sysMsgSaving || !sysMsgForm.title.trim()}
            >
              {sysMsgSaving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>

      {/* Create / edit user — right slide-out drawer. Also hosts the password\n          reset flow (see resetStep), which takes over the body and footer. */}
      <div className={`drawer-overlay ${modalOpen ? "open" : ""}`} onClick={closeModal}>
        <div className="drawer" onClick={(e) => e.stopPropagation()}>
          <div className="drawer-head">
            <h2>
              {resetStep === "idle"
                ? form.id === null
                  ? "Add User"
                  : "Edit User"
                : resetStep === "confirm"
                  ? "Reset Password"
                  : "Temporary Password"}
            </h2>
            <button className="icon-button close" onClick={closeModal} title="Close">
              <X size={18} />
            </button>
          </div>
          <div className="drawer-body">
            {(resetStep === "idle" ? saveError : resetError) && (
              <div className="alert-error" role="alert" style={{ marginBottom: 12 }}>
                {resetStep === "idle" ? saveError : resetError}
              </div>
            )}

            {resetStep === "confirm" ? (
              <div>
                <p style={{ marginTop: 0 }}>
                  Issue a temporary password for <strong>{form.display_name}</strong> (
                  {form.email})?
                </p>
                <div className="alert-error" role="alert">
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    <li>Their current password stops working immediately.</li>
                    <li>
                      A session that is already open keeps working until the page is reloaded —
                      access tokens are not revoked server-side.
                    </li>
                    <li>
                      The next time they open the app they must choose a new password, and they
                      cannot do anything else until they do.
                    </li>
                    <li>The temporary password is shown once and cannot be retrieved later.</li>
                  </ul>
                </div>
                <p style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>
                  Pass it to {form.display_name} over a channel you trust — a phone call or
                  in person, not the same email that carries the account.
                </p>
              </div>
            ) : resetStep === "done" && resetResult ? (
              <div>
                <p style={{ marginTop: 0 }}>
                  A temporary password has been issued for <strong>{resetResult.display_name}</strong>.
                </p>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    margin: "0 0 12px",
                    padding: "12px 14px",
                    background: "var(--panel-bg, #f6f7f9)",
                    border: "1px solid var(--border, #d8dce2)",
                    borderRadius: "var(--radius)",
                  }}
                >
                  <code
                    style={{
                      flex: 1,
                      fontSize: "0.9375rem",
                      letterSpacing: "0.06em",
                      wordBreak: "break-all",
                      userSelect: "all",
                    }}
                  >
                    {resetResult.temporary_password}
                  </code>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void copyTemporaryPassword()}
                  >
                    {copied === "yes" ? <Check size={16} /> : <Copy size={16} />}
                    {copied === "yes" ? "Copied" : "Copy"}
                  </button>
                </div>

                {copied === "failed" && (
                  <div className="alert-error" role="alert" style={{ marginBottom: 12 }}>
                    Could not copy automatically — select the password above and copy it
                    manually.
                  </div>
                )}

                <div className="alert-error" role="alert">
                  This is the only time it will be shown. There is no way to display it again;
                  if it is lost, reset the password once more to get a new one.
                </div>
              </div>
            ) : (
              <>
                <div className="form-grid">
              <Field label="Display name">
                <input
                  className="edit-input"
                  value={form.display_name}
                  onChange={(e) => setForm((f) => ({ ...f, display_name: e.target.value }))}
                  placeholder="Jane Doe"
                />
              </Field>
              <Field label="Email">
                <input
                  className="edit-input"
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="jane@school.org"
                />
              </Field>
              {form.id === null && (
                <Field label="Password">
                  <input
                    className="edit-input"
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                    placeholder="min 8 characters"
                  />
                </Field>
              )}
              <Field label="Role">
                <select
                  className="edit-select"
                  value={form.role}
                  onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
                >
                  {roles.map((r) => (
                    <option key={r.role_key} value={r.role_key}>
                      {r.label}
                    </option>
                  ))}
                  {/* The catalog is fetched once and may still be in flight. A role
                      cannot be removed from the catalog while a user references it
                      (the FK refuses), so once it loads it always holds the value
                      being edited — but rendering the raw key while the request is
                      outstanding is better than a select with no matching option,
                      which React shows as a blank field on the account you opened. */}
                  {roles.length === 0 && <option value={form.role}>{form.role}</option>}
                </select>
              </Field>
              {/* The tenant is SHOWN, not chosen.

                  This control used to list every organization while its own
                  placeholder and label implied "your organization", and
                  `handleSave` submits the field on every save — including a save
                  whose only intent was toggling Active. But the server discards
                  it: `PUT /api/users/:id` always writes the caller's org, and
                  `GET /api/users` only ever returns users inside it. So the
                  dropdown offered a choice that could not take effect, and the
                  one thing it COULD do was disagree with the caller's org — which
                  is what produced "You can only assign users within your own
                  organization" while activating a user in the admin's OWN
                  organization. (The Users grid renders no organization column, so
                  the disagreement was never visible anywhere in the UI.)

                  The boundary itself is the server's to enforce; this just stops
                  the form promising a capability it does not have. */}
              <Field label="Organization">
                <select
                  className="edit-select"
                  value={ownOrgId}
                  onChange={() => undefined}
                  disabled
                  title="You can only manage users in your own organization."
                >
                  <option value={ownOrgId}>{ownOrgName}</option>
                </select>
                <span className="field-note">Fixed — users stay in your organization.</span>
              </Field>
              <Field label="School" full>
                <select
                  className="edit-select"
                  value={form.school_id}
                  onChange={(e) => setForm((f) => ({ ...f, school_id: e.target.value }))}
                >
                  <option value="">— No school —</option>
                  {schools.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>

              {form.id !== null && (
                <Field label="Active">
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Toggle
                      checked={form.active}
                      disabled={form.id === user?.id}
                      onChange={(v) => setForm((f) => ({ ...f, active: v }))}
                    />
                    <span style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>
                      {form.active ? "Active" : "Inactive"}
                      {form.id === user?.id ? " (you)" : ""}
                    </span>
                  </div>
                </Field>
              )}

              {/* Curates the Select User (Test) login dropdown. Off unless an
                  admin deliberately opts the account in. */}
              <Field label="Show user on Test screen" full>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Toggle
                    checked={form.show_on_test_screen}
                    onChange={(v) => setForm((f) => ({ ...f, show_on_test_screen: v }))}
                  />
                  <span style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>
                    {form.show_on_test_screen
                      ? "Listed in the Select User (Test) dropdown"
                      : "Not listed in the Select User (Test) dropdown"}
                  </span>
                </div>
              </Field>
            </div>

            {/* Form access — the grants that EXIST for this account, with a
                Remove per row.
                ★ Only for an existing account (a create has none), and only
                PRIVATE forms appear: a grant on a public form is inert, since
                everyone can read a public form regardless.
                ★ A staff or admin account legitimately shows an empty list — it
                is exempt BY RULE and holds no row. The note says so, or the
                empty state reads as missing data. */}
            {form.id !== null && (
              <div className="drawer-section">
                <h3 className="section-title">Form access</h3>
                {userAccessError && (
                  <div className="alert-error" role="alert" style={{ marginBottom: 10 }}>
                    {userAccessError}
                  </div>
                )}
                {userAccess.length === 0 ? (
                  <p className="empty-note">
                    No individual form grants.{" "}
                    {form.role === "admin" || form.role === "staff"
                      ? "This role reads every form in the organization, so it needs no grants."
                      : "This account can read every public form; private forms need a grant."}
                  </p>
                ) : (
                  <table className="grid">
                    <thead>
                      <tr>
                        <th>Form</th>
                        <th>Status</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {userAccess.map((a) => (
                        <tr key={a.form_id}>
                          <td data-label="Form">
                            <span className="cell-strong">
                              #{a.form_id} {a.form_title ?? "(deleted form)"}
                            </span>
                            {a.source === "backfill" && (
                              <div className="cell-sub">Grandfathered when the form went private</div>
                            )}
                          </td>
                          <td data-label="Status">
                            <span
                              className={`badge ${
                                a.status === "approved"
                                  ? "badge-green"
                                  : a.status === "pending"
                                    ? "badge-blue"
                                    : "badge-gray"
                              }`}
                            >
                              {a.status}
                            </span>
                            {a.status === "denied" && (
                              <div className="cell-sub">
                                {a.last_event === "revoked" ? "Access removed" : "Declined"}
                              </div>
                            )}
                          </td>
                          <td>
                            {/* ★ Only an APPROVED row can be removed. A pending
                                request is answered in the Access Requests
                                section, and a denied row is already without
                                access — a Remove button on either would be a
                                control the API refuses. */}
                            {a.status === "approved" && (
                              <button
                                type="button"
                                className="badge-button danger"
                                disabled={userAccessBusy === a.form_id}
                                title={
                                  a.form_visibility === "public"
                                    ? "This form is public — make it private first"
                                    : "Remove this account's access to the form"
                                }
                                onClick={() => void removeAccess(form.id!, a.form_id)}
                              >
                                Remove access
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <p className="empty-note" style={{ marginTop: 8 }}>
                  Removing access takes effect immediately and is recorded in the
                  form&apos;s history. The account will see the form under
                  &ldquo;Available to request&rdquo; and can ask for access again —
                  approving that request is what restores it.
                </p>
              </div>
            )}
              </>
            )}
          </div>
          {resetStep === "confirm" ? (
            <div className="drawer-foot">
              <span className="muted-note">This affects {form.display_name}&apos;s sign-in</span>
              <button
                className="secondary-button"
                onClick={() => setResetStep("idle")}
                disabled={resetBusy}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                onClick={() => void handleReset()}
                disabled={resetBusy}
              >
                {resetBusy ? "Resetting…" : "Reset password"}
              </button>
            </div>
          ) : resetStep === "done" ? (
            <div className="drawer-foot">
              <span className="muted-note">
                Signing in as {resetResult?.display_name} now requires this password
              </span>
              <button className="primary-button" onClick={closeModal}>
                Done
              </button>
            </div>
          ) : (
            <div className="drawer-foot">
              <span className="muted-note">{form.id === null ? "New account" : "Editing account"}</span>
              {/* Only for an existing account — a create has no password to replace.
                  Hidden (not merely disabled) for the signed-in admin's own row:
                  the API refuses self-reset with a 400 pointing at Change Password,
                  so offering it here would look like a broken button. Disabled
                  Toggle above follows the same "you" convention. */}
              {form.id !== null && form.id !== user?.id && (
                <button
                  className="secondary-button"
                  onClick={() => {
                    setResetError("");
                    setResetStep("confirm");
                  }}
                  disabled={saving}
                  title="Issue a temporary password this user must change at next sign-in"
                >
                  <KeyRound size={16} /> Reset password
                </button>
              )}
              <button className="secondary-button" onClick={closeModal} disabled={saving}>
                Cancel
              </button>
              <button
                className="primary-button"
                onClick={() => void handleSave()}
                disabled={saving || !form.display_name || !form.email || (form.id === null && form.password.length < 8)}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Create / edit role — right slide-out drawer. */}
      <div className={`drawer-overlay ${roleOpen ? "open" : ""}`} onClick={closeRole}>
        <div className="drawer" onClick={(e) => e.stopPropagation()}>
          <div className="drawer-head">
            <h2>{roleForm.editing === null ? "Add Role" : "Edit Role"}</h2>
            <button className="icon-button close" onClick={closeRole} title="Close">
              <X size={18} />
            </button>
          </div>
          <div className="drawer-body">
            {roleSaveError && (
              <div className="alert-error" role="alert" style={{ marginBottom: 12 }}>
                {roleSaveError}
              </div>
            )}
            <div className="form-grid">
              <Field label="Name" full>
                <input
                  className="edit-input"
                  value={roleForm.label}
                  maxLength={60}
                  onChange={(e) => setRoleForm((f) => ({ ...f, label: e.target.value }))}
                  placeholder="Finance Lead"
                />
              </Field>
              <Field label="Key" full>
                <input
                  className="edit-input"
                  value={roleForm.role_key}
                  maxLength={40}
                  readOnly={roleForm.editing !== null}
                  onChange={(e) => setRoleForm((f) => ({ ...f, role_key: e.target.value }))}
                  placeholder="finance_lead"
                />
                <span style={{ ...FIELD_HINT, textTransform: "none" }}>
                  {roleForm.editing !== null
                    ? "The key cannot be changed. It is what form-field access lists, message audiences and menu settings actually store, so renaming it would leave those grants pointing at nothing."
                    : 'Optional — leave it blank and the key is made from the name ("Finance Lead" becomes finance_lead). Lower case letters, digits and underscores only.'}
                </span>
              </Field>
              <Field label="Description" full>
                <textarea
                  className="edit-input"
                  value={roleForm.description}
                  maxLength={400}
                  onChange={(e) => setRoleForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="What this role is for, in a line. Shown beside the role in this panel."
                  rows={3}
                />
              </Field>
              <div style={{ gridColumn: "1 / -1" }}>
                <span style={FIELD_CAPTION}>Badge colour</span>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {/* ★ Only three choices, because only three of a stylesheet's
                      eight badge names resolve to different pixels — the other five
                      are duplicates of these. Offering "teal" beside "green" would
                      be offering the same colour twice under two labels. */}
                  {BADGE_CHOICES.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      className="secondary-button"
                      onClick={() => setRoleForm((f) => ({ ...f, badge: c.value }))}
                      style={
                        roleForm.badge === c.value
                          ? { borderColor: "var(--accent)", boxShadow: "0 0 0 1px var(--accent)" }
                          : undefined
                      }
                      aria-pressed={roleForm.badge === c.value}
                      title={c.hint}
                    >
                      <span className={`badge ${badgeClass(c.value)}`}>{c.label}</span>
                    </button>
                  ))}
                </div>
                <span style={FIELD_HINT}>
                  {BADGE_CHOICES.find((c) => c.value === roleForm.badge)?.hint ??
                    `This role's stored badge is "${roleForm.badge}", which is not one of the three above — choosing one replaces it.`}
                </span>
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <span style={FIELD_CAPTION}>Access</span>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                    gap: 8,
                  }}
                >
                  {ROLE_FLAGS.map((f) => {
                    // Two locks, for two different reasons. A built-in's capabilities
                    // are re-derived from code at every start — all six columns on the
                    // row, of which this form shows four — so an edit here would save
                    // and then revert. Administrator is a create-time decision on any
                    // role, which is why it is fixed once the role exists.
                    const locked =
                      roleForm.built_in || (f.key === "is_admin" && roleForm.editing !== null);
                    return (
                      <label
                        key={f.key}
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 8,
                          fontSize: "0.8125rem",
                          opacity: locked ? 0.6 : 1,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={roleForm[f.key]}
                          disabled={locked}
                          onChange={(e) => setRoleFlag(f.key, e.target.checked)}
                          style={{ marginTop: 2 }}
                        />
                        <span>
                          {f.label}
                          <span style={{ display: "block", fontSize: "0.6875rem", color: "var(--text-muted)" }}>
                            {f.hint}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
                <span style={FIELD_HINT}>
                  {roleForm.built_in
                    ? "This role is built in: its access flags are set by the installation at every start, so they are shown but cannot be changed. The name, description and badge can be."
                    : roleForm.editing !== null
                      ? "Administrator can only be granted when a role is created, so that checkbox is fixed. The other three can be changed."
                      : "A role with every box clear can sign in and do nothing else."}
                </span>
              </div>
            </div>
          </div>
          <div className="drawer-foot">
            <span className="muted-note">
              {roleForm.editing === null ? "New role" : `Editing "${roleForm.role_key}"`}
            </span>
            <button className="secondary-button" onClick={closeRole} disabled={roleSaving}>
              Cancel
            </button>
            <button
              className="primary-button"
              onClick={() => void handleRoleSave()}
              disabled={roleSaving || !roleForm.label.trim()}
            >
              {roleSaving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>

      {/* Rendered last so it paints above the drawer overlay (z-index 100) and
          the system-message banner (201); `.toast` carries z-index 300 for the
          same reason. Mounted with a per-notification `key` so a repeated save
          remounts it and restarts its timer — see components/Toast.tsx. */}
      {toast && (
        <Toast key={toast.id} message={toast.text} onDismiss={() => setToast(null)} />
      )}
    </div>
  );
}
