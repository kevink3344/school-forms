import { env } from "../config/env.js";
import { getSetting } from "../db/queries.js";

// -----------------------------------------------------------------------------
// Slack admin notifications (fire-and-forget).
//
// These are ADMIN-facing alerts — a new submission arrived, a Google Doc was
// created, etc. They are deliberately isolated so a Slack outage / misconfigured
// URL can NEVER break the core submission or document flow. If no webhook URL is
// configured, this module is a silent no-op.
//
// A second, runtime gate sits on top of the webhook URL: the
// `slack_notifications_enabled` app setting (Settings → Slack Notifications).
// When an admin turns it off, nothing is sent even though a URL is configured —
// the URL is left in place, so the switch is a MUTE, not a teardown, and turning
// it back on needs no redeploy.
// -----------------------------------------------------------------------------

// App-settings key behind the Settings → Slack Notifications on/off switch.
//
// Owned on THIS side because the notifier is what reads it; routes/settings.ts
// imports the key for its allow-list. Declaring it here (rather than in
// settings.ts) keeps the dependency one-way: settings.ts already imports
// `notifySlack` from this module, so importing a constant back the other way
// would be a cycle.
export const SLACK_ENABLED_KEY = "slack_notifications_enabled";

// The values the switch accepts. The PUT handler in routes/settings.ts rejects
// anything else, so a stored row is always one of these.
export const SLACK_ENABLED_VALUES = new Set(["true", "false"]);

/**
 * Whether admin Slack alerts are currently switched on.
 *
 * An absent, blank or unparsable row means ON, so an installation that predates
 * the switch keeps sending exactly as it did before it existed. A settings read
 * failure also falls back to ON: this module must never break — or silently
 * mute — the flow it was attached to, and failing "loud" preserves the
 * historical behaviour an operator already trusts.
 */
export async function slackNotificationsEnabled(): Promise<boolean> {
  try {
    const raw = await getSetting(SLACK_ENABLED_KEY);
    if (raw === null || raw === undefined || raw.trim() === "") return true;
    return raw.trim().toLowerCase() !== "false";
  } catch (err) {
    console.error("Slack enablement check failed; assuming enabled:", err);
    return true;
  }
}

export interface SlackField {
  title: string;
  value: string;
  short?: boolean;
}

export interface SlackAttachment {
  color?: "good" | "warning" | "danger" | string;
  fields?: SlackField[];
  fallback?: string;
}

export interface SlackMessage {
  text: string;
  attachments?: SlackAttachment[];
}

/**
 * Send a message to the configured Slack incoming webhook. Resolves regardless
 * of outcome — never throws. Returns true when a request was actually sent,
 * false when switched off (no URL, or the admin's toggle is off) or the send
 * failed.
 */
export async function notifySlack(message: SlackMessage): Promise<boolean> {
  const url = env.slack.webhookUrl;
  if (!url) return false;
  // The admin's on/off switch (Settings → Slack Notifications). Checked AFTER the
  // URL so an installation with no webhook never pays for a settings read.
  if (!(await slackNotificationsEnabled())) return false;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    // Slack returns 200 with "ok" on success; any 4xx/5xx is a delivery problem.
    if (!res.ok) {
      console.error(
        `Slack notification failed (${res.status} ${res.statusText}):`,
        await res.text().catch(() => "")
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error("Slack notification failed:", err);
    return false;
  }
}

/**
 * Convenience helper used by the notification call sites. Accepts a plain body
 * and common attachment fields. `fallback` is the plain-text summary shown by
 * Slack clients that can't render attachments.
 */
export async function sendSlackAlert(
  text: string,
  fields: SlackField[],
  opts: { color?: SlackAttachment["color"]; fallback?: string } = {}
): Promise<boolean> {
  return notifySlack({
    text,
    attachments: [
      {
        color: opts.color ?? "good",
        fields,
        fallback: opts.fallback ?? text,
      },
    ],
  });
}
