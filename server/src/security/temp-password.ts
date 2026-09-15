import { randomInt } from "node:crypto";

// -----------------------------------------------------------------------------
// Temporary password generation for the admin password reset
// (POST /api/users/{id}/reset-password — see docs/plans/password-recovery.md).
// -----------------------------------------------------------------------------

// 57 characters: the lowercase alphabet without 'l', the uppercase alphabet
// without 'I' and 'O', and the digits without '0' and '1'.
//
// The exclusions are the whole point. This value is dictated over a phone, copied
// off a screen onto paper, or typed on a phone keyboard by someone who did not
// choose it and has never seen it before. In that setting `l`/`1`/`I` and `O`/`0`
// produce only "it says my password is wrong" — no security. Removing them costs
// nothing meaningful (still ~5.8 bits per character).
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// 57^14 ≈ 8.3e24 combinations, far past brute force. It also clears the
// 8-character floor in `changePasswordSchema`, so the temporary password is
// never rejected for being too short when the user goes to replace it.
const LENGTH = 14;

/**
 * Generate a random temporary password.
 *
 * Uses `crypto.randomInt`, which is both cryptographic and uniformly distributed.
 * `Math.random()` is neither, and the usual `Math.floor(Math.random() * n)` idiom
 * additionally biases the low characters of the alphabet — not a mistake worth
 * making on the one credential an administrator hands to another person.
 *
 * Deliberately letters and digits only, no symbols: this password gets retyped by
 * a human, and `$`, `@` and quotes are a reliable source of avoidable support
 * traffic for no security gain.
 */
export function generateTemporaryPassword(): string {
  let out = "";
  for (let i = 0; i < LENGTH; i++) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}
