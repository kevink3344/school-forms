import crypto from "node:crypto";
import type { Request } from "express";

// -----------------------------------------------------------------------------
// Raw request-body capture for the webhook log (docs/plans/webhook-log.md).
//
// The webhook route stores the payload VERBATIM so a failed attempt can be
// replayed. `JSON.stringify(req.body)` is not good enough: it loses key order,
// whitespace and any field that survived parsing but is not in the schema, and a
// malformed body has no `req.body` at all. So the bytes are captured before
// parsing, through `express.json`'s `verify` hook.
//
// Two constraints on that hook:
//   1. It runs on EVERY JSON request, so it must be cheap and must not capture
//      the body of unrelated endpoints. It filters on the webhook path.
//   2. It must be bounded. `payload_raw` is a second copy of parent-submitted
//      data held for an unbounded time, so it is capped — the true byte length is
//      still recorded, which is what lets the UI say "not stored (too large)"
//      instead of silently showing an empty payload.
//
// The augmentation lives here rather than in auth.ts because `rawBody` is a
// webhook concern; TypeScript merges the two `interface Request` declarations
// globally, so both are visible everywhere.
// -----------------------------------------------------------------------------

/** Path prefix whose bodies are retained. Must match the mount in index.ts. */
export const RAW_BODY_PATH = "/api/webhook/google";

/** Bodies larger than this are counted but not stored, and are NOT replayable. */
export const RAW_BODY_LIMIT = 64 * 1024;

declare global {
  namespace Express {
    interface Request {
      /** The verbatim request body, when captured and within the cap. */
      rawBody?: string;
      /** The true body length in bytes, captured even when over the cap. */
      rawBodyBytes?: number;
    }
  }
}

/**
 * `express.json({ verify })` hook. Attaches the raw body for the webhook path
 * only. Never throws — a throw here would abort every JSON request in the app.
 */
export function captureRawBody(req: Request, _res: unknown, buf: Buffer): void {
  try {
    const path = (req.originalUrl || req.url || "").split("?")[0];
    if (path !== RAW_BODY_PATH) return;
    req.rawBodyBytes = buf.length;
    if (buf.length <= RAW_BODY_LIMIT) {
      req.rawBody = buf.toString("utf8");
    }
  } catch {
    // Best-effort capture; the webhook must still be processed without it.
  }
}

export interface CapturedPayload {
  /** What to store in `payload_raw`, or null when nothing is safely available. */
  raw: string | null;
  /** The true body size in bytes. */
  bytes: number | null;
  /** sha256 of the captured body — a cheap duplicate hint in the UI. */
  hash: string | null;
  /** True when the body exceeded the cap and was deliberately not stored. */
  truncated: boolean;
}

/**
 * Read the captured body for a request, falling back to re-serialising the
 * parsed body when the `verify` hook never fired (a request with no body, or a
 * non-JSON content type). The fallback is lossy but keeps every attempt
 * replayable rather than only the well-formed ones.
 */
export function capturedPayload(req: Request): CapturedPayload {
  const captured = req.rawBody;
  const raw = captured ?? reSerialize(req.body);
  const bytes =
    typeof req.rawBodyBytes === "number"
      ? req.rawBodyBytes
      : raw === null
        ? null
        : Buffer.byteLength(raw, "utf8");
  return {
    raw,
    bytes,
    hash: raw === null ? null : crypto.createHash("sha256").update(raw).digest("hex"),
    truncated: raw !== null && typeof req.rawBodyBytes === "number" && req.rawBodyBytes > RAW_BODY_LIMIT,
  };
}

function reSerialize(body: unknown): string | null {
  if (body === undefined || body === null) return null;
  try {
    return JSON.stringify(body);
  } catch {
    return null;
  }
}

/** The client IP to record, honouring the single trusted proxy hop (index.ts). */
export function remoteIp(req: Request): string | null {
  const ip = req.ip ?? req.socket?.remoteAddress ?? null;
  return ip ? ip.slice(0, 64) : null;
}

/** The User-Agent to record, truncated to the column width instead of erroring. */
export function userAgent(req: Request): string | null {
  const ua = req.header("user-agent");
  return ua ? ua.slice(0, 200) : null;
}
