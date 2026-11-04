/**
 * Shared predicate for `VITE_AUTH_ENABLED`.
 *
 * Auth is off unless the value is an explicit true (after trim, case-insensitive).
 * Unset, empty, whitespace, `"false"`, and any other value mean off.
 * Keep `src/lib/auth/{client,server,gate-identity.server}.ts` on this helper.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function authEnabledFromEnvValue(value) {
  return String(value ?? "").trim().toLowerCase() === "true";
}
