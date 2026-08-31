import { env } from "../config/env.js";

// -----------------------------------------------------------------------------
// Slack admin notifications (fire-and-forget).
//
// These are ADMIN-facing alerts — a new submission arrived, a Google Doc was
// created, etc. They are deliberately isolated so a Slack outage / misconfigured
// URL can NEVER break the core submission or document flow. If no webhook URL is
// configured, this module is a silent no-op.
// -----------------------------------------------------------------------------

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
 * false when disabled (no URL) or the send failed.
 */
export async function notifySlack(message: SlackMessage): Promise<boolean> {
  const url = env.slack.webhookUrl;
  if (!url) return false;

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
